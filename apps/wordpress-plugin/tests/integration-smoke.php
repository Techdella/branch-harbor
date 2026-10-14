<?php
/**
 * Integration smoke test against a real WordPress install, with the BranchHarbor API mocked via
 * the pre_http_request filter. Run with WP-CLI from a disposable site:
 *
 *   wp eval-file tests/integration-smoke.php
 *
 * Requires the plugin to be active. Do NOT run against a production site: it connects, writes
 * options and resets them at the end.
 *
 * @package BranchHarbor
 */

// phpcs:disable -- test script.

use BranchHarbor\Admin;
use BranchHarbor\Api_Client;
use BranchHarbor\Cache;
use BranchHarbor\Connect;
use BranchHarbor\Connection_Status;
use BranchHarbor\Connection_Tests;
use BranchHarbor\Detector;
use BranchHarbor\Leads;
use BranchHarbor\Mapping;
use BranchHarbor\Renderer;
use BranchHarbor\Rest;
use BranchHarbor\Settings;
use BranchHarbor\Signature;
use BranchHarbor\WooCommerce;

$pass = 0;
$fail = array();
$ok   = function ( string $name, bool $cond ) use ( &$pass, &$fail ) {
	if ( $cond ) {
		$pass++;
		WP_CLI::log( "  \u{2713} $name" );
	} else {
		$fail[] = $name;
		WP_CLI::log( "  \u{2717} $name" );
	}
};

// Start clean.
foreach ( array( 'branchharbor_connection', 'branchharbor_consent', 'branchharbor_lead_queue', 'branchharbor_woo_pending', 'branchharbor_activity' ) as $o ) {
	delete_option( $o );
}
Settings::update( Settings::defaults() );
delete_option( 'branchharbor_cache_versions' );
global $wpdb;
$wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '\_transient\_%branchharbor\_%' OR option_name LIKE '\_branchharbor\_evt\_%'" );
wp_cache_flush();
wp_set_current_user( 1 );

const QW = '11111111-1111-4111-8111-111111111111';
const KT = '33333333-3333-4333-8333-333333333333';

