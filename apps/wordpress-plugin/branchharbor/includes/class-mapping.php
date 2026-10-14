<?php
/**
 * Site → BranchHarbor location mapping validation. Pure PHP; no WordPress calls.
 *
 * A "site" is this WordPress site, or each subsite on Multisite. A target is:
 *   'org'  – organisation-level (e.g. a brand site that lists all locations),
 *   'none' – leave this site unconnected,
 *   '<location uuid>' – one BranchHarbor location.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Mapping {

	public const TARGET_ORG  = 'org';
	public const TARGET_NONE = 'none';

	/**
	 * Is the target syntactically valid?
	 */
	public static function valid_target( string $target ): bool {
		return self::TARGET_ORG === $target || self::TARGET_NONE === $target || self::is_uuid( $target );
	}

	public static function is_uuid( string $value ): bool {
		return (bool) preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $value );
	}

	/**
	 * Build a DateTimeZone from an IANA name or a WordPress-style UTC offset ("-8", "5.5", "UTC+2", "+05:30").
	 */
	public static function timezone( string $tz ): ?\DateTimeZone {
		$tz = trim( $tz );
		if ( '' === $tz ) {
			return null;
		}
		if ( preg_match( '/^(?:UTC)?\s*([+-]?)(\d{1,2})(?:(?::(\d{2}))|(?:\.(\d+)))?$/i', $tz, $m ) ) {
			$sign    = '-' === $m[1] ? '-' : '+';
			$hours   = (int) $m[2];
			$minutes = 0;
			if ( isset( $m[3] ) && '' !== $m[3] ) {
				$minutes = (int) $m[3];
			} elseif ( isset( $m[4] ) && '' !== $m[4] ) {
				$minutes = (int) round( (float) ( '0.' . $m[4] ) * 60 );
			}
			if ( $hours > 14 || $minutes > 59 ) {
				return null;
			}
			return new \DateTimeZone( sprintf( '%s%02d:%02d', $sign, $hours, $minutes ) );
		}
		try {
			return new \DateTimeZone( $tz );
		} catch ( \Exception $e ) {
			return null;
		}
	}

	/**
	 * Do two time zones show the same wall-clock time all year (checked in January and July)?
	 */
	public static function same_local_time( string $a, string $b, ?int $now = null ): bool {
		$za = self::timezone( $a );
		$zb = self::timezone( $b );
		if ( ! $za || ! $zb ) {
			return false;
		}
		$year = (int) gmdate( 'Y', $now ?? time() );
		foreach ( array( "$year-01-15 12:00:00", "$year-07-15 12:00:00" ) as $when ) {
			$utc = new \DateTimeImmutable( $when, new \DateTimeZone( 'UTC' ) );
			if ( $za->getOffset( $utc ) !== $zb->getOffset( $utc ) ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Validate mappings for one or more sites.
	 *
	 * @param array<int,array{site_id:int|string,name:string,timezone:string,target:string}> $sites
	 * @param array<int,array{id:string,name:string,timeZone:string}>                          $locations Locations in the connected organisation.
	 * @return array<string,array{status:string,errors:array<int,array{code:string,message:string}>,warnings:array<int,array{code:string,message:string}>,suggestions:string[]}>
	 *         Keyed by (string) site_id. status: matched | organisation | not_connected | error.
	 */
	public static function validate( array $sites, array $locations, ?int $now = null ): array {
		$by_id = array();
		foreach ( $locations as $loc ) {
			$by_id[ strtolower( (string) $loc['id'] ) ] = $loc;
		}
		$used = array();
		$out  = array();

		foreach ( $sites as $site ) {
			$sid    = (string) $site['site_id'];
			$target = strtolower( trim( (string) $site['target'] ) );
			$result = array(
				'status'      => 'matched',
				'errors'      => array(),
				'warnings'    => array(),
				'suggestions' => array(),
			);

			if ( ! self::valid_target( $target ) ) {
				$result['status']   = 'error';
				$result['errors'][] = array(
					'code'    => 'invalid_target',
					'message' => __( 'Choose a location, the organisation, or "Don’t connect this site".', 'branchharbor' ),
				);
			} elseif ( self::TARGET_NONE === $target ) {
				$result['status'] = 'not_connected';
			} elseif ( self::TARGET_ORG === $target ) {
				$result['status'] = 'organisation';
			} elseif ( ! isset( $by_id[ $target ] ) ) {
				$result['status']   = 'error';
				$result['errors'][] = array(
					'code'    => 'unknown_location',
					'message' => __( 'This location no longer exists in BranchHarbor or you no longer have access to it. Choose another location or leave this site unconnected.', 'branchharbor' ),
				);
			} else {
				$loc = $by_id[ $target ];
				if ( ! self::same_local_time( (string) $site['timezone'], (string) $loc['timeZone'], $now ) ) {
					$result['status']   = 'error';
					$result['errors'][] = array(
						'code'    => 'timezone_mismatch',
						'message' => sprintf(
							/* translators: 1: site time zone, 2: location name, 3: location time zone */
							__( 'This site uses %1$s, but %2$s uses %3$s. Class and pickup times would show at the wrong time. Choose a location in the same time zone, change the site time zone in Settings → General, or leave this site unconnected.', 'branchharbor' ),
							'' !== (string) $site['timezone'] ? (string) $site['timezone'] : 'UTC',
							(string) $loc['name'],
							(string) $loc['timeZone']
						),
					);
					foreach ( $locations as $candidate ) {
						if ( self::same_local_time( (string) $site['timezone'], (string) $candidate['timeZone'], $now ) ) {
							$result['suggestions'][] = (string) $candidate['id'];
						}
					}
				}
				if ( isset( $used[ $target ] ) ) {
					$result['warnings'][] = array(
						'code'    => 'duplicate_location',
						'message' => sprintf(
							/* translators: %s: name of the other site */
							__( 'This location is also mapped to %s. Enquiries from both sites will go to the same location.', 'branchharbor' ),
							(string) $used[ $target ]
						),
					);
				}
				$used[ $target ] = (string) $site['name'];
			}
			$out[ $sid ] = $result;
		}
		return $out;
	}

	/**
	 * True when no site has an error.
	 *
	 * @param array<string,array{status:string}> $results Output of validate().
	 */
	public static function all_valid( array $results ): bool {
		foreach ( $results as $r ) {
			if ( 'error' === $r['status'] ) {
				return false;
			}
		}
		return true;
	}
}
