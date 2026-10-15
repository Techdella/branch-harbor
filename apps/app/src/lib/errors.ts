/**
 * Normalised API error: `{ error: { code, message, fields, details } }` from the backend, or a network failure.
 * `message` and `fields` are English as sent until `useLocalizeError` (lib/useErrorText.ts) phrases them in the viewer's
 * language; the original sentence is then kept in `apiMessage`.
 */
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public fields?: Record<string, string>,
    public details?: Record<string, unknown>,
    public apiMessage?: string,
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
