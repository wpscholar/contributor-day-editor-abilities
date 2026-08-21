/**
 * The chat panel.
 *
 * The same panel mounts into a block editor PluginSidebar and into a standalone
 * admin screen, so nothing here may assume the editor is present. Page context
 * and starter prompts are the only things a mount supplies.
 */

import * as React from 'react';
import { useChat } from '@ai-sdk/react';
import { MessageSquareIcon, SendIcon, SquareIcon, Trash2Icon } from 'lucide-react';
import { chatConfig } from '@contributor-day/chat-config';
import { listTools, onToolsChanged } from '@contributor-day/webmcp-tools';

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

/** Names of the WebMCP tools the current page offers. */
function useToolNames(): string[] {
	const [ names, setNames ] = React.useState< string[] >( [] );

	React.useEffect( () => {
		let active = true;

		const refresh = () => {
			listTools()
				.then( ( tools ) => {
					if ( active ) {
						setNames( tools.map( ( tool ) => tool.name ) );
					}
				} )
				.catch( () => {
					if ( active ) {
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
	/** Page context for the system prompt, read at send time. */
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

	const { messages, sendMessage, status, stop, setMessages, error, clearError } =
		useChat< ChatUIMessage >( { transport } );

	const [ input, setInput ] = React.useState( '' );
	const inputRef = React.useRef< HTMLTextAreaElement >( null );
	const toolNames = useToolNames();

	const busy = status === 'submitted' || status === 'streaming';

	const submit = React.useCallback( () => {
		const text = input.trim();
		if ( ! text || busy ) {
			return;
		}
		setInput( '' );
		clearError();
		void sendMessage( { text } );
	}, [ busy, clearError, input, sendMessage ] );

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
						onPick={ ( suggestion ) => {
							clearError();
							void sendMessage( { text: suggestion } );
						} }
					/>
				) }

				{ messages.map( ( message ) => (
					<ChatMessage key={ message.id } message={ message } />
				) ) }

				{ status === 'submitted' && (
					<Marker role="status">
						<MarkerIcon>
							<Spinner />
						</MarkerIcon>
						<MarkerContent>Thinking…</MarkerContent>
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
							event.key === 'Enter' &&
							( event.metaKey || event.ctrlKey )
						) {
							event.preventDefault();
							submit();
						}
					} }
					className="max-h-40 min-h-16 resize-none"
				/>

				<div className="flex items-center gap-2">
					<ToolCount names={ toolNames } />

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
							disabled={ ! input.trim() }
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

function ChatMessage( { message }: { message: ChatUIMessage } ) {
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
						return <ToolCall key={ key } part={ part } />;
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

function ToolCount( { names }: { names: string[] } ) {
	const label = names.length
		? `${ names.length } page ${ names.length === 1 ? 'tool' : 'tools' }`
		: 'No page tools';

	return (
		<span
			className="mr-auto text-xs text-muted-foreground"
			title={
				names.length
					? names.join( '\n' )
					: 'This page registers no WebMCP tools, so the assistant can only answer questions.'
			}
		>
			{ label }
		</span>
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
	onPick,
}: {
	suggestions: string[];
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
