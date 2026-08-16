<?php
/**
 * Plugin Name:       Contributor Day Editor Abilities
 * Description:       Registers client-side block editor abilities and bridges them to WebMCP.
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

define( 'CONTRIBUTOR_DAY_VERSION', '0.1.0' );
define( 'CONTRIBUTOR_DAY_PLUGIN_FILE', __FILE__ );
define( 'CONTRIBUTOR_DAY_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'CONTRIBUTOR_DAY_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

/**
 * Enqueue editor abilities script module on block editor screens.
 */
function contributor_day_enqueue_editor_abilities() {
	if ( ! function_exists( 'wp_enqueue_script_module' ) ) {
		return;
	}

	// Ensure the Abilities client (and its import map entry) are available.
	wp_enqueue_script_module( '@wordpress/abilities' );

	$script_path = CONTRIBUTOR_DAY_PLUGIN_DIR . 'js/index.js';
	$version     = file_exists( $script_path )
		? (string) filemtime( $script_path )
		: CONTRIBUTOR_DAY_VERSION;

	wp_enqueue_script_module(
		'@contributor-day/editor-abilities',
		CONTRIBUTOR_DAY_PLUGIN_URL . 'js/index.js',
		array( '@wordpress/abilities' ),
		$version
	);
}
add_action( 'enqueue_block_editor_assets', 'contributor_day_enqueue_editor_abilities' );
