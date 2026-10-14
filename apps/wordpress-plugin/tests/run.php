<?php
/**
 * Standalone tests for the plugin's pure logic. No WordPress or PHPUnit required:
 *
 *   php tests/run.php
 *
 * Exits non-zero on failure.
 *
 * @package BranchHarbor
 */

declare(strict_types=1);

// Minimal stand-ins for the few WordPress functions the pure classes use for i18n.
define( 'ABSPATH', __DIR__ . '/' );
define( 'DAY_IN_SECONDS', 86400 );
define( 'HOUR_IN_SECONDS', 3600 );
function __( string $text, string $domain = 'default' ): string { return $text; }
function _n( string $single, string $plural, int $n, string $domain = 'default' ): string { return 1 === $n ? $single : $plural; }

$dir = dirname( __DIR__ ) . '/branchharbor/includes/';
foreach ( array( 'signature', 'idempotency', 'mapping', 'connection-status', 'compat', 'lead-mapper', 'format', 'secret' ) as $f ) {
	require $dir . 'class-' . $f . '.php';
}

use BranchHarbor\Compat;
use BranchHarbor\Connection_Status as CS;
use BranchHarbor\Format;
use BranchHarbor\Idempotency;
use BranchHarbor\Lead_Mapper;
use BranchHarbor\Mapping;
use BranchHarbor\Secret;
use BranchHarbor\Signature;

$GLOBALS['bh_pass'] = 0;
$GLOBALS['bh_fail'] = array();
$GLOBALS['bh_group'] = '';

function group( string $name ): void { $GLOBALS['bh_group'] = $name; echo "\n{$name}\n"; }
function check( string $name, bool $ok ): void {
	if ( $ok ) {
		$GLOBALS['bh_pass']++;
		echo "  \u{2713} {$name}\n";
	} else {
		$GLOBALS['bh_fail'][] = $GLOBALS['bh_group'] . ' › ' . $name;
		echo "  \u{2717} {$name}\n";
	}
}
function eq( string $name, $expected, $actual ): void {
	$ok = $expected === $actual;
	check( $name, $ok );
	if ( ! $ok ) {
		echo '      expected: ' . var_export( $expected, true ) . "\n      actual:   " . var_export( $actual, true ) . "\n";
	}
}

/* -------------------------------------------------------------------------- */
group( 'Signature' );
$secret = 'whsec_test_123';
$body   = '{"id":"evt_1","type":"schedule.updated","data":{"locationId":"x"}}';
$now    = 1760000000;
$hdr    = Signature::header( $secret, $now, $body );
eq( 'valid signature accepted', true, Signature::verify( $secret, (string) $now, $hdr, $body, $now ) );
eq( 'accepted within tolerance', true, Signature::verify( $secret, (string) $now, $hdr, $body, $now + 299 ) );
eq( 'tampered body rejected', 'signature_mismatch', Signature::verify( $secret, (string) $now, $hdr, $body . ' ', $now ) );
eq( 'wrong secret rejected', 'signature_mismatch', Signature::verify( 'other', (string) $now, $hdr, $body, $now ) );
eq( 'replayed old timestamp rejected', 'timestamp_out_of_range', Signature::verify( $secret, (string) $now, $hdr, $body, $now + 301 ) );
eq( 'future timestamp rejected', 'timestamp_out_of_range', Signature::verify( $secret, (string) ( $now + 1000 ), Signature::header( $secret, $now + 1000, $body ), $body, $now ) );
eq( 'timestamp is part of the signature', 'signature_mismatch', Signature::verify( $secret, (string) ( $now + 1 ), $hdr, $body, $now ) );
eq( 'missing signature', 'missing_signature', Signature::verify( $secret, (string) $now, '', $body, $now ) );
eq( 'malformed signature ignored', 'missing_signature', Signature::verify( $secret, (string) $now, 'v1=nothex', $body, $now ) );
eq( 'non-numeric timestamp', 'missing_timestamp', Signature::verify( $secret, 'abc', $hdr, $body, $now ) );
eq( 'no secret configured', 'no_secret', Signature::verify( '', (string) $now, $hdr, $body, $now ) );
eq( 'rotation: any listed v1 signature passes', true, Signature::verify( $secret, (string) $now, 'v1=' . str_repeat( 'a', 64 ) . ', ' . $hdr, $body, $now ) );
eq( 'v0 scheme ignored', 'missing_signature', Signature::verify( $secret, (string) $now, 'v0=' . Signature::sign( $secret, $now, $body ), $body, $now ) );

