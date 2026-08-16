/**
 * Bridge WordPress client-side abilities to the WebMCP Imperative API.
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
 * WebMCP tool names may include alphanumerics, _, -, and .
 * Convert ability names like "editor/get-editor-tree" → "editor_get-editor-tree".
 *
 * @param {string} abilityName
 * @return {string}
 */
export function toToolName( abilityName ) {
	return abilityName.replace( /\//g, '_' );
}

/**
 * @param {Object} [ability]
 * @return {{ readOnlyHint: boolean }|undefined}
 */
function toToolAnnotations( ability ) {
	const annotations = ability?.meta?.annotations;
	if ( ! annotations ) {
		return undefined;
	}

	// Only WebMCP-supported annotation keys (unknown keys can break registration).
	return {
		readOnlyHint: !! annotations.readonly,
	};
}

/**
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
 * @param {Object} [schema]
 * @return {Object}
 */
function toToolInputSchema( schema ) {
	if ( ! schema || typeof schema !== 'object' ) {
		return { type: 'object', properties: {} };
	}

	const properties = {};
	for ( const [ key, value ] of Object.entries( schema.properties || {} ) ) {
		if ( ! value || typeof value !== 'object' ) {
			continue;
		}

		const property = { ...value };
		if ( Array.isArray( property.type ) ) {
			const nonNull = property.type.filter( ( type ) => type !== 'null' );
			property.type = nonNull[ 0 ] || 'string';
		}

		properties[ key ] = property;
	}

	const normalized = {
		type: 'object',
		properties,
	};

	if ( Array.isArray( schema.required ) && schema.required.length ) {
		normalized.required = [ ...schema.required ];
	}

	return normalized;
}

/**
 * Wait briefly for WebMCP to become available (flag / document ready races).
 *
 * @param {number} [timeoutMs]
 * @return {Promise<ModelContext|null>}
 */
async function waitForModelContext( timeoutMs = 3000 ) {
	const started = Date.now();

	while ( Date.now() - started < timeoutMs ) {
		const modelContext = getModelContext();
		if ( modelContext?.registerTool ) {
			return modelContext;
		}
		await new Promise( ( resolve ) => window.setTimeout( resolve, 50 ) );
	}

	return getModelContext();
}

/**
 * Register one ability as a page-lifetime WebMCP tool (no AbortSignal).
 *
 * @param {string} abilityName
 * @param {ModelContext} modelContext
 * @return {Promise<boolean>}
 */
async function registerAbilityAsWebMCPTool( abilityName, modelContext ) {
	const ability = getAbility( abilityName );
	if ( ! ability ) {
		throw new Error( `Ability not found: ${ abilityName }` );
	}

	const tool = {
		name: toToolName( abilityName ),
		description: ability.description || ability.label || abilityName,
		inputSchema: toToolInputSchema( ability.input_schema ),
		execute: async ( input = {} ) => {
			const result = await executeAbility( abilityName, input || {} );
			return formatToolResult( result );
		},
	};

	const annotations = toToolAnnotations( ability );
	if ( annotations ) {
		tool.annotations = annotations;
	}

	await modelContext.registerTool( tool );
	return true;
}

/**
 * Bridge abilities to WebMCP.
 *
 * @param {string[]} abilityNames
 * @return {Promise<{ supported: boolean, registered: string[], skipped: string[], errors: Object[] }>}
 */
export async function bridgeAbilitiesToWebMCP( abilityNames ) {
	const modelContext = await waitForModelContext();
	if ( ! modelContext?.registerTool ) {
		return {
			supported: false,
			registered: [],
			skipped: [ ...abilityNames ],
			errors: [],
		};
	}

	const registered = [];
	const skipped = [];
	const errors = [];

	for ( const name of abilityNames ) {
		try {
			await registerAbilityAsWebMCPTool( name, modelContext );
			registered.push( name );
		} catch ( error ) {
			// Already registered from a prior bootstrap attempt — treat as success.
			const message = String( error?.message || error );
			if ( /already|InvalidStateError/i.test( message ) ) {
				registered.push( name );
				continue;
			}

			console.warn(
				`[contributor-day] Failed to register WebMCP tool for ${ name }:`,
				error
			);
			skipped.push( name );
			errors.push( { name, message } );
		}
	}

	return { supported: true, registered, skipped, errors };
}

/**
 * @return {boolean}
 */
export function isWebMCPSupported() {
	const modelContext = getModelContext();
	return !! ( modelContext && 'registerTool' in modelContext );
}
