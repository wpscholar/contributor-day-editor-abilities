/**
 * WebMCP environment.
 *
 * Chrome only exposes `document.modelContext` behind a flag, so the polyfill is
 * enqueued as a classic script alongside anything that needs WebMCP. It
 * installs itself on load and steps aside when the browser has native support,
 * which means one code path covers flagged Chrome, unflagged Chrome, and other
 * browsers.
 *
 * This module only reports on that environment; it never installs anything.
 *
 * @see https://www.npmjs.com/package/@mcp-b/webmcp-polyfill
 */

/**
 * @return {Object|null} The model context, or null when there is none.
 */
export function getModelContext() {
	if ( typeof document !== 'undefined' && document.modelContext ) {
		return document.modelContext;
	}
	// Deprecated alias, still the only surface on older Chromium builds.
	if ( typeof navigator !== 'undefined' && navigator.modelContext ) {
		return navigator.modelContext;
	}
	return null;
}

let warned = false;

/**
 * @return {{ available: boolean, polyfillLoaded: boolean, secureContext: boolean }}
 */
export function getWebMCPStatus() {
	const secureContext =
		typeof window !== 'undefined' ? window.isSecureContext !== false : false;
	const available = !! getModelContext()?.registerTool;

	if ( ! available && ! secureContext && ! warned ) {
		warned = true;
		console.warn(
			'[contributor-day] WebMCP is unavailable because this page is not a secure context. Serve the site over HTTPS or from localhost.'
		);
	}

	return {
		available,
		polyfillLoaded:
			typeof window !== 'undefined' && !! window.WebMCPPolyfill,
		secureContext,
	};
}
