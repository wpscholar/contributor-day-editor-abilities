import type { Page } from '@playwright/test';

/**
 * Open a fresh post in the block editor and wait until abilities can be
 * exercised against it.
 */
export async function openEditor( page: Page, timeout = 15_000 ) {
	// A fresh auto-draft per call keeps abilities from stepping on each other.
	await page.goto( '/wp-admin/post-new.php', { timeout } );

	// A brand-new site shows the welcome guide as a modal on first load.
	await page.keyboard.press( 'Escape' );

	// The abilities bridge registers tools asynchronously after the editor
	// mounts, so wait for the WebMCP surface to actually list one.
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
		{ timeout }
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
			const root = ( canvas?.contentDocument ?? document ).querySelector(
				'.is-root-container'
			);
			return !! editorReady && !! root;
		},
		null,
		{ timeout }
	);
}
