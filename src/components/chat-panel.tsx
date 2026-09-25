/**
 * The chat panel.
 *
 * The same panel mounts into a block editor PluginSidebar and into a standalone
 * admin screen, so nothing here may assume the editor is present. Page context
 * and starter prompts are the only things a mount supplies.
 */

import * as React from 'react';
import { useChat } from '@ai-sdk/react';
import {
	MessageSquareIcon,
	SendIcon,
	SquareIcon,
	Trash2Icon,
} from 'lucide-react';
import { chatConfig } from '@agentic-editor/chat-config';
import { listTools, onToolsChanged } from '@agentic-editor/webmcp-tools';

import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import {
	Message,
	MessageContent,
	MessageFooter,
} from '@/components/ui/message';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ChatScroller } from '@/components/chat-scroller';
import { Markdown } from '@/components/markdown';
import { ToolCall } from '@/components/tool-call';
import { WordPressAiTransport, type ChatUIMessage } from '@/chat/transport';

const SUGGESTIONS_LIMIT = 3;

/**
 * What the assistant is doing while a reply is in progress, from the last
 * thing in the transcript. The endpoint answers each round in one piece, so
 * without this the panel would look idle between rounds.
 */
function progressLabel( messages: ChatUIMessage[] ): string {
	const last = messages.at( -1 );
	const part = last?.role === 'assistant' ? last.parts.at( -1 ) : undefined;

	if ( part?.type === 'dynamic-tool' ) {
		if ( part.state === 'approval-requested' ) {
			return 'Waiting for your approval…';
		}
		if (
			part.state === 'input-streaming' ||
			part.state === 'input-available' ||
			part.state === 'approval-responded'
		) {
			return `Running ${ part.toolName }…`;
		}
	}

	return 'Thinking…';
}

/** Names of the WebMCP tools the current page offers. */
function useToolNames(): string[] {
	const [ names, setNames ] = React.useState< string[] >( [] );

	React.useEffect( () => {
		let active = true;
		// Only the latest listing may land: an earlier, slower one would
		// otherwise overwrite a newer answer.
		let latest = 0;

		const refresh = () => {
			const request = ++latest;
			const current = () => active && request === latest;
			listTools()
				.then( ( tools ) => {
					if ( current() ) {
						setNames( tools.map( ( tool ) => tool.name ) );
					}
				} )
				.catch( () => {
					if ( current() ) {
						setNames( [] );
					}
				} );
		};

		const unwatch = onToolsChanged( refresh );
		refresh();

		return () => {
			active = false;
			unwatch();
		};
	}, [] );

	return names;
}

export interface ChatPanelProps {
	/** Page context sent with the user's latest message, read at send time. */
	getContext?: () => Record< string, unknown >;
	/** Starter prompts shown on the empty state. */
	suggestions?: string[];
	className?: string;
}

