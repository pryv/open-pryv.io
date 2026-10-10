/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * `auth.passwordAttempts`: the limits on failed passwords.
 *
 * Every check of an account password (sign-in, password change, the MFA
 * step-up by password, MFA recovery) counts on one tally per account. After
 * `freeFailures` failures within `windowSeconds`, each further failure delays
 * the next attempt by `baseSeconds`, doubling up to `maxSeconds`. It is a
 * delay, never a lockout. `maxSeconds: 0` disables it.
 *
 * The same checks also count, per client address, on `perIp`: past
 * `perIp.maxFailures` failures within `perIp.windowSeconds`, those checks are
 * refused from that address until the window ends, whatever the account.
 * `perIp.maxFailures: 0` disables it.
 */

type PasswordIpCfg = { maxFailures: number; windowSeconds: number };

type PasswordAttemptsCfg = {
  windowSeconds: number;
  backoff: { freeFailures: number; baseSeconds: number; maxSeconds: number };
  perIp: PasswordIpCfg;
};

const PASSWORD_ATTEMPTS_DEFAULTS = Object.freeze({
  freeFailures: 5,
  baseSeconds: 2,
  maxSeconds: 300,
  windowSeconds: 900
});

const PASSWORD_IP_DEFAULTS = Object.freeze({
  maxFailures: 30,
  windowSeconds: 900
});

/**
 * A non-negative integer from `raw[key]`, else the default. `null`, absent and
 * '' mean "not configured": coercing them would yield 0, which DISABLES what it
 * governs, so an unset key never reaches Number(). Anything else invalid also
 * keeps the default, so a config typo cannot open the login path.
 */
function countOr<K extends string> (raw: Record<string, unknown>, key: K, defaults: Readonly<Record<K, number>>): number {
  const value = raw[key];
  if (value == null || value === '') return defaults[key];
  const n = Number(value);
  return (Number.isFinite(n) && n >= 0) ? Math.floor(n) : defaults[key];
}

function objectOr (raw: unknown): Record<string, unknown> {
  return (raw != null && typeof raw === 'object') ? raw as Record<string, unknown> : {};
}

function normalizePasswordAttempts (raw: unknown): PasswordAttemptsCfg {
  const src = objectOr(raw);
  const perIp = objectOr(src.perIp);
  return {
    windowSeconds: countOr(src, 'windowSeconds', PASSWORD_ATTEMPTS_DEFAULTS),
    backoff: {
      freeFailures: countOr(src, 'freeFailures', PASSWORD_ATTEMPTS_DEFAULTS),
      baseSeconds: countOr(src, 'baseSeconds', PASSWORD_ATTEMPTS_DEFAULTS),
      maxSeconds: countOr(src, 'maxSeconds', PASSWORD_ATTEMPTS_DEFAULTS)
    },
    perIp: {
      maxFailures: countOr(perIp, 'maxFailures', PASSWORD_IP_DEFAULTS),
      // A zero-length window would count nothing: keep the default.
      windowSeconds: countOr(perIp, 'windowSeconds', PASSWORD_IP_DEFAULTS) || PASSWORD_IP_DEFAULTS.windowSeconds
    }
  };
}

export { normalizePasswordAttempts, PASSWORD_ATTEMPTS_DEFAULTS, PASSWORD_IP_DEFAULTS };
export type { PasswordAttemptsCfg, PasswordIpCfg };
