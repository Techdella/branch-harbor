<?php
/**
 * Recent activity shown on the Overview tab, plus optional debug logging.
 * Entries never contain customer data (no names, emails, phone numbers or message text).
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Activity {

	private const MAX = 40;

	/**
	 * Record an event.
	 *
	 * @param string              $code    Machine code, e.g. 'schedule_refreshed'.
	 * @param array<string,mixed> $context Non-personal context (counts, location ids, HTTP status).
	 * @param string              $level   info | warning | error.
	 */
	public static function log( string $code, array $context = array(), string $level = 'info' ): void {
		$entries = get_option( Settings::OPT_ACTIVITY, array() );
		$entries = is_array( $entries ) ? $entries : array();
		array_unshift(
			$entries,
			array(
				'code'    => sanitize_key( $code ),
				'level'   => in_array( $level, array( 'info', 'warning', 'error' ), true ) ? $level : 'info',
				'context' => self::scrub( $context ),
				'at'      => time(),
			)
		);
		update_option( Settings::OPT_ACTIVITY, array_slice( $entries, 0, self::MAX ), false );

		if ( Settings::get( 'debug' ) && defined( 'WP_DEBUG_LOG' ) && WP_DEBUG_LOG ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- opt-in debug logging.
			error_log( '[BranchHarbor] ' . $level . ' ' . $code . ' ' . wp_json_encode( self::scrub( $context ) ) );
		}
	}

	/**
	 * @return array<int,array{code:string,level:string,context:array<string,mixed>,at:int}>
	 */
	public static function recent( int $limit = 10 ): array {
		$entries = get_option( Settings::OPT_ACTIVITY, array() );
		return array_slice( is_array( $entries ) ? $entries : array(), 0, $limit );
	}

	/**
	 * Human-readable message for an entry.
	 *
	 * @param array{code:string,context:array<string,mixed>} $e
	 */
	public static function message( array $e ): string {
		$c = $e['context'];
		switch ( $e['code'] ) {
			case 'consent_granted':
				return __( 'Data processing consent given', 'branchharbor' );
			case 'consent_withdrawn':
				return __( 'Data processing consent withdrawn', 'branchharbor' );
			case 'connected':
				return __( 'Site connected to BranchHarbor', 'branchharbor' );
			case 'disconnected':
				return __( 'Site disconnected from BranchHarbor', 'branchharbor' );
			case 'authorization_expired':
				return __( 'Authorisation expired or was revoked', 'branchharbor' );
			case 'webhook_received':
				/* translators: %s: event type */
				return sprintf( __( 'Update received from BranchHarbor (%s)', 'branchharbor' ), (string) ( $c['type'] ?? '' ) );
			case 'cache_refreshed':
				/* translators: %s: resource type */
				return sprintf( __( 'Refreshed %s', 'branchharbor' ), (string) ( $c['resource'] ?? '' ) );
			case 'lead_sent':
				return __( 'Enquiry sent to BranchHarbor', 'branchharbor' );
			case 'lead_queued':
				return __( 'Enquiry queued on this site; will retry', 'branchharbor' );
			case 'lead_dropped':
				/* translators: %d: number of enquiries */
				return sprintf( __( '%d queued enquiries expired after 7 days without delivery', 'branchharbor' ), (int) ( $c['count'] ?? 0 ) );
			case 'woo_exported':
				/* translators: %d: number of records */
				return sprintf( __( '%d WooCommerce records sent', 'branchharbor' ), (int) ( $c['count'] ?? 0 ) );
			case 'woo_export_failed':
				/* translators: %d: number of records */
				return sprintf( __( 'WooCommerce export failed; %d records waiting', 'branchharbor' ), (int) ( $c['count'] ?? 0 ) );
			case 'mapping_saved':
				return __( 'Location mapping saved', 'branchharbor' );
			case 'directions_saved':
				return __( 'Data directions saved', 'branchharbor' );
			case 'tests_run':
				/* translators: 1: passed tests, 2: total tests */
				return sprintf( __( 'Connection tests: %1$d of %2$d passed', 'branchharbor' ), (int) ( $c['passed'] ?? 0 ), (int) ( $c['total'] ?? 0 ) );
			case 'request_failed':
				/* translators: %s: HTTP status or error code */
				return sprintf( __( 'Request to BranchHarbor failed (%s)', 'branchharbor' ), (string) ( $c['status'] ?? '' ) );
			default:
				return (string) $e['code'];
		}
	}

	/**
	 * Drop anything that looks like personal data from a context array.
	 *
	 * @param array<string,mixed> $context
	 * @return array<string,mixed>
	 */
	private static function scrub( array $context ): array {
		$out = array();
		foreach ( $context as $k => $v ) {
			if ( in_array( $k, array( 'email', 'name', 'phone', 'message', 'contact', 'body', 'token', 'secret' ), true ) ) {
				continue;
			}
			$out[ sanitize_key( (string) $k ) ] = is_scalar( $v ) ? ( is_string( $v ) ? substr( $v, 0, 200 ) : $v ) : null;
		}
		return $out;
	}
}
