<?php
/**
 * Option storage. All BranchHarbor data lives in a handful of prefixed options:
 *
 *   branchharbor_settings      (autoload) mapping, data directions, SEO owner, credits, debug, keep-data.
 *   branchharbor_connection    (no autoload) state, organisation, sealed site token + webhook secret, locations.
 *   branchharbor_consent       (no autoload) who agreed to external data processing, when, which version.
 *   branchharbor_lead_queue    (no autoload) enquiries waiting for delivery (deleted on delivery/expiry/uninstall).
 *   branchharbor_woo_pending   (no autoload) WooCommerce object ids waiting for export (ids only).
 *   branchharbor_activity      (no autoload) recent activity log, no customer data.
 *   branchharbor_cache_versions (autoload) cache invalidation counters.
 *   _branchharbor_evt_*        (no autoload) webhook idempotency claims.
 *
 * On Multisite, a network-level connection is stored as a site option (branchharbor_network_connection)
 * and each subsite keeps its own mapping in its own branchharbor_settings.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Settings {

	public const OPT_SETTINGS   = 'branchharbor_settings';
	public const OPT_CONNECTION = 'branchharbor_connection';
	public const OPT_CONSENT    = 'branchharbor_consent';
	public const OPT_LEADS      = 'branchharbor_lead_queue';
	public const OPT_WOO        = 'branchharbor_woo_pending';
	public const OPT_ACTIVITY   = 'branchharbor_activity';
	public const OPT_CACHE_VER  = 'branchharbor_cache_versions';
	public const OPT_NETWORK    = 'branchharbor_network_connection';

	public const CONSENT_VERSION = '2026-10';

	public const DEFAULT_API_BASE = 'https://api.branchharbor.com';
	public const DEFAULT_APP_BASE = 'https://app.branchharbor.com';

	/**
	 * Data types and the directions each one allows, from WordPress's point of view.
	 * to_bh = WordPress → BranchHarbor, from_bh = BranchHarbor → WordPress. Values listed in
	 * 'later' are shown disabled ("later") and cannot be saved.
	 *
	 * @return array<string,array{label:string,note:string,options:string[],later:string[],default:string,requires?:string}>
	 */
	public static function data_types(): array {
		return array(
			'forms'        => array(
				'label'   => __( 'Enquiry forms', 'branchharbor' ),
				'note'    => __( 'Submissions from BranchHarbor form blocks go to the matching location. Other form plugins are not affected.', 'branchharbor' ),
				'options' => array( 'to_bh', 'off' ),
				'later'   => array(),
				'default' => 'to_bh',
			),
			'locations'    => array(
				'label'   => __( 'Locations', 'branchharbor' ),
				'note'    => __( 'Names, addresses and opening hours shown by the location finder. BranchHarbor is the official record.', 'branchharbor' ),
				'options' => array( 'from_bh', 'off' ),
				'later'   => array(),
				'default' => 'from_bh',
			),
			'schedule'     => array(
				'label'   => __( 'Class schedule', 'branchharbor' ),
				'note'    => __( 'Shown on this site from BranchHarbor. Your booking provider stays the official record.', 'branchharbor' ),
				'options' => array( 'from_bh', 'off' ),
				'later'   => array(),
				'default' => 'from_bh',
			),
			'menu'         => array(
				'label'   => __( 'Menus and pickup', 'branchharbor' ),
				'note'    => __( 'Menus, prices and pickup ordering come from BranchHarbor.', 'branchharbor' ),
				'options' => array( 'from_bh', 'off' ),
				'later'   => array(),
				'default' => 'from_bh',
			),
			'woo_products' => array(
				'label'    => __( 'WooCommerce products', 'branchharbor' ),
				'note'     => __( 'WooCommerce is the official record. BranchHarbor reads products for reports. Nothing is written back.', 'branchharbor' ),
				'options'  => array( 'to_bh', 'both', 'off' ),
				'later'    => array( 'both' ),
				'default'  => 'to_bh',
				'requires' => 'woocommerce',
			),
			'woo_orders'   => array(
				'label'    => __( 'WooCommerce orders', 'branchharbor' ),
				'note'     => __( 'Order totals, status and items are read for reports. Customer names, emails and addresses are not sent.', 'branchharbor' ),
				'options'  => array( 'to_bh', 'both', 'off' ),
				'later'    => array( 'both' ),
				'default'  => 'to_bh',
				'requires' => 'woocommerce',
			),
			'customers'    => array(
				'label'   => __( 'Customer records', 'branchharbor' ),
				'note'    => __( 'Existing customer lists aren’t copied. Import with review is planned.', 'branchharbor' ),
				'options' => array( 'off', 'to_bh' ),
				'later'   => array( 'to_bh' ),
				'default' => 'off',
			),
		);
	}

	public static function direction_label( string $direction ): string {
		switch ( $direction ) {
			case 'to_bh':
				return __( 'WordPress → BranchHarbor', 'branchharbor' );
			case 'from_bh':
				return __( 'BranchHarbor → WordPress', 'branchharbor' );
			case 'both':
				return __( 'Two-way', 'branchharbor' );
			default:
				return __( 'Don’t sync', 'branchharbor' );
		}
	}

	/**
	 * Map a plugin direction to the BranchHarbor API's connection.direction (BranchHarbor's point of view).
	 */
	public static function api_direction( string $direction ): ?string {
		$map = array(
			'to_bh'   => 'import',
			'from_bh' => 'export',
			'both'    => 'bidirectional',
		);
		return $map[ $direction ] ?? null;
	}

	/**
	 * @return array<string,mixed>
	 */
	public static function defaults(): array {
		$dirs = array();
		foreach ( self::data_types() as $key => $type ) {
			$dirs[ $key ] = $type['default'];
		}
		return array(
			'mapping'    => is_multisite() ? Mapping::TARGET_NONE : Mapping::TARGET_ORG,
			'directions' => $dirs,
			'seo_owner'  => 'wordpress',
			'credits'    => false,
			'debug'      => false,
			'keep_data'  => true,
			'last_scan'  => null,
			'last_tests' => null,
			'lead_forms' => array(),
		);
	}

	/**
	 * @return array<string,mixed>
	 */
	public static function all(): array {
		$stored            = get_option( self::OPT_SETTINGS, array() );
		$all               = array_merge( self::defaults(), is_array( $stored ) ? $stored : array() );
		$all['directions'] = array_merge( self::defaults()['directions'], (array) $all['directions'] );
		return $all;
	}

	/**
	 * @param mixed $fallback
	 * @return mixed
	 */
	public static function get( string $key, $fallback = null ) {
		$all = self::all();
		return array_key_exists( $key, $all ) ? $all[ $key ] : $fallback;
	}

	/**
	 * @param array<string,mixed> $changes
	 */
	public static function update( array $changes ): void {
		update_option( self::OPT_SETTINGS, array_merge( self::all(), $changes ), true );
	}

	public static function direction( string $type ): string {
		$dirs = (array) self::get( 'directions', array() );
		return (string) ( $dirs[ $type ] ?? 'off' );
	}

	/**
	 * Validate a direction against the allowed (and not "later") options.
	 */
	public static function valid_direction( string $type, string $direction ): bool {
		$types = self::data_types();
		return isset( $types[ $type ] ) && in_array( $direction, $types[ $type ]['options'], true ) && ! in_array( $direction, $types[ $type ]['later'], true );
	}

	/* ------------------------------------------------------------------ */
	/* Consent                                                             */
	/* ------------------------------------------------------------------ */

	/**
	 * @return array{granted:bool,user_id:int,user_name:string,at:int,version:string}
	 */
	public static function consent(): array {
		$c = is_multisite() && is_network_admin() ? get_site_option( self::OPT_CONSENT, array() ) : get_option( self::OPT_CONSENT, array() );
		if ( ! is_array( $c ) ) {
			$c = array();
		}
		if ( empty( $c['granted'] ) && is_multisite() ) {
			$net = get_site_option( self::OPT_CONSENT, array() );
			if ( is_array( $net ) && ! empty( $net['granted'] ) ) {
				$c = $net;
			}
		}
		return array(
			'granted'   => ! empty( $c['granted'] ) && self::CONSENT_VERSION === ( $c['version'] ?? '' ),
			'user_id'   => (int) ( $c['user_id'] ?? 0 ),
			'user_name' => (string) ( $c['user_name'] ?? '' ),
			'at'        => (int) ( $c['at'] ?? 0 ),
			'version'   => (string) ( $c['version'] ?? '' ),
		);
	}

	public static function record_consent( bool $granted, bool $network = false ): void {
		$user  = wp_get_current_user();
		$value = array(
			'granted'   => $granted,
			'user_id'   => (int) $user->ID,
			'user_name' => (string) $user->display_name,
			'at'        => time(),
			'version'   => self::CONSENT_VERSION,
		);
		if ( $network ) {
			update_site_option( self::OPT_CONSENT, $value );
		} else {
			update_option( self::OPT_CONSENT, $value, false );
		}
		Activity::log( $granted ? 'consent_granted' : 'consent_withdrawn' );
	}

	/* ------------------------------------------------------------------ */
	/* Connection                                                          */
	/* ------------------------------------------------------------------ */

	/**
	 * @return array<string,mixed>
	 */
	public static function connection_defaults(): array {
		return array(
			'state'            => Connection_Status::NOT_CONNECTED,
			'organization'     => null,
			'site_id'          => '',
			'token'            => '',
			'webhook_secret'   => '',
			'scopes'           => array(),
			'method'           => '',
			'connected_at'     => 0,
			'connected_by'     => 0,
			'last_success_at'  => null,
			'last_error'       => null,
			'last_error_at'    => null,
			'failures'         => 0,
			'affected_records' => 0,
			'sync_progress'    => null,
			'locations'        => array(),
			'locations_at'     => 0,
			'network'          => false,
		);
	}

	/**
	 * The effective connection for this site: its own, or the network connection on Multisite.
	 *
	 * @return array<string,mixed>
	 */
	public static function connection(): array {
		if ( is_multisite() && is_network_admin() ) {
			$net = get_site_option( self::OPT_NETWORK, array() );
			return array_merge( self::connection_defaults(), is_array( $net ) ? $net : array(), array( 'network' => true ) );
		}
		$own = get_option( self::OPT_CONNECTION, array() );
		if ( is_array( $own ) && self::is_active_record( $own ) ) {
			return array_merge( self::connection_defaults(), $own );
		}
		$net = self::network_connection();
		if ( $net ) {
			return array_merge( self::connection_defaults(), $net, array( 'network' => true ) );
		}
		return array_merge( self::connection_defaults(), is_array( $own ) ? $own : array() );
	}

	/**
	 * @return array<string,mixed>|null
	 */
	public static function network_connection(): ?array {
		if ( ! is_multisite() ) {
			return null;
		}
		$net = get_site_option( self::OPT_NETWORK, array() );
		return is_array( $net ) && self::is_active_record( $net ) ? $net : null;
	}

	/**
	 * A stored connection record is in use when it holds a token or is a public-content-only link.
	 *
	 * @param array<string,mixed> $record
	 */
	private static function is_active_record( array $record ): bool {
		return ! empty( $record['token'] ) || ( 'public' === ( $record['method'] ?? '' ) && Connection_Status::DISCONNECTED !== ( $record['state'] ?? '' ) );
	}

	/**
	 * Merge changes into the connection record (own or network, whichever is effective).
	 *
	 * @param array<string,mixed> $changes
	 */
	public static function update_connection( array $changes, ?bool $network = null ): void {
		$network = $network ?? (bool) self::connection()['network'];
		if ( $network ) {
			$current = get_site_option( self::OPT_NETWORK, array() );
			update_site_option( self::OPT_NETWORK, array_merge( self::connection_defaults(), is_array( $current ) ? $current : array(), $changes, array( 'network' => true ) ) );
			return;
		}
		$current = get_option( self::OPT_CONNECTION, array() );
		update_option( self::OPT_CONNECTION, array_merge( self::connection_defaults(), is_array( $current ) ? $current : array(), $changes ), false );
	}

	public static function token(): string {
		$sealed = (string) self::connection()['token'];
		return '' === $sealed ? '' : (string) Secret::open( $sealed, Secret::site_key() );
	}

	public static function webhook_secret(): string {
		$sealed = (string) self::connection()['webhook_secret'];
		return '' === $sealed ? '' : (string) Secret::open( $sealed, Secret::site_key() );
	}

	/**
	 * Store credentials returned by the token exchange.
	 *
	 * @param array<string,mixed> $exchange Response from POST /v1/connector/wordpress/exchange.
	 */
	public static function store_credentials( array $exchange, string $method, bool $network = false ): void {
		$key = Secret::site_key();
		self::update_connection(
			array(
				'state'            => Connection_Status::INITIAL_SYNC,
				'organization'     => array(
					'id'   => sanitize_text_field( (string) ( $exchange['organization']['id'] ?? '' ) ),
					'slug' => sanitize_title( (string) ( $exchange['organization']['slug'] ?? '' ) ),
					'name' => sanitize_text_field( (string) ( $exchange['organization']['name'] ?? '' ) ),
				),
				'site_id'          => sanitize_text_field( (string) ( $exchange['siteId'] ?? '' ) ),
				'token'            => Secret::seal( (string) ( $exchange['siteToken'] ?? '' ), $key ),
				'webhook_secret'   => Secret::seal( (string) ( $exchange['webhookSecret'] ?? '' ), $key ),
				'scopes'           => array_map( 'sanitize_key', (array) ( $exchange['scopes'] ?? array() ) ),
				'method'           => $method,
				'connected_at'     => time(),
				'connected_by'     => get_current_user_id(),
				'last_error'       => null,
				'failures'         => 0,
				'affected_records' => 0,
				'locations'        => self::clean_locations( (array) ( $exchange['locations'] ?? array() ) ),
				'locations_at'     => time(),
			),
			$network
		);
	}

	/**
	 * Wipe credentials but keep mapping and settings (so reconnecting is quick).
	 */
	public static function clear_credentials( string $state = Connection_Status::DISCONNECTED, ?bool $network = null ): void {
		self::update_connection(
			array(
				'state'          => $state,
				'token'          => '',
				'webhook_secret' => '',
				'scopes'         => array(),
			),
			$network
		);
	}

	/**
	 * Normalise a location list from the API.
	 *
	 * @param array<int,mixed> $items
	 * @return array<int,array{id:string,name:string,slug:string,timeZone:string,currency:string,city:string,links:array<string,string>}>
	 */
	public static function clean_locations( array $items ): array {
		$out = array();
		foreach ( $items as $l ) {
			if ( ! is_array( $l ) || ! Mapping::is_uuid( (string) ( $l['id'] ?? '' ) ) ) {
				continue;
			}
			$links = array();
			foreach ( (array) ( $l['links'] ?? array() ) as $k => $url ) {
				$url = esc_url_raw( (string) $url, array( 'https', 'http' ) );
				if ( $url ) {
					$links[ sanitize_key( (string) $k ) ] = $url;
				}
			}
			$out[] = array(
				'id'       => strtolower( (string) $l['id'] ),
				'name'     => sanitize_text_field( (string) ( $l['name'] ?? '' ) ),
				'slug'     => sanitize_title( (string) ( $l['slug'] ?? '' ) ),
				'timeZone' => sanitize_text_field( (string) ( $l['timeZone'] ?? 'UTC' ) ),
				'currency' => strtoupper( substr( sanitize_text_field( (string) ( $l['currency'] ?? '' ) ), 0, 3 ) ),
				'city'     => sanitize_text_field( (string) ( $l['address']['city'] ?? $l['city'] ?? '' ) ),
				'links'    => $links,
			);
		}
		return $out;
	}

	/**
	 * @return array<string,mixed>|null
	 */
	public static function location( string $id ): ?array {
		foreach ( (array) self::connection()['locations'] as $l ) {
			if ( strtolower( $id ) === $l['id'] ) {
				return $l;
			}
		}
		return null;
	}

	/**
	 * The location blocks use when none is chosen: this site's mapped location.
	 */
	public static function default_location_id(): string {
		$m = (string) self::get( 'mapping', Mapping::TARGET_ORG );
		return Mapping::is_uuid( $m ) ? strtolower( $m ) : '';
	}

	/**
	 * Site timezone as IANA name or a "+HH:MM" offset.
	 */
	public static function site_timezone( ?int $blog_id = null ): string {
		if ( $blog_id && is_multisite() ) {
			$tz = (string) get_blog_option( $blog_id, 'timezone_string' );
			return '' !== $tz ? $tz : (string) get_blog_option( $blog_id, 'gmt_offset' );
		}
		return wp_timezone_string();
	}

	public static function api_base(): string {
		$base = defined( 'BRANCHHARBOR_API_URL' ) ? (string) constant( 'BRANCHHARBOR_API_URL' ) : self::DEFAULT_API_BASE;
		/** Filter the BranchHarbor API base URL (e.g. a regional endpoint or a local dev server). */
		return untrailingslashit( (string) apply_filters( 'branchharbor_api_base', $base ) );
	}

	public static function app_base(): string {
		$base = defined( 'BRANCHHARBOR_APP_URL' ) ? (string) constant( 'BRANCHHARBOR_APP_URL' ) : self::DEFAULT_APP_BASE;
		return untrailingslashit( (string) apply_filters( 'branchharbor_app_base', $base ) );
	}

	/**
	 * May the plugin make outbound calls at all (consent given and connection in a callable state)?
	 * Public-content-only connections have no token but may read public endpoints.
	 */
	public static function can_call(): bool {
		return self::consent()['granted'] && Connection_Status::can_call( (string) self::connection()['state'] );
	}

	/**
	 * Is this a full (token) connection rather than public-content-only?
	 */
	public static function has_token(): bool {
		return '' !== (string) self::connection()['token'];
	}

	public static function is_public_only(): bool {
		return 'public' === (string) self::connection()['method'];
	}
}
