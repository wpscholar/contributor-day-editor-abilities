import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';

type ChatStatus = {
	available: boolean;
	hasAiClient: boolean;
	modelPreference: string[];
	connectorsUrl: string | null;
};

/**
 * GET the chat status as the page's user.
 */
async function chatStatus( page: Page ): Promise< ChatStatus > {
	return page.evaluate( () =>
		( window as any ).wp.apiFetch( {
			path: '/agentic-editor/v1/chat/status',
		} )
	);
}

const SIDEBAR = 'agentic-editor-chat/agentic-editor-chat';

test.describe( 'chat panel', () => {
	test( 'status reports the AI Client', async ( { editor } ) => {
		const status = await chatStatus( editor );

		expect( status.hasAiClient ).toBe( true );
		expect( typeof status.available ).toBe( 'boolean' );
		expect( status.modelPreference.length ).toBeGreaterThan( 0 );
		expect( status.connectorsUrl ).toContain( 'options-connectors.php' );
	} );

	test( 'the editor sidebar offers every editor ability', async ( {
		editor,
	} ) => {
		const abilityCount = await editor.evaluate(
			() => ( window as any ).agenticEditorAbilities.abilityNames.length
		);

		await editor.evaluate( ( sidebar ) => {
			( window as any ).wp.data
				.dispatch( 'core/edit-post' )
				.openGeneralSidebar( sidebar );
		}, SIDEBAR );

		const panel = editor.locator( '.cdchat-sidebar' );
		await expect( panel.getByLabel( 'Message' ) ).toBeVisible();
		await expect(
			panel.getByRole( 'button', {
				name: `${ abilityCount } page tools`,
			} )
		).toBeVisible();
	} );

	test( 'the editor shares WordPress React, with no second copy', async ( {
		editor,
	} ) => {
		const warnings: string[] = [];
		editor.on( 'console', ( message ) => {
			if (
				/two copies of React|Invalid hook call/i.test( message.text() )
			) {
				warnings.push( message.text() );
			}
		} );

		await editor.evaluate( ( sidebar ) => {
			( window as any ).wp.data
				.dispatch( 'core/edit-post' )
				.openGeneralSidebar( sidebar );
		}, SIDEBAR );
		await expect(
			editor.locator( '.cdchat-sidebar' ).getByLabel( 'Message' )
		).toBeVisible();

		const version = await editor.evaluate(
			() => ( window as any ).React?.version
		);
		expect( version ).toMatch( /^18\./ );
		expect( warnings ).toEqual( [] );
	} );

	test( 'Tools → AI Chat renders without tools and without leaking styles', async ( {
		page,
	} ) => {
		await page.goto( '/wp-admin/tools.php?page=agentic-editor-chat' );

		const panel = page.locator( '#agentic-editor-chat-root' );
		await expect( panel.getByLabel( 'Message' ) ).toBeVisible();
		await expect(
			panel.getByRole( 'button', { name: 'No page tools' } )
		).toBeVisible();

		// The editor's abilities are not loaded here.
		expect(
			await page.evaluate(
				() => ( window as any ).agenticEditorAbilities
			)
		).toBeUndefined();

		// Tailwind's Preflight would reset admin headings; 23px is core's size.
		await expect( page.locator( '.wrap > h1' ) ).toHaveCSS(
			'font-size',
			'23px'
		);

		const status = await chatStatus( page );
		const notice = panel.getByText(
			'No AI connector is configured, so the assistant cannot answer yet.'
		);
		// Shown exactly when the site has no connector that can answer.
		await expect( notice ).toHaveCount( status.available ? 0 : 1 );
	} );

	test( 'screens without the editor or chat load neither', async ( {
		page,
	} ) => {
		await page.goto( '/wp-admin/index.php' );

		const loaded = await page.evaluate( () => ( {
			abilities: ( window as any ).agenticEditorAbilities,
			chatRoot: !! document.querySelector( '#agentic-editor-chat-root' ),
			importMap:
				document.querySelector( 'script[type="importmap"]' )
					?.textContent ?? '',
		} ) );

		expect( loaded.abilities ).toBeUndefined();
		expect( loaded.chatRoot ).toBe( false );
		expect( loaded.importMap ).not.toContain( '@agentic-editor/' );
	} );
} );
