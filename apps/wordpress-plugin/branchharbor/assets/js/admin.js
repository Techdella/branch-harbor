/**
 * BranchHarbor admin helpers: confirmation prompts and click-to-copy shortcodes. No dependencies.
 */
( function () {
	'use strict';

	document.addEventListener( 'click', function ( e ) {
		var t = e.target;
		if ( ! ( t instanceof Element ) ) {
			return;
		}
		var confirmEl = t.closest( '[data-bh-confirm]' );
		if ( confirmEl && ! window.confirm( confirmEl.getAttribute( 'data-bh-confirm' ) ) ) {
			e.preventDefault();
			return;
		}
		var copy = t.closest( '.bh-copy' );
		if ( copy && navigator.clipboard ) {
			navigator.clipboard.writeText( copy.textContent ).then( function () {
				copy.classList.add( 'is-copied' );
				setTimeout( function () { copy.classList.remove( 'is-copied' ); }, 1200 );
			} );
		}
	} );
}() );