$calls = array();
$mode  = array( 'lead' => 'route_missing' );
add_filter(
	'pre_http_request',
	function ( $pre, $args, $url ) use ( &$calls, &$mode ) {
		if ( false !== $pre || false === strpos( $url, 'api.branchharbor.com' ) ) {
			return $pre;
		}
		$path    = wp_parse_url( $url, PHP_URL_PATH );
		$calls[] = array( $args['method'], $path, $args );
		$json    = function ( $code, $body ) {
			return array( 'response' => array( 'code' => $code, 'message' => '' ), 'body' => wp_json_encode( $body ), 'headers' => array(), 'cookies' => array() );
		};
		$locs = array(
			array( 'id' => QW, 'name' => 'Toronto – Queen West', 'slug' => 'queen-west', 'timeZone' => 'America/Toronto', 'currency' => 'CAD', 'address' => array( 'line1' => '1 Queen St W', 'city' => 'Toronto' ), 'links' => array( 'booking' => 'https://book.branchharbor.com/l/queen-west' ) ),
			array( 'id' => KT, 'name' => 'Vancouver – Kitsilano', 'slug' => 'kitsilano', 'timeZone' => 'America/Vancouver', 'currency' => 'CAD', 'address' => array( 'line1' => '2 W 4th Ave', 'city' => 'Vancouver' ), 'links' => array( 'booking' => 'https://book.branchharbor.com/l/kitsilano', 'order' => 'https://order.branchharbor.com/l/kitsilano' ) ),
		);
		switch ( $path ) {
			case '/health':
				return $json( 200, array( 'status' => 'ok' ) );
			case '/v1/connector/wordpress/exchange':
				$b = json_decode( $args['body'], true );
				return 'BHC-ABCD-EFGH-JKLM' === $b['code']
					? $json( 200, array( 'siteId' => 'site_1', 'siteToken' => 'bhst_secret_token', 'webhookSecret' => 'whsec_abc', 'scopes' => array( 'site.read', 'leads.write' ), 'organization' => array( 'id' => '99999999-9999-4999-8999-999999999999', 'slug' => 'stillwater', 'name' => 'Stillwater Yoga Collective' ), 'locations' => $locs ) )
					: $json( 400, array( 'error' => array( 'code' => 'invalid_code', 'message' => 'Code expired' ) ) );
			case '/v1/connector/wordpress/site':
				return 'GET' === $args['method'] ? $json( 200, array( 'locations' => $locs, 'connection' => array( 'state' => 'connected' ) ) ) : $json( 200, array( 'ok' => true ) );
			case '/v1/public/studios/' . KT . '/schedule':
				return $json( 200, array( 'location' => array( 'id' => KT, 'name' => 'Kitsilano', 'timeZone' => 'America/Vancouver' ), 'items' => array(
					array( 'id' => 'occ1', 'classType' => array( 'name' => 'Morning Vinyasa' ), 'startsAt' => gmdate( 'Y-m-d', time() + DAY_IN_SECONDS ) . 'T14:00:00.000Z', 'instructorName' => 'Maya Rao', 'spotsLeft' => 4, 'status' => 'available', 'action' => 'book' ),
					array( 'id' => 'occ2', 'classType' => array( 'name' => 'Slow <Flow>' ), 'startsAt' => gmdate( 'Y-m-d', time() + DAY_IN_SECONDS ) . 'T16:00:00.000Z', 'instructorName' => 'Sam Tran', 'spotsLeft' => 0, 'status' => 'full', 'action' => 'join_waitlist' ),
				) ) );
			case '/v1/public/foods/' . KT . '/menu':
				return $json( 200, array( 'location' => array( 'currency' => 'CAD' ), 'categories' => array( array( 'name' => 'Bowls', 'items' => array( array( 'name' => 'Poke', 'available' => true, 'price' => array( 'amount' => 1450, 'currency' => 'CAD' ), 'dietary' => array( 'GF' ) ) ) ) ) ) );
			case '/v1/connector/wordpress/leads':
				return 'ok' === $mode['lead'] ? $json( 201, array( 'id' => 'lead_1' ) ) : $json( 404, array( 'error' => array( 'code' => 'not_found', 'message' => 'Route POST /v1/connector/wordpress/leads not found' ) ) );
			case '/v1/connector/wordpress/events':
				return $json( 202, array( 'accepted' => true ) );
			case '/v1/connector/wordpress/test-event':
				// Simulate BranchHarbor delivering a signed ping to the site before answering.
				$body = wp_json_encode( array( 'id' => 'evt_ping_' . wp_rand(), 'type' => 'connection.ping', 'data' => array() ) );
				$ts   = time();
				wp_remote_post( rest_url( 'branchharbor/v1/webhook' ), array( 'headers' => array( 'Content-Type' => 'application/json', 'X-BH-Timestamp' => (string) $ts, 'X-BH-Signature' => Signature::header( 'whsec_abc', $ts, $body ) ), 'body' => $body, 'timeout' => 10 ) );
				return $json( 200, array( 'delivered' => true ) );
			case '/v1/connector/wordpress/site/revoke':
			default:
				if ( 'DELETE' === $args['method'] ) {
					return $json( 204, array() );
				}
				return $json( 404, array( 'error' => array( 'code' => 'not_found', 'message' => 'Route ' . $args['method'] . ' ' . $path . ' not found' ) ) );
		}
	},
	10,
	3
);

$capture_redirect = function () {
	add_filter( 'wp_redirect', function ( $loc ) { throw new RuntimeException( 'REDIRECT:' . $loc ); }, -100 );
};

WP_CLI::log( 'Consent gate' );
$html = Renderer::render( 'class-schedule', array( 'locationId' => '', 'days' => 7, 'showInstructor' => true, 'showSpots' => true ), true );
$ok( 'blocks show "temporarily unavailable" before connecting', false !== strpos( $html, 'temporarily unavailable' ) );
$r = Api_Client::health();
$ok( 'no request without consent (even health, via gate)', 0 === count( $calls ) );
$r = Connect::connect_with_code( 'BHC-ABCD-EFGH-JKLM' );
$ok( 'connect refused without consent', is_wp_error( $r ) && 'branchharbor_no_consent' === $r->get_error_code() );
$ok( 'still zero external calls', 0 === count( $calls ) );

