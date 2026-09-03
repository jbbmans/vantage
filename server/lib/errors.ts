export class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, code = 'error', extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (message: string, extra: Record<string, unknown> = {}) => new HttpError(400, message, 'validation', extra);
export const unauthorized = (message = 'Not signed in.', code = 'unauthenticated') => new HttpError(401, message, code);
export const forbidden = (message = 'You do not have permission to do that.', code = 'forbidden') => new HttpError(403, message, code);
export const notFound = (message = 'Not found.') => new HttpError(404, message, 'not_found');
export const conflict = (message: string, code = 'conflict', extra: Record<string, unknown> = {}) => new HttpError(409, message, code, extra);
export const tooMany = (message: string, retryAfter: number, code = 'throttled') => new HttpError(429, message, code, { retryAfter });
