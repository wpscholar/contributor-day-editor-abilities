import type { ChatConfig } from '@agentic-editor/chat-config';

/** Stands in for js/chat/config.js; tests may change it. */
export const chatConfig: ChatConfig = {
	restUrl: 'http://example.test/wp-json/agentic-editor/v1/chat',
	nonce: 'nonce',
	available: true,
	connectorsUrl: null,
	maxToolRounds: 8,
	siteName: 'Test',
};
