<?php
/**
 * BranchHarbor API client. Every outbound request goes through here so the consent gate,
 * timeouts and connection-state bookkeeping are applied consistently.
 *
 * Endpoints marked [proposed] are not yet implemented by the BranchHarbor API (see
 * docs/API_CONTRACT.md). A 404/405/501 from those returns the error code
 * 'branchharbor_endpoint_unavailable' and callers degrade gracefully.
 *
 * @package BranchHarbor
 */

namespace BranchHarbor;

defined( 'ABSPATH' ) || exit;

final class Api_Client {

	public const TIMEOUT_INTERACTIVE = 5;
	public const TIMEOUT_BACKGROUND  = 15;

	/**
	 * Low-level request.
	 *
	 * @param array{query?:array<string,mixed>,body?:array<string,mixed>|null,auth?:bool,timeout?:int,idempotency_key?:string,skip_gate?:bool,track_state?:bool} $args
	 * @return array{status:int,data:mixed,headers:array<string,string>}|\WP_Error
	 */
	public static function request( string $method, string $path, array $args = array() ) {
		$auth = $args['auth'] ?? true;

		// Consent is always required: there is no code path that contacts BranchHarbor before it.
		if ( ! Settings::consent()['granted'] ) {
			return new \WP_Error( 'branchharbor_no_consent', __( 'Agree to data processing before BranchHarbor can be contacted.', 'branchharbor' ) );
		}
		// skip_gate only skips the "connected" check (used while connecting, testing and revoking).
		if ( empty( $args['skip_gate'] ) ) {
			if ( ! Settings::can_call() ) {
				return new \WP_Error( 'branchharbor_not_connected', __( 'This site is not connected to BranchHarbor.', 'branchharbor' ) );
			}
		}
		$headers = array(
			'Accept'       => 'application/json',
			'User-Agent'   => 'BranchHarbor-WordPress/' . BRANCHHARBOR_VERSION . '; ' . home_url( '/' ),
			'X-BH-Client'  => 'wordpress-plugin',
			'X-BH-Version' => BRANCHHARBOR_VERSION,
		);
		if ( $auth ) {
			$token = Settings::token();
			if ( '' === $token ) {
				return new \WP_Error( 'branchharbor_no_token', __( 'This site has no BranchHarbor authorisation.', 'branchharbor' ) );
			}
			$headers['Authorization'] = 'Bearer ' . $token;
			$site_id                  = (string) Settings::connection()['site_id'];
			if ( '' !== $site_id ) {
				$headers['X-BH-Site'] = $site_id;
			}
		}
		if ( ! empty( $args['idempotency_key'] ) ) {
			$headers['Idempotency-Key'] = (string) $args['idempotency_key'];
		}

		$url = Settings::api_base() . $path;
		if ( ! empty( $args['query'] ) ) {
			$url = add_query_arg( array_map( 'rawurlencode', array_map( 'strval', $args['query'] ) ), $url );
		}
		$request = array(
			'method'      => $method,
			'timeout'     => (int) ( $args['timeout'] ?? ( wp_doing_cron() ? self::TIMEOUT_BACKGROUND : self::TIMEOUT_INTERACTIVE ) ),
			'redirection' => 0,
			'headers'     => $headers,
		);
		if ( array_key_exists( 'body', $args ) && null !== $args['body'] ) {
			$request['headers']['Content-Type'] = 'application/json';
			$request['body']                    = wp_json_encode( $args['body'] );
		}

		$response = wp_remote_request( $url, $request );
		$track    = $args['track_state'] ?? $auth;

		if ( is_wp_error( $response ) ) {
			if ( $track ) {
				self::track( null, $response->get_error_message() );
			}
			Activity::log(
				'request_failed',
				array(
					'status' => $response->get_error_code(),
					'path'   => $path,
				),
				'warning'
			);
			return new \WP_Error( 'branchharbor_unreachable', __( 'BranchHarbor could not be reached. Try again in a few minutes.', 'branchharbor' ), array( 'cause' => $response->get_error_code() ) );
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$data   = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		if ( $track ) {
			self::track( $status, $status >= 400 ? self::error_message( $data, $status ) : null );
		}

		if ( in_array( $status, array( 404, 405, 501 ), true ) && ! self::is_known_resource_error( $data ) ) {
			return new \WP_Error( 'branchharbor_endpoint_unavailable', __( 'This BranchHarbor feature is not available yet.', 'branchharbor' ), array( 'status' => $status ) );
		}
		if ( $status >= 400 ) {
			if ( $status >= 500 || 429 === $status ) {
				Activity::log(
					'request_failed',
					array(
						'status' => $status,
						'path'   => $path,
					),
					'warning'
				);
			}
			return new \WP_Error(
				'branchharbor_http_' . $status,
				self::error_message( $data, $status ),
				array(
					'status' => $status,
					'data'   => $data,
				)
			);
		}
		return array(
			'status'  => $status,
			'data'    => $data,
			'headers' => array(),
		);
	}

	/**
	 * A 404 with a structured BranchHarbor error ({error:{code:'not_found'}}) means "resource missing",
	 * not "endpoint missing". The API's route-not-found handler uses the same code with a message
	 * of the form "Route GET /v1/... not found", which we treat as "endpoint unavailable".
	 *
	 * @param mixed $data
	 */
	private static function is_known_resource_error( $data ): bool {
		if ( ! is_array( $data ) || ! isset( $data['error']['code'] ) || 'not_found' !== $data['error']['code'] ) {
			return false;
		}
		$message = (string) ( $data['error']['message'] ?? '' );
		return 0 !== strpos( $message, 'Route ' );
	}

	/**
	 * @param mixed $data
	 */
	private static function error_message( $data, int $status ): string {
		if ( is_array( $data ) && isset( $data['error']['message'] ) && is_string( $data['error']['message'] ) ) {
			return sanitize_text_field( $data['error']['message'] );
		}
		/* translators: %d: HTTP status code */
		return sprintf( __( 'BranchHarbor returned an error (HTTP %d).', 'branchharbor' ), $status );
	}

	/**
	 * Update connection state after an authenticated call.
	 */
	private static function track( ?int $status, ?string $error ): void {
		$c       = Settings::connection();
		$next    = Connection_Status::after_response( (string) $c['state'], $status, (int) $c['failures'] );
		$changes = array(
			'state'    => $next['state'],
			'failures' => $next['failures'],
		);
		if ( null !== $status && $status < 400 ) {
			$changes['last_success_at'] = time();
		} elseif ( null !== $error ) {
			$changes['last_error']    = $error;
			$changes['last_error_at'] = time();
		}
		if ( Connection_Status::EXPIRED === $next['state'] && Connection_Status::EXPIRED !== $c['state'] ) {
			Activity::log( 'authorization_expired', array(), 'error' );
		}
		Settings::update_connection( $changes );
	}

	/* ------------------------------------------------------------------ */
	/* Endpoints that exist in the BranchHarbor API today                 */
	/* ------------------------------------------------------------------ */

	/** GET /health — reachability only. */
	public static function health() {
		return self::request(
			'GET',
			'/health',
			array(
				'auth'        => false,
				'track_state' => false,
				'skip_gate'   => true,
				'timeout'     => self::TIMEOUT_INTERACTIVE,
			)
		);
	}

	/** GET /v1/public/locations/{orgSlug}. */
	public static function public_locations( string $org_slug ) {
		return self::request( 'GET', '/v1/public/locations/' . rawurlencode( $org_slug ), array( 'auth' => false ) );
	}

	/** GET /v1/public/studios/{locationId}/schedule?from&to. */
	public static function schedule( string $location_id, int $days ) {
		$from = gmdate( 'Y-m-d\TH:i:s\Z' );
		$to   = gmdate( 'Y-m-d\TH:i:s\Z', time() + max( 1, min( 28, $days ) ) * DAY_IN_SECONDS );
		return self::request(
			'GET',
			'/v1/public/studios/' . rawurlencode( $location_id ) . '/schedule',
			array(
				'auth'  => false,
				'query' => array(
					'from' => $from,
					'to'   => $to,
				),
			)
		);
	}

	/** GET /v1/public/foods/{locationId}/menu. */
	public static function menu( string $location_id ) {
		return self::request( 'GET', '/v1/public/foods/' . rawurlencode( $location_id ) . '/menu', array( 'auth' => false ) );
	}

	/** GET /v1/public/foods/{locationId}/pickup-slots. */
	public static function pickup_slots( string $location_id ) {
		return self::request( 'GET', '/v1/public/foods/' . rawurlencode( $location_id ) . '/pickup-slots', array( 'auth' => false ) );
	}

	/** POST /v1/public/demo-requests. */
	public static function demo_request( array $payload ) {
		return self::request(
			'POST',
			'/v1/public/demo-requests',
			array(
				'auth' => false,
				'body' => $payload,
			)
		);
	}

	/* ------------------------------------------------------------------ */
	/* [proposed] connector endpoints                                      */
	/* ------------------------------------------------------------------ */

	/**
	 * [proposed] POST /v1/connector/wordpress/exchange — swap a connection code or authorisation
	 * code (+ PKCE verifier) for a scoped site token. Called after consent, before a token exists.
	 *
	 * @param array<string,string> $grant
	 */
	public static function exchange( array $grant ) {
		if ( ! Settings::consent()['granted'] ) {
			return new \WP_Error( 'branchharbor_no_consent', __( 'Agree to data processing before BranchHarbor can be contacted.', 'branchharbor' ) );
		}
		return self::request(
			'POST',
			'/v1/connector/wordpress/exchange',
			array(
				'auth'        => false,
				'skip_gate'   => true,
				'track_state' => false,
				'body'        => array_merge(
					$grant,
					array(
						'site'   => array(
							'url'           => home_url( '/' ),
							'restUrl'       => get_rest_url(),
							'webhookUrl'    => rest_url( Rest::NAMESPACE . '/webhook' ),
							'name'          => get_bloginfo( 'name' ),
							'timeZone'      => wp_timezone_string(),
							'locale'        => get_locale(),
							'wpVersion'     => get_bloginfo( 'version' ),
							'pluginVersion' => BRANCHHARBOR_VERSION,
							'multisite'     => is_multisite(),
						),
						'scopes' => Connect::SCOPES,
					)
				),
			)
		);
	}

	/** [proposed] GET /v1/connector/wordpress/site — organisation, locations (with links), scopes, state. */
	public static function site() {
		return self::request( 'GET', '/v1/connector/wordpress/site' );
	}

	/** [proposed] PUT /v1/connector/wordpress/site — report mapping, directions, SEO owner and compatibility scan. */
	public static function update_site( array $config ) {
		return self::request( 'PUT', '/v1/connector/wordpress/site', array( 'body' => $config ) );
	}

	/** [proposed] DELETE /v1/connector/wordpress/site — revoke this site's token. */
	public static function revoke() {
		return self::request(
			'DELETE',
			'/v1/connector/wordpress/site',
			array(
				'track_state' => false,
				'skip_gate'   => true,
			)
		);
	}

	/** [proposed] POST /v1/connector/wordpress/test-event — ask BranchHarbor to deliver a signed ping webhook now. */
	public static function test_event() {
		return self::request( 'POST', '/v1/connector/wordpress/test-event', array( 'body' => array( 'type' => 'connection.ping' ) ) );
	}

	/** [proposed] POST /v1/connector/wordpress/leads — location enquiry with Idempotency-Key. */
	public static function lead( array $payload, string $idempotency_key ) {
		return self::request(
			'POST',
			'/v1/connector/wordpress/leads',
			array(
				'body'            => $payload,
				'idempotency_key' => $idempotency_key,
			)
		);
	}

	/** [proposed] POST /v1/connector/wordpress/events — batch of exported WooCommerce records. */
	public static function events( array $events, string $idempotency_key ) {
		return self::request(
			'POST',
			'/v1/connector/wordpress/events',
			array(
				'body'            => array( 'events' => $events ),
				'idempotency_key' => $idempotency_key,
				'timeout'         => self::TIMEOUT_BACKGROUND,
			)
		);
	}
}
