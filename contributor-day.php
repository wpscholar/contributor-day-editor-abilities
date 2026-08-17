<?php
/**
 * Plugin Name:       Contributor Day Editor Abilities
 * Description:       Registers client-side block editor abilities, bridges them to WebMCP, and adds an AI chat panel powered by the WordPress AI Client.
 * Version:           0.1.0
 * Requires at least: 7.0
 * Requires PHP:      7.4
 * Author:            Contributor Day
 * License:           GPL-2.0-or-later
 * Text Domain:       contributor-day
 *
 * @package ContributorDay
 */

defined( 'ABSPATH' ) || exit;

defined( 'CONTRIBUTOR_DAY_VERSION' ) || define( 'CONTRIBUTOR_DAY_VERSION', '0.1.0' );
defined( 'CONTRIBUTOR_DAY_PLUGIN_FILE' ) || define( 'CONTRIBUTOR_DAY_PLUGIN_FILE', __FILE__ );
defined( 'CONTRIBUTOR_DAY_PLUGIN_DIR' ) || define( 'CONTRIBUTOR_DAY_PLUGIN_DIR', plugin_dir_path( CONTRIBUTOR_DAY_PLUGIN_FILE ) );
defined( 'CONTRIBUTOR_DAY_PLUGIN_URL' ) || define( 'CONTRIBUTOR_DAY_PLUGIN_URL', plugin_dir_url( CONTRIBUTOR_DAY_PLUGIN_FILE ) );

/**
 * Cache-busting version for a plugin file.
 *
 * @param string $relative_path Path relative to the plugin root.
 * @return string
 */
function contributor_day_asset_version( $relative_path ) {
	$path = CONTRIBUTOR_DAY_PLUGIN_DIR . $relative_path;

	return file_exists( $path )
		? (string) filemtime( $path )
		: CONTRIBUTOR_DAY_VERSION;
}

require_once CONTRIBUTOR_DAY_PLUGIN_DIR . 'includes/chat-rest.php';
require_once CONTRIBUTOR_DAY_PLUGIN_DIR . 'includes/chat-assets.php';
require_once CONTRIBUTOR_DAY_PLUGIN_DIR . 'includes/chat-admin-page.php';

/**
 * Enqueue editor abilities script module on block editor screens.
 *
 * Submodules are registered as dependencies rather than imported by relative
 * path so that WordPress resolves them through the import map, where each one
 * carries its own version query.
 */
function contributor_day_enqueue_editor_abilities() {
	if ( ! function_exists( 'wp_enqueue_script_module' ) ) {
		return;
	}

	// Ensure the Abilities client (and its import map entry) are available.
	wp_enqueue_script_module( '@wordpress/abilities' );

	// Installs `document.modelContext` for the bridge to register tools into.
	wp_enqueue_script( 'contributor-day-webmcp-polyfill' );

	wp_register_script_module(
		'@contributor-day/abilities',
		CONTRIBUTOR_DAY_PLUGIN_URL . 'js/abilities.js',
		array( '@wordpress/abilities' ),
		contributor_day_asset_version( 'js/abilities.js' )
	);

	wp_register_script_module(
		'@contributor-day/webmcp-bridge',
		CONTRIBUTOR_DAY_PLUGIN_URL . 'js/webmcp-bridge.js',
		array(
			'@wordpress/abilities',
			'@contributor-day/webmcp-polyfill',
			'@contributor-day/webmcp-tools',
		),
		contributor_day_asset_version( 'js/webmcp-bridge.js' )
	);

	wp_enqueue_script_module(
		'@contributor-day/editor-abilities',
		CONTRIBUTOR_DAY_PLUGIN_URL . 'js/index.js',
		array(
			'@wordpress/abilities',
			'@contributor-day/abilities',
			'@contributor-day/webmcp-bridge',
		),
		contributor_day_asset_version( 'js/index.js' )
	);
}
add_action( 'enqueue_block_editor_assets', 'contributor_day_enqueue_editor_abilities' );

/**
 * Enqueue the chat sidebar in the block editor.
 *
 * The sidebar mount is the only editor-specific piece; it renders the shared
 * panel into a PluginSidebar. The classic script dependencies are what put
 * `wp.plugins`, `wp.element`, and `wp.editor` on the page for it to read.
 */
function contributor_day_enqueue_editor_chat() {
	contributor_day_enqueue_chat(
		'@contributor-day/chat-editor-sidebar',
		'js/chat/mount-editor-sidebar.js'
	);

	if ( ! contributor_day_user_can_chat() ) {
		return;
	}

	wp_enqueue_script( 'wp-plugins' );
	wp_enqueue_script( 'wp-element' );
	wp_enqueue_script( 'wp-components' );
	wp_enqueue_script( 'wp-editor' );
	wp_enqueue_script( 'wp-i18n' );
}
add_action( 'enqueue_block_editor_assets', 'contributor_day_enqueue_editor_chat' );
