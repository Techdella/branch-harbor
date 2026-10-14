<?php
/**
 * Block and shortcode registration. Blocks are dynamic (server-rendered); block.json files live in
 * /blocks/<name>/ and the editor UI is a single plain-JS file using wp.* globals (no build step).
 * Every block has an equivalent shortcode for page builders and the classic editor.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Blocks {

	/**
	 * Block definitions: shortcode name and attribute schema (type, default, and enum/min/max).
	 *
	 * @return array<string,array{shortcode:string,attributes:array<string,array<string,mixed>>}>
	 */
	public static function definitions(): array {
		$location = array(
			'type'    => 'string',
			'default' => '',
		);
		return array(
			'location-finder'     => array(
				'shortcode'  => 'branchharbor_location_finder',
				'attributes' => array(
					'orgSlug'    => array(
						'type'    => 'string',
						'default' => '',
					),
					'country'    => array(
						'type'    => 'string',
						'default' => '',
					),
					'showSearch' => array(
						'type'    => 'boolean',
						'default' => true,
					),
				),
			),
			'class-schedule'      => array(
				'shortcode'  => 'branchharbor_class_schedule',
				'attributes' => array(
					'locationId'     => $location,
					'days'           => array(
						'type'    => 'integer',
						'default' => 7,
						'min'     => 1,
						'max'     => 14,
					),
					'showInstructor' => array(
						'type'    => 'boolean',
						'default' => true,
					),
					'showSpots'      => array(
						'type'    => 'boolean',
						'default' => true,
					),
				),
			),
			'book-button'         => array(
				'shortcode'  => 'branchharbor_book_button',
				'attributes' => array(
					'locationId' => $location,
					'label'      => array(
						'type'    => 'string',
						'default' => '',
					),
					'url'        => array(
						'type'    => 'string',
						'default' => '',
					),
					'variant'    => array(
						'type'    => 'string',
						'default' => 'fill',
						'enum'    => array( 'fill', 'outline' ),
					),
				),
			),
			'menu'                => array(
				'shortcode'  => 'branchharbor_menu',
				'attributes' => array(
					'locationId'  => $location,
					'category'    => array(
						'type'    => 'string',
						'default' => '',
					),
					'showPrices'  => array(
						'type'    => 'boolean',
						'default' => true,
					),
					'showDietary' => array(
						'type'    => 'boolean',
						'default' => true,
					),
				),
			),
			'pickup-order-button' => array(
				'shortcode'  => 'branchharbor_pickup_button',
				'attributes' => array(
					'locationId' => $location,
					'label'      => array(
						'type'    => 'string',
						'default' => '',
					),
					'url'        => array(
						'type'    => 'string',
						'default' => '',
					),
					'variant'    => array(
						'type'    => 'string',
						'default' => 'fill',
						'enum'    => array( 'fill', 'outline' ),
					),
				),
			),
			'lead-form'           => array(
				'shortcode'  => 'branchharbor_lead_form',
				'attributes' => array(
					'locationId'     => $location,
					'target'         => array(
						'type'    => 'string',
						'default' => 'lead',
						'enum'    => Lead_Mapper::TARGETS,
					),
					'formId'         => array(
						'type'    => 'string',
						'default' => 'enquiry',
					),
					'fields'         => array(
						'type'    => 'array',
						'default' => array(),
					),
					'industry'       => array(
						'type'    => 'string',
						'default' => 'studios',
						'enum'    => Lead_Mapper::INDUSTRIES,
					),
					'submitLabel'    => array(
						'type'    => 'string',
						'default' => '',
					),
					'successMessage' => array(
						'type'    => 'string',
						'default' => '',
					),
					'consentText'    => array(
						'type'    => 'string',
						'default' => '',
					),
				),
			),
		);
	}

	public static function register(): void {
		wp_register_style( 'branchharbor-blocks', BRANCHHARBOR_URL . 'assets/css/blocks.css', array(), BRANCHHARBOR_VERSION );
		wp_register_script(
			'branchharbor-blocks-view',
			BRANCHHARBOR_URL . 'assets/js/blocks-view.js',
			array(),
			BRANCHHARBOR_VERSION,
			array(
				'strategy'  => 'defer',
				'in_footer' => true,
			)
		);
		wp_register_script(
			'branchharbor-blocks-editor',
			BRANCHHARBOR_URL . 'blocks/editor.js',
			array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-i18n', 'wp-server-side-render' ),
			BRANCHHARBOR_VERSION,
			true
		);
		wp_set_script_translations( 'branchharbor-blocks-editor', 'branchharbor' );

		foreach ( array_keys( self::definitions() ) as $name ) {
			register_block_type(
				BRANCHHARBOR_DIR . 'blocks/' . $name,
				array(
					'render_callback' => static function ( $attrs ) use ( $name ) {
						$html = Renderer::render( $name, self::sanitize_attributes( $name, (array) $attrs ), self::is_editor_preview() );
						// Wrapper carries alignment/spacing from block supports.
						return '' === $html ? '' : '<div ' . get_block_wrapper_attributes() . '>' . $html . '</div>';
					},
				)
			);
		}
		foreach ( self::definitions() as $name => $def ) {
			add_shortcode( $def['shortcode'], static fn( $atts ) => Renderer::render( $name, self::sanitize_attributes( $name, self::shortcode_atts( $name, (array) $atts ) ), false ) );
		}
		add_action( 'enqueue_block_editor_assets', array( self::class, 'editor_data' ) );
	}

	/**
	 * Data the editor needs: mapped locations and connection state (no secrets).
	 */
	public static function editor_data(): void {
		$c = Settings::connection();
		wp_add_inline_script(
			'branchharbor-blocks-editor',
			'window.branchharborEditor = ' . wp_json_encode(
				array(
					'connected'       => Settings::can_call(),
					'state'           => $c['state'],
					'defaultLocation' => Settings::default_location_id(),
					'orgSlug'         => (string) ( $c['organization']['slug'] ?? '' ),
					'locations'       => array_map(
						static fn( $l ) => array(
							'value' => $l['id'],
							'label' => $l['name'],
						),
						(array) $c['locations']
					),
					'settingsUrl'     => admin_url( 'options-general.php?page=branchharbor' ),
				)
			) . ';',
			'before'
		);
	}

	/**
	 * Server-side render requests from the editor (ServerSideRender) may fetch synchronously.
	 */
	private static function is_editor_preview(): bool {
		return defined( 'REST_REQUEST' ) && REST_REQUEST && current_user_can( 'edit_posts' );
	}

	/**
	 * Shortcode attributes are lower-case snake/one-word; map them to block attribute names.
	 *
	 * @param array<string,mixed> $atts
	 * @return array<string,mixed>
	 */
	public static function shortcode_atts( string $block, array $atts ): array {
		$out = array();
		foreach ( array_keys( self::definitions()[ $block ]['attributes'] ) as $attr ) {
			$keys = array_unique( array( strtolower( $attr ), strtolower( preg_replace( '/([a-z])([A-Z])/', '$1_$2', $attr ) ) ) );
			if ( 'locationId' === $attr ) {
				$keys[] = 'location';
			}
			if ( 'orgSlug' === $attr ) {
				$keys[] = 'org';
			}
			foreach ( $keys as $k ) {
				if ( isset( $atts[ $k ] ) ) {
					$out[ $attr ] = $atts[ $k ];
					break;
				}
			}
		}
		if ( isset( $out['fields'] ) && is_string( $out['fields'] ) ) {
			$out['fields'] = array_filter( array_map( 'trim', explode( ',', $out['fields'] ) ) );
		}
		return $out;
	}

	/**
	 * Whitelist + type-coerce attributes from blocks, shortcodes or the REST render route.
	 *
	 * @param array<string,mixed> $input
	 * @return array<string,mixed>
	 */
	public static function sanitize_attributes( string $block, array $input ): array {
		$defs = self::definitions();
		if ( ! isset( $defs[ $block ] ) ) {
			return array();
		}
		$out = array();
		foreach ( $defs[ $block ]['attributes'] as $name => $spec ) {
			$v = $input[ $name ] ?? $spec['default'];
			switch ( $spec['type'] ) {
				case 'boolean':
					$v = is_bool( $v ) ? $v : in_array( strtolower( (string) $v ), array( '1', 'true', 'yes', 'on' ), true );
					break;
				case 'integer':
					$v = (int) $v;
					$v = max( $spec['min'] ?? PHP_INT_MIN, min( $spec['max'] ?? PHP_INT_MAX, $v ) );
					break;
				case 'array':
					$v = is_string( $v ) ? explode( ',', $v ) : $v;
					$v = is_array( $v ) ? array_values( array_filter( array_map( 'sanitize_key', array_map( 'strval', $v ) ) ) ) : array();
					break;
				default:
					$v = is_scalar( $v ) ? (string) $v : '';
					$v = 'url' === $name ? esc_url_raw( $v, array( 'https', 'http' ) ) : sanitize_text_field( $v );
			}
			if ( isset( $spec['enum'] ) && ! in_array( $v, $spec['enum'], true ) ) {
				$v = $spec['default'];
			}
			$out[ $name ] = $v;
		}
		if ( array_key_exists( 'locationId', $out ) ) {
			$loc = strtolower( (string) $out['locationId'] );
			// Only locations of the connected organisation; otherwise this site's mapped location.
			$out['locationId'] = Mapping::is_uuid( $loc ) && Settings::location( $loc ) ? $loc : Settings::default_location_id();
		}
		if ( array_key_exists( 'orgSlug', $out ) ) {
			$own            = (string) ( Settings::connection()['organization']['slug'] ?? '' );
			$out['orgSlug'] = $own; // Location finder only lists the connected organisation.
		}
		if ( array_key_exists( 'country', $out ) ) {
			$out['country'] = strtoupper( substr( preg_replace( '/[^A-Za-z]/', '', (string) $out['country'] ) ?? '', 0, 2 ) );
		}
		if ( array_key_exists( 'formId', $out ) ) {
			$form_id       = sanitize_key( (string) $out['formId'] );
			$out['formId'] = '' !== $form_id ? $form_id : 'enquiry';
		}
		return $out;
	}
}
