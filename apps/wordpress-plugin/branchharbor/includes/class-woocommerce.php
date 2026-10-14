<?php
/**
 * WooCommerce integration: read-only export of products and orders (WordPress → BranchHarbor).
 *
 * - Declares compatibility with High-Performance Order Storage and cart/checkout blocks.
 * - Uses only WooCommerce CRUD/query APIs (wc_get_orders, wc_get_order, wc_get_products) — never
 *   postmeta or order tables directly — so HPOS and legacy storage behave the same.
 * - Hooks only record ids; payloads are built and sent by a background job in batches.
 * - Never modifies orders/products and never adds a checkout. Customer personal data is not sent.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class WooCommerce {

	private const BATCH          = 50;
	private const MAX_PENDING    = 5000;
	private const OPT_INITIAL    = 'branchharbor_woo_initial';
	private const INITIAL_WINDOW = 90 * DAY_IN_SECONDS;

	public static function declare_compatibility(): void {
		if ( class_exists( '\Automattic\WooCommerce\Utilities\FeaturesUtil' ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', BRANCHHARBOR_FILE, true );
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', BRANCHHARBOR_FILE, true );
		}
	}

	public static function active(): bool {
		return class_exists( '\WooCommerce' ) && function_exists( 'wc_get_orders' );
	}

	public static function hpos_enabled(): ?bool {
		if ( class_exists( '\Automattic\WooCommerce\Utilities\OrderUtil' ) && method_exists( '\Automattic\WooCommerce\Utilities\OrderUtil', 'custom_orders_table_usage_is_enabled' ) ) {
			return (bool) \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled();
		}
		return null;
	}

	public static function register(): void {
		if ( ! self::active() ) {
			return;
		}
		add_action( 'woocommerce_new_order', static fn( $id ) => self::queue( 'order', (int) $id ) );
		add_action( 'woocommerce_update_order', static fn( $id ) => self::queue( 'order', (int) $id ) );
		add_action( 'woocommerce_order_refunded', static fn( $id ) => self::queue( 'order', (int) $id ) );
		add_action( 'woocommerce_trash_order', static fn( $id ) => self::queue( 'order_deleted', (int) $id ) );
		add_action( 'woocommerce_delete_order', static fn( $id ) => self::queue( 'order_deleted', (int) $id ) );
		add_action( 'woocommerce_new_product', static fn( $id ) => self::queue( 'product', (int) $id ) );
		add_action( 'woocommerce_update_product', static fn( $id ) => self::queue( 'product', (int) $id ) );
		add_action( 'woocommerce_delete_product', static fn( $id ) => self::queue( 'product_deleted', (int) $id ) );
		add_action( 'woocommerce_trash_product', static fn( $id ) => self::queue( 'product_deleted', (int) $id ) );
	}

	private static function enabled_for( string $kind ): bool {
		$type = 0 === strpos( $kind, 'order' ) ? 'woo_orders' : 'woo_products';
		return 'to_bh' === Settings::direction( $type ) && Settings::can_call() && Settings::has_token();
	}

	/**
	 * Record an id for export. Cheap: one option write, then a deduplicated background job.
	 */
	public static function queue( string $kind, int $id ): void {
		if ( $id <= 0 || ! self::enabled_for( $kind ) ) {
			return;
		}
		$pending = self::pending();
		if ( ! isset( $pending[ $kind ] ) ) {
			$pending[ $kind ] = array();
		}
		$pending[ $kind ][ $id ] = time();
		if ( count( $pending[ $kind ] ) > self::MAX_PENDING ) {
			$pending[ $kind ] = array_slice( $pending[ $kind ], -self::MAX_PENDING, null, true );
		}
		update_option( Settings::OPT_WOO, $pending, false );
		Jobs::enqueue( Jobs::HOOK_FLUSH_WOO, array(), 60 );
	}

	/**
	 * @return array<string,array<int,int>>
	 */
	public static function pending(): array {
		$p = get_option( Settings::OPT_WOO, array() );
		return is_array( $p ) ? $p : array();
	}

	public static function pending_count(): int {
		return array_sum( array_map( 'count', self::pending() ) );
	}

	/**
	 * Send pending records in batches. Background job.
	 */
	public static function flush(): void {
		if ( ! self::active() || ! Settings::can_call() || ! Settings::has_token() ) {
			return;
		}
		$pending = self::pending();
		$events  = array();
		$taken   = array();
		foreach ( $pending as $kind => $ids ) {
			foreach ( array_keys( $ids ) as $id ) {
				if ( count( $events ) >= self::BATCH ) {
					break 2;
				}
				$event = self::event( (string) $kind, (int) $id );
				if ( $event ) {
					$events[] = $event;
				}
				$taken[ $kind ][] = $id;
			}
		}
		if ( ! $taken ) {
			return;
		}
		if ( $events ) {
			$key = hash( 'sha256', wp_json_encode( array_column( $events, 'id' ) ) );
			$res = Api_Client::events( $events, $key );
			if ( is_wp_error( $res ) ) {
				Activity::log(
					'woo_export_failed',
					array(
						'count' => self::pending_count(),
						'code'  => $res->get_error_code(),
					),
					'warning'
				);
				Settings::update_connection( array( 'affected_records' => self::pending_count() ) );
				return; // Keep pending; the hourly job retries.
			}
			Activity::log( 'woo_exported', array( 'count' => count( $events ) ) );
		}
		$pending = self::pending(); // Re-read: hooks may have added ids meanwhile.
		foreach ( $taken as $kind => $ids ) {
			foreach ( $ids as $id ) {
				unset( $pending[ $kind ][ $id ] );
			}
		}
		update_option( Settings::OPT_WOO, array_filter( $pending ), false );
		$left = self::pending_count();
		Settings::update_connection( array( 'affected_records' => $left ) );
		if ( $left > 0 ) {
			Jobs::enqueue( Jobs::HOOK_FLUSH_WOO, array(), 5 );
		}
	}

	/**
	 * Build an export event for a pending id.
	 *
	 * @return array<string,mixed>|null
	 */
	private static function event( string $kind, int $id ): ?array {
		$now = gmdate( 'c' );
		if ( 'order_deleted' === $kind || 'product_deleted' === $kind ) {
			$entity = 'order_deleted' === $kind ? 'order' : 'product';
			return array(
				'id'         => "wc.{$entity}.{$id}.deleted",
				'type'       => "woocommerce.{$entity}.deleted",
				'occurredAt' => $now,
				'data'       => array( 'externalId' => (string) $id ),
			);
		}
		if ( 'order' === $kind ) {
			$order = wc_get_order( $id );
			if ( ! $order || ! is_a( $order, '\WC_Order' ) || is_a( $order, '\WC_Order_Refund' ) ) {
				return null;
			}
			$data = self::order_payload( $order );
		} else {
			$product = wc_get_product( $id );
			if ( ! $product ) {
				return null;
			}
			$data = self::product_payload( $product );
		}
		return array(
			'id'         => "wc.{$kind}.{$id}." . ( $data['modifiedAt'] ? strtotime( $data['modifiedAt'] ) : time() ),
			'type'       => "woocommerce.{$kind}.upserted",
			'occurredAt' => $now,
			'data'       => $data,
		);
	}

	/**
	 * Order payload — amounts in integer minor units with currency, UTC timestamps, no customer PII.
	 *
	 * @param \WC_Order $order
	 * @return array<string,mixed>
	 */
	public static function order_payload( $order ): array {
		$currency = (string) $order->get_currency();
		$minor    = static fn( $v ) => Format::to_minor( wc_format_decimal( (string) $v ), $currency );
		$items    = array();
		foreach ( $order->get_items() as $item ) {
			if ( ! is_a( $item, '\WC_Order_Item_Product' ) ) {
				continue;
			}
			$product = $item->get_product();
			$items[] = array(
				'productId'   => (string) $item->get_product_id(),
				'variationId' => $item->get_variation_id() ? (string) $item->get_variation_id() : null,
				'sku'         => $product ? (string) $product->get_sku() : '',
				'name'        => (string) $item->get_name(),
				'quantity'    => (int) $item->get_quantity(),
				'total'       => $minor( $item->get_total() ),
			);
		}
		$created  = $order->get_date_created();
		$modified = $order->get_date_modified();
		$paid     = $order->get_date_paid();
		return array(
			'externalId' => (string) $order->get_id(),
			'number'     => (string) $order->get_order_number(),
			'status'     => (string) $order->get_status(),
			'currency'   => $currency,
			'total'      => $minor( $order->get_total() ),
			'subtotal'   => $minor( $order->get_subtotal() ),
			'tax'        => $minor( $order->get_total_tax() ),
			'shipping'   => $minor( $order->get_shipping_total() ),
			'discount'   => $minor( $order->get_discount_total() ),
			'refunded'   => $minor( $order->get_total_refunded() ),
			'createdVia' => (string) $order->get_created_via(),
			'createdAt'  => $created ? gmdate( 'c', $created->getTimestamp() ) : null,
			'modifiedAt' => $modified ? gmdate( 'c', $modified->getTimestamp() ) : null,
			'paidAt'     => $paid ? gmdate( 'c', $paid->getTimestamp() ) : null,
			'items'      => $items,
			'customer'   => array( 'registered' => (bool) $order->get_customer_id() ),
			'siteTarget' => (string) Settings::get( 'mapping' ),
		);
	}

	/**
	 * @param \WC_Product $product
	 * @return array<string,mixed>
	 */
	public static function product_payload( $product ): array {
		$currency = function_exists( 'get_woocommerce_currency' ) ? (string) get_woocommerce_currency() : 'USD';
		$price    = (string) $product->get_price();
		$modified = $product->get_date_modified();
		return array(
			'externalId'  => (string) $product->get_id(),
			'parentId'    => $product->get_parent_id() ? (string) $product->get_parent_id() : null,
			'type'        => (string) $product->get_type(),
			'status'      => (string) $product->get_status(),
			'sku'         => (string) $product->get_sku(),
			'name'        => (string) $product->get_name(),
			'price'       => '' === $price ? null : array(
				'amount'   => Format::to_minor( wc_format_decimal( $price ), $currency ),
				'currency' => $currency,
			),
			'manageStock' => (bool) $product->get_manage_stock(),
			'stock'       => $product->get_manage_stock() ? (int) $product->get_stock_quantity() : null,
			'stockStatus' => (string) $product->get_stock_status(),
			'variations'  => array_map( 'strval', (array) $product->get_children() ),
			'modifiedAt'  => $modified ? gmdate( 'c', $modified->getTimestamp() ) : null,
		);
	}

	/**
	 * Initial export: queue ids page by page (last 90 days of orders; all published products).
	 */
	public static function initial_batch( string $type, int $page ): void {
		if ( ! self::active() || ! self::enabled_for( $type ) ) {
			delete_option( self::OPT_INITIAL );
			return;
		}
		if ( 'order' === $type ) {
			$ids = wc_get_orders(
				array(
					'limit'         => self::BATCH,
					'page'          => max( 1, $page ),
					'return'        => 'ids',
					'orderby'       => 'ID',
					'order'         => 'ASC',
					'type'          => 'shop_order',
					'date_modified' => '>' . ( time() - (int) apply_filters( 'branchharbor_initial_order_window', self::INITIAL_WINDOW ) ),
				)
			);
		} else {
			$ids = wc_get_products(
				array(
					'limit'   => self::BATCH,
					'page'    => max( 1, $page ),
					'return'  => 'ids',
					'orderby' => 'ID',
					'order'   => 'ASC',
					'status'  => array( 'publish', 'private' ),
				)
			);
		}
		$ids               = array_map( 'intval', (array) $ids );
		$progress          = get_option( self::OPT_INITIAL, array() );
		$progress          = is_array( $progress ) ? $progress : array();
		$progress[ $type ] = array(
			'page' => $page,
			'done' => count( $ids ) < self::BATCH,
		);
		update_option( self::OPT_INITIAL, $progress, false );

		foreach ( $ids as $id ) {
			self::queue( $type, $id );
		}
		if ( count( $ids ) === self::BATCH ) {
			Jobs::enqueue( Jobs::HOOK_INITIAL_WOO, array( $type, $page + 1 ), 30 );
		}
		if ( ! self::initial_sync_running() ) {
			delete_option( self::OPT_INITIAL );
		}
	}

	public static function initial_sync_running(): bool {
		$progress = get_option( self::OPT_INITIAL, array() );
		if ( ! is_array( $progress ) || ! $progress ) {
			return false;
		}
		foreach ( $progress as $p ) {
			if ( empty( $p['done'] ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Read-only page for the pull endpoint (GET /wp-json/branchharbor/v1/woocommerce/{orders|products}).
	 *
	 * @return array{items:array<int,array<string,mixed>>,page:int,hasMore:bool}
	 */
	public static function export_page( string $type, int $page, int $per_page, ?int $modified_after ): array {
		$args = array(
			'limit'   => $per_page,
			'page'    => max( 1, $page ),
			'orderby' => 'ID',
			'order'   => 'ASC',
		);
		if ( $modified_after ) {
			$args['date_modified'] = '>' . $modified_after;
		}
		$items = array();
		if ( 'order' === $type ) {
			$args['type'] = 'shop_order';
			foreach ( wc_get_orders( $args ) as $order ) {
				$items[] = self::order_payload( $order );
			}
		} else {
			$args['status'] = array( 'publish', 'private' );
			foreach ( wc_get_products( $args ) as $product ) {
				$items[] = self::product_payload( $product );
			}
		}
		return array(
			'items'   => $items,
			'page'    => max( 1, $page ),
			'hasMore' => count( $items ) === $per_page,
		);
	}
}
