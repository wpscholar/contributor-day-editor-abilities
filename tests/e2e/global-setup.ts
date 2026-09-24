import { chromium, type FullConfig } from '@playwright/test';
import { openEditor } from './open-editor';

export const STORAGE_STATE = 'playwright/.auth/admin.json';

/**
 * Log in once and share the session with every test.
 *
 * Without this, each test's fresh context goes through Playground's
 * auto-login. WordPress keeps a user's sessions in one `session_tokens` meta
 * value, rewritten on every login, so concurrent logins from parallel workers
 * overwrite each other's token and the loser lands on wp-login.php?reauth=1.
 */
export default async function globalSetup( config: FullConfig ) {
	const { baseURL } = config.projects[ 0 ].use;
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext( { baseURL } );
		await openEditor( await context.newPage(), 60_000 );
		await context.storageState( { path: STORAGE_STATE } );
	} finally {
		await browser.close();
	}
}
