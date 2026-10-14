<?php
/**
 * Plugin Name:       BranchHarbor Connector
 * Plugin URI:        https://branchharbor.com/wordpress
 * Description:       Connect this WordPress site to BranchHarbor for location pages, class schedules, menus, enquiry routing and read-only WooCommerce reporting. Nothing is sent to BranchHarbor until an administrator connects and consents.
 * Version:           1.0.0
 * Requires at least: 6.4
 * Requires PHP:      8.1
 * Author:            BranchHarbor
 * Author URI:        https://branchharbor.com
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       branchharbor
 * WC requires at least: 8.9
 * WC tested up to:   11.2
 *
 * @package BranchHarbor
 */

/*
BranchHarbor Connector is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 2 of the License, or
any later version.

BranchHarbor Connector is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.
*/

defined( 'ABSPATH' ) || exit;

define( 'BRANCHHARBOR_VERSION', '1.0.0' );
define( 'BRANCHHARBOR_FILE', __FILE__ );
define( 'BRANCHHARBOR_DIR', plugin_dir_path( __FILE__ ) );
define( 'BRANCHHARBOR_URL', plugin_dir_url( __FILE__ ) );
define( 'BRANCHHARBOR_MIN_PHP', '8.1' );
define( 'BRANCHHARBOR_MIN_WP', '6.4' );

if ( version_compare( PHP_VERSION, BRANCHHARBOR_MIN_PHP, '<' ) ) {
	add_action(
		'admin_notices',
		static function () {
			echo '<div class="notice notice-error"><p>' . esc_html__( 'BranchHarbor Connector requires PHP 8.1 or newer. The plugin is inactive until PHP is upgraded.', 'branchharbor' ) . '</p></div>';
		}
	);
	return;
}

require_once BRANCHHARBOR_DIR . 'includes/autoload.php';

register_activation_hook( __FILE__, array( \BranchHarbor\Plugin::class, 'activate' ) );
register_deactivation_hook( __FILE__, array( \BranchHarbor\Plugin::class, 'deactivate' ) );

// WooCommerce feature compatibility must be declared before WooCommerce initialises.
add_action( 'before_woocommerce_init', array( \BranchHarbor\WooCommerce::class, 'declare_compatibility' ) );

add_action( 'plugins_loaded', array( \BranchHarbor\Plugin::class, 'instance' ) );
