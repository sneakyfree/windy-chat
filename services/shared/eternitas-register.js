/**
 * Windy Chat — Eternitas Platform Registration
 *
 * On boot, registers Windy Chat as a platform with the Eternitas registry.
 * Skips registration if already registered (checks on startup).
 *
 * Usage:
 *   const { registerWithEternitas } = require('../shared/eternitas-register');
 *   registerWithEternitas(); // fire-and-forget on startup
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ETERNITAS_URL = process.env.ETERNITAS_URL || process.env.ETERNITAS_API_URL || 'https://api.eternitas.ai';
const WEBHOOK_URL = process.env.ETERNITAS_WEBHOOK_URL || 'https://chat.windyword.ai/api/v1/webhooks/eternitas';
const CONTACT_EMAIL = process.env.ETERNITAS_CONTACT_EMAIL || 'admin@windychat.com';
const PLATFORM_ID_FILE = path.join(__dirname, '..', '.eternitas-platform-id');

/**
 * Register Windy Chat as a platform with Eternitas.
 * Stores the platform_id locally to avoid re-registering.
 */
async function registerWithEternitas() {
  // Check if already registered
  try {
    if (fs.existsSync(PLATFORM_ID_FILE)) {
      const platformId = fs.readFileSync(PLATFORM_ID_FILE, 'utf-8').trim();
      if (platformId) {
        console.log(`[eternitas-register] Already registered as platform ${platformId}`);
        return platformId;
      }
    }
  } catch { /* file read failed, try registering */ }

  const registrationBody = JSON.stringify({
    name: 'Windy Chat',
    webhook_url: WEBHOOK_URL,
    contact_email: CONTACT_EMAIL,
  });

  return new Promise((resolve) => {
    const url = `${ETERNITAS_URL}/api/v1/platforms/register`;
    const httpModule = url.startsWith('https') ? https : http;
    const parsed = new URL(url);

    const req = httpModule.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(registrationBody),
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const body = JSON.parse(data);
            const platformId = body.platform_id || body.id || 'registered';
            // Persist platform ID
            try {
              fs.writeFileSync(PLATFORM_ID_FILE, platformId);
            } catch (e) {
              console.warn(`[eternitas-register] Could not persist platform ID: ${e.message}`);
            }
            console.log(`[eternitas-register] Registered with Eternitas as platform ${platformId}`);
            resolve(platformId);
          } catch {
            console.warn('[eternitas-register] Could not parse registration response');
            resolve(null);
          }
        } else if (res.statusCode === 409) {
          // Already registered
          console.log('[eternitas-register] Platform already registered with Eternitas');
          try {
            const body = JSON.parse(data);
            const platformId = body.platform_id || body.id || 'already-registered';
            fs.writeFileSync(PLATFORM_ID_FILE, platformId);
            resolve(platformId);
          } catch {
            resolve('already-registered');
          }
        } else {
          console.warn(`[eternitas-register] Registration failed: ${res.statusCode} ${data.slice(0, 200)}`);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.warn(`[eternitas-register] Could not reach Eternitas at ${ETERNITAS_URL}: ${e.message}`);
      resolve(null);
    });
    req.on('timeout', () => {
      console.warn('[eternitas-register] Registration request timed out');
      req.destroy();
      resolve(null);
    });
    req.write(registrationBody);
    req.end();
  });
}

module.exports = { registerWithEternitas };
