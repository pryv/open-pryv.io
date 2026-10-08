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
const { MIN_CODE_LENGTH, MAX_CODE_LENGTH } = require('./generateCode.ts');
const { DEFAULT_CODE_LENGTH, DEFAULT_CODE_TTL_SECONDS } = require('./SingleService.ts');
const { SmsSendLimiter, SEND_LIMIT_DEFAULTS, smsDestination } = require('./smsSendLimits.ts');
const { smsEnrolmentContent, RESERVED_CONTENT_KEYS } = require('./smsRequest.ts');

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

type MethodCfg = { active?: boolean; mode?: string; endpoints?: Record<string, unknown>; contentKeys?: string[]; [k: string]: unknown };
type SendLimitsCfg = {
  minIntervalSeconds: number;
  perUserPerHour: number;
  perDestinationPerDay: number;
};
/** The SMS settings besides the endpoints and content keys. */
type SmsTuningCfg = {
  codeLength: number;
  codeTtlSeconds: number;
  sendLimits: SendLimitsCfg;
};
type BackoffCfg = {
  freeFailures: number;
  baseSeconds: number;
  maxSeconds: number;
};
type AttemptsCfg = {
  perSession: number;
  perAccountWindowSeconds: number;
  backoff: BackoffCfg;
};
type StepUpCfg = {
  required: boolean;
};
type NormalizedMfaConfig = {
  active: boolean;
  defaultMethod?: string;
  methods?: { totp?: MethodCfg; sms?: MethodCfg };
  sessions?: { ttlSeconds?: number };
  attempts?: AttemptsCfg;
  stepUp: StepUpCfg;
  /**
   * When true, an enrolled user whose method is not active on this server
   * logs in with the password only (former behaviour). Default false: such a
   * login is refused.
   */
  allowLoginWhenMethodInactive: boolean;
};
type RawMfaConfig = MFAConfig & {
  active?: boolean;
  defaultMethod?: string;
  methods?: { totp?: MethodCfg; sms?: MethodCfg };
  sms?: { endpoints?: Record<string, unknown>; contentKeys?: unknown; codeLength?: unknown; codeTtlSeconds?: unknown; sendLimits?: unknown };
  attempts?: Record<string, unknown>;
  stepUp?: { required?: unknown };
  allowLoginWhenMethodInactive?: unknown;
};

const BACKOFF_DEFAULTS: BackoffCfg = {
  freeFailures: 3,
  baseSeconds: 2,
  maxSeconds: 300
};
const ATTEMPTS_DEFAULTS = {
  perSession: 5,
  perAccountWindowSeconds: 900
};

/**
 * Copy the non-negative integer values of `raw` over `defaults`. `null`,
 * absent and '' mean "not configured" and keep the default: coercing them
 * would yield 0, which DISABLES what it governs rather than weakening nothing,
 * so an unset key must never reach Number(). Anything else invalid also keeps
 * the default, so a config typo cannot brick the login path.
 */
function mergeCounts<T extends Record<string, number>> (defaults: T, raw: unknown): T {
  const out = { ...defaults };
  const src = (raw != null && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  for (const key of Object.keys(defaults) as Array<keyof T & string>) {
    const value = src[key];
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) out[key] = Math.floor(n) as T[typeof key];
  }
  return out;
}

/**
 * Normalize the `services.mfa.attempts` block. `backoff.maxSeconds: 0` is
 * meaningful and preserved: it disables the per-account backoff, leaving only
 * the per-session ceiling (for deployments that throttle at the edge instead).
 * The keys of the former per-account lockout (`perAccount`, `lockoutSeconds`)
 * are no longer read; a boot warning reports them.
 */
function normalizeAttempts (raw: RawMfaConfig['attempts']): AttemptsCfg {
  return {
    ...mergeCounts(ATTEMPTS_DEFAULTS, raw),
    backoff: mergeCounts(BACKOFF_DEFAULTS, raw?.backoff)
  };
}

/**
 * Delay, in seconds, imposed after the `failures`-th failed second factor of a
 * user within the window: none for the first `freeFailures`, then
 * `baseSeconds` doubling on each further failure, capped at `maxSeconds`.
 * `maxSeconds: 0` disables it. A delay only ever postpones the next attempt;
 * nothing locks the user out.
 */
function delayForFailures (failures: number, backoff: BackoffCfg): number {
  if (backoff.maxSeconds === 0 || failures <= backoff.freeFailures) return 0;
  const exponent = Math.min(failures - backoff.freeFailures - 1, 30);
  return Math.min(backoff.baseSeconds * 2 ** exponent, backoff.maxSeconds);
}

/**
 * Normalize `services.mfa.stepUp`. Only an explicit boolean `false` turns the
 * step-up off; anything else (absent, a typo, a string) keeps it required, so
 * a config mistake can only make turning MFA off or replacing it stricter.
 * The boot check reports a value that is not a boolean.
 */
