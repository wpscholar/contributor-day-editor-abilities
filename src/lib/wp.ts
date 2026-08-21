/**
 * The bits of the WordPress global this bundle reads.
 *
 * These are classic scripts (`wp-plugins`, `wp-editor`, …), which execute
 * before deferred script modules, so they are present by the time this runs —
 * as long as PHP actually enqueued them for the screen.
 */

import type * as React from 'react';

interface PluginSidebarProps {
	name: string;
	title: string;
	icon?: string;
	className?: string;
	children?: React.ReactNode;
}

export interface WordPressGlobal {
	plugins?: {
		registerPlugin: (
			name: string,
			settings: { render: () => React.ReactNode; icon?: string }
		) => void;
	};
	editor?: {
		PluginSidebar?: React.ComponentType< PluginSidebarProps >;
	};
	editPost?: {
		PluginSidebar?: React.ComponentType< PluginSidebarProps >;
	};
	data?: {
		select: ( store: string ) => Record< string, ( ...args: never[] ) => unknown >;
	};
}

declare global {
	interface Window {
		wp?: WordPressGlobal;
	}
}

/**
 * Wait for something on the page to become available.
 *
 * @param check     Returns a truthy value once ready.
 * @param timeoutMs How long to keep looking.
 */
export function waitFor< T >(
	check: () => T | null | undefined,
	timeoutMs = 5000
): Promise< T | null > {
	return new Promise( ( resolve ) => {
		const started = Date.now();

		const poll = () => {
			const value = check();
			if ( value ) {
				resolve( value );
				return;
			}
			if ( Date.now() - started >= timeoutMs ) {
				resolve( null );
				return;
			}
			window.setTimeout( poll, 50 );
		};

		poll();
	} );
}
