/**
 * The chat panel.
 *
 * Plain DOM on purpose: the same panel mounts into a block editor
 * PluginSidebar, into an admin page, or into any other element, without
 * dragging a rendering framework along with it.
 */

import { chatConfig } from '@contributor-day/chat-config';
import { createChatSession } from '@contributor-day/chat-session';
import { renderMarkdown } from '@contributor-day/chat-markup';
import { listTools, onToolsChanged } from '@contributor-day/webmcp-tools';

const SUGGESTIONS_LIMIT = 3;

/**
 * @param {string}                  tag
 * @param {string}                  [className]
 * @param {string|Node|Node[]|null} [children]
 * @return {HTMLElement}
 */
function element( tag, className, children ) {
	const node = document.createElement( tag );
	if ( className ) {
		node.className = className;
	}
	if ( Array.isArray( children ) ) {
		node.append( ...children );
	} else if ( children !== undefined && children !== null ) {
		node.append( children );
	}
	return node;
}

/**
 * @param {unknown} value
 * @return {string}
 */
function formatArguments( value ) {
	if ( value === undefined || value === null ) {
		return '{}';
	}
	try {
		return JSON.stringify( value, null, 2 );
	} catch {
		return String( value );
	}
}

const TOOL_STATE_LABELS = {
	pending: 'Queued',
	running: 'Running',
	done: 'Done',
	error: 'Failed',
};

/**
 * @param {Object} call
 * @return {HTMLElement}
 */
function renderToolCall( call ) {
	const details = element( 'details', 'cdchat-tool' );
	details.dataset.state = call.state || 'done';

	const summary = element( 'summary', 'cdchat-tool__summary' );
	summary.append(
		element( 'span', 'cdchat-tool__name', call.name ),
		element(
			'span',
			'cdchat-tool__state',
			TOOL_STATE_LABELS[ call.state ] || ''
		)
	);
	details.append( summary );

	const args = element( 'pre', 'cdchat-tool__block' );
	args.textContent = formatArguments( call.arguments );
	details.append( element( 'p', 'cdchat-tool__label', 'Input' ), args );

	if ( call.result !== undefined ) {
		const result = element( 'pre', 'cdchat-tool__block' );
		result.textContent = call.result;
		details.append(
			element(
				'p',
				'cdchat-tool__label',
				call.state === 'error' ? 'Error' : 'Result'
			),
			result
		);
	}

	return details;
}

/**
 * @param {Object} turn
 * @return {HTMLElement|null}
 */
function renderTurn( turn ) {
	if ( turn.role === 'tool' ) {
		// Tool results are shown inside the assistant turn that asked for them.
		return null;
	}

	const wrapper = element( 'div', `cdchat-turn cdchat-turn--${ turn.role }` );

	if ( turn.role === 'user' ) {
		wrapper.append( element( 'div', 'cdchat-turn__body', turn.content ) );
		return wrapper;
	}

	if ( turn.role === 'error' ) {
		wrapper.append( element( 'div', 'cdchat-turn__body', turn.content ) );
		return wrapper;
	}

	const body = element( 'div', 'cdchat-turn__body' );

	if ( turn.toolCalls?.length ) {
		const tools = element( 'div', 'cdchat-turn__tools' );
		turn.toolCalls.forEach( ( call ) => tools.append( renderToolCall( call ) ) );
		body.append( tools );
	}

	if ( turn.text ) {
		body.append( renderMarkdown( turn.text ) );
	}

	if ( ! turn.text && ! turn.toolCalls?.length ) {
		return null;
	}

	wrapper.append( body );

	const attribution = [ turn.meta?.model, turn.meta?.provider ]
		.filter( Boolean )
		.join( ' · ' );
	if ( attribution ) {
		wrapper.append( element( 'p', 'cdchat-turn__meta', attribution ) );
	}

	return wrapper;
}

/**
 * Mount a chat panel into an element.
 *
 * @param {HTMLElement} container            Element to render into.
 * @param {Object}      [options]
 * @param {Function}    [options.getContext] Page context for the system prompt.
 * @param {string[]}    [options.suggestions] Starter prompts.
 * @return {{ destroy: Function, focus: Function }}
 */
