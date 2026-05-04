/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * MFA business module — ported from service-mfa as part of Plan 26.
 *
 * Exposes the MFA service implementations (`ChallengeVerifyService`,
 * `SingleService`) plus shared types (`Profile`) and a factory that picks the
 * right service based on `mfaConfig.mode`.
 *
 * Session storage lives in `./SessionStore` (Plan 26 Phase 3).
 */

const Profile = require('./Profile');
const Service = require('./Service');
const ChallengeVerifyService = require('./ChallengeVerifyService');
const SingleService = require('./SingleService');
const SessionStore = require('./SessionStore');
const generateCode = require('./generateCode');

/**
 * Build the MFA service implementation matching `mfaConfig.mode`.
 * Returns null when MFA is disabled — callers should treat that as
 * "MFA not configured" (login flow stays unchanged).
 *
 * @param {Object} mfaConfig - the `services.mfa` config block
 * @returns {Service|null}
 */
function createMFAService (mfaConfig) {
  if (!mfaConfig || mfaConfig.mode == null || mfaConfig.mode === 'disabled') return null;
  if (mfaConfig.mode === 'challenge-verify') return new ChallengeVerifyService(mfaConfig);
  if (mfaConfig.mode === 'single') return new SingleService(mfaConfig);
  throw new Error(`Unknown MFA mode "${mfaConfig.mode}". Expected one of: disabled, challenge-verify, single`);
}

// Per-worker MFA service singleton (stateless once built).
//
// SessionStore (Plan 55): the `_sessionStore` reference itself is per-worker
// but the underlying storage is `cluster_kv` (master-held), so every worker
// in the cluster sees the same MFA sessions. Different from Plan 26's
// original "single-core only" framing — under cluster.fork() that meant
// per-worker, which broke the login → verify flow when polls round-robined.
let _mfaService = null;
let _sessionStore = null;

/**
 * Get (or lazily build) the process-wide MFA service singleton from `services.mfa` config.
 * Returns null when MFA is disabled.
 *
 * @param {Object} mfaConfig - `services.mfa` config block
 * @returns {Service|null}
 */
function getMFAService (mfaConfig) {
  if (_mfaService === null) _mfaService = createMFAService(mfaConfig);
  return _mfaService;
}

/**
 * Get (or lazily build) the process-wide MFA session store singleton.
 *
 * @param {Object} mfaConfig - `services.mfa` config block (read sessions.ttlSeconds)
 * @returns {SessionStore}
 */
function getMFASessionStore (mfaConfig) {
  if (_sessionStore === null) {
    const ttl = mfaConfig?.sessions?.ttlSeconds ?? 1800;
    _sessionStore = new SessionStore(ttl);
  }
  return _sessionStore;
}

/**
 * Reset singletons — for tests only. Async because `clearAll()` now goes
 * through cluster_kv (master IPC).
 */
async function _resetMFASingletons () {
  if (_sessionStore) {
    try { await _sessionStore.clearAll(); } catch (_) { /* may fail outside cluster — ignore */ }
  }
  _mfaService = null;
  _sessionStore = null;
}

module.exports = {
  Profile,
  Service,
  ChallengeVerifyService,
  SingleService,
  SessionStore,
  generateCode,
  createMFAService,
  getMFAService,
  getMFASessionStore,
  _resetMFASingletons
};
