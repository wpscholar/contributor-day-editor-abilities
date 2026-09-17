<?php
/**
 * Standalone chat screen.
 *
 * This is the same chat panel the block editor sidebar mounts, on a page of its
 * own. It exists to prove the chat is not tied to the editor: it picks up
 * whatever WebMCP tools the current page registers, which on this screen is
 * usually none.
 *
 * @package AgenticEditor
 */

defined( 'ABSPATH' ) || exit;

/**
 * Admin page slug.
 */
const AGENTIC_EDITOR_CHAT_PAGE = 'agentic-editor-chat';

/**
 * Add the chat screen under Tools.
 */
function agentic_editor_register_chat_admin_page() {
	$hook = add_management_page(
		__( 'AI Chat', 'agentic-editor' ),
		__( 'AI Chat', 'agentic-editor' ),
		agentic_editor_chat_capability(),
		AGENTIC_EDITOR_CHAT_PAGE,
		'agentic_editor_render_chat_admin_page'
	);

	if ( $hook ) {
		add_action( "load-{$hook}", 'agentic_editor_chat_admin_page_loaded' );
	}
}
add_action( 'admin_menu', 'agentic_editor_register_chat_admin_page' );

/**
 * Mark the screen so the enqueue callback knows to load the chat.
 */
function agentic_editor_chat_admin_page_loaded() {
	add_action( 'admin_enqueue_scripts', 'agentic_editor_enqueue_chat_admin_page' );
	add_filter( 'admin_body_class', 'agentic_editor_chat_admin_body_class' );
}

/**
 * @param string $classes Body classes.
 * @return string
 */
function agentic_editor_chat_admin_body_class( $classes ) {
	return $classes . ' agentic-editor-chat-screen';
}

/**
 * Enqueue the standalone mount.
 */
function agentic_editor_enqueue_chat_admin_page() {
	agentic_editor_enqueue_chat(
		'@agentic-editor/chat-standalone',
		'chat-standalone.js'
	);
}

/**
 * Render the screen.
 */
function agentic_editor_render_chat_admin_page() {
	?>
	<div class="wrap agentic-editor-chat-page">
		<h1><?php echo esc_html__( 'AI Chat', 'agentic-editor' ); ?></h1>
		<p class="agentic-editor-chat-page__intro">
			<?php echo esc_html__( 'Chat with the AI provider configured for this site. Any WebMCP tools registered by the current page are offered to the model.', 'agentic-editor' ); ?>
		</p>
		<div id="agentic-editor-chat-root" class="agentic-editor-chat-page__panel"></div>
	</div>
	<?php
}
