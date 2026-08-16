/**
 * Contributor Day — editor abilities + WebMCP bridge entry point.
 */

import { registerEditorAbilities } from './abilities.js';
import {
	bridgeAbilitiesToWebMCP,
	isWebMCPSupported,
} from './webmcp-bridge.js';

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
		const bridgeResult = await bridgeAbilitiesToWebMCP( abilityNames );

		window.contributorDayEditorAbilities = {
			abilityNames,
			webmcp: bridgeResult,
			isWebMCPSupported: isWebMCPSupported(),
		};

		if ( bridgeResult.supported ) {
			console.info(
				'[contributor-day] Registered editor abilities with WebMCP:',
				bridgeResult.registered.map( ( name ) =>
					name.replace( /\//g, '_' )
				)
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