export function ChatPanel( {
	getContext,
	suggestions = [],
	className,
}: ChatPanelProps ) {
	/*
	 * The mount may pass a fresh closure on every render, but the transport
	 * has to stay stable, so it reads the latest one through a ref.
	 */
	const contextRef = React.useRef( getContext );
	contextRef.current = getContext;

	const transport = React.useMemo(
		() =>
			new WordPressAiTransport( {
				getContext: () => contextRef.current?.() ?? {},
			} ),
		[]
	);

	const {
		messages,
		sendMessage,
		status,
		stop,
		setMessages,
		error,
		clearError,
	} = useChat< ChatUIMessage >( { transport } );

	const [ input, setInput ] = React.useState( '' );
	const inputRef = React.useRef< HTMLTextAreaElement >( null );
	const toolNames = useToolNames();

	const busy = status === 'submitted' || status === 'streaming';
	// Without a connector every send would fail, so none is offered.
	const canSend = chatConfig.available;

	/*
	 * A send that fails before the assistant says anything leaves only the
	 * user's message behind. Put its text back in the composer, and take the
	 * message out, so it can be sent again without typing it twice.
	 */
	React.useEffect( () => {
		if ( ! error ) {
			return;
		}
		const last = messages.at( -1 );
		if ( last?.role !== 'user' ) {
			return;
		}
		const text = last.parts
			.filter( ( part ) => part.type === 'text' )
			.map( ( part ) => part.text )
			.join( '\n' );
		setMessages( messages.slice( 0, -1 ) );
		setInput( ( current ) => current || text );
		// Only a new error should trigger this, not every message change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ error ] );

	const respondToApproval = React.useCallback(
		( approvalId: string, approved: boolean ) =>
			transport.respondToApproval( approvalId, approved ),
		[ transport ]
	);

	const submit = React.useCallback( () => {
		const text = input.trim();
		if ( ! text || busy || ! canSend ) {
			return;
		}
		setInput( '' );
		clearError();
		void sendMessage( { text } );
	}, [ busy, canSend, clearError, input, sendMessage ] );

	return (
		<div
			className={ [
				'cdchat flex h-full min-h-0 flex-col bg-background',
				className,
			]
				.filter( Boolean )
				.join( ' ' ) }
		>
			{ ! chatConfig.available && <ConnectorNotice /> }

			<ChatScroller>
				{ messages.length === 0 && (
					<EmptyState
						suggestions={ suggestions }
						disabled={ ! canSend }
						onPick={ ( suggestion ) => {
							clearError();
							void sendMessage( { text: suggestion } );
						} }
					/>
				) }

				{ messages.map( ( message ) => (
					<ChatMessage
						key={ message.id }
						message={ message }
						onApprovalResponse={
							busy ? respondToApproval : undefined
						}
					/>
				) ) }

				{ busy && (
					<Marker role="status">
						<MarkerIcon>
							<Spinner />
						</MarkerIcon>
						<MarkerContent>
							{ progressLabel( messages ) }
						</MarkerContent>
					</Marker>
				) }

				{ error && (
					<Message>
						<MessageContent>
							<Bubble variant="destructive">
								<BubbleContent>{ error.message }</BubbleContent>
							</Bubble>
						</MessageContent>
					</Message>
				) }
			</ChatScroller>

			<form
				className="flex flex-col gap-2 border-t border-border bg-background p-3"
				onSubmit={ ( event ) => {
					event.preventDefault();
					submit();
				} }
			>
				<Textarea
					ref={ inputRef }
					rows={ 3 }
					value={ input }
					aria-label="Message"
					placeholder="Ask about this site, or tell the assistant what to change…"
					onChange={ ( event ) => setInput( event.target.value ) }
					onKeyDown={ ( event ) => {
						if (
							event.key !== 'Enter' ||
							event.shiftKey ||
							event.nativeEvent.isComposing
						) {
							return;
						}
						event.preventDefault();
						submit();
					} }
					className="max-h-40 min-h-16 resize-none"
				/>

				<div className="flex items-center gap-2">
					<ToolCount names={ toolNames } messages={ messages } />

					<Button
						type="button"
						size="sm"
						variant="ghost"
						disabled={ ! messages.length }
						onClick={ () => {
							stop();
							setMessages( [] );
							clearError();
						} }
					>
						<Trash2Icon />
						Clear
					</Button>

					{ busy ? (
						<Button
							type="button"
							size="sm"
							variant="secondary"
							onClick={ () => stop() }
						>
							<SquareIcon />
							Stop
						</Button>
					) : (
						<Button
							type="submit"
							size="sm"
							disabled={ ! input.trim() || ! canSend }
						>
							<SendIcon />
							Send
						</Button>
					) }
				</div>
			</form>
		</div>
	);
}

function ChatMessage( {
	message,
	onApprovalResponse,
}: {
	message: ChatUIMessage;
	onApprovalResponse?: ( approvalId: string, approved: boolean ) => void;
} ) {
	const isUser = message.role === 'user';
	const attribution = [ message.metadata?.model, message.metadata?.provider ]
		.filter( Boolean )
		.join( ' · ' );

	return (
		<Message align={ isUser ? 'end' : 'start' }>
			<MessageContent>
				{ message.parts.map( ( part, index ) => {
					const key = `${ message.id }-${ index }`;

					if ( part.type === 'text' ) {
						return (
							<Bubble
								key={ key }
								variant={ isUser ? 'default' : 'ghost' }
							>
								<BubbleContent>
									{ isUser ? (
										<span className="whitespace-pre-wrap">
											{ part.text }
										</span>
									) : (
										<Markdown text={ part.text } />
									) }
								</BubbleContent>
							</Bubble>
						);
					}

					if ( part.type === 'dynamic-tool' ) {
						return (
							<ToolCall
								key={ key }
								part={ part }
								onApprovalResponse={ onApprovalResponse }
							/>
						);
					}

					return null;
				} ) }

				{ attribution && (
					<MessageFooter>{ attribution }</MessageFooter>
				) }
			</MessageContent>
		</Message>
	);
}

function ToolCount( {
	names,
	messages,
}: {
	names: string[];
	messages: ChatUIMessage[];
} ) {
	/*
	 * Undocumented: clicking the tool count copies the raw conversation
	 * (including tool-call parts) as JSON, for debugging without opening
	 * devtools.
	 */
	const [ copied, setCopied ] = React.useState( false );

	React.useEffect( () => {
		if ( ! copied ) {
			return;
		}
		const timer = setTimeout( () => setCopied( false ), 1200 );
		return () => clearTimeout( timer );
	}, [ copied ] );

	let label = 'No page tools';
	if ( copied ) {
		label = 'Copied!';
	} else if ( names.length ) {
		label = `${ names.length } page ${
			names.length === 1 ? 'tool' : 'tools'
		}`;
	}

	return (
		<button
			type="button"
			className="mr-auto cursor-pointer border-0 bg-transparent p-0 text-xs text-muted-foreground [font:inherit]"
			title={
				names.length
					? names.join( '\n' )
					: 'This page registers no WebMCP tools, so the assistant can only answer questions.'
			}
			onClick={ () => {
				navigator.clipboard
					.writeText( JSON.stringify( messages, null, 2 ) )
					.then( () => setCopied( true ) )
					.catch( () => {} );
			} }
		>
			{ label }
		</button>
	);
}

function ConnectorNotice() {
	return (
		<div className="border-b border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
			No AI connector is configured, so the assistant cannot answer yet.{ ' ' }
			{ chatConfig.connectorsUrl && (
				<a
					href={ chatConfig.connectorsUrl }
					className="underline underline-offset-2"
				>
					Set one up under Settings → Connectors.
				</a>
			) }
		</div>
	);
}

function EmptyState( {
	suggestions,
	disabled,
	onPick,
}: {
	suggestions: string[];
	disabled: boolean;
	onPick: ( suggestion: string ) => void;
} ) {
	return (
		/*
		 * Tailwind breakpoints measure the viewport, not the container, so the
		 * component's own responsive padding would fire on a wide screen even
		 * when the panel is in a 350px sidebar. Padding is pinned instead.
		 */
		<Empty className="border-none p-4 md:p-6">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<MessageSquareIcon />
				</EmptyMedia>
				<EmptyTitle>
					{ chatConfig.siteName
						? `Ask anything about ${ chatConfig.siteName }.`
						: 'Ask anything about this site.' }
				</EmptyTitle>
				<EmptyDescription>
					The assistant can act on this screen using the tools it
					offers.
				</EmptyDescription>
			</EmptyHeader>

			{ suggestions.length > 0 && (
				<EmptyContent>
					{ suggestions
						.slice( 0, SUGGESTIONS_LIMIT )
						.map( ( suggestion ) => (
							<Button
								key={ suggestion }
								type="button"
								variant="outline"
								size="sm"
								className="h-auto w-full justify-start py-2 text-left whitespace-normal"
								disabled={ disabled }
								onClick={ () => onPick( suggestion ) }
							>
								{ suggestion }
							</Button>
						) ) }
				</EmptyContent>
			) }
		</Empty>
	);
}
