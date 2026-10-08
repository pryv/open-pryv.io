/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { normalizeMfaConfig, normalizeAttempts } from './index.ts';
import { NON_CONTENT_KEYS } from './smsRequest.ts';

/**
 * Boot-time check of `services.mfa`. The MFA normalizer on the login path
 * deliberately never throws (a config typo must not brick every login), so a
 * setting that cannot work would otherwise surface only request by request.
 * This check runs once at boot instead:
 *  - `problems`: explicit settings that cannot work; the boot is refused.
 *  - `warnings`: settings that are ignored or replaced by a default; logged.
 * Pure: takes the raw `services.mfa` block, touches nothing else.
 */

type Problem = { message: string; path: string[] };
type Raw = Record<string, unknown>;

const MODES = ['disabled', 'single', 'challenge-verify'];
const SMS_MODES = ['single', 'challenge-verify'];
const KEY_BYTES = 32;

const obj = (v: unknown): Raw => (v != null && typeof v === 'object' && !Array.isArray(v)) ? v as Raw : {};
const isSet = (v: unknown): boolean => v != null && v !== '';

function describeMfaConfig (rawMfa: unknown): { problems: Problem[]; warnings: string[] } {
  const problems: Problem[] = [];
  const warnings: string[] = [];
  const base = ['services', 'mfa'];
  const raw = obj(rawMfa);

  if (isSet(raw.mode) && !MODES.includes(raw.mode as string)) {
    problems.push({ message: `unknown mode "${raw.mode}"; expected one of ${MODES.join(', ')}. Every MFA login would fail.`, path: [...base, 'mode'] });
    return { problems, warnings };
  }

  const cfg = normalizeMfaConfig(raw);
  const legacyMode = raw.mode === 'single' || raw.mode === 'challenge-verify';
  if (cfg.active === true && legacyMode) {
    warnings.push(`services.mfa.mode="${raw.mode}" is in effect: MFA runs SMS-only and TOTP is unavailable. Remove the legacy mode to use the multi-method model.`);
  }

  if (cfg.active === true) {
    const methods = obj(cfg.methods);
    const def = cfg.defaultMethod;
    if (!legacyMode && (typeof def !== 'string' || obj(methods[def]).active !== true)) {
      const activeList = Object.keys(methods).filter((m) => obj(methods[m]).active === true).join(', ') || 'none';
      if (typeof raw.defaultMethod === 'string') {
        problems.push({ message: `defaultMethod "${def}" is not an active MFA method (active: ${activeList}); mfa.activate without an explicit method would always fail.`, path: [...base, 'defaultMethod'] });
      } else {
        // Not set by the operator: the implicit "totp" is inactive here. Clients
        // naming their method still work, so warn rather than refuse.
        warnings.push(`services.mfa.defaultMethod is not set and its implicit value "${def}" is not an active method (active: ${activeList}): mfa.activate without an explicit method fails. Set defaultMethod.`);
      }
    }

    const totp = obj(methods.totp);
    if (totp.active === true) {
      const tPath = [...base, 'methods', 'totp'];
      if (isSet(totp.secretsKey)) {
        const len = typeof totp.secretsKey === 'string' ? Buffer.from(totp.secretsKey, 'base64').length : -1;
        if (len !== KEY_BYTES) {
          problems.push({ message: `secretsKey must be the base64 of ${KEY_BYTES} bytes (got ${len < 0 ? 'a non-string' : len + ' bytes'}); every TOTP enrolment would fail.`, path: [...tPath, 'secretsKey'] });
        }
      }
      const intIn = (key: string, min: number, max: number) => {
        if (!isSet(totp[key])) return;
        const n = Number(totp[key]);
        if (!Number.isInteger(n) || n < min || n > max) {
          problems.push({ message: `${key} must be an integer from ${min} to ${max}, got ${JSON.stringify(totp[key])}.`, path: [...tPath, key] });
        }
      };
      intIn('digits', 6, 8);
      intIn('periodSeconds', 1, 3600);
      intIn('driftSteps', 0, 10);
    }

    const sms = obj(methods.sms);
    if (sms.active === true) {
      const sPath = legacyMode ? [...base, 'mode'] : [...base, 'methods', 'sms'];
      if (!SMS_MODES.includes(sms.mode as string)) {
        problems.push({ message: `SMS mode "${sms.mode}" is not one of ${SMS_MODES.join(', ')}.`, path: [...sPath, 'mode'] });
      } else {
        const endpoints = obj(sms.endpoints);
        const needed = sms.mode === 'single' ? ['single'] : ['challenge', 'verify'];
        const missing = needed.filter((e) => !isSet(obj(endpoints[e]).url));
        if (missing.length > 0) {
          problems.push({ message: `SMS mode "${sms.mode}" needs an endpoint url for ${missing.join(' and ')} (services.mfa.methods.sms.endpoints, or the legacy services.mfa.sms.endpoints); every SMS challenge would fail.`, path: [...sPath, 'endpoints'] });
        }
      }
      // The allow-list of enrolment keys besides `phone`, read from the raw
      // block (the normalizer drops what is invalid).
      const keyLists: Array<[unknown, string[]]> = [
        [obj(obj(raw.methods).sms).contentKeys, [...base, 'methods', 'sms', 'contentKeys']],
        [obj(raw.sms).contentKeys, [...base, 'sms', 'contentKeys']]
      ];
      for (const [keys, path] of keyLists) {
        if (keys == null) continue;
        if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || k === '')) {
          problems.push({ message: `contentKeys must be a list of key names, got ${JSON.stringify(keys)}.`, path });
          continue;
        }
        const reserved = keys.filter((k) => NON_CONTENT_KEYS.includes(k));
        if (reserved.length > 0) {
          problems.push({ message: `contentKeys cannot name ${reserved.map((k) => `"${k}"`).join(', ')}: ${NON_CONTENT_KEYS.join(', ')} are never enrolment content.`, path });
        }
        if (keys.includes('phone')) {
          warnings.push(`${path.join('.')} lists "phone", which is always accepted; the entry has no effect.`);
        }
      }
    }

    const sessions = obj(raw.sessions);
    if (isSet(sessions.ttlSeconds)) {
      const n = Number(sessions.ttlSeconds);
      if (!Number.isFinite(n) || n < 1) {
        problems.push({ message: `sessions.ttlSeconds must be a number of at least 1, got ${JSON.stringify(sessions.ttlSeconds)}.`, path: [...base, 'sessions', 'ttlSeconds'] });
      }
    }
  }

  // Step-up on turning MFA off or replacing it. Checked whether MFA is active
  // or not: mfa.deactivate stays callable either way.
  if (isSet(raw.stepUp) && (typeof raw.stepUp !== 'object' || Array.isArray(raw.stepUp))) {
    problems.push({ message: `stepUp must be a mapping, got ${JSON.stringify(raw.stepUp)}.`, path: [...base, 'stepUp'] });
  } else {
    const stepUp = obj(raw.stepUp);
    if (isSet(stepUp.required) && typeof stepUp.required !== 'boolean') {
      problems.push({ message: `stepUp.required must be true or false, got ${JSON.stringify(stepUp.required)}.`, path: [...base, 'stepUp', 'required'] });
    } else if (stepUp.required === false) {
      warnings.push('services.mfa.stepUp.required is false: mfa.deactivate, and mfa.activate over an active enrolment, accept a personal token alone, without the account password or a code of the current factor. This opt-out is for one release only and will be removed in a later release; update your clients to send the step-up.');
    }
  }

  // Login of an enrolled user whose method is not active: refused unless the
  // operator opts back into the password-only login.
  if (isSet(raw.allowLoginWhenMethodInactive) && typeof raw.allowLoginWhenMethodInactive !== 'boolean') {
    problems.push({ message: `allowLoginWhenMethodInactive must be true or false, got ${JSON.stringify(raw.allowLoginWhenMethodInactive)}.`, path: [...base, 'allowLoginWhenMethodInactive'] });
  } else if (raw.allowLoginWhenMethodInactive === true) {
    warnings.push('services.mfa.allowLoginWhenMethodInactive is true: an account enrolled in an MFA method that is not active on this server logs in with the password only, without a second factor. A warning is logged at each such login.');
  }

  // Attempts: never refuse the boot here (an upgraded deployment must keep
  // booting), but say what is ignored or replaced.
  const attempts = obj(raw.attempts);
  const removed = ['perAccount', 'lockoutSeconds'].filter((k) => k in attempts);
  if (removed.length > 0) {
    warnings.push(`services.mfa.attempts.${removed.join(' and services.mfa.attempts.')} ${removed.length > 1 ? 'are' : 'is'} no longer read: the per-account limiter is now a backoff (delays, never a lockout). Configure services.mfa.attempts.backoff instead.`);
  }
  const invalid = (block: Raw, keys: string[], prefix: string) => {
    for (const k of keys) {
      const v = block[k];
      if (!isSet(v)) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) warnings.push(`${prefix}.${k} = ${JSON.stringify(v)} is not a non-negative number; the default is used.`);
    }
  };
  invalid(attempts, ['perSession', 'perAccountWindowSeconds'], 'services.mfa.attempts');
  if (isSet(attempts.backoff) && (typeof attempts.backoff !== 'object' || Array.isArray(attempts.backoff))) {
    warnings.push(`services.mfa.attempts.backoff = ${JSON.stringify(attempts.backoff)} is not a mapping; the defaults are used.`);
  }
  invalid(obj(attempts.backoff), ['freeFailures', 'baseSeconds', 'maxSeconds'], 'services.mfa.attempts.backoff');
  // Combinations that silently weaken the backoff (read after normalization).
  const eff = normalizeAttempts(obj(raw.attempts));
  if (eff.backoff.maxSeconds > 0 && eff.backoff.baseSeconds === 0) {
    warnings.push('services.mfa.attempts.backoff.baseSeconds is 0 while maxSeconds is not: every delay is 0, so the per-account backoff is off. Set maxSeconds: 0 to say so, or a baseSeconds above 0.');
  }
  if (eff.backoff.maxSeconds > eff.perAccountWindowSeconds) {
    warnings.push(`services.mfa.attempts.backoff.maxSeconds (${eff.backoff.maxSeconds}) exceeds perAccountWindowSeconds (${eff.perAccountWindowSeconds}): the tally lapses first, so every delay is cut short at perAccountWindowSeconds.`);
  }

  return { problems, warnings };
}

