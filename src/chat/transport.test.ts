import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readUIMessageStream } from 'ai';
import { chatConfig } from '@agentic-editor/chat-config';
import { callTool, listTools } from '@agentic-editor/webmcp-tools';
import { WordPressAiTransport, type ChatUIMessage } from './transport';

vi.mock( '@agentic-editor/webmcp-tools', () => ( {
	listTools: vi.fn(),
	callTool: vi.fn(),
	onToolsChanged: vi.fn(),
} ) );

type Call = { id: string; name: string; args?: Record< string, unknown > };

/** An endpoint response in which the model answers with text. */
function textTurn( text: string, historyMode = 'native' ) {
	return {
		message: {
			role: 'assistant',
			parts: [ { channel: 'content', type: 'text', text } ],
		},
		text,
		toolCalls: [],
		meta: { provider: 'Test', model: 'Test Model' },
		historyMode,
	};
}

/** An endpoint response in which the model calls tools. */
function callTurn( ...calls: Call[] ) {
	return {
		message: {
			role: 'assistant',
			parts: calls.map( ( call ) => ( {
				channel: 'content',
				type: 'function_call',
				functionCall: { id: call.id, name: call.name, args: call.args ?? {} },
			} ) ),
		},
		text: '',
		toolCalls: calls.map( ( call ) => ( {
			id: call.id,
			name: call.name,
			arguments: call.args ?? {},
		} ) ),
		meta: { provider: 'Test', model: 'Test Model' },
		historyMode: 'native',
	};
}

function userMessage( text: string, id = `user-${ text }` ): ChatUIMessage {
	return { id, role: 'user', parts: [ { type: 'text', text } ] };
}

/** Answer each chat request with the next body, and record what was sent. */
function respondWith( ...bodies: Array< object | ( () => Response ) > ) {
	const fetchMock = vi.fn( async ( _url: string, _init: RequestInit ) => {
		const next = bodies.shift();
		if ( ! next ) {
			throw new Error( 'Unexpected chat request' );
		}
		return typeof next === 'function'
			? next()
			: new Response( JSON.stringify( next ), { status: 200 } );
	} );
	vi.stubGlobal( 'fetch', fetchMock );

	return {
		requests: () =>
			fetchMock.mock.calls.map( ( [ , init ] ) => JSON.parse( String( init.body ) ) ),
	};
}

/** Run one send and fold the stream the way useChat does. */
async function send(
	transport: WordPressAiTransport,
	messages: ChatUIMessage[],
	abortSignal?: AbortSignal
) {
	const stream = await transport.sendMessages( {
		trigger: 'submit-message',
		chatId: 'chat',
		messageId: undefined,
		messages,
		abortSignal,
	} );

	const errors: string[] = [];
	let message: ChatUIMessage | undefined;
	for await ( const snapshot of readUIMessageStream< ChatUIMessage >( {
		stream,
		terminateOnError: false,
		onError: ( error ) => errors.push( ( error as Error ).message ?? String( error ) ),
	} ) ) {
		message = snapshot;
	}

	return { message: message!, errors, wire: message?.metadata?.wire ?? [] };
}

/**
 * Every function call in the stored history must be answered by the next turn,
 * or providers reject the conversation when it is replayed.
 */
function expectEveryCallAnswered( wire: unknown[] ) {
	wire.forEach( ( turn: any, index ) => {
		if ( turn.role !== 'assistant' ) {
			return;
		}
		const ids = turn.parts
			.filter( ( part: any ) => part.functionCall )
			.map( ( part: any ) => part.functionCall.id );
		if ( ! ids.length ) {
			return;
		}
		const next: any = wire[ index + 1 ];
		expect( next?.role, `turn ${ index } has unanswered calls` ).toBe( 'tool' );
		expect( next.responses.map( ( response: any ) => response.id ) ).toEqual( ids );
	} );
}

beforeEach( () => {
	chatConfig.maxToolRounds = 8;
	vi.mocked( listTools ).mockResolvedValue( [
		{ name: 'editor_get-editor-tree', description: 'Tree', source: 'local' },
	] );
	vi.mocked( callTool ).mockResolvedValue( {
		isError: false,
		value: { blocks: [] },
		text: '',
	} );
} );

afterEach( () => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
} );

