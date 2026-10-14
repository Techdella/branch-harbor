<?php
/**
 * Settings → BranchHarbor (and Network Admin → Settings → BranchHarbor on Multisite).
 *
 * Tabs: Overview (status), Connect (consent → detect → authorise → map → data → test → done),
 * Compatibility, Blocks, Settings. Every state change is a POST to admin-post.php protected by a
 * nonce and a capability check; nothing here edits posts, users or other plugins' settings.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Admin {

	public const SLUG = 'branchharbor';

	private const STEPS = array( 'consent', 'detect', 'authorise', 'map', 'data', 'test', 'done' );

	private const HANDLERS = array( 'consent', 'scan', 'authorize', 'oauth_return', 'connect_code', 'connect_public', 'save_mapping', 'save_network_mapping', 'save_directions', 'run_tests', 'retry', 'save_settings', 'disconnect', 'withdraw_consent' );

	public static function register(): void {
		add_action( 'admin_menu', array( self::class, 'menu' ) );
		add_action( 'network_admin_menu', array( self::class, 'network_menu' ) );
		add_action( 'admin_enqueue_scripts', array( self::class, 'assets' ) );
		add_action( 'admin_notices', array( self::class, 'notices' ) );
		add_action( 'network_admin_notices', array( self::class, 'notices' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( BRANCHHARBOR_FILE ), array( self::class, 'action_links' ) );
		foreach ( self::HANDLERS as $h ) {
			add_action( 'admin_post_branchharbor_' . $h, array( self::class, 'handle_' . $h ) );
		}
	}

	public static function menu(): void {
		add_options_page( __( 'BranchHarbor', 'branchharbor' ), __( 'BranchHarbor', 'branchharbor' ), 'manage_options', self::SLUG, array( self::class, 'page' ) );
	}

	public static function network_menu(): void {
		if ( Network::is_network_active() ) {
			add_submenu_page( 'settings.php', __( 'BranchHarbor', 'branchharbor' ), __( 'BranchHarbor', 'branchharbor' ), 'manage_network_options', self::SLUG, array( self::class, 'network_page' ) );
		}
	}

	/**
	 * @param string[] $links
	 * @return string[]
	 */
	public static function action_links( array $links ): array {
		array_unshift( $links, '<a href="' . esc_url( self::url() ) . '">' . esc_html__( 'Settings', 'branchharbor' ) . '</a>' );
		return $links;
	}

	public static function assets( string $hook ): void {
		if ( false === strpos( $hook, self::SLUG ) ) {
			return;
		}
		wp_enqueue_style( 'branchharbor-admin', BRANCHHARBOR_URL . 'assets/css/admin.css', array(), BRANCHHARBOR_VERSION );
		wp_enqueue_script( 'branchharbor-admin', BRANCHHARBOR_URL . 'assets/js/admin.js', array(), BRANCHHARBOR_VERSION, true );
	}

	/**
	 * @param array<string,string> $args
	 */
	public static function url( array $args = array(), bool $network = false ): string {
		$base = $network ? network_admin_url( 'settings.php?page=' . self::SLUG ) : admin_url( 'options-general.php?page=' . self::SLUG );
		return add_query_arg( $args, $base );
	}

	/* ------------------------------------------------------------------ */
	/* Notices                                                             */
	/* ------------------------------------------------------------------ */

	private static function flash( string $type, string $message ): void {
		set_transient( 'branchharbor_notice_' . get_current_user_id(), array( $type, $message ), 120 );
	}

	public static function notices(): void {
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( get_option( 'branchharbor_activated' ) && current_user_can( 'manage_options' ) ) {
			delete_option( 'branchharbor_activated' );
			echo '<div class="notice notice-info is-dismissible"><p>' . esc_html__( 'BranchHarbor Connector is active. Nothing is sent to BranchHarbor until you connect and agree to data processing.', 'branchharbor' ) . ' <a href="' . esc_url( self::url( array( 'tab' => 'connect' ) ) ) . '">' . esc_html__( 'Connect this site', 'branchharbor' ) . '</a></p></div>';
		}
		if ( ! $screen || false === strpos( (string) $screen->id, self::SLUG ) ) {
			return;
		}
		$n = get_transient( 'branchharbor_notice_' . get_current_user_id() );
		if ( is_array( $n ) ) {
			delete_transient( 'branchharbor_notice_' . get_current_user_id() );
			$class = 'error' === $n[0] ? 'notice-error' : ( 'warning' === $n[0] ? 'notice-warning' : 'notice-success' );
			echo '<div class="notice ' . esc_attr( $class ) . ' is-dismissible"><p>' . esc_html( (string) $n[1] ) . '</p></div>';
		}
	}

	/* ------------------------------------------------------------------ */
	/* Handlers                                                            */
	/* ------------------------------------------------------------------ */

	/**
	 * Verify nonce + capability. Network requests need manage_network_options.
	 */
	private static function verify( string $action ): bool {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- checked by check_admin_referer below.
		$network = ! empty( $_POST['bh_network'] ) && is_multisite();
		check_admin_referer( 'branchharbor_' . $action );
		if ( ! current_user_can( $network ? 'manage_network_options' : 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to manage BranchHarbor.', 'branchharbor' ), 403 );
		}
		return $network;
	}

	/**
	 * @param array<string,string> $args
	 * @return never
	 */
	private static function back( array $args, bool $network ): void {
		wp_safe_redirect( self::url( $args, $network ) );
		exit;
	}

	private static function post( string $key ): string {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- callers verify the nonce first.
		return isset( $_POST[ $key ] ) && is_string( $_POST[ $key ] ) ? sanitize_text_field( wp_unslash( $_POST[ $key ] ) ) : '';
	}

	public static function handle_consent(): void {
		$network = self::verify( 'consent' );
		if ( '1' !== self::post( 'bh_consent' ) ) {
			self::flash( 'error', __( 'Agree to data processing to continue.', 'branchharbor' ) );
			self::back(
				array(
					'tab'  => 'connect',
					'step' => 'consent',
				),
				$network
			);
		}
		Settings::record_consent( true, $network );
		self::back(
			array(
				'tab'  => 'connect',
				'step' => $network ? 'authorise' : 'detect',
			),
			$network
		);
	}

	public static function handle_withdraw_consent(): void {
		$network = self::verify( 'withdraw_consent' );
		Connect::disconnect( $network );
		Settings::record_consent( false, $network );
		delete_option( Settings::OPT_LEADS );
		self::flash( 'success', __( 'Consent withdrawn and the site disconnected. Queued enquiries were deleted from this site.', 'branchharbor' ) );
		self::back( array( 'tab' => 'settings' ), $network );
	}

	public static function handle_scan(): void {
		$network = self::verify( 'scan' );
		Detector::scan();
		self::back(
			array(
				'tab'  => 'connect',
				'step' => 'detect',
			),
			$network
		);
	}

	public static function handle_authorize(): void {
		$network = self::verify( 'authorize' );
		if ( ! Settings::consent()['granted'] ) {
			self::back(
				array(
					'tab'  => 'connect',
					'step' => 'consent',
				),
				$network
			);
		}
		// External redirect to the BranchHarbor app (fixed, filterable host).
		wp_redirect( Connect::authorize_url( $network ) ); // phpcs:ignore WordPress.Security.SafeRedirect.wp_redirect_wp_redirect -- intentional redirect to app.branchharbor.com.
		exit;
	}

	/**
	 * Return from app.branchharbor.com. Verified by the one-time state value bound to this admin.
	 */
	public static function handle_oauth_return(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to manage BranchHarbor.', 'branchharbor' ), 403 );
		}
		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- the OAuth "state" parameter is the CSRF check.
		$code  = isset( $_GET['code'] ) ? sanitize_text_field( wp_unslash( $_GET['code'] ) ) : '';
		$state = isset( $_GET['state'] ) ? sanitize_text_field( wp_unslash( $_GET['state'] ) ) : '';
		// phpcs:enable WordPress.Security.NonceVerification.Recommended
		$saved   = get_transient( 'branchharbor_auth_' . get_current_user_id() );
		$network = is_array( $saved ) && ! empty( $saved['network'] );
		$result  = Connect::handle_return( $code, $state );
		if ( is_wp_error( $result ) ) {
			self::flash( 'error', $result->get_error_message() );
			self::back(
				array(
					'tab'  => 'connect',
					'step' => 'authorise',
				),
				$network
			);
		}
		self::flash( 'success', __( 'Access approved. Now map this site to a location.', 'branchharbor' ) );
		self::back(
			array(
				'tab'  => 'connect',
				'step' => 'map',
			),
			$network
		);
	}

	public static function handle_connect_code(): void {
		$network = self::verify( 'connect_code' );
		$result  = Connect::connect_with_code( self::post( 'bh_code' ), $network );
		if ( is_wp_error( $result ) ) {
			self::flash( 'error', $result->get_error_message() );
			self::back(
				array(
					'tab'  => 'connect',
					'step' => 'authorise',
				),
				$network
			);
		}
		self::flash( 'success', __( 'Connected. Now map this site to a location.', 'branchharbor' ) );
		self::back(
			array(
				'tab'  => 'connect',
				'step' => 'map',
			),
			$network
		);
	}

	public static function handle_connect_public(): void {
		$network = self::verify( 'connect_public' );
		$result  = Connect::connect_public( self::post( 'bh_org' ), $network );
		if ( is_wp_error( $result ) ) {
			self::flash( 'error', $result->get_error_message() );
			self::back(
				array(
					'tab'  => 'connect',
					'step' => 'authorise',
				),
				$network
			);
		}
		self::flash( 'success', __( 'Public content connected. Now map this site to a location.', 'branchharbor' ) );
		self::back(
			array(
				'tab'  => 'connect',
				'step' => 'map',
			),
			$network
		);
	}

	public static function handle_save_mapping(): void {
		$network = self::verify( 'save_mapping' );
		$target  = strtolower( self::post( 'bh_mapping' ) );
		if ( ! Mapping::valid_target( $target ) ) {
			self::flash( 'error', __( 'Choose a location, the organisation, or "Don’t connect this site".', 'branchharbor' ) );
			self::back(
				array(
					'tab'  => 'connect',
					'step' => 'map',
				),
				$network
			);
		}
		Settings::update( array( 'mapping' => $target ) );
		Cache::invalidate( 'schedule' );
		Activity::log( 'mapping_saved' );
		$results = self::site_validation();
		if ( ! Mapping::all_valid( $results ) ) {
			self::back(
				array(
					'tab'  => 'connect',
					'step' => 'map',
				),
				$network
			);
		}
		Connect::push_config();
		self::back(
			array(
				'tab'  => 'connect',
				'step' => 'data',
			),
			$network
		);
	}

	public static function handle_save_network_mapping(): void {
		$network = self::verify( 'save_network_mapping' );
		if ( ! $network ) {
			wp_die( esc_html__( 'Network mapping can only be changed in Network Admin.', 'branchharbor' ), 403 );
		}
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- verified above.
		$posted = isset( $_POST['bh_site'] ) && is_array( $_POST['bh_site'] ) ? array_map( 'sanitize_text_field', wp_unslash( $_POST['bh_site'] ) ) : array();
		$valid  = wp_list_pluck( Network::sites(), 'site_id' );
		foreach ( $posted as $blog_id => $target ) {
			$blog_id = (int) $blog_id;
			$target  = strtolower( sanitize_text_field( (string) $target ) );
			if ( in_array( $blog_id, $valid, true ) && Mapping::valid_target( $target ) ) {
				Network::set_target( $blog_id, $target );
			}
		}
		Activity::log( 'mapping_saved' );
		Connect::push_config();
		self::flash( Mapping::all_valid( Network::validate() ) ? 'success' : 'warning', Mapping::all_valid( Network::validate() ) ? __( 'Site mapping saved.', 'branchharbor' ) : __( 'Saved, but some sites still have mapping errors.', 'branchharbor' ) );
		self::back( array(), true );
	}

	public static function handle_save_directions(): void {
		$network = self::verify( 'save_directions' );
		$dirs    = Settings::get( 'directions' );
		foreach ( array_keys( Settings::data_types() ) as $type ) {
			$value = self::post( 'bh_dir_' . $type );
			if ( '' !== $value && Settings::valid_direction( $type, $value ) ) {
				$dirs[ $type ] = $value;
			}
		}
		$seo = self::post( 'bh_seo_owner' );
		Settings::update(
			array(
				'directions' => $dirs,
				'seo_owner'  => 'wordpress' === $seo ? 'wordpress' : (string) Settings::get( 'seo_owner' ),
			)
		);
		Activity::log( 'directions_saved' );
		Connect::push_config();
		self::back(
			array(
				'tab'  => 'connect',
				'step' => 'test',
			),
			$network
		);
	}

	public static function handle_run_tests(): void {
		$network = self::verify( 'run_tests' );
		$tests   = Connection_Tests::run();
		if ( Connection_Tests::all_passed( $tests ) && '1' === self::post( 'bh_finish' ) ) {
			self::back(
				array(
					'tab'  => 'connect',
					'step' => 'done',
				),
				$network
			);
		}
		self::back(
			array(
				'tab'  => 'connect',
				'step' => 'test',
			),
			$network
		);
	}

	public static function handle_retry(): void {
		$network = self::verify( 'retry' );
		Leads::flush_queue();
		WooCommerce::flush();
		Connect::sync_site();
		$c = Settings::connection();
		if ( Connection_Status::DEGRADED === $c['state'] && 0 === (int) $c['failures'] ) {
			Settings::update_connection( array( 'state' => Connection_Status::CONNECTED ) );
		}
		self::flash( 'success', __( 'Retry started. Waiting records are sent in the background.', 'branchharbor' ) );
		self::back( array( 'tab' => 'overview' ), $network );
	}

	public static function handle_save_settings(): void {
		$network = self::verify( 'save_settings' );
		Settings::update(
			array(
				'credits'   => '1' === self::post( 'bh_credits' ),
				'debug'     => '1' === self::post( 'bh_debug' ),
				'keep_data' => '1' === self::post( 'bh_keep_data' ),
			)
		);
		self::flash( 'success', __( 'Settings saved.', 'branchharbor' ) );
		self::back( array( 'tab' => 'settings' ), $network );
	}

	public static function handle_disconnect(): void {
		$network = self::verify( 'disconnect' );
		if ( '1' !== self::post( 'bh_confirm' ) ) {
			self::flash( 'error', __( 'Tick the confirmation box to disconnect.', 'branchharbor' ) );
			self::back( array( 'tab' => 'settings' ), $network );
		}
		Connect::disconnect( $network );
		self::flash( 'success', __( 'Disconnected. Your pages and WordPress content are untouched.', 'branchharbor' ) );
		self::back( array( 'tab' => 'overview' ), $network );
	}

	/* ------------------------------------------------------------------ */
	/* Rendering helpers                                                   */
	/* ------------------------------------------------------------------ */

	private static function form_open( string $action, bool $network, string $css_class = '' ): void {
		echo '<form method="post" action="' . esc_url( $network ? network_admin_url( 'admin-post.php' ) : admin_url( 'admin-post.php' ) ) . '"' . ( $css_class ? ' class="' . esc_attr( $css_class ) . '"' : '' ) . '>';
		echo '<input type="hidden" name="action" value="' . esc_attr( 'branchharbor_' . $action ) . '">';
		if ( $network ) {
			echo '<input type="hidden" name="bh_network" value="1">';
		}
		wp_nonce_field( 'branchharbor_' . $action );
	}

	private static function pill( string $label, string $tone ): string {
		return '<span class="bh-pill bh-pill-' . esc_attr( $tone ) . '">' . esc_html( $label ) . '</span>';
	}

	private static function status_tone( string $status ): string {
		$map = array(
			Compat::TESTED         => 'success',
			Compat::LIMITED        => 'warning',
			Compat::REQUIRES_SETUP => 'info',
			Compat::PLANNED        => 'neutral',
			Compat::UNSUPPORTED    => 'error',
		);
		return $map[ $status ] ?? 'neutral';
	}

	private static function ago( ?int $ts ): string {
		if ( ! $ts ) {
			return __( 'Never', 'branchharbor' );
		}
		/* translators: %s: human-readable time difference, e.g. "5 mins" */
		return sprintf( __( '%s ago', 'branchharbor' ), human_time_diff( $ts, time() ) );
	}

	/**
	 * @return array<string,array{status:string,errors:array,warnings:array,suggestions:string[]}>
	 */
	private static function site_validation(): array {
		return Mapping::validate(
			array(
				array(
					'site_id'  => get_current_blog_id(),
					'name'     => get_bloginfo( 'name' ),
					'timezone' => wp_timezone_string(),
					'target'   => (string) Settings::get( 'mapping' ),
				),
			),
			(array) Settings::connection()['locations']
		);
	}

	private static function location_name( string $id ): string {
		if ( Mapping::TARGET_ORG === $id ) {
			return __( 'Organisation', 'branchharbor' );
		}
		if ( Mapping::TARGET_NONE === $id ) {
			return __( 'Not connected', 'branchharbor' );
		}
		$l = Settings::location( $id );
		return $l ? $l['name'] : __( 'Unknown location', 'branchharbor' );
	}

	private static function current_step(): string {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- navigation only.
		$step = isset( $_GET['step'] ) ? sanitize_key( wp_unslash( $_GET['step'] ) ) : '';
		if ( in_array( $step, self::STEPS, true ) ) {
			return $step;
		}
		if ( ! Settings::consent()['granted'] ) {
			return 'consent';
		}
		if ( ! Settings::can_call() && Connection_Status::EXPIRED !== Settings::connection()['state'] ) {
			return is_array( Settings::get( 'last_scan' ) ) ? 'authorise' : 'detect';
		}
		if ( Connection_Status::EXPIRED === Settings::connection()['state'] ) {
			return 'authorise';
		}
		return Connection_Tests::all_passed( Settings::get( 'last_tests' ) ) ? 'done' : 'map';
	}

	/* ------------------------------------------------------------------ */
	/* Pages                                                               */
	/* ------------------------------------------------------------------ */

	public static function page(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- navigation only.
		$tab  = isset( $_GET['tab'] ) ? sanitize_key( wp_unslash( $_GET['tab'] ) ) : '';
		$tabs = array(
			'overview' => __( 'Overview', 'branchharbor' ),
			'connect'  => __( 'Connect', 'branchharbor' ),
			'compat'   => __( 'Compatibility', 'branchharbor' ),
			'blocks'   => __( 'Blocks', 'branchharbor' ),
			'settings' => __( 'Settings', 'branchharbor' ),
		);
		if ( ! isset( $tabs[ $tab ] ) ) {
			$tab = Settings::can_call() || Connection_Status::NOT_CONNECTED !== Settings::connection()['state'] ? 'overview' : 'connect';
		}
		$status = self::status();

		echo '<div class="wrap bh-wrap">';
		echo '<h1 class="bh-title"><span class="bh-mark" aria-hidden="true"></span>' . esc_html__( 'BranchHarbor', 'branchharbor' ) . ' ' . self::pill( $status['label'], $status['tone'] ) . '</h1>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- pill() escapes.
		echo '<nav class="nav-tab-wrapper" aria-label="' . esc_attr__( 'BranchHarbor sections', 'branchharbor' ) . '">';
		foreach ( $tabs as $key => $label ) {
			echo '<a href="' . esc_url( self::url( array( 'tab' => $key ) ) ) . '" class="nav-tab' . ( $tab === $key ? ' nav-tab-active' : '' ) . '"' . ( $tab === $key ? ' aria-current="page"' : '' ) . '>' . esc_html( $label ) . '</a>';
		}
		echo '</nav><div class="bh-body">';
		switch ( $tab ) {
			case 'connect':
				self::connect_tab( false );
				break;
			case 'compat':
				self::compat_tab();
				break;
			case 'blocks':
				self::blocks_tab();
				break;
			case 'settings':
				self::settings_tab( false );
				break;
			default:
				self::overview_tab( $status, false );
		}
		echo '</div></div>';
	}

	public static function network_page(): void {
		if ( ! current_user_can( 'manage_network_options' ) ) {
			return;
		}
		$status = self::status();
		echo '<div class="wrap bh-wrap">';
		echo '<h1 class="bh-title"><span class="bh-mark" aria-hidden="true"></span>' . esc_html__( 'BranchHarbor network', 'branchharbor' ) . ' ' . self::pill( $status['label'], $status['tone'] ) . '</h1>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- pill() escapes.
		echo '<div class="bh-body">';
		echo '<p class="bh-lead">' . esc_html__( 'Authorise the network once, then choose a BranchHarbor location for each site. Sites are never connected until you choose. Each site’s administrators manage data directions and blocks in their own Settings → BranchHarbor.', 'branchharbor' ) . '</p>';

		$net = Settings::network_connection();
		if ( ! $net || ! Settings::consent()['granted'] ) {
			echo '<section class="bh-card bh-step">';
			Settings::consent()['granted'] ? self::step_authorise( true ) : self::step_consent( true );
			echo '</section>';
		} else {
			self::overview_tab( $status, true );
			self::network_mapping();
			self::settings_disconnect( true );
		}
		echo '</div></div>';
	}

	/**
	 * @return array{state:string,label:string,tone:string,description:string,recovery:?string,recovery_action:?string}
	 */
	private static function status(): array {
		$c = Settings::connection();
		return Connection_Status::describe(
			array(
				'state'            => (string) $c['state'],
				'affected_records' => (int) $c['affected_records'],
				'queued_leads'     => count( Leads::queue() ),
				'pending_orders'   => WooCommerce::pending_count(),
				'sync_progress'    => is_array( $c['sync_progress'] ) ? $c['sync_progress'] : null,
			)
		);
	}

	/* ------------------------------------------------------------------ */

	/**
	 * @param array{state:string,label:string,tone:string,description:string,recovery:?string,recovery_action:?string} $status
	 */
	private static function overview_tab( array $status, bool $network ): void {
		$c = Settings::connection();
		echo '<section class="bh-card bh-status bh-tone-' . esc_attr( $status['tone'] ) . '" aria-live="polite">';
		echo '<h2>' . esc_html( $status['label'] ) . '</h2><p>' . esc_html( $status['description'] ) . '</p>';
		if ( ! empty( $c['last_error'] ) && in_array( $status['state'], array( Connection_Status::DEGRADED, Connection_Status::EXPIRED ), true ) ) {
			/* translators: %s: last error message */
			echo '<p class="bh-muted">' . esc_html( sprintf( __( 'Last error: %s', 'branchharbor' ), (string) $c['last_error'] ) ) . '</p>';
		}
		if ( 'retry' === $status['recovery_action'] ) {
			self::form_open( 'retry', $network, 'bh-inline' );
			submit_button( (string) $status['recovery'], 'primary', 'submit', false );
			echo '</form>';
		} elseif ( $status['recovery_action'] ) {
			echo '<a class="button button-primary" href="' . esc_url(
				self::url(
					array(
						'tab'  => 'connect',
						'step' => 'consent' === self::current_step() ? 'consent' : 'authorise',
					),
					$network
				)
			) . '">' . esc_html( (string) $status['recovery'] ) . '</a>';
		}
		echo '</section>';

		if ( Connection_Status::NOT_CONNECTED === $status['state'] ) {
			return;
		}
		$org   = (array) ( $c['organization'] ?? array() );
		$stats = array(
			array( __( 'Last successful sync', 'branchharbor' ), self::ago( $c['last_success_at'] ? (int) $c['last_success_at'] : null ) ),
			array( __( 'Organisation', 'branchharbor' ), '' !== (string) ( $org['name'] ?? '' ) ? (string) $org['name'] : '—' ),
			array( __( 'Locations available', 'branchharbor' ), (string) count( (array) $c['locations'] ) ),
			array( __( 'Enquiries queued', 'branchharbor' ), (string) count( Leads::queue() ) ),
			array( __( 'Records waiting', 'branchharbor' ), (string) ( WooCommerce::pending_count() + (int) $c['affected_records'] ) ),
			array( __( 'Connection type', 'branchharbor' ), Settings::is_public_only() ? __( 'Public content only', 'branchharbor' ) : ( $c['network'] ? __( 'Network authorisation', 'branchharbor' ) : __( 'Site authorisation', 'branchharbor' ) ) ),
		);
		echo '<div class="bh-stats">';
		foreach ( $stats as $s ) {
			echo '<div class="bh-stat"><span class="bh-stat-label">' . esc_html( $s[0] ) . '</span><span class="bh-stat-value">' . esc_html( $s[1] ) . '</span></div>';
		}
		echo '</div>';

		if ( ! $network ) {
			echo '<section class="bh-card"><h2>' . esc_html__( 'This site', 'branchharbor' ) . '</h2><table class="widefat striped"><thead><tr><th>' . esc_html__( 'Site', 'branchharbor' ) . '</th><th>' . esc_html__( 'BranchHarbor location', 'branchharbor' ) . '</th><th>' . esc_html__( 'Status', 'branchharbor' ) . '</th></tr></thead><tbody>';
			$v = self::site_validation();
			$r = reset( $v );
			echo '<tr><td>' . esc_html( get_bloginfo( 'name' ) ) . '<br><span class="bh-muted">' . esc_html( home_url( '/' ) ) . '</span></td><td>' . esc_html( self::location_name( (string) Settings::get( 'mapping' ) ) ) . '</td><td>' . ( $r && 'error' === $r['status'] ? self::pill( __( 'Mapping error', 'branchharbor' ), 'error' ) : self::pill( __( 'Matched', 'branchharbor' ), 'success' ) ) . '</td></tr>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- pill() escapes.
			echo '</tbody></table></section>';
		}

		echo '<section class="bh-card"><h2>' . esc_html__( 'Recent activity', 'branchharbor' ) . '</h2>';
		$recent = Activity::recent( 10 );
		if ( ! $recent ) {
			echo '<p class="bh-muted">' . esc_html__( 'No activity yet.', 'branchharbor' ) . '</p>';
		} else {
			echo '<ul class="bh-activity">';
			foreach ( $recent as $e ) {
				echo '<li class="bh-activity-' . esc_attr( $e['level'] ) . '"><span>' . esc_html( Activity::message( $e ) ) . '</span><time datetime="' . esc_attr( gmdate( 'c', (int) $e['at'] ) ) . '">' . esc_html( self::ago( (int) $e['at'] ) ) . '</time></li>';
			}
			echo '</ul>';
		}
		echo '</section>';
	}

	/* ------------------------------------------------------------------ */

	private static function connect_tab( bool $network ): void {
		$step   = self::current_step();
		$labels = array(
			'consent'   => __( 'Consent', 'branchharbor' ),
			'detect'    => __( 'Detect', 'branchharbor' ),
			'authorise' => __( 'Authorise', 'branchharbor' ),
			'map'       => __( 'Map sites', 'branchharbor' ),
			'data'      => __( 'Data', 'branchharbor' ),
			'test'      => __( 'Test', 'branchharbor' ),
			'done'      => __( 'Done', 'branchharbor' ),
		);
		$reach  = self::reachable_steps();
		echo '<ol class="bh-steps">';
		foreach ( self::STEPS as $i => $key ) {
			$on = $key === $step;
			echo '<li class="' . ( $on ? 'is-current' : '' ) . '">';
			if ( in_array( $key, $reach, true ) && ! $on ) {
				echo '<a href="' . esc_url(
					self::url(
						array(
							'tab'  => 'connect',
							'step' => $key,
						),
						$network
					)
				) . '"><span class="bh-step-n">' . esc_html( (string) ( $i + 1 ) ) . '</span>' . esc_html( $labels[ $key ] ) . '</a>';
			} else {
				echo '<span' . ( $on ? ' aria-current="step"' : '' ) . '><span class="bh-step-n">' . esc_html( (string) ( $i + 1 ) ) . '</span>' . esc_html( $labels[ $key ] ) . '</span>';
			}
			echo '</li>';
		}
		echo '</ol>';
		if ( ! in_array( $step, $reach, true ) ) {
			$step = end( $reach );
		}
		echo '<section class="bh-card bh-step">';
		call_user_func( array( self::class, 'step_' . $step ), $network );
		echo '</section>';
	}

	/**
	 * @return string[]
	 */
	private static function reachable_steps(): array {
		$steps = array( 'consent' );
		if ( ! Settings::consent()['granted'] ) {
			return $steps;
		}
		$steps[] = 'detect';
		$steps[] = 'authorise';
		$state   = (string) Settings::connection()['state'];
		if ( ! Settings::can_call() && Connection_Status::EXPIRED !== $state ) {
			return $steps;
		}
		$steps[] = 'map';
		if ( ! Mapping::all_valid( self::site_validation() ) ) {
			return $steps;
		}
		$steps[] = 'data';
		$steps[] = 'test';
		if ( Connection_Tests::all_passed( Settings::get( 'last_tests' ) ) ) {
			$steps[] = 'done';
		}
		return $steps;
	}

	private static function step_consent( bool $network ): void {
		echo '<h2>' . esc_html__( 'Before you connect', 'branchharbor' ) . '</h2>';
		echo '<p>' . esc_html__( 'BranchHarbor is an external service. When this site is connected, it exchanges data with BranchHarbor’s servers:', 'branchharbor' ) . '</p><ul class="bh-bullets">';
		echo '<li>' . esc_html__( 'Site details: address, name, time zone, language, WordPress and plugin versions, and the compatibility scan result.', 'branchharbor' ) . '</li>';
		echo '<li>' . esc_html__( 'Enquiries submitted through BranchHarbor form blocks (name, email, phone and message as entered by the visitor).', 'branchharbor' ) . '</li>';
		echo '<li>' . esc_html__( 'If WooCommerce sync is on: product details and order totals, status and items. Customer names, emails and addresses are not sent.', 'branchharbor' ) . '</li>';
		echo '<li>' . esc_html__( 'Public content is loaded from BranchHarbor in the background: locations, class schedules, menus and pickup times.', 'branchharbor' ) . '</li>';
		echo '</ul><p>' . esc_html__( 'No analytics, tracking or advertising is added to your site. Existing customer records are not copied. You can withdraw consent and disconnect at any time in Settings.', 'branchharbor' ) . '</p>';
		echo '<p><a href="' . esc_url( 'https://branchharbor.com/legal/terms' ) . '" target="_blank" rel="noopener">' . esc_html__( 'Terms of service', 'branchharbor' ) . '</a> · <a href="' . esc_url( 'https://branchharbor.com/legal/privacy' ) . '" target="_blank" rel="noopener">' . esc_html__( 'Privacy policy', 'branchharbor' ) . '</a> · <a href="' . esc_url( 'https://branchharbor.com/legal/dpa' ) . '" target="_blank" rel="noopener">' . esc_html__( 'Data processing agreement', 'branchharbor' ) . '</a></p>';
		$consent = Settings::consent();
		if ( $consent['granted'] ) {
			/* translators: 1: user name, 2: date */
			echo '<p class="bh-ok">' . esc_html( sprintf( __( 'Agreed by %1$s on %2$s.', 'branchharbor' ), $consent['user_name'], wp_date( get_option( 'date_format' ), $consent['at'] ) ) ) . '</p>';
			echo '<p><a class="button button-primary" href="' . esc_url(
				self::url(
					array(
						'tab'  => 'connect',
						'step' => $network ? 'authorise' : 'detect',
					),
					$network
				)
			) . '">' . esc_html__( 'Continue', 'branchharbor' ) . '</a></p>';
			return;
		}
		self::form_open( 'consent', $network );
		echo '<p><label><input type="checkbox" name="bh_consent" value="1" required> ' . esc_html__( 'I agree that this site may exchange the data listed above with BranchHarbor, and I am authorised to agree on behalf of this business.', 'branchharbor' ) . '</label></p>';
		submit_button( __( 'Agree and continue', 'branchharbor' ) );
		echo '</form>';
	}

	private static function step_detect( bool $network ): void {
		echo '<h2>' . esc_html__( 'Check this site', 'branchharbor' ) . '</h2>';
		echo '<p>' . esc_html__( 'The scan runs on your server and only looks at which plugins are active. Nothing is sent, and no plugin is changed or turned off.', 'branchharbor' ) . '</p>';
		$scan = Settings::get( 'last_scan' );
		self::form_open( 'scan', $network, 'bh-inline' );
		submit_button( is_array( $scan ) ? __( 'Scan again', 'branchharbor' ) : __( 'Scan this site', 'branchharbor' ), 'secondary', 'submit', false );
		echo '</form>';
		if ( ! is_array( $scan ) ) {
			return;
		}
		self::compat_table( (array) $scan['rows'], true );
		if ( ! empty( $scan['seo'] ) ) {
			/* translators: %s: SEO plugin names */
			echo '<p class="bh-note">' . esc_html( sprintf( __( '%s will stay in charge of page titles, canonical links and sitemaps. BranchHarbor will not add its own.', 'branchharbor' ), implode( ', ', (array) $scan['seo'] ) ) ) . '</p>';
		}
		echo '<p><a class="button button-primary" href="' . esc_url(
			self::url(
				array(
					'tab'  => 'connect',
					'step' => 'authorise',
				),
				$network
			)
		) . '">' . esc_html__( 'Continue', 'branchharbor' ) . '</a></p>';
	}

	private static function step_authorise( bool $network ): void {
		$c = Settings::connection();
		echo '<h2>' . esc_html__( 'Authorise access', 'branchharbor' ) . '</h2>';
		if ( $c['network'] && ! $network ) {
			echo '<p class="bh-ok">' . esc_html__( 'Your network administrator authorised BranchHarbor for all sites. Choose this site’s location in the next step.', 'branchharbor' ) . '</p>';
			echo '<p><a class="button button-primary" href="' . esc_url(
				self::url(
					array(
						'tab'  => 'connect',
						'step' => 'map',
					)
				)
			) . '">' . esc_html__( 'Continue', 'branchharbor' ) . '</a></p>';
			return;
		}
		if ( Settings::can_call() ) {
			/* translators: %s: organisation name */
			echo '<p class="bh-ok">' . esc_html( sprintf( __( 'Connected to %s.', 'branchharbor' ), (string) ( $c['organization']['name'] ?? '' ) ) ) . '</p>';
		}
		echo '<p>' . esc_html__( 'BranchHarbor gets a site token limited to this site. Your WordPress password is never shared.', 'branchharbor' ) . '</p>';
		echo '<ul class="bh-scopes">';
		$scopes = array(
			array( true, __( 'Read site name, address and time zone', 'branchharbor' ) ),
			array( true, __( 'Send enquiries from BranchHarbor form blocks', 'branchharbor' ) ),
			array( true, __( 'Receive WooCommerce products and orders this site sends (read-only)', 'branchharbor' ) ),
			array( true, __( 'Tell this site when schedules, menus or locations change', 'branchharbor' ) ),
			array( false, __( 'Can’t create users, install plugins, edit posts or change other content', 'branchharbor' ) ),
		);
		foreach ( $scopes as $s ) {
			echo '<li class="' . ( $s[0] ? 'bh-yes' : 'bh-no' ) . '"><span class="screen-reader-text">' . esc_html( $s[0] ? __( 'Allowed:', 'branchharbor' ) : __( 'Not allowed:', 'branchharbor' ) ) . '</span>' . esc_html( $s[1] ) . '</li>';
		}
		echo '</ul>';

		echo '<div class="bh-options">';
		echo '<div class="bh-option"><h3>' . esc_html__( 'Connect with BranchHarbor', 'branchharbor' ) . '</h3><p>' . esc_html__( 'Sign in to BranchHarbor, choose your business and approve access. You’ll come straight back here.', 'branchharbor' ) . '</p>';
		self::form_open( 'authorize', $network );
		submit_button( __( 'Connect with BranchHarbor', 'branchharbor' ), 'primary', 'submit', false );
		echo '</form></div>';

		echo '<div class="bh-option"><h3>' . esc_html__( 'Paste a connection code', 'branchharbor' ) . '</h3><p>' . esc_html__( 'In BranchHarbor go to Connections → WordPress → Create code. Codes work once and expire after 15 minutes.', 'branchharbor' ) . '</p>';
		self::form_open( 'connect_code', $network );
		echo '<label class="screen-reader-text" for="bh-code">' . esc_html__( 'Connection code', 'branchharbor' ) . '</label><input id="bh-code" class="regular-text code" name="bh_code" placeholder="BHC-XXXX-XXXX-XXXX" autocomplete="off" required pattern="[Bb][Hh][Cc](-[A-Za-z0-9]{4}){3,6}"> ';
		submit_button( __( 'Connect', 'branchharbor' ), 'secondary', 'submit', false );
		echo '</form></div>';

		echo '<div class="bh-option"><h3>' . esc_html__( 'Public content only', 'branchharbor' ) . '</h3><p>' . esc_html__( 'No account link: show locations, schedules and menus and accept demo requests. Location enquiries, WooCommerce sync and instant updates need a full connection.', 'branchharbor' ) . '</p>';
		self::form_open( 'connect_public', $network );
		echo '<label for="bh-org">' . esc_html__( 'Organisation address', 'branchharbor' ) . '</label><br><code>branchharbor.com/</code><input id="bh-org" class="regular-text" name="bh_org" placeholder="stillwater-yoga" value="' . esc_attr( (string) ( $c['organization']['slug'] ?? '' ) ) . '" required> ';
		submit_button( __( 'Use public content', 'branchharbor' ), 'secondary', 'submit', false );
		echo '</form></div></div>';

		echo '<details class="bh-details"><summary>' . esc_html__( 'Optional: let BranchHarbor read WooCommerce data from this site with an Application Password', 'branchharbor' ) . '</summary>';
		echo '<ol><li>' . esc_html__( 'Create a user with the “BranchHarbor Connector” role (Users → Add New). It can only read the BranchHarbor endpoints; it cannot edit content or settings.', 'branchharbor' ) . '</li>';
		echo '<li>' . esc_html__( 'Sign in as that user and open the link below. WordPress asks you to approve an Application Password named “BranchHarbor” and sends it to BranchHarbor.', 'branchharbor' ) . '</li>';
		echo '<li>' . esc_html__( 'You can revoke it at any time under Users → Profile → Application Passwords.', 'branchharbor' ) . '</li></ol>';
		echo '<p><a href="' . esc_url( Connect::application_password_url() ) . '">' . esc_html__( 'Create an Application Password for BranchHarbor', 'branchharbor' ) . '</a></p>';
		echo '<p class="bh-muted">' . esc_html__( 'Never use an administrator’s password or Application Password for this.', 'branchharbor' ) . '</p></details>';

		if ( Settings::can_call() ) {
			echo '<p><a class="button button-primary" href="' . esc_url(
				self::url(
					array(
						'tab'  => 'connect',
						'step' => 'map',
					),
					$network
				)
			) . '">' . esc_html__( 'Continue', 'branchharbor' ) . '</a></p>';
		}
	}

	private static function step_map( bool $network ): void {
		if ( $network ) {
			self::network_mapping();
			return;
		}
		$locations = (array) Settings::connection()['locations'];
		$current   = (string) Settings::get( 'mapping' );
		$results   = self::site_validation();
		$r         = reset( $results );
		$error     = $r && 'error' === $r['status'];

		echo '<h2>' . esc_html__( 'Map this site', 'branchharbor' ) . '</h2>';
		echo '<p>' . esc_html__( 'Choose which BranchHarbor location this site represents. Enquiries go to that location and blocks default to its schedule or menu. A brand site that lists every location can map to the organisation.', 'branchharbor' ) . '</p>';
		if ( ! $locations ) {
			echo '<p class="bh-note">' . esc_html__( 'No locations were found yet. Publish a location in BranchHarbor, then reload this page.', 'branchharbor' ) . '</p>';
		}
		self::form_open( 'save_mapping', $network );
		echo '<table class="widefat bh-map"><thead><tr><th>' . esc_html__( 'Site', 'branchharbor' ) . '</th><th>' . esc_html__( 'Time zone', 'branchharbor' ) . '</th><th>' . esc_html__( 'BranchHarbor location', 'branchharbor' ) . '</th><th>' . esc_html__( 'Status', 'branchharbor' ) . '</th></tr></thead><tbody>';
		echo '<tr class="' . ( $error ? 'bh-row-error' : '' ) . '"><td>' . esc_html( get_bloginfo( 'name' ) ) . '<br><span class="bh-muted">' . esc_html( home_url( '/' ) ) . '</span></td><td>' . esc_html( wp_timezone_string() ) . '</td><td>';
		self::location_select( 'bh_mapping', 'bh-mapping', $current, $locations, $error );
		echo '</td><td>' . ( $error ? self::pill( __( 'Mapping error', 'branchharbor' ), 'error' ) : ( Mapping::TARGET_NONE === $current ? self::pill( __( 'Not connected', 'branchharbor' ), 'neutral' ) : self::pill( __( 'Matched', 'branchharbor' ), 'success' ) ) ) . '</td></tr>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- pill() escapes.
		if ( $r && ( $r['errors'] || $r['warnings'] ) ) {
			echo '<tr class="bh-row-error-detail"><td colspan="4">';
			foreach ( $r['errors'] as $e ) {
				echo '<p class="bh-error" id="bh-mapping-error">' . esc_html( $e['message'] ) . '</p>';
			}
			foreach ( $r['warnings'] as $w ) {
				echo '<p class="bh-warning">' . esc_html( $w['message'] ) . '</p>';
			}
			if ( $r['suggestions'] ) {
				echo '<p>' . esc_html__( 'Suggested:', 'branchharbor' ) . ' ';
				foreach ( $r['suggestions'] as $sid ) {
					echo '<button type="submit" class="button button-small" name="bh_mapping" value="' . esc_attr( $sid ) . '">' . esc_html( self::location_name( $sid ) ) . '</button> ';
				}
				echo '<button type="submit" class="button button-small" name="bh_mapping" value="none">' . esc_html__( 'Don’t connect this site', 'branchharbor' ) . '</button></p>';
			}
			echo '</td></tr>';
		}
		echo '</tbody></table>';
		submit_button( __( 'Save and continue', 'branchharbor' ) );
		echo '</form>';
	}

	/**
	 * @param array<int,array{id:string,name:string}> $locations
	 */
	private static function location_select( string $name, string $id, string $current, array $locations, bool $error ): void {
		echo '<label class="screen-reader-text" for="' . esc_attr( $id ) . '">' . esc_html__( 'BranchHarbor location', 'branchharbor' ) . '</label>';
		echo '<select name="' . esc_attr( $name ) . '" id="' . esc_attr( $id ) . '"' . ( $error ? ' aria-invalid="true" aria-describedby="bh-mapping-error"' : '' ) . '>';
		echo '<option value="org"' . selected( $current, 'org', false ) . '>' . esc_html__( 'Organisation (all locations)', 'branchharbor' ) . '</option>';
		$known = false;
		foreach ( $locations as $l ) {
			$known = $known || $l['id'] === $current;
			echo '<option value="' . esc_attr( $l['id'] ) . '"' . selected( $current, $l['id'], false ) . '>' . esc_html( $l['name'] . ( $l['timeZone'] ? ' — ' . $l['timeZone'] : '' ) ) . '</option>';
		}
		if ( Mapping::is_uuid( $current ) && ! $known ) {
			echo '<option value="' . esc_attr( $current ) . '" selected>' . esc_html__( 'Unknown location (removed?)', 'branchharbor' ) . '</option>';
		}
		echo '<option value="none"' . selected( $current, 'none', false ) . '>' . esc_html__( 'Don’t connect this site', 'branchharbor' ) . '</option>';
		echo '</select>';
	}

	private static function network_mapping(): void {
		$locations = (array) Settings::connection()['locations'];
		$sites     = Network::sites();
		$results   = Network::validate();
		echo '<section class="bh-card"><h2>' . esc_html__( 'Map sites to locations', 'branchharbor' ) . '</h2>';
		if ( ! Mapping::all_valid( $results ) ) {
			echo '<div class="bh-banner bh-tone-error" role="alert">' . esc_html__( 'Some sites have mapping errors. Fix them below or choose “Don’t connect this site”. Unfixed sites show no BranchHarbor content.', 'branchharbor' ) . '</div>';
		}
		self::form_open( 'save_network_mapping', true );
		echo '<table class="widefat striped bh-map"><thead><tr><th>' . esc_html__( 'Site', 'branchharbor' ) . '</th><th>' . esc_html__( 'Time zone', 'branchharbor' ) . '</th><th>' . esc_html__( 'BranchHarbor location', 'branchharbor' ) . '</th><th>' . esc_html__( 'Status', 'branchharbor' ) . '</th></tr></thead><tbody>';
		foreach ( $sites as $site ) {
			$r     = $results[ (string) $site['site_id'] ] ?? null;
			$error = $r && 'error' === $r['status'];
			echo '<tr class="' . ( $error ? 'bh-row-error' : '' ) . '"><td>' . esc_html( $site['name'] ) . '<br><span class="bh-muted">' . esc_html( $site['url'] ) . '</span></td><td>' . esc_html( $site['timezone'] ) . '</td><td>';
			self::location_select( 'bh_site[' . (int) $site['site_id'] . ']', 'bh-site-' . (int) $site['site_id'], $site['target'], $locations, $error );
			if ( $r ) {
				foreach ( $r['errors'] as $e ) {
					echo '<p class="bh-error">' . esc_html( $e['message'] ) . '</p>';
				}
				foreach ( $r['warnings'] as $w ) {
					echo '<p class="bh-warning">' . esc_html( $w['message'] ) . '</p>';
				}
				if ( $r['suggestions'] ) {
					/* translators: %s: list of location names */
					echo '<p class="bh-muted">' . esc_html( sprintf( __( 'Locations in the same time zone: %s', 'branchharbor' ), implode( ', ', array_map( array( self::class, 'location_name' ), $r['suggestions'] ) ) ) ) . '</p>';
				}
			}
			$label = ! $r ? '' : ( $error ? self::pill( __( 'Mapping error', 'branchharbor' ), 'error' ) : ( 'not_connected' === $r['status'] ? self::pill( __( 'Not connected', 'branchharbor' ), 'neutral' ) : self::pill( __( 'Matched', 'branchharbor' ), 'success' ) ) );
			echo '</td><td>' . $label . '</td></tr>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- pill() escapes.
		}
		echo '</tbody></table>';
		submit_button( __( 'Save mapping', 'branchharbor' ) );
		echo '</form></section>';
	}

	private static function step_data( bool $network ): void {
		$woo  = WooCommerce::active();
		$scan = Settings::get( 'last_scan' );
		echo '<h2>' . esc_html__( 'Choose what syncs', 'branchharbor' ) . '</h2>';
		echo '<p>' . esc_html__( 'For each kind of data, choose the direction. The system that owns a record stays its official source; BranchHarbor never overwrites WordPress content.', 'branchharbor' ) . '</p>';
		self::form_open( 'save_directions', $network );
		echo '<table class="widefat bh-dirs"><tbody>';
		foreach ( Settings::data_types() as $key => $type ) {
			if ( isset( $type['requires'] ) && 'woocommerce' === $type['requires'] && ! $woo ) {
				continue;
			}
			$current = Settings::direction( $key );
			echo '<tr><th scope="row">' . esc_html( $type['label'] ) . '<p class="bh-muted">' . esc_html( $type['note'] ) . '</p></th><td><fieldset><legend class="screen-reader-text">' . esc_html( $type['label'] ) . '</legend>';
			foreach ( $type['options'] as $opt ) {
				$later = in_array( $opt, $type['later'], true );
				echo '<label class="bh-radio' . ( $later ? ' is-disabled' : '' ) . '"><input type="radio" name="' . esc_attr( 'bh_dir_' . $key ) . '" value="' . esc_attr( $opt ) . '"' . checked( $current, $opt, false ) . disabled( $later, true, false ) . '> ' . esc_html( Settings::direction_label( $opt ) ) . ( $later ? ' <span class="bh-muted">· ' . esc_html__( 'later', 'branchharbor' ) . '</span>' : '' ) . '</label>';
			}
			echo '</fieldset></td></tr>';
		}
		$seo = is_array( $scan ) && ! empty( $scan['seo'] ) ? implode( ', ', (array) $scan['seo'] ) : __( 'WordPress / your theme', 'branchharbor' );
		echo '<tr><th scope="row">' . esc_html__( 'SEO metadata', 'branchharbor' ) . '<p class="bh-muted">' . esc_html__( 'Page titles, canonical links and sitemaps.', 'branchharbor' ) . '</p></th><td><fieldset><legend class="screen-reader-text">' . esc_html__( 'SEO metadata owner', 'branchharbor' ) . '</legend>';
		/* translators: %s: SEO plugin or "WordPress" */
		echo '<label class="bh-radio"><input type="radio" name="bh_seo_owner" value="wordpress" checked> ' . esc_html( sprintf( __( '%s owns it', 'branchharbor' ), $seo ) ) . '</label>';
		echo '<label class="bh-radio is-disabled"><input type="radio" name="bh_seo_owner" value="branchharbor" disabled> ' . esc_html__( 'BranchHarbor owns it', 'branchharbor' ) . ' <span class="bh-muted">· ' . esc_html__( 'later', 'branchharbor' ) . '</span></label>';
		echo '</fieldset></td></tr></tbody></table>';
		echo '<p class="bh-muted">' . esc_html__( 'Conflicts: when a record is edited in both places, the official source’s version is kept and the conflict is listed in Recent activity.', 'branchharbor' ) . '</p>';
		submit_button( __( 'Save and continue', 'branchharbor' ) );
		echo '</form>';
	}

	private static function step_test( bool $network ): void {
		$tests = Settings::get( 'last_tests' );
		echo '<h2>' . esc_html__( 'Test the connection', 'branchharbor' ) . '</h2>';
		echo '<p>' . esc_html__( 'Tests check each enabled feature end to end. They don’t change your content.', 'branchharbor' ) . '</p>';
		if ( is_array( $tests ) && ! empty( $tests['results'] ) ) {
			echo '<ul class="bh-tests">';
			foreach ( $tests['results'] as $r ) {
				$label = 'pass' === $r['status'] ? __( 'Passed', 'branchharbor' ) : ( 'fail' === $r['status'] ? __( 'Failed', 'branchharbor' ) : __( 'Skipped', 'branchharbor' ) );
				echo '<li class="bh-test bh-test-' . esc_attr( $r['status'] ) . '"><strong>' . esc_html( $r['name'] ) . '</strong> ' . self::pill( $label, 'pass' === $r['status'] ? 'success' : ( 'fail' === $r['status'] ? 'error' : 'neutral' ) ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- pill() escapes.
				if ( $r['message'] && $r['message'] !== $label ) {
					echo '<p class="bh-muted">' . esc_html( $r['message'] ) . '</p>';
				}
				if ( 'fail' === $r['status'] && $r['fix'] ) {
					echo '<p class="bh-fix"><strong>' . esc_html__( 'How to fix:', 'branchharbor' ) . '</strong> ' . esc_html( $r['fix'] ) . '</p>';
				}
				echo '</li>';
			}
			echo '</ul>';
		}
		self::form_open( 'run_tests', $network, 'bh-inline' );
		echo '<input type="hidden" name="bh_finish" value="1">';
		submit_button( is_array( $tests ) ? __( 'Run tests again', 'branchharbor' ) : __( 'Run tests', 'branchharbor' ), 'primary', 'submit', false );
		echo '</form>';
		if ( Connection_Tests::all_passed( $tests ) ) {
			echo ' <a class="button" href="' . esc_url(
				self::url(
					array(
						'tab'  => 'connect',
						'step' => 'done',
					),
					$network
				)
			) . '">' . esc_html__( 'Finish', 'branchharbor' ) . '</a>';
		}
	}

	private static function step_done( bool $network ): void {
		$c = Settings::connection();
		echo '<h2>' . esc_html__( 'You’re connected', 'branchharbor' ) . '</h2>';
		/* translators: 1: site name, 2: organisation name, 3: location name */
		echo '<p>' . esc_html( sprintf( __( '%1$s is linked to %2$s (%3$s).', 'branchharbor' ), get_bloginfo( 'name' ), (string) ( $c['organization']['name'] ?? '' ), self::location_name( (string) Settings::get( 'mapping' ) ) ) ) . '</p>';
		echo '<p>' . esc_html__( 'Add BranchHarbor blocks to any page, or use the shortcodes in your page builder.', 'branchharbor' ) . '</p>';
		echo '<p><a class="button button-primary" href="' . esc_url( self::url( array( 'tab' => 'blocks' ), $network ) ) . '">' . esc_html__( 'See blocks', 'branchharbor' ) . '</a> <a class="button" href="' . esc_url( self::url( array( 'tab' => 'overview' ), $network ) ) . '">' . esc_html__( 'Go to overview', 'branchharbor' ) . '</a></p>';
	}

	/* ------------------------------------------------------------------ */

	/**
	 * @param array<int,array<string,string>> $rows
	 */
	private static function compat_table( array $rows, bool $show_version ): void {
		if ( ! $rows ) {
			echo '<p class="bh-muted">' . esc_html__( 'Nothing to show.', 'branchharbor' ) . '</p>';
			return;
		}
		echo '<table class="widefat striped bh-compat"><thead><tr><th>' . esc_html__( 'System', 'branchharbor' ) . '</th><th>' . esc_html__( 'Status', 'branchharbor' ) . '</th><th>' . esc_html__( 'What works', 'branchharbor' ) . '</th><th>' . esc_html__( 'Limits and setup', 'branchharbor' ) . '</th></tr></thead><tbody>';
		foreach ( $rows as $r ) {
			echo '<tr><td><strong>' . esc_html( $r['name'] ) . '</strong>' . ( $show_version && $r['version'] ? ' <span class="bh-muted">' . esc_html( $r['version'] ) . '</span>' : '' ) . '<br><span class="bh-muted">' . esc_html( Compat::category_label( $r['category'] ) ) . '</span></td>';
			echo '<td>' . self::pill( Compat::status_label( $r['status'] ), self::status_tone( $r['status'] ) ) . '</td>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- pill() escapes.
			echo '<td>' . esc_html( $r['works'] ) . ( ! empty( $r['note'] ) ? '<p class="bh-muted">' . esc_html( $r['note'] ) . '</p>' : '' ) . '</td>';
			echo '<td>' . esc_html( $r['limits'] ) . ( ! empty( $r['action'] ) ? '<p class="bh-fix"><strong>' . esc_html__( 'Setup:', 'branchharbor' ) . '</strong> ' . esc_html( $r['action'] ) . '</p>' : '' ) . '</td></tr>';
		}
		echo '</tbody></table>';
	}

	private static function compat_tab(): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- filter only.
		$filter = isset( $_GET['status'] ) ? sanitize_key( wp_unslash( $_GET['status'] ) ) : '';
		echo '<h2>' . esc_html__( 'Compatibility', 'branchharbor' ) . '</h2>';
		echo '<p>' . esc_html__( 'Working alongside a plugin is not the same as exchanging data with it. This list names what we test and how; anything not listed has not been evaluated.', 'branchharbor' ) . '</p>';
		echo '<ul class="subsubsub">';
		$filters = array_merge( array( '' => __( 'All', 'branchharbor' ) ), array_combine( Compat::STATUSES, array_map( array( Compat::class, 'status_label' ), Compat::STATUSES ) ) );
		$i       = 0;
		foreach ( $filters as $key => $label ) {
			echo '<li><a href="' . esc_url(
				self::url(
					array_filter(
						array(
							'tab'    => 'compat',
							'status' => $key,
						)
					)
				)
			) . '"' . ( $filter === $key ? ' class="current" aria-current="page"' : '' ) . '>' . esc_html( $label ) . '</a>' . ( ++$i < count( $filters ) ? ' |' : '' ) . '</li>';
		}
		echo '</ul><br class="clear">';
		$rows = array();
		foreach ( Compat::catalogue() as $key => $entry ) {
			if ( '' !== $filter && $entry['status'] !== $filter ) {
				continue;
			}
			$rows[] = array(
				'key'      => $key,
				'name'     => $entry['name'] . ( $entry['tested'] ? ' (' . $entry['tested'][0] . ' – ' . $entry['tested'][1] . ')' : '' ),
				'category' => $entry['category'],
				'version'  => '',
				'status'   => $entry['status'],
				'works'    => $entry['works'],
				'limits'   => $entry['limits'],
				'action'   => $entry['action'],
			);
		}
		self::compat_table( $rows, false );
	}

	private static function blocks_tab(): void {
		echo '<h2>' . esc_html__( 'Blocks and shortcodes', 'branchharbor' ) . '</h2>';
		echo '<p>' . esc_html__( 'Find these blocks under “BranchHarbor” in the block inserter. In Elementor, Divi or other builders, paste a shortcode into a Shortcode, Code or Text widget. Leave “location” out to use this site’s mapped location.', 'branchharbor' ) . '</p>';
		$info = array(
			'location-finder'     => array( __( 'Location finder', 'branchharbor' ), __( 'Searchable list of your locations.', 'branchharbor' ), '[branchharbor_location_finder country="CA"]' ),
			'class-schedule'      => array( __( 'Class schedule', 'branchharbor' ), __( 'Upcoming classes with booking links (Studios).', 'branchharbor' ), '[branchharbor_class_schedule days="7"]' ),
			'book-button'         => array( __( 'Book button', 'branchharbor' ), __( 'Links to the location’s booking page.', 'branchharbor' ), '[branchharbor_book_button label="Book a class"]' ),
			'menu'                => array( __( 'Menu', 'branchharbor' ), __( 'Menu with local prices and availability (Foods).', 'branchharbor' ), '[branchharbor_menu show_prices="true"]' ),
			'pickup-order-button' => array( __( 'Pickup order button', 'branchharbor' ), __( 'Links to the location’s pickup ordering page.', 'branchharbor' ), '[branchharbor_pickup_button]' ),
			'lead-form'           => array( __( 'Enquiry / demo form', 'branchharbor' ), __( 'Sends enquiries to the right location, with duplicate prevention.', 'branchharbor' ), '[branchharbor_lead_form fields="name,email,phone,message,marketing_consent"]' ),
		);
		echo '<table class="widefat striped"><thead><tr><th>' . esc_html__( 'Block', 'branchharbor' ) . '</th><th>' . esc_html__( 'What it shows', 'branchharbor' ) . '</th><th>' . esc_html__( 'Shortcode example', 'branchharbor' ) . '</th></tr></thead><tbody>';
		foreach ( $info as $i ) {
			echo '<tr><td><strong>' . esc_html( $i[0] ) . '</strong></td><td>' . esc_html( $i[1] ) . '</td><td><code class="bh-copy" tabindex="0">' . esc_html( $i[2] ) . '</code></td></tr>';
		}
		echo '</tbody></table>';
		echo '<p class="bh-muted">' . esc_html__( 'Shortcode options: location="<location id>", days="1–14", label="…", url="…", variant="fill|outline", category="…", target="lead|demo_request", form_id="…", industry="studios|sports|wellness|commerce|foods".', 'branchharbor' ) . '</p>';
		echo '<h3>' . esc_html__( 'Locations you can use', 'branchharbor' ) . '</h3>';
		$locs = (array) Settings::connection()['locations'];
		if ( ! $locs ) {
			echo '<p class="bh-muted">' . esc_html__( 'Connect BranchHarbor to see location ids.', 'branchharbor' ) . '</p>';
			return;
		}
		echo '<table class="widefat striped"><tbody>';
		foreach ( $locs as $l ) {
			echo '<tr><td>' . esc_html( $l['name'] ) . '</td><td><code>' . esc_html( $l['id'] ) . '</code></td><td>' . esc_html( $l['timeZone'] ) . '</td></tr>';
		}
		echo '</tbody></table>';
	}

	private static function settings_tab( bool $network ): void {
		$s       = Settings::all();
		$consent = Settings::consent();
		echo '<h2>' . esc_html__( 'Settings', 'branchharbor' ) . '</h2>';
		self::form_open( 'save_settings', $network );
		echo '<table class="form-table" role="presentation"><tbody>';
		echo '<tr><th scope="row">' . esc_html__( 'Data processing consent', 'branchharbor' ) . '</th><td>';
		if ( $consent['granted'] ) {
			/* translators: 1: user name, 2: date */
			echo esc_html( sprintf( __( 'Agreed by %1$s on %2$s. Required while connected.', 'branchharbor' ), $consent['user_name'], wp_date( get_option( 'date_format' ), $consent['at'] ) ) );
		} else {
			echo esc_html__( 'Not given. Nothing is sent to BranchHarbor.', 'branchharbor' );
		}
		echo '</td></tr>';
		$toggles = array(
			'credits'   => array( __( 'Show “Powered by BranchHarbor”', 'branchharbor' ), __( 'Adds a small credit link under BranchHarbor blocks. Off by default.', 'branchharbor' ) ),
			'keep_data' => array( __( 'Keep settings if the plugin is deleted', 'branchharbor' ), __( 'Turn off to remove all BranchHarbor settings from WordPress on uninstall. Credentials and queued enquiries are always removed.', 'branchharbor' ) ),
			'debug'     => array( __( 'Debug logging', 'branchharbor' ), __( 'Writes connection events to the PHP error log when WP_DEBUG_LOG is on. Contains no customer data.', 'branchharbor' ) ),
		);
		foreach ( $toggles as $key => $t ) {
			echo '<tr><th scope="row">' . esc_html( $t[0] ) . '</th><td><label><input type="checkbox" name="' . esc_attr( 'bh_' . $key ) . '" value="1"' . checked( ! empty( $s[ $key ] ), true, false ) . '> ' . esc_html( $t[1] ) . '</label></td></tr>';
		}
		echo '</tbody></table>';
		submit_button();
		echo '</form>';
		self::settings_disconnect( $network );
	}

	private static function settings_disconnect( bool $network ): void {
		$c = Settings::connection();
		echo '<section class="bh-card bh-danger"><h2>' . esc_html__( 'Disconnect', 'branchharbor' ) . '</h2>';
		if ( Connection_Status::NOT_CONNECTED === $c['state'] || Connection_Status::DISCONNECTED === $c['state'] ) {
			echo '<p class="bh-muted">' . esc_html__( 'This site is not connected.', 'branchharbor' ) . '</p>';
		} elseif ( $c['network'] && ! $network ) {
			echo '<p class="bh-muted">' . esc_html__( 'This site uses the network connection. To stop BranchHarbor content here, map this site to “Don’t connect this site” or ask your network administrator.', 'branchharbor' ) . '</p>';
		} else {
			echo '<p>' . esc_html__( 'BranchHarbor blocks will show a short “temporarily unavailable” message. Your pages and WordPress content are untouched. Mapping and settings are kept so you can reconnect quickly.', 'branchharbor' ) . '</p>';
			self::form_open( 'disconnect', $network );
			echo '<p><label><input type="checkbox" name="bh_confirm" value="1" required> ' . esc_html__( 'I understand BranchHarbor content will stop updating on this site.', 'branchharbor' ) . '</label></p>';
			submit_button( __( 'Disconnect', 'branchharbor' ), 'delete', 'submit', false );
			echo '</form>';
		}
		if ( Settings::consent()['granted'] ) {
			echo '<hr>';
			self::form_open( 'withdraw_consent', $network );
			echo '<p>' . esc_html__( 'Withdrawing consent disconnects the site and deletes enquiries still queued on this site.', 'branchharbor' ) . '</p>';
			submit_button( __( 'Withdraw consent', 'branchharbor' ), 'secondary', 'submit', false, array( 'data-bh-confirm' => esc_attr__( 'Withdraw consent and disconnect BranchHarbor?', 'branchharbor' ) ) );
			echo '</form>';
		}
		echo '</section>';
	}
}
