<?php
/**
 * Multisite: one network-level authorisation plus an explicit location mapping per subsite.
 * Subsites are never connected implicitly — a new subsite starts as "Don’t connect this site".
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Network {

	public static function is_network_active(): bool {
		if ( ! is_multisite() ) {
			return false;
		}
		if ( ! function_exists( 'is_plugin_active_for_network' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		return is_plugin_active_for_network( plugin_basename( BRANCHHARBOR_FILE ) );
	}

	public static function is_network_connection(): bool {
		return is_multisite() && (bool) Settings::connection()['network'];
	}

	/**
	 * @return array<int,array{site_id:int,name:string,url:string,timezone:string,target:string}>
	 */
	public static function sites(): array {
		$out = array();
		foreach ( get_sites(
			array(
				'number'   => 500,
				'fields'   => 'ids',
				'deleted'  => 0,
				'archived' => 0,
			)
		) as $blog_id ) {
			$settings = get_blog_option( (int) $blog_id, Settings::OPT_SETTINGS, array() );
			$target   = is_array( $settings ) && isset( $settings['mapping'] ) ? (string) $settings['mapping'] : Mapping::TARGET_NONE;
			$out[]    = array(
				'site_id'  => (int) $blog_id,
				'name'     => (string) get_blog_option( (int) $blog_id, 'blogname' ),
				'url'      => (string) get_home_url( (int) $blog_id, '/' ),
				'timezone' => Settings::site_timezone( (int) $blog_id ),
				'target'   => $target,
			);
		}
		return $out;
	}

	/**
	 * @return array<string,array{status:string,errors:array,warnings:array,suggestions:string[]}>
	 */
	public static function validate(): array {
		return Mapping::validate( self::sites(), (array) Settings::connection()['locations'] );
	}

	public static function set_target( int $blog_id, string $target ): void {
		switch_to_blog( $blog_id );
		Settings::update( array( 'mapping' => $target ) );
		Cache::invalidate( 'schedule' );
		restore_current_blog();
	}

	/**
	 * Default mapping for subsites created after connecting: not connected until an admin chooses.
	 */
	public static function on_new_site( \WP_Site $site ): void {
		if ( ! self::is_network_active() ) {
			return;
		}
		switch_to_blog( (int) $site->blog_id );
		Connect::add_role();
		if ( false === get_option( Settings::OPT_SETTINGS ) ) {
			Settings::update( array( 'mapping' => Mapping::TARGET_NONE ) );
		}
		restore_current_blog();
	}
}
