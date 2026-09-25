import { test as base, expect, type Page } from '@playwright/test';
import { openEditor } from './open-editor';

/**
 * What js/webmcp-tools.js#callTool returns: the shape the chat panel sees.
 */
export type ToolResult = {
	isError: boolean;
	value: any;
	text: string;
};

type Fixtures = {
	editor: Page;
	callTool: (
		name: string,
		args?: Record< string, unknown >
	) => Promise< ToolResult >;
};

export const test = base.extend< Fixtures >( {
	editor: async ( { page }, use ) => {
		await openEditor( page );
		await use( page );
	},

	callTool: async ( { editor }, use ) => {
		const callTool = async (
			name: string,
			args: Record< string, unknown > = {}
		): Promise< ToolResult > =>
			editor.evaluate(
				async ( { name, args } ) => {
					// The chat's own consumer module, resolved through the
					// page's import map, so tests call tools exactly the way
					// the chat does. A variable keeps the bundler and
					// TypeScript from resolving the bare specifier here.
					const specifier = '@agentic-editor/webmcp-tools';
					const tools = await import( specifier );
					return tools.callTool( name, args );
				},
				{ name, args }
			);

		await use( callTool );
	},
} );

export { expect };
