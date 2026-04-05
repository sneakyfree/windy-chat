/**
 * Windy Chat — Shared Sentry Error Reporting
 *
 * Usage in each service:
 *   const { initSentry, sentryErrorHandler } = require('../shared/sentry');
 *   initSentry(app, 'windy-chat-onboarding');
 *   // ... routes ...
 *   app.use(sentryErrorHandler());
 */

let Sentry = null;

function initSentry(app, serviceName) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log(`[${serviceName}] Sentry not configured (SENTRY_DSN not set)`);
    return;
  }

  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      serverName: serviceName,
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
      beforeSend(event) {
        // Strip sensitive data
        if (event.request?.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
        return event;
      },
    });

    // Request handler adds request context to Sentry events
    if (app && Sentry.Handlers) {
      app.use(Sentry.Handlers.requestHandler());
    }

    console.log(`[${serviceName}] Sentry initialized`);
  } catch (err) {
    console.warn(`[${serviceName}] Sentry init failed (install @sentry/node): ${err.message}`);
    Sentry = null;
  }
}

function sentryErrorHandler() {
  if (Sentry && Sentry.Handlers) {
    return Sentry.Handlers.errorHandler();
  }
  // No-op middleware if Sentry not available
  return (_err, _req, _res, next) => next(_err);
}

function captureException(err) {
  if (Sentry) Sentry.captureException(err);
}

module.exports = { initSentry, sentryErrorHandler, captureException };
