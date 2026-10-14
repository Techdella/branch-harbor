<?php
/**
 * Idempotency for inbound webhook events.
 *
 * The decision logic is pure and operates on a storage adapter so it can be tested without
 * WordPress. In production the adapter claims an event with add_option(), which is atomic
 * thanks to the unique option_name index: two concurrent deliveries of the same event cannot
 * both succeed in claiming it.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Idempotency {

	public const TTL           = 604800; // 7 days.
	public const OPTION_PREFIX = '_branchharbor_evt_';

	/** @var callable(string,int):bool Atomically claim key with expiry; false if it already exists. */
	private $claim;

	/** @var callable(string):void Release a claim (used when processing fails so the sender may retry). */
	private $release;

	public function __construct( callable $claim, callable $release ) {
		$this->claim   = $claim;
		$this->release = $release;
	}

	/**
	 * Validate an event id from a sender. Accepts 1–128 chars of [A-Za-z0-9_.:-].
	 */
	public static function valid_event_id( string $event_id ): bool {
		return (bool) preg_match( '/^[A-Za-z0-9_.:\-]{1,128}$/', $event_id );
	}

	/**
	 * Storage key for an event (fixed length, safe for option names).
	 */
	public static function key( string $event_id ): string {
		return self::OPTION_PREFIX . substr( hash( 'sha256', $event_id ), 0, 40 );
	}

	/**
	 * Process an event at most once.
	 *
	 * @param string   $event_id Sender-provided event id.
	 * @param callable $handler  Does the work; throwing releases the claim so a retry can process it.
	 * @return string 'processed' | 'duplicate' | 'invalid'
	 * @throws \Throwable When the handler fails (claim is released first).
	 */
	public function process( string $event_id, callable $handler, ?int $now = null ): string {
		if ( ! self::valid_event_id( $event_id ) ) {
			return 'invalid';
		}
		$key = self::key( $event_id );
		if ( ! ( $this->claim )( $key, ( $now ?? time() ) + self::TTL ) ) {
			return 'duplicate';
		}
		try {
			$handler();
		} catch ( \Throwable $e ) {
			( $this->release )( $key );
			throw $e;
		}
		return 'processed';
	}

	/**
	 * In-memory adapter (tests, and a fallback if options are unavailable).
	 *
	 * @param array<string,int> $store Store passed by reference.
	 */
	public static function in_memory( array &$store ): self {
		return new self(
			static function ( string $key, int $expires ) use ( &$store ): bool {
				if ( isset( $store[ $key ] ) && $store[ $key ] > time() ) {
					return false;
				}
				$store[ $key ] = $expires;
				return true;
			},
			static function ( string $key ) use ( &$store ): void {
				unset( $store[ $key ] );
			}
		);
	}

	/**
	 * WordPress options adapter.
	 */
	public static function wordpress(): self {
		return new self(
			static function ( string $key, int $expires ): bool {
				// add_option() fails if the row exists. Expired rows are pruned by cron; if a stale row
				// survives we treat it as expired and replace it.
				if ( add_option( $key, $expires, '', false ) ) {
					return true;
				}
				$existing = (int) get_option( $key, 0 );
				if ( $existing && $existing < time() ) {
					delete_option( $key );
					return add_option( $key, $expires, '', false );
				}
				return false;
			},
			static function ( string $key ): void {
				delete_option( $key );
			}
		);
	}

	/**
	 * Delete expired event claims. Runs from the daily cron.
	 */
	public static function prune(): int {
		global $wpdb;
		$like = $wpdb->esc_like( self::OPTION_PREFIX ) . '%';
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- bulk prune of our own rows.
		$rows    = $wpdb->get_results( $wpdb->prepare( "SELECT option_name, option_value FROM {$wpdb->options} WHERE option_name LIKE %s LIMIT 1000", $like ) );
		$removed = 0;
		foreach ( (array) $rows as $row ) {
			if ( (int) $row->option_value < time() ) {
				delete_option( $row->option_name );
				++$removed;
			}
		}
		return $removed;
	}
}
