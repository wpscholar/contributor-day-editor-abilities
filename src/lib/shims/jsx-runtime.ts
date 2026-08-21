/**
 * The automatic JSX runtime, taken from WordPress.
 *
 * WordPress ships this as the `react-jsx-runtime` script, which assigns
 * `window.ReactJSXRuntime`. Older setups may not have it, so the runtime is
 * rebuilt from `createElement` when the global is absent — slower, but it keeps
 * every element coming from the one React instance, which is the part that
 * matters.
 */

import React from './react';

type JsxFactory = (
	type: unknown,
	props: Record< string, unknown >,
	key?: string
) => unknown;

interface JsxRuntimeGlobal {
	jsx: JsxFactory;
	jsxs: JsxFactory;
	jsxDEV?: JsxFactory;
	Fragment: unknown;
}

declare global {
	interface Window {
		ReactJSXRuntime?: JsxRuntimeGlobal;
	}
}

const fromCreateElement: JsxFactory = ( type, props, key ) => {
	const { children, ...rest } = props ?? {};
	const attributes = key === undefined ? rest : { ...rest, key };

	return Array.isArray( children )
		? React.createElement(
				type as never,
				attributes,
				...( children as React.ReactNode[] )
		  )
		: React.createElement(
				type as never,
				attributes,
				children as React.ReactNode
		  );
};

const runtime: JsxRuntimeGlobal = window.ReactJSXRuntime ?? {
	jsx: fromCreateElement,
	jsxs: fromCreateElement,
	jsxDEV: fromCreateElement,
	Fragment: React.Fragment,
};

export const Fragment = runtime.Fragment;
export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;
export const jsxDEV = runtime.jsxDEV ?? runtime.jsx;
