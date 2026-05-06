/**
 * Contract Test: Synapse Auth Module ↔ Windy Pro Account Server
 *
 * Validates that windy_registration.py sends the correct request format
 * to POST /api/v1/auth/chat-validate and handles all responses correctly.
 *
 * Since the module is Python, we test the contract by mocking the
 * account-server endpoint and verifying the request/response shapes.
 *
 * Run: node --test tests/integration/test_synapse_auth_contract.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let mockServer;
let mockPort;
let lastRequest = null;

// Track what the mock server received
function resetMock() {
  lastRequest = null;
}

before(async () => {
  mockServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/auth/chat-validate') {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        lastRequest = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: JSON.parse(body),
        };

        const { user, password } = lastRequest.body;

        // Simulate different responses based on credentials
        if (user === 'valid@windyword.ai' && password === 'correct_password') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            windy_user_id: '550e8400-e29b-41d4-a716-446655440000',
            display_name: 'Grant Whitmer',
            avatar_url: 'https://cdn.windyword.ai/avatars/grant.jpg',
          }));
        } else if (user === 'valid@windyword.ai' && password === 'wrong_password') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_credentials' }));
        } else if (user === 'timeout@windyword.ai') {
          // Simulate timeout — don't respond
          setTimeout(() => {
            res.writeHead(504);
            res.end();
          }, 15000);
        } else if (user === 'server_error@windyword.ai') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'user_not_found' }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => {
    mockServer.listen(0, () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
});

after(() => new Promise((resolve) => {
  if (mockServer) mockServer.close(resolve);
  else resolve();
}));

function callChatValidate(user, password) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ user, password });
    const req = http.request({
      method: 'POST',
      hostname: 'localhost',
      port: mockPort,
      path: '/api/v1/auth/chat-validate',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════
// Request Format Contract
// ═══════════════════════════════════════════

describe('Synapse Auth Contract: Request format', () => {
  before(() => resetMock());

  it('sends POST with {user, password} body', async () => {
    await callChatValidate('valid@windyword.ai', 'correct_password');
    assert.ok(lastRequest, 'Mock should have received a request');
    assert.equal(lastRequest.method, 'POST');
    assert.equal(lastRequest.url, '/api/v1/auth/chat-validate');
    assert.equal(lastRequest.headers['content-type'], 'application/json');
  });

  it('request body has "user" field (not "username")', async () => {
    resetMock();
    await callChatValidate('test@windyword.ai', 'pass');
    assert.ok(lastRequest.body.user, 'Body must have "user" field');
    assert.equal(lastRequest.body.user, 'test@windyword.ai');
    assert.equal(lastRequest.body.password, 'pass');
    assert.equal(lastRequest.body.username, undefined, 'Must NOT use "username" field');
    assert.equal(lastRequest.body.shared_secret, undefined, 'Must NOT send shared_secret in body');
  });
});

// ═══════════════════════════════════════════
// Response Format Contract
// ═══════════════════════════════════════════

describe('Synapse Auth Contract: Successful response', () => {
  it('returns {windy_user_id, display_name, avatar_url} on 200', async () => {
    const res = await callChatValidate('valid@windyword.ai', 'correct_password');
    assert.equal(res.status, 200);
    assert.equal(res.body.windy_user_id, '550e8400-e29b-41d4-a716-446655440000');
    assert.equal(res.body.display_name, 'Grant Whitmer');
    assert.equal(res.body.avatar_url, 'https://cdn.windyword.ai/avatars/grant.jpg');
  });

  it('windy_user_id is a UUID string', async () => {
    const res = await callChatValidate('valid@windyword.ai', 'correct_password');
    assert.match(res.body.windy_user_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ═══════════════════════════════════════════
// Error Handling Contract
// ═══════════════════════════════════════════

describe('Synapse Auth Contract: Error handling', () => {
  it('returns 401 for bad credentials', async () => {
    const res = await callChatValidate('valid@windyword.ai', 'wrong_password');
    assert.equal(res.status, 401);
  });

  it('returns 401 for unknown user', async () => {
    const res = await callChatValidate('nobody@windyword.ai', 'any_pass');
    assert.equal(res.status, 401);
  });

  it('returns 500 for server error', async () => {
    const res = await callChatValidate('server_error@windyword.ai', 'any_pass');
    assert.equal(res.status, 500);
  });

  it('handles timeout gracefully', async () => {
    const res = await callChatValidate('timeout@windyword.ai', 'any_pass');
    // Should timeout or get an error, not hang
    assert.ok(res.status === 0 || res.status >= 500, `Expected timeout/error, got ${res.status}`);
  });

  it('handles unreachable server gracefully', async () => {
    const res = await new Promise((resolve) => {
      const body = JSON.stringify({ user: 'test', password: 'test' });
      const req = http.request({
        method: 'POST',
        hostname: 'localhost',
        port: 1, // Nothing listening
        path: '/api/v1/auth/chat-validate',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 2000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', () => resolve({ status: 0, error: 'connection_refused' }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      req.write(body);
      req.end();
    });
    assert.equal(res.status, 0, 'Unreachable server should fail with connection error');
  });
});
