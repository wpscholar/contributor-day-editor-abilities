/**
 * Contributor Day — editor abilities + WebMCP bridge entry point.
 */

import { registerEditorAbilities } from '@contributor-day/abilities';
import {
	bridgeAbilitiesToWebMCP,
	isWebMCPSupported,
	toToolName,
} from '@contributor-day/webmcp-bridge';

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
		window.contributorDayEditorAbilities = {
			abilityNames,
			webmcp: null,
			isWebMCPSupported: isWebMCPSupported(),
		};

		const bridgeResult = await bridgeAbilitiesToWebMCP( abilityNames );

		window.contributorDayEditorAbilities = {
			abilityNames,
			webmcp: bridgeResult,
			isWebMCPSupported: isWebMCPSupported(),
		};

		if ( bridgeResult.supported ) {
			console.info(
				'[contributor-day] Registered editor abilities with WebMCP:',
				bridgeResult.registered.map( toToolName )
			);
		} else {
			console.info(
				'[contributor-day] Editor abilities registered. WebMCP is unavailable in this browser (enable chrome://flags/#enable-webmcp-testing).',
				abilityNames
			);
		}
	} )();

	return bootstrapPromise;
}

bootstrap().catch( ( error ) => {
	bootstrapPromise = null;
	console.error(
		'[contributor-day] Failed to bootstrap editor abilities:',
		error
	);
} );
