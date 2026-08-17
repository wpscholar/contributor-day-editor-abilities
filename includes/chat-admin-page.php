<?php
/**
 * Standalone chat screen.
 *
 * This is the same chat panel the block editor sidebar mounts, on a page of its
 * own. It exists to prove the chat is not tied to the editor: it picks up
 * whatever WebMCP tools the current page registers, which on this screen is
 * usually none.
 *
 * @package ContributorDay
 */

defined( 'ABSPATH' ) || exit;

/**
 * Admin page slug.
 */
const CONTRIBUTOR_DAY_CHAT_PAGE = 'contributor-day-chat';

/**
 * Add the chat screen under Tools.
 */
function contributor_day_register_chat_admin_page() {
	$hook = add_management_page(
		__( 'AI Chat', 'contributor-day' ),
		__( 'AI Chat', 'contributor-day' ),
		contributor_day_chat_capability(),
		CONTRIBUTOR_DAY_CHAT_PAGE,
		'contributor_day_render_chat_admin_page'
	);

	if ( $hook ) {
		add_action( "load-{$hook}", 'contributor_day_chat_admin_page_loaded' );
	}
}
add_action( 'admin_menu', 'contributor_day_register_chat_admin_page' );

/**
 * Mark the screen so the enqueue callback knows to load the chat.
 */
function contributor_day_chat_admin_page_loaded() {
	add_action( 'admin_enqueue_scripts', 'contributor_day_enqueue_chat_admin_page' );
	add_filter( 'admin_body_class', 'contributor_day_chat_admin_body_class' );
}

/**
 * @param string $classes Body classes.
 * @return string
 */
function contributor_day_chat_admin_body_class( $classes ) {
	return $classes . ' contributor-day-chat-screen';
}

/**
 * Enqueue the standalone mount.
 */
function contributor_day_enqueue_chat_admin_page() {
	contributor_day_enqueue_chat(
		'@contributor-day/chat-standalone',
		'js/chat/mount-standalone.js'
	);
}

/**
 * Render the screen.
 */
function contributor_day_render_chat_admin_page() {
	?>
	<div class="wrap contributor-day-chat-page">
		<h1><?php echo esc_html__( 'AI Chat', 'contributor-day' ); ?></h1>
		<p class="contributor-day-chat-page__intro">
			<?php echo esc_html__( 'Chat with the AI provider configured for this site. Any WebMCP tools registered by the current page are offered to the model.', 'contributor-day' ); ?>
		</p>
		<div id="contributor-day-chat-root" class="contributor-day-chat-page__panel"></div>
	</div>
	<?php
}