WP_CLI::log( 'Detect' );
$scan = Detector::scan();
$keys = array_column( $scan['rows'], 'key' );
$ok( 'scan detects block editor', in_array( 'block_editor', $keys, true ) );
$ok( 'scan makes no external calls', 0 === count( $calls ) );

WP_CLI::log( 'Connect' );
Settings::record_consent( true );
$ok( 'consent recorded with version', Settings::consent()['granted'] && Settings::CONSENT_VERSION === Settings::consent()['version'] );
$bad = Connect::connect_with_code( 'nonsense' );
$ok( 'malformed code rejected locally', is_wp_error( $bad ) && 0 === count( $calls ) );
$exp = Connect::connect_with_code( 'BHC-ZZZZ-ZZZZ-ZZZZ' );
$ok( 'expired code shows API message', is_wp_error( $exp ) && 'Code expired' === $exp->get_error_message() );
$res = Connect::connect_with_code( 'bhc-abcd-efgh-jklm' );
$ok( 'valid code connects', true === $res );
$raw = get_option( 'branchharbor_connection' );
$ok( 'token stored sealed (not plaintext)', false === strpos( wp_json_encode( $raw ), 'bhst_secret_token' ) );
$ok( 'token readable via Settings::token()', 'bhst_secret_token' === Settings::token() );
$ok( 'state is initial_sync after connect', Connection_Status::INITIAL_SYNC === Settings::connection()['state'] );
$ok( 'locations stored', 2 === count( Settings::connection()['locations'] ) );
$exchange = array_values( array_filter( $calls, fn( $c ) => '/v1/connector/wordpress/exchange' === $c[1] ) );
$sent     = json_decode( $exchange[1][2]['body'], true );
$ok( 'exchange sends site + webhook URL + scopes', isset( $sent['site']['webhookUrl'], $sent['scopes'] ) && 'connection_code' === $sent['grantType'] );
$ok( 'exchange uses timeout', $exchange[1][2]['timeout'] <= 15 );
Connect::sync_site();
$ok( 'sync_site moves state to connected', Connection_Status::CONNECTED === Settings::connection()['state'] );
$auth_url = Connect::authorize_url();
$ok( 'authorise URL uses PKCE S256 + state', false !== strpos( $auth_url, 'code_challenge_method=S256' ) && false !== strpos( $auth_url, 'state=' ) && 0 === strpos( $auth_url, 'https://app.branchharbor.com/connect/wordpress' ) );
$ok( 'redirect return rejects wrong state', is_wp_error( Connect::handle_return( 'code', 'wrong' ) ) );

WP_CLI::log( 'Mapping (site timezone America/Vancouver)' );
Settings::update( array( 'mapping' => QW ) );
$v = Mapping::validate( array( array( 'site_id' => 1, 'name' => 'x', 'timezone' => wp_timezone_string(), 'target' => QW ) ), Settings::connection()['locations'] );
$ok( 'Toronto location on a Pacific site → mapping error', 'error' === $v['1']['status'] && array( KT ) === $v['1']['suggestions'] );
$t = Connection_Tests::run();
$mapping_result = array_values( array_filter( $t['results'], fn( $r ) => 'mapping' === $r['key'] ) )[0];
$ok( 'connection test flags mapping error', 'fail' === $mapping_result['status'] );
Settings::update( array( 'mapping' => KT ) );
$ok( 'fixed mapping becomes default block location', KT === Settings::default_location_id() );

WP_CLI::log( 'Tests' );
$t = Connection_Tests::run();
foreach ( $t['results'] as $r ) {
	WP_CLI::log( "      {$r['key']}: {$r['status']} — {$r['message']}" );
}
$ok( 'all connection tests pass (loopback + signed ping included)', Connection_Tests::all_passed( $t ) );

