/**
 * Agentic Editor — editor abilities + WebMCP bridge entry point.
 */

import { registerEditorAbilities } from '@agentic-editor/abilities';
import {
	bridgeAbilitiesToWebMCP,
	isWebMCPSupported,
	toToolName,
} from '@agentic-editor/webmcp-bridge';

/** @type {Promise<void>|null} */
let bootstrapPromise = null;

async function bootstrap() {
	if ( bootstrapPromise ) {
		return bootstrapPromise;
	}

	bootstrapPromise = ( async () => {
		// Register abilities + WebMCP tools immediately. Ability callbacks already
		// guard on the block editor store when executed.
		const abilityNames = registerEditorAbilities();

		// Published before bridging so the global is inspectable while the
		// bridge waits for WebMCP to appear.
		window.agenticEditorAbilities = {
			abilityNames,
			webmcp: null,
			isWebMCPSupported: isWebMCPSupported(),
		};

		const bridgeResult = await bridgeAbilitiesToWebMCP( abilityNames );

		window.agenticEditorAbilities = {
			abilityNames,
			webmcp: bridgeResult,
			isWebMCPSupported: isWebMCPSupported(),
		};

		if ( bridgeResult.supported ) {
			console.info(
				'[agentic-editor] Registered editor abilities with WebMCP:',
				bridgeResult.registered.map( toToolName )
			);
		} else {
			console.info(
				'[agentic-editor] Editor abilities registered, but WebMCP is unavailable and the polyfill could not install (this page may not be a secure context).',
				abilityNames
			);
		}
	} )();

	return bootstrapPromise;
}

bootstrap().catch( ( error ) => {
	bootstrapPromise = null;
	console.error(
		'[agentic-editor] Failed to bootstrap editor abilities:',
		error
	);
} );
