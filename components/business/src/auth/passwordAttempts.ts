/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * `auth.passwordAttempts`: the per-account delay on failed passwords.
 *
 * Every check of an account password (sign-in, password change, the MFA
 * step-up by password, MFA recovery) counts on one tally per account. After
 * `freeFailures` failures within `windowSeconds`, each further failure delays
 * the next attempt by `baseSeconds`, doubling up to `maxSeconds`. It is a
 * delay, never a lockout. `maxSeconds: 0` disables it.
 */

type PasswordAttemptsCfg = {
  windowSeconds: number;
  backoff: { freeFailures: number; baseSeconds: number; maxSeconds: number };
};

const PASSWORD_ATTEMPTS_DEFAULTS = Object.freeze({
  freeFailures: 5,
  baseSeconds: 2,
  maxSeconds: 300,
  windowSeconds: 900
});

/**
 * A non-negative integer from `raw[key]`, else the default. `null`, absent and
 * '' mean "not configured": coercing them would yield 0, which DISABLES what it
 * governs, so an unset key never reaches Number(). Anything else invalid also
 * keeps the default, so a config typo cannot open the login path.
 */
function countOr (raw: Record<string, unknown>, key: keyof typeof PASSWORD_ATTEMPTS_DEFAULTS): number {
  const value = raw[key];
  if (value == null || value === '') return PASSWORD_ATTEMPTS_DEFAULTS[key];
  const n = Number(value);
  return (Number.isFinite(n) && n >= 0) ? Math.floor(n) : PASSWORD_ATTEMPTS_DEFAULTS[key];
}

function normalizePasswordAttempts (raw: unknown): PasswordAttemptsCfg {
  const src = (raw != null && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  return {
    windowSeconds: countOr(src, 'windowSeconds'),
    backoff: {
      freeFailures: countOr(src, 'freeFailures'),
      baseSeconds: countOr(src, 'baseSeconds'),
      maxSeconds: countOr(src, 'maxSeconds')
    }
  };
}

export { normalizePasswordAttempts, PASSWORD_ATTEMPTS_DEFAULTS };
export type { PasswordAttemptsCfg };
