<?php
/**
 * Uninstall BranchHarbor Connector.
 *
 * Always removed: site token, webhook secret, queued enquiries (personal data), pending export ids,
 * webhook idempotency rows, cached BranchHarbor content, scheduled jobs and the connector role.
 * Removed unless "Keep settings if the plugin is deleted" is on: mapping, data directions,
 * preferences, consent record and activity log.
 *
 * WordPress posts, pages and other plugins' data are never touched.
 *
 * @package BranchHarbor
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

/**
 * Clean one site (the current blog).
 */
function branchharbor_uninstall_site(): void {
	global $wpdb;

	$settings  = get_option( 'branchharbor_settings', array() );
	$keep_data = is_array( $settings ) && ! empty( $settings['keep_data'] );

	// Credentials and personal data: always removed.
	$connection = get_option( 'branchharbor_connection', array() );
	if ( is_array( $connection ) ) {
		$connection['token']          = '';
		$connection['webhook_secret'] = '';
		$connection['state']          = 'disconnected';
		update_option( 'branchharbor_connection', $connection, false );
	}
	foreach ( array( 'branchharbor_lead_queue', 'branchharbor_woo_pending', 'branchharbor_woo_initial', 'branchharbor_last_ping', 'branchharbor_cache_versions', 'branchharbor_activated' ) as $option ) {
		delete_option( $option );
	}

	// Our own rows only: idempotency claims and cached content/transients.
	$prefixes = array( '_branchharbor_evt_', '_transient_branchharbor_', '_transient_timeout_branchharbor_' );
	foreach ( $prefixes as $prefix ) {
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- one-off cleanup of this plugin's rows.
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s", $wpdb->esc_like( $prefix ) . '%' ) );
	}

	foreach ( array( 'branchharbor_refresh_resource', 'branchharbor_flush_leads', 'branchharbor_flush_woocommerce', 'branchharbor_initial_woocommerce', 'branchharbor_sync_site', 'branchharbor_hourly', 'branchharbor_daily' ) as $hook ) {
		wp_clear_scheduled_hook( $hook );
		if ( function_exists( 'as_unschedule_all_actions' ) ) {
			as_unschedule_all_actions( $hook, array(), 'branchharbor' );
		}
	}

	if ( ! $keep_data ) {
		foreach ( array( 'branchharbor_settings', 'branchharbor_connection', 'branchharbor_consent', 'branchharbor_activity' ) as $option ) {
			delete_option( $option );
		}
	}
}

if ( is_multisite() ) {
	$branchharbor_sites = get_sites(
		array(
			'fields' => 'ids',
			'number' => 0,
		)
	);
	foreach ( $branchharbor_sites as $branchharbor_site_id ) {
		switch_to_blog( (int) $branchharbor_site_id );
		branchharbor_uninstall_site();
		restore_current_blog();
	}
	$branchharbor_network = get_site_option( 'branchharbor_network_connection', array() );
	if ( is_array( $branchharbor_network ) ) {
		$branchharbor_network['token']          = '';
		$branchharbor_network['webhook_secret'] = '';
		$branchharbor_network['state']          = 'disconnected';
		update_site_option( 'branchharbor_network_connection', $branchharbor_network );
	}
	$branchharbor_main = get_blog_option( get_main_site_id(), 'branchharbor_settings', array() );
	if ( ! is_array( $branchharbor_main ) || empty( $branchharbor_main['keep_data'] ) ) {
		delete_site_option( 'branchharbor_network_connection' );
		delete_site_option( 'branchharbor_consent' );
	}
} else {
	branchharbor_uninstall_site();
}

remove_role( 'branchharbor_connector' );