WP_CLI::log( 'Webhooks' );
$send = function ( array $event, string $secret = 'whsec_abc', ?int $ts = null ) {
	$body = wp_json_encode( $event );
	$ts   = $ts ?? time();
	$req  = new WP_REST_Request( 'POST', '/branchharbor/v1/webhook' );
	$req->set_body( $body );
	$req->set_header( 'content-type', 'application/json' );
	$req->set_header( 'x-bh-timestamp', (string) $ts );
	$req->set_header( 'x-bh-signature', Signature::header( $secret, $ts, $body ) );
	$req->set_header( 'x-bh-event-id', $event['id'] );
	return rest_do_request( $req );
};
$evt = array( 'id' => 'evt_' . wp_rand(), 'type' => 'schedule.updated', 'data' => array( 'locationId' => KT ) );
Cache::refresh( 'schedule', KT, array( 'days' => 7 ) );
$ok( 'schedule cached and fresh', false === Cache::get( 'schedule', KT, array( 'days' => 7 ), false )['stale'] );
$r1 = $send( $evt );
$ok( 'signed event accepted', 200 === $r1->get_status() && false === $r1->get_data()['duplicate'] );
$ok( 'event invalidates the schedule cache (stale but still renderable)', true === Cache::get( 'schedule', KT, array( 'days' => 7 ), false )['stale'] );
$r2 = $send( $evt );
$ok( 'duplicate event acknowledged once', 200 === $r2->get_status() && true === $r2->get_data()['duplicate'] );
$r3 = $send( array( 'id' => 'evt_x', 'type' => 'schedule.updated' ), 'wrong_secret' );
$ok( 'bad signature → 401', 401 === $r3->get_status() );
$r4 = $send( array( 'id' => 'evt_old', 'type' => 'schedule.updated' ), 'whsec_abc', time() - 3600 );
$ok( 'stale timestamp → 401', 401 === $r4->get_status() );

WP_CLI::log( 'Blocks' );
$sched = Renderer::render( 'class-schedule', \BranchHarbor\Blocks::sanitize_attributes( 'class-schedule', array() ), false );
$ok( 'schedule renders from cache on a page request', false !== strpos( $sched, 'Morning Vinyasa' ) );
$ok( 'class names are escaped', false !== strpos( $sched, 'Slow &lt;Flow&gt;' ) );
$ok( 'times shown in location zone (7:00 am Vancouver)', false !== strpos( $sched, '7:00 am' ) );
$ok( 'booking links use the location booking page', false !== strpos( $sched, 'book.branchharbor.com/l/kitsilano?occurrence=occ1' ) );
$ok( 'waitlist CTA for full class', false !== strpos( $sched, 'Join waitlist' ) );
$before = count( $calls );
$menu   = Renderer::render( 'menu', \BranchHarbor\Blocks::sanitize_attributes( 'menu', array() ), false );
$ok( 'menu placeholder when nothing cached (no blocking fetch)', false !== strpos( $menu, 'data-bh-pending' ) && count( $calls ) === $before );
$res = rest_do_request( new WP_REST_Request( 'GET', '/branchharbor/v1/render/menu' ) );
$ok( 'REST render route fills the menu', false !== strpos( $res->get_data()['html'], 'Poke' ) && false !== strpos( $res->get_data()['html'], '14.50' ) );
$foreign = \BranchHarbor\Blocks::sanitize_attributes( 'menu', array( 'locationId' => '55555555-5555-4555-8555-555555555555' ) );
$ok( 'unknown location ids are replaced by the mapped location', KT === $foreign['locationId'] );
$ok( 'shortcode registered', shortcode_exists( 'branchharbor_class_schedule' ) && false !== strpos( do_shortcode( '[branchharbor_class_schedule days="7"]' ), 'Morning Vinyasa' ) );
$ok( 'all six blocks registered', 6 === count( array_filter( array_keys( WP_Block_Type_Registry::get_instance()->get_all_registered() ), fn( $n ) => 0 === strpos( $n, 'branchharbor/' ) ) ) );
$btn = do_shortcode( '[branchharbor_pickup_button]' );
$ok( 'pickup button links to order page', false !== strpos( $btn, 'order.branchharbor.com/l/kitsilano' ) );
$ok( 'no "Powered by" credit by default', false === strpos( $sched, 'Powered by' ) );

