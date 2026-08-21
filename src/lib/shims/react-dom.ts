/**
 * ReactDOM, taken from the copy WordPress already put on the page.
 *
 * Radix (and therefore most shadcn components) reaches for `createPortal` and
 * `flushSync`, so the DOM renderer has to come from the same runtime as React
 * itself. See ./react.ts.
 */

import type * as ReactDOMNamespace from 'react-dom';
import type * as ReactDOMClientNamespace from 'react-dom/client';

type ReactDOMGlobal = typeof ReactDOMNamespace &
	Partial< typeof ReactDOMClientNamespace >;

declare global {
	interface Window {
		ReactDOM?: ReactDOMGlobal;
	}
}

const ReactDOM = window.ReactDOM;

if ( ! ReactDOM ) {
	throw new Error(
		'[contributor-day] window.ReactDOM is missing. Enqueue the "react-dom" script before this module.'
	);
}

export default ReactDOM;

export const {
	createPortal,
	flushSync,
	unstable_batchedUpdates,
	version,
} = ReactDOM;

/*
 * `createRoot` and `hydrateRoot` live in `react-dom/client` as far as the
 * package is concerned, but the global build exposes them alongside everything
 * else, so both specifiers alias to this file.
 */
export const createRoot = ReactDOM.createRoot;
export const hydrateRoot = ReactDOM.hydrateRoot;
