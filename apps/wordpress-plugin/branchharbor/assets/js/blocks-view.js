/**
 * BranchHarbor front-end helper (no dependencies).
 *
 * 1. Fills placeholders and refreshes blocks older than 5 minutes from the plugin's own REST
 *    render route, so pages served from a full-page cache still show current schedules/menus.
 *    The visitor's browser only talks to this WordPress site, never to BranchHarbor directly.
 * 2. Filters the location finder list as the visitor types.
 */
( function () {
	'use strict';

	var STALE_MS = 5 * 60 * 1000;

	function refresh( node ) {
		var endpoint = node.getAttribute( 'data-bh-endpoint' );
		var attrs;
		if ( ! endpoint || ! window.fetch || ! window.URL ) {
			return;
		}
		try {
			attrs = JSON.parse( node.getAttribute( 'data-bh-attrs' ) || '{}' );
		} catch ( e ) {
			return;
		}
		var url = new URL( endpoint, window.location.href );
		Object.keys( attrs ).forEach( function ( k ) {
			var v = attrs[ k ];
			if ( Array.isArray( v ) ) {
				v = v.join( ',' );
			}
			url.searchParams.set( k, String( v ) );
		} );
		window.fetch( url.toString(), { credentials: 'same-origin', headers: { Accept: 'application/json' } } )
			.then( function ( r ) { return r.ok ? r.json() : null; } )
			.then( function ( body ) {
				if ( ! body || typeof body.html !== 'string' || body.html.indexOf( 'data-bh-pending' ) !== -1 ) {
					if ( node.hasAttribute( 'data-bh-pending' ) ) {
						node.removeAttribute( 'aria-busy' );
					}
					return;
				}
				var tpl = document.createElement( 'template' );
				tpl.innerHTML = body.html.trim();
				var fresh = tpl.content.firstElementChild;
				if ( fresh ) {
					node.replaceWith( fresh );
					bindFinder( fresh );
				}
			} )
			.catch( function () { /* keep the cached copy */ } );
	}

	function bindFinder( root ) {
		var input = root.querySelector && root.querySelector( '[data-bh-filter]' );
		if ( ! input ) {
			return;
		}
		var items = root.querySelectorAll( '[data-bh-text]' );
		var empty = root.querySelector( '.bh-empty' );
		input.addEventListener( 'input', function () {
			var q = input.value.trim().toLowerCase();
			var shown = 0;
			Array.prototype.forEach.call( items, function ( li ) {
				var match = ! q || li.getAttribute( 'data-bh-text' ).indexOf( q ) !== -1;
				li.hidden = ! match;
				shown += match ? 1 : 0;
			} );
			if ( empty ) {
				empty.hidden = shown !== 0;
			}
		} );
	}

	function init() {
		var nodes = document.querySelectorAll( '[data-bh-block]' );
		var now = Date.now();
		Array.prototype.forEach.call( nodes, function ( node ) {
			bindFinder( node );
			var fetched = parseInt( node.getAttribute( 'data-bh-fetched' ) || '0', 10 ) * 1000;
			if ( node.hasAttribute( 'data-bh-pending' ) || ! fetched || now - fetched > STALE_MS ) {
				refresh( node );
			}
		} );
	}

	if ( document.readyState === 'loading' ) {
		document.addEventListener( 'DOMContentLoaded', init );
	} else {
		init();
	}
}() );