function normalizeStepUp (raw: RawMfaConfig['stepUp']): StepUpCfg {
  const src = (raw != null && typeof raw === 'object') ? raw : {};
  return { required: src.required !== false };
}

/**
 * Normalize the SMS content-key allow-list: the keys an SMS enrolment may
 * carry besides `phone`. Read from `methods.sms.contentKeys`, falling back to
 * the legacy `sms.contentKeys` when that is empty (as for the endpoints).
 * Only string entries are kept, never a reserved name (`phone`, always
 * accepted, nor the method and step-up fields); anything that is not an array
 * means none. The boot check reports invalid values.
 */
function normalizeContentKeys (cfg: RawMfaConfig): string[] {
  const own = cfg.methods?.sms?.contentKeys;
  const raw = (Array.isArray(own) && own.length > 0) ? own : cfg.sms?.contentKeys;
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === 'string' && k !== '' && !RESERVED_CONTENT_KEYS.includes(k));
}

/**
 * Normalize the SMS code and send settings: `codeLength`, `codeTtlSeconds`,
 * `sendLimits`. Each is read from `methods.sms` and from the legacy `sms`
 * block; the legacy mode reads the legacy block first, the multi-method model
 * `methods.sms` first (the first that sets a key wins, key by key for
 * `sendLimits`). A value out of range keeps the default; the boot check
 * refuses it.
 */
function normalizeSmsTuning (cfg: RawMfaConfig, legacyFirst: boolean): SmsTuningCfg {
  const own = (cfg.methods?.sms ?? {}) as Record<string, unknown>;
  const legacy = (cfg.sms ?? {}) as Record<string, unknown>;
  const layers = legacyFirst ? [legacy, own] : [own, legacy];
  const first = (key: string): unknown => {
    for (const layer of layers) {
      const value = layer[key];
      if (value != null && value !== '') return value;
    }
    return undefined;
  };
  const intIn = (value: unknown, min: number, max: number, fallback: number): number => {
    const n = Number(value);
    return (value != null && Number.isInteger(n) && n >= min && n <= max) ? n : fallback;
  };
  // Lowest precedence first: each layer overrides the keys it sets.
  let sendLimits: SendLimitsCfg = { ...SEND_LIMIT_DEFAULTS };
  for (const layer of [...layers].reverse()) sendLimits = mergeCounts(sendLimits, layer.sendLimits);
  return {
    codeLength: intIn(first('codeLength'), MIN_CODE_LENGTH, MAX_CODE_LENGTH, DEFAULT_CODE_LENGTH),
    codeTtlSeconds: intIn(first('codeTtlSeconds'), 1, Number.MAX_SAFE_INTEGER, DEFAULT_CODE_TTL_SECONDS),
    sendLimits
  };
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
  // Carried on every branch, MFA off included: mfa.deactivate stays callable
  // when MFA is off server-wide, and its step-up rule must not change then.
  const stepUp = normalizeStepUp(cfg.stepUp);
  // Only an explicit boolean `true` opts in; anything else keeps the refusal.
  const allowLoginWhenMethodInactive = cfg.allowLoginWhenMethodInactive === true;

  // N0 — explicit `active: false` wins. The shipped default is now `true`, so a
  // `false` value can only be deliberate operator intent to disable MFA, even
  // over a leftover legacy `mode`.
  if (cfg.active === false) return { active: false, stepUp, allowLoginWhenMethodInactive };

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
        sms: { active: true, mode: cfg.mode, endpoints: cfg.sms?.endpoints || {}, contentKeys: normalizeContentKeys(cfg), ...normalizeSmsTuning(cfg, true) },
        totp: { active: false }
      },
      sessions,
      attempts,
      stepUp,
      allowLoginWhenMethodInactive
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
    const sms: MethodCfg = { ...smsIn, active: smsIn.active === true, endpoints: smsEndpoints, contentKeys: normalizeContentKeys(cfg), ...normalizeSmsTuning(cfg, false) };
    const defaultMethod = cfg.defaultMethod || 'totp';
    // NB: we do NOT throw here if `defaultMethod` names an inactive method.
    // This normalizer runs on the login path too, so throwing would brick all
    // logins on a config typo. `mfa.activate` resolves `defaultMethod` through
    // getMFAMethod() and returns a clean invalid-mfa-method error when it is
    // inactive, which is the only place the default is actually used.
    return { active: true, defaultMethod, methods: { totp, sms }, sessions, attempts, stepUp, allowLoginWhenMethodInactive };
  }

  // N3 — disabled / absent.
  if (cfg.mode == null || cfg.mode === 'disabled') return { active: false, stepUp, allowLoginWhenMethodInactive };

  // Unknown mode keeps today's throw.
  throw new Error(`Unknown MFA mode "${cfg.mode}". Expected one of: disabled, challenge-verify, single`);
}