/* -------------------------------------------------------------------------- */
group( 'Idempotency' );
$store = array();
$idem  = Idempotency::in_memory( $store );
$runs  = 0;
eq( 'first delivery processed', 'processed', $idem->process( 'evt_1', function () use ( &$runs ) { $runs++; } ) );
eq( 'duplicate delivery skipped', 'duplicate', $idem->process( 'evt_1', function () use ( &$runs ) { $runs++; } ) );
eq( 'handler ran once', 1, $runs );
eq( 'other event processed', 'processed', $idem->process( 'evt_2', function () use ( &$runs ) { $runs++; } ) );
eq( 'invalid id rejected', 'invalid', $idem->process( 'bad id with spaces', function () {} ) );
eq( 'empty id rejected', 'invalid', $idem->process( '', function () {} ) );
eq( 'overlong id rejected', 'invalid', $idem->process( str_repeat( 'a', 129 ), function () {} ) );
$threw = false;
try {
	$idem->process( 'evt_3', function () { throw new RuntimeException( 'boom' ); } );
} catch ( RuntimeException $e ) {
	$threw = true;
}
check( 'handler failure propagates', $threw );
eq( 'failed event can be retried', 'processed', $idem->process( 'evt_3', function () {} ) );
eq( 'keys are fixed-length option names', 18 + 40, strlen( Idempotency::key( str_repeat( 'x', 128 ) ) ) );
$expired = array( Idempotency::key( 'evt_old' ) => time() - 10 );
eq( 'expired claim can be reprocessed', 'processed', Idempotency::in_memory( $expired )->process( 'evt_old', function () {} ) );

/* -------------------------------------------------------------------------- */
group( 'Mapping' );
$qw  = '11111111-1111-4111-8111-111111111111';
$ls  = '22222222-2222-4222-8222-222222222222';
$kt  = '33333333-3333-4333-8333-333333333333';
$locs = array(
	array( 'id' => $qw, 'name' => 'Toronto – Queen West', 'timeZone' => 'America/Toronto' ),
	array( 'id' => $ls, 'name' => 'Toronto – Leslieville', 'timeZone' => 'America/Toronto' ),
	array( 'id' => $kt, 'name' => 'Vancouver – Kitsilano', 'timeZone' => 'America/Vancouver' ),
);
$t = strtotime( '2026-10-14T12:00:00Z' );
$r = Mapping::validate(
	array(
		array( 'site_id' => 1, 'name' => 'Stillwater Yoga', 'timezone' => 'America/Toronto', 'target' => 'org' ),
		array( 'site_id' => 2, 'name' => 'Queen West', 'timezone' => 'America/Toronto', 'target' => $qw ),
		array( 'site_id' => 3, 'name' => 'Kitsilano', 'timezone' => 'America/Vancouver', 'target' => $ls ),
	),
	$locs,
	$t
);
eq( 'organisation mapping', 'organisation', $r['1']['status'] );
eq( 'matching location', 'matched', $r['2']['status'] );
eq( 'prototype scenario 3: Pacific site → Eastern location is an error', 'error', $r['3']['status'] );
eq( 'error code is timezone_mismatch', 'timezone_mismatch', $r['3']['errors'][0]['code'] );
eq( 'suggests the Vancouver location', array( $kt ), $r['3']['suggestions'] );
check( 'message names the location', false !== strpos( $r['3']['errors'][0]['message'], 'Toronto – Leslieville' ) );
eq( 'all_valid false with an error', false, Mapping::all_valid( $r ) );

$fixed = Mapping::validate( array( array( 'site_id' => 3, 'name' => 'Kitsilano', 'timezone' => 'America/Vancouver', 'target' => $kt ) ), $locs, $t );
eq( 'fix flow: choosing the suggested location resolves it', 'matched', $fixed['3']['status'] );
$none = Mapping::validate( array( array( 'site_id' => 3, 'name' => 'Kitsilano', 'timezone' => 'America/Vancouver', 'target' => 'none' ) ), $locs, $t );
eq( 'fix flow: "Don’t connect this site" resolves it', true, Mapping::all_valid( $none ) );

