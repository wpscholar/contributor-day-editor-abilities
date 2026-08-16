/**
 * Bridge WordPress client-side abilities to the WebMCP Imperative API.
 *
 * Uses document.modelContext.registerTool (with navigator.modelContext fallback)
 * so browser agents can discover and invoke editor abilities.
 *
 * @see https://developer.chrome.com/docs/ai/webmcp
 */

import { executeAbility, getAbility } from '@wordpress/abilities';

/**
 * @return {ModelContext|null}
 */
function getModelContext() {
	if ( typeof document !== 'undefined' && document.modelContext ) {
		return document.modelContext;
	}
	if ( typeof navigator !== 'undefined' && navigator.modelContext ) {
		return navigator.modelContext;
	}
	return null;
}

/**
 * Gemini and some agents reject tool names containing "/".
 *
 * @param {string} abilityName
 * @return {string}
 */
export function toToolName( abilityName ) {
	return abilityName.replace( /\//g, '_' );
}

/**
 * Map ability annotations to WebMCP tool annotations.
 *
 * @param {Object} [ability]
 * @return {Object|undefined}
 */
function toToolAnnotations( ability ) {
	const annotations = ability?.meta?.annotations;
	if ( ! annotations ) {
		return undefined;
	}

	return {
		readOnlyHint: !! annotations.readonly,
		destructiveHint: !! annotations.destructive,
		idempotentHint: !! annotations.idempotent,
	};
}

/**
 * Format ability results for WebMCP / MCP-style clients.
 *
 * @param {unknown} result
 * @return {{ content: Array<{ type: string, text: string }>, structuredContent: unknown }}
 */
function formatToolResult( result ) {
	const text =
		typeof result === 'string' ? result : JSON.stringify( result, null, 2 );

	return {
		content: [ { type: 'text', text } ],
		structuredContent: result,
	};
}

/**
 * Register a single ability as a WebMCP tool.
 *
 * @param {string} abilityName
 * @param {AbortSignal} [signal]
 * @return {Promise<boolean>} Whether registration succeeded.
 */
export async function registerAbilityAsWebMCPTool( abilityName, signal ) {
	const modelContext = getModelContext();
	if ( ! modelContext?.registerTool ) {
		return false;
	}

	const ability = getAbility( abilityName );
	if ( ! ability ) {
		throw new Error( `Ability not found: ${ abilityName }` );
	}

	const tool = {
		name: toToolName( abilityName ),
		description: ability.description || ability.label || abilityName,
		inputSchema: ability.input_schema || {
			type: 'object',
			properties: {},
		},
		execute: async ( input = {} ) => {
			const result = await executeAbility( abilityName, input );
			return formatToolResult( result );
		},
	};

	const annotations = toToolAnnotations( ability );
	if ( annotations ) {
		tool.annotations = annotations;
	}

	const options = signal ? { signal } : {};
	await modelContext.registerTool( tool, options );
	return true;
}

/**
 * Bridge a list of abilities to WebMCP.
 *
 * @param {string[]} abilityNames
 * @param {AbortSignal} [signal]
 * @return {Promise<{ supported: boolean, registered: string[], skipped: string[] }>}
 */
export async function bridgeAbilitiesToWebMCP( abilityNames, signal ) {
	const modelContext = getModelContext();
	if ( ! modelContext?.registerTool ) {
		return {
			supported: false,
			registered: [],
			skipped: [ ...abilityNames ],
		};
	}

	const registered = [];
	const skipped = [];

	for ( const name of abilityNames ) {
		if ( signal?.aborted ) {
			skipped.push( name );
			continue;
		}

		try {
			const ok = await registerAbilityAsWebMCPTool( name, signal );
			if ( ok ) {
				registered.push( name );
			} else {
				skipped.push( name );
			}
		} catch ( error ) {
			// Duplicate registration or transient API errors should not break the page.
			console.warn(
				`[contributor-day] Failed to register WebMCP tool for ${ name }:`,
				error
			);
			skipped.push( name );
		}
	}

	return { supported: true, registered, skipped };
}

/**
 * Whether WebMCP is available in this browser.
 *
 * @return {boolean}
 */
export function isWebMCPSupported() {
	const modelContext = getModelContext();
	return !! ( modelContext && 'registerTool' in modelContext );
}
