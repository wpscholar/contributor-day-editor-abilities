import { test, expect } from './fixtures';

const EXPECTED_TOOLS = [
	'editor_get-editor-tree',
	'editor_find-editor-blocks',
	'editor_get-block-location',
	'editor_insert-block',
	'editor_move-block',
	'editor_update-block',
	'editor_remove-block',
	'editor_get-editor-selection',
	'editor_can-insert-block',
	'editor_get-block-types',
	'editor_get-block-type',
	'editor_transform-block',
	'editor_select-block',
	'editor_undo',
	'editor_redo',
	'editor_get-patterns',
	'editor_get-pattern',
	'editor_get-pattern-categories',
	'editor_insert-pattern',
	'editor_create-pattern',
];

test( 'registers all 20 editor abilities as WebMCP tools', async ( { editor } ) => {
	const names: string[] = await editor.evaluate( async () => {
		const tools = await ( document as any ).modelContext.getTools();
		return tools.map( ( tool: { name: string } ) => tool.name );
	} );

	for ( const expected of EXPECTED_TOOLS ) {
		expect( names ).toContain( expected );
	}
} );
