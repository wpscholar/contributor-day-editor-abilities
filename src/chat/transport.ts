/**
 * An AI SDK transport backed by the WordPress AI Client.
 *
 * The REST endpoint runs exactly one model turn and streams nothing, so this
 * transport owns the loop that turns a request into an answer: send the
 * conversation, run whatever tools the model asked for against the page, send
 * the results back, repeat until the model replies with text. Every round is
 * emitted into the one assistant message the AI SDK is expecting, separated by
 * step boundaries.
 *
 * Nothing here touches the DOM or the block editor.
 */

import { chatConfig } from '@agentic-editor/chat-config';
import { callTool, listTools } from '@agentic-editor/webmcp-tools';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';

/**
 * What a turn is replayed from.
 *
 * `wire` holds the raw AI Client messages this assistant turn produced, in
 * order, so a later request can replay the model's own function calls as
 * function calls rather than as a description of them. Anything reconstructed
 * from the rendered UI message would lose the provider's call IDs.
 */
export interface ChatMetadata {
	wire?: WireMessage[];
	model?: string;
	provider?: string;
}

export type ChatUIMessage = UIMessage< ChatMetadata >;

type WireMessage =
	| { role: 'user'; content: string }
	| { role: 'assistant'; parts: unknown[] }
	| { role: 'tool'; responses: ToolResponse[] };

interface ToolResponse {
	id: string | null;
	name: string;
	response: unknown;
}

interface ToolCall {
	id: string | null;
	name: string;
	arguments: Record< string, unknown > | null;
}

interface TurnResponse {
	message?: { role: string; parts: unknown[] };
	text?: string;
	toolCalls?: ToolCall[];
	meta?: { provider?: string; model?: string };
	historyMode?: HistoryMode;
}

type HistoryMode = 'native' | 'text';

type Emit = ( chunk: UIMessageChunk< ChatMetadata > ) => void;

let idCounter = 0;

function nextId( prefix: string ): string {
	idCounter += 1;
	return `${ prefix }-${ idCounter }`;
}

function errorMessage( error: unknown ): string {
	if ( error instanceof Error ) {
		return error.message;
	}
	return String( error );
}

function isAbort( error: unknown ): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

/**
 * Flatten a UI message back into what the endpoint replays.
 *
 * Assistant turns come from their metadata rather than from their rendered
 * parts; see ChatMetadata.
 */
function toWireMessages( message: ChatUIMessage ): WireMessage[] {
	if ( message.role === 'user' ) {
		const content = message.parts
			.filter( ( part ) => part.type === 'text' )
			.map( ( part ) => ( part as { text: string } ).text )
			.join( '\n' )
			.trim();

		return content ? [ { role: 'user', content } ] : [];
	}

	if ( message.role === 'assistant' ) {
		return message.metadata?.wire ?? [];
	}

	return [];
}

/**
 * A tool turn answering every call with the same error.
 *
 * Providers reject a function call that has no response, so a round that is
 * cut short still has to answer each call, and saying why lets the model take
 * it into account on the next message.
 */
function notRunTurn(
	toolCalls: ToolCall[],
	reason: string
): { role: 'tool'; responses: ToolResponse[] } {
	return {
		role: 'tool',
		responses: toolCalls.map( ( call ) => ( {
			id: call.id,
			name: call.name,
			response: { error: reason },
		} ) ),
	};
}

async function readErrorMessage( response: Response ): Promise< string > {
	try {
		const body = await response.json();
		if ( body?.message ) {
			return String( body.message );
		}
	} catch {
		// Fall through to the status text.
	}
	return `The chat request failed (${ response.status } ${ response.statusText }).`;
}

export interface WordPressAiTransportOptions {
	/**
	 * Page context for the system prompt, read at send time so that it
	 * describes the screen as it is now rather than as it was at mount.
	 */
	getContext?: () => Record< string, unknown >;
	/** Whether to offer the page's WebMCP tools to the model. */
	useTools?: boolean;
}

export class WordPressAiTransport implements ChatTransport< ChatUIMessage > {
	private readonly getContext: () => Record< string, unknown >;
	private readonly useTools: boolean;

	/**
	 * How the server replayed tool calls last turn. Reporting it back keeps a
	 * provider that rejects native tool call history from being retried on
	 * every turn of the same conversation.
	 */
	private historyMode: HistoryMode = 'native';

	constructor( options: WordPressAiTransportOptions = {} ) {
		this.getContext = options.getContext ?? ( () => ( {} ) );
		this.useTools = options.useTools ?? true;
	}

	sendMessages( options: {
		trigger: 'submit-message' | 'regenerate-message';
		chatId: string;
		messageId: string | undefined;
		messages: ChatUIMessage[];
		abortSignal: AbortSignal | undefined;
	} ): Promise< ReadableStream< UIMessageChunk< ChatMetadata > > > {
		const { messages, abortSignal } = options;

		/*
		 * Regenerating replaces the last assistant turn, so it must not be part
		 * of the history the model is asked to continue from.
		 */
		const history =
			options.trigger === 'regenerate-message' &&
			messages.at( -1 )?.role === 'assistant'
				? messages.slice( 0, -1 )
				: messages;

		const stream = new ReadableStream< UIMessageChunk< ChatMetadata > >( {
			start: async ( controller ) => {
				const emit: Emit = ( chunk ) => controller.enqueue( chunk );

				try {
					await this.run( history, emit, abortSignal );
				} catch ( error ) {
					if ( ! isAbort( error ) ) {
						emit( {
							type: 'error',
							errorText: errorMessage( error ),
						} );
					}
				} finally {
					controller.close();
				}
			},
		} );

		return Promise.resolve( stream );
	}

