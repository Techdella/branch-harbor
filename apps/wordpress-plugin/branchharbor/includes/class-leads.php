<?php
/**
 * Enquiry / demo form submissions.
 *
 * - Forms post to admin-post.php (works without JavaScript and inside any page builder).
 * - The form's configuration (destination, location, visible fields) is signed with an HMAC so a
 *   visitor cannot re-route a submission to another location or add fields.
 * - Duplicate prevention: identical submissions within 10 minutes are accepted once; the same key
 *   is sent to BranchHarbor as Idempotency-Key so retries never create a second lead.
 * - If BranchHarbor is unreachable or authorisation expired, the enquiry is queued on this site and
 *   retried hourly for up to 7 days. Queued entries are deleted on delivery, expiry or uninstall.
 *
 * Nonces are deliberately not used for the public form: pages are often served from full-page
 * caches, where a nonce would expire and block genuine visitors. The form performs no privileged
 * action; abuse is limited by the signed configuration, a honeypot field and a per-IP rate limit.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Leads {

	public const ACTION     = 'branchharbor_lead';
	private const MAX_QUEUE = 200;
	private const QUEUE_TTL = 7 * DAY_IN_SECONDS;
	private const RATE_MAX  = 5;
	private const RATE_SPAN = 600;

	public static function register(): void {
		add_action( 'admin_post_' . self::ACTION, array( self::class, 'handle' ) );
		add_action( 'admin_post_nopriv_' . self::ACTION, array( self::class, 'handle' ) );
	}

	/**
	 * Sign a form configuration.
	 *
	 * @param array<string,mixed> $config
	 */
	public static function sign_config( array $config ): string {
		$json = (string) wp_json_encode( $config );
		$b64  = rtrim( strtr( base64_encode( $json ), '+/', '-_' ), '=' ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
		return $b64 . '.' . hash_hmac( 'sha256', $b64, wp_salt( 'nonce' ) . '|branchharbor-form' );
	}

	/**
	 * @return array<string,mixed>|null
	 */
	public static function verify_config( string $signed ): ?array {
		$parts = explode( '.', $signed );
		if ( 2 !== count( $parts ) ) {
			return null;
		}
		[ $b64, $mac ] = $parts;
		if ( ! hash_equals( hash_hmac( 'sha256', $b64, wp_salt( 'nonce' ) . '|branchharbor-form' ), $mac ) ) {
			return null;
		}
		$json = base64_decode( strtr( $b64, '-_', '+/' ), true ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		$cfg  = false === $json ? null : json_decode( $json, true );
		return is_array( $cfg ) ? $cfg : null;
	}

	/**
	 * Handle a submission and redirect back to the page.
	 */
	public static function handle(): void {
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- public form; see class docblock.
		$signed = isset( $_POST['bh_cfg'] ) ? sanitize_text_field( wp_unslash( $_POST['bh_cfg'] ) ) : '';
		$trap   = isset( $_POST['bh_hp'] ) ? sanitize_text_field( wp_unslash( $_POST['bh_hp'] ) ) : '';
		$raw    = array();
		foreach ( array_keys( Lead_Mapper::field_specs() ) as $field ) {
			if ( isset( $_POST[ 'bh_' . $field ] ) && ! is_array( $_POST[ 'bh_' . $field ] ) ) {
				$raw[ $field ] = 'message' === $field
					? sanitize_textarea_field( wp_unslash( $_POST[ 'bh_' . $field ] ) )
					: sanitize_text_field( wp_unslash( $_POST[ 'bh_' . $field ] ) );
			}
		}
		// phpcs:enable WordPress.Security.NonceVerification.Missing
		$cfg    = self::verify_config( $signed );
		$anchor = $cfg ? 'bh-form-' . sanitize_html_class( (string) $cfg['form_id'] ) : '';
		$back   = wp_get_referer();
		$back   = $back ? $back : home_url( '/' );

		if ( ! $cfg ) {
			self::redirect( $back, 'error', 'form', $anchor );
		}
		if ( '' !== $trap ) {
			self::redirect( $back, 'sent', '', $anchor ); // Pretend success to bots.
		}
		if ( self::rate_limited() ) {
			self::redirect( $back, 'error', 'rate', $anchor );
		}
		if ( 'lead' === $cfg['target'] && 'to_bh' !== Settings::direction( 'forms' ) ) {
			self::redirect( $back, 'error', 'unavailable', $anchor );
		}

		$mapped = Lead_Mapper::map(
			$raw,
			(array) $cfg['fields'],
			array(
				'target'       => $cfg['target'],
				'form_id'      => $cfg['form_id'],
				'location_id'  => $cfg['location_id'],
				'allow_org'    => false,
				'page_url'     => esc_url_raw( $back ),
				'industry'     => $cfg['industry'] ?? '',
				'locale'       => self::api_locale(),
				'consent_text' => $cfg['consent_text'] ?? '',
			)
		);
		if ( ! $mapped['ok'] ) {
			self::redirect( $back, 'error', implode( ',', array_map( 'sanitize_key', array_keys( $mapped['errors'] ) ) ), $anchor );
		}

		$keys = Lead_Mapper::dedupe_keys( $mapped['values'], (string) $cfg['target'], (string) $cfg['form_id'], (string) $cfg['location_id'], time() );
		foreach ( $keys as $k ) {
			if ( get_transient( 'branchharbor_ld_' . substr( $k, 0, 32 ) ) ) {
				self::redirect( $back, 'sent', '', $anchor ); // Duplicate: already accepted.
			}
		}
		set_transient( 'branchharbor_ld_' . substr( $keys[0], 0, 32 ), 1, 2 * Lead_Mapper::DEDUPE_WINDOW );

		$result = self::deliver( (string) $cfg['target'], $mapped['payload'], $keys[0] );
		if ( 'rejected' === $result ) {
			delete_transient( 'branchharbor_ld_' . substr( $keys[0], 0, 32 ) );
			self::redirect( $back, 'error', 'rejected', $anchor );
		}
		if ( 'queue' === $result ) {
			self::enqueue( (string) $cfg['target'], $mapped['payload'], $keys[0] );
		}
		self::redirect( $back, 'sent', '', $anchor );
	}

	/**
	 * Try to deliver now.
	 *
	 * @param array<string,mixed> $payload
	 * @return string sent | queue | rejected
	 */
	private static function deliver( string $target, array $payload, string $key ): string {
		$state = (string) Settings::connection()['state'];
		if ( ! Settings::consent()['granted'] ) {
			return 'rejected';
		}
		if ( ! Settings::can_call() ) {
			return Connection_Status::EXPIRED === $state ? 'queue' : 'rejected';
		}
		if ( 'demo_request' === $target ) {
			$res = Api_Client::demo_request( $payload );
		} else {
			if ( ! Settings::has_token() ) {
				return 'rejected';
			}
			$res = Api_Client::lead( $payload, $key );
		}
		if ( ! is_wp_error( $res ) ) {
			Activity::log( 'lead_sent', array( 'target' => $target ) );
			return 'sent';
		}
		$status = (int) ( $res->get_error_data()['status'] ?? 0 );
		if ( 409 === $status ) {
			return 'sent'; // Idempotency conflict: BranchHarbor already has it.
		}
		if ( in_array( $status, array( 400, 422 ), true ) ) {
			return 'rejected';
		}
		return 'queue'; // Unreachable, 5xx, 429, auth expired, or endpoint not live yet.
	}

	/**
	 * @param array<string,mixed> $payload
	 */
	private static function enqueue( string $target, array $payload, string $key ): void {
		$queue = self::queue();
		foreach ( $queue as $item ) {
			if ( $item['key'] === $key ) {
				return;
			}
		}
		$queue[] = array(
			'key'      => $key,
			'target'   => $target,
			'payload'  => $payload,
			'attempts' => 0,
			'first_at' => time(),
		);
		update_option( Settings::OPT_LEADS, array_slice( $queue, -self::MAX_QUEUE ), false );
		Activity::log( 'lead_queued', array( 'target' => $target ), 'warning' );
		Jobs::enqueue( Jobs::HOOK_FLUSH_LEADS, array(), 300 );
	}

	/**
	 * @return array<int,array{key:string,target:string,payload:array<string,mixed>,attempts:int,first_at:int}>
	 */
	public static function queue(): array {
		$q = get_option( Settings::OPT_LEADS, array() );
		return is_array( $q ) ? array_values( $q ) : array();
	}

	/**
	 * Retry queued enquiries. Background job.
	 */
	public static function flush_queue(): void {
		$queue = self::queue();
		if ( ! $queue || ! Settings::can_call() ) {
			return;
		}
		$keep    = array();
		$dropped = 0;
		foreach ( $queue as $item ) {
			if ( time() - (int) $item['first_at'] > self::QUEUE_TTL ) {
				++$dropped;
				continue;
			}
			$result = self::deliver( (string) $item['target'], (array) $item['payload'], (string) $item['key'] );
			if ( 'queue' === $result ) {
				$item['attempts'] = (int) $item['attempts'] + 1;
				$keep[]           = $item;
			}
		}
		if ( $dropped ) {
			Activity::log( 'lead_dropped', array( 'count' => $dropped ), 'error' );
		}
		update_option( Settings::OPT_LEADS, $keep, false );
	}

	private static function rate_limited(): bool {
		$ip  = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';
		$key = 'branchharbor_rl_' . substr( hash( 'sha256', $ip . wp_salt( 'nonce' ) ), 0, 24 );
		$n   = (int) get_transient( $key );
		if ( $n >= self::RATE_MAX ) {
			return true;
		}
		set_transient( $key, $n + 1, self::RATE_SPAN );
		return false;
	}

	/**
	 * Map the WordPress locale to the nearest locale BranchHarbor supports.
	 */
	public static function api_locale(): string {
		$wp = str_replace( '_', '-', get_locale() );
		if ( in_array( $wp, Lead_Mapper::LOCALES, true ) ) {
			return $wp;
		}
		$lang = strtolower( substr( $wp, 0, 2 ) );
		if ( 'pt' === $lang ) {
			return 'pt-BR';
		}
		return in_array( $lang, Lead_Mapper::LOCALES, true ) ? $lang : 'en';
	}

	/**
	 * @return never
	 */
	private static function redirect( string $back, string $status, string $code, string $anchor ): void {
		$url = remove_query_arg( array( 'bh_lead', 'bh_err', 'bh_form' ), $back );
		$url = add_query_arg(
			array_filter(
				array(
					'bh_lead' => $status,
					'bh_err'  => $code,
					'bh_form' => $anchor,
				)
			),
			$url
		);
		wp_safe_redirect( $url . ( $anchor ? '#' . $anchor : '' ), 303 );
		exit;
	}
}