describe( 'WordPressAiTransport', () => {
	it( 'finishes on a text-only answer', async () => {
		const { requests } = respondWith( textTurn( 'Hello there.' ) );

		const { message, errors, wire } = await send( new WordPressAiTransport(), [
			userMessage( 'Hi' ),
		] );

		expect( errors ).toEqual( [] );
		expect( message.parts ).toContainEqual(
			expect.objectContaining( { type: 'text', text: 'Hello there.' } )
		);
		expect( wire ).toEqual( [
			{ role: 'assistant', parts: textTurn( 'Hello there.' ).message.parts },
		] );
		expect( message.metadata?.model ).toBe( 'Test Model' );
		expect( requests()[ 0 ].messages ).toEqual( [ { role: 'user', content: 'Hi' } ] );
		expect( requests()[ 0 ].tools ).toEqual( [
			{ name: 'editor_get-editor-tree', description: 'Tree' },
		] );
	} );

	it( 'runs a tool round, sends the result back, then finishes', async () => {
		const { requests } = respondWith(
			callTurn( { id: 'call_1', name: 'editor_get-editor-tree', args: { depth: 1 } } ),
			textTurn( 'The post is empty.' )
		);

		const { errors, wire, message } = await send( new WordPressAiTransport(), [
			userMessage( 'What is in the post?' ),
		] );

		expect( errors ).toEqual( [] );
		expect( callTool ).toHaveBeenCalledWith( 'editor_get-editor-tree', { depth: 1 } );
		expect( wire.map( ( turn ) => turn.role ) ).toEqual( [ 'assistant', 'tool', 'assistant' ] );
		expect( wire[ 1 ] ).toEqual( {
			role: 'tool',
			responses: [ { id: 'call_1', name: 'editor_get-editor-tree', response: { blocks: [] } } ],
		} );
		expect( requests()[ 1 ].messages.slice( 1 ) ).toEqual( wire.slice( 0, 2 ) );
		expect( message.parts ).toContainEqual(
			expect.objectContaining( { type: 'dynamic-tool', state: 'output-available' } )
		);
		expectEveryCallAnswered( wire );
	} );

	it( 'answers the last round of calls when it hits the round limit', async () => {
		chatConfig.maxToolRounds = 2;
		const { requests } = respondWith(
			callTurn( { id: 'call_1', name: 'editor_get-editor-tree' } ),
			callTurn( { id: 'call_2', name: 'editor_get-editor-tree' } ),
			callTurn( { id: 'call_3', name: 'editor_get-editor-tree' } )
		);

		const { errors, wire } = await send( new WordPressAiTransport(), [ userMessage( 'Loop' ) ] );

		expect( requests() ).toHaveLength( 3 );
		expect( callTool ).toHaveBeenCalledTimes( 2 );
		expect( errors ).toEqual( [ 'The assistant stopped after 2 rounds of tool calls.' ] );
		expectEveryCallAnswered( wire );
		expect( ( wire.at( -1 ) as any ).responses[ 0 ].response ).toEqual( {
			error: 'Not run: the assistant reached its limit of 2 rounds of tool calls.',
		} );
	} );

	it( 'keeps the history consistent when stopped during a tool call', async () => {
		const controller = new AbortController();
		respondWith(
			callTurn(
				{ id: 'call_1', name: 'editor_get-editor-tree' },
				{ id: 'call_2', name: 'editor_get-editor-tree' }
			)
		);
		vi.mocked( callTool ).mockImplementationOnce( async () => {
			controller.abort();
			return { isError: false, value: { blocks: [ 'one' ] }, text: '' };
		} );

		const { errors, wire } = await send(
			new WordPressAiTransport(),
			[ userMessage( 'Stop me' ) ],
			controller.signal
		);

		expect( errors ).toEqual( [] );
		expect( callTool ).toHaveBeenCalledTimes( 1 );
		expectEveryCallAnswered( wire );
		expect( ( wire[ 1 ] as any ).responses.map( ( response: any ) => response.response ) ).toEqual( [
			{ blocks: [ 'one' ] },
			{ error: 'Not run: the user stopped the assistant.' },
		] );
	} );

	it( 'reports a failed tool call to the model and the UI', async () => {
		respondWith(
			callTurn( { id: 'call_1', name: 'editor_get-editor-tree' } ),
			textTurn( 'That failed.' )
		);
		vi.mocked( callTool ).mockResolvedValueOnce( {
			isError: true,
			value: { error: 'No editor' },
			text: 'No editor',
		} );

		const { wire, message } = await send( new WordPressAiTransport(), [ userMessage( 'Try' ) ] );

		expect( ( wire[ 1 ] as any ).responses[ 0 ].response ).toEqual( { error: 'No editor' } );
		expect( message.parts ).toContainEqual(
			expect.objectContaining( { type: 'dynamic-tool', state: 'output-error', errorText: 'No editor' } )
		);
	} );

	it( 'surfaces the endpoint error message and stores only whole rounds', async () => {
		respondWith(
			callTurn( { id: 'call_1', name: 'editor_get-editor-tree' } ),
			() => new Response( JSON.stringify( { message: 'Rate limited.' } ), { status: 429 } )
		);

		const { errors, wire } = await send( new WordPressAiTransport(), [ userMessage( 'Hi' ) ] );

		expect( errors ).toEqual( [ 'Rate limited.' ] );
		expect( wire.map( ( turn ) => turn.role ) ).toEqual( [ 'assistant', 'tool' ] );
		expectEveryCallAnswered( wire );
	} );

	it( 'reports the history mode that worked on the next request', async () => {
		const { requests } = respondWith( textTurn( 'One', 'text' ), textTurn( 'Two' ) );
		const transport = new WordPressAiTransport();

		const first = await send( transport, [ userMessage( 'A' ) ] );
		await send( transport, [ userMessage( 'A' ), first.message, userMessage( 'B' ) ] );

		expect( requests()[ 0 ].historyMode ).toBe( 'native' );
		expect( requests()[ 1 ].historyMode ).toBe( 'text' );
	} );

	it( 'replays a stored turn exactly and never changes it afterwards', async () => {
		const { requests } = respondWith(
			callTurn( { id: 'call_1', name: 'editor_get-editor-tree' } ),
			textTurn( 'Done.' ),
			textTurn( 'Again.' )
		);
		const transport = new WordPressAiTransport();

		const first = await send( transport, [ userMessage( 'A' ) ] );
		const stored = structuredClone( first.wire );
		await send( transport, [ userMessage( 'A' ), first.message, userMessage( 'B' ) ] );

		expect( first.wire ).toEqual( stored );
		expect( requests()[ 2 ].messages ).toEqual( [
			{ role: 'user', content: 'A' },
			...stored,
			{ role: 'user', content: 'B' },
		] );
	} );
} );