	reconnectToStream(): Promise< ReadableStream<
		UIMessageChunk< ChatMetadata >
	> | null > {
		// Every turn is driven from the browser, so there is nothing to rejoin.
		return Promise.resolve( null );
	}

	private async run(
		history: ChatUIMessage[],
		emit: Emit,
		abortSignal: AbortSignal | undefined
	): Promise< void > {
		const wire: WireMessage[] = history.flatMap( toWireMessages );

		// Only the turns produced now belong to the message being built.
		const produced: WireMessage[] = [];
		const metadata: ChatMetadata = {};

		/*
		 * The AI SDK keeps whatever array a metadata chunk carries, so every
		 * chunk gets a fresh snapshot rather than a live array that later
		 * rounds would change underneath the stored message. `pending` is a
		 * round still in progress, included so that the stored history always
		 * pairs every function call with a response, wherever Stop lands.
		 */
		const snapshot = ( pending: WireMessage[] = [] ): ChatMetadata => ( {
			...metadata,
			wire: [ ...produced, ...pending ],
		} );
		const publish = ( pending?: WireMessage[] ) =>
			emit( {
				type: 'message-metadata',
				messageMetadata: snapshot( pending ),
			} );

		const tools = this.useTools ? await listTools() : [];
		const declarations = tools.map( ( tool ) => ( {
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
		} ) );

		const maxRounds = Math.max( 1, chatConfig.maxToolRounds );

		emit( { type: 'start' } );

		for ( let round = 0; round <= maxRounds; round += 1 ) {
			abortSignal?.throwIfAborted();

			emit( { type: 'start-step' } );

			const payload = await this.requestTurn(
				wire,
				declarations,
				abortSignal
			);

			const parts = payload.message?.parts ?? [];
			const assistantTurn: WireMessage = { role: 'assistant', parts };

			if ( payload.meta?.model ) {
				metadata.model = payload.meta.model;
			}
			if ( payload.meta?.provider ) {
				metadata.provider = payload.meta.provider;
			}

			if ( payload.text ) {
				/*
				 * The endpoint returns the whole turn at once, so the text
				 * arrives as a single delta rather than being retimed into a
				 * fake typewriter.
				 */
				const textId = nextId( 'text' );
				emit( { type: 'text-start', id: textId } );
				emit( {
					type: 'text-delta',
					id: textId,
					delta: payload.text,
				} );
				emit( { type: 'text-end', id: textId } );
			}

			const toolCalls = payload.toolCalls ?? [];

			if ( ! toolCalls.length ) {
				produced.push( assistantTurn );
				emit( { type: 'finish-step' } );
				emit( { type: 'finish', messageMetadata: snapshot() } );
				return;
			}

			if ( round === maxRounds ) {
				produced.push(
					assistantTurn,
					notRunTurn(
						toolCalls,
						`Not run: the assistant reached its limit of ${ maxRounds } rounds of tool calls.`
					)
				);
				publish();
				emit( { type: 'finish-step' } );
				emit( {
					type: 'error',
					errorText: `The assistant stopped after ${ maxRounds } rounds of tool calls.`,
				} );
				return;
			}

			// Filled in as each call completes; anything left was never run.
			let toolTurn = notRunTurn(
				toolCalls,
				'Not run: the user stopped the assistant.'
			);
			publish( [ assistantTurn, toolTurn ] );

			await this.runToolCalls(
				toolCalls,
				emit,
				abortSignal,
				( index, response ) => {
					// A new turn each time: the last one is already emitted.
					toolTurn = {
						role: 'tool',
						responses: toolTurn.responses.map(
							( existing, position ) =>
								position === index ? response : existing
						),
					};
					publish( [ assistantTurn, toolTurn ] );
				}
			);

			wire.push( assistantTurn, toolTurn );
			produced.push( assistantTurn, toolTurn );

			emit( { type: 'finish-step' } );
		}
	}

	private async runToolCalls(
		toolCalls: ToolCall[],
		emit: Emit,
		abortSignal: AbortSignal | undefined,
		onResponse: ( index: number, response: ToolResponse ) => void
	): Promise< void > {
		for ( const [ index, call ] of toolCalls.entries() ) {
			abortSignal?.throwIfAborted();

			const toolCallId = call.id ?? nextId( 'call' );
			const input = call.arguments ?? {};

			/*
			 * These are dynamic tools: the set comes from whatever the page
			 * registered with WebMCP, so there is no statically known tool
			 * name for the AI SDK to type against.
			 */
			emit( {
				type: 'tool-input-available',
				toolCallId,
				toolName: call.name,
				input,
				dynamic: true,
			} );

			const result = await callTool( call.name, input );

			if ( result.isError ) {
				emit( {
					type: 'tool-output-error',
					toolCallId,
					errorText: result.text || 'The tool call failed.',
					dynamic: true,
				} );
			} else {
				emit( {
					type: 'tool-output-available',
					toolCallId,
					output: result.value,
					dynamic: true,
				} );
			}

			onResponse( index, {
				id: call.id,
				name: call.name,
				response: result.value,
			} );
		}
	}

	private async requestTurn(
		messages: WireMessage[],
		tools: unknown[],
		abortSignal: AbortSignal | undefined
	): Promise< TurnResponse > {
		const response = await fetch( chatConfig.restUrl, {
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				'Content-Type': 'application/json',
				'X-WP-Nonce': chatConfig.nonce,
			},
			signal: abortSignal,
			body: JSON.stringify( {
				messages,
				tools,
				context: this.getContext() || {},
				historyMode: this.historyMode,
			} ),
		} );

		if ( ! response.ok ) {
			throw new Error( await readErrorMessage( response ) );
		}

		const payload = ( await response.json() ) as TurnResponse;

		if ( payload?.historyMode ) {
			this.historyMode = payload.historyMode;
		}

		return payload;
	}
}
