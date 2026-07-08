/**
 * Unit tests for the APNs provider wrapper.
 *
 * We inject a fake `apn` module via `apnOverride` — no real .p8 file, no
 * connection to gateway.push.apple.com.
 */

function makeApnMock({ sendImpl } = {}) {
  const providerInstances = [];
  class FakeNotification {
    constructor() {
      this.alert = null;
      this.badge = null;
      this.sound = null;
      this.topic = null;
      this.payload = null;
      this.pushType = null;
      this.priority = null;
    }
  }
  class FakeProvider {
    constructor(opts) {
      this.opts = opts;
      this.sentNotes = [];
      providerInstances.push(this);
    }
    async send(note, device) {
      this.sentNotes.push({ note, device });
      if (sendImpl) return sendImpl(note, device);
      return { sent: [{ device }], failed: [] };
    }
  }
  return {
    Notification: FakeNotification,
    Provider: FakeProvider,
    _instances: providerInstances,
  };
}

beforeEach(() => {
  jest.resetModules();
  delete process.env.APNS_KEY_PATH;
  delete process.env.APNS_KEY_ID;
  delete process.env.APNS_TEAM_ID;
  delete process.env.APNS_BUNDLE_ID;
});

function setApnsEnv() {
  process.env.APNS_KEY_PATH = '/etc/secrets/AuthKey.p8';
  process.env.APNS_KEY_ID = 'KEYID12345';
  process.env.APNS_TEAM_ID = 'TEAMID6789';
  process.env.APNS_BUNDLE_ID = 'ai.windy.chat';
}

describe('lib/providers/apns', () => {
  describe('status() — config gating', () => {
    it('returns "unconfigured" when any of the four env vars is missing', () => {
      process.env.APNS_KEY_PATH = '/etc/secrets/AuthKey.p8';
      // APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID all missing
      const apns = require('../../lib/providers/apns');
      expect(apns.init({ apnOverride: makeApnMock() })).toBe(false);
      expect(apns.status()).toBe('unconfigured');
    });

    it('returns "ok" after successful init', () => {
      setApnsEnv();
      const apns = require('../../lib/providers/apns');
      expect(apns.init({ apnOverride: makeApnMock() })).toBe(true);
      expect(apns.status()).toBe('ok');
    });

    it('passes APNS_KEY_PATH / KEY_ID / TEAM_ID into apn.Provider', () => {
      setApnsEnv();
      const apns = require('../../lib/providers/apns');
      const apnMock = makeApnMock();
      apns.init({ apnOverride: apnMock });
      expect(apnMock._instances).toHaveLength(1);
      expect(apnMock._instances[0].opts.token).toEqual({
        key: '/etc/secrets/AuthKey.p8',
        keyId: 'KEYID12345',
        teamId: 'TEAMID6789',
      });
    });

    it('flips apn.Provider production flag based on NODE_ENV', () => {
      setApnsEnv();
      const original = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        const apns = require('../../lib/providers/apns');
        const apnMock = makeApnMock();
        apns.init({ apnOverride: apnMock });
        expect(apnMock._instances[0].opts.production).toBe(true);
      } finally {
        process.env.NODE_ENV = original;
      }
    });
  });

  describe('send()', () => {
    it('returns { stubbed: true } when not configured', async () => {
      const apns = require('../../lib/providers/apns');
      const result = await apns.send('device', { title: 't', body: 'b' });
      expect(result).toEqual({ stubbed: true });
    });

    it('builds an APNs Notification with the right fields', async () => {
      setApnsEnv();
      const apns = require('../../lib/providers/apns');
      const apnMock = makeApnMock();
      apns.init({ apnOverride: apnMock });

      const result = await apns.send('ios-device-token', {
        title: 'Grant',
        body: 'New message',
        badge: 2,
        roomId: '!r:chat.windychat.ai',
        eventId: '$evt-1',
      }, { apnOverride: apnMock });

      expect(result.ok).toBe(true);
      const inst = apnMock._instances[0];
      expect(inst.sentNotes).toHaveLength(1);
      const { note, device } = inst.sentNotes[0];
      expect(device).toBe('ios-device-token');
      expect(note.alert).toEqual({ title: 'Grant', body: 'New message' });
      expect(note.badge).toBe(2);
      expect(note.sound).toBe('default');
      expect(note.topic).toBe('ai.windy.chat');
      expect(note.payload).toEqual({
        room_id: '!r:chat.windychat.ai',
        event_id: '$evt-1',
      });
      expect(note.pushType).toBe('alert');
      expect(note.priority).toBe(10);
    });

    it('marks dead-token reasons as expired WITHOUT flipping status to failed', async () => {
      setApnsEnv();
      const apns = require('../../lib/providers/apns');
      const apnMock = makeApnMock({
        sendImpl: async () => ({
          sent: [],
          failed: [{ device: 'bad', status: 400, response: { reason: 'BadDeviceToken' } }],
        }),
      });
      apns.init({ apnOverride: apnMock });

      const result = await apns.send('bad', { title: 't', body: 'b' }, { apnOverride: apnMock });
      expect(result.ok).toBe(false);
      expect(result.expired).toBe(true);
      expect(result.error).toBe('BadDeviceToken');
      expect(result.statusCode).toBe(400);
      // A stale device token is not a provider outage.
      expect(apns.status()).toBe('ok');
    });

    it('treats HTTP 410 (Unregistered) as expired regardless of reason', async () => {
      setApnsEnv();
      const apns = require('../../lib/providers/apns');
      const apnMock = makeApnMock({
        sendImpl: async () => ({
          sent: [],
          failed: [{ device: 'gone', status: 410, response: { reason: 'Unregistered' } }],
        }),
      });
      apns.init({ apnOverride: apnMock });

      const result = await apns.send('gone', { title: 't', body: 'b' }, { apnOverride: apnMock });
      expect(result.expired).toBe(true);
      expect(apns.status()).toBe('ok');
    });

    it('reports failure (status "failed") on non-token delivery errors', async () => {
      setApnsEnv();
      const apns = require('../../lib/providers/apns');
      const apnMock = makeApnMock({
        sendImpl: async () => ({
          sent: [],
          failed: [{ device: 'd', status: 500, response: { reason: 'InternalServerError' } }],
        }),
      });
      apns.init({ apnOverride: apnMock });

      const result = await apns.send('d', { title: 't', body: 'b' }, { apnOverride: apnMock });
      expect(result.ok).toBe(false);
      expect(result.expired).toBeUndefined();
      expect(result.error).toBe('InternalServerError');
      expect(result.statusCode).toBe(500);
      expect(apns.status()).toBe('failed');
    });

    it('catches thrown errors and flips status to "failed"', async () => {
      setApnsEnv();
      const apns = require('../../lib/providers/apns');
      const apnMock = makeApnMock({
        sendImpl: async () => { throw new Error('connection refused'); },
      });
      apns.init({ apnOverride: apnMock });

      const result = await apns.send('t', { title: 't', body: 'b' }, { apnOverride: apnMock });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('connection refused');
      expect(apns.status()).toBe('failed');
    });
  });
});
