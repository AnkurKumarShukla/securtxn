// Domain error types. Routes throw these; the error handler is the only place
// that turns them into HTTP responses.
// Spec: docs/architecture.md §4.1

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "BAD_REQUEST", message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Insufficient role for this operation") {
    super(403, "FORBIDDEN", message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, "NOT_FOUND", `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, "CONFLICT", message, details);
  }
}

/**
 * Verification failed — the request was well-formed but the identity, signature
 * or consistency check did not pass. Distinct from 400 because the caller sent
 * valid input; the *evidence* is what was rejected, and it is never persisted
 * as usable (D04).
 */
export class UnprocessableError extends AppError {
  constructor(message: string, details?: unknown) {
    super(422, "UNPROCESSABLE", message, details);
  }
}

/**
 * A route that exists in the API surface but has no implementation yet.
 * Deliberately 501, never a 200 with an empty body — a stub that looks like
 * success gets built on top of and is never noticed (D21).
 */
export class NotImplementedError extends AppError {
  constructor(what: string) {
    super(501, "NOT_IMPLEMENTED", `${what} is not implemented yet`);
  }
}
