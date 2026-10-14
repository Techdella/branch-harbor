/** Errors rendered as { error: { code, message, fields? } } — the apiError contract in @bh/shared. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) => new AppError(400, 'bad_request', message, fields);
export const validationError = (message: string, fields?: Record<string, string>) => new AppError(400, 'validation_failed', message, fields);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that in this scope') => new AppError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) => new AppError(409, code, message, undefined, details);
export const unavailable = (code: string, message: string) => new AppError(503, code, message);
