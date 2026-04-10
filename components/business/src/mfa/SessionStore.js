/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { v4: uuidv4 } = require('uuid');

/**
 * In-memory MFA session store.
 *
 * Sessions are short-lived (default 30 min) and exist only between a login
 * call (or activate call) and the matching verify/confirm call. They are
 * keyed by `mfaToken` — a UUID v4 returned to the client in lieu of an
 * access token while MFA is pending.
 *
 * Single-core only: sessions are not shared across cores or workers. A
 * follow-up plan can swap this with an rqlite-backed implementation if
 * cross-core MFA flows become necessary.
 */
class SessionStore {
  /**
   * @param {number} ttlSeconds - session lifetime in seconds (default 1800)
   */
  constructor (ttlSeconds = 1800) {
    this.ttlMilliseconds = ttlSeconds * 1000;
    /** @type {Map<string, { id: string, profile: any, context: any, _timeout: NodeJS.Timeout }>} */
    this.sessions = new Map();
  }

  /**
   * Create a new session and return its mfaToken.
   *
   * @param {Object} profile - the MFA profile (with content + recoveryCodes)
   * @param {Object} context - opaque per-flow context (e.g. the resolved user, login params)
   * @returns {string} the mfaToken (UUID v4)
   */
  create (profile, context) {
    const id = uuidv4();
    const timeout = setTimeout(() => this.clear(id), this.ttlMilliseconds);
    // Don't keep the event loop alive for an idle session.
    if (typeof timeout.unref === 'function') timeout.unref();
    this.sessions.set(id, { id, profile, context, _timeout: timeout });
    return id;
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  has (id) {
    return this.sessions.has(id);
  }

  /**
   * @param {string} id
   * @returns {{id: string, profile: any, context: any}|undefined}
   */
  get (id) {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    // Strip the internal timeout handle from the returned shape.
    return { id: session.id, profile: session.profile, context: session.context };
  }

  /**
   * Clear a session immediately. Idempotent — safe to call on an unknown id.
   * @param {string} id
   * @returns {boolean} true if a session was removed
   */
  clear (id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    clearTimeout(session._timeout);
    return this.sessions.delete(id);
  }

  /**
   * Number of live sessions (for tests / metrics).
   * @returns {number}
   */
  size () {
    return this.sessions.size;
  }

  /**
   * Drop everything (for tests / shutdown).
   */
  clearAll () {
    for (const session of this.sessions.values()) {
      clearTimeout(session._timeout);
    }
    this.sessions.clear();
  }
}

module.exports = SessionStore;
