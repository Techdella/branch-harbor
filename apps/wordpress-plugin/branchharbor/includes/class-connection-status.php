<?php
/**
 * Connection state model. Pure PHP: derives the label, explanation and recovery action shown in
 * the status panel from the stored connection record.
 *
 * States mirror the BranchHarbor API (connections.state): connected, initial_sync, degraded,
 * disconnected, authorization_expired — plus not_connected before the first connection.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Connection_Status {

	public const NOT_CONNECTED = 'not_connected';
	public const CONNECTED     = 'connected';
	public const INITIAL_SYNC  = 'initial_sync';
	public const DEGRADED      = 'degraded';
	public const DISCONNECTED  = 'disconnected';
	public const EXPIRED       = 'authorization_expired';

	public const STATES = array( self::NOT_CONNECTED, self::CONNECTED, self::INITIAL_SYNC, self::DEGRADED, self::DISCONNECTED, self::EXPIRED );

	/** Consecutive transport failures before the connection is reported as degraded. */
	public const DEGRADE_AFTER_FAILURES = 3;

	/**
	 * Next state after an API response. Pure state transition.
	 *
	 * @param string   $state        Current state.
	 * @param int|null $http_status  HTTP status, or null for a transport error/timeout.
	 * @param int      $failures     Consecutive failures before this response.
	 * @return array{state:string,failures:int}
	 */
	public static function after_response( string $state, ?int $http_status, int $failures ): array {
		if ( self::NOT_CONNECTED === $state || self::DISCONNECTED === $state ) {
			return array(
				'state'    => $state,
				'failures' => $failures,
			);
		}
		if ( 401 === $http_status || 403 === $http_status ) {
			return array(
				'state'    => self::EXPIRED,
				'failures' => $failures + 1,
			);
		}
		if ( null === $http_status || $http_status >= 500 || 429 === $http_status ) {
			++$failures;
			return array(
				'state'    => $failures >= self::DEGRADE_AFTER_FAILURES && self::EXPIRED !== $state ? self::DEGRADED : $state,
				'failures' => $failures,
			);
		}
		// 2xx/3xx/4xx (other than auth) mean BranchHarbor answered: transport is healthy.
		if ( $http_status < 400 ) {
			return array(
				'state'    => self::DEGRADED === $state || self::EXPIRED === $state ? self::CONNECTED : $state,
				'failures' => 0,
			);
		}
		return array(
			'state'    => $state,
			'failures' => 0,
		);
	}

	/**
	 * Presentation for the status panel.
	 *
	 * @param array{state?:string,last_success_at?:int|null,last_error?:string|null,affected_records?:int,queued_leads?:int,pending_orders?:int,sync_progress?:array{done:int,total:int}|null} $c
	 * @return array{state:string,label:string,tone:string,description:string,recovery:?string,recovery_action:?string}
	 */
	public static function describe( array $c ): array {
		$state    = in_array( $c['state'] ?? '', self::STATES, true ) ? $c['state'] : self::NOT_CONNECTED;
		$affected = (int) ( $c['affected_records'] ?? 0 ) + (int) ( $c['pending_orders'] ?? 0 );
		$queued   = (int) ( $c['queued_leads'] ?? 0 );

		switch ( $state ) {
			case self::CONNECTED:
				$label   = __( 'Connected', 'branchharbor' );
				$tone    = 'success';
				$desc    = __( 'BranchHarbor content and enquiries are up to date.', 'branchharbor' );
				$rec     = null;
				$rec_act = null;
				break;
			case self::INITIAL_SYNC:
				$label = __( 'Initial sync in progress', 'branchharbor' );
				$tone  = 'info';
				$p     = $c['sync_progress'] ?? null;
				$desc  = $p && $p['total'] > 0
					/* translators: 1: processed records, 2: total records */
					? sprintf( __( '%1$d of %2$d records processed. Blocks show live data as each location finishes.', 'branchharbor' ), (int) $p['done'], (int) $p['total'] )
					: __( 'Blocks show live data as each location finishes.', 'branchharbor' );
				$rec     = null;
				$rec_act = null;
				break;
			case self::DEGRADED:
				$label = __( 'Degraded', 'branchharbor' );
				$tone  = 'warning';
				$desc  = $affected > 0
					/* translators: %d: number of records waiting */
					? sprintf( _n( '%d record is waiting to be sent. Blocks keep showing the last good copy.', '%d records are waiting to be sent. Blocks keep showing the last good copy.', $affected, 'branchharbor' ), $affected )
					: __( 'Some requests to BranchHarbor are failing. Blocks keep showing the last good copy.', 'branchharbor' );
				$rec     = __( 'Retry now', 'branchharbor' );
				$rec_act = 'retry';
				break;
			case self::EXPIRED:
				$label   = __( 'Reconnect needed', 'branchharbor' );
				$tone    = 'error';
				$desc    = __( 'Authorisation expired or was revoked. Blocks show cached content and new enquiries are queued on this site until you reconnect.', 'branchharbor' );
				$rec     = __( 'Reconnect', 'branchharbor' );
				$rec_act = 'reconnect';
				break;
			case self::DISCONNECTED:
				$label   = __( 'Disconnected', 'branchharbor' );
				$tone    = 'neutral';
				$desc    = __( 'Blocks show a short "temporarily unavailable" message. Your pages and WordPress content are untouched.', 'branchharbor' );
				$rec     = __( 'Connect again', 'branchharbor' );
				$rec_act = 'reconnect';
				break;
			default:
				$label   = __( 'Not connected', 'branchharbor' );
				$tone    = 'neutral';
				$desc    = __( 'Nothing is sent to BranchHarbor until you connect and agree to data processing.', 'branchharbor' );
				$rec     = __( 'Connect', 'branchharbor' );
				$rec_act = 'connect';
		}
		if ( $queued > 0 ) {
			/* translators: %d: number of queued enquiries */
			$desc .= ' ' . sprintf( _n( '%d enquiry is queued on this site.', '%d enquiries are queued on this site.', $queued, 'branchharbor' ), $queued );
		}
		return array(
			'state'           => $state,
			'label'           => $label,
			'tone'            => $tone,
			'description'     => $desc,
			'recovery'        => $rec,
			'recovery_action' => $rec_act,
		);
	}

	/**
	 * Should outbound calls be attempted in this state?
	 */
	public static function can_call( string $state ): bool {
		return in_array( $state, array( self::CONNECTED, self::INITIAL_SYNC, self::DEGRADED ), true );
	}
}
