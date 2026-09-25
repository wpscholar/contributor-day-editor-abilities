import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';

/**
 * Permanently delete a pattern (a `wp_block` post) a test created.
 */
async function deletePattern( editor: Page, id: number ) {
	await editor.evaluate( async ( id ) => {
		await ( window as any ).wp.apiFetch( {
			path: `/wp/v2/blocks/${ id }?force=true`,
			method: 'DELETE',
		} );
	}, id );
}

test.describe( 'patterns', () => {
	test( 'editor/get-pattern-categories lists at least one category', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_get-pattern-categories' );
		expect( result.isError ).toBe( false );
		expect( result.value.count ).toBeGreaterThan( 0 );
		expect( result.value.categories ).toHaveLength( result.value.count );
	} );

	test( 'editor/get-patterns lists patterns, and editor/get-pattern reads one in full', async ( {
		callTool,
	} ) => {
		const list = await callTool( 'editor_get-patterns' );
		expect( list.isError ).toBe( false );

		// The test site's theme always registers patterns, so an empty list
		// is a failure to find them, not a site without any.
		expect( list.value.totalCount ).toBeGreaterThan( 0 );

		const first = list.value.patterns[ 0 ];
		const pattern = await callTool( 'editor_get-pattern', {
			name: first.name,
		} );
		expect( pattern.isError ).toBe( false );
		expect( pattern.value.name ).toBe( first.name );
		expect( pattern.value.blockCount ).toBeGreaterThan( 0 );
		expect( pattern.value.blocks.length ).toBeGreaterThan( 0 );
	} );

	test( 'editor/get-pattern fails for an unknown pattern name', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_get-pattern', {
			name: 'not/a-real-pattern',
		} );
		expect( result.isError ).toBe( true );
	} );

	test( 'editor/create-pattern saves blocks as a pattern, and editor/insert-pattern inserts it', async ( {
		editor,
		callTool,
	} ) => {
		const title = `E2E pattern ${ Date.now() }`;

		const created = await callTool( 'editor_create-pattern', {
			title,
			blocks: [
				{
					name: 'core/paragraph',
					attributes: { content: 'Saved from a test' },
				},
			],
		} );
		expect( created.isError ).toBe( false );

		try {
			expect( created.value.title ).toBe( title );
			expect( created.value.blockCount ).toBe( 1 );
			expect( created.value.syncStatus ).toBe( 'unsynced' );

			const inserted = await callTool( 'editor_insert-pattern', {
				name: created.value.name,
			} );
			expect( inserted.isError ).toBe( false );
			expect( inserted.value.count ).toBeGreaterThan( 0 );

			const found = await callTool( 'editor_find-editor-blocks', {
				search: 'Saved from a test',
			} );
			expect( found.value.count ).toBeGreaterThan( 0 );
		} finally {
			// The dev site is shared with manual testing; leave no patterns.
			await deletePattern( editor, created.value.id );
		}
	} );

	test( 'editor/create-pattern requires either clientIds or blocks, not both or neither', async ( {
		callTool,
	} ) => {
		const result = await callTool( 'editor_create-pattern', {
			title: `E2E pattern ${ Date.now() }`,
		} );
		expect( result.isError ).toBe( true );
	} );
} );
