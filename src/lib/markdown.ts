/**
 * Just enough Markdown to render a model reply, parsed into plain data.
 *
 * Parsing is kept apart from rendering so it can be tested without React.
 * Nothing here produces HTML: `src/components/markdown.tsx` turns these
 * nodes into React elements.
 */

export type Inline =
	| { type: 'text'; text: string }
	| { type: 'code'; text: string }
	| { type: 'strong'; text: string }
	| { type: 'em'; text: string }
	| { type: 'link'; text: string; href: string };

export type Block =
	| { type: 'code'; text: string }
	| { type: 'list'; ordered: boolean; items: Inline[][] }
	| { type: 'paragraph'; lines: Inline[][] };

const INLINE_PATTERN =
	/(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/;

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/;

const BULLET = /^\s*[-*]\s+/;
const ORDERED = /^\s*\d+\.\s+/;

/**
 * Only allow links the browser can safely follow.
 *
 * @param url  Link target as the model wrote it.
 * @param base URL relative targets resolve against.
 */
export function safeUrl(
	url: string,
	base: string = globalThis.location?.href ?? 'http://localhost/'
): string | null {
	try {
		const parsed = new URL( url, base );
		return parsed.protocol === 'http:' || parsed.protocol === 'https:'
			? parsed.href
			: null;
	} catch {
		return null;
	}
}

/**
 * Split one line into code spans, emphasis, and links.
 */
export function parseInline( text: string ): Inline[] {
	const nodes: Inline[] = [];
	let rest = text;

	while ( rest ) {
		const match = INLINE_PATTERN.exec( rest );

		if ( ! match ) {
			nodes.push( { type: 'text', text: rest } );
			break;
		}

		if ( match.index > 0 ) {
			nodes.push( { type: 'text', text: rest.slice( 0, match.index ) } );
		}

		const token = match[ 0 ];

		if ( token.startsWith( '`' ) ) {
			nodes.push( { type: 'code', text: token.slice( 1, -1 ) } );
		} else if ( token.startsWith( '**' ) ) {
			nodes.push( { type: 'strong', text: token.slice( 2, -2 ) } );
		} else if ( token.startsWith( '*' ) ) {
			nodes.push( { type: 'em', text: token.slice( 1, -1 ) } );
		} else {
			const link = LINK.exec( token );
			const label = link?.[ 1 ] ?? token;
			const href = link ? safeUrl( link[ 2 ] ) : null;

			nodes.push(
				href
					? { type: 'link', text: label, href }
					: { type: 'text', text: label }
			);
		}

		rest = rest.slice( match.index + token.length );
	}

	return nodes;
}

/**
 * Split a reply into code blocks, lists, and paragraphs.
 */
export function parseMarkdown( text: string ): Block[] {
	const lines = String( text || '' ).split( '\n' );
	const blocks: Block[] = [];

	let index = 0;

	while ( index < lines.length ) {
		const line = lines[ index ];

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

			blocks.push( { type: 'code', text: body.join( '\n' ) } );
			continue;
		}

		const isBullet = BULLET.test( line );
		const isOrdered = ORDERED.test( line );

		if ( isBullet || isOrdered ) {
			const marker = isBullet ? BULLET : ORDERED;
			const items: Inline[][] = [];

			while ( index < lines.length && marker.test( lines[ index ] ) ) {
				items.push(
					parseInline( lines[ index ].replace( marker, '' ) )
				);
				index += 1;
			}

			blocks.push( { type: 'list', ordered: isOrdered, items } );
			continue;
		}

		if ( ! line.trim() ) {
			index += 1;
			continue;
		}

		const paragraph: Inline[][] = [];
		while (
			index < lines.length &&
			lines[ index ].trim() &&
			! lines[ index ].startsWith( '```' ) &&
			! BULLET.test( lines[ index ] ) &&
			! ORDERED.test( lines[ index ] )
		) {
			paragraph.push( parseInline( lines[ index ] ) );
			index += 1;
		}

		blocks.push( { type: 'paragraph', lines: paragraph } );
	}

	return blocks;
}
