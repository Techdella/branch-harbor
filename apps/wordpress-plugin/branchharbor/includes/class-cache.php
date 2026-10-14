<?php
/**
 * Stale-while-revalidate cache for BranchHarbor content (locations, schedules, menus).
 *
 * - Entries are stored as transients with a long lifetime and carry their own freshness data.
 * - A webhook bumps a per-resource version; older entries become stale but stay renderable, so
 *   visitors keep seeing the last good copy while a background job refreshes it.
 * - Page requests never fetch synchronously: a missing entry renders a placeholder that the
 *   front-end script fills via the plugin's REST render route (or the background refresh).
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Cache {

	public const RESOURCES = array( 'locations', 'schedule', 'menu', 'pickup_slots' );

	/** Fresh lifetime before a background refresh is triggered. */
	public const FRESH_SECONDS = 300;

	/** How long a last-good copy may be shown. */
	public const KEEP_SECONDS = 7 * DAY_IN_SECONDS;

	private static function key( string $kind, string $id, array $params ): string {
		return 'branchharbor_c_' . substr( md5( $kind . '|' . strtolower( $id ) . '|' . wp_json_encode( $params ) ), 0, 24 );
	}

	private static function version( string $kind, string $id ): int {
		$versions = get_option( Settings::OPT_CACHE_VER, array() );
		return (int) ( is_array( $versions ) ? ( $versions[ $kind . ':' . strtolower( $id ) ] ?? 0 ) + ( $versions[ $kind . ':*' ] ?? 0 ) : 0 );
	}

	/**
	 * Mark a resource stale. $id '*' invalidates every id of that resource.
	 */
	public static function invalidate( string $kind, string $id = '*' ): void {
		$versions       = get_option( Settings::OPT_CACHE_VER, array() );
		$versions       = is_array( $versions ) ? $versions : array();
		$k              = $kind . ':' . strtolower( $id );
		$versions[ $k ] = (int) ( $versions[ $k ] ?? 0 ) + 1;
		update_option( Settings::OPT_CACHE_VER, $versions, true );
	}

	/**
	 * Read an entry without fetching. Schedules a background refresh when stale or missing.
	 *
	 * @param array<string,scalar> $params
	 * @return array{data:mixed,fetched_at:int,stale:bool}|null
	 */
	public static function get( string $kind, string $id, array $params = array(), bool $schedule_refresh = true ): ?array {
		$entry = get_transient( self::key( $kind, $id, $params ) );
		$stale = true;
		if ( is_array( $entry ) && isset( $entry['data'], $entry['fetched_at'] ) ) {
			$stale = ( time() - (int) $entry['fetched_at'] ) > self::FRESH_SECONDS || (int) ( $entry['v'] ?? -1 ) !== self::version( $kind, $id );
		} else {
			$entry = null;
		}
		if ( $stale && $schedule_refresh && Settings::can_call() ) {
			Jobs::enqueue( Jobs::HOOK_REFRESH, array( $kind, $id, $params ) );
		}
		return $entry ? array(
			'data'       => $entry['data'],
			'fetched_at' => (int) $entry['fetched_at'],
			'stale'      => $stale,
		) : null;
	}

	/**
	 * Fetch from BranchHarbor now and store. Used by background jobs, the editor preview and the
	 * REST render route — never during a normal front-end page render.
	 *
	 * @param array<string,scalar> $params
	 * @return array{data:mixed,fetched_at:int,stale:bool}|null
	 */
	public static function refresh( string $kind, string $id, array $params = array() ): ?array {
		if ( ! in_array( $kind, self::RESOURCES, true ) || ! Settings::can_call() ) {
			return null;
		}
		switch ( $kind ) {
			case 'locations':
				$res = Api_Client::public_locations( $id );
				break;
			case 'schedule':
				$res = Api_Client::schedule( $id, (int) ( $params['days'] ?? 7 ) );
				break;
			case 'menu':
				$res = Api_Client::menu( $id );
				break;
			default:
				$res = Api_Client::pickup_slots( $id );
		}
		if ( is_wp_error( $res ) ) {
			return null;
		}
		$entry = array(
			'data'       => $res['data'],
			'fetched_at' => time(),
			'v'          => self::version( $kind, $id ),
		);
		set_transient( self::key( $kind, $id, $params ), $entry, self::KEEP_SECONDS );
		Settings::update_connection( array( 'last_success_at' => time() ) );
		return array(
			'data'       => $entry['data'],
			'fetched_at' => $entry['fetched_at'],
			'stale'      => false,
		);
	}

	/**
	 * Get, fetching synchronously when missing (editor preview / REST render route only).
	 *
	 * @param array<string,scalar> $params
	 * @return array{data:mixed,fetched_at:int,stale:bool}|null
	 */
	public static function get_or_fetch( string $kind, string $id, array $params = array() ): ?array {
		$entry = self::get( $kind, $id, $params, false );
		if ( $entry && ! $entry['stale'] ) {
			return $entry;
		}
		return self::refresh( $kind, $id, $params ) ?? $entry;
	}
}
