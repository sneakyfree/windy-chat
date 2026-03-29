/**
 * Windy Chat — Async Route Handler Wrapper
 *
 * Express 4 does not catch rejected promises from async route handlers.
 * This wrapper ensures async errors are forwarded to the error middleware.
 */

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
