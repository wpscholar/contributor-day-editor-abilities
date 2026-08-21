<?php
/**
 * Script module registration and enqueueing for the chat panel.
 *
 * The chat is a React app built with Vite (see src/ and vite.config.ts). Two
 * pieces stay outside that bundle and remain hand-written script modules:
 *
 * - `@contributor-day/webmcp-tools`, so the chat and the ability bridge share
 *   one tool registry rather than each getting a private copy.
 * - `@contributor-day/chat-config`, so the `script_module_data_` filter below
 *   keeps being the way per-screen configuration reaches the client.
 *
 * The bundle imports both by their import-map IDs, which is why it ships as a
 * script module rather than as a classic script.
 *
 * @package ContributorDay
 */

defined( 'ABSPATH' ) || exit;

/**
 * Script module ID carrying the chat configuration for the current screen.
 */
const CONTRIBUTOR_DAY_CHAT_CONFIG_MODULE = '@contributor-day/chat-config';

/**
 * Directory holding the built chat assets, relative to the plugin root.
 */
const CONTRIBUTOR_DAY_CHAT_BUILD_DIR = 'build/';

/**
 * Register every chat-related script module and style.
 *
 * Registration is separate from enqueueing so both the editor sidebar and the
 * standalone screen can pull in the same graph.
 */
function contributor_day_register_chat_modules() {
	if ( ! function_exists( 'wp_register_script_module' ) ) {
		return;
	}

	$modules = array(
		'@contributor-day/webmcp-polyfill' => array( 'js/webmcp-polyfill.js', array() ),
		'@contributor-day/webmcp-tools'    => array( 'js/webmcp-tools.js', array( '@contributor-day/webmcp-polyfill' ) ),
		CONTRIBUTOR_DAY_CHAT_CONFIG_MODULE => array( 'js/chat/config.js', array() ),
	);

	foreach ( $modules as $id => $module ) {
		list( $path, $deps ) = $module;

		wp_register_script_module(
			$id,
			CONTRIBUTOR_DAY_PLUGIN_URL . $path,
			$deps,
			contributor_day_asset_version( $path )
		);
	}

	// The panel's own styles, emitted by the build.
	wp_register_style(
		'contributor-day-chat',
		CONTRIBUTOR_DAY_PLUGIN_URL . CONTRIBUTOR_DAY_CHAT_BUILD_DIR . 'chat.css',
		array(),
		contributor_day_asset_version( CONTRIBUTOR_DAY_CHAT_BUILD_DIR . 'chat.css' )
	);

	/*
	 * Layout for the wp-admin containers the panel mounts into. This is
	 * deliberately not part of the build: it styles WordPress's own markup,
	 * which sits outside the `.cdchat` scope the bundled stylesheet is
	 * confined to.
	 */
	wp_register_style(
		'contributor-day-chat-chrome',
		CONTRIBUTOR_DAY_PLUGIN_URL . 'css/chat-chrome.css',
		array( 'contributor-day-chat' ),
		contributor_day_asset_version( 'css/chat-chrome.css' )
	);

	/*
	 * The polyfill ships as a classic script rather than a module: the package's
	 * ESM build imports a bare specifier that import maps would not resolve,
	 * while this build is self-contained and installs itself on load. Classic
	 * scripts also run before deferred modules, so `document.modelContext`
	 * exists by the time any module looks for it.
	 */
	wp_register_script(
		'contributor-day-webmcp-polyfill',
		CONTRIBUTOR_DAY_PLUGIN_URL . 'js/vendor/webmcp-polyfill/webmcp-polyfill.js',
		array(),
		contributor_day_asset_version( 'js/vendor/webmcp-polyfill/webmcp-polyfill.js' ),
		true
	);
}
add_action( 'init', 'contributor_day_register_chat_modules' );

/**
 * Configuration handed to the chat modules for the current screen.
 *
 * Script modules cannot use wp_localize_script, so this rides along on the
 * script module data filter that core prints as JSON.
 *
 * @param array<string, mixed> $data Existing data.
 * @return array<string, mixed>
 */
function contributor_day_chat_module_data( $data ) {
	return array_merge(
		is_array( $data ) ? $data : array(),
		array(
			'restUrl'       => rest_url( CONTRIBUTOR_DAY_CHAT_NAMESPACE . '/chat' ),
			'nonce'         => wp_create_nonce( 'wp_rest' ),
			'available'     => contributor_day_chat_is_available(),
			'connectorsUrl' => current_user_can( 'manage_options' )
				? admin_url( 'options-connectors.php' )
				: null,
			'maxToolRounds' => (int) apply_filters( 'contributor_day_chat_max_tool_rounds', 8 ),
			'siteName'      => wp_specialchars_decode( get_bloginfo( 'name' ), ENT_QUOTES ),
		)
	);
}
add_filter( 'script_module_data_' . CONTRIBUTOR_DAY_CHAT_CONFIG_MODULE, 'contributor_day_chat_module_data' );

/**
 * Whether the chat bundle has been built.
 *
 * @return bool
 */
function contributor_day_chat_is_built() {
	return file_exists( CONTRIBUTOR_DAY_PLUGIN_DIR . CONTRIBUTOR_DAY_CHAT_BUILD_DIR . 'chat.css' );
}

/**
 * Enqueue the chat panel plus a mount for the current screen.
 *
 * @param string   $module_id  Script module ID to register the mount under.
 * @param string   $build_file Built entry file name, relative to the build directory.
 * @param string[] $extra_deps Additional script module dependencies.
 */
function contributor_day_enqueue_chat( $module_id, $build_file, array $extra_deps = array() ) {
	if ( ! function_exists( 'wp_enqueue_script_module' ) || ! contributor_day_user_can_chat() ) {
		return;
	}

	$path = CONTRIBUTOR_DAY_CHAT_BUILD_DIR . $build_file;

	if ( ! file_exists( CONTRIBUTOR_DAY_PLUGIN_DIR . $path ) ) {
		return;
	}

	wp_enqueue_style( 'contributor-day-chat-chrome' );
	wp_enqueue_script( 'contributor-day-webmcp-polyfill' );

	/*
	 * React comes from WordPress rather than from the bundle. Core asks plugins
	 * not to ship their own copy, since two runtimes in one page is what breaks
	 * on the React 19 upgrade, so the build rewrites every React import to read
	 * these globals instead. They are classic scripts, which run before
	 * deferred modules, so they are defined by the time the bundle executes.
	 */
	wp_enqueue_script( 'react' );
	wp_enqueue_script( 'react-dom' );
	wp_enqueue_script( 'react-jsx-runtime' );

	wp_enqueue_script_module(
		$module_id,
		CONTRIBUTOR_DAY_PLUGIN_URL . $path,
		array_merge(
			array(
				'@contributor-day/webmcp-tools',
				CONTRIBUTOR_DAY_CHAT_CONFIG_MODULE,
			),
			$extra_deps
		),
		contributor_day_asset_version( $path )
	);
}

/**
 * Tell an administrator when the chat is missing because nobody built it.
 *
 * The panel is compiled from src/, so a fresh checkout has no assets to load
 * and would otherwise just show nothing.
 */
function contributor_day_chat_build_notice() {
	if ( ! current_user_can( 'manage_options' ) || contributor_day_chat_is_built() ) {
		return;
	}

	wp_admin_notice(
		esc_html__( 'Contributor Day: the chat panel has not been built yet. Run "npm install && npm run build" in the plugin directory.', 'contributor-day' ),
		array( 'type' => 'warning' )
	);
}
add_action( 'admin_notices', 'contributor_day_chat_build_notice' );
