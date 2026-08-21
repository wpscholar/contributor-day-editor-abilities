/**
 * The transcript scroll container.
 *
 * shadcn ships `MessageScroller` for this, but it comes from the `@shadcn/react`
 * package, which requires React 19, and WordPress 7.0 is on React 18. So the
 * behaviors that matter for a streaming transcript are implemented here: follow
 * the reply only while the reader is already at the live edge, leave them alone
 * the moment they scroll away, and offer a way back.
 */

import * as React from 'react';
import { ArrowDownIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** How close to the bottom still counts as "at the live edge". */
const EDGE_THRESHOLD = 32;

export function ChatScroller( {
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
} ) {
	const viewportRef = React.useRef< HTMLDivElement >( null );
	const contentRef = React.useRef< HTMLDivElement >( null );
	const [ following, setFollowing ] = React.useState( true );

	// Kept in a ref so the ResizeObserver below never needs to be rebuilt.
	const followingRef = React.useRef( following );
	followingRef.current = following;

	const scrollToBottom = React.useCallback( () => {
		const viewport = viewportRef.current;
		if ( viewport ) {
			viewport.scrollTop = viewport.scrollHeight;
		}
	}, [] );

	const handleScroll = React.useCallback( () => {
		const viewport = viewportRef.current;
		if ( ! viewport ) {
			return;
		}

		const distance =
			viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;

		setFollowing( distance <= EDGE_THRESHOLD );
	}, [] );

	/*
	 * Growing content is what moves the reader, not the scroll event, so the
	 * transcript is measured rather than watched for renders.
	 */
	React.useEffect( () => {
		const content = contentRef.current;
		if ( ! content || typeof ResizeObserver === 'undefined' ) {
			return;
		}

		const observer = new ResizeObserver( () => {
			if ( followingRef.current ) {
				scrollToBottom();
			}
		} );

		observer.observe( content );
		return () => observer.disconnect();
	}, [ scrollToBottom ] );

	return (
		<div className={ cn( 'relative min-h-0 flex-1', className ) }>
			<div
				ref={ viewportRef }
				onScroll={ handleScroll }
				className="h-full overflow-y-auto overscroll-contain px-3 py-4"
				role="log"
				aria-live="polite"
			>
				<div ref={ contentRef } className="flex flex-col gap-4">
					{ children }
				</div>
			</div>

			{ ! following && (
				<Button
					type="button"
					size="sm"
					variant="secondary"
					onClick={ () => {
						setFollowing( true );
						scrollToBottom();
					} }
					className="absolute inset-x-0 bottom-3 mx-auto w-fit rounded-full shadow-md"
				>
					<ArrowDownIcon />
					Jump to latest
				</Button>
			) }
		</div>
	);
}
