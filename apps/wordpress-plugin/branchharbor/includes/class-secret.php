<?php
/**
 * At-rest protection for the site token and webhook secret stored in wp_options.
 *
 * Values are sealed with libsodium secretbox using a key derived from the site's AUTH salt, so a
 * database dump alone does not reveal the token. If the salts rotate, opening fails and the
 * connection is reported as "authorisation expired" — the admin reconnects; nothing breaks.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Secret {

	private const PREFIX = 'bhs1:';

	public static function key_from( string $material ): string {
		return hash( 'sha256', 'branchharbor-secret-v1|' . $material, true );
	}

	public static function seal( string $plain, string $key ): string {
		if ( '' === $plain ) {
			return '';
		}
		if ( ! function_exists( 'sodium_crypto_secretbox' ) ) {
			// Sodium is bundled with PHP 7.2+ and WordPress ships a polyfill, so this is a last resort.
			return 'plain:' . base64_encode( $plain ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
		}
		$nonce = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		return self::PREFIX . base64_encode( $nonce . sodium_crypto_secretbox( $plain, $nonce, $key ) ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
	}

	/**
	 * @return string|null Null when the value cannot be opened (tampered, or salts rotated).
	 */
	public static function open( string $sealed, string $key ): ?string {
		if ( '' === $sealed ) {
			return '';
		}
		if ( 0 === strpos( $sealed, 'plain:' ) ) {
			$v = base64_decode( substr( $sealed, 6 ), true ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
			return false === $v ? null : $v;
		}
		if ( 0 !== strpos( $sealed, self::PREFIX ) || ! function_exists( 'sodium_crypto_secretbox_open' ) ) {
			return null;
		}
		$raw = base64_decode( substr( $sealed, strlen( self::PREFIX ) ), true ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		if ( false === $raw || strlen( $raw ) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ) {
			return null;
		}
		$nonce = substr( $raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$box   = substr( $raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$plain = sodium_crypto_secretbox_open( $box, $nonce, $key );
		return false === $plain ? null : $plain;
	}

	/**
	 * Key for this WordPress install.
	 */
	public static function site_key(): string {
		return self::key_from( wp_salt( 'auth' ) );
	}
}
