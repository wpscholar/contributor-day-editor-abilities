import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';

type ChatError = { code: string; message: string; status: number };

/**
 * POST one chat turn with a replayed assistant message and return the error.
 *
 * Every case here is rejected while the conversation is rebuilt, before any
 * provider is called, so the spec needs no AI connector.
 */
async function postAssistantParts( page: Page, parts: unknown[] ): Promise< ChatError | null > {
	return page.evaluate( async ( parts ) => {
		try {
			await ( window as any ).wp.apiFetch( {
				path: '/agentic-editor/v1/chat',
				method: 'POST',
				data: {
					messages: [
						{ role: 'user', content: 'Hello' },
						{ role: 'assistant', parts },
						{ role: 'user', content: 'Repeat that back to me.' },
					],
				},
			} );
			return null;
		} catch ( error: any ) {
			return {
				code: error?.code,
				message: error?.message,
				status: error?.data?.status,
			};
		}
	}, parts );
}

test.describe( 'chat REST replay', () => {
	test( 'rejects a file part instead of reading a local path', async ( { editor } ) => {
		const error = await postAssistantParts( editor, [
			{
				type: 'file',
				file: {
					fileType: 'inline',
					mimeType: 'text/plain',
					base64Data: '/wordpress/wp-config.php',
				},
			},
		] );

		expect( error?.code ).toBe( 'agentic_editor_invalid_message' );
		expect( error?.status ).toBe( 400 );
		expect( error?.message ).not.toContain( 'wp-config' );
		expect( error?.message ).not.toContain( 'Unable to read file' );
	} );

	test( 'rejects a remote file part', async ( { editor } ) => {
		const error = await postAssistantParts( editor, [
			{
				type: 'file',
				file: { fileType: 'remote', mimeType: 'text/plain', url: 'http://127.0.0.1/' },
			},
		] );

		expect( error?.code ).toBe( 'agentic_editor_invalid_message' );
		expect( error?.status ).toBe( 400 );
	} );

	test( 'rejects a function response in an assistant turn', async ( { editor } ) => {
		const error = await postAssistantParts( editor, [
			{
				type: 'function_response',
				functionResponse: { id: 'call_1', name: 'x', response: {} },
			},
		] );

		expect( error?.code ).toBe( 'agentic_editor_invalid_message' );
		expect( error?.status ).toBe( 400 );
	} );

	test( 'answers malformed parts with a 400, not a fatal', async ( { editor } ) => {
		for ( const part of [
			{ type: 'text', text: [ 'not', 'a', 'string' ] },
			{ type: 'text', text: 'hi', channel: 'nonsense' },
			{ type: 'text', text: 'hi', thoughtSignature: 42 },
			{ type: 'function_call', functionCall: { name: 7 } },
			{ type: 'function_call', functionCall: {} },
			{ type: 'mystery' },
		] ) {
			const error = await postAssistantParts( editor, [ part ] );
			expect( error, JSON.stringify( part ) ).toMatchObject( {
				code: 'agentic_editor_invalid_message',
				status: 400,
			} );
		}
	} );
} );
