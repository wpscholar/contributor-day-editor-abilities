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
			panel.getByRole( 'log' ).getByText( 'Done', { exact: true } )
		).toBeVisible();
		await expect( panel.getByRole( 'status' ) ).toHaveText( 'Thinking…' );

		release();
		await expect(
			panel.getByRole( 'log' ).getByText( 'empty', { exact: true } )
		).toHaveJSProperty( 'tagName', 'STRONG' );
		await expect( panel.getByRole( 'status' ) ).toHaveText( 'Done' );

		// The second request answered the call with the tool's real result.
		const toolTurn = bodies[ 1 ].messages.at( -1 );
		expect( toolTurn.role ).toBe( 'tool' );
		expect( toolTurn.responses[ 0 ] ).toMatchObject( {
			id: 'c1',
			name: 'editor_get-editor-tree',
			response: { count: 0, blocks: [] },
		} );
	} );

	test( 'shows the thinking collapsed above the answer', async ( {
		page,
	} ) => {
		await fakeChat( page, [
			{
				...textTurn( 'Hello.' ),
				reasoning: 'The user said **hi**.',
			},
		] );
		await pretendConnector( page );
		await page.goto( '/wp-admin/tools.php?page=agentic-editor-chat' );
		const panel = page.locator( '#agentic-editor-chat-root' );

		await panel.getByLabel( 'Message' ).fill( 'Hi' );
		await panel.getByRole( 'button', { name: 'Send' } ).click();

		const log = panel.getByRole( 'log' );
		await expect( log.getByText( 'Hello.' ) ).toBeVisible();
		const thinking = log.locator( 'details', { hasText: 'Thinking' } );
		await expect( thinking ).not.toHaveAttribute( 'open' );
		await expect( log.getByText( 'hi', { exact: true } ) ).toBeHidden();

		await thinking.getByText( 'Thinking' ).click();
		await expect( log.getByText( 'hi', { exact: true } ) ).toHaveJSProperty(
			'tagName',
			'STRONG'
		);
		// Only the answer is read out, not the thinking.
		await expect( panel.locator( 'p.sr-only' ) ).toHaveText( 'Hello.' );
	} );

	test( 'says when a reply was stopped or did not finish', async ( {
		page,
	} ) => {
		await fakeChat( page, [
			callTurn( 'c1', 'editor_get-editor-tree', {} ),
			// Never answers, so the only way on is Stop.
			() => new Promise( () => {} ),
			callTurn( 'c2', 'editor_get-editor-tree', {} ),
			{
				status: 502,
				body: {
					code: 'agentic_editor_generation_failed',
					message: 'The AI provider could not answer.',
				},
			},
		] );
		await pretendConnector( page );
		await openEditor( page );
		const panel = await openSidebar( page );
		const status = panel.getByRole( 'status' );

		await panel.getByLabel( 'Message' ).fill( 'Look around.' );
		await panel.getByRole( 'button', { name: 'Send' } ).click();
		await expect( status ).toHaveText( 'Thinking…' );
		await expect(
			panel.getByRole( 'log' ).getByText( 'Done', { exact: true } )
		).toBeVisible();
		await panel.getByRole( 'button', { name: 'Stop' } ).click();
		await expect( status ).toHaveText( 'Stopped' );

		await panel.getByLabel( 'Message' ).fill( 'Try again.' );
		await panel.getByRole( 'button', { name: 'Send' } ).click();
		await expect(
			panel
				.getByRole( 'log' )
				.getByText( 'The AI provider could not answer.' )
		).toBeVisible();
		await expect( status ).toHaveText( 'Did not finish' );
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

		await expect(
			panel.getByRole( 'log' ).getByText( 'Understood.' )
		).toBeVisible();
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
			panel
				.getByRole( 'log' )
				.getByText( 'The AI provider could not answer.' )
		).toBeVisible();
		await expect( panel.getByLabel( 'Message' ) ).toHaveValue(
			'Hello there'
		);
		// No reply was started, so there is no reply to call unfinished.
		await expect( panel.getByRole( 'status' ) ).toHaveCount( 0 );
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

	test( 'follows a new message after the reader scrolled up, and announces the reply', async ( {
		page,
	} ) => {
		const long = Array.from(
			{ length: 60 },
			( _, line ) => `Line ${ line + 1 }`
		).join( '\n\n' );
		await fakeChat( page, [
			textTurn( long ),
			textTurn( 'Short answer.' ),
		] );
		await pretendConnector( page );
		await page.goto( '/wp-admin/tools.php?page=agentic-editor-chat' );
		const panel = page.locator( '#agentic-editor-chat-root' );
		const log = panel.getByRole( 'log' );

		await panel.getByLabel( 'Message' ).fill( 'Long, please.' );
		await panel.getByRole( 'button', { name: 'Send' } ).click();
		await expect(
			panel.getByRole( 'log' ).getByText( 'Line 60' )
		).toBeVisible();

		await log.evaluate( ( element ) => {
			element.scrollTop = 0;
			element.dispatchEvent( new Event( 'scroll' ) );
		} );
		await expect(
			panel.getByRole( 'button', { name: 'Jump to latest' } )
		).toBeVisible();

		await panel.getByLabel( 'Message' ).fill( 'Now short.' );
		await panel.getByRole( 'button', { name: 'Send' } ).click();
		await expect(
			panel.getByRole( 'log' ).getByText( 'Short answer.' )
		).toBeInViewport();
		await expect(
			panel.getByRole( 'button', { name: 'Jump to latest' } )
		).toHaveCount( 0 );

		await expect( panel.locator( 'p.sr-only' ) ).toHaveText(
			'Short answer.'
		);
	} );
} );

