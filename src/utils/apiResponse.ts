/**
 * Application-level error carrying an HTTP status and a stable machine code.
 * The global error handler turns these into `{ error: { message, code } }`.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, status = 400, code = 'BAD_REQUEST', details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Unauthorized = (message = 'Authentication required') =>
  new AppError(message, 401, 'UNAUTHENTICATED');

export const Forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(message, 403, 'FORBIDDEN');

export const NotFound = (message = 'Resource not found') =>
  new AppError(message, 404, 'NOT_FOUND');
