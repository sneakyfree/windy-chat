/**
 * Windy Chat Hub — bridge registry.
 *
 * One entry per bridged network. A platform is "configured" when its
 * bridge's provisioning base URL is set in the environment; the routes
 * only expose configured platforms, so adding a network later is: deploy
 * the bridge container, set the two env vars, restart hub.
 *
 * All mautrix bridgev2 bridges expose the SAME provisioning surface
 * (spec.mau.fi/megabridge): /_matrix/provision/v3/* authenticated with
 * `Authorization: Bearer <provisioning shared_secret>` plus a `user_id`
 * query param naming the Matrix user the call acts for. That uniformity
 * is why this registry is just URLs + secrets and the proxy is generic.
 */

const PLATFORMS = {
  telegram: {
    key: 'telegram',
    displayName: 'Telegram',
    baseUrlEnv: 'HUB_BRIDGE_TELEGRAM_URL',
    secretEnv: 'HUB_BRIDGE_TELEGRAM_PROVISIONING_SECRET',
    // Puppet MXID namespace the bridge registers exclusively — clients use
    // the same prefix for provenance badges (Hub exec guide §4.2).
    puppetPrefix: '@telegram_',
  },
  slack: {
    key: 'slack',
    displayName: 'Slack',
    baseUrlEnv: 'HUB_BRIDGE_SLACK_URL',
    secretEnv: 'HUB_BRIDGE_SLACK_PROVISIONING_SECRET',
    puppetPrefix: '@slack_',
  },
  whatsapp: {
    key: 'whatsapp',
    displayName: 'WhatsApp',
    baseUrlEnv: 'HUB_BRIDGE_WHATSAPP_URL',
    secretEnv: 'HUB_BRIDGE_WHATSAPP_PROVISIONING_SECRET',
    puppetPrefix: '@whatsapp_',
  },
  discord: {
    key: 'discord',
    displayName: 'Discord',
    baseUrlEnv: 'HUB_BRIDGE_DISCORD_URL',
    secretEnv: 'HUB_BRIDGE_DISCORD_PROVISIONING_SECRET',
    puppetPrefix: '@discord_',
  },
};

function getPlatform(key) {
  const def = PLATFORMS[key];
  if (!def) return null;
  const baseUrl = process.env[def.baseUrlEnv];
  const secret = process.env[def.secretEnv];
  if (!baseUrl || !secret) return null; // not configured on this deploy
  return { ...def, baseUrl: baseUrl.replace(/\/+$/, ''), secret };
}

function listConfiguredPlatforms() {
  return Object.keys(PLATFORMS)
    .map((key) => getPlatform(key))
    .filter(Boolean)
    // Secret must never leave the service; baseUrl is internal topology.
    .map(({ secret, baseUrl, baseUrlEnv, secretEnv, ...pub }) => pub);
}

module.exports = { PLATFORMS, getPlatform, listConfiguredPlatforms };
