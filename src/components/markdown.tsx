/**
 * Just enough Markdown to render a model reply.
 *
 * Output is React elements, never an HTML string, so a model reply cannot
 * introduce markup into the admin. Parsing lives in `@/lib/markdown`.
 */

import * as React from 'react';
import { parseMarkdown, type Inline } from '@/lib/markdown';

function renderInline( nodes: Inline[], keyPrefix: string ): React.ReactNode[] {
	return nodes.map( ( node, position ) => {
		const id = `${ keyPrefix }-i${ position }`;

		switch ( node.type ) {
			case 'code':
				return (
					<code
						key={ id }
						className="rounded bg-muted px-1 py-0.5 text-[0.85em]"
					>
						{ node.text }
					</code>
				);
			case 'strong':
				return (
					<strong key={ id } className="font-semibold">
						{ node.text }
					</strong>
				);
			case 'em':
				return <em key={ id }>{ node.text }</em>;
			case 'link':
				return (
					<a
						key={ id }
						href={ node.href }
						rel="noreferrer noopener"
						target="_blank"
						className="underline underline-offset-2"
					>
						{ node.text }
					</a>
				);
			default:
				return (
					<React.Fragment key={ id }>{ node.text }</React.Fragment>
				);
		}
	} );
}

export function Markdown( { text }: { text: string } ) {
	const blocks = parseMarkdown( text ).map( ( block, position ) => {
		const id = `b${ position }`;

		if ( block.type === 'code' ) {
			return (
				<pre
					key={ id }
					className="overflow-x-auto rounded-lg bg-muted p-3 text-xs"
				>
					<code>{ block.text }</code>
				</pre>
			);
		}

		if ( block.type === 'heading' ) {
			// Replies sit inside a narrow panel, so every level is a bold
			// line rather than an admin-sized heading.
			return (
				<p
					key={ id }
					className="font-semibold"
					role="heading"
					aria-level={ block.level }
				>
					{ renderInline( block.content, id ) }
				</p>
			);
		}

		if ( block.type === 'quote' ) {
			return (
				<blockquote
					key={ id }
					className="border-l-2 border-border pl-3 text-muted-foreground"
				>
					{ block.lines.map( ( line, index ) => (
						<React.Fragment key={ index }>
							{ index > 0 && <br /> }
							{ renderInline( line, `${ id }-${ index }` ) }
						</React.Fragment>
					) ) }
				</blockquote>
			);
		}

		if ( block.type === 'list' ) {
			const List = block.ordered ? 'ol' : 'ul';
			return (
				<List
					key={ id }
					start={ block.start }
					className={
						block.ordered
							? 'list-decimal space-y-1 pl-5'
							: 'list-disc space-y-1 pl-5'
					}
				>
					{ block.items.map( ( item, index ) => (
						<li key={ index }>
							{ renderInline( item, `${ id }-${ index }` ) }
						</li>
					) ) }
				</List>
			);
		}

		return (
			<p key={ id }>
				{ block.lines.map( ( line, index ) => (
					<React.Fragment key={ index }>
						{ index > 0 && <br /> }
						{ renderInline( line, `${ id }-${ index }` ) }
					</React.Fragment>
				) ) }
			</p>
		);
	} );

	return <div className="flex flex-col gap-2">{ blocks }</div>;
}
