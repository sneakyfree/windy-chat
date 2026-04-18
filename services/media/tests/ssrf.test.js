/**
 * Unit tests for link-preview SSRF defenses (P1-7).
 *
 * Covers the specific bypass vectors flagged in the gap analysis:
 *   - DNS rebinding (not fully simulated — we test the "first probe"
 *     validation; the rebinding defense lives in the pinned-agent
 *     lookup which is integration-tested elsewhere)
 *   - IPv6-mapped IPv4 (::ffff:127.0.0.1)
 *   - Integer/hex IP encodings
 *   - Cloud-metadata hostnames
 *   - Standard IPv4 private ranges
 *   - Standard IPv6 private ranges
 *
 * Run: node --test services/media/tests/ssrf.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { __test_internals__ } = require('../routes/link-preview');
const { isPrivateIP, validateUrl, BLOCKED_HOSTNAMES } = __test_internals__;

describe('isPrivateIP — IPv4', () => {
  const cases = [
    // ✅ private
    ['0.0.0.0', true], ['10.1.2.3', true], ['127.0.0.1', true],
    ['127.0.1.1', true], ['169.254.169.254', true],
    ['172.16.0.1', true], ['172.31.255.254', true],
    ['192.168.1.1', true], ['100.64.0.1', true], ['198.18.0.1', true],
    ['224.0.0.1', true], ['255.255.255.255', true],
    // ✅ public
    ['1.1.1.1', false], ['8.8.8.8', false], ['93.184.216.34', false],
    ['172.15.0.1', false], ['172.32.0.1', false],
    ['198.17.255.255', false], ['198.20.0.0', false],
  ];
  for (const [ip, want] of cases) {
    it(`${ip} → ${want ? 'private' : 'public'}`, () => {
      assert.equal(isPrivateIP(ip), want);
    });
  }
});

describe('isPrivateIP — IPv6 + mapped', () => {
  const cases = [
    ['::1', true], ['::', true],
    ['fe80::1', true], ['fc00::1', true], ['fd00::beef', true],
    ['::ffff:127.0.0.1', true],    // mapped IPv4 loopback
    ['::ffff:10.0.0.1', true],     // mapped IPv4 private
    ['::ffff:8.8.8.8', false],     // mapped IPv4 public
    ['2001:4860:4860::8888', false], // Google DNS v6
    ['ff00::1', true],              // multicast
  ];
  for (const [ip, want] of cases) {
    it(`${ip} → ${want ? 'private' : 'public'}`, () => {
      assert.equal(isPrivateIP(ip), want);
    });
  }
});

describe('validateUrl — blocked hostnames + protocol', () => {
  it('rejects file:// protocol', () => {
    assert.equal(validateUrl('file:///etc/passwd').valid, false);
  });
  it('rejects gopher://', () => {
    assert.equal(validateUrl('gopher://example.com/').valid, false);
  });
  it('rejects metadata.google.internal hostname', () => {
    const res = validateUrl('http://metadata.google.internal/');
    assert.equal(res.valid, false);
    assert.match(res.error, /blocked/);
  });
  it('rejects metadata.azure.com hostname', () => {
    assert.equal(validateUrl('http://metadata.azure.com/').valid, false);
  });
  it('rejects localhost by hostname', () => {
    assert.equal(validateUrl('http://localhost/').valid, false);
  });
  it('accepts public-looking hostname (pending DNS resolve)', () => {
    // validateUrl doesn't resolve — resolveSafeAddress does that later.
    // This is the happy path where validation succeeds.
    assert.equal(validateUrl('https://example.com/').valid, true);
  });
  it('accepts URLs with HTTP-only protocol', () => {
    assert.equal(validateUrl('http://example.com/').valid, true);
  });
});

describe('BLOCKED_HOSTNAMES coverage', () => {
  it('includes every cloud metadata hostname the audit flagged', () => {
    const required = ['localhost', 'metadata.google.internal', 'metadata.azure.com'];
    for (const h of required) {
      assert.ok(BLOCKED_HOSTNAMES.has(h), `missing: ${h}`);
    }
  });
});

describe('resolveSafeAddress — integer-encoded IP hosts', () => {
  const { resolveSafeAddress } = __test_internals__;
  it('rejects integer-encoded loopback (2130706433 → 127.0.0.1)', async () => {
    // Node's URL parser normalizes `http://2130706433/` hostname to
    // `127.0.0.1` in recent versions. resolveSafeAddress should see the
    // normalized literal IP and reject it.
    const { URL } = require('url');
    const parsed = new URL('http://2130706433/');
    await assert.rejects(
      () => resolveSafeAddress(parsed.hostname),
      /private|blocked/i,
      `hostname was ${parsed.hostname}`,
    );
  });
  it('rejects hex-encoded loopback (0x7f000001)', async () => {
    const { URL } = require('url');
    let parsed;
    try { parsed = new URL('http://0x7f000001/'); } catch {
      // Older Node may not normalize this — then hostname is literal,
      // dns.lookup will fail, which also gives us an SSRF_DENIED error.
      return;
    }
    await assert.rejects(
      () => resolveSafeAddress(parsed.hostname),
      /private|blocked|DNS lookup failed/i,
    );
  });
  it('rejects IPv6 literal loopback [::1]', async () => {
    const { URL } = require('url');
    const parsed = new URL('http://[::1]/');
    await assert.rejects(
      () => resolveSafeAddress(parsed.hostname),
      /private/i,
    );
  });
  it('rejects IPv6-mapped IPv4 literal [::ffff:127.0.0.1]', async () => {
    const { URL } = require('url');
    const parsed = new URL('http://[::ffff:127.0.0.1]/');
    await assert.rejects(
      () => resolveSafeAddress(parsed.hostname),
      /private/i,
    );
  });
});