WP_CLI::log( 'Lead form' );
$form = do_shortcode( '[branchharbor_lead_form form_id="contact"]' );
$ok( 'form renders with signed config + honeypot', false !== strpos( $form, 'name="bh_cfg"' ) && false !== strpos( $form, 'name="bh_hp"' ) );
preg_match( '/name="bh_cfg" value="([^"]+)"/', $form, $m );
$cfg = html_entity_decode( $m[1] );
$submit = function ( array $post ) use ( $capture_redirect ) {
	$_POST                  = array_map( 'wp_slash', $post );
	$_SERVER['REMOTE_ADDR'] = '203.0.113.' . wp_rand( 1, 250 );
	$_SERVER['HTTP_REFERER'] = home_url( '/contact/' );
	$_REQUEST['_wp_http_referer'] = '/contact/';
	try {
		Leads::handle();
	} catch ( RuntimeException $e ) {
		return substr( $e->getMessage(), 9 );
	}
	return '';
};
$capture_redirect();
$tampered = $cfg . 'x';
$loc = $submit( array( 'bh_cfg' => $tampered, 'bh_name' => 'Ada', 'bh_email' => 'ada@example.com' ) );
$ok( 'tampered form config rejected', false !== strpos( $loc, 'bh_lead=error' ) );
$loc = $submit( array( 'bh_cfg' => $cfg, 'bh_name' => '', 'bh_email' => 'bad' ) );
$ok( 'validation errors returned', false !== strpos( $loc, 'bh_err=email%2Cname' ) || false !== strpos( $loc, 'bh_err=name,email' ) || false !== strpos( $loc, 'bh_err=name%2Cemail' ) );
$calls_before = count( $calls );
$loc = $submit( array( 'bh_cfg' => $cfg, 'bh_name' => 'Ada', 'bh_email' => 'ada@example.com', 'bh_message' => 'Hello' ) );
$ok( 'lead endpoint not live → accepted and queued', false !== strpos( $loc, 'bh_lead=sent' ) && 1 === count( Leads::queue() ) );
$lead_call = array_values( array_filter( array_slice( $calls, $calls_before ), fn( $c ) => '/v1/connector/wordpress/leads' === $c[1] ) );
$ok( 'lead sent with Idempotency-Key', ! empty( $lead_call[0][2]['headers']['Idempotency-Key'] ) );
$loc = $submit( array( 'bh_cfg' => $cfg, 'bh_name' => 'Ada', 'bh_email' => 'ADA@example.com', 'bh_message' => 'Hello ' ) );
$ok( 'duplicate submission not queued twice', false !== strpos( $loc, 'bh_lead=sent' ) && 1 === count( Leads::queue() ) );
$loc = $submit( array( 'bh_cfg' => $cfg, 'bh_name' => 'Bot', 'bh_email' => 'bot@example.com', 'bh_hp' => 'http://spam' ) );
$ok( 'honeypot: bot told success, nothing queued', false !== strpos( $loc, 'bh_lead=sent' ) && 1 === count( Leads::queue() ) );
$mode['lead'] = 'ok';
Leads::flush_queue();
$ok( 'queued enquiry delivered when endpoint is live', 0 === count( Leads::queue() ) );

WP_CLI::log( 'Degraded / expired' );
add_filter( 'pre_http_request', function ( $pre, $args, $url ) {
	return false !== strpos( $url, '/v1/connector/wordpress/site' ) && 'GET' === $args['method'] ? array( 'response' => array( 'code' => 401 ), 'body' => '{"error":{"code":"unauthorized","message":"Token revoked"}}', 'headers' => array(), 'cookies' => array() ) : $pre;
}, 5, 3 );
Api_Client::site();
$ok( '401 → authorisation expired', Connection_Status::EXPIRED === Settings::connection()['state'] );
$cached = Renderer::render( 'class-schedule', \BranchHarbor\Blocks::sanitize_attributes( 'class-schedule', array() ), false );
$ok( 'expired: blocks still show cached schedule', false !== strpos( $cached, 'Morning Vinyasa' ) );
$desc = Connection_Status::describe( array( 'state' => Settings::connection()['state'] ) );
$ok( 'expired: recovery action is reconnect', 'reconnect' === $desc['recovery_action'] );

WP_CLI::log( 'Admin pages render' );
Settings::update_connection( array( 'state' => Connection_Status::CONNECTED ) );
set_current_screen( 'settings_page_branchharbor' );
foreach ( array( 'overview', 'connect', 'compat', 'blocks', 'settings' ) as $tab ) {
	$_GET['tab'] = $tab;
	foreach ( 'connect' === $tab ? array( 'consent', 'detect', 'authorise', 'map', 'data', 'test', 'done' ) : array( '' ) as $step ) {
		$_GET['step'] = $step;
		ob_start();
		Admin::page();
		$out = ob_get_clean();
		$ok( "admin tab $tab" . ( $step ? "/$step" : '' ) . ' renders', strlen( $out ) > 500 && false === stripos( $out, 'Fatal' ) );
	}
}
unset( $_GET['tab'], $_GET['step'] );

