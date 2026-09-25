import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeUrl } from './markdown';

const BASE = 'https://example.test/wp-admin/post.php?post=1';

describe( 'safeUrl', () => {
	it( 'allows http and https', () => {
		expect( safeUrl( 'https://wordpress.org/', BASE ) ).toBe(
			'https://wordpress.org/'
		);
		expect( safeUrl( 'http://example.com/a?b=c', BASE ) ).toBe(
			'http://example.com/a?b=c'
		);
	} );

	it.each( [
		'javascript:alert(1)',
		'JavaScript:alert(1)',
		'data:text/html,<script>alert(1)</script>',
		'vbscript:msgbox',
		'file:///etc/passwd',
		'mailto:someone@example.com',
	] )( 'rejects %s', ( url ) => {
		expect( safeUrl( url, BASE ) ).toBeNull();
	} );

	it( 'rejects what is not a URL at all', () => {
		expect( safeUrl( 'http://', BASE ) ).toBeNull();
	} );
} );

describe( 'parseInline', () => {
	it( 'returns plain text as one node', () => {
		expect( parseInline( 'Hello there.' ) ).toEqual( [
			{ type: 'text', text: 'Hello there.' },
		] );
	} );

	it( 'parses code, strong, emphasis and links in order', () => {
		expect(
			parseInline(
				'Use `core/paragraph`, **not** *that*, see [docs](https://wordpress.org/).'
			)
		).toEqual( [
			{ type: 'text', text: 'Use ' },
			{ type: 'code', text: 'core/paragraph' },
			{ type: 'text', text: ', ' },
			{ type: 'strong', text: 'not' },
			{ type: 'text', text: ' ' },
			{ type: 'em', text: 'that' },
			{ type: 'text', text: ', see ' },
			{ type: 'link', text: 'docs', href: 'https://wordpress.org/' },
			{ type: 'text', text: '.' },
		] );
	} );

	it( 'keeps markup inside code spans literal', () => {
		expect( parseInline( '`**bold** <b>`' ) ).toEqual( [
			{ type: 'code', text: '**bold** <b>' },
		] );
	} );

	it( 'renders an unsafe link as its label only', () => {
		expect( parseInline( '[click](javascript:alert(1))' ) ).toEqual( [
			{ type: 'text', text: 'click' },
			{ type: 'text', text: ')' },
		] );
	} );

	it( 'leaves HTML as text', () => {
		expect( parseInline( '<img src=x onerror=alert(1)>' ) ).toEqual( [
			{ type: 'text', text: '<img src=x onerror=alert(1)>' },
		] );
	} );
} );

describe( 'parseMarkdown', () => {
	it( 'returns nothing for empty input', () => {
		expect( parseMarkdown( '' ) ).toEqual( [] );
		expect( parseMarkdown( '\n\n' ) ).toEqual( [] );
	} );

	it( 'joins consecutive lines into one paragraph and splits on blank lines', () => {
		expect( parseMarkdown( 'One\nTwo\n\nThree' ) ).toEqual( [
			{
				type: 'paragraph',
				lines: [
					[ { type: 'text', text: 'One' } ],
					[ { type: 'text', text: 'Two' } ],
				],
			},
			{
				type: 'paragraph',
				lines: [ [ { type: 'text', text: 'Three' } ] ],
			},
		] );
	} );

	it( 'parses fenced code verbatim', () => {
		expect( parseMarkdown( '```js\nconst a = **1**;\n\n```' ) ).toEqual( [
			{ type: 'code', text: 'const a = **1**;\n' },
		] );
	} );

	it( 'keeps an unterminated fence as code to the end', () => {
		expect( parseMarkdown( '```\nstill code' ) ).toEqual( [
			{ type: 'code', text: 'still code' },
		] );
	} );

	it( 'parses bullet and ordered lists', () => {
		expect(
			parseMarkdown( '- one\n* two\n\n1. first\n2. second' )
		).toEqual( [
			{
				type: 'list',
				ordered: false,
				items: [
					[ { type: 'text', text: 'one' } ],
					[ { type: 'text', text: 'two' } ],
				],
			},
			{
				type: 'list',
				ordered: true,
				items: [
					[ { type: 'text', text: 'first' } ],
					[ { type: 'text', text: 'second' } ],
				],
			},
		] );
	} );

	it( 'ends a paragraph where a list starts', () => {
		const blocks = parseMarkdown( 'Steps:\n- one' );

		expect( blocks.map( ( block ) => block.type ) ).toEqual( [
			'paragraph',
			'list',
		] );
	} );
} );
