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
		// A static file, not /wp-admin/: WP Playground's auto-login flow answers
		// every authenticated URL with a self-redirecting 302 that sets a fresh
		// cookie each time. Playwright's readiness prober follows redirects but
		// doesn't persist cookies between hops, so it loops on that 302 forever.
		url: 'http://127.0.0.1:9400/readme.html',
		reuseExistingServer: ! process.env.CI,
		timeout: 120_000,
	},
} );
