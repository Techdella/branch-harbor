<?php
/**
 * HTML for blocks and shortcodes. All output is escaped here.
 *
 * Front-end page renders never call BranchHarbor: they use the cache (last good copy) and, when
 * nothing is cached yet, output a placeholder that assets/js/blocks-view.js fills from the
 * plugin's REST render route. The REST route and the editor preview may fetch synchronously.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Renderer {

	/**
	 * @param array<string,mixed> $a Sanitised attributes.
	 */
	public static function render( string $block, array $a, bool $allow_fetch ): string {
		wp_enqueue_style( 'branchharbor-blocks' );
		wp_enqueue_script( 'branchharbor-blocks-view' );

		$state = (string) Settings::connection()['state'];
		$live  = Settings::can_call();
		// With expired authorisation we still show the last good copy (no new fetches).
		$cached_only = ! $live && Connection_Status::EXPIRED === $state && Settings::consent()['granted'];
		if ( ! $live && ! $cached_only ) {
			return self::unavailable( $block );
		}
		$allow_fetch = $allow_fetch && $live;

		switch ( $block ) {
			case 'location-finder':
				$html = self::location_finder( $a, $allow_fetch );
				break;
			case 'class-schedule':
				$html = self::schedule( $a, $allow_fetch );
				break;
			case 'menu':
				$html = self::menu( $a, $allow_fetch );
				break;
			case 'book-button':
				$html = self::link_button( $block, $a, 'booking', __( 'Book a class', 'branchharbor' ) );
				break;
			case 'pickup-order-button':
				$html = self::link_button( $block, $a, 'order', __( 'Order for pickup', 'branchharbor' ) );
				break;
			case 'lead-form':
				$html = self::lead_form( $a, $cached_only );
				break;
			default:
				$html = '';
		}
		if ( '' === $html ) {
			return '';
		}
		return $html . self::credit();
	}

	/* ------------------------------------------------------------------ */

	/**
	 * @param array<string,mixed> $a
	 */
	private static function wrapper_open( string $block, array $a, ?int $fetched_at, bool $pending = false ): string {
		$classes = 'bh-block bh-' . sanitize_html_class( $block ) . ( $pending ? ' bh-is-loading' : '' );
		$attrs   = array(
			'class'            => $classes,
			'data-bh-block'    => $block,
			'data-bh-endpoint' => rest_url( Rest::NAMESPACE . '/render/' . $block ),
			'data-bh-attrs'    => (string) wp_json_encode( $a ),
		);
		if ( null !== $fetched_at ) {
			$attrs['data-bh-fetched'] = (string) $fetched_at;
		}
		if ( $pending ) {
			$attrs['data-bh-pending'] = '1';
			$attrs['aria-busy']       = 'true';
		}
		$out = '<div';
		foreach ( $attrs as $k => $v ) {
			$out .= ' ' . $k . '="' . esc_attr( $v ) . '"';
		}
		return $out . '>';
	}

	private static function placeholder( string $block, array $a, string $text ): string {
		return self::wrapper_open( $block, $a, null, true ) . '<p class="bh-muted">' . esc_html( $text ) . '</p></div>';
	}

	private static function unavailable( string $block ): string {
		$msg = '<p class="bh-muted">' . esc_html__( 'This content is temporarily unavailable.', 'branchharbor' ) . '</p>';
		if ( current_user_can( 'manage_options' ) ) {
			$msg .= '<p class="bh-admin-hint">' . sprintf(
				/* translators: %s: link to the BranchHarbor settings page */
				esc_html__( 'Only administrators see this: BranchHarbor is not connected. %s', 'branchharbor' ),
				'<a href="' . esc_url( admin_url( 'options-general.php?page=branchharbor' ) ) . '">' . esc_html__( 'Open BranchHarbor settings', 'branchharbor' ) . '</a>'
			) . '</p>';
		}
		return '<div class="bh-block bh-' . esc_attr( $block ) . ' bh-unavailable">' . $msg . '</div>';
	}

	private static function admin_hint( string $text ): string {
		if ( ! current_user_can( 'edit_posts' ) ) {
			return '';
		}
		return '<p class="bh-admin-hint">' . esc_html( $text ) . '</p>';
	}

	private static function credit(): string {
		if ( ! Settings::get( 'credits' ) ) {
			return '';
		}
		return '<p class="bh-credit">' . esc_html__( 'Powered by', 'branchharbor' ) . ' <a href="' . esc_url( 'https://branchharbor.com' ) . '" rel="nofollow noopener">BranchHarbor</a></p>';
	}

	private static function stale_note( array $entry ): string {
		if ( ! $entry['stale'] || ( time() - $entry['fetched_at'] ) < HOUR_IN_SECONDS ) {
			return '';
		}
		/* translators: %s: date and time of the last update */
		return '<p class="bh-muted bh-small">' . esc_html( sprintf( __( 'Last updated %s', 'branchharbor' ), wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $entry['fetched_at'] ) ) ) . '</p>';
	}

	/**
	 * @return array{data:mixed,fetched_at:int,stale:bool}|null
	 */
	private static function data( string $kind, string $id, array $params, bool $allow_fetch ): ?array {
		return $allow_fetch ? Cache::get_or_fetch( $kind, $id, $params ) : Cache::get( $kind, $id, $params );
	}

	/* ------------------------------------------------------------------ */

	/**
	 * @param array<string,mixed> $a
	 */
	private static function location_finder( array $a, bool $allow_fetch ): string {
		if ( 'off' === Settings::direction( 'locations' ) ) {
			return self::admin_hint( __( 'Locations are turned off in BranchHarbor → Data.', 'branchharbor' ) );
		}
		$slug = (string) $a['orgSlug'];
		if ( '' === $slug ) {
			return self::admin_hint( __( 'Connect BranchHarbor to show your locations.', 'branchharbor' ) );
		}
		$entry = self::data( 'locations', $slug, array(), $allow_fetch );
		if ( ! $entry ) {
			return self::placeholder( 'location-finder', $a, __( 'Loading locations…', 'branchharbor' ) );
		}
		$items = (array) ( $entry['data']['items'] ?? array() );
		if ( '' !== $a['country'] ) {
			$items = array_filter( $items, static fn( $l ) => strtoupper( (string) ( $l['country'] ?? '' ) ) === $a['country'] );
		}
		$known = array();
		foreach ( (array) Settings::connection()['locations'] as $l ) {
			$known[ $l['id'] ] = $l;
		}

		$id  = 'bh-finder-' . substr( md5( wp_json_encode( $a ) ), 0, 8 );
		$out = self::wrapper_open( 'location-finder', $a, $entry['fetched_at'] );
		if ( $a['showSearch'] ) {
			$out .= '<label class="bh-label" for="' . esc_attr( $id ) . '">' . esc_html__( 'Find a location', 'branchharbor' ) . '</label>';
			$out .= '<input class="bh-input" type="search" id="' . esc_attr( $id ) . '" data-bh-filter placeholder="' . esc_attr__( 'City or location name', 'branchharbor' ) . '" autocomplete="off">';
		}
		if ( ! $items ) {
			$out .= '<p class="bh-muted">' . esc_html__( 'No locations to show yet.', 'branchharbor' ) . '</p>';
		}
		$out .= '<ul class="bh-list" role="list">';
		foreach ( $items as $l ) {
			$addr = (array) ( $l['address'] ?? array() );
			$line = implode( ', ', array_filter( array( $addr['line1'] ?? '', $addr['city'] ?? '', $addr['region'] ?? '', $addr['postalCode'] ?? '' ) ) );
			$page = $known[ strtolower( (string) ( $l['id'] ?? '' ) ) ]['links']['page'] ?? '';
			$text = strtolower( ( $l['name'] ?? '' ) . ' ' . $line );
			$out .= '<li class="bh-card" data-bh-text="' . esc_attr( $text ) . '">';
			$out .= '<h3 class="bh-card-title">' . ( $page ? '<a href="' . esc_url( $page ) . '">' . esc_html( (string) $l['name'] ) . '</a>' : esc_html( (string) ( $l['name'] ?? '' ) ) ) . '</h3>';
			if ( $line ) {
				$out .= '<p class="bh-muted">' . esc_html( $line ) . '</p>';
			}
			if ( ! empty( $l['phone'] ) ) {
				$out .= '<p><a href="' . esc_url( 'tel:' . preg_replace( '/[^0-9+]/', '', (string) $l['phone'] ) ) . '">' . esc_html( (string) $l['phone'] ) . '</a></p>';
			}
			if ( isset( $l['status'] ) && 'operating' !== $l['status'] ) {
				$out .= '<p class="bh-badge">' . esc_html( ucwords( str_replace( '_', ' ', (string) $l['status'] ) ) ) . '</p>';
			}
			$out .= '</li>';
		}
		$out .= '</ul><p class="bh-muted bh-empty" hidden>' . esc_html__( 'No locations match your search.', 'branchharbor' ) . '</p>';
		return $out . self::stale_note( $entry ) . '</div>';
	}

	/**
	 * @param array<string,mixed> $a
	 */
	private static function schedule( array $a, bool $allow_fetch ): string {
		if ( 'off' === Settings::direction( 'schedule' ) ) {
			return self::admin_hint( __( 'Class schedules are turned off in BranchHarbor → Data.', 'branchharbor' ) );
		}
		$loc_id = (string) $a['locationId'];
		if ( '' === $loc_id ) {
			return self::admin_hint( __( 'Choose a location for this class schedule.', 'branchharbor' ) );
		}
		$entry = self::data( 'schedule', $loc_id, array( 'days' => (int) $a['days'] ), $allow_fetch );
		if ( ! $entry ) {
			return self::placeholder( 'class-schedule', $a, __( 'Loading schedule…', 'branchharbor' ) );
		}
		$tz      = (string) ( $entry['data']['location']['timeZone'] ?? 'UTC' );
		$items   = (array) ( $entry['data']['items'] ?? array() );
		$booking = (string) ( Settings::location( $loc_id )['links']['booking'] ?? '' );
		try {
			$zone = new \DateTimeZone( $tz );
		} catch ( \Exception $e ) {
			$zone = new \DateTimeZone( 'UTC' );
		}

		$out = self::wrapper_open( 'class-schedule', $a, $entry['fetched_at'] );
		if ( ! $items ) {
			$out .= '<p class="bh-muted">' . esc_html__( 'No classes scheduled in this period.', 'branchharbor' ) . '</p>';
		}
		$day = '';
		foreach ( $items as $o ) {
			$ts = strtotime( (string) ( $o['startsAt'] ?? '' ) );
			if ( ! $ts ) {
				continue;
			}
			$this_day = wp_date( 'Y-m-d', $ts, $zone );
			if ( $this_day !== $day ) {
				$out .= ( '' !== $day ? '</ul>' : '' ) . '<h3 class="bh-day">' . esc_html( wp_date( 'l j F', $ts, $zone ) ) . '</h3><ul class="bh-list" role="list">';
				$day  = $this_day;
			}
			$status = (string) ( $o['status'] ?? '' );
			$action = (string) ( $o['action'] ?? '' );
			$spots  = (int) ( $o['spotsLeft'] ?? 0 );
			$out   .= '<li class="bh-row' . ( 'cancelled' === $status ? ' bh-cancelled' : '' ) . '">';
			$out   .= '<span class="bh-time">' . esc_html( wp_date( get_option( 'time_format' ), $ts, $zone ) ) . '</span>';
			$out   .= '<span class="bh-row-main"><strong>' . esc_html( (string) ( $o['classType']['name'] ?? '' ) ) . '</strong>';
			$meta   = array();
			if ( $a['showInstructor'] && ! empty( $o['instructorName'] ) ) {
				$meta[] = (string) $o['instructorName'];
			}
			if ( 'cancelled' === $status ) {
				$meta[] = __( 'Cancelled', 'branchharbor' );
			} elseif ( $a['showSpots'] ) {
				if ( 'full' === $status ) {
					$meta[] = __( 'Full', 'branchharbor' );
				} elseif ( 'available' === $status ) {
					/* translators: %d: number of spots left */
					$meta[] = sprintf( _n( '%d spot left', '%d spots left', $spots, 'branchharbor' ), $spots );
				}
			}
			if ( $meta ) {
				$out .= '<span class="bh-muted bh-small">' . esc_html( implode( ' · ', $meta ) ) . '</span>';
			}
			$out .= '</span>';
			if ( $booking && in_array( $action, array( 'book', 'join_waitlist' ), true ) ) {
				$label = 'book' === $action ? __( 'Book', 'branchharbor' ) : __( 'Join waitlist', 'branchharbor' );
				$out  .= '<a class="bh-button bh-button-small" href="' . esc_url( add_query_arg( 'occurrence', rawurlencode( (string) $o['id'] ), $booking ) ) . '">' . esc_html( $label ) . '<span class="screen-reader-text"> ' . esc_html( (string) ( $o['classType']['name'] ?? '' ) ) . '</span></a>';
			}
			$out .= '</li>';
		}
		if ( '' !== $day ) {
			$out .= '</ul>';
		}
		/* translators: %s: time zone name */
		$out .= '<p class="bh-muted bh-small">' . esc_html( sprintf( __( 'Times shown in %s.', 'branchharbor' ), $tz ) ) . '</p>';
		return $out . self::stale_note( $entry ) . '</div>';
	}

	/**
	 * @param array<string,mixed> $a
	 */
	private static function menu( array $a, bool $allow_fetch ): string {
		if ( 'off' === Settings::direction( 'menu' ) ) {
			return self::admin_hint( __( 'Menus are turned off in BranchHarbor → Data.', 'branchharbor' ) );
		}
		$loc_id = (string) $a['locationId'];
		if ( '' === $loc_id ) {
			return self::admin_hint( __( 'Choose a location for this menu.', 'branchharbor' ) );
		}
		$entry = self::data( 'menu', $loc_id, array(), $allow_fetch );
		if ( ! $entry ) {
			return self::placeholder( 'menu', $a, __( 'Loading menu…', 'branchharbor' ) );
		}
		$locale     = get_locale();
		$categories = (array) ( $entry['data']['categories'] ?? array() );
		if ( '' !== $a['category'] ) {
			$categories = array_filter( $categories, static fn( $c ) => 0 === strcasecmp( (string) ( $c['name'] ?? '' ), (string) $a['category'] ) );
		}
		$out = self::wrapper_open( 'menu', $a, $entry['fetched_at'] );
		if ( ! $categories ) {
			$out .= '<p class="bh-muted">' . esc_html__( 'The menu is not available yet.', 'branchharbor' ) . '</p>';
		}
		foreach ( $categories as $cat ) {
			$out .= '<h3 class="bh-day">' . esc_html( (string) ( $cat['name'] ?? '' ) ) . '</h3><ul class="bh-list" role="list">';
			foreach ( (array) ( $cat['items'] ?? array() ) as $item ) {
				$available = ! empty( $item['available'] );
				$out      .= '<li class="bh-row' . ( $available ? '' : ' bh-cancelled' ) . '"><span class="bh-row-main"><strong>' . esc_html( (string) ( $item['name'] ?? '' ) ) . '</strong>';
				if ( ! empty( $item['description'] ) ) {
					$out .= '<span class="bh-muted bh-small">' . esc_html( (string) $item['description'] ) . '</span>';
				}
				if ( $a['showDietary'] && ! empty( $item['dietary'] ) && is_array( $item['dietary'] ) ) {
					$out .= '<span class="bh-tags">';
					foreach ( $item['dietary'] as $tag ) {
						$out .= '<span class="bh-tag">' . esc_html( (string) $tag ) . '</span>';
					}
					$out .= '</span>';
				}
				if ( ! $available && ! empty( $item['unavailableReason'] ) ) {
					$out .= '<span class="bh-muted bh-small">' . esc_html( (string) $item['unavailableReason'] ) . '</span>';
				}
				$out .= '</span>';
				if ( $a['showPrices'] && isset( $item['price']['amount'], $item['price']['currency'] ) ) {
					$out .= '<span class="bh-price">' . esc_html( Format::money( (int) $item['price']['amount'], (string) $item['price']['currency'], $locale ) ) . '</span>';
				}
				$out .= '</li>';
			}
			$out .= '</ul>';
		}
		$out .= '<p class="bh-muted bh-small">' . esc_html__( 'Dietary and allergen information is supplied by the business. Ask staff if you have an allergy.', 'branchharbor' ) . '</p>';
		return $out . self::stale_note( $entry ) . '</div>';
	}

	/**
	 * Book / pickup buttons link to the BranchHarbor-hosted flow for the location (or a custom URL).
	 * They never add a second checkout to WooCommerce.
	 *
	 * @param array<string,mixed> $a
	 */
	private static function link_button( string $block, array $a, string $link_key, string $default_label ): string {
		$direction = 'order' === $link_key ? 'menu' : 'schedule';
		if ( 'off' === Settings::direction( $direction ) ) {
			return self::admin_hint( __( 'This content type is turned off in BranchHarbor → Data.', 'branchharbor' ) );
		}
		$url = (string) $a['url'];
		if ( '' === $url && '' !== (string) $a['locationId'] ) {
			$url = (string) ( Settings::location( (string) $a['locationId'] )['links'][ $link_key ] ?? '' );
		}
		if ( '' === $url ) {
			return self::admin_hint( __( 'No booking or ordering page is available for this location yet. Choose a location or enter a link.', 'branchharbor' ) );
		}
		$label = '' !== (string) $a['label'] ? (string) $a['label'] : $default_label;
		$class = 'bh-button' . ( 'outline' === $a['variant'] ? ' bh-button-outline' : '' );
		return '<div class="bh-block bh-' . esc_attr( $block ) . '"><a class="' . esc_attr( $class ) . '" href="' . esc_url( $url ) . '">' . esc_html( $label ) . '</a></div>';
	}

	/**
	 * @param array<string,mixed> $a
	 */
	private static function lead_form( array $a, bool $queued_mode ): string {
		$target = (string) $a['target'];
		if ( 'lead' === $target && 'to_bh' !== Settings::direction( 'forms' ) ) {
			return self::admin_hint( __( 'Enquiry forms are turned off in BranchHarbor → Data.', 'branchharbor' ) );
		}
		if ( 'lead' === $target && '' === (string) $a['locationId'] ) {
			return self::admin_hint( __( 'Choose the location that should receive enquiries from this form.', 'branchharbor' ) );
		}
		if ( 'lead' === $target && ! Settings::has_token() && ! $queued_mode ) {
			return self::admin_hint( __( 'Location enquiries need a full BranchHarbor connection (not public content only).', 'branchharbor' ) );
		}
		$fields = Lead_Mapper::normalise_fields( $a['fields'] ? (array) $a['fields'] : Lead_Mapper::default_fields( $target ), $target );
		$req    = Lead_Mapper::required( $target );
		$cfg    = array(
			'target'       => $target,
			'form_id'      => (string) $a['formId'],
			'location_id'  => 'lead' === $target ? (string) $a['locationId'] : '',
			'fields'       => $fields,
			'industry'     => (string) $a['industry'],
			'consent_text' => (string) $a['consentText'],
		);
		$anchor = 'bh-form-' . sanitize_html_class( (string) $a['formId'] );
		$labels = array(
			'name'              => __( 'Name', 'branchharbor' ),
			'email'             => __( 'Email', 'branchharbor' ),
			'phone'             => __( 'Phone', 'branchharbor' ),
			'message'           => 'demo_request' === $target ? __( 'What’s hardest to manage today?', 'branchharbor' ) : __( 'Message', 'branchharbor' ),
			'business'          => __( 'Business name', 'branchharbor' ),
			'location_count'    => __( 'Number of locations', 'branchharbor' ),
			'country'           => __( 'Country (2-letter code)', 'branchharbor' ),
			'website'           => __( 'Current website', 'branchharbor' ),
			'marketing_consent' => '' !== (string) $a['consentText'] ? (string) $a['consentText'] : __( 'Send me occasional news and offers by email. You can unsubscribe at any time.', 'branchharbor' ),
		);
		$types  = array(
			'email'          => 'email',
			'phone'          => 'tel',
			'website'        => 'url',
			'location_count' => 'number',
		);
		$auto   = array(
			'name'     => 'name',
			'email'    => 'email',
			'phone'    => 'tel',
			'business' => 'organization',
			'country'  => 'country',
			'website'  => 'url',
		);

		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- display-only status flags.
		$status = isset( $_GET['bh_lead'], $_GET['bh_form'] ) && sanitize_key( wp_unslash( $_GET['bh_form'] ) ) === sanitize_key( $anchor ) ? sanitize_key( wp_unslash( $_GET['bh_lead'] ) ) : '';
		$errors = isset( $_GET['bh_err'] ) ? array_map( 'sanitize_key', explode( ',', sanitize_text_field( wp_unslash( $_GET['bh_err'] ) ) ) ) : array();
		// phpcs:enable WordPress.Security.NonceVerification.Recommended

		$out = '<div class="bh-block bh-lead-form" id="' . esc_attr( $anchor ) . '">';
		if ( 'sent' === $status ) {
			$msg  = '' !== (string) $a['successMessage'] ? (string) $a['successMessage'] : __( 'Thanks — your message was sent. The team will reply by email.', 'branchharbor' );
			$out .= '<div class="bh-notice bh-notice-success" role="status">' . esc_html( $msg ) . '</div>';
		} elseif ( 'error' === $status ) {
			$out .= '<div class="bh-notice bh-notice-error" role="alert">' . esc_html( self::form_error_message( $errors, $labels ) ) . '</div>';
		}
		$out .= '<form class="bh-form" method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		$out .= '<input type="hidden" name="action" value="' . esc_attr( Leads::ACTION ) . '">';
		$out .= '<input type="hidden" name="bh_cfg" value="' . esc_attr( Leads::sign_config( $cfg ) ) . '">';
		$out .= '<div class="bh-hp" aria-hidden="true"><label>' . esc_html__( 'Leave this field empty', 'branchharbor' ) . '<input type="text" name="bh_hp" tabindex="-1" autocomplete="off"></label></div>';
		foreach ( $fields as $f ) {
			$id       = $anchor . '-' . $f;
			$required = in_array( $f, $req, true );
			$invalid  = in_array( $f, $errors, true ) ? ' aria-invalid="true"' : '';
			if ( 'marketing_consent' === $f ) {
				$out .= '<p class="bh-field bh-check"><input type="checkbox" id="' . esc_attr( $id ) . '" name="bh_' . esc_attr( $f ) . '" value="1"> <label for="' . esc_attr( $id ) . '">' . esc_html( $labels[ $f ] ) . '</label></p>';
				continue;
			}
			$out .= '<p class="bh-field"><label class="bh-label" for="' . esc_attr( $id ) . '">' . esc_html( $labels[ $f ] ) . ( $required ? ' <span aria-hidden="true">*</span>' : '' ) . '</label>';
			if ( 'message' === $f ) {
				$out .= '<textarea class="bh-input" id="' . esc_attr( $id ) . '" name="bh_message" rows="4" maxlength="2000"' . ( $required ? ' required' : '' ) . $invalid . '></textarea>';
			} else {
				$extra = 'location_count' === $f ? ' min="1" max="10000"' : ( 'country' === $f ? ' maxlength="2" pattern="[A-Za-z]{2}"' : '' );
				$out  .= '<input class="bh-input" type="' . esc_attr( $types[ $f ] ?? 'text' ) . '" id="' . esc_attr( $id ) . '" name="bh_' . esc_attr( $f ) . '"' . ( isset( $auto[ $f ] ) ? ' autocomplete="' . esc_attr( $auto[ $f ] ) . '"' : '' ) . ( $required ? ' required' : '' ) . $extra . $invalid . '>';
			}
			$out .= '</p>';
		}
		$privacy = get_privacy_policy_url();
		if ( $privacy ) {
			/* translators: %s: privacy policy link */
			$out .= '<p class="bh-muted bh-small">' . sprintf( esc_html__( 'Your details are sent to the business through BranchHarbor. See our %s.', 'branchharbor' ), '<a href="' . esc_url( $privacy ) . '">' . esc_html__( 'privacy policy', 'branchharbor' ) . '</a>' ) . '</p>';
		}
		$submit = '' !== (string) $a['submitLabel'] ? (string) $a['submitLabel'] : ( 'demo_request' === $target ? __( 'Request a demo', 'branchharbor' ) : __( 'Send enquiry', 'branchharbor' ) );
		$out   .= '<p><button type="submit" class="bh-button">' . esc_html( $submit ) . '</button></p></form></div>';
		return $out;
	}

	/**
	 * @param string[]             $errors
	 * @param array<string,string> $labels
	 */
	private static function form_error_message( array $errors, array $labels ): string {
		if ( in_array( 'rate', $errors, true ) ) {
			return __( 'Too many messages were sent from your connection. Please try again in a few minutes.', 'branchharbor' );
		}
		if ( in_array( 'form', $errors, true ) || in_array( 'unavailable', $errors, true ) || in_array( 'formid', $errors, true ) || in_array( '_form', $errors, true ) ) {
			return __( 'This form can’t accept messages right now. Please contact the business directly.', 'branchharbor' );
		}
		if ( in_array( 'rejected', $errors, true ) ) {
			return __( 'Your message could not be sent. Check your details and try again.', 'branchharbor' );
		}
		$names = array();
		foreach ( $errors as $e ) {
			if ( isset( $labels[ $e ] ) ) {
				$names[] = $labels[ $e ];
			}
		}
		/* translators: %s: list of field names */
		return $names ? sprintf( __( 'Please check: %s.', 'branchharbor' ), implode( ', ', $names ) ) : __( 'Please check the form and try again.', 'branchharbor' );
	}
}
