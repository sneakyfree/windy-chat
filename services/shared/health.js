/**
 * Windy Chat — Shared Health Check Builder
 *
 * Returns a handler that reports service status, uptime, and dependency health.
 */

const startedAt = Date.now();

/**
 * Create a health check handler for an Express service.
 *
 * @param {object} opts
 * @param {string} opts.service - Service name (e.g. 'windy-chat-onboarding')
 * @param {string} opts.version - Service version
 * @param {function} [opts.checks] - Async function returning { key: boolean } dependency map
 */
function createHealthHandler(opts) {
  const { service, version = '1.0.0', checks } = opts;

  return async (_req, res) => {
    const uptimeMs = Date.now() - startedAt;
    const base = {
      service,
      status: 'ok',
      version,
      uptime: formatUptime(uptimeMs),
      uptimeMs,
      timestamp: new Date().toISOString(),
    };

    if (checks) {
      try {
        const deps = await checks();
        base.dependencies = deps;
      } catch (err) {
        base.status = 'degraded';
        base.dependencies = { error: err.message };
      }
    }

    const statusCode = base.status === 'ok' ? 200 : 503;
    res.status(statusCode).json(base);
  };
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

module.exports = { createHealthHandler };
