/**
 * Contributor Day — editor abilities + WebMCP bridge entry point.
 */

import { registerEditorAbilities } from './abilities.js';
import {
	bridgeAbilitiesToWebMCP,
	isWebMCPSupported,
} from './webmcp-bridge.js';

const controller = new AbortController();

async function bootstrap() {
	const abilityNames = await registerEditorAbilities();

	const bridgeResult = await bridgeAbilitiesToWebMCP(
		abilityNames,
		controller.signal
	);

	if ( typeof window !== 'undefined' ) {
		window.contributorDayEditorAbilities = {
			abilityNames,
			webmcp: bridgeResult,
			isWebMCPSupported: isWebMCPSupported(),
			abort: () => controller.abort(),
		};
	}

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
}

bootstrap().catch( ( error ) => {
	console.error( '[contributor-day] Failed to bootstrap editor abilities:', error );
} );
