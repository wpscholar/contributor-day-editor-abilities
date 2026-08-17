<?php
/**
 * Script module registration and enqueueing for the chat panel.
 *
 * The chat is built as three layers: a tool registry over WebMCP, a session
 * that talks to the REST endpoint, and a panel that renders into any element.
 * Each mount (block editor sidebar, standalone admin page) only adds the last
 * step, so the chat itself is not tied to the editor.
 *
 * @package ContributorDay
 */

defined( 'ABSPATH' ) || exit;

/**
 * Script module ID carrying the chat configuration for the current screen.
 */
const CONTRIBUTOR_DAY_CHAT_CONFIG_MODULE = '@contributor-day/chat-config';

/**
 * Register every chat-related script module.
 *
 * Registration is separate from enqueueing so both the editor sidebar and the
 * standalone page can pull in the same graph.
 */
function contributor_day_register_chat_modules() {
	if ( ! function_exists( 'wp_register_script_module' ) ) {
		return;
	}

	$modules = array(
		'@contributor-day/webmcp-polyfill' => array( 'js/webmcp-polyfill.js', array() ),
		'@contributor-day/webmcp-tools'    => array( 'js/webmcp-tools.js', array( '@contributor-day/webmcp-polyfill' ) ),
		CONTRIBUTOR_DAY_CHAT_CONFIG_MODULE => array( 'js/chat/config.js', array() ),
		'@contributor-day/chat-markup'     => array( 'js/chat/markup.js', array() ),
		'@contributor-day/chat-session'    => array(
			'js/chat/session.js',
			array( CONTRIBUTOR_DAY_CHAT_CONFIG_MODULE, '@contributor-day/webmcp-tools' ),
		),
		'@contributor-day/chat-panel'      => array(
			'js/chat/panel.js',
			array(
				'@contributor-day/chat-session',
				'@contributor-day/webmcp-tools',
				'@contributor-day/chat-markup',
				CONTRIBUTOR_DAY_CHAT_CONFIG_MODULE,
			),
		),
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

	wp_register_style(
		'contributor-day-chat',
		CONTRIBUTOR_DAY_PLUGIN_URL . 'css/chat.css',
		array(),
		contributor_day_asset_version( 'css/chat.css' )
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
 * Enqueue the chat panel plus a mount for the current screen.
 *
 * @param string   $mount_module Script module ID of the mount.
 * @param string   $mount_path   Path to the mount module, relative to the plugin root.
 * @param string[] $extra_deps   Additional script module dependencies.
 */
function contributor_day_enqueue_chat( $mount_module, $mount_path, array $extra_deps = array() ) {
	if ( ! function_exists( 'wp_enqueue_script_module' ) || ! contributor_day_user_can_chat() ) {
		return;
	}

	wp_enqueue_style( 'contributor-day-chat' );
	wp_enqueue_script( 'contributor-day-webmcp-polyfill' );

	wp_enqueue_script_module(
		$mount_module,
		CONTRIBUTOR_DAY_PLUGIN_URL . $mount_path,
		array_merge( array( '@contributor-day/chat-panel' ), $extra_deps ),
		contributor_day_asset_version( $mount_path )
	);
}
