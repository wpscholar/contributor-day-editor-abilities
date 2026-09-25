import { test as base, expect, type Page } from '@playwright/test';
import { openEditor } from './open-editor';

/**
 * The MCP-shaped result every tool call normalizes to, mirroring how
 * js/webmcp-tools.js#callTool reduces a raw WebMCP result for the chat panel.
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
					const modelContext = ( document as any ).modelContext;
					const tools = await modelContext.getTools();
					const tool = tools.find(
						( candidate: { name: string } ) =>
							candidate.name === name
					);
					if ( ! tool ) {
						throw new Error( `Tool not registered: ${ name }` );
					}

					const raw = await modelContext.executeTool(
						tool,
						JSON.stringify( args ?? {} )
					);
					const parsed =
						typeof raw === 'string' ? JSON.parse( raw ) : raw;

					const text = ( parsed?.content || [] )
						.filter(
							( block: { type: string } ) => block.type === 'text'
						)
						.map( ( block: { text: string } ) => block.text )
						.join( '\n' );

					return {
						isError: !! parsed?.isError,
						value:
							parsed?.structuredContent !== undefined
								? parsed.structuredContent
								: text,
						text,
					};
				},
				{ name, args }
			);

		await use( callTool );
	},
} );

export { expect };