$same = Mapping::validate( array( array( 'site_id' => 9, 'name' => 'NY', 'timezone' => 'America/New_York', 'target' => $qw ) ), $locs, $t );
eq( 'different zone name with identical local time is fine', 'matched', $same['9']['status'] );
$offset = Mapping::validate( array( array( 'site_id' => 9, 'name' => 'Fixed', 'timezone' => '-5', 'target' => $qw ) ), $locs, $t );
eq( 'fixed UTC offset vs DST zone is an error (summer differs)', 'error', $offset['9']['status'] );
$unknown = Mapping::validate( array( array( 'site_id' => 4, 'name' => 'X', 'timezone' => 'UTC', 'target' => '44444444-4444-4444-8444-444444444444' ) ), $locs, $t );
eq( 'removed location is an error', 'unknown_location', $unknown['4']['errors'][0]['code'] );
$invalid = Mapping::validate( array( array( 'site_id' => 5, 'name' => 'X', 'timezone' => 'UTC', 'target' => 'drop table' ) ), $locs, $t );
eq( 'invalid target is an error', 'invalid_target', $invalid['5']['errors'][0]['code'] );
$dup = Mapping::validate(
	array(
		array( 'site_id' => 1, 'name' => 'A', 'timezone' => 'America/Toronto', 'target' => $qw ),
		array( 'site_id' => 2, 'name' => 'B', 'timezone' => 'America/Toronto', 'target' => strtoupper( $qw ) ),
	),
	$locs,
	$t
);
eq( 'duplicate location is a warning, not an error', 'matched', $dup['2']['status'] );
eq( 'duplicate warning code', 'duplicate_location', $dup['2']['warnings'][0]['code'] );
eq( 'offset parsing "+05:30"', '+05:30', Mapping::timezone( '+05:30' )->getName() );
eq( 'offset parsing "5.5"', '+05:30', Mapping::timezone( '5.5' )->getName() );
eq( 'offset parsing "UTC-8"', '-08:00', Mapping::timezone( 'UTC-8' )->getName() );
eq( 'garbage timezone is null', null, Mapping::timezone( 'Mars/Olympus' ) );

/* -------------------------------------------------------------------------- */
group( 'Connection status' );
eq( '401 → authorisation expired', CS::EXPIRED, CS::after_response( CS::CONNECTED, 401, 0 )['state'] );
eq( '403 → authorisation expired', CS::EXPIRED, CS::after_response( CS::CONNECTED, 403, 0 )['state'] );
eq( 'one timeout stays connected', CS::CONNECTED, CS::after_response( CS::CONNECTED, null, 0 )['state'] );
eq( 'third consecutive failure → degraded', CS::DEGRADED, CS::after_response( CS::CONNECTED, 503, 2 )['state'] );
eq( 'success after degraded → connected', CS::CONNECTED, CS::after_response( CS::DEGRADED, 200, 5 )['state'] );
eq( 'success resets failures', 0, CS::after_response( CS::DEGRADED, 200, 5 )['failures'] );
eq( 'initial sync stays initial on success', CS::INITIAL_SYNC, CS::after_response( CS::INITIAL_SYNC, 200, 0 )['state'] );
eq( 'disconnected is never revived by a response', CS::DISCONNECTED, CS::after_response( CS::DISCONNECTED, 200, 0 )['state'] );
eq( 'expired does not become degraded on timeouts', CS::EXPIRED, CS::after_response( CS::EXPIRED, null, 9 )['state'] );
eq( 'degraded recovery action', 'retry', CS::describe( array( 'state' => CS::DEGRADED, 'pending_orders' => 6 ) )['recovery_action'] );
check( 'degraded lists affected records', false !== strpos( CS::describe( array( 'state' => CS::DEGRADED, 'pending_orders' => 6 ) )['description'], '6 records' ) );
eq( 'expired recovery action', 'reconnect', CS::describe( array( 'state' => CS::EXPIRED ) )['recovery_action'] );
check( 'queued enquiries mentioned', false !== strpos( CS::describe( array( 'state' => CS::EXPIRED, 'queued_leads' => 2 ) )['description'], '2 enquiries are queued' ) );
eq( 'unknown state treated as not connected', CS::NOT_CONNECTED, CS::describe( array( 'state' => 'weird' ) )['state'] );
eq( 'can_call while degraded', true, CS::can_call( CS::DEGRADED ) );
eq( 'cannot call while expired', false, CS::can_call( CS::EXPIRED ) );

