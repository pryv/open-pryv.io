/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

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

// Process-wide singletons (single-core only — see Plan 26 SessionState).
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
 * Reset singletons — for tests only.
 */
function _resetMFASingletons () {
  if (_sessionStore) _sessionStore.clearAll();
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
