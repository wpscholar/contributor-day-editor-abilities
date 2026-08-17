/**
 * Mount the chat as a block editor sidebar.
 *
 * This is the only editor-aware part of the chat. It renders the shared panel
 * into a PluginSidebar and describes the post being edited, so the assistant
 * knows what the editor tools are pointed at.
 */

import { mountChatPanel } from '@contributor-day/chat-panel';

const SIDEBAR_NAME = 'contributor-day-chat';

/**
 * Editor packages load as classic scripts, which execute before deferred
 * modules — but only when they are actually on the page. Poll briefly rather
 * than assuming.
 *
 * @param {Function} check     Returns a truthy value once ready.
 * @param {number}   timeoutMs
 * @return {Promise<unknown>}
 */
function waitFor( check, timeoutMs = 5000 ) {
	return new Promise( ( resolve ) => {
		const started = Date.now();

		const poll = () => {
			const value = check();
			if ( value ) {
				resolve( value );
				return;
			}
			if ( Date.now() - started >= timeoutMs ) {
				resolve( null );
				return;
			}
			window.setTimeout( poll, 50 );
		};

		poll();
	} );
}

/**
 * Describe what the editor is currently showing.
 *
 * @return {Object}
 */
function getEditorContext() {
	const select = window.wp?.data?.select;
	if ( typeof select !== 'function' ) {
		return { screen: 'block editor' };
	}

	const notes = [];

	try {
		const editor = select( 'core/editor' );
		const postType = editor?.getCurrentPostType?.();
		const title = editor?.getEditedPostAttribute?.( 'title' );

		if ( postType ) {
			notes.push( `The user is editing a "${ postType }".` );
		}
		if ( title ) {
			notes.push( `Its title is "${ title }".` );
		}

		const blockEditor = select( 'core/block-editor' );
		const selectedId = blockEditor?.getSelectedBlockClientId?.();
		if ( selectedId ) {
			const block = blockEditor.getBlock( selectedId );
			if ( block ) {
				notes.push(
					`The selected block is ${ block.name } with client ID ${ selectedId }.`
				);
			}
		}
	} catch {
		// A partial context is better than failing the request.
	}

	notes.push(
		'Block editor tools act on this post. Read the block tree before changing it, and use client IDs from a read tool rather than guessing.'
	);

	return { screen: 'block editor', notes: notes.join( ' ' ) };
}

async function registerChatSidebar() {
	const wp = await waitFor(
		() =>
			window.wp?.plugins?.registerPlugin &&
			window.wp?.element?.createElement &&
			( window.wp.editor?.PluginSidebar || window.wp.editPost?.PluginSidebar )
				? window.wp
				: null
	);

	if ( ! wp ) {
		console.warn(
			'[contributor-day] The block editor sidebar API is unavailable, so the chat sidebar was not added.'
		);
		return;
	}

	const { registerPlugin } = wp.plugins;
	const { createElement, useEffect, useRef } = wp.element;
	const PluginSidebar =
		wp.editor?.PluginSidebar || wp.editPost?.PluginSidebar;

	function ChatSidebar() {
		const containerRef = useRef( null );

		useEffect( () => {
			if ( ! containerRef.current ) {
				return undefined;
			}

			const panel = mountChatPanel( containerRef.current, {
				getContext: getEditorContext,
				suggestions: [
					'Summarize the blocks in this post.',
					'Add a two-column layout below the first paragraph.',
				],
			} );

			return () => panel.destroy();
		}, [] );

		return createElement( 'div', {
			className: 'cdchat-sidebar',
			ref: containerRef,
		} );
	}

	registerPlugin( SIDEBAR_NAME, {
		render: () =>
			createElement(
				PluginSidebar,
				{
					name: SIDEBAR_NAME,
					title: 'AI Chat',
					icon: 'format-chat',
					className: 'cdchat-sidebar-wrapper',
				},
				createElement( ChatSidebar )
			),
	} );
}

registerChatSidebar().catch( ( error ) => {
	console.error(
		'[contributor-day] Failed to register the chat sidebar:',
		error
	);
} );
