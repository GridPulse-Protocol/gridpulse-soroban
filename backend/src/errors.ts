/**
 * Shared error types for the backend.
 *
 * Keeping the HTTP-status-carrying error in one place (rather than, say, a
 * class exported from `relayer.ts`) lets *every* layer — config parsing,
 * request validation, relaying, admin — signal a client-fixable failure with
 * the status code it deserves, without creating import cycles.
 */

/** An error that maps to a specific HTTP status code in the API layer. */
export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}
