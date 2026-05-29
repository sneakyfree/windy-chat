const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.WINDY_JWT_SECRET = 'test-secret-ci-only';
process.env.SYNAPSE_REGISTRATION_SECRET = 'test-reg-secret';

let server;
let baseURL;

before(() => {
  const app = require('../server');
  server = app.listen(0);
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  delete process.env.CHAT_OTP_ENABLED;
});

// /health always reports core deps.
test('GET /health returns ok with core dependencies', async () => {
  const res = await fetch(`${baseURL}/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'ok');
  assert.ok(body.dependencies, 'has dependencies');
  assert.ok('synapse' in body.dependencies, 'reports synapse');
  assert.ok('redis' in body.dependencies, 'reports redis');
});

// Twilio/SendGrid back the OTP verify path, which is off by default (identity
// is delegated to windy-pro). They're gated behind CHAT_OTP_ENABLED so /health
// doesn't report a misleading `false` for an intentionally-unconfigured feature.
// checks() reads the env at request time, so we can toggle on one server.
test('GET /health omits twilio/sendgrid when OTP disabled (default)', async () => {
  delete process.env.CHAT_OTP_ENABLED;
  const res = await fetch(`${baseURL}/health`);
  const body = await res.json();
  assert.ok(!('twilio' in body.dependencies), 'twilio omitted when OTP off');
  assert.ok(!('sendgrid' in body.dependencies), 'sendgrid omitted when OTP off');
});

test('GET /health reports twilio/sendgrid when OTP enabled', async () => {
  process.env.CHAT_OTP_ENABLED = 'true';
  const res = await fetch(`${baseURL}/health`);
  const body = await res.json();
  assert.ok('twilio' in body.dependencies, 'twilio reported when OTP on');
  assert.ok('sendgrid' in body.dependencies, 'sendgrid reported when OTP on');
});
