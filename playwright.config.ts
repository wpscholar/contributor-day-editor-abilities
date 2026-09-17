import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against a real WordPress editor served by wp-playground-cli (`npm start`),
 * the same instance used for manual local development — no Docker, no @wordpress/env.
 */
export default defineConfig( {
	testDir: './tests/e2e',
	fullyParallel: true,
	forbidOnly: !! process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: 'list',
	use: {
		baseURL: 'http://127.0.0.1:9400',
		trace: 'on-first-retry',
	},
	projects: [ { name: 'chromium', use: { ...devices[ 'Desktop Chrome' ] } } ],
	webServer: {
		command: 'npm start',
		url: 'http://127.0.0.1:9400/wp-admin/',
		reuseExistingServer: ! process.env.CI,
		timeout: 120_000,
	},
} );
