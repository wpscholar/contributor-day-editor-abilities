/**
 * Mount the chat on the Tools → AI Chat screen.
 */

import '@/styles/chat.css';

import { createRoot } from 'react-dom/client';

import { ChatPanel } from '@/components/chat-panel';

const container = document.getElementById( 'contributor-day-chat-root' );

if ( container ) {
	createRoot( container ).render(
		<ChatPanel
			getContext={ () => ( {
				screen: 'Tools → AI Chat',
				notes: 'This screen is a plain chat surface. Any tools offered come from the page itself.',
			} ) }
			suggestions={ [
				'What can you help me with here?',
				'Summarize what this site is about.',
			] }
		/>
	);
}
