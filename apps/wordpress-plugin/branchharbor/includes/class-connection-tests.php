<?php
/**
 * "Test connection": checks that each enabled piece works end to end, and explains how to fix
 * failures (most often a cache or security plugin blocking the event route).
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Connection_Tests {

	/**
	 * @return array{at:int,results:array<int,array{key:string,name:string,status:string,message:string,fix:string}>}
	 */
	public static function run(): array {
		$results   = array();
		$results[] = self::reachable();
		$results[] = self::authorised();
		$results[] = self::mapping();
		$results[] = self::content();
		$results[] = self::events();
		if ( WooCommerce::active() ) {
			$results[] = self::woocommerce();
		}
		$out = array(
			'at'      => time(),
			'results' => $results,
		);
		Settings::update( array( 'last_tests' => $out ) );
		Activity::log(
			'tests_run',
			array(
				'passed' => count( array_filter( $results, static fn( $r ) => 'pass' === $r['status'] ) ),
				'total'  => count( array_filter( $results, static fn( $r ) => 'skip' !== $r['status'] ) ),
			)
		);
		return $out;
	}

	public static function all_passed( ?array $tests ): bool {
		if ( ! $tests || empty( $tests['results'] ) ) {
			return false;
		}
		foreach ( $tests['results'] as $r ) {
			if ( 'fail' === $r['status'] ) {
				return false;
			}
		}
		return true;
	}

	private static function result( string $key, string $name, string $status, string $message, string $fix = '' ): array {
		return array(
			'key'     => $key,
			'name'    => $name,
			'status'  => $status,
			'message' => $message,
			'fix'     => $fix,
		);
	}

	private static function reachable(): array {
		$name = __( 'BranchHarbor can be reached', 'branchharbor' );
		$res  = Api_Client::health();
		return is_wp_error( $res )
			? self::result( 'reachable', $name, 'fail', $res->get_error_message(), __( 'Your host may block outgoing HTTPS requests. Ask them to allow api.branchharbor.com.', 'branchharbor' ) )
			: self::result( 'reachable', $name, 'pass', __( 'Passed', 'branchharbor' ) );
	}

	private static function authorised(): array {
		$name = __( 'Site authorisation is valid', 'branchharbor' );
		if ( Settings::is_public_only() ) {
			return self::result( 'authorised', $name, 'skip', __( 'Public content only — no account authorisation in use.', 'branchharbor' ) );
		}
		if ( ! Settings::has_token() ) {
			return self::result( 'authorised', $name, 'fail', __( 'This site has no authorisation.', 'branchharbor' ), __( 'Reconnect from the Connect tab.', 'branchharbor' ) );
		}
		$res = Api_Client::site();
		if ( is_wp_error( $res ) ) {
			if ( 'branchharbor_endpoint_unavailable' === $res->get_error_code() ) {
				return self::result( 'authorised', $name, 'skip', __( 'BranchHarbor cannot confirm site authorisations yet.', 'branchharbor' ) );
			}
			return self::result( 'authorised', $name, 'fail', $res->get_error_message(), __( 'Reconnect from the Connect tab.', 'branchharbor' ) );
		}
		Connect::sync_site();
		return self::result( 'authorised', $name, 'pass', __( 'Passed', 'branchharbor' ) );
	}

	private static function mapping(): array {
		$name    = __( 'Sites are mapped to the right locations', 'branchharbor' );
		$results = Network::is_network_connection() ? Network::validate() : Mapping::validate(
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
		if ( Mapping::all_valid( $results ) ) {
			return self::result( 'mapping', $name, 'pass', __( 'Passed', 'branchharbor' ) );
		}
		foreach ( $results as $r ) {
			if ( $r['errors'] ) {
				return self::result( 'mapping', $name, 'fail', $r['errors'][0]['message'], __( 'Open the Map sites step and fix the highlighted site.', 'branchharbor' ) );
			}
		}
		return self::result( 'mapping', $name, 'fail', __( 'Mapping error', 'branchharbor' ) );
	}

	private static function content(): array {
		$loc = Settings::default_location_id();
		if ( $loc && 'from_bh' === Settings::direction( 'schedule' ) ) {
			$name = __( 'Class schedule loads', 'branchharbor' );
			$res  = Cache::refresh( 'schedule', $loc, array( 'days' => 7 ) );
		} elseif ( $loc && 'from_bh' === Settings::direction( 'menu' ) ) {
			$name = __( 'Menu loads', 'branchharbor' );
			$res  = Cache::refresh( 'menu', $loc );
		} else {
			$name = __( 'Locations load', 'branchharbor' );
			$slug = (string) ( Settings::connection()['organization']['slug'] ?? '' );
			if ( '' === $slug ) {
				return self::result( 'content', $name, 'skip', __( 'No organisation address is known yet.', 'branchharbor' ) );
			}
			$res = Cache::refresh( 'locations', $slug );
		}
		return null === $res
			? self::result( 'content', $name, 'fail', __( 'BranchHarbor content could not be loaded.', 'branchharbor' ), __( 'Check that the location is published in BranchHarbor, then run the tests again.', 'branchharbor' ) )
			: self::result( 'content', $name, 'pass', __( 'Passed', 'branchharbor' ) );
	}

	/**
	 * Event delivery: (1) loopback to our own webhook route to detect cache/security plugins that
	 * block or cache it; (2) with a full connection, ask BranchHarbor to send a signed ping.
	 */
	private static function events(): array {
		$name = __( 'Updates from BranchHarbor arrive', 'branchharbor' );
		$fix  = __( 'A cache or security plugin is intercepting /wp-json/branchharbor/v1/webhook. Exclude /wp-json/branchharbor/ from page caching and allow POST requests to it, then run the tests again.', 'branchharbor' );
		$url  = rest_url( Rest::NAMESPACE . '/webhook' );
		$res  = wp_remote_post(
			$url,
			array(
				'timeout'   => 5,
				'headers'   => array( 'Content-Type' => 'application/json' ),
				'body'      => '{"type":"connection.loopback"}',
				// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- core filter, same default core uses for loopbacks.
				'sslverify' => (bool) apply_filters( 'https_local_ssl_verify', false ),
			)
		);
		if ( is_wp_error( $res ) ) {
			return self::result( 'events', $name, 'fail', __( 'This site could not reach its own event address.', 'branchharbor' ), __( 'Loopback requests are blocked on this server. Check Tools → Site Health for loopback errors.', 'branchharbor' ) );
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		$body = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		// An unsigned request must be rejected by our handler with a JSON 401. Anything else means
		// something in front of WordPress answered instead.
		if ( 401 !== $code || ! is_array( $body ) || 0 !== strpos( (string) ( $body['code'] ?? '' ), 'branchharbor_' ) ) {
			/* translators: %d: HTTP status code */
			return self::result( 'events', $name, 'fail', sprintf( __( 'The event address answered with HTTP %d instead of BranchHarbor’s handler.', 'branchharbor' ), $code ), $fix );
		}
		if ( ! Settings::has_token() ) {
			return self::result( 'events', $name, 'pass', __( 'Event address is reachable. (Public content only: no events are sent.)', 'branchharbor' ) );
		}
		$before = (int) get_option( Rest::OPT_LAST_PING, 0 );
		$ping   = Api_Client::test_event();
		if ( is_wp_error( $ping ) ) {
			if ( 'branchharbor_endpoint_unavailable' === $ping->get_error_code() ) {
				return self::result( 'events', $name, 'pass', __( 'Event address is reachable. BranchHarbor test events are not available yet.', 'branchharbor' ) );
			}
			return self::result( 'events', $name, 'fail', $ping->get_error_message(), $fix );
		}
		wp_cache_delete( Rest::OPT_LAST_PING, 'options' );
		$after = (int) get_option( Rest::OPT_LAST_PING, 0 );
		$sent  = is_array( $ping['data'] ) ? ( $ping['data']['delivered'] ?? null ) : null;
		if ( $after > $before || true === $sent ) {
			return self::result( 'events', $name, 'pass', __( 'Passed', 'branchharbor' ) );
		}
		return self::result( 'events', $name, 'fail', __( 'BranchHarbor sent a test event but this site did not receive it.', 'branchharbor' ), $fix );
	}

	private static function woocommerce(): array {
		$name = __( 'WooCommerce orders can be read', 'branchharbor' );
		if ( 'to_bh' !== Settings::direction( 'woo_orders' ) && 'to_bh' !== Settings::direction( 'woo_products' ) ) {
			return self::result( 'woocommerce', $name, 'skip', __( 'WooCommerce sync is turned off.', 'branchharbor' ) );
		}
		try {
			wc_get_orders(
				array(
					'limit'  => 1,
					'return' => 'ids',
				)
			);
		} catch ( \Throwable $e ) {
			return self::result( 'woocommerce', $name, 'fail', __( 'Orders could not be read through WooCommerce.', 'branchharbor' ), __( 'Update WooCommerce, then run the tests again.', 'branchharbor' ) );
		}
		$hpos = WooCommerce::hpos_enabled();
		return self::result( 'woocommerce', $name, 'pass', true === $hpos ? __( 'Passed · high-performance order storage', 'branchharbor' ) : __( 'Passed', 'branchharbor' ) );
	}
}
