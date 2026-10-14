<?php
/**
 * Background work. Uses Action Scheduler when available (bundled with WooCommerce), otherwise
 * WP-Cron single events. Page requests only enqueue work; they never wait for BranchHarbor.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Jobs {

	public const GROUP = 'branchharbor';

	public const HOOK_REFRESH     = 'branchharbor_refresh_resource';
	public const HOOK_FLUSH_LEADS = 'branchharbor_flush_leads';
	public const HOOK_FLUSH_WOO   = 'branchharbor_flush_woocommerce';
	public const HOOK_INITIAL_WOO = 'branchharbor_initial_woocommerce';
	public const HOOK_SYNC_SITE   = 'branchharbor_sync_site';
	public const HOOK_HOURLY      = 'branchharbor_hourly';
	public const HOOK_DAILY       = 'branchharbor_daily';

	public static function register(): void {
		add_action( self::HOOK_REFRESH, array( Cache::class, 'refresh' ), 10, 3 );
		add_action( self::HOOK_FLUSH_LEADS, array( Leads::class, 'flush_queue' ) );
		add_action( self::HOOK_FLUSH_WOO, array( WooCommerce::class, 'flush' ) );
		add_action( self::HOOK_INITIAL_WOO, array( WooCommerce::class, 'initial_batch' ), 10, 2 );
		add_action( self::HOOK_SYNC_SITE, array( Connect::class, 'sync_site' ) );
		add_action( self::HOOK_HOURLY, array( self::class, 'hourly' ) );
		add_action( self::HOOK_DAILY, array( self::class, 'daily' ) );
	}

	/**
	 * Queue a one-off job (deduplicated by hook + args).
	 *
	 * @param array<int,mixed> $args
	 */
	public static function enqueue( string $hook, array $args = array(), int $delay = 0 ): void {
		if ( function_exists( 'as_enqueue_async_action' ) && function_exists( 'as_has_scheduled_action' ) && did_action( 'action_scheduler_init' ) ) {
			if ( as_has_scheduled_action( $hook, $args, self::GROUP ) ) {
				return;
			}
			if ( $delay > 0 && function_exists( 'as_schedule_single_action' ) ) {
				as_schedule_single_action( time() + $delay, $hook, $args, self::GROUP );
			} else {
				as_enqueue_async_action( $hook, $args, self::GROUP );
			}
			return;
		}
		if ( ! wp_next_scheduled( $hook, $args ) ) {
			wp_schedule_single_event( time() + max( 0, $delay ), $hook, $args );
		}
	}

	public static function schedule_recurring(): void {
		if ( ! wp_next_scheduled( self::HOOK_HOURLY ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'hourly', self::HOOK_HOURLY );
		}
		if ( ! wp_next_scheduled( self::HOOK_DAILY ) ) {
			wp_schedule_event( time() + DAY_IN_SECONDS, 'daily', self::HOOK_DAILY );
		}
	}

	public static function unschedule_all(): void {
		foreach ( array( self::HOOK_REFRESH, self::HOOK_FLUSH_LEADS, self::HOOK_FLUSH_WOO, self::HOOK_INITIAL_WOO, self::HOOK_SYNC_SITE, self::HOOK_HOURLY, self::HOOK_DAILY ) as $hook ) {
			wp_clear_scheduled_hook( $hook );
			if ( function_exists( 'as_unschedule_all_actions' ) ) {
				as_unschedule_all_actions( $hook, array(), self::GROUP );
			}
		}
	}

	/**
	 * Hourly: retry queued enquiries and pending WooCommerce exports, refresh the location list.
	 */
	public static function hourly(): void {
		if ( ! Settings::can_call() ) {
			return;
		}
		Leads::flush_queue();
		WooCommerce::flush();
		Connect::sync_site();
	}

	/**
	 * Daily: prune webhook idempotency rows.
	 */
	public static function daily(): void {
		Idempotency::prune();
	}
}