if ( WooCommerce::active() ) {
	WP_CLI::log( 'WooCommerce (read-only export)' );
	$fc = wc_get_container()->get( Automattic\WooCommerce\Internal\Features\FeaturesController::class );
	$ok( 'HPOS compatibility declared', in_array( plugin_basename( BRANCHHARBOR_FILE ), $fc->get_compatible_plugins_for_feature( 'custom_order_tables' )['compatible'], true ) );
	$ok( 'cart/checkout blocks compatibility declared', in_array( plugin_basename( BRANCHHARBOR_FILE ), $fc->get_compatible_plugins_for_feature( 'cart_checkout_blocks' )['compatible'], true ) );
	delete_option( 'branchharbor_woo_pending' );
	$product = new WC_Product_Simple();
	$product->set_name( 'Mat' );
	$product->set_regular_price( '19.99' );
	$product->set_sku( 'MAT-' . wp_rand() );
	$product->save();
	$order = wc_create_order();
	$order->add_product( $product, 2 );
	$order->set_billing_email( 'customer@example.com' );
	$order->set_billing_first_name( 'Casey' );
	$order->set_currency( 'CAD' );
	$order->calculate_totals();
	$order->save();
	$pending = WooCommerce::pending();
	$ok( 'new order id queued (ids only)', isset( $pending['order'][ $order->get_id() ] ) );
	$ok( 'product id queued', isset( $pending['product'][ $product->get_id() ] ) );
	$before = count( $calls );
	WooCommerce::flush();
	$sent = array_values( array_filter( array_slice( $calls, $before ), fn( $c ) => '/v1/connector/wordpress/events' === $c[1] ) );
	$ok( 'flush sends one batch', 1 === count( $sent ) );
	$body = $sent ? $sent[0][2]['body'] : '';
	$ok( 'payload has no customer PII', false === strpos( $body, 'customer@example.com' ) && false === strpos( $body, 'Casey' ) );
	$events = json_decode( $body, true )['events'] ?? array();
	$orders = array_values( array_filter( $events, fn( $e ) => 'woocommerce.order.upserted' === $e['type'] ) );
	$ok( 'order total in minor units with currency', $orders && 3998 === $orders[0]['data']['total'] && 'CAD' === $orders[0]['data']['currency'] );
	$ok( 'pending cleared after successful send', 0 === WooCommerce::pending_count() );
	$ok( 'order is untouched (read-only)', 'pending' === wc_get_order( $order->get_id() )->get_status() );
	Settings::update( array( 'directions' => array_merge( Settings::get( 'directions' ), array( 'woo_orders' => 'off' ) ) ) );
	$order->set_status( 'processing' );
	$order->save();
	$ok( 'direction off → nothing queued', ! isset( WooCommerce::pending()['order'] ) );
	Settings::update( array( 'directions' => array_merge( Settings::get( 'directions' ), array( 'woo_orders' => 'to_bh' ) ) ) );
	$page = WooCommerce::export_page( 'order', 1, 10, null );
	$ok( 'pull endpoint page uses wc_get_orders', count( $page['items'] ) >= 1 );
}

WP_CLI::log( 'Disconnect' );
Connect::disconnect();
$ok( 'disconnect clears token', '' === Settings::token() && Connection_Status::DISCONNECTED === Settings::connection()['state'] );
$ok( 'disconnect revokes at BranchHarbor', (bool) array_filter( $calls, fn( $c ) => 'DELETE' === $c[0] ) );
$ok( 'mapping kept after disconnect', KT === Settings::get( 'mapping' ) );
$ok( 'blocks unavailable after disconnect', false !== strpos( do_shortcode( '[branchharbor_class_schedule]' ), 'temporarily unavailable' ) );

WP_CLI::log( '' );
WP_CLI::log( "$pass passed, " . count( $fail ) . ' failed' );
if ( $fail ) {
	WP_CLI::error( "Failures:\n - " . implode( "\n - ", $fail ) );
}
WP_CLI::success( 'Integration smoke test passed.' );
