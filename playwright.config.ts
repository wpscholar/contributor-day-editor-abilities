import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against a real WordPress editor served by wp-playground-cli (`npm start`),
 * the same instance used for manual local development — no Docker, no @wordpress/env.
 */
export default defineConfig( {
	testDir: './tests/e2e',
	fullyParallel: true,
	// All workers share the one wp-playground-cli backend below, and it can't
	// keep up with more than one concurrently-booting editor: at 2+ workers,
	// document.modelContext intermittently never finishes initializing within
	// any reasonable wait, since it's genuine backend overload rather than a
	// short-lived race. Measured: 0/30 flakes at workers=1 across five runs,
	// vs. 1/30 (2 workers), 6/30 (4 workers), 6/30 (12 workers) — raising the
	// per-call wait budget did not help at higher worker counts. Revisit this
	// if the suite moves to one backend instance per worker.
	workers: 1,
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
