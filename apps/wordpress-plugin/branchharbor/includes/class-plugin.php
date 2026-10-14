<?php
/**
 * Bootstrap: wires hooks. Loading the plugin makes no external requests; nothing is contacted
 * until an administrator consents and connects.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Plugin {

	private static ?Plugin $instance = null;

	public static function instance(): Plugin {
		if ( null === self::$instance ) {
			self::$instance = new self();
			self::$instance->hooks();
		}
		return self::$instance;
	}

	private function hooks(): void {
		global $wp_version;
		if ( version_compare( (string) $wp_version, BRANCHHARBOR_MIN_WP, '<' ) ) {
			add_action(
				'admin_notices',
				static function () {
					echo '<div class="notice notice-error"><p>' . esc_html__( 'BranchHarbor Connector requires WordPress 6.4 or newer.', 'branchharbor' ) . '</p></div>';
				}
			);
			return;
		}

		Jobs::register();
		Leads::register();
		WooCommerce::register();
		add_action( 'init', array( Blocks::class, 'register' ) );
		add_action( 'rest_api_init', array( Rest::class, 'register' ) );
		add_action( 'admin_init', array( self::class, 'privacy_policy' ) );
		add_action( 'wp_initialize_site', array( Network::class, 'on_new_site' ), 20 );
		add_filter( 'block_categories_all', array( self::class, 'block_category' ) );

		if ( is_admin() ) {
			Admin::register();
		}
	}

	/**
	 * @param array<int,array<string,string>> $categories
	 * @return array<int,array<string,string>>
	 */
	public static function block_category( array $categories ): array {
		foreach ( $categories as $c ) {
			if ( 'branchharbor' === ( $c['slug'] ?? '' ) ) {
				return $categories;
			}
		}
		$categories[] = array(
			'slug'  => 'branchharbor',
			'title' => __( 'BranchHarbor', 'branchharbor' ),
		);
		return $categories;
	}

	/**
	 * Suggested privacy policy text (Settings → Privacy).
	 */
	public static function privacy_policy(): void {
		if ( ! function_exists( 'wp_add_privacy_policy_content' ) ) {
			return;
		}
		$text  = '<p>' . esc_html__( 'This site uses BranchHarbor to manage locations, schedules, menus and enquiries.', 'branchharbor' ) . '</p>';
		$text .= '<p>' . esc_html__( 'When you submit a BranchHarbor enquiry or demo form, the details you enter (such as name, email, phone and message) and the page address are sent to BranchHarbor and to the business location that receives the enquiry. If BranchHarbor is temporarily unavailable, the enquiry is stored on this site for up to 7 days and then sent or deleted.', 'branchharbor' ) . '</p>';
		$text .= '<p>' . esc_html__( 'Pages that show BranchHarbor locations, class schedules or menus load that content from this site; your browser does not contact BranchHarbor directly. Booking and pickup buttons link to pages hosted by BranchHarbor, which have their own privacy notice.', 'branchharbor' ) . '</p>';
		$text .= '<p>' . sprintf(
			/* translators: %s: BranchHarbor privacy policy URL */
			esc_html__( 'BranchHarbor privacy policy: %s', 'branchharbor' ),
			'<a href="https://branchharbor.com/legal/privacy">https://branchharbor.com/legal/privacy</a>'
		) . '</p>';
		wp_add_privacy_policy_content( 'BranchHarbor Connector', wp_kses_post( $text ) );
	}

	public static function activate( bool $network_wide = false ): void {
		Connect::add_role();
		if ( $network_wide && is_multisite() ) {
			// Roles are per site; add the least-privilege connector role everywhere (bounded).
			foreach ( get_sites(
				array(
					'fields' => 'ids',
					'number' => 1000,
				)
			) as $blog_id ) {
				switch_to_blog( (int) $blog_id );
				Connect::add_role();
				restore_current_blog();
			}
		}
		add_option( 'branchharbor_activated', 1, '', false );
		if ( false === get_option( Settings::OPT_SETTINGS ) ) {
			add_option( Settings::OPT_SETTINGS, Settings::defaults(), '', true );
		}
		// Recurring jobs are scheduled when the site connects, not on activation.
		unset( $network_wide ); // Subsites get defaults lazily; nothing is connected implicitly.
	}

	public static function deactivate(): void {
		Jobs::unschedule_all();
	}
}