export function mountChatPanel( container, options = {} ) {
	const { getContext, suggestions = [] } = options;

	const session = createChatSession( { getContext } );

	const root = element( 'div', 'cdchat' );
	const notice = element( 'div', 'cdchat__notice' );
	const log = element( 'div', 'cdchat__log' );
	log.setAttribute( 'role', 'log' );
	log.setAttribute( 'aria-live', 'polite' );

	const empty = element( 'div', 'cdchat__empty' );
	const form = element( 'form', 'cdchat__composer' );
	const input = element( 'textarea', 'cdchat__input' );
	input.rows = 3;
	input.placeholder = 'Ask about this site, or tell the assistant what to change…';
	input.setAttribute( 'aria-label', 'Message' );

	const toolCount = element( 'span', 'cdchat__tools' );
	const send = element( 'button', 'button button-primary cdchat__send', 'Send' );
	send.type = 'submit';
	const stop = element( 'button', 'button cdchat__stop', 'Stop' );
	stop.type = 'button';
	stop.hidden = true;
	const clear = element( 'button', 'button-link cdchat__clear', 'Clear' );
	clear.type = 'button';

	const actions = element( 'div', 'cdchat__actions', [
		toolCount,
		clear,
		stop,
		send,
	] );
	form.append( input, actions );
	root.append( notice, log, empty, form );
	container.append( root );

	if ( ! chatConfig.available ) {
		notice.hidden = false;
		notice.append(
			'No AI connector is configured, so the assistant cannot answer yet. '
		);
		if ( chatConfig.connectorsUrl ) {
			const link = element(
				'a',
				null,
				'Set one up under Settings → Connectors.'
			);
			link.href = chatConfig.connectorsUrl;
			notice.append( link );
		}
	} else {
		notice.hidden = true;
	}

	function renderSuggestions() {
		empty.replaceChildren();
		empty.append(
			element(
				'p',
				'cdchat__empty-text',
				chatConfig.siteName
					? `Ask anything about ${ chatConfig.siteName }.`
					: 'Ask anything about this site.'
			)
		);

		suggestions.slice( 0, SUGGESTIONS_LIMIT ).forEach( ( suggestion ) => {
			const button = element(
				'button',
				'button cdchat__suggestion',
				suggestion
			);
			button.type = 'button';
			button.addEventListener( 'click', () => {
				input.value = suggestion;
				form.requestSubmit();
			} );
			empty.append( button );
		} );
	}

	function render( state ) {
		const nodes = state.turns.map( renderTurn ).filter( Boolean );
		log.replaceChildren( ...nodes );

		if ( state.busy && state.status ) {
			log.append( element( 'div', 'cdchat__status', state.status ) );
		}

		empty.hidden = nodes.length > 0;
		send.disabled = state.busy;
		stop.hidden = ! state.busy;
		clear.disabled = ! state.turns.length;
		log.scrollTop = log.scrollHeight;
	}

	async function refreshToolCount() {
		const tools = await listTools();
		toolCount.textContent = tools.length
			? `${ tools.length } page ${ tools.length === 1 ? 'tool' : 'tools' }`
			: 'No page tools';
		toolCount.title = tools.length
			? tools.map( ( tool ) => tool.name ).join( '\n' )
			: 'This page registers no WebMCP tools, so the assistant can only answer questions.';
	}

	form.addEventListener( 'submit', ( event ) => {
		event.preventDefault();
		const text = input.value;
		if ( ! text.trim() ) {
			return;
		}
		input.value = '';
		session.send( text );
	} );

	input.addEventListener( 'keydown', ( event ) => {
		if ( event.key === 'Enter' && ( event.metaKey || event.ctrlKey ) ) {
			event.preventDefault();
			form.requestSubmit();
		}
	} );

	stop.addEventListener( 'click', () => session.stop() );
	clear.addEventListener( 'click', () => session.clear() );

	renderSuggestions();
	const unsubscribe = session.subscribe( render );
	const unwatchTools = onToolsChanged( refreshToolCount );
	refreshToolCount();

	return {
		destroy() {
			unsubscribe();
			unwatchTools();
			session.stop();
			root.remove();
		},
		focus() {
			input.focus();
		},
	};
}

// Exposed so the panel can be mounted from anywhere, including code that is not
// loaded as a script module.
if ( typeof window !== 'undefined' ) {
	window.contributorDayChat = { mount: mountChatPanel };
}
