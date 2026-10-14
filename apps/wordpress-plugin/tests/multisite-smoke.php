<?php
/**
 * Multisite smoke test (network authorisation + per-site mapping + mapping error/fix flow).
 * Run on a disposable, network-activated Multisite with subsites whose time zones differ:
 *
 *   wp eval-file tests/multisite-smoke.php --url=<network url>
 *
 * Expects blog 2 in America/Vancouver and blog 3 in America/Toronto.
 *
 * @package BranchHarbor
 */

// phpcs:disable -- test script.

use BranchHarbor\Admin;
use BranchHarbor\Connect;
use BranchHarbor\Mapping;
use BranchHarbor\Network;
use BranchHarbor\Renderer;
use BranchHarbor\Settings;

$pass = 0;
$fail = array();
$ok   = function ( string $name, bool $cond ) use ( &$pass, &$fail ) {
	$cond ? $pass++ : $fail[] = $name;
	WP_CLI::log( ( $cond ? "  \u{2713} " : "  \u{2717} " ) . $name );
};

const QW = '11111111-1111-4111-8111-111111111111';
const KT = '33333333-3333-4333-8333-333333333333';

delete_site_option( 'branchharbor_network_connection' );
delete_site_option( 'branchharbor_consent' );
foreach ( array( 1, 2, 3 ) as $b ) {
	switch_to_blog( $b );
	delete_option( 'branchharbor_settings' );
	delete_option( 'branchharbor_connection' );
	delete_option( 'branchharbor_consent' );
	restore_current_blog();
}
wp_set_current_user( 1 );

add_filter(
	'pre_http_request',
	function ( $pre, $args, $url ) {
		if ( false !== $pre || false === strpos( $url, 'api.branchharbor.com' ) ) {
			return $pre;
		}
		$path = wp_parse_url( $url, PHP_URL_PATH );
		$json = fn( $code, $body ) => array( 'response' => array( 'code' => $code, 'message' => '' ), 'body' => wp_json_encode( $body ), 'headers' => array(), 'cookies' => array() );
		$locs = array(
			array( 'id' => QW, 'name' => 'Toronto – Queen West', 'timeZone' => 'America/Toronto', 'links' => array() ),
			array( 'id' => KT, 'name' => 'Vancouver – Kitsilano', 'timeZone' => 'America/Vancouver', 'links' => array() ),
		);
		if ( '/v1/connector/wordpress/exchange' === $path ) {
			return $json( 200, array( 'siteId' => 'net_1', 'siteToken' => 'bhst_net', 'webhookSecret' => 'whsec_net', 'organization' => array( 'id' => '99999999-9999-4999-8999-999999999999', 'slug' => 'stillwater', 'name' => 'Stillwater Yoga Collective' ), 'locations' => $locs ) );
		}
		if ( '/v1/public/studios/' . KT . '/schedule' === $path ) {
			return $json( 200, array( 'location' => array( 'timeZone' => 'America/Vancouver' ), 'items' => array( array( 'id' => 'o1', 'classType' => array( 'name' => 'Kits Flow' ), 'startsAt' => gmdate( 'Y-m-d\TH:i:s\Z', time() + DAY_IN_SECONDS ), 'status' => 'available', 'spotsLeft' => 3, 'action' => 'book' ) ) ) );
		}
		return $json( 404, array( 'error' => array( 'code' => 'not_found', 'message' => 'Route ' . $args['method'] . ' ' . $path . ' not found' ) ) );
	},
	10,
	3
);

WP_CLI::log( 'Network authorisation' );
$ok( 'plugin is network-active', Network::is_network_active() );
Settings::record_consent( true, true );
$ok( 'network consent stored as site option', ! empty( get_site_option( 'branchharbor_consent' )['granted'] ) );
$ok( 'network connect with code', true === Connect::connect_with_code( 'BHC-ABCD-EFGH-JKLM', true ) );
$ok( 'token stored at network level only', ! empty( get_site_option( 'branchharbor_network_connection' )['token'] ) && false === get_option( 'branchharbor_connection' ) );

WP_CLI::log( 'Subsites inherit authorisation, not mapping' );
switch_to_blog( 2 );
$ok( 'subsite sees the network connection', true === Settings::connection()['network'] && Settings::can_call() );
$ok( 'subsite is not connected to a location until chosen', Mapping::TARGET_NONE === Settings::get( 'mapping' ) );
$ok( 'subsite blocks show nothing location-specific yet', '' === Settings::default_location_id() );
restore_current_blog();

WP_CLI::log( 'Mapping error and fix flow (prototype scenario 3)' );
Network::set_target( 2, QW ); // Pacific subsite → Eastern location.
Network::set_target( 3, QW );
$v = Network::validate();
$ok( 'Kitsilano subsite mapped to Toronto → mapping error', 'error' === $v['2']['status'] && 'timezone_mismatch' === $v['2']['errors'][0]['code'] );
$ok( 'fix suggestion is Vancouver – Kitsilano', array( KT ) === $v['2']['suggestions'] );
$ok( 'Queen West subsite matched (duplicate warning only)', 'matched' === $v['3']['status'] );
$ok( 'main site defaults to not connected', 'not_connected' === $v['1']['status'] );

set_current_screen( 'settings_page_branchharbor-network' );
ob_start();
Admin::network_page();
$html = ob_get_clean();
$ok( 'network page shows the mapping error banner', false !== strpos( $html, 'Some sites have mapping errors' ) );
$ok( 'network page lists every subsite', false !== strpos( $html, 'bh_site[2]' ) && false !== strpos( $html, 'bh_site[3]' ) );

Network::set_target( 2, KT );
$ok( 'after fix all sites valid', Mapping::all_valid( Network::validate() ) );
ob_start();
Admin::network_page();
$html = ob_get_clean();
$ok( 'banner gone after fix', false === strpos( $html, 'Some sites have mapping errors' ) );
$GLOBALS['current_screen'] = null;

switch_to_blog( 2 );
$out = Renderer::render( 'class-schedule', \BranchHarbor\Blocks::sanitize_attributes( 'class-schedule', array() ), true );
$ok( 'subsite schedule uses its own mapped location', false !== strpos( $out, 'Kits Flow' ) );
restore_current_blog();

WP_CLI::log( 'New subsites' );
$new = wpmu_create_blog( 'localhost:8898', '/new-' . wp_rand() . '/', 'New', 1 );
$ok( 'new subsite starts as "Don’t connect this site"', ! is_wp_error( $new ) && Mapping::TARGET_NONE === get_blog_option( $new, 'branchharbor_settings' )['mapping'] );
if ( ! is_wp_error( $new ) ) {
	wp_delete_site( $new );
}

WP_CLI::log( '' );
WP_CLI::log( "$pass passed, " . count( $fail ) . ' failed' );
$fail ? WP_CLI::error( "Failures:\n - " . implode( "\n - ", $fail ) ) : WP_CLI::success( 'Multisite smoke test passed.' );
