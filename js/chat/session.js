/**
 * A chat conversation against the WordPress AI Client.
 *
 * The REST endpoint runs a single model turn, so the loop that turns a request
 * into an answer lives here: send the conversation, run whatever tools the
 * model asked for against the page, send the results back, repeat until the
 * model replies with text.
 *
 * Nothing in this module touches the DOM or the block editor. A session is
 * driven entirely through `send()` and observed through `subscribe()`.
 */

import { chatConfig } from '@contributor-day/chat-config';
import { callTool, listTools } from '@contributor-day/webmcp-tools';

let turnCounter = 0;

function nextId() {
	turnCounter += 1;
	return `turn-${ turnCounter }`;
}

/**
 * Reduce a turn to the shape the REST endpoint replays.
 *
 * @param {Object} turn
 * @return {Object|null}
 */
function toWireMessage( turn ) {
	switch ( turn.role ) {
		case 'user':
			return { role: 'user', content: turn.content };
		case 'assistant':
			return { role: 'assistant', parts: turn.parts };
		case 'tool':
			return { role: 'tool', responses: turn.responses };
		default:
			return null;
	}
}

/**
 * Pull a readable message out of a REST failure.
 *
 * @param {Response} response
 * @return {Promise<string>}
 */
async function readErrorMessage( response ) {
	try {
		const body = await response.json();
		if ( body?.message ) {
			return body.message;
		}
	} catch {
		// Fall through to the status text.
	}
	return `The chat request failed (${ response.status } ${ response.statusText }).`;
}

/**
 * Create a chat session.
 *
 * @param {Object}   [options]
 * @param {Function} [options.getContext] Returns page context to send with each
 *                                        request, evaluated at send time so it
 *                                        reflects the current screen.
 * @param {boolean}  [options.useTools]   Whether to offer page tools to the model.
 * @return {Object}
 */
export function createChatSession( options = {} ) {
	const { getContext = () => ( {} ), useTools = true } = options;

	/** @type {Array<Object>} */
	let turns = [];
	/** @type {Set<Function>} */
	const listeners = new Set();
	/** @type {AbortController|null} */
	let controller = null;
	let busy = false;
	let status = '';
	// Set when the conversation was thrown away rather than merely stopped, so
	// the in-flight request does not report back into an empty log.
	let discarded = false;
	// How the server replayed tool calls last turn. Reporting it back keeps a
	// provider that rejects native tool call history from being retried on
	// every turn of the same conversation.
	let historyMode = 'native';

	function emit() {
		const snapshot = getState();
		for ( const listener of listeners ) {
			listener( snapshot );
		}
	}

	function getState() {
		return { turns: [ ...turns ], busy, status };
	}

	function setStatus( next ) {
		status = next;
		emit();
	}

	function addTurn( turn ) {
		const entry = { id: nextId(), ...turn };
		turns = [ ...turns, entry ];
		emit();
		return entry;
	}

	function updateTurn( id, changes ) {
		turns = turns.map( ( turn ) =>
			turn.id === id ? { ...turn, ...changes } : turn
		);
		emit();
	}

	async function requestTurn( tools, signal ) {
		const response = await fetch( chatConfig.restUrl, {
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				'Content-Type': 'application/json',
				'X-WP-Nonce': chatConfig.nonce,
			},
			signal,
			body: JSON.stringify( {
				messages: turns.map( toWireMessage ).filter( Boolean ),
				tools,
				context: getContext() || {},
				historyMode,
			} ),
		} );

		if ( ! response.ok ) {
			throw new Error( await readErrorMessage( response ) );
		}

		const payload = await response.json();
		if ( payload?.historyMode ) {
			historyMode = payload.historyMode;
		}

		return payload;
	}

	/**
	 * Run the tools the model asked for and record how each one went.
	 *
	 * @param {Object} assistantTurn
	 * @return {Promise<Array<Object>>} Function responses for the next request.
	 */
	async function runToolCalls( assistantTurn ) {
		const responses = [];
		const calls = assistantTurn.toolCalls.map( ( call ) => ( {
			...call,
			state: 'pending',
		} ) );

		updateTurn( assistantTurn.id, { toolCalls: calls } );

		for ( let index = 0; index < calls.length; index += 1 ) {
			if ( controller?.signal.aborted ) {
				throw new DOMException( 'Aborted', 'AbortError' );
			}

			const call = calls[ index ];
			setStatus( `Running ${ call.name }…` );

			calls[ index ] = { ...call, state: 'running' };
			updateTurn( assistantTurn.id, { toolCalls: [ ...calls ] } );

			const result = await callTool( call.name, call.arguments || {} );

			calls[ index ] = {
				...call,
				state: result.isError ? 'error' : 'done',
				result: result.text,
			};
			updateTurn( assistantTurn.id, { toolCalls: [ ...calls ] } );

			responses.push( {
				id: call.id,
				name: call.name,
				response: result.value,
			} );
		}

		return responses;
	}

	/**
	 * Send a message and run the conversation until the model answers.
	 *
	 * @param {string} text
	 * @return {Promise<void>}
	 */
	async function send( text ) {
		const content = String( text || '' ).trim();
		if ( ! content || busy ) {
			return;
		}

		controller = new AbortController();
		busy = true;
		discarded = false;
		addTurn( { role: 'user', content } );

		try {
			const tools = useTools ? await listTools() : [];
			const declarations = tools.map( ( tool ) => ( {
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
			} ) );

			const maxRounds = Math.max( 1, chatConfig.maxToolRounds );

			for ( let round = 0; round <= maxRounds; round += 1 ) {
				setStatus( round === 0 ? 'Thinking…' : 'Working…' );

				const payload = await requestTurn(
					declarations,
					controller.signal
				);

				const assistantTurn = addTurn( {
					role: 'assistant',
					parts: payload.message?.parts || [],
					text: payload.text || '',
					toolCalls: payload.toolCalls || [],
					meta: payload.meta || {},
				} );

				if ( ! assistantTurn.toolCalls.length ) {
					return;
				}

				if ( round === maxRounds ) {
					addTurn( {
						role: 'error',
						content: `The assistant stopped after ${ maxRounds } rounds of tool calls.`,
					} );
					return;
				}

				const responses = await runToolCalls( assistantTurn );
				addTurn( { role: 'tool', responses } );
			}
		} catch ( error ) {
			if ( discarded ) {
				// The conversation this belonged to is gone.
			} else if ( error?.name === 'AbortError' ) {
				addTurn( { role: 'error', content: 'Stopped.' } );
			} else {
				addTurn( {
					role: 'error',
					content: String( error?.message || error ),
				} );
			}
		} finally {
			busy = false;
			controller = null;
			setStatus( '' );
		}
	}

	function stop() {
		controller?.abort();
	}

	function clear() {
		if ( busy ) {
			discarded = true;
			stop();
		}
		turns = [];
		emit();
	}

	/**
	 * @param {Function} listener
	 * @return {Function} Unsubscribe.
	 */
	function subscribe( listener ) {
		listeners.add( listener );
		listener( getState() );
		return () => listeners.delete( listener );
	}

	return { send, stop, clear, subscribe, getState };
}
