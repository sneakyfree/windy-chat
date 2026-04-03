/**
 * Windy Chat — Structured Logger
 *
 * Lightweight logger that outputs JSON in production and readable text in dev.
 * No external dependencies — just wraps console methods with structure.
 *
 * Usage:
 *   const { createLogger } = require('windy-chat-shared/logger');
 *   const log = createLogger('onboarding');
 *   log.info('server started', { port: 8101 });
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Create a logger scoped to a service name.
 *
 * @param {string} service - Service name (e.g. 'windy-chat-onboarding')
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
function createLogger(service) {
  const isProduction = process.env.NODE_ENV === 'production';

  function log(level, consoleFn, message, extra) {
    if (isProduction) {
      const entry = {
        timestamp: new Date().toISOString(),
        level,
        service,
        message,
      };
      if (extra !== undefined && extra !== null) {
        // Spread plain objects; attach anything else as "data"
        if (typeof extra === 'object' && !Array.isArray(extra)) {
          Object.assign(entry, extra);
        } else {
          entry.data = extra;
        }
      }
      consoleFn(JSON.stringify(entry));
    } else {
      const prefix = `[${service}] ${level.toUpperCase()}`;
      if (extra !== undefined && extra !== null) {
        consoleFn(prefix, message, extra);
      } else {
        consoleFn(prefix, message);
      }
    }
  }

  return {
    debug: (message, extra) => log('debug', console.debug, message, extra),
    info:  (message, extra) => log('info',  console.log,   message, extra),
    warn:  (message, extra) => log('warn',  console.warn,  message, extra),
    error: (message, extra) => log('error', console.error, message, extra),
  };
}

module.exports = { createLogger };