/**
 * SMS adapter: exposes the HTTP-provider `ChallengeVerifyService` /
 * `SingleService` through the `MfaMethod` contract, and checks the SMS send
 * limits (`smsSendLimits.ts`) before every send.
 */
type SendLimiterLike = { reserve: (send: { sessionId: string; username: string; destination: string }) => Promise<void> };

class SmsMethod implements MfaMethod {
  readonly name = 'sms';
  service: { challenge: Function; verify: Function };
  contentKeys: string[];
  limiter: SendLimiterLike | null;
  /**
   * @param contentKeys - enrolment keys accepted besides `phone`
   * @param limiter - the send limits, checked before every send (null: none, for unit tests)
   */
  constructor (service: { challenge: Function; verify: Function }, contentKeys: string[] = [], limiter: SendLimiterLike | null = null) {
    this.service = service;
    this.contentKeys = contentKeys;
    this.limiter = limiter;
  }

  checkEnrolParams (params: Record<string, unknown>): void {
    smsEnrolmentContent(params, this.contentKeys);
  }

  async enroll (_username: string, profile: ProfileType, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    // SMS enrolment content = `phone` plus the allow-listed keys of the
    // activate body (never the method or step-up fields), validated. The
    // challenge is sent once the MFA session exists (see `challenge`).
    const content = smsEnrolmentContent(params, this.contentKeys);
    (profile as unknown as { content: Record<string, unknown> }).content = content;
    return {};
  }

  /**
   * Send an SMS for the session `clientRequest.sessionId`, within the send
   * limits. Nothing of the client request reaches the provider service.
   */
  async challenge (username: string, profile: ProfileType, clientRequest: MfaClientRequest): Promise<Record<string, unknown>> {
    const sessionId = clientRequest?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('SMS MFA challenge without an MFA session');
    }
    const content = (profile as unknown as { content?: Record<string, unknown> }).content;
    if (this.limiter != null) await this.limiter.reserve({ sessionId, username, destination: smsDestination(content) });
    await this.service.challenge(username, profile, { headers: {}, body: {}, sessionId });
    return {};
  }

  async verify (username: string, profile: ProfileType, clientRequest: MfaClientRequest): Promise<void> {
    const code = (clientRequest?.body || {}).code;
    await this.service.verify(username, profile, { headers: {}, body: { code }, sessionId: clientRequest?.sessionId });
  }
}

// Per-method cache: one method instance per process (same rationale as the
// old `_mfaService`; the SMS `SingleService` keeps its pending codes in the
// MFA session records and the send limits their counters, both in cluster_kv,
// shared by the workers). Reset in tests.
let _methodCache: Map<string, MfaMethod> | null = null;
function methodCache (): Map<string, MfaMethod> {
  if (_methodCache === null) _methodCache = new Map();
  return _methodCache;
}

function buildSmsMethod (smsCfg: MethodCfg, sessions: NormalizedMfaConfig['sessions']): MfaMethod {
  const legacyShaped = { sms: { endpoints: smsCfg.endpoints || {} }, sessions };
  const contentKeys = Array.isArray(smsCfg.contentKeys) ? smsCfg.contentKeys : [];
  const sendLimits = (smsCfg.sendLimits as SendLimitsCfg | undefined) ?? { ...SEND_LIMIT_DEFAULTS };
  const limiter = new SmsSendLimiter(sendLimits);
  if (smsCfg.mode === 'challenge-verify') return new SmsMethod(new ChallengeVerifyService(legacyShaped), contentKeys, limiter);
  if (smsCfg.mode === 'single') {
    const single = new SingleService(legacyShaped, {
      sessionStore: getMFASessionStore({ sessions }),
      codeLength: smsCfg.codeLength as number | undefined,
      codeTtlSeconds: smsCfg.codeTtlSeconds as number | undefined
    });
    return new SmsMethod(single, contentKeys, limiter);
  }
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
  // Clears the whole MFA state in cluster_kv (sessions, enrolment slots, SMS
  // send counters), even when no session store was built in this process.
  try { await (_sessionStore ?? new SessionStore()).clearAll(); } catch (_) { /* may fail outside cluster: ignore */ }
  _mfaService = null;
  _sessionStore = null;
  _methodCache = null;
}

export { Profile, Service, ChallengeVerifyService, SingleService, SessionStore, generateCode, createMFAService, getMFAService, getMFASessionStore, _resetMFASingletons, normalizeMfaConfig, normalizeAttempts, normalizeStepUp, delayForFailures, getMFAMethod, getMFAMethodForProfile, SmsMethod, SmsSendLimiter, normalizeSmsTuning };
export type { AttemptsCfg, BackoffCfg, StepUpCfg, NormalizedMfaConfig, SendLimitsCfg, SmsTuningCfg };
export type { MfaMethod, MfaClientRequest } from './MfaMethod.ts';