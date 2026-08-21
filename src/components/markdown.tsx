/**
 * Just enough Markdown to render a model reply.
 *
 * Output is React elements, never an HTML string, so a model reply cannot
 * introduce markup into the admin.
 */

import * as React from 'react';

const INLINE_PATTERN =
	/(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/;

const BULLET = /^\s*[-*]\s+/;
const ORDERED = /^\s*\d+\.\s+/;

/** Only allow links the browser can safely follow. */
function safeUrl( url: string ): string | null {
	try {
		const parsed = new URL( url, window.location.href );
		return parsed.protocol === 'http:' || parsed.protocol === 'https:'
			? parsed.href
			: null;
	} catch {
		return null;
	}
}

function renderInline( text: string, keyPrefix: string ): React.ReactNode[] {
	const nodes: React.ReactNode[] = [];
	let rest = text;
	let key = 0;

	while ( rest ) {
		const match = INLINE_PATTERN.exec( rest );

		if ( ! match ) {
			nodes.push( rest );
			break;
		}

		if ( match.index > 0 ) {
			nodes.push( rest.slice( 0, match.index ) );
		}

		const token = match[ 0 ];
		const id = `${ keyPrefix }-i${ key++ }`;

		if ( token.startsWith( '`' ) ) {
			nodes.push(
				<code
					key={ id }
					className="rounded bg-muted px-1 py-0.5 text-[0.85em]"
				>
					{ token.slice( 1, -1 ) }
				</code>
			);
		} else if ( token.startsWith( '**' ) ) {
			nodes.push(
				<strong key={ id } className="font-semibold">
					{ token.slice( 2, -2 ) }
				</strong>
			);
		} else if ( token.startsWith( '*' ) ) {
			nodes.push( <em key={ id }>{ token.slice( 1, -1 ) }</em> );
		} else {
			const link = /\[([^\]]+)\]\(([^)\s]+)\)/.exec( token );
			const label = link?.[ 1 ] ?? token;
			const url = link ? safeUrl( link[ 2 ] ) : null;

			nodes.push(
				url ? (
					<a
						key={ id }
						href={ url }
						rel="noreferrer noopener"
						target="_blank"
						className="underline underline-offset-2"
					>
						{ label }
					</a>
				) : (
					label
				)
			);
		}

		rest = rest.slice( match.index + token.length );
	}

	return nodes;
}

export function Markdown( { text }: { text: string } ) {
	const lines = String( text || '' ).split( '\n' );
	const blocks: React.ReactNode[] = [];

	let index = 0;
	let key = 0;

	while ( index < lines.length ) {
		const line = lines[ index ];
		const id = `b${ key++ }`;

		if ( line.startsWith( '```' ) ) {
			const body: string[] = [];
			index += 1;
			while (
				index < lines.length &&
				! lines[ index ].startsWith( '```' )
			) {
				body.push( lines[ index ] );
				index += 1;
			}
			index += 1;

			blocks.push(
				<pre
					key={ id }
					className="overflow-x-auto rounded-lg bg-muted p-3 text-xs"
				>
					<code>{ body.join( '\n' ) }</code>
				</pre>
			);
			continue;
		}

		const isBullet = BULLET.test( line );
		const isOrdered = ORDERED.test( line );

		if ( isBullet || isOrdered ) {
			const test = isBullet ? BULLET : ORDERED;
			const items: string[] = [];

			while ( index < lines.length && test.test( lines[ index ] ) ) {
				items.push( lines[ index ].replace( test, '' ) );
				index += 1;
			}

			const List = isOrdered ? 'ol' : 'ul';
			blocks.push(
				<List
					key={ id }
					className={
						isOrdered
							? 'list-decimal space-y-1 pl-5'
							: 'list-disc space-y-1 pl-5'
					}
				>
					{ items.map( ( item, position ) => (
						<li key={ position }>
							{ renderInline( item, `${ id }-${ position }` ) }
						</li>
					) ) }
				</List>
			);
			continue;
		}

		if ( ! line.trim() ) {
			index += 1;
			continue;
		}

		const paragraph: string[] = [];
		while (
			index < lines.length &&
			lines[ index ].trim() &&
			! lines[ index ].startsWith( '```' ) &&
			! BULLET.test( lines[ index ] ) &&
			! ORDERED.test( lines[ index ] )
		) {
			paragraph.push( lines[ index ] );
			index += 1;
		}

		blocks.push(
			<p key={ id }>
				{ paragraph.map( ( part, position ) => (
					<React.Fragment key={ position }>
						{ position > 0 && <br /> }
						{ renderInline( part, `${ id }-${ position }` ) }
					</React.Fragment>
				) ) }
			</p>
		);
	}

	return <div className="flex flex-col gap-2">{ blocks }</div>;
}
