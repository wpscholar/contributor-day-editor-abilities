import { test as base, expect, type Page } from '@playwright/test';

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
	callTool: ( name: string, args?: Record< string, unknown > ) => Promise< ToolResult >;
};

export const test = base.extend< Fixtures >( {
	// eslint-disable-next-line no-empty-pattern
	editor: async ( { page }, use ) => {
		// A fresh auto-draft per test keeps abilities from stepping on each other.
		await page.goto( '/wp-admin/post-new.php' );

		// A brand-new site shows the welcome guide as a modal on first load.
		await page.keyboard.press( 'Escape' );

		// The abilities bridge registers tools asynchronously after the editor
		// mounts, so wait for the WebMCP surface to actually list one before
		// any test tries to call it.
		await page.waitForFunction(
			async () => {
				const modelContext = ( document as any ).modelContext;
				if ( ! modelContext?.getTools ) {
					return false;
				}
				const tools = await modelContext.getTools();
				return tools.some(
					( tool: { name: string } ) => tool.name === 'editor_get-editor-tree'
				);
			},
			null,
			{ timeout: 15_000 }
		);

		// Tools register before the editor finishes booting. Until core/editor
		// is ready, an insert records no undo step; until the canvas renders,
		// containers have no block-list settings. Tests must not race either.
		await page.waitForFunction(
			() => {
				const w = window as any;
				const editorReady = w.wp?.data
					?.select( 'core/editor' )
					?.__unstableIsEditorReady?.();
				const canvas = document.querySelector(
					'iframe[name="editor-canvas"]'
				) as HTMLIFrameElement | null;
				const root = (
					canvas?.contentDocument ?? document
				).querySelector( '.is-root-container' );
				return !! editorReady && !! root;
			},
			null,
			{ timeout: 15_000 }
		);

		await use( page );
	},

	callTool: async ( { editor }, use ) => {
		const callTool = async (
			name: string,
			args: Record< string, unknown > = {}
		): Promise< ToolResult > =>
			editor.evaluate(
				async ( { name, args } ) => {
					// The `editor` fixture already confirmed modelContext exists once,
					// but under load (many workers sharing one backend) the page can
					// still be settling when this runs, so re-check rather than trust
					// that earlier snapshot.
					// Matches the `editor` fixture's own 15s budget below: under many
					// parallel workers sharing one backend, this is genuinely slow to
					// settle rather than transiently missing, so a short retry window
					// just trades a hang for a flake.
					const waitForModelContext = async ( timeoutMs = 15_000 ) => {
						const started = Date.now();
						while ( Date.now() - started < timeoutMs ) {
							const current = ( document as any ).modelContext;
							if ( current?.getTools ) {
								return current;
							}
							await new Promise( ( resolve ) =>
								setTimeout( resolve, 50 )
							);
						}
						throw new Error(
							'document.modelContext was not available in time.'
						);
					};

					const modelContext = await waitForModelContext();
					const tools = await modelContext.getTools();
					const tool = tools.find(
						( candidate: { name: string } ) => candidate.name === name
					);
					if ( ! tool ) {
						throw new Error( `Tool not registered: ${ name }` );
					}

					const raw = await modelContext.executeTool(
						tool,
						JSON.stringify( args ?? {} )
					);
					const parsed = typeof raw === 'string' ? JSON.parse( raw ) : raw;

					const text = ( parsed?.content || [] )
						.filter( ( block: { type: string } ) => block.type === 'text' )
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
