/**
 * BranchHarbor block editor UI. Plain ES5-compatible JavaScript using the wp.* globals, so the
 * plugin ships without a build step. Blocks are dynamic: the preview is server-rendered and
 * save() returns null.
 */
( function ( wp, data ) {
	'use strict';

	if ( ! wp || ! wp.blocks || ! wp.element ) {
		return;
	}

	var el = wp.element.createElement;
	var Fragment = wp.element.Fragment;
	var __ = wp.i18n.__;
	var be = wp.blockEditor;
	var c = wp.components;
	var ServerSideRender = wp.serverSideRender;
	data = data || { locations: [], connected: false, settingsUrl: '' };

	var FIELD_OPTIONS = [
		{ value: 'name', label: __( 'Name', 'branchharbor' ) },
		{ value: 'email', label: __( 'Email', 'branchharbor' ) },
		{ value: 'phone', label: __( 'Phone', 'branchharbor' ) },
		{ value: 'message', label: __( 'Message', 'branchharbor' ) },
		{ value: 'business', label: __( 'Business name', 'branchharbor' ) },
		{ value: 'location_count', label: __( 'Number of locations', 'branchharbor' ) },
		{ value: 'country', label: __( 'Country', 'branchharbor' ) },
		{ value: 'website', label: __( 'Current website', 'branchharbor' ) },
		{ value: 'marketing_consent', label: __( 'Marketing consent checkbox', 'branchharbor' ) }
	];

	function locationControl( props ) {
		var options = [ { value: '', label: __( 'This site’s location', 'branchharbor' ) } ].concat( data.locations || [] );
		return el( c.SelectControl, {
			label: __( 'Location', 'branchharbor' ),
			value: props.attributes.locationId,
			options: options,
			onChange: function ( v ) { props.setAttributes( { locationId: v } ); },
			__nextHasNoMarginBottom: true
		} );
	}

	function text( props, key, label, help ) {
		return el( c.TextControl, {
			label: label,
			help: help,
			value: props.attributes[ key ] || '',
			onChange: function ( v ) { var o = {}; o[ key ] = v; props.setAttributes( o ); },
			__nextHasNoMarginBottom: true
		} );
	}

	function toggle( props, key, label ) {
		return el( c.ToggleControl, {
			label: label,
			checked: !! props.attributes[ key ],
			onChange: function ( v ) { var o = {}; o[ key ] = v; props.setAttributes( o ); },
			__nextHasNoMarginBottom: true
		} );
	}

	function select( props, key, label, options ) {
		return el( c.SelectControl, {
			label: label,
			value: props.attributes[ key ],
			options: options,
			onChange: function ( v ) { var o = {}; o[ key ] = v; props.setAttributes( o ); },
			__nextHasNoMarginBottom: true
		} );
	}

	var controls = {
		'location-finder': function ( p ) {
			return [
				text( p, 'country', __( 'Country filter', 'branchharbor' ), __( 'Two-letter code, e.g. CA. Leave empty for all.', 'branchharbor' ) ),
				toggle( p, 'showSearch', __( 'Show search box', 'branchharbor' ) )
			];
		},
		'class-schedule': function ( p ) {
			return [
				locationControl( p ),
				el( c.RangeControl, {
					label: __( 'Days to show', 'branchharbor' ),
					value: p.attributes.days,
					min: 1,
					max: 14,
					onChange: function ( v ) { p.setAttributes( { days: v } ); },
					__nextHasNoMarginBottom: true
				} ),
				toggle( p, 'showInstructor', __( 'Show instructor', 'branchharbor' ) ),
				toggle( p, 'showSpots', __( 'Show spots left', 'branchharbor' ) )
			];
		},
		'book-button': function ( p ) {
			return [
				locationControl( p ),
				text( p, 'label', __( 'Button text', 'branchharbor' ) ),
				text( p, 'url', __( 'Custom link', 'branchharbor' ), __( 'Optional. Leave empty to use the location’s BranchHarbor booking page.', 'branchharbor' ) ),
				select( p, 'variant', __( 'Style', 'branchharbor' ), [ { value: 'fill', label: __( 'Filled', 'branchharbor' ) }, { value: 'outline', label: __( 'Outline', 'branchharbor' ) } ] )
			];
		},
		'menu': function ( p ) {
			return [
				locationControl( p ),
				text( p, 'category', __( 'Only this category', 'branchharbor' ), __( 'Optional, e.g. Mains.', 'branchharbor' ) ),
				toggle( p, 'showPrices', __( 'Show prices', 'branchharbor' ) ),
				toggle( p, 'showDietary', __( 'Show dietary tags', 'branchharbor' ) )
			];
		},
		'pickup-order-button': function ( p ) {
			return [
				locationControl( p ),
				text( p, 'label', __( 'Button text', 'branchharbor' ) ),
				text( p, 'url', __( 'Custom link', 'branchharbor' ), __( 'Optional. Leave empty to use the location’s BranchHarbor pickup page.', 'branchharbor' ) ),
				select( p, 'variant', __( 'Style', 'branchharbor' ), [ { value: 'fill', label: __( 'Filled', 'branchharbor' ) }, { value: 'outline', label: __( 'Outline', 'branchharbor' ) } ] )
			];
		},
		'lead-form': function ( p ) {
			var fields = p.attributes.fields || [];
			var list = [
				select( p, 'target', __( 'Send to', 'branchharbor' ), [
					{ value: 'lead', label: __( 'A location (enquiry)', 'branchharbor' ) },
					{ value: 'demo_request', label: __( 'BranchHarbor demo request', 'branchharbor' ) }
				] )
			];
			if ( p.attributes.target !== 'demo_request' ) {
				list.push( locationControl( p ) );
			} else {
				list.push( select( p, 'industry', __( 'Industry', 'branchharbor' ), [
					{ value: 'studios', label: __( 'Studios', 'branchharbor' ) },
					{ value: 'sports', label: __( 'Sports', 'branchharbor' ) },
					{ value: 'wellness', label: __( 'Wellness', 'branchharbor' ) },
					{ value: 'commerce', label: __( 'Commerce', 'branchharbor' ) },
					{ value: 'foods', label: __( 'Foods', 'branchharbor' ) }
				] ) );
			}
			list.push( el( 'p', { className: 'components-base-control__help' }, __( 'Fields (name and email are always included):', 'branchharbor' ) ) );
			FIELD_OPTIONS.forEach( function ( f ) {
				list.push( el( c.CheckboxControl, {
					key: f.value,
					label: f.label,
					checked: fields.length ? fields.indexOf( f.value ) !== -1 : [ 'name', 'email', 'phone', 'message', 'marketing_consent' ].indexOf( f.value ) !== -1,
					onChange: function ( on ) {
						var base = fields.length ? fields.slice() : [ 'name', 'email', 'phone', 'message', 'marketing_consent' ];
						var next = on ? base.concat( [ f.value ] ) : base.filter( function ( x ) { return x !== f.value; } );
						p.setAttributes( { fields: next.filter( function ( x, i ) { return next.indexOf( x ) === i; } ) } );
					},
					__nextHasNoMarginBottom: true
				} ) );
			} );
			list.push( text( p, 'formId', __( 'Form name', 'branchharbor' ), __( 'Used for routing and duplicate prevention. Letters, numbers and dashes.', 'branchharbor' ) ) );
			list.push( text( p, 'submitLabel', __( 'Button text', 'branchharbor' ) ) );
			list.push( text( p, 'successMessage', __( 'Message after sending', 'branchharbor' ) ) );
			list.push( text( p, 'consentText', __( 'Marketing consent wording', 'branchharbor' ) ) );
			return list;
		}
	};

	Object.keys( controls ).forEach( function ( slug ) {
		var name = 'branchharbor/' + slug;
		wp.blocks.registerBlockType( name, {
			edit: function ( props ) {
				var blockProps = be.useBlockProps();
				var notice = data.connected ? null : el( c.Notice, { status: 'warning', isDismissible: false },
					__( 'BranchHarbor is not connected. Visitors will see a short “temporarily unavailable” message.', 'branchharbor' ),
					data.settingsUrl ? el( 'a', { href: data.settingsUrl, style: { marginLeft: '4px' } }, __( 'Connect', 'branchharbor' ) ) : null
				);
				return el( Fragment, null,
					el( be.InspectorControls, null,
						el( c.PanelBody, { title: __( 'Settings', 'branchharbor' ), initialOpen: true }, controls[ slug ]( props ) )
					),
					el( 'div', blockProps,
						notice,
						el( ServerSideRender, { block: name, attributes: props.attributes, httpMethod: 'POST' } )
					)
				);
			},
			save: function () { return null; }
		} );
	} );
}( window.wp, window.branchharborEditor ) );
