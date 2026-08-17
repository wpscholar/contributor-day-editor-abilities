/**
 * Just enough Markdown to render a model reply.
 *
 * Everything is built with DOM nodes rather than HTML strings, so model output
 * can never introduce markup into the admin.
 */

const INLINE_PATTERN =
	/(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/;

/**
 * Only allow links the browser can safely follow.
 *
 * @param {string} url
 * @return {string|null}
 */
function safeUrl( url ) {
	try {
		const parsed = new URL( url, window.location.href );
		return parsed.protocol === 'http:' || parsed.protocol === 'https:'
			? parsed.href
			: null;
	} catch {
		return null;
	}
}

/**
 * @param {string} text
 * @return {DocumentFragment}
 */
function renderInline( text ) {
	const fragment = document.createDocumentFragment();
	let rest = text;

	while ( rest ) {
		const match = INLINE_PATTERN.exec( rest );
		if ( ! match ) {
			fragment.append( rest );
			break;
		}

		if ( match.index > 0 ) {
			fragment.append( rest.slice( 0, match.index ) );
		}

		const token = match[ 0 ];

		if ( token.startsWith( '`' ) ) {
			const code = document.createElement( 'code' );
			code.textContent = token.slice( 1, -1 );
			fragment.append( code );
		} else if ( token.startsWith( '**' ) ) {
			const strong = document.createElement( 'strong' );
			strong.textContent = token.slice( 2, -2 );
			fragment.append( strong );
		} else if ( token.startsWith( '*' ) ) {
			const em = document.createElement( 'em' );
			em.textContent = token.slice( 1, -1 );
			fragment.append( em );
		} else {
			const [ , label, href ] = /\[([^\]]+)\]\(([^)\s]+)\)/.exec( token );
			const url = safeUrl( href );
			if ( url ) {
				const link = document.createElement( 'a' );
				link.href = url;
				link.textContent = label;
				link.rel = 'noreferrer noopener';
				link.target = '_blank';
				fragment.append( link );
			} else {
				fragment.append( label );
			}
		}

		rest = rest.slice( match.index + token.length );
	}

	return fragment;
}

/**
 * @param {string[]} lines
 * @param {boolean}  ordered
 * @return {HTMLElement}
 */
function renderList( lines, ordered ) {
	const list = document.createElement( ordered ? 'ol' : 'ul' );

	for ( const line of lines ) {
		const item = document.createElement( 'li' );
		item.append(
			renderInline( line.replace( ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, '' ) )
		);
		list.append( item );
	}

	return list;
}

/**
 * Render Markdown-ish text into a fragment.
 *
 * @param {string} text
 * @return {DocumentFragment}
 */
export function renderMarkdown( text ) {
	const fragment = document.createDocumentFragment();
	const lines = String( text || '' ).split( '\n' );

	let index = 0;

	while ( index < lines.length ) {
		const line = lines[ index ];

		if ( line.startsWith( '```' ) ) {
			const language = line.slice( 3 ).trim();
			const body = [];
			index += 1;
			while ( index < lines.length && ! lines[ index ].startsWith( '```' ) ) {
				body.push( lines[ index ] );
				index += 1;
			}
			index += 1;

			const pre = document.createElement( 'pre' );
			const code = document.createElement( 'code' );
			if ( language ) {
				code.dataset.language = language;
			}
			code.textContent = body.join( '\n' );
			pre.append( code );
			fragment.append( pre );
			continue;
		}

		const bulletMatch = /^\s*[-*]\s+/.test( line );
		const orderedMatch = /^\s*\d+\.\s+/.test( line );

		if ( bulletMatch || orderedMatch ) {
			const test = bulletMatch ? /^\s*[-*]\s+/ : /^\s*\d+\.\s+/;
			const items = [];
			while ( index < lines.length && test.test( lines[ index ] ) ) {
				items.push( lines[ index ] );
				index += 1;
			}
			fragment.append( renderList( items, orderedMatch ) );
			continue;
		}

		if ( ! line.trim() ) {
			index += 1;
			continue;
		}

		const paragraph = [];
		while (
			index < lines.length &&
			lines[ index ].trim() &&
			! lines[ index ].startsWith( '```' ) &&
			! /^\s*[-*]\s+/.test( lines[ index ] ) &&
			! /^\s*\d+\.\s+/.test( lines[ index ] )
		) {
			paragraph.push( lines[ index ] );
			index += 1;
		}

		const element = document.createElement( 'p' );
		paragraph.forEach( ( part, position ) => {
			if ( position > 0 ) {
				element.append( document.createElement( 'br' ) );
			}
			element.append( renderInline( part ) );
		} );
		fragment.append( element );
	}

	return fragment;
}
