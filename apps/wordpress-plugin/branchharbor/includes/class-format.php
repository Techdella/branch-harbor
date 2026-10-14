<?php
/**
 * Display formatting helpers for money and times. Pure PHP (uses intl when available).
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Format {

	/** ISO 4217 minor-unit exponents that differ from 2. */
	private const EXPONENTS = array(
		'BIF' => 0,
		'CLP' => 0,
		'DJF' => 0,
		'GNF' => 0,
		'ISK' => 0,
		'JPY' => 0,
		'KMF' => 0,
		'KRW' => 0,
		'PYG' => 0,
		'RWF' => 0,
		'UGX' => 0,
		'VND' => 0,
		'VUV' => 0,
		'XAF' => 0,
		'XOF' => 0,
		'XPF' => 0,
		'BHD' => 3,
		'IQD' => 3,
		'JOD' => 3,
		'KWD' => 3,
		'LYD' => 3,
		'OMR' => 3,
		'TND' => 3,
	);

	public static function exponent( string $currency ): int {
		return self::EXPONENTS[ strtoupper( $currency ) ] ?? 2;
	}

	/**
	 * Convert a decimal string (e.g. WooCommerce "12.50") to integer minor units without float drift.
	 */
	public static function to_minor( string $decimal, string $currency ): int {
		$exp            = self::exponent( $currency );
		$decimal        = trim( $decimal );
		$negative       = 0 === strpos( $decimal, '-' );
		$decimal        = ltrim( $decimal, '+-' );
		[ $int, $frac ] = array_pad( explode( '.', $decimal, 2 ), 2, '' );
		$int            = (string) preg_replace( '/\D/', '', $int );
		$int            = '' !== $int ? $int : '0';
		$frac           = preg_replace( '/\D/', '', $frac ) ?? '';
		$frac_padded    = str_pad( substr( $frac, 0, $exp ), $exp, '0' );
		$minor          = (int) ( $int . $frac_padded );
		// Round half up on the first dropped digit.
		if ( strlen( $frac ) > $exp && (int) $frac[ $exp ] >= 5 ) {
			++$minor;
		}
		return $negative ? -$minor : $minor;
	}

	/**
	 * Format minor units for display, e.g. (1250, 'CAD', 'en_CA') => "$12.50".
	 */
	public static function money( int $amount_minor, string $currency, string $locale = 'en_US' ): string {
		$currency = strtoupper( $currency );
		$exp      = self::exponent( $currency );
		$value    = $amount_minor / ( 10 ** $exp );
		if ( class_exists( '\NumberFormatter' ) ) {
			$fmt = new \NumberFormatter( $locale, \NumberFormatter::CURRENCY );
			$out = $fmt->formatCurrency( $value, $currency );
			if ( false !== $out ) {
				return $out;
			}
		}
		return number_format( $value, $exp, '.', ',' ) . ' ' . $currency;
	}

	/**
	 * Format an ISO-8601 UTC instant in a location's time zone (recurrence is generated server-side in
	 * the location's zone; we only present it).
	 */
	public static function local_time( string $iso_utc, string $time_zone, string $format ): string {
		try {
			$tz = new \DateTimeZone( '' !== $time_zone ? $time_zone : 'UTC' );
			$dt = new \DateTimeImmutable( $iso_utc );
			return $dt->setTimezone( $tz )->format( $format );
		} catch ( \Exception $e ) {
			return '';
		}
	}
}
