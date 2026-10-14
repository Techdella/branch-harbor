/** Normalised API error: `{ error: { code, message, fields } }` from the backend, or a network failure. */
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isForbidden() {
    return this.status === 403 || this.code === 'forbidden';
  }
  get isNetwork() {
    return this.code === 'network_error';
  }
  get isUnauthenticated() {
    return this.status === 401;
  }
}
