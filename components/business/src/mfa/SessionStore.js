/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { randomUUID: uuidv4 } = require('node:crypto');
const Profile = require('./Profile');

/**
 * MFA session store, backed by `cluster_kv` (master-held in-memory map +
 * worker IPC).
 *
 * Sessions are short-lived (default 30 min) and exist only between a login
 * (or activate) call and the matching verify/confirm call. They are keyed
 * by `mfaToken` — a UUID v4 returned to the client in lieu of an access
 * token while MFA is pending.
 *
 * Cluster-aware (Plan 55): with `cluster.apiWorkers > 1`, login may land on
 * worker A and verify on worker B. Backing on cluster_kv makes the store
 * worker-symmetric within a single core. For cross-core MFA flows (a future
 * need; not today) swap the backing for PlatformDB.
 */
class SessionStore {
  /**
   * @param {number} ttlSeconds - session lifetime in seconds (default 1800)
   * @param {Object} [opts]
   * @param {Object} [opts.kvClient] - injectable; defaults to a fresh
   *   `cluster_kv.clientFor()` over the live process IPC channel.
   * @param {string} [opts.namespace='mfa-session/'] - key prefix in cluster_kv.
   */
  constructor (ttlSeconds = 1800, opts = {}) {
    this.ttlMilliseconds = ttlSeconds * 1000;
    const clusterKv = require('messages/src/cluster_kv');
    this.kv = opts.kvClient || clusterKv.clientFor();
    this.namespace = opts.namespace || 'mfa-session/';
  }

  /**
   * Create a new session and return its mfaToken.
   *
   * @param {Object} profile - the MFA profile (with content + recoveryCodes)
   * @param {Object} context - opaque per-flow context (e.g. the resolved user, login params)
   * @returns {Promise<string>} the mfaToken (UUID v4)
   */
  async create (profile, context) {
    const id = uuidv4();
    // Profile is stored as a plain shape so it survives JSON round-trips
    // through the IPC channel; `get()` rehydrates the Profile class.
    const stored = {
      id,
      profile: { content: profile?.content || {}, recoveryCodes: profile?.recoveryCodes || [] },
      context
    };
    await this.kv.set(this.namespace + id, stored, { ttlMs: this.ttlMilliseconds });
    return id;
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async has (id) {
    return (await this.kv.get(this.namespace + id)) != null;
  }

  /**
   * @param {string} id
   * @returns {Promise<{id: string, profile: any, context: any}|undefined>}
   */
  async get (id) {
    const session = await this.kv.get(this.namespace + id);
    if (!session) return undefined;
    const profile = new Profile(
      session.profile?.content || {},
      session.profile?.recoveryCodes || []
    );
    return { id: session.id, profile, context: session.context };
  }

  /**
   * Clear a session immediately. Idempotent — safe to call on an unknown id.
   * @param {string} id
   * @returns {Promise<boolean>} true if a session was removed
   */
  async clear (id) {
    const existed = (await this.kv.get(this.namespace + id)) != null;
    await this.kv.delete(this.namespace + id);
    return existed;
  }

  /**
   * Drop everything (for tests / shutdown).
   */
  async clearAll () {
    await this.kv.clear();
  }
}

module.exports = SessionStore;
