<?php
/**
 * Detects relevant plugins and site features. Runs entirely on this server: nothing is sent to
 * BranchHarbor by the scan itself. Detection only reads constants/classes/theme info — it never
 * activates, deactivates or reconfigures another plugin.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Detector {

	/**
	 * @return array<string,string|true> key => version (true when the version is unknown)
	 */
	public static function detected(): array {
		$d = array();

		$const = static function ( string $name ) {
			return defined( $name ) ? (string) constant( $name ) : null;
		};

		if ( class_exists( 'WooCommerce' ) ) {
			$d['woocommerce'] = $const( 'WC_VERSION' ) ?? true;
		}
		if ( class_exists( 'Classic_Editor' ) || ( function_exists( 'use_block_editor_for_post_type' ) && ! use_block_editor_for_post_type( 'page' ) ) ) {
			$d['classic_editor'] = true;
		} else {
			$d['block_editor'] = (string) get_bloginfo( 'version' );
		}
		if ( null !== $const( 'ELEMENTOR_VERSION' ) ) {
			$d['elementor'] = $const( 'ELEMENTOR_VERSION' );
		}
		$theme = wp_get_theme();
		if ( null !== $const( 'ET_BUILDER_VERSION' ) || 'Divi' === $theme->get_template() ) {
			$d['divi'] = $const( 'ET_BUILDER_VERSION' ) ?? true;
		}
		if ( null !== $const( 'FL_BUILDER_VERSION' ) ) {
			$d['beaver'] = $const( 'FL_BUILDER_VERSION' );
		}
		if ( null !== $const( 'WPSEO_VERSION' ) ) {
			$d['yoast'] = $const( 'WPSEO_VERSION' );
		}
		if ( null !== $const( 'RANK_MATH_VERSION' ) ) {
			$d['rankmath'] = $const( 'RANK_MATH_VERSION' );
		}
		if ( null !== $const( 'WP_ROCKET_VERSION' ) ) {
			$d['wp_rocket'] = $const( 'WP_ROCKET_VERSION' );
		}
		if ( null !== $const( 'W3TC_VERSION' ) ) {
			$d['w3tc'] = $const( 'W3TC_VERSION' );
		}
		if ( null !== $const( 'LSCWP_V' ) ) {
			$d['litespeed'] = $const( 'LSCWP_V' );
		}
		if ( null !== $const( 'WPCACHEHOME' ) || function_exists( 'wp_cache_phase2' ) ) {
			$d['wp_super_cache'] = true;
		}
		if ( null !== $const( 'WORDFENCE_VERSION' ) ) {
			$d['wordfence'] = $const( 'WORDFENCE_VERSION' );
		}
		if ( class_exists( 'ITSEC_Core' ) ) {
			$d['solid_security'] = true;
		}
		if ( null !== $const( 'ICL_SITEPRESS_VERSION' ) ) {
			$d['wpml'] = $const( 'ICL_SITEPRESS_VERSION' );
		}
		if ( null !== $const( 'POLYLANG_VERSION' ) ) {
			$d['polylang'] = $const( 'POLYLANG_VERSION' );
		}
		if ( null !== $const( 'MEPR_VERSION' ) ) {
			$d['memberpress'] = $const( 'MEPR_VERSION' );
		}
		if ( null !== $const( 'AMELIA_VERSION' ) ) {
			$d['amelia'] = $const( 'AMELIA_VERSION' );
		}
		if ( class_exists( '\Bookly\Lib\Plugin' ) ) {
			$d['bookly'] = true;
		}
		if ( null !== $const( 'WC_BOOKINGS_VERSION' ) ) {
			$d['wc_bookings'] = $const( 'WC_BOOKINGS_VERSION' );
		}
		if ( class_exists( 'Tribe__Events__Main' ) ) {
			$d['events_calendar'] = defined( 'Tribe__Events__Main::VERSION' ) ? (string) constant( 'Tribe__Events__Main::VERSION' ) : true;
		}
		if ( null !== $const( 'WPCF7_VERSION' ) ) {
			$d['cf7'] = $const( 'WPCF7_VERSION' );
		}
		if ( class_exists( 'GFForms' ) ) {
			$d['gravity_forms'] = class_exists( 'GFCommon' ) && isset( \GFCommon::$version ) ? (string) \GFCommon::$version : true;
		}
		if ( null !== $const( 'WPFORMS_VERSION' ) ) {
			$d['wpforms'] = $const( 'WPFORMS_VERSION' );
		}
		if ( is_multisite() ) {
			$d['multisite'] = (string) get_bloginfo( 'version' );
		}

		/** Filter detected systems (key => version|true). Keys must exist in Compat::catalogue(). */
		return (array) apply_filters( 'branchharbor_detected_systems', $d );
	}

	/**
	 * Run a scan and store the result (locally).
	 *
	 * @return array{at:int,rows:array<int,array<string,string>>}
	 */
	public static function scan(): array {
		$facts = array();
		if ( WooCommerce::active() ) {
			$facts['hpos'] = WooCommerce::hpos_enabled();
		}
		$detected = self::detected();
		$result   = array(
			'at'   => time(),
			'rows' => Compat::evaluate( $detected, array_filter( $facts, static fn( $v ) => null !== $v ) ),
			'seo'  => Compat::seo_plugins( $detected ),
		);
		Settings::update( array( 'last_scan' => $result ) );
		return $result;
	}
}
