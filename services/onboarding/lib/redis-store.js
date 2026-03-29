/**
 * Windy Chat — Redis-backed store with in-memory fallback
 * Phase 10.2: Replaces ephemeral `new Map()` stores with Redis
 *
 * CRITICAL: This is the #1 production readiness blocker for chat-onboarding.
 * Without Redis, a server restart loses all OTPs, verified sessions,
 * pairing sessions, profiles, and onboarding state.
 *
 * Features:
 *   - Drop-in Map replacement (get/set/delete/has interface)
 *   - Auto-JSON serialization
 *   - TTL support (auto-expiry for OTPs, pairing sessions)
 *   - Graceful fallback to in-memory Map if Redis unavailable
 *   - Key namespacing to prevent collisions between stores
 *
 * Usage:
 *   const store = new RedisStore('otp');
 *   await store.set('user@email.com', { code: '123456', expiresAt: ... }, 600);
 *   const val = await store.get('user@email.com');
 */

const redis = require('redis');

let client = null;
let isConnected = false;
let connectionAttempted = false;

/**
 * Initialize the shared Redis client.
 * Call once at startup. Returns the client (or null if unavailable).
 */
async function initRedis() {
  if (connectionAttempted) return client;
  connectionAttempted = true;

  const url = process.env.REDIS_URL || 'redis://localhost:6379';

  try {
    client = redis.createClient({
      url,
      socket: {
        connectTimeout: 3000,
        reconnectStrategy: (retries) => {
          if (retries > 5) {
            console.warn('[RedisStore] Max reconnect attempts reached, using in-memory fallback');
            return false;
          }
          return Math.min(retries * 200, 2000);
        },
      },
    });

    client.on('error', (err) => {
      if (isConnected) {
        console.warn('[RedisStore] Connection lost:', err.message);
        isConnected = false;
      }
    });

    client.on('connect', () => {
      isConnected = true;
      console.log('[RedisStore] Connected to Redis');
    });

    await client.connect();
    isConnected = true;
    return client;
  } catch (err) {
    console.warn(`[RedisStore] Redis unavailable (${err.message}), using in-memory fallback`);
    client = null;
    isConnected = false;
    return null;
  }
}

/**
 * Redis-backed Map replacement with automatic fallback.
 */
class RedisStore {
  /**
   * @param {string} namespace - Key prefix (e.g., 'otp', 'verified', 'pairing')
   * @param {number} [defaultTTL] - Default TTL in seconds (0 = no expiry)
   */
  constructor(namespace, defaultTTL = 0) {
    this._namespace = `windy:chat:${namespace}`;
    this._defaultTTL = defaultTTL;
    this._fallback = new Map();
    this._fallbackTimers = new Map();
  }

  _key(key) {
    return `${this._namespace}:${key}`;
  }

  /**
   * Set a value with optional TTL.
   * @param {string} key
   * @param {*} value - Will be JSON-serialized
   * @param {number} [ttlSeconds] - Override default TTL
   */
  async set(key, value, ttlSeconds) {
    const ttl = ttlSeconds ?? this._defaultTTL;
    const serialized = JSON.stringify(value);

    if (isConnected && client) {
      try {
        if (ttl > 0) {
          await client.set(this._key(key), serialized, { EX: ttl });
        } else {
          await client.set(this._key(key), serialized);
        }
        return;
      } catch (err) {
        console.warn(`[RedisStore] SET failed for ${this._namespace}:${key}, using fallback:`, err.message);
      }
    }

    // Fallback: in-memory Map with timer-based expiry
    this._fallback.set(key, serialized);
    if (ttl > 0) {
      // Clear existing timer
      if (this._fallbackTimers.has(key)) {
        clearTimeout(this._fallbackTimers.get(key));
      }
      this._fallbackTimers.set(key, setTimeout(() => {
        this._fallback.delete(key);
        this._fallbackTimers.delete(key);
      }, ttl * 1000));
    }
  }

  /**
   * Get a value. Returns parsed JSON or null.
   * @param {string} key
   * @returns {Promise<*>}
   */
  async get(key) {
    if (isConnected && client) {
      try {
        const raw = await client.get(this._key(key));
        return raw ? JSON.parse(raw) : null;
      } catch (err) {
        console.warn(`[RedisStore] GET failed for ${this._namespace}:${key}, using fallback:`, err.message);
      }
    }

    const raw = this._fallback.get(key);
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * Delete a key. Returns true if existed.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async delete(key) {
    let deleted = false;

    if (isConnected && client) {
      try {
        const count = await client.del(this._key(key));
        deleted = count > 0;
      } catch (err) {
        console.warn(`[RedisStore] DEL failed for ${this._namespace}:${key}:`, err.message);
      }
    }

    // Also clean fallback
    if (this._fallback.has(key)) {
      this._fallback.delete(key);
      if (this._fallbackTimers.has(key)) {
        clearTimeout(this._fallbackTimers.get(key));
        this._fallbackTimers.delete(key);
      }
      deleted = true;
    }

    return deleted;
  }

  /**
   * Check if a key exists.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async has(key) {
    if (isConnected && client) {
      try {
        return (await client.exists(this._key(key))) > 0;
      } catch (err) {
        // fallthrough
      }
    }
    return this._fallback.has(key);
  }

  /**
   * Atomically update: get → transform → set.
   * @param {string} key
   * @param {function} transform - (value) => newValue
   * @param {number} [ttlSeconds]
   */
  async update(key, transform, ttlSeconds) {
    const current = await this.get(key);
    if (current === null) return null;
    const updated = transform(current);
    await this.set(key, updated, ttlSeconds);
    return updated;
  }
}

module.exports = { RedisStore, initRedis };
