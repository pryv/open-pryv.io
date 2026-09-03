/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { MfaMethod, MfaClientRequest } from './MfaMethod.ts';
import type { Profile as ProfileType } from './Profile.ts';
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

// ----------------------------------------------------------------------
// Multi-method model: config normalization + a per-method registry.
//
// The single-valued `mode` selector is superseded by an `active` +
// `defaultMethod` + `methods.{totp,sms}` shape. `normalizeMfaConfig` maps both
// the new shape and the legacy `mode` onto one normalized object so the API
// layer only ever sees the modern form. Legacy SMS deployments keep working
// unchanged through the shim (N2), which is why `createMFAService` above is
// left untouched (still used by its own unit test).
// ----------------------------------------------------------------------

type MethodCfg = { active?: boolean; mode?: string; endpoints?: Record<string, unknown>; [k: string]: unknown };
type AttemptsCfg = {
  perSession: number;
  perAccount: number;
  perAccountWindowSeconds: number;
  lockoutSeconds: number;
};
type NormalizedMfaConfig = {
  active: boolean;
  defaultMethod?: string;
  methods?: { totp?: MethodCfg; sms?: MethodCfg };
  sessions?: { ttlSeconds?: number };
  attempts?: AttemptsCfg;
};
type RawMfaConfig = MFAConfig & {
  active?: boolean;
  defaultMethod?: string;
  methods?: { totp?: MethodCfg; sms?: MethodCfg };
  sms?: { endpoints?: Record<string, unknown> };
  attempts?: Partial<Record<keyof AttemptsCfg, unknown>>;
};

const ATTEMPTS_DEFAULTS: AttemptsCfg = {
  perSession: 5,
  perAccount: 20,
  perAccountWindowSeconds: 900,
  lockoutSeconds: 900
};

/**
 * Normalize the `services.mfa.attempts` block. Each field falls back to its
 * default when absent or not a non-negative number, so a config typo weakens
 * nothing silently and cannot brick the login path. `perAccount: 0` is
 * meaningful and preserved: it disables the per-account limiter, leaving only
 * the per-session ceiling (the escape hatch for deployments that throttle at
 * the edge instead).
 */
function normalizeAttempts (raw: RawMfaConfig['attempts']): AttemptsCfg {
  const out = { ...ATTEMPTS_DEFAULTS };
  for (const key of Object.keys(ATTEMPTS_DEFAULTS) as Array<keyof AttemptsCfg>) {
    const value = raw?.[key];
    // `null` / absent / '' mean "not configured" and must fall back to the
    // default. Coercing them would yield 0, which silently DISABLES the limit
    // it governs (a zero lockout, or a zero window) rather than weakening
    // nothing, so an unset key must never reach Number().
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) out[key] = Math.floor(n);
  }
  return out;
}

let _warnedLegacyMode = false;
function mfaLogger (): { warn: (...args: unknown[]) => void } {
  try {
    const { getLogger } = require('@pryv/boiler');
    return getLogger('mfa');
  } catch {
    return { warn: (...args: unknown[]) => console.warn('[mfa]', ...args) };
  }
}

/**
 * Normalize a raw `services.mfa` block to the modern shape. Pure function,
 * called per-invocation at each read site (config is re-read for test
 * injection). Rule order: N0 (explicit active:false => off) / N2 (legacy
 * `mode` shim, takes precedence over the active-by-default so upgrades are
 * byte-identical) / N1 (new multi-method model) / N3 (disabled/absent).
 */
function normalizeMfaConfig (raw: RawMfaConfig | null | undefined): NormalizedMfaConfig {
  const cfg = (raw || {}) as RawMfaConfig;
  const sessions = cfg.sessions;
  const attempts = normalizeAttempts(cfg.attempts);

  // N0 — explicit `active: false` wins. The shipped default is now `true`, so a
  // `false` value can only be deliberate operator intent to disable MFA, even
  // over a leftover legacy `mode`.
  if (cfg.active === false) return { active: false };

  // N2 — a legacy non-disabled `mode` takes PRECEDENCE over the new-model
  // default (checked before N1). This is the critical upgrade-safety rule: a
  // pre-multi-method deployment (`mode: single|challenge-verify`, no `active`
  // key) merges over the now-`active:true` default; honouring the mode keeps
  // its SMS second factor enforced (byte-identical to before) instead of
  // silently dropping to a TOTP-only model where its SMS users would have no
  // active method. Such operators gain TOTP only after migrating off `mode`.
  if (cfg.mode === 'single' || cfg.mode === 'challenge-verify') {
    if (!_warnedLegacyMode) {
      mfaLogger().warn(`services.mfa.mode="${cfg.mode}" takes precedence (SMS-only) and is deprecated; remove it to adopt the multi-method model and enable TOTP.`);
      _warnedLegacyMode = true;
    }
    return {
      active: true,
      defaultMethod: 'sms',
      methods: {
        sms: { active: true, mode: cfg.mode, endpoints: cfg.sms?.endpoints || {} },
        totp: { active: false }
      },
      sessions,
      attempts
    };
  }

  // N1 — new multi-method model (active:true, no legacy mode).
  if (cfg.active === true) {
    const methods = cfg.methods || {};
    const totpIn = methods.totp || {};
    const smsIn = methods.sms || {};
    const totp: MethodCfg = { ...totpIn, active: totpIn.active !== false }; // default true
    const smsEndpoints = (smsIn.endpoints && Object.keys(smsIn.endpoints).length > 0)
      ? smsIn.endpoints
      : (cfg.sms?.endpoints || {}); // fall back to the legacy endpoints location
    const sms: MethodCfg = { ...smsIn, active: smsIn.active === true, endpoints: smsEndpoints };
    const defaultMethod = cfg.defaultMethod || 'totp';
    // NB: we do NOT throw here if `defaultMethod` names an inactive method.
    // This normalizer runs on the login path too, so throwing would brick all
    // logins on a config typo. `mfa.activate` resolves `defaultMethod` through
    // getMFAMethod() and returns a clean invalid-mfa-method error when it is
    // inactive, which is the only place the default is actually used.
    return { active: true, defaultMethod, methods: { totp, sms }, sessions, attempts };
  }

  // N3 — disabled / absent.
  if (cfg.mode == null || cfg.mode === 'disabled') return { active: false };

  // Unknown mode keeps today's throw.
  throw new Error(`Unknown MFA mode "${cfg.mode}". Expected one of: disabled, challenge-verify, single`);
}

