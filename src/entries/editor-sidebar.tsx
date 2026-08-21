/**
 * Mount the chat as a block editor sidebar.
 *
 * This is the only editor-aware part of the chat. It describes the post being
 * edited so the assistant knows what the editor tools are pointed at, and
 * renders the shared panel into a PluginSidebar.
 *
 * The panel goes in as ordinary children rather than being mounted into a ref'd
 * div, which only works because this bundle uses the same React instance as the
 * editor. See src/lib/shims/react.ts.
 */

import '@/styles/chat.css';

import { ChatPanel } from '@/components/chat-panel';
import { waitFor } from '@/lib/wp';

const SIDEBAR_NAME = 'contributor-day-chat';

/** Describe what the editor is currently showing. */
function getEditorContext(): Record< string, unknown > {
	const select = window.wp?.data?.select;

	if ( typeof select !== 'function' ) {
		return { screen: 'block editor' };
	}

	const notes: string[] = [];

	try {
		const editor = select( 'core/editor' );
		const postType = editor?.getCurrentPostType?.();
		const title = editor?.getEditedPostAttribute?.( 'title' as never );

		if ( postType ) {
			notes.push( `The user is editing a "${ postType }".` );
		}
		if ( title ) {
			notes.push( `Its title is "${ title }".` );
		}

		const blockEditor = select( 'core/block-editor' );
		const selectedId = blockEditor?.getSelectedBlockClientId?.();

		if ( selectedId ) {
			const block = blockEditor.getBlock?.( selectedId as never ) as
				| { name?: string }
				| undefined;

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

const SUGGESTIONS = [
	'Summarize the blocks in this post.',
	'Add a two-column layout below the first paragraph.',
];

async function registerChatSidebar() {
	const wp = await waitFor( () =>
		window.wp?.plugins?.registerPlugin &&
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

	const PluginSidebar = ( wp.editor?.PluginSidebar ??
		wp.editPost?.PluginSidebar )!;

	wp.plugins!.registerPlugin( SIDEBAR_NAME, {
		render: () => (
			<PluginSidebar
				name={ SIDEBAR_NAME }
				title="AI Chat"
				icon="format-chat"
				className="cdchat-sidebar"
			>
				<ChatPanel
					getContext={ getEditorContext }
					suggestions={ SUGGESTIONS }
				/>
			</PluginSidebar>
		),
	} );
}

registerChatSidebar().catch( ( error ) => {
	console.error(
		'[contributor-day] Failed to register the chat sidebar:',
		error
	);
} );
