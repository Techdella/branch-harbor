<?php
/**
 * Published compatibility matrix and evaluation of detected plugins. Pure PHP.
 *
 * Coexistence (works alongside) is not integration (supported data exchange). Statuses are the
 * five labels from the product spec: Tested, Limited support, Requires setup, Planned, Unsupported.
 * There is no universal compatibility claim: anything not listed here is simply "not evaluated".
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Compat {

	public const TESTED         = 'tested';
	public const LIMITED        = 'limited';
	public const REQUIRES_SETUP = 'requires_setup';
	public const PLANNED        = 'planned';
	public const UNSUPPORTED    = 'unsupported';

	public const STATUSES = array( self::TESTED, self::LIMITED, self::REQUIRES_SETUP, self::PLANNED, self::UNSUPPORTED );

	public static function status_label( string $status ): string {
		switch ( $status ) {
			case self::TESTED:
				return __( 'Tested', 'branchharbor' );
			case self::LIMITED:
				return __( 'Limited support', 'branchharbor' );
			case self::REQUIRES_SETUP:
				return __( 'Requires setup', 'branchharbor' );
			case self::PLANNED:
				return __( 'Planned', 'branchharbor' );
			default:
				return __( 'Unsupported', 'branchharbor' );
		}
	}

	public static function category_label( string $category ): string {
		$labels = array(
			'commerce'     => __( 'Commerce', 'branchharbor' ),
			'editor'       => __( 'Page builders', 'branchharbor' ),
			'seo'          => __( 'SEO', 'branchharbor' ),
			'cache'        => __( 'Cache', 'branchharbor' ),
			'security'     => __( 'Security', 'branchharbor' ),
			'multilingual' => __( 'Multilingual', 'branchharbor' ),
			'booking'      => __( 'Booking', 'branchharbor' ),
			'forms'        => __( 'Forms', 'branchharbor' ),
			'membership'   => __( 'Memberships', 'branchharbor' ),
			'network'      => __( 'Network', 'branchharbor' ),
		);
		return $labels[ $category ] ?? $category;
	}

	/**
	 * The published matrix. Version ranges are the ranges we have tested; detected versions outside
	 * the range are downgraded to "Limited support" with an explanation.
	 *
	 * @return array<string,array{name:string,category:string,tested:?array{0:string,1:string},works:string,limits:string,status:string,action:string}>
	 */
	public static function catalogue(): array {
		$cache_action    = __( 'Exclude /wp-json/branchharbor/ from page caching and minification. Pages that contain BranchHarbor blocks can stay cached: live content refreshes in the background.', 'branchharbor' );
		$security_action = __( 'Allow POST requests to /wp-json/branchharbor/v1/webhook (signed by BranchHarbor) and do not block the REST API for this route. Rate limiting may delay updates.', 'branchharbor' );

		return array(
			'woocommerce'     => array(
				'name'     => 'WooCommerce',
				'category' => 'commerce',
				'tested'   => array( '9.3', '11.2' ),
				'works'    => __( 'Reads products and orders through WooCommerce APIs (wc_get_orders, wc_get_products). High-performance order storage (HPOS) and cart/checkout blocks are declared compatible.', 'branchharbor' ),
				'limits'   => __( 'Read-only, WordPress → BranchHarbor. Uses your checkout; no second checkout is added. Customer details are not sent.', 'branchharbor' ),
				'status'   => self::TESTED,
				'action'   => '',
			),
			'block_editor'    => array(
				'name'     => __( 'Block editor', 'branchharbor' ),
				'category' => 'editor',
				'tested'   => array( '6.7', '7.1' ),
				'works'    => __( 'Six native blocks with settings and live preview.', 'branchharbor' ),
				'limits'   => __( 'Full-site editing templates are not tested.', 'branchharbor' ),
				'status'   => self::TESTED,
				'action'   => '',
			),
			'classic_editor'  => array(
				'name'     => __( 'Classic Editor', 'branchharbor' ),
				'category' => 'editor',
				'tested'   => null,
				'works'    => __( 'Use the shortcodes listed on the Blocks tab.', 'branchharbor' ),
				'limits'   => __( 'No visual preview.', 'branchharbor' ),
				'status'   => self::LIMITED,
				'action'   => '',
			),
			'elementor'       => array(
				'name'     => 'Elementor',
				'category' => 'editor',
				'tested'   => null, // Not yet in the automated test run; see README.
				'works'    => __( 'Shortcode widget with BranchHarbor shortcodes.', 'branchharbor' ),
				'limits'   => __( 'No native Elementor widgets yet.', 'branchharbor' ),
				'status'   => self::LIMITED,
				'action'   => '',
			),
			'divi'            => array(
				'name'     => 'Divi',
				'category' => 'editor',
				'tested'   => null,
				'works'    => __( 'Code or Text module with BranchHarbor shortcodes.', 'branchharbor' ),
				'limits'   => __( 'No native Divi modules. Not part of the regular test run.', 'branchharbor' ),
				'status'   => self::LIMITED,
				'action'   => '',
			),
			'beaver'          => array(
				'name'     => 'Beaver Builder',
				'category' => 'editor',
				'tested'   => null,
				'works'    => __( 'HTML module with BranchHarbor shortcodes.', 'branchharbor' ),
				'limits'   => __( 'Not part of the regular test run.', 'branchharbor' ),
				'status'   => self::LIMITED,
				'action'   => '',
			),
			'yoast'           => array(
				'name'     => 'Yoast SEO',
				'category' => 'seo',
				'tested'   => null, // Not yet in the automated test run; see README.
				'works'    => __( 'Yoast stays in charge of page titles, canonical links and sitemaps. BranchHarbor adds none of its own.', 'branchharbor' ),
				'limits'   => __( 'Location pages need Yoast templates set manually.', 'branchharbor' ),
				'status'   => self::LIMITED,
				'action'   => '',
			),
			'rankmath'        => array(
				'name'     => 'Rank Math',
				'category' => 'seo',
				'tested'   => null,
				'works'    => __( 'Rank Math stays in charge of titles, canonical links, schema and sitemaps. BranchHarbor adds none of its own.', 'branchharbor' ),
				'limits'   => __( 'Coexistence only; not part of the regular test run.', 'branchharbor' ),
				'status'   => self::LIMITED,
				'action'   => '',
			),
			'wp_rocket'       => array(
				'name'     => 'WP Rocket',
				'category' => 'cache',
				'tested'   => null, // Not yet in the automated test run; see README.
				'works'    => __( 'Works after excluding /wp-json/branchharbor/ from caching.', 'branchharbor' ),
				'limits'   => __( 'Exclusion required for live data and event delivery.', 'branchharbor' ),
				'status'   => self::REQUIRES_SETUP,
				'action'   => $cache_action,
			),
			'w3tc'            => array(
				'name'     => 'W3 Total Cache',
				'category' => 'cache',
				'tested'   => null,
				'works'    => __( 'Works after excluding /wp-json/branchharbor/ from page and database caching.', 'branchharbor' ),
				'limits'   => __( 'Not part of the regular test run.', 'branchharbor' ),
				'status'   => self::REQUIRES_SETUP,
				'action'   => $cache_action,
			),
			'litespeed'       => array(
				'name'     => 'LiteSpeed Cache',
				'category' => 'cache',
				'tested'   => null,
				'works'    => __( 'Works after adding /wp-json/branchharbor/ to "Do Not Cache URIs".', 'branchharbor' ),
				'limits'   => __( 'Not part of the regular test run.', 'branchharbor' ),
				'status'   => self::REQUIRES_SETUP,
				'action'   => $cache_action,
			),
			'wp_super_cache'  => array(
				'name'     => 'WP Super Cache',
				'category' => 'cache',
				'tested'   => null,
				'works'    => __( 'REST API requests are not cached by default.', 'branchharbor' ),
				'limits'   => __( 'Check rejected URIs if you changed the defaults.', 'branchharbor' ),
				'status'   => self::REQUIRES_SETUP,
				'action'   => $cache_action,
			),
			'wordfence'       => array(
				'name'     => 'Wordfence',
				'category' => 'security',
				'tested'   => null, // Not yet in the automated test run; see README.
				'works'    => __( 'Allow BranchHarbor event requests.', 'branchharbor' ),
				'limits'   => __( 'Rate limiting may delay events.', 'branchharbor' ),
				'status'   => self::REQUIRES_SETUP,
				'action'   => $security_action,
			),
			'solid_security'  => array(
				'name'     => 'Solid Security',
				'category' => 'security',
				'tested'   => null,
				'works'    => __( 'Allow BranchHarbor event requests if the REST API is restricted.', 'branchharbor' ),
				'limits'   => __( 'Not part of the regular test run.', 'branchharbor' ),
				'status'   => self::REQUIRES_SETUP,
				'action'   => $security_action,
			),
			'wpml'            => array(
				'name'     => 'WPML',
				'category' => 'multilingual',
				'tested'   => null,
				'works'    => __( 'Planned: map translated pages to locations.', 'branchharbor' ),
				'limits'   => __( 'Blocks show in the site’s default language only for now.', 'branchharbor' ),
				'status'   => self::PLANNED,
				'action'   => '',
			),
			'polylang'        => array(
				'name'     => 'Polylang',
				'category' => 'multilingual',
				'tested'   => null,
				'works'    => __( 'Planned: map translated pages to locations.', 'branchharbor' ),
				'limits'   => __( 'Blocks show in the site’s default language only for now.', 'branchharbor' ),
				'status'   => self::PLANNED,
				'action'   => '',
			),
			'memberpress'     => array(
				'name'     => 'MemberPress',
				'category' => 'membership',
				'tested'   => null,
				'works'    => __( 'Planned: read membership status.', 'branchharbor' ),
				'limits'   => __( 'One system must own access rules and membership state.', 'branchharbor' ),
				'status'   => self::PLANNED,
				'action'   => '',
			),
			'amelia'          => array(
				'name'     => 'Amelia',
				'category' => 'booking',
				'tested'   => null,
				'works'    => __( 'Coexists. Keep using it for its bookings.', 'branchharbor' ),
				'limits'   => __( 'No adapter: bookings are not exchanged with BranchHarbor. Avoid showing two booking flows for the same class.', 'branchharbor' ),
				'status'   => self::UNSUPPORTED,
				'action'   => '',
			),
			'bookly'          => array(
				'name'     => 'Bookly',
				'category' => 'booking',
				'tested'   => null,
				'works'    => __( 'Coexists. Keep using it for its bookings.', 'branchharbor' ),
				'limits'   => __( 'No adapter: bookings are not exchanged with BranchHarbor.', 'branchharbor' ),
				'status'   => self::UNSUPPORTED,
				'action'   => '',
			),
			'wc_bookings'     => array(
				'name'     => 'WooCommerce Bookings',
				'category' => 'booking',
				'tested'   => null,
				'works'    => __( 'Coexists. Booking orders are read like other WooCommerce orders.', 'branchharbor' ),
				'limits'   => __( 'Availability and resources are not exchanged.', 'branchharbor' ),
				'status'   => self::UNSUPPORTED,
				'action'   => '',
			),
			'events_calendar' => array(
				'name'     => 'The Events Calendar',
				'category' => 'booking',
				'tested'   => null,
				'works'    => __( 'Coexists.', 'branchharbor' ),
				'limits'   => __( 'Events are not exchanged with BranchHarbor.', 'branchharbor' ),
				'status'   => self::UNSUPPORTED,
				'action'   => '',
			),
			'cf7'             => array(
				'name'     => 'Contact Form 7',
				'category' => 'forms',
				'tested'   => null,
				'works'    => __( 'Coexists. Keep using it.', 'branchharbor' ),
				'limits'   => __( 'Its submissions aren’t routed to BranchHarbor. Use the BranchHarbor enquiry form block for routed enquiries.', 'branchharbor' ),
				'status'   => self::UNSUPPORTED,
				'action'   => '',
			),
			'gravity_forms'   => array(
				'name'     => 'Gravity Forms',
				'category' => 'forms',
				'tested'   => null,
				'works'    => __( 'Coexists. Keep using it.', 'branchharbor' ),
				'limits'   => __( 'Its submissions aren’t routed to BranchHarbor.', 'branchharbor' ),
				'status'   => self::UNSUPPORTED,
				'action'   => '',
			),
			'wpforms'         => array(
				'name'     => 'WPForms',
				'category' => 'forms',
				'tested'   => null,
				'works'    => __( 'Coexists. Keep using it.', 'branchharbor' ),
				'limits'   => __( 'Its submissions aren’t routed to BranchHarbor.', 'branchharbor' ),
				'status'   => self::UNSUPPORTED,
				'action'   => '',
			),
			'multisite'       => array(
				'name'     => __( 'Multisite', 'branchharbor' ),
				'category' => 'network',
				'tested'   => array( '7.1', '7.1' ),
				'works'    => __( 'Network authorisation plus explicit per-site location mapping.', 'branchharbor' ),
				'limits'   => __( 'Each site maps to one location or to the organisation.', 'branchharbor' ),
				'status'   => self::TESTED,
				'action'   => '',
			),
		);
	}

	/**
	 * Is $version within [min, max] comparing only the significant parts of max (9.3 covers 9.3.x)?
	 */
	public static function in_range( string $version, array $range ): bool {
		[ $min, $max ] = $range;
		if ( version_compare( $version, $min, '<' ) ) {
			return false;
		}
		$parts = substr_count( $max, '.' ) + 1;
		$cut   = implode( '.', array_slice( explode( '.', $version ), 0, $parts ) );
		return version_compare( $cut, $max, '<=' );
	}

	/**
	 * Evaluate detected systems against the matrix.
	 *
	 * @param array<string,string|true> $detected key => version (or true when the version is unknown).
	 * @param array<string,mixed>       $facts    Extra facts, e.g. ['hpos' => true].
	 * @return array<int,array{key:string,name:string,category:string,version:string,status:string,status_label:string,works:string,limits:string,action:string,note:string}>
	 */
	public static function evaluate( array $detected, array $facts = array() ): array {
		$catalogue = self::catalogue();
		$rows      = array();
		foreach ( $detected as $key => $version ) {
			if ( ! isset( $catalogue[ $key ] ) ) {
				continue;
			}
			$entry   = $catalogue[ $key ];
			$status  = $entry['status'];
			$note    = '';
			$version = true === $version ? '' : (string) $version;

			if ( '' !== $version && null !== $entry['tested'] && self::TESTED === $status && ! self::in_range( $version, $entry['tested'] ) ) {
				$status = self::LIMITED;
				/* translators: 1: detected version, 2: minimum tested version, 3: maximum tested version */
				$note = sprintf( __( 'Version %1$s is outside the tested range (%2$s – %3$s).', 'branchharbor' ), $version, $entry['tested'][0], $entry['tested'][1] );
			}
			if ( 'woocommerce' === $key && array_key_exists( 'hpos', $facts ) ) {
				$note = trim( $note . ' ' . ( $facts['hpos'] ? __( 'High-performance order storage is on; orders are read through HPOS-compatible APIs.', 'branchharbor' ) : __( 'Legacy order storage is on; orders are read through the same APIs.', 'branchharbor' ) ) );
			}
			$rows[] = array(
				'key'          => $key,
				'name'         => $entry['name'],
				'category'     => $entry['category'],
				'version'      => $version,
				'status'       => $status,
				'status_label' => self::status_label( $status ),
				'works'        => $entry['works'],
				'limits'       => $entry['limits'],
				'action'       => $entry['action'],
				'note'         => $note,
			);
		}
		return $rows;
	}

	/**
	 * Which detected keys are SEO plugins (used for the SEO ownership choice)?
	 *
	 * @param array<string,mixed> $detected
	 * @return string[]
	 */
	public static function seo_plugins( array $detected ): array {
		$out = array();
		foreach ( array_keys( $detected ) as $key ) {
			if ( isset( self::catalogue()[ $key ] ) && 'seo' === self::catalogue()[ $key ]['category'] ) {
				$out[] = self::catalogue()[ $key ]['name'];
			}
		}
		return $out;
	}
}
