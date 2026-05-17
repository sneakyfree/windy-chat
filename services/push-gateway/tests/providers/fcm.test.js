/**
 * Unit tests for the FCM provider wrapper.
 *
 * We mock the firebase-admin SDK by passing an `adminOverride` into init()
 * and send() — no real network calls, no real service-account JSON.
 *
 * These tests are intentionally narrow: they verify (a) the wrapper plumbs
 * env config through correctly, (b) status() flips between
 * unconfigured / ok / failed at the right times, (c) send() returns the
 * documented { ok, messageId } shape, and (d) Android channel routing is
 * passed through to the SDK message payload.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Create a fake service-account JSON resolvable via require(). We park it in
// os.tmpdir() so the repo working tree stays clean — fcmProvider.init() just
// needs a require()-able JSON file, not a particular location.
const FAKE_SA_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'push-gw-fcm-test-')),
  'fake-fcm-sa.json',
);

beforeAll(() => {
  fs.writeFileSync(FAKE_SA_PATH, JSON.stringify({
    type: 'service_account',
    project_id: 'windy-chat-test',
    private_key: 'fake',
    client_email: 'fake@windy-chat-test.iam.gserviceaccount.com',
  }));
});

beforeEach(() => {
  jest.resetModules();
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
});

function makeAdminMock({ sendImpl } = {}) {
  const messagingSend = jest.fn(sendImpl || (async () => 'projects/x/messages/abc-123'));
  return {
    initializeApp: jest.fn(() => ({ name: 'fake-app' })),
    credential: { cert: jest.fn((sa) => ({ _sa: sa })) },
    messaging: () => ({ send: messagingSend }),
    _messagingSend: messagingSend,
  };
}

describe('lib/providers/fcm', () => {
  describe('status() — config gating', () => {
    it('returns "unconfigured" when FIREBASE_SERVICE_ACCOUNT is missing', () => {
      const fcm = require('../../lib/providers/fcm');
      expect(fcm.init()).toBe(false);
      expect(fcm.status()).toBe('unconfigured');
      expect(fcm.isConfigured()).toBe(false);
    });

    it('returns "unconfigured" when service-account JSON cannot be loaded', () => {
      process.env.FIREBASE_SERVICE_ACCOUNT = '/does/not/exist.json';
      const fcm = require('../../lib/providers/fcm');
      expect(fcm.init({ adminOverride: makeAdminMock() })).toBe(false);
      expect(fcm.status()).toBe('unconfigured');
    });

    it('returns "ok" after successful init with no sends yet', () => {
      process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SA_PATH;
      const fcm = require('../../lib/providers/fcm');
      expect(fcm.init({ adminOverride: makeAdminMock() })).toBe(true);
      expect(fcm.status()).toBe('ok');
      expect(fcm.isConfigured()).toBe(true);
    });
  });

  describe('send()', () => {
    it('returns { stubbed: true } when not configured', async () => {
      const fcm = require('../../lib/providers/fcm');
      const result = await fcm.send('any-token', { title: 't', body: 'b' });
      expect(result).toEqual({ stubbed: true });
    });

    it('calls firebase-admin messaging().send() with the right shape', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SA_PATH;
      const fcm = require('../../lib/providers/fcm');
      const adminMock = makeAdminMock();
      fcm.init({ adminOverride: adminMock });

      const result = await fcm.send('device-token-abc', {
        title: 'Grant',
        body: 'New message',
        badge: 3,
        roomId: '!r:chat.windychat.ai',
        eventId: '$evt',
        eventType: 'mail.inbound',
        deepLink: 'windy://mail/inbox',
      }, { adminOverride: adminMock, channelId: 'mail' });

      expect(result.ok).toBe(true);
      expect(result.messageId).toBe('projects/x/messages/abc-123');

      expect(adminMock._messagingSend).toHaveBeenCalledTimes(1);
      const message = adminMock._messagingSend.mock.calls[0][0];
      expect(message.token).toBe('device-token-abc');
      expect(message.notification.title).toBe('Grant');
      expect(message.notification.body).toBe('New message');
      expect(message.data.room_id).toBe('!r:chat.windychat.ai');
      expect(message.data.event_id).toBe('$evt');
      expect(message.data.deep_link).toBe('windy://mail/inbox');
      expect(message.android.notification.channelId).toBe('mail');
      expect(message.android.notification.notificationCount).toBe(3);
      expect(message.android.priority).toBe('high');
    });

    it('flips status to "failed" when the SDK throws', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SA_PATH;
      const fcm = require('../../lib/providers/fcm');
      const adminMock = makeAdminMock({
        sendImpl: async () => { throw new Error('UNREGISTERED'); },
      });
      fcm.init({ adminOverride: adminMock });

      const result = await fcm.send('dead-token', { title: 't', body: 'b' }, {
        adminOverride: adminMock,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('UNREGISTERED');
      expect(fcm.status()).toBe('failed');
    });

    it('flips status back to "ok" on a subsequent successful send', async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SA_PATH;
      const fcm = require('../../lib/providers/fcm');
      let shouldThrow = true;
      const adminMock = makeAdminMock({
        sendImpl: async () => {
          if (shouldThrow) throw new Error('transient');
          return 'projects/x/messages/ok';
        },
      });
      fcm.init({ adminOverride: adminMock });

      await fcm.send('t', { title: 't', body: 'b' }, { adminOverride: adminMock });
      expect(fcm.status()).toBe('failed');

      shouldThrow = false;
      const result = await fcm.send('t', { title: 't', body: 'b' }, { adminOverride: adminMock });
      expect(result.ok).toBe(true);
      expect(fcm.status()).toBe('ok');
    });
  });

  it('init() is idempotent — second call is a no-op', () => {
    process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SA_PATH;
    const fcm = require('../../lib/providers/fcm');
    const adminMock = makeAdminMock();
    expect(fcm.init({ adminOverride: adminMock })).toBe(true);
    expect(adminMock.initializeApp).toHaveBeenCalledTimes(1);
    expect(fcm.init({ adminOverride: adminMock })).toBe(true);
    expect(adminMock.initializeApp).toHaveBeenCalledTimes(1);
  });
});
