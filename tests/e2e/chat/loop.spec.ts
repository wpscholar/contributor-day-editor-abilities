import { test, expect } from '../fixtures';
import type { Page, Route } from '@playwright/test';
import { openEditor } from '../open-editor';

/*
 * These drive the real panel and tool loop against a faked chat endpoint, so
 * they need no AI connector and cost nothing. Only the endpoint is faked: the
 * tools run for real against the editor.
 */

const SIDEBAR = 'agentic-editor-chat/agentic-editor-chat';

/**
 * Serve pages with the chat configured as if a connector were, or were not,
 * set up. Local sites often have one whether or not a test wants it, since
 * WordPress picks provider keys up from the environment.
 */
async function pretendConnector( page: Page, available = true ) {
	await page.route(
		( url ) =>
			url.pathname.endsWith( '/post-new.php' ) ||
			url.pathname.endsWith( '/tools.php' ),
		async ( route ) => {
			const response = await route.fetch();
			const body = ( await response.text() ).replace(
				/("available":)(true|false)/,
				`$1${ available }`
			);
			await route.fulfill( { response, body } );
		}
	);
}

type Turn =
	Record< string, unknown > | ( () => Promise< Record< string, unknown > > );

/** Answer chat requests in order, recording each request body. */
async function fakeChat( page: Page, turns: Turn[] ) {
	const bodies: any[] = [];
	await page.route(
		( url ) =>
			/agentic-editor(\/|%2F)v1(\/|%2F)chat$/.test(
				url.pathname + ( url.searchParams.get( 'rest_route' ) ?? '' )
			),
		async ( route: Route ) => {
			bodies.push( route.request().postDataJSON() );
			const next = turns.shift();
			if ( ! next ) {
				await route.fulfill( {
					status: 500,
					json: { message: 'Unexpected chat request.' },
				} );
				return;
			}
			const turn = typeof next === 'function' ? await next() : next;
			const status = typeof turn.status === 'number' ? turn.status : 200;
			await route.fulfill( { status, json: turn.body ?? turn } );
		}
	);
	return bodies;
}

function textTurn( text: string ) {
	return {
		message: {
			role: 'assistant',
			parts: [ { channel: 'content', type: 'text', text } ],
		},
		text,
		toolCalls: [],
		meta: { provider: 'Fake', model: 'Fake Model' },
		historyMode: 'native',
	};
}

function callTurn( id: string, name: string, args: Record< string, unknown > ) {
	return {
		message: {
			role: 'assistant',
			parts: [
				{
					channel: 'content',
					type: 'function_call',
					functionCall: { id, name, args },
				},
			],
		},
		text: '',
		toolCalls: [ { id, name, arguments: args } ],
		meta: { provider: 'Fake', model: 'Fake Model' },
		historyMode: 'native',
	};
}

async function openSidebar( page: Page ) {
	await page.evaluate( ( sidebar ) => {
		( window as any ).wp.data
			.dispatch( 'core/edit-post' )
			.openGeneralSidebar( sidebar );
	}, SIDEBAR );
	const panel = page.locator( '.cdchat-sidebar' );
	await expect( panel.getByLabel( 'Message' ) ).toBeVisible();
	return panel;
}

test.describe( 'chat loop', () => {
	test( 'runs a tool, shows progress between rounds, and answers', async ( {
		page,
	} ) => {
		let release: () => void = () => {};
		const held = new Promise< void >( ( resolve ) => {
			release = resolve;
		} );
		const bodies = await fakeChat( page, [
			callTurn( 'c1', 'editor_get-editor-tree', {} ),
			async () => {
				await held;
				return textTurn( 'The post is **empty**.' );
			},
		] );
		await pretendConnector( page );
		await openEditor( page );
		const panel = await openSidebar( page );

		await panel.getByLabel( 'Message' ).fill( 'What is in this post?' );
		await panel.getByRole( 'button', { name: 'Send' } ).click();

		// The tool has run and the second round is waiting on the model.
		await expect(
			panel.getByText( 'Done', { exact: true } )
		).toBeVisible();
		await expect( panel.getByRole( 'status' ) ).toHaveText( 'Thinking…' );

		release();
		await expect(
			panel.getByText( 'empty', { exact: true } )
		).toHaveJSProperty( 'tagName', 'STRONG' );
		await expect( panel.getByRole( 'status' ) ).toHaveCount( 0 );

		// The second request answered the call with the tool's real result.
		const toolTurn = bodies[ 1 ].messages.at( -1 );
		expect( toolTurn.role ).toBe( 'tool' );
		expect( toolTurn.responses[ 0 ] ).toMatchObject( {
			id: 'c1',
			name: 'editor_get-editor-tree',
			response: { count: 0, blocks: [] },
		} );
	} );

	test( 'waits for approval, says so, and reports a denial to the model', async ( {
		page,
	} ) => {
		const bodies = await fakeChat( page, [
			callTurn( 'c1', 'editor_create-pattern', {
				title: 'Never saved',
				blocks: [ { name: 'core/paragraph' } ],
			} ),
			textTurn( 'Understood.' ),
		] );
		await pretendConnector( page );
		await openEditor( page );
		const panel = await openSidebar( page );

		await panel.getByLabel( 'Message' ).fill( 'Save a pattern.' );
		await panel.getByRole( 'button', { name: 'Send' } ).click();

		await expect( panel.getByRole( 'status' ) ).toHaveText(
			'Waiting for your approval…'
		);
		await panel.getByRole( 'button', { name: 'Deny' } ).click();

		await expect( panel.getByText( 'Understood.' ) ).toBeVisible();
		expect( bodies[ 1 ].messages.at( -1 ).responses[ 0 ].response ).toEqual(
			{
				error: 'Not run: the user declined this action.',
			}
		);
	} );

	test( 'puts a failed message back in the composer', async ( { page } ) => {
		await fakeChat( page, [
			{
				status: 502,
				body: {
					code: 'agentic_editor_generation_failed',
					message: 'The AI provider could not answer.',
				},
			},
		] );
		await pretendConnector( page );
		await page.goto( '/wp-admin/tools.php?page=agentic-editor-chat' );
		const panel = page.locator( '#agentic-editor-chat-root' );

		await panel.getByLabel( 'Message' ).fill( 'Hello there' );
		await panel.getByRole( 'button', { name: 'Send' } ).click();

		await expect(
			panel.getByText( 'The AI provider could not answer.' )
		).toBeVisible();
		await expect( panel.getByLabel( 'Message' ) ).toHaveValue(
			'Hello there'
		);
		// Only the composer holds it; the failed message's bubble is gone.
		await expect(
			panel.locator( 'span.whitespace-pre-wrap', {
				hasText: 'Hello there',
			} )
		).toHaveCount( 0 );
	} );

	test( 'offers no way to send without a connector', async ( { page } ) => {
		await pretendConnector( page, false );
		await page.goto( '/wp-admin/tools.php?page=agentic-editor-chat' );
		const panel = page.locator( '#agentic-editor-chat-root' );

		await panel.getByLabel( 'Message' ).fill( 'Hello' );
		await expect(
			panel.getByRole( 'button', { name: 'Send' } )
		).toBeDisabled();
		await expect(
			panel.getByRole( 'button', {
				name: 'What can you help me with here?',
			} )
		).toBeDisabled();
	} );
} );
