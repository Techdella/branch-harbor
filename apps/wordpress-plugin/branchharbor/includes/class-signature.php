<?php
/**
 * Webhook signature verification. Pure PHP (no WordPress calls) so it can be unit tested.
 *
 * Scheme (see docs/API_CONTRACT.md):
 *   X-BH-Timestamp: unix seconds
 *   X-BH-Signature: v1=<hex hmac_sha256(secret, "<timestamp>.<raw body>")>[, v1=<...>]
 * Several v1 signatures may be present during secret rotation; any valid one is accepted.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Signature {

	public const TOLERANCE_SECONDS = 300;

	/**
	 * Compute the hex signature for a payload.
	 */
	public static function sign( string $secret, int $timestamp, string $raw_body ): string {
		return hash_hmac( 'sha256', $timestamp . '.' . $raw_body, $secret );
	}

	/**
	 * Build a header value for a payload (used by tests and the loopback self-check).
	 */
	public static function header( string $secret, int $timestamp, string $raw_body ): string {
		return 'v1=' . self::sign( $secret, $timestamp, $raw_body );
	}

	/**
	 * Verify a signature header.
	 *
	 * @return true|string True when valid, otherwise a machine-readable reason code.
	 */
	public static function verify( string $secret, string $timestamp_header, string $signature_header, string $raw_body, ?int $now = null ) {
		if ( '' === $secret ) {
			return 'no_secret';
		}
		if ( '' === $timestamp_header || ! ctype_digit( $timestamp_header ) ) {
			return 'missing_timestamp';
		}
		$timestamp = (int) $timestamp_header;
		$now       = $now ?? time();
		if ( abs( $now - $timestamp ) > self::TOLERANCE_SECONDS ) {
			return 'timestamp_out_of_range';
		}
		$candidates = self::parse( $signature_header );
		if ( ! $candidates ) {
			return 'missing_signature';
		}
		$expected = self::sign( $secret, $timestamp, $raw_body );
		foreach ( $candidates as $candidate ) {
			if ( hash_equals( $expected, $candidate ) ) {
				return true;
			}
		}
		return 'signature_mismatch';
	}

	/**
	 * Extract v1 signatures from "v1=abc, v1=def".
	 *
	 * @return string[]
	 */
	public static function parse( string $header ): array {
		$out = array();
		foreach ( explode( ',', $header ) as $part ) {
			$part = trim( $part );
			if ( 0 === strpos( $part, 'v1=' ) ) {
				$sig = strtolower( substr( $part, 3 ) );
				if ( preg_match( '/^[0-9a-f]{64}$/', $sig ) ) {
					$out[] = $sig;
				}
			}
		}
		return $out;
	}
}