/**
 * Boot check that needs the user data: SMS enrolments (a profile `mfa` with
 * `method: sms` or no method, the legacy shape) while SMS is not an active
 * method, which happens when the legacy `mode` is removed without activating
 * `methods.sms`. Those accounts are refused at login (or, with
 * `allowLoginWhenMethodInactive`, log in with the password only).
 *
 * `countSmsEnrolments` is the storage count, or null when the engine cannot
 * count across users cheaply; it is called only when the configuration makes
 * SMS enrolments unusable. Returns the warning to log, or null. Never throws:
 * a failing count goes to `onError` and yields null.
 */
async function describeInactiveSmsEnrolments (
  rawMfa: unknown,
  countSmsEnrolments: (() => Promise<number>) | null,
  onError?: (err: unknown) => void
): Promise<string | null> {
  try {
    const cfg = normalizeMfaConfig(obj(rawMfa));
    if (cfg.active !== true) return null; // MFA off server-wide: nobody is asked for a second factor
    if (obj(obj(cfg.methods).sms).active === true) return null;
    if (countSmsEnrolments == null) return null;
    const count = await countSmsEnrolments();
    if (!(count > 0)) return null;
    const what = `${count} account(s) on this core are enrolled in SMS MFA, but SMS is not an active method (services.mfa.methods.sms.active is not true and no legacy services.mfa.mode is set)`;
    if (cfg.allowLoginWhenMethodInactive) {
      return `${what}: they log in with the password only, because services.mfa.allowLoginWhenMethodInactive is true. Activate services.mfa.methods.sms with its endpoints to ask them for their second factor again.`;
    }
    return `${what}: their logins are refused (403 mfa-method-inactive). Activate services.mfa.methods.sms with its endpoints, or set services.mfa.allowLoginWhenMethodInactive: true to let them log in with the password only.`;
  } catch (err) {
    if (onError) onError(err);
    return null;
  }
}

export { describeMfaConfig, describeInactiveSmsEnrolments };
