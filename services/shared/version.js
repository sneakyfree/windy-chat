/**
 * Windy Chat — Shared Version Endpoint Builder
 *
 * Returns the MF1 deployment-identity contract. Every service in
 * windy-chat (and across the Windy ecosystem) exposes /version with
 * this identical shape so the kit-army-config deployed-state cron
 * can poll every host uniformly.
 *
 * See ~/kit-army-config/docs/marathon-foundations-program-2026-05-11.md §MF1.
 *
 * Separate from /health on purpose:
 *   - /health is for orchestrators (liveness/readiness probes)
 *   - /version is for deployment verification (provenance)
 *   - /version MUST NOT depend on DB/Redis — process-level fact,
 *     safe to call during incidents.
 */

const versionStartedAt = new Date().toISOString();

/**
 * Create a version handler for an Express service.
 *
 * @param {object} opts
 * @param {string} opts.service - Canonical service name (e.g. 'windy-chat-push-gateway')
 * @param {string} opts.version - Semver (from service's package.json)
 * @returns {function} Express handler
 */
function createVersionHandler(opts) {
  const { service, version = '1.0.0' } = opts;

  return (_req, res) => {
    const commitSha = process.env.COMMIT_SHA || null;
    res.json({
      service,
      version,
      commit_sha: commitSha,
      commit_sha_short: commitSha ? commitSha.slice(0, 7) : null,
      build_timestamp: process.env.BUILD_TIMESTAMP || null,
      started_at: versionStartedAt,
      environment: process.env.ENVIRONMENT || process.env.NODE_ENV || 'unknown',
    });
  };
}

module.exports = { createVersionHandler };
