/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * MFA business module.
 *
 * Exposes the MFA service implementations (`ChallengeVerifyService`,
 * `SingleService`) plus shared types (`Profile`) and a factory that picks the
 * right service based on `mfaConfig.mode`.
 *
 * Session storage lives in `./SessionStore`.
 */

const Profile = require('./Profile.ts').default;
const Service = require('./Service.ts').default;
const ChallengeVerifyService = require('./ChallengeVerifyService.ts').default;
const SingleService = require('./SingleService.ts').default;
const SessionStore = require('./SessionStore.ts').default;
const generateCode = require('./generateCode.ts').default;

type MFAConfig = {
  mode?: 'disabled' | 'challenge-verify' | 'single' | string;
  sessions?: { ttlSeconds?: number };
  [k: string]: unknown;
};
type MFAServiceLike = unknown; // Service implementation — opaque from the façade's POV
type MFASessionStoreLike = { clearAll: () => Promise<void> };

/**
 * Build the MFA service implementation matching `mfaConfig.mode`.
 * Returns null when MFA is disabled — callers should treat that as
 * "MFA not configured" (login flow stays unchanged).
 *
 * @param mfaConfig - the `services.mfa` config block
 */
function createMFAService (mfaConfig: MFAConfig | null | undefined): MFAServiceLike | null {
  if (!mfaConfig || mfaConfig.mode == null || mfaConfig.mode === 'disabled') return null;
  if (mfaConfig.mode === 'challenge-verify') return new ChallengeVerifyService(mfaConfig);
  if (mfaConfig.mode === 'single') return new SingleService(mfaConfig);
  throw new Error(`Unknown MFA mode "${mfaConfig.mode}". Expected one of: disabled, challenge-verify, single`);
}

// Per-worker MFA service singleton (stateless once built).
//
// The `_sessionStore` reference itself is per-worker but the underlying
// storage is `cluster_kv` (master-held), so every worker in the cluster
// sees the same MFA sessions. The earlier per-worker `Map` broke the
// login → verify flow when polls round-robined across workers.
let _mfaService: MFAServiceLike | null = null;
let _sessionStore: MFASessionStoreLike | null = null;

/**
 * Get (or lazily build) the process-wide MFA service singleton from `services.mfa` config.
 * Returns null when MFA is disabled.
 *
 * @param mfaConfig - `services.mfa` config block
 */
function getMFAService (mfaConfig: MFAConfig | null | undefined): MFAServiceLike | null {
  if (_mfaService === null) _mfaService = createMFAService(mfaConfig);
  return _mfaService;
}

/**
 * Get (or lazily build) the process-wide MFA session store singleton.
 *
 * @param mfaConfig - `services.mfa` config block (read sessions.ttlSeconds)
 */
function getMFASessionStore (mfaConfig: MFAConfig | null | undefined): MFASessionStoreLike {
  if (_sessionStore === null) {
    const ttl = mfaConfig?.sessions?.ttlSeconds ?? 1800;
    _sessionStore = new SessionStore(ttl);
  }
  return _sessionStore!;
}

/**
 * Reset singletons — for tests only. Async because `clearAll()` now goes
 * through cluster_kv (master IPC).
 */
async function _resetMFASingletons (): Promise<void> {
  if (_sessionStore) {
    try { await _sessionStore.clearAll(); } catch (_) { /* may fail outside cluster — ignore */ }
  }
  _mfaService = null;
  _sessionStore = null;
}

export { Profile, Service, ChallengeVerifyService, SingleService, SessionStore, generateCode, createMFAService, getMFAService, getMFASessionStore, _resetMFASingletons };