/**
 * SMS adapter: exposes the HTTP-provider `ChallengeVerifyService` /
 * `SingleService` through the `MfaMethod` contract. Their internals and the
 * HTTP `Service` base class are untouched.
 */
class SmsMethod implements MfaMethod {
  readonly name = 'sms';
  service: { challenge: Function; verify: Function };
  constructor (service: { challenge: Function; verify: Function }) {
    this.service = service;
  }

  async enroll (username: string, profile: ProfileType, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    // SMS enrolment content = the activate body (phone etc.), minus the
    // method selector; then send the challenge, exactly as the pre-registry
    // activate did.
    const content = { ...params };
    delete (content as Record<string, unknown>).method;
    (profile as unknown as { content: Record<string, unknown> }).content = content;
    await this.service.challenge(username, profile, { headers: {}, body: params });
    return {};
  }

  async challenge (username: string, profile: ProfileType, clientRequest: MfaClientRequest): Promise<Record<string, unknown>> {
    await this.service.challenge(username, profile, clientRequest);
    return {};
  }

  async verify (username: string, profile: ProfileType, clientRequest: MfaClientRequest): Promise<void> {
    await this.service.verify(username, profile, clientRequest);
  }
}

// Per-method cache. The SMS `SingleService` holds a per-instance username->code
// map spanning challenge->verify, so a method MUST be a singleton across a
// flow (same rationale as the old `_mfaService`). Reset in tests.
let _methodCache: Map<string, MfaMethod> | null = null;
function methodCache (): Map<string, MfaMethod> {
  if (_methodCache === null) _methodCache = new Map();
  return _methodCache;
}

function buildSmsMethod (smsCfg: MethodCfg, sessions: NormalizedMfaConfig['sessions']): MfaMethod {
  const legacyShaped = { sms: { endpoints: smsCfg.endpoints || {} }, sessions };
  if (smsCfg.mode === 'challenge-verify') return new SmsMethod(new ChallengeVerifyService(legacyShaped));
  if (smsCfg.mode === 'single') return new SmsMethod(new SingleService(legacyShaped));
  throw new Error(`Unknown SMS MFA mode "${smsCfg.mode}". Expected challenge-verify or single`);
}

function buildTotpMethod (totpCfg: MethodCfg): MfaMethod {
  const TotpService = require('./TotpService.ts').default;
  return new TotpService(totpCfg);
}

/**
 * Resolve an MFA method by name against a NORMALIZED config. Returns null when
 * MFA is off or that method is not active. Built instances are cached.
 */
function getMFAMethod (name: string, normalizedCfg: NormalizedMfaConfig | null | undefined): MfaMethod | null {
  if (!normalizedCfg || normalizedCfg.active !== true) return null;
  const methods = (normalizedCfg.methods || {}) as Record<string, MethodCfg>;
  const mcfg = methods[name];
  if (!mcfg || mcfg.active !== true) return null;
  const cache = methodCache();
  const existing = cache.get(name);
  if (existing) return existing;
  let built: MfaMethod;
  if (name === 'sms') built = buildSmsMethod(mcfg, normalizedCfg.sessions);
  else if (name === 'totp') built = buildTotpMethod(mcfg);
  else throw new Error(`Unknown MFA method "${name}". Expected one of: totp, sms`);
  cache.set(name, built);
  return built;
}

/**
 * Resolve the MFA method for a stored profile (its `method`, defaulting to
 * 'sms' for legacy profiles). Null when that method is not active.
 */
function getMFAMethodForProfile (profile: { method?: string } | null | undefined, normalizedCfg: NormalizedMfaConfig | null | undefined): MfaMethod | null {
  const name = (profile && profile.method) ? profile.method : 'sms';
  return getMFAMethod(name, normalizedCfg);
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
  _methodCache = null;
}

export { Profile, Service, ChallengeVerifyService, SingleService, SessionStore, generateCode, createMFAService, getMFAService, getMFASessionStore, _resetMFASingletons, normalizeMfaConfig, getMFAMethod, getMFAMethodForProfile, SmsMethod };
export type { MfaMethod, MfaClientRequest } from './MfaMethod.ts';