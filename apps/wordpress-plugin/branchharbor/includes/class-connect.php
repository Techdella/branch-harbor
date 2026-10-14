<?php
/**
 * Connection flows.
 *
 * 1. Authorisation redirect (recommended): the admin is sent to app.branchharbor.com, signs in,
 *    picks the organisation and approves the listed scopes. BranchHarbor redirects back with a
 *    one-time code which the plugin exchanges server-to-server (PKCE S256) for a scoped site token.
 * 2. Connection code: the admin copies a one-time code from BranchHarbor → Connections → WordPress
 *    and pastes it here; the plugin exchanges it for the same scoped site token.
 * 3. Public content only: no account link. The admin enters the organisation's public slug; only the
 *    public endpoints (locations, schedules, menus, demo requests) are used. Works with today's API.
 *
 * For BranchHarbor → WordPress calls (optional pull of WooCommerce orders), the admin may create a
 * WordPress Application Password for a dedicated low-privilege "BranchHarbor Connector" user — never
 * the admin's primary password.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Connect {

	/** Scopes requested from BranchHarbor (least privilege; see docs/API_CONTRACT.md). */
	public const SCOPES = array( 'site.read', 'locations.read', 'content.read', 'leads.write', 'commerce.export', 'webhooks.receive' );

	public const ROLE       = 'branchharbor_connector';
	public const CAPABILITY = 'branchharbor_sync';

	private const STATE_TTL = 600;

	/**
	 * Build the authorisation URL and remember state + PKCE verifier for this admin.
	 */
	public static function authorize_url( bool $network = false ): string {
		$state    = wp_generate_password( 32, false, false );
		$verifier = wp_generate_password( 64, false, false );
		set_transient(
			'branchharbor_auth_' . get_current_user_id(),
			array(
				'state'    => $state,
				'verifier' => $verifier,
				'network'  => $network,
			),
			self::STATE_TTL
		);
		$challenge = rtrim( strtr( base64_encode( hash( 'sha256', $verifier, true ) ), '+/', '-_' ), '=' ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- PKCE encoding.
		$return    = $network ? network_admin_url( 'admin-post.php?action=branchharbor_oauth_return' ) : admin_url( 'admin-post.php?action=branchharbor_oauth_return' );

		return add_query_arg(
			array(
				'client'                => 'wordpress',
				'site_url'              => rawurlencode( home_url( '/' ) ),
				'return_url'            => rawurlencode( $return ),
				'state'                 => $state,
				'code_challenge'        => $challenge,
				'code_challenge_method' => 'S256',
				'scope'                 => rawurlencode( implode( ' ', self::SCOPES ) ),
				'multisite'             => is_multisite() ? '1' : '0',
			),
			Settings::app_base() . '/connect/wordpress'
		);
	}

	/**
	 * Complete the redirect flow.
	 *
	 * @return true|\WP_Error
	 */
	public static function handle_return( string $code, string $state ) {
		$key   = 'branchharbor_auth_' . get_current_user_id();
		$saved = get_transient( $key );
		delete_transient( $key );
		if ( ! is_array( $saved ) || '' === $state || ! hash_equals( (string) $saved['state'], $state ) ) {
			return new \WP_Error( 'branchharbor_bad_state', __( 'The authorisation request expired or did not start on this site. Start again.', 'branchharbor' ) );
		}
		if ( '' === $code ) {
			return new \WP_Error( 'branchharbor_denied', __( 'Access was not approved in BranchHarbor.', 'branchharbor' ) );
		}
		return self::exchange(
			array(
				'grantType'    => 'authorization_code',
				'code'         => $code,
				'codeVerifier' => (string) $saved['verifier'],
			),
			'redirect',
			(bool) $saved['network']
		);
	}

	/**
	 * Valid connection code format: BHC- followed by 3–6 groups of 4 letters/digits.
	 */
	public static function valid_code( string $code ): bool {
		return (bool) preg_match( '/^BHC(-[A-Z0-9]{4}){3,6}$/', strtoupper( trim( $code ) ) );
	}

	/**
	 * @return true|\WP_Error
	 */
	public static function connect_with_code( string $code, bool $network = false ) {
		$code = strtoupper( trim( $code ) );
		if ( ! self::valid_code( $code ) ) {
			return new \WP_Error( 'branchharbor_bad_code', __( 'That doesn’t look like a BranchHarbor connection code. It starts with BHC- and is shown in BranchHarbor → Connections → WordPress.', 'branchharbor' ) );
		}
		return self::exchange(
			array(
				'grantType' => 'connection_code',
				'code'      => $code,
			),
			'code',
			$network
		);
	}

	/**
	 * @param array<string,string> $grant
	 * @return true|\WP_Error
	 */
	private static function exchange( array $grant, string $method, bool $network ) {
		$res = Api_Client::exchange( $grant );
		if ( is_wp_error( $res ) ) {
			if ( 'branchharbor_endpoint_unavailable' === $res->get_error_code() ) {
				return new \WP_Error( 'branchharbor_endpoint_unavailable', __( 'Account connections are not available from BranchHarbor yet. You can use "Public content only" in the meantime: location finder, schedules, menus and demo requests work without an account link.', 'branchharbor' ) );
			}
			return $res;
		}
		$data = is_array( $res['data'] ) ? $res['data'] : array();
		if ( empty( $data['siteToken'] ) || empty( $data['organization']['id'] ) ) {
			return new \WP_Error( 'branchharbor_bad_exchange', __( 'BranchHarbor returned an incomplete response. Try again.', 'branchharbor' ) );
		}
		Settings::store_credentials( $data, $method, $network );
		Activity::log( 'connected', array( 'method' => $method ) );
		Jobs::schedule_recurring();
		Jobs::enqueue( Jobs::HOOK_SYNC_SITE );
		if ( WooCommerce::active() && 'to_bh' === Settings::direction( 'woo_orders' ) ) {
			Jobs::enqueue( Jobs::HOOK_INITIAL_WOO, array( 'order', 1 ), 30 );
		}
		if ( WooCommerce::active() && 'to_bh' === Settings::direction( 'woo_products' ) ) {
			Jobs::enqueue( Jobs::HOOK_INITIAL_WOO, array( 'product', 1 ), 60 );
		}
		return true;
	}

	/**
	 * Public-content-only mode using GET /v1/public/locations/{orgSlug} (exists today).
	 *
	 * @return true|\WP_Error
	 */
	public static function connect_public( string $org_slug, bool $network = false ) {
		$org_slug = sanitize_title( $org_slug );
		if ( '' === $org_slug ) {
			return new \WP_Error( 'branchharbor_bad_slug', __( 'Enter your organisation’s BranchHarbor address, for example "stillwater-yoga".', 'branchharbor' ) );
		}
		if ( ! Settings::consent()['granted'] ) {
			return new \WP_Error( 'branchharbor_no_consent', __( 'Agree to data processing before BranchHarbor can be contacted.', 'branchharbor' ) );
		}
		$res = Api_Client::request(
			'GET',
			'/v1/public/locations/' . rawurlencode( $org_slug ),
			array(
				'auth'        => false,
				'skip_gate'   => true,
				'track_state' => false,
			)
		);
		if ( is_wp_error( $res ) ) {
			$status = (int) ( $res->get_error_data()['status'] ?? 0 );
			return 404 === $status
				? new \WP_Error( 'branchharbor_unknown_org', __( 'No BranchHarbor business uses that address.', 'branchharbor' ) )
				: $res;
		}
		$data = is_array( $res['data'] ) ? $res['data'] : array();
		Settings::update_connection(
			array(
				'state'           => Connection_Status::CONNECTED,
				'organization'    => array(
					'id'   => '',
					'slug' => $org_slug,
					'name' => sanitize_text_field( (string) ( $data['organization']['name'] ?? $org_slug ) ),
				),
				'token'           => '',
				'webhook_secret'  => '',
				'scopes'          => array(),
				'method'          => 'public',
				'connected_at'    => time(),
				'connected_by'    => get_current_user_id(),
				'last_success_at' => time(),
				'failures'        => 0,
				'last_error'      => null,
				'locations'       => Settings::clean_locations( (array) ( $data['items'] ?? array() ) ),
				'locations_at'    => time(),
			),
			$network
		);
		Activity::log( 'connected', array( 'method' => 'public' ) );
		Jobs::schedule_recurring();
		return true;
	}

	/**
	 * Disconnect: revoke the token at BranchHarbor (best effort) and forget it locally.
	 * Mapping and settings are kept; WordPress content is never touched.
	 */
	public static function disconnect( bool $network = false ): void {
		if ( Settings::has_token() ) {
			Api_Client::revoke();
		}
		Settings::clear_credentials( Connection_Status::DISCONNECTED, $network ? true : null );
		Cache::invalidate( 'locations' );
		Activity::log( 'disconnected' );
	}

	/**
	 * Refresh organisation, locations and state from BranchHarbor. Background job.
	 */
	public static function sync_site(): void {
		if ( ! Settings::can_call() ) {
			return;
		}
		$c = Settings::connection();
		if ( Settings::has_token() ) {
			$res = Api_Client::site();
			if ( ! is_wp_error( $res ) && is_array( $res['data'] ) ) {
				$d       = $res['data'];
				$changes = array(
					'locations'    => Settings::clean_locations( (array) ( $d['locations'] ?? array() ) ),
					'locations_at' => time(),
				);
				if ( isset( $d['connection']['state'] ) && in_array( $d['connection']['state'], Connection_Status::STATES, true ) ) {
					$changes['state'] = $d['connection']['state'];
				} elseif ( Connection_Status::INITIAL_SYNC === $c['state'] && ! WooCommerce::initial_sync_running() ) {
					$changes['state'] = Connection_Status::CONNECTED;
				}
				if ( isset( $d['connection']['affectedRecords'] ) ) {
					$changes['affected_records'] = max( 0, (int) $d['connection']['affectedRecords'] );
				}
				Settings::update_connection( $changes );
				return;
			}
			if ( is_wp_error( $res ) && 'branchharbor_endpoint_unavailable' !== $res->get_error_code() ) {
				return;
			}
		}
		// Fallback for public-only connections (or before the connector site endpoint ships).
		$slug = (string) ( $c['organization']['slug'] ?? '' );
		if ( '' === $slug ) {
			return;
		}
		$res = Api_Client::public_locations( $slug );
		if ( ! is_wp_error( $res ) && is_array( $res['data'] ) ) {
			$changes = array(
				'locations'       => Settings::clean_locations( (array) ( $res['data']['items'] ?? array() ) ),
				'locations_at'    => time(),
				'last_success_at' => time(),
			);
			if ( Connection_Status::INITIAL_SYNC === $c['state'] && ! WooCommerce::initial_sync_running() ) {
				$changes['state'] = Connection_Status::CONNECTED;
			}
			Settings::update_connection( $changes );
		}
	}

	/**
	 * Tell BranchHarbor about mapping, directions, SEO owner and the compatibility scan (best effort).
	 */
	public static function push_config(): void {
		if ( ! Settings::can_call() || ! Settings::has_token() ) {
			return;
		}
		$s    = Settings::all();
		$dirs = array();
		foreach ( (array) $s['directions'] as $type => $dir ) {
			$dirs[ $type ] = array(
				'direction'    => $dir,
				'apiDirection' => Settings::api_direction( (string) $dir ),
			);
		}
		Api_Client::update_site(
			array(
				'mapping'       => self::mapping_payload(),
				'directions'    => $dirs,
				'seoOwner'      => $s['seo_owner'],
				'compatibility' => is_array( $s['last_scan'] ) ? array_map(
					static fn( $r ) => array(
						'key'     => $r['key'],
						'version' => $r['version'],
						'status'  => $r['status'],
					),
					(array) ( $s['last_scan']['rows'] ?? array() )
				) : array(),
				'pluginVersion' => BRANCHHARBOR_VERSION,
			)
		);
	}

	/**
	 * @return array<int,array{siteUrl:string,blogId:int,target:string,timeZone:string}>
	 */
	public static function mapping_payload(): array {
		if ( is_multisite() && Settings::connection()['network'] ) {
			$out = array();
			foreach ( Network::sites() as $site ) {
				$out[] = array(
					'siteUrl'  => $site['url'],
					'blogId'   => (int) $site['site_id'],
					'target'   => $site['target'],
					'timeZone' => $site['timezone'],
				);
			}
			return $out;
		}
		return array(
			array(
				'siteUrl'  => home_url( '/' ),
				'blogId'   => get_current_blog_id(),
				'target'   => (string) Settings::get( 'mapping' ),
				'timeZone' => wp_timezone_string(),
			),
		);
	}

	/**
	 * Link to WordPress's own Application Password authorisation screen, pre-filled for BranchHarbor.
	 * The admin should be signed in as the dedicated BranchHarbor Connector user when following it.
	 */
	public static function application_password_url(): string {
		return add_query_arg(
			array(
				'app_name'    => rawurlencode( 'BranchHarbor' ),
				'app_id'      => '4b1f5d0e-6c43-4b8e-9c55-3f1f2d6a9b21',
				'success_url' => rawurlencode( Settings::app_base() . '/connect/wordpress/application-password' ),
			),
			admin_url( 'authorize-application.php' )
		);
	}

	/**
	 * Create the least-privilege role used with an Application Password.
	 */
	public static function add_role(): void {
		if ( ! get_role( self::ROLE ) ) {
			add_role(
				self::ROLE,
				__( 'BranchHarbor Connector', 'branchharbor' ),
				array(
					'read'           => true,
					self::CAPABILITY => true,
				)
			);
		}
	}
}
