<?php
/**
 * Enquiry / demo form field mapping, validation and duplicate-prevention keys. Pure PHP.
 *
 * Two destinations:
 *   'lead'         – location enquiry → POST /v1/connector/wordpress/leads (proposed endpoint).
 *   'demo_request' – BranchHarbor demo/pilot enquiry → POST /v1/public/demo-requests (exists today).
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Lead_Mapper {

	public const TARGETS = array( 'lead', 'demo_request' );

	public const INDUSTRIES = array( 'studios', 'sports', 'wellness', 'commerce', 'foods', 'realty' );

	public const LOCALES = array( 'en', 'en-GB', 'fr', 'es', 'de', 'pt-BR', 'nl', 'it', 'ar' );

	/** Window during which an identical submission is treated as a duplicate. */
	public const DEDUPE_WINDOW = 600;

	/**
	 * Fields a site visitor can be shown, with limits. Keys are the WordPress form field names.
	 *
	 * @return array<string,array{type:string,max:int}>
	 */
	public static function field_specs(): array {
		return array(
			'name'              => array(
				'type' => 'text',
				'max'  => 120,
			),
			'email'             => array(
				'type' => 'email',
				'max'  => 254,
			),
			'phone'             => array(
				'type' => 'tel',
				'max'  => 40,
			),
			'message'           => array(
				'type' => 'textarea',
				'max'  => 2000,
			),
			'business'          => array(
				'type' => 'text',
				'max'  => 160,
			),
			'location_count'    => array(
				'type' => 'number',
				'max'  => 5,
			),
			'country'           => array(
				'type' => 'country',
				'max'  => 3,
			), // Validated to exactly 2; never truncated (AUT ≠ AU).
			'website'           => array(
				'type' => 'url',
				'max'  => 300,
			),
			'marketing_consent' => array(
				'type' => 'checkbox',
				'max'  => 1,
			),
		);
	}

	/**
	 * Required fields per destination.
	 *
	 * @return string[]
	 */
	public static function required( string $target ): array {
		return 'demo_request' === $target
			? array( 'name', 'email', 'business', 'location_count', 'country' )
			: array( 'name', 'email' );
	}

	/**
	 * Default visible fields per destination.
	 *
	 * @return string[]
	 */
	public static function default_fields( string $target ): array {
		return 'demo_request' === $target
			? array( 'name', 'email', 'business', 'location_count', 'country', 'website', 'phone', 'message', 'marketing_consent' )
			: array( 'name', 'email', 'phone', 'message', 'marketing_consent' );
	}

	/**
	 * Normalise a field list from block attributes: known fields only, required ones always present.
	 *
	 * @param string[] $fields
	 * @return string[]
	 */
	public static function normalise_fields( array $fields, string $target ): array {
		$specs = self::field_specs();
		$out   = array();
		foreach ( array_merge( self::required( $target ), $fields ) as $f ) {
			$f = (string) $f;
			if ( isset( $specs[ $f ] ) && ! in_array( $f, $out, true ) ) {
				$out[] = $f;
			}
		}
		return $out;
	}

	/**
	 * Clean a single raw value (already unslashed) by type. Does not use WordPress sanitizers so it
	 * can be unit tested; the controller additionally runs sanitize_text_field() on input.
	 */
	public static function clean( string $field, $raw ): string {
		$specs = self::field_specs();
		if ( ! isset( $specs[ $field ] ) || is_array( $raw ) ) {
			return '';
		}
		$value = trim( (string) $raw );
		$value = preg_replace( '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $value ) ?? '';
		if ( 'textarea' !== $specs[ $field ]['type'] ) {
			$value = preg_replace( '/\s+/u', ' ', $value ) ?? '';
		}
		$value = strip_tags( $value ); // phpcs:ignore WordPress.WP.AlternativeFunctions.strip_tags_strip_tags -- pure helper, no WP available in tests.
		switch ( $specs[ $field ]['type'] ) {
			case 'email':
				$value = strtolower( $value );
				break;
			case 'number':
				$value = preg_replace( '/\D/', '', $value ) ?? '';
				break;
			case 'country':
				$value = strtoupper( preg_replace( '/[^A-Za-z]/', '', $value ) ?? '' );
				break;
			case 'checkbox':
				$value = in_array( strtolower( $value ), array( '1', 'on', 'yes', 'true' ), true ) ? '1' : '';
				break;
		}
		return function_exists( 'mb_substr' ) ? mb_substr( $value, 0, $specs[ $field ]['max'] ) : substr( $value, 0, $specs[ $field ]['max'] );
	}

	/**
	 * Validate and map submitted values to the destination payload.
	 *
	 * @param array<string,mixed> $raw     Submitted values keyed by field name.
	 * @param string[]            $fields  Fields shown on the form.
	 * @param array<string,mixed> $context target, form_id, location_id, page_url, industry, locale, consent_text.
	 * @return array{ok:bool,errors:array<string,string>,payload:array<string,mixed>,values:array<string,string>}
	 */
	public static function map( array $raw, array $fields, array $context ): array {
		$target = in_array( $context['target'] ?? 'lead', self::TARGETS, true ) ? $context['target'] : 'lead';
		$fields = self::normalise_fields( $fields, $target );
		$values = array();
		$errors = array();

		foreach ( $fields as $f ) {
			$values[ $f ] = self::clean( $f, $raw[ $f ] ?? '' );
		}
		foreach ( self::required( $target ) as $f ) {
			if ( '' === ( $values[ $f ] ?? '' ) ) {
				$errors[ $f ] = __( 'This field is required.', 'branchharbor' );
			}
		}
		if ( '' !== ( $values['email'] ?? '' ) && ! filter_var( $values['email'], FILTER_VALIDATE_EMAIL ) ) {
			$errors['email'] = __( 'Enter a valid email address.', 'branchharbor' );
		}
		if ( '' !== ( $values['website'] ?? '' ) ) {
			$url = preg_match( '#^https?://#i', $values['website'] ) ? $values['website'] : 'https://' . $values['website'];
			if ( ! filter_var( $url, FILTER_VALIDATE_URL ) ) {
				$errors['website'] = __( 'Enter a valid website address.', 'branchharbor' );
			} else {
				$values['website'] = $url;
			}
		}
		if ( '' !== ( $values['country'] ?? '' ) && 2 !== strlen( $values['country'] ) ) {
			$errors['country'] = __( 'Use a two-letter country code, for example CA.', 'branchharbor' );
		}
		if ( '' !== ( $values['location_count'] ?? '' ) && ( (int) $values['location_count'] < 1 || (int) $values['location_count'] > 10000 ) ) {
			$errors['location_count'] = __( 'Enter a number between 1 and 10,000.', 'branchharbor' );
		}
		if ( 'lead' === $target && empty( $context['location_id'] ) && empty( $context['allow_org'] ) ) {
			$errors['_form'] = __( 'This form is not linked to a location yet.', 'branchharbor' );
		}

		$marketing = '1' === ( $values['marketing_consent'] ?? '' );
		if ( 'demo_request' === $target ) {
			$industry = in_array( $context['industry'] ?? '', self::INDUSTRIES, true ) ? $context['industry'] : 'studios';
			$locale   = in_array( $context['locale'] ?? '', self::LOCALES, true ) ? $context['locale'] : 'en';
			$payload  = array_filter(
				array(
					'name'              => $values['name'] ?? '',
					'email'             => $values['email'] ?? '',
					'business'          => $values['business'] ?? '',
					'industry'          => $industry,
					'locationCount'     => (int) ( $values['location_count'] ?? 0 ),
					'country'           => $values['country'] ?? '',
					'existingWebsite'   => $values['website'] ?? '',
					'phone'             => $values['phone'] ?? '',
					'primaryDifficulty' => $values['message'] ?? '',
					'locale'            => $locale,
					'marketingConsent'  => $marketing,
				),
				static fn( $v ) => '' !== $v
			);
		} else {
			$payload = array(
				'formId'     => (string) ( $context['form_id'] ?? 'default' ),
				'locationId' => ! empty( $context['location_id'] ) ? (string) $context['location_id'] : null,
				'source'     => 'wordpress',
				'pageUrl'    => (string) ( $context['page_url'] ?? '' ),
				'contact'    => array_filter(
					array(
						'name'  => $values['name'] ?? '',
						'email' => $values['email'] ?? '',
						'phone' => $values['phone'] ?? '',
					),
					static fn( $v ) => '' !== $v
				),
				'message'    => $values['message'] ?? '',
				'consent'    => array(
					'marketing' => $marketing,
					'text'      => (string) ( $context['consent_text'] ?? '' ),
				),
			);
		}

		return array(
			'ok'      => ! $errors,
			'errors'  => $errors,
			'payload' => $payload,
			'values'  => $values,
		);
	}

	/**
	 * Deterministic duplicate-prevention key. The same person sending the same message to the same
	 * location from the same form within the window gets the same key, which is also sent to
	 * BranchHarbor as the Idempotency-Key so a retried/queued delivery cannot create a second lead.
	 *
	 * @param array<string,string> $values
	 */
	public static function dedupe_key( array $values, string $target, string $form_id, string $location_id, int $now, int $window = self::DEDUPE_WINDOW ): string {
		$message = strtolower( preg_replace( '/\s+/u', ' ', trim( $values['message'] ?? '' ) ) ?? '' );
		$bucket  = intdiv( $now, max( 1, $window ) );
		return hash( 'sha256', implode( '|', array( $target, $form_id, strtolower( $location_id ), strtolower( $values['email'] ?? '' ), $message, (string) $bucket ) ) );
	}

	/**
	 * Keys to check for duplicates: the current window and the previous one, so a double submit that
	 * straddles a window boundary is still caught. The first key is the one to record.
	 *
	 * @param array<string,string> $values
	 * @return string[]
	 */
	public static function dedupe_keys( array $values, string $target, string $form_id, string $location_id, int $now, int $window = self::DEDUPE_WINDOW ): array {
		return array(
			self::dedupe_key( $values, $target, $form_id, $location_id, $now, $window ),
			self::dedupe_key( $values, $target, $form_id, $location_id, $now - $window, $window ),
		);
	}
}
