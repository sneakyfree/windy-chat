/**
 * Wave 12 M-2 — FCM Android channel routing by event_type
 *
 * Before this fix every event with `eventType !== 'agent.hatched'`
 * landed on the `chat_messages` Android channel, so cross-service
 * fan-outs (mail.inbound, cloud.quota_warn, passport.trust_changed)
 * all rode the chat notification channel with chat's sound/vibrate/
 * mute preferences. This suite pins the explicit event_type → channel
 * map and the family-prefix fallback.
 *
 * Run: node --test services/push-gateway/tests/fcm-channels.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.WINDY_JWT_SECRET = 'wave12-m2-jwt';
process.env.PUSH_BUS_TOKEN = 'wave12-m2-bus';

const dataDir = path.join(__dirname, '..', 'data');
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
fs.mkdirSync(dataDir, { recursive: true });

const { channelForEvent, FCM_CHANNEL_BY_EVENT } = require('../server');

describe('Wave 12 M-2 — channelForEvent()', () => {
  it('routes agent.hatched to its own channel (the Wave 8 Grandma Ribbon path)', () => {
    assert.equal(channelForEvent('agent.hatched'), 'agent_hatched');
  });

  it('routes chat.new_message to chat_messages', () => {
    assert.equal(channelForEvent('chat.new_message'), 'chat_messages');
    assert.equal(channelForEvent('chat.reaction'), 'chat_messages');
  });

  it('routes mail.* to the mail channel (not chat_messages)', () => {
    assert.equal(channelForEvent('mail.inbound'), 'mail');
    assert.equal(channelForEvent('mail.delivered'), 'mail');
  });

  it('routes cloud.* to the system channel', () => {
    assert.equal(channelForEvent('cloud.quota_warn'), 'system');
    assert.equal(channelForEvent('cloud.plan_changed'), 'system');
  });

  it('routes passport.* and eternitas.* to the security channel', () => {
    assert.equal(channelForEvent('passport.trust_changed'), 'security');
    assert.equal(channelForEvent('passport.revoked'), 'security');
    assert.equal(channelForEvent('eternitas.verify_required'), 'security');
  });

  it('routes fly.* (non-hatch agent events) to agent_updates', () => {
    assert.equal(channelForEvent('fly.task_completed'), 'agent_updates');
    assert.equal(channelForEvent('fly.needs_input'), 'agent_updates');
  });

  it('falls back to chat_messages for null / unknown event types', () => {
    assert.equal(channelForEvent(undefined), 'chat_messages');
    assert.equal(channelForEvent(null), 'chat_messages');
    assert.equal(channelForEvent(''), 'chat_messages');
    assert.equal(channelForEvent('totally.unknown.event'), 'chat_messages');
    assert.equal(channelForEvent(42), 'chat_messages');
  });

  it('handles family-only event_type ("agent" without a dot)', () => {
    // The legacy Synapse /_matrix/push/v1/notify payload has no
    // eventType set, but if a publisher sends a bare family name it
    // should still resolve — exact-match beats prefix-match.
    assert.equal(channelForEvent('agent'), 'agent_updates');
    assert.equal(channelForEvent('mail'), 'mail');
  });

  it('exports the canonical map for client parity', () => {
    // windy-pro-mobile must call NotificationManager.createNotificationChannel
    // for each of these channels on first launch. Locking the set here
    // so any new family addition is visible in review.
    assert.deepEqual(Object.keys(FCM_CHANNEL_BY_EVENT).sort(), [
      'agent',
      'agent.hatched',
      'chat',
      'cloud',
      'eternitas',
      'fly',
      'mail',
      'passport',
    ]);
  });
});
