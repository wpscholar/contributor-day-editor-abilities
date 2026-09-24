import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = ( path: string ) =>
	fileURLToPath( new URL( `./src/${ path }`, import.meta.url ) );

/*
 * Unit tests run in Node, without WordPress. The two import-map externals are
 * pointed at stubs that tests replace with `vi.mock`, and nothing tested here
 * touches React, so the build's React shims and plugins stay out.
 */
export default defineConfig( {
	resolve: {
		alias: {
			'@agentic-editor/chat-config': src( 'test/stubs/chat-config.ts' ),
			'@agentic-editor/webmcp-tools': src( 'test/stubs/webmcp-tools.ts' ),
			'@': src( '' ).replace( /\/$/, '' ),
		},
	},
	test: {
		include: [ 'src/**/*.test.ts' ],
		environment: 'node',
	},
} );