test.describe( 'selected block attachment', () => {
	/** Insert two paragraphs and return their client IDs. */
	async function insertParagraphs( page: Page ): Promise< string[] > {
		return page.evaluate( () => {
			const { dispatch, select } = ( window as any ).wp.data;
			const { createBlock } = ( window as any ).wp.blocks;
			dispatch( 'core/block-editor' ).insertBlocks( [
				createBlock( 'core/paragraph', {
					content: 'First <b>one</b>',
				} ),
				createBlock( 'core/paragraph', { content: 'Second one' } ),
			] );
			return select( 'core/block-editor' )
				.getBlocks()
				.map( ( block: any ) => block.clientId );
		} );
	}

	async function selectBlock( page: Page, clientId: string | null ) {
		await page.evaluate( ( id ) => {
			const store = ( window as any ).wp.data.dispatch(
				'core/block-editor'
			);
			if ( id ) {
				store.selectBlock( id );
			} else {
				store.clearSelectedBlock();
			}
		}, clientId );
	}

	test( 'attaches the selected block until it is removed or deselected', async ( {
		page,
	} ) => {
		const bodies = await fakeChat( page, [
			textTurn( 'One.' ),
			textTurn( 'Two.' ),
			textTurn( 'Three.' ),
		] );
		await pretendConnector( page );
		await openEditor( page );
		const [ first, second ] = await insertParagraphs( page );
		const panel = await openSidebar( page );
		const chip = panel.getByText( 'Attached', { exact: true } );
		const remove = panel.getByRole( 'button', {
			name: 'Remove attached block',
		} );

		await selectBlock( page, null );
		await expect( chip ).toBeHidden();

		await selectBlock( page, first );
		await expect( chip ).toBeVisible();
		await expect( panel.getByText( 'Paragraph: First one' ) ).toBeVisible();

		await panel.getByLabel( 'Message' ).fill( 'Shorten this.' );
		await panel.getByRole( 'button', { name: 'Send' } ).click();
		await expect( panel.getByRole( 'status' ) ).toHaveText( 'Done' );

		expect( bodies[ 0 ].context.attachedBlock ).toMatchObject( {
			clientId: first,
			name: 'core/paragraph',
			attributes: { content: 'First <b>one</b>' },
		} );
		expect( bodies[ 0 ].context.notes ).not.toContain( first );
		// The transcript records what the message was sent with.
		await expect(
			panel.getByRole( 'log' ).getByText( 'Paragraph: First one' )
		).toBeVisible();
		// The attachment stays for the next turn while the block is selected.
		await expect( chip ).toBeVisible();

		// Removing it stays removed while the same block is selected.
		await remove.click();
		await expect( chip ).toBeHidden();
		await panel.getByLabel( 'Message' ).fill( 'Summarize the post.' );
		await panel.getByRole( 'button', { name: 'Send' } ).click();
		await expect(
			panel.getByRole( 'log' ).getByText( 'Two.' )
		).toBeVisible();
		expect( bodies[ 1 ].context.attachedBlock ).toBeUndefined();

		// A different block attaches again.
		await selectBlock( page, second );
		await expect(
			panel.getByText( 'Paragraph: Second one' )
		).toBeVisible();
		await panel.getByLabel( 'Message' ).fill( 'And this?' );
		await panel.getByRole( 'button', { name: 'Send' } ).click();
		await expect(
			panel.getByRole( 'log' ).getByText( 'Three.' )
		).toBeVisible();
		expect( bodies[ 2 ].context.attachedBlock.clientId ).toBe( second );
	} );
} );