/* -------------------------------------------------------------------------- */
group( 'Compatibility' );
eq( 'in range (patch of max)', true, Compat::in_range( '9.3.2', array( '8.9', '9.3' ) ) );
eq( 'below range', false, Compat::in_range( '8.8.5', array( '8.9', '9.3' ) ) );
eq( 'above range', false, Compat::in_range( '9.4.0', array( '8.9', '9.3' ) ) );
$rows = Compat::evaluate( array( 'woocommerce' => '12.0.0', 'yoast' => '23.5', 'unknown_plugin' => '1.0', 'cf7' => '5.9' ), array( 'hpos' => true ) );
eq( 'unknown plugins are not claimed', array( 'woocommerce', 'yoast', 'cf7' ), array_column( $rows, 'key' ) );
eq( 'tested plugin outside range is downgraded', Compat::LIMITED, $rows[0]['status'] );
check( 'downgrade explains the range', false !== strpos( $rows[0]['note'], 'outside the tested range' ) );
check( 'HPOS noted', false !== strpos( $rows[0]['note'], 'High-performance order storage' ) );
eq( 'coexistence-only form plugin is Unsupported', Compat::UNSUPPORTED, $rows[2]['status'] );
eq( 'status label', 'Requires setup', Compat::status_label( Compat::REQUIRES_SETUP ) );
eq( 'SEO plugins detected for ownership choice', array( 'Yoast SEO', 'Rank Math' ), Compat::seo_plugins( array( 'yoast' => '1', 'rankmath' => '1', 'woocommerce' => '1' ) ) );
check( 'every catalogue status is one of the five labels', array() === array_diff( array_column( Compat::catalogue(), 'status' ), Compat::STATUSES ) );
check( 'cache plugins carry exclusion guidance', false !== strpos( Compat::catalogue()['wp_rocket']['action'], '/wp-json/branchharbor/' ) );

/* -------------------------------------------------------------------------- */
group( 'Lead mapping' );
$ctx = array( 'target' => 'lead', 'form_id' => 'enquiry', 'location_id' => $qw, 'page_url' => 'https://example.com/contact' );
$m   = Lead_Mapper::map( array( 'name' => '  Ada  Lovelace ', 'email' => 'ADA@Example.com', 'message' => "Hello\n<b>there</b>", 'marketing_consent' => 'on' ), array( 'name', 'email', 'message', 'marketing_consent' ), $ctx );
eq( 'valid lead ok', true, $m['ok'] );
eq( 'name whitespace collapsed', 'Ada Lovelace', $m['payload']['contact']['name'] );
eq( 'email lower-cased', 'ada@example.com', $m['payload']['contact']['email'] );
eq( 'tags stripped, newlines kept in message', "Hello\nthere", $m['payload']['message'] );
eq( 'marketing consent mapped', true, $m['payload']['consent']['marketing'] );
eq( 'location routed', $qw, $m['payload']['locationId'] );
eq( 'source', 'wordpress', $m['payload']['source'] );
$bad = Lead_Mapper::map( array( 'email' => 'not-an-email' ), array(), $ctx );
eq( 'missing name + bad email', array( 'name', 'email' ), array_keys( $bad['errors'] ) );
$noloc = Lead_Mapper::map( array( 'name' => 'A', 'email' => 'a@b.co' ), array(), array( 'target' => 'lead' ) );
check( 'lead without location is rejected', isset( $noloc['errors']['_form'] ) );
eq( 'unknown fields cannot be added', array( 'name', 'email', 'phone' ), Lead_Mapper::normalise_fields( array( 'phone', 'password', 'name' ), 'lead' ) );
$demo = Lead_Mapper::map(
	array( 'name' => 'Jo', 'email' => 'jo@biz.ca', 'business' => 'Biz', 'location_count' => '3 sites', 'country' => 'ca', 'website' => 'biz.ca', 'message' => 'Rotas' ),
	array( 'website', 'message' ),
	array( 'target' => 'demo_request', 'industry' => 'foods', 'locale' => 'fr' )
);
eq( 'demo request ok', true, $demo['ok'] );
eq( 'demo request payload matches /v1/public/demo-requests', array( 'name' => 'Jo', 'email' => 'jo@biz.ca', 'business' => 'Biz', 'industry' => 'foods', 'locationCount' => 3, 'country' => 'CA', 'existingWebsite' => 'https://biz.ca', 'primaryDifficulty' => 'Rotas', 'locale' => 'fr', 'marketingConsent' => false ), $demo['payload'] );
$demo_bad = Lead_Mapper::map( array( 'name' => 'Jo', 'email' => 'jo@biz.ca', 'business' => 'B', 'location_count' => '0', 'country' => 'CAN' ), array(), array( 'target' => 'demo_request' ) );
eq( 'demo validation errors', array( 'country', 'location_count' ), array_keys( $demo_bad['errors'] ) );
$a = Lead_Mapper::dedupe_key( array( 'email' => 'A@x.com', 'message' => 'Hi  there' ), 'lead', 'enquiry', $qw, 1000 );
$b = Lead_Mapper::dedupe_key( array( 'email' => 'a@x.com', 'message' => 'hi there' ), 'lead', 'enquiry', strtoupper( $qw ), 1100 );
eq( 'same person + message within window → same key', $a, $b );
check( 'different location → different key', $a !== Lead_Mapper::dedupe_key( array( 'email' => 'a@x.com', 'message' => 'hi there' ), 'lead', 'enquiry', $ls, 1000 ) );
check( 'different message → different key', $a !== Lead_Mapper::dedupe_key( array( 'email' => 'a@x.com', 'message' => 'other' ), 'lead', 'enquiry', $qw, 1000 ) );
$k1 = Lead_Mapper::dedupe_keys( array( 'email' => 'a@x.com', 'message' => 'm' ), 'lead', 'f', $qw, 1199 );
$k2 = Lead_Mapper::dedupe_keys( array( 'email' => 'a@x.com', 'message' => 'm' ), 'lead', 'f', $qw, 1201 );
check( 'double submit straddling a window boundary is still caught', in_array( $k1[0], $k2, true ) );
check( 'resubmission after two windows is a new lead', ! in_array( $k1[0], Lead_Mapper::dedupe_keys( array( 'email' => 'a@x.com', 'message' => 'm' ), 'lead', 'f', $qw, 2500 ), true ) );

