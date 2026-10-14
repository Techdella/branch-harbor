<?php
/**
 * REST routes under /wp-json/branchharbor/v1.
 *
 *   POST /webhook                 BranchHarbor → WordPress events (HMAC-signed, idempotent by event id).
 *   GET  /render/{block}          Fresh HTML for a block (front-end refresh; works behind page caches).
 *   GET  /site                    Site info for BranchHarbor (Application Password, branchharbor_sync capability).
 *   GET  /woocommerce/orders      Read-only order export page (same capability; export direction must be on).
 *   GET  /woocommerce/products    Read-only product export page (same capability; export direction must be on).
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Rest {

	public const NAMESPACE = 'branchharbor/v1';

	public const OPT_LAST_PING = 'branchharbor_last_ping';

	public static function register(): void {
		register_rest_route(
			self::NAMESPACE,
			'/webhook',
			array(
				'methods'             => 'POST',
				'callback'            => array( self::class, 'webhook' ),
				// Authenticity is established by the HMAC signature inside the callback; there is no
				// WordPress user for a server-to-server delivery.
				'permission_callback' => '__return_true',
			)
		);
		register_rest_route(
			self::NAMESPACE,
			'/render/(?P<block>[a-z-]+)',
			array(
				'methods'             => 'GET',
				'callback'            => array( self::class, 'render' ),
				'permission_callback' => '__return_true',
				'args'                => array(
					'block' => array(
						'type' => 'string',
						'enum' => array_keys( Blocks::definitions() ),
					),
				),
			)
		);
		register_rest_route(
			self::NAMESPACE,
			'/site',
			array(
				'methods'             => 'GET',
				'callback'            => array( self::class, 'site' ),
				'permission_callback' => array( self::class, 'can_sync' ),
			)
		);
		foreach ( array( 'orders', 'products' ) as $type ) {
			register_rest_route(
				self::NAMESPACE,
				'/woocommerce/' . $type,
				array(
					'methods'             => 'GET',
					'callback'            => static fn( \WP_REST_Request $r ) => self::woo_export( $r, rtrim( $type, 's' ) ),
					'permission_callback' => array( self::class, 'can_sync' ),
					'args'                => array(
						'modified_after' => array(
							'type'              => 'string',
							'format'            => 'date-time',
							'sanitize_callback' => 'sanitize_text_field',
						),
						'page'           => array(
							'type'    => 'integer',
							'minimum' => 1,
							'default' => 1,
						),
						'per_page'       => array(
							'type'    => 'integer',
							'minimum' => 1,
							'maximum' => 100,
							'default' => 50,
						),
					),
				)
			);
		}
	}

	public static function can_sync(): bool {
		return current_user_can( Connect::CAPABILITY ) || current_user_can( 'manage_options' );
	}

	/**
	 * Handle a signed event from BranchHarbor.
	 *
	 * @return \WP_REST_Response|\WP_Error
	 */
	public static function webhook( \WP_REST_Request $request ) {
		$secret = Settings::webhook_secret();
		if ( '' === $secret || ! Settings::consent()['granted'] ) {
			return new \WP_Error( 'branchharbor_not_connected', 'Not connected', array( 'status' => 401 ) );
		}
		$raw    = (string) $request->get_body();
		$result = Signature::verify( $secret, (string) $request->get_header( 'x_bh_timestamp' ), (string) $request->get_header( 'x_bh_signature' ), $raw );
		if ( true !== $result ) {
			return new \WP_Error(
				'branchharbor_bad_signature',
				'Invalid signature',
				array(
					'status' => 401,
					'reason' => $result,
				)
			);
		}
		$event = json_decode( $raw, true );
		if ( ! is_array( $event ) || empty( $event['type'] ) ) {
			return new \WP_Error( 'branchharbor_bad_event', 'Malformed event', array( 'status' => 400 ) );
		}
		$event_id = (string) $request->get_header( 'x_bh_event_id' );
		$event_id = '' !== $event_id ? $event_id : (string) ( $event['id'] ?? '' );
		if ( isset( $event['id'] ) && (string) $event['id'] !== $event_id ) {
			return new \WP_Error( 'branchharbor_bad_event', 'Event id mismatch', array( 'status' => 400 ) );
		}

		try {
			$outcome = Idempotency::wordpress()->process( $event_id, static fn() => self::handle_event( (string) $event['type'], (array) ( $event['data'] ?? array() ) ) );
		} catch ( \Throwable $e ) {
			return new \WP_Error( 'branchharbor_event_failed', 'Event processing failed', array( 'status' => 500 ) );
		}
		if ( 'invalid' === $outcome ) {
			return new \WP_Error( 'branchharbor_bad_event', 'Invalid event id', array( 'status' => 400 ) );
		}
		$response = new \WP_REST_Response(
			array(
				'received'  => true,
				'duplicate' => 'duplicate' === $outcome,
			),
			200
		);
		$response->header( 'Cache-Control', 'no-store' );
		return $response;
	}

	/**
	 * Apply an event. Only cache invalidation and connection bookkeeping — events never write
	 * WordPress posts, users or settings belonging to other plugins.
	 *
	 * @param array<string,mixed> $data
	 */
	public static function handle_event( string $type, array $data ): void {
		$location = isset( $data['locationId'] ) && Mapping::is_uuid( (string) $data['locationId'] ) ? strtolower( (string) $data['locationId'] ) : '*';

		switch ( $type ) {
			case 'schedule.updated':
				Cache::invalidate( 'schedule', $location );
				break;
			case 'menu.updated':
				Cache::invalidate( 'menu', $location );
				Cache::invalidate( 'pickup_slots', $location );
				break;
			case 'pickup_slots.updated':
				Cache::invalidate( 'pickup_slots', $location );
				break;
			case 'locations.updated':
				Cache::invalidate( 'locations' );
				Jobs::enqueue( Jobs::HOOK_SYNC_SITE );
				break;
			case 'connection.state_changed':
				$state = (string) ( $data['state'] ?? '' );
				if ( in_array( $state, Connection_Status::STATES, true ) && Connection_Status::NOT_CONNECTED !== $state ) {
					Settings::update_connection(
						array(
							'state'            => $state,
							'affected_records' => max( 0, (int) ( $data['affectedRecords'] ?? 0 ) ),
							'last_error'       => isset( $data['message'] ) ? sanitize_text_field( (string) $data['message'] ) : null,
						)
					);
				}
				break;
			case 'connection.revoked':
				Settings::clear_credentials( Connection_Status::EXPIRED );
				Activity::log( 'authorization_expired', array(), 'error' );
				break;
			case 'connection.ping':
				update_option( self::OPT_LAST_PING, time(), false );
				break;
			default:
				// Unknown types are acknowledged so BranchHarbor does not retry them forever.
				break;
		}
		if ( 'connection.ping' !== $type ) {
			Activity::log( 'webhook_received', array( 'type' => sanitize_key( str_replace( '.', '_', $type ) ) ) );
		}
		/**
		 * Fires after a BranchHarbor event was applied. Cache plugins can purge pages here.
		 *
		 * @param string $type     Event type, e.g. schedule.updated.
		 * @param string $location Location id or '*'.
		 */
		do_action( 'branchharbor_event', $type, $location );
	}

	/**
	 * Fresh block HTML for the front-end refresh script.
	 */
	public static function render( \WP_REST_Request $request ): \WP_REST_Response {
		$block = (string) $request['block'];
		$attrs = Blocks::sanitize_attributes( $block, (array) $request->get_query_params() );
		$html  = Renderer::render( $block, $attrs, true );
		$res   = new \WP_REST_Response( array( 'html' => $html ), 200 );
		$res->header( 'Cache-Control', 'public, max-age=60' );
		return $res;
	}

	public static function site(): \WP_REST_Response {
		$s = Settings::all();
		return new \WP_REST_Response(
			array(
				'url'           => home_url( '/' ),
				'name'          => get_bloginfo( 'name' ),
				'timeZone'      => wp_timezone_string(),
				'locale'        => get_locale(),
				'wpVersion'     => get_bloginfo( 'version' ),
				'pluginVersion' => BRANCHHARBOR_VERSION,
				'multisite'     => is_multisite(),
				'mapping'       => Connect::mapping_payload(),
				'directions'    => $s['directions'],
				'seoOwner'      => $s['seo_owner'],
				'woocommerce'   => WooCommerce::active() ? array(
					'version' => defined( 'WC_VERSION' ) ? WC_VERSION : null,
					'hpos'    => WooCommerce::hpos_enabled(),
				) : null,
				'compatibility' => is_array( $s['last_scan'] ) ? ( $s['last_scan']['rows'] ?? array() ) : array(),
			),
			200
		);
	}

	/**
	 * @return \WP_REST_Response|\WP_Error
	 */
	public static function woo_export( \WP_REST_Request $request, string $type ) {
		if ( ! WooCommerce::active() ) {
			return new \WP_Error( 'branchharbor_no_woocommerce', 'WooCommerce is not active', array( 'status' => 404 ) );
		}
		if ( 'to_bh' !== Settings::direction( 'order' === $type ? 'woo_orders' : 'woo_products' ) ) {
			return new \WP_Error( 'branchharbor_direction_off', 'Export of this data type is turned off on this site', array( 'status' => 403 ) );
		}
		$after = (string) $request['modified_after'];
		$page  = WooCommerce::export_page( $type, (int) $request['page'], (int) $request['per_page'], '' !== $after ? strtotime( $after ) : null );
		return new \WP_REST_Response( $page, 200 );
	}
}
