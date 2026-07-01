// Shared HTTP helpers so route handlers stop hand-rolling try/catch and a
// forgotten catch can't leak an unhandled rejection.
//
// Express 4 routes a SYNC throw to error middleware automatically, but an ASYNC
// (promise) rejection is NOT caught — it becomes an unhandled rejection and the
// request hangs. Wrap async handlers with asyncHandler() so their rejections are
// forwarded to errorMiddleware, which is mounted once after all routes.
//
// Error policy (and info-disclosure fix): a raw 5xx error's message is logged
// server-side but NEVER sent to the client (it can expose internals); the client
// gets a generic message. For an INTENTIONAL, client-safe error throw
// `new HttpError(status, message)` — its status + message reach the client.

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.expose = true; // message is safe to show the client
  }
}

// Wrap an async route handler so a rejected promise goes to errorMiddleware
// instead of hanging the request. Sync handlers don't need it (Express 4 catches
// those), but wrapping them is harmless.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The single error-handling middleware. Mount LAST: `app.use(errorMiddleware)`.
function errorMiddleware(err, req, res, _next) {
  if (res.headersSent) return _next(err); // mid-stream: let Express abort the response
  const status = Number.isInteger(err && err.status) ? err.status : 500;
  // Only expose the message for explicit HttpErrors / 4xx; 5xx stays generic.
  const safe = (err && err.expose === true) || (status >= 400 && status < 500);
  const error = safe && err && err.message ? err.message : 'Something went wrong on our end.';
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl} →`, (err && err.stack) || err);
  }
  res.status(status).json({ error });
}

module.exports = { HttpError, asyncHandler, errorMiddleware };