/* -------------------------------------------------------------------------- */
group( 'Money and time formatting' );
eq( 'USD decimal → minor', 1250, Format::to_minor( '12.5', 'USD' ) );
eq( 'JPY has no minor unit', 1200, Format::to_minor( '1200', 'JPY' ) );
eq( 'KWD three decimals, round half up', 1235, Format::to_minor( '1.2345', 'KWD' ) );
eq( 'negative refund', -199, Format::to_minor( '-1.99', 'EUR' ) );
eq( 'no float drift', 1999, Format::to_minor( '19.99', 'GBP' ) );
eq( 'thousands separators ignored', 123456, Format::to_minor( '1,234.56', 'CAD' ) );
check( 'money formats with currency', false !== strpos( Format::money( 1250, 'CAD', 'en_CA' ), '12.50' ) );
eq( 'local time in location zone', '07:00', Format::local_time( '2026-10-15T11:00:00Z', 'America/Toronto', 'H:i' ) );
eq( 'local time Vancouver', '04:00', Format::local_time( '2026-10-15T11:00:00Z', 'America/Vancouver', 'H:i' ) );

/* -------------------------------------------------------------------------- */
group( 'Secret storage' );
$key    = Secret::key_from( 'salt-one' );
$sealed = Secret::seal( 'bh_site_token_abc', $key );
check( 'sealed value does not contain the token', false === strpos( $sealed, 'bh_site_token_abc' ) );
eq( 'round trip', 'bh_site_token_abc', Secret::open( $sealed, $key ) );
eq( 'rotated salts cannot open (→ reconnect)', null, Secret::open( $sealed, Secret::key_from( 'salt-two' ) ) );
eq( 'tampered value rejected', null, Secret::open( substr( $sealed, 0, -4 ) . 'AAAA', $key ) );
eq( 'empty stays empty', '', Secret::open( Secret::seal( '', $key ), $key ) );
check( 'nonce makes each seal unique', Secret::seal( 'x', $key ) !== Secret::seal( 'x', $key ) );

/* -------------------------------------------------------------------------- */
$failed = count( $GLOBALS['bh_fail'] );
echo "\n" . $GLOBALS['bh_pass'] . ' passed, ' . $failed . " failed\n";
if ( $failed ) {
	echo "Failures:\n  - " . implode( "\n  - ", $GLOBALS['bh_fail'] ) . "\n";
	exit( 1 );
}
exit( 0 );
