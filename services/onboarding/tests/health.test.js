const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.WINDY_JWT_SECRET = 'test-secret-ci-only';
process.env.SYNAPSE_REGISTRATION_SECRET = 'test-reg-secret';

let server;
let baseURL;

before(() => {
  // server.js exports { app } (destructured) — the old bare `require`
  // returned the module object and app.listen crashed every run; CI's
  // billing-lock hid it. Pre-existing, fixed with the OTP retire.
  const { app } = require('../server');
  server = app.listen(0);
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
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

// OTP path retired 2026-07-06 — /health must never report OTP providers.
test('GET /health never reports twilio/sendgrid (OTP path retired)', async () => {
  const res = await fetch(`${baseURL}/health`);
  const body = await res.json();
  assert.ok(!('twilio' in body.dependencies), 'twilio never reported');
  assert.ok(!('sendgrid' in body.dependencies), 'sendgrid never reported');
});
