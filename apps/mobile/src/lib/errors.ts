/** Error shape returned by apps/api: { error: { code, message, fields } }. */
export class ApiError extends Error {
  code: string;
  status: number;
  fields?: Record<string, string>;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
  get isNetwork() {
    return this.code === 'network_error';
  }
}

