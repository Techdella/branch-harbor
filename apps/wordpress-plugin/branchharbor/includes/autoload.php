<?php
/**
 * Minimal PSR-4-style autoloader for the BranchHarbor namespace.
 * BranchHarbor\Foo_Bar => includes/class-foo-bar.php
 *
 * @package BranchHarbor
 */

defined( 'ABSPATH' ) || exit;

spl_autoload_register(
	static function ( string $class_name ): void {
		$prefix = 'BranchHarbor\\';
		if ( 0 !== strpos( $class_name, $prefix ) ) {
			return;
		}
		$relative = substr( $class_name, strlen( $prefix ) );
		if ( false !== strpos( $relative, '\\' ) ) {
			return;
		}
		$file = __DIR__ . '/class-' . strtolower( str_replace( '_', '-', $relative ) ) . '.php';
		if ( is_readable( $file ) ) {
			require_once $file;
		}
	}
);
