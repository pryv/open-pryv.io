/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { normalizeMfaConfig } from './index.ts';

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
      problems.push({ message: `defaultMethod "${def}" is not an active MFA method (active: ${Object.keys(methods).filter((m) => obj(methods[m]).active === true).join(', ') || 'none'}); mfa.activate without an explicit method would always fail.`, path: [...base, 'defaultMethod'] });
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
    }

    const sessions = obj(raw.sessions);
    if (isSet(sessions.ttlSeconds)) {
      const n = Number(sessions.ttlSeconds);
      if (!Number.isFinite(n) || n < 1) {
        problems.push({ message: `sessions.ttlSeconds must be a number of at least 1, got ${JSON.stringify(sessions.ttlSeconds)}.`, path: [...base, 'sessions', 'ttlSeconds'] });
      }
    }
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

  return { problems, warnings };
}

export { describeMfaConfig };
