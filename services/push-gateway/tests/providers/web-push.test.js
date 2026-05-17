/**
 * Unit tests for the Web Push (VAPID) provider wrapper.
 */

function makeWebpushMock({ sendImpl } = {}) {
  return {
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn(sendImpl || (async () => ({ statusCode: 201 }))),
  };
}

beforeEach(() => {
  jest.resetModules();
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
});

function setVapidEnv() {
  process.env.VAPID_PUBLIC_KEY = 'public-test-key';
  process.env.VAPID_PRIVATE_KEY = 'private-test-key';
  process.env.VAPID_SUBJECT = 'mailto:ops@windychat.ai';
}

const FAKE_SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'p256-key', auth: 'auth-key' },
};

describe('lib/providers/web-push', () => {
  describe('status() — config gating', () => {
    it('returns "unconfigured" when VAPID keys are missing', () => {
      const wp = require('../../lib/providers/web-push');
      expect(wp.init({ webpushOverride: makeWebpushMock() })).toBe(false);
      expect(wp.status()).toBe('unconfigured');
    });

    it('returns "ok" after successful init', () => {
      setVapidEnv();
      const wp = require('../../lib/providers/web-push');
      const wpMock = makeWebpushMock();
      expect(wp.init({ webpushOverride: wpMock })).toBe(true);
      expect(wp.status()).toBe('ok');
      expect(wpMock.setVapidDetails).toHaveBeenCalledWith(
        'mailto:ops@windychat.ai',
        'public-test-key',
        'private-test-key',
      );
    });

    it('defaults VAPID_SUBJECT to mailto:admin@windychat.ai', () => {
      process.env.VAPID_PUBLIC_KEY = 'public-test-key';
      process.env.VAPID_PRIVATE_KEY = 'private-test-key';
      const wp = require('../../lib/providers/web-push');
      const wpMock = makeWebpushMock();
      wp.init({ webpushOverride: wpMock });
      expect(wpMock.setVapidDetails).toHaveBeenCalledWith(
        'mailto:admin@windychat.ai',
        'public-test-key',
        'private-test-key',
      );
    });
  });

  describe('send()', () => {
    it('returns { stubbed: true } when not configured', async () => {
      const wp = require('../../lib/providers/web-push');
      const result = await wp.send(JSON.stringify(FAKE_SUB), { title: 't', body: 'b' });
      expect(result).toEqual({ stubbed: true });
    });

    it('parses a stringified subscription and posts the right body', async () => {
      setVapidEnv();
      const wp = require('../../lib/providers/web-push');
      const wpMock = makeWebpushMock();
      wp.init({ webpushOverride: wpMock });

      const result = await wp.send(JSON.stringify(FAKE_SUB), {
        title: 'Grant',
        body: 'New message',
        roomId: '!r:chat.windychat.ai',
        eventId: '$evt',
        deepLink: 'windy://chat/!r',
      }, { webpushOverride: wpMock });

      expect(result.ok).toBe(true);
      expect(wpMock.sendNotification).toHaveBeenCalledTimes(1);
      const [sub, bodyJson] = wpMock.sendNotification.mock.calls[0];
      expect(sub).toEqual(FAKE_SUB);
      const body = JSON.parse(bodyJson);
      expect(body.title).toBe('Grant');
      expect(body.body).toBe('New message');
      expect(body.tag).toBe('!r:chat.windychat.ai');
      expect(body.data).toEqual({
        room_id: '!r:chat.windychat.ai',
        event_id: '$evt',
        url: 'windy://chat/!r',
      });
    });

    it('returns { expired: true } on 410 Gone', async () => {
      setVapidEnv();
      const wp = require('../../lib/providers/web-push');
      const err = Object.assign(new Error('Gone'), { statusCode: 410 });
      const wpMock = makeWebpushMock({ sendImpl: async () => { throw err; } });
      wp.init({ webpushOverride: wpMock });

      const result = await wp.send(JSON.stringify(FAKE_SUB), { title: 't', body: 'b' }, {
        webpushOverride: wpMock,
      });
      expect(result.ok).toBe(false);
      expect(result.expired).toBe(true);
      expect(result.statusCode).toBe(410);
      expect(result.error).toBe('subscription_expired');
    });

    it('returns { expired: true } on 404 Not Found', async () => {
      setVapidEnv();
      const wp = require('../../lib/providers/web-push');
      const err = Object.assign(new Error('not found'), { statusCode: 404 });
      const wpMock = makeWebpushMock({ sendImpl: async () => { throw err; } });
      wp.init({ webpushOverride: wpMock });

      const result = await wp.send(JSON.stringify(FAKE_SUB), { title: 't', body: 'b' }, {
        webpushOverride: wpMock,
      });
      expect(result.expired).toBe(true);
      expect(result.statusCode).toBe(404);
    });

    it('flips status to "failed" on non-expired error', async () => {
      setVapidEnv();
      const wp = require('../../lib/providers/web-push');
      const wpMock = makeWebpushMock({
        sendImpl: async () => { throw new Error('500 internal'); },
      });
      wp.init({ webpushOverride: wpMock });

      const result = await wp.send(JSON.stringify(FAKE_SUB), { title: 't', body: 'b' }, {
        webpushOverride: wpMock,
      });
      expect(result.ok).toBe(false);
      expect(result.expired).toBeUndefined();
      expect(wp.status()).toBe('failed');
    });

    it('accepts an already-parsed subscription object', async () => {
      setVapidEnv();
      const wp = require('../../lib/providers/web-push');
      const wpMock = makeWebpushMock();
      wp.init({ webpushOverride: wpMock });

      const result = await wp.send(FAKE_SUB, { title: 't', body: 'b' }, {
        webpushOverride: wpMock,
      });
      expect(result.ok).toBe(true);
      expect(wpMock.sendNotification.mock.calls[0][0]).toEqual(FAKE_SUB);
    });
  });
});
