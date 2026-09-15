/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Static, method-aware description of whether this deployment can send mail,
 * and whether the account email-verification flow is live.
 *
 * Config only: no I/O, no SMTP probe. It answers "is mail configured", never
 * "is the mail server up". A live probe would make the boot depend on an
 * external service and turn a transient outage into a failed restart.
 *
 * One predicate serves the boot validation, `bin/check-config.js`, the runtime
 * gate and `service.info`, so those four can never disagree about whether a
 * verification mail would be sent.
 */

export type ConfigReader = { get: (key: string) => unknown };

export type ScopedConfigReader = ConfigReader & {
  getScopeAndValue?: (key: string) => { value: unknown; scope: string; info: string } | null;
};

export type MailMethod = 'in-process' | 'microservice' | 'mandrill';

export type MailCapability = {
  ok: boolean;
  /** The configured `services.email.method`, or null when unset or unknown. */
  method: MailMethod | null;
  /** Human-readable reasons when `ok` is false (dotted config paths). */
  problems: string[];
};

export type VerificationMailStatus = {
  /** True when a verification mail would actually be sent. */
  enabled: boolean;
  /** Why not, when `enabled` is false. */
  reason: 'disabled' | 'missing-page-url' | 'mail-not-configured' | null;
  /**
   * True when `services.email.enabled.verifyEmail` was set by the operator, as
   * opposed to coming from the shipped default file. Drives how strict the boot
   * validation is about `auth.emailVerificationPageURL`.
   */
  explicit: boolean;
};

const METHODS: readonly string[] = ['in-process', 'microservice', 'mandrill'];

/**
 * A value is treated as "missing / unset" when it would render the feature
 * non-functional: null/undefined, the empty string, or one of the two
 * placeholder sentinels. Same semantics as the config-validation plugin's
 * helper of the same name; duplicated rather than imported because that plugin
 * is a CJS file under `config/` and the business layer must not depend on it.
 */
function isMissingOrSentinel (value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  if (value.includes('REPLACE')) return true;
  if (/\$\{[A-Z_][A-Z0-9_]*\}/.test(value)) return true;
  return false;
}

export function describeMailCapability (config: ConfigReader): MailCapability {
  const problems: string[] = [];

  if (config.get('services:email:enabled') === false) {
    problems.push('services.email.enabled is false');
  }

  const rawMethod = config.get('services:email:method');
  const method: MailMethod | null =
    typeof rawMethod === 'string' && METHODS.includes(rawMethod)
      ? (rawMethod as MailMethod)
      : null;

  if (method == null) {
    problems.push('services.email.method must be one of in-process, microservice, mandrill');
  } else if (method === 'in-process') {
    // SMTP delivery: we need somewhere to send and something to send as.
    if (isMissingOrSentinel(config.get('services:email:smtp:host'))) {
      problems.push('services.email.smtp.host missing or unset');
    }
    if (isMissingOrSentinel(config.get('services:email:from:address'))) {
      problems.push('services.email.from.address missing or unset');
    }
  } else {
    // HTTP delivery (external mail service or Mandrill): endpoint plus key.
    if (isMissingOrSentinel(config.get('services:email:url'))) {
      problems.push('services.email.url missing or unset');
    }
    if (isMissingOrSentinel(config.get('services:email:key'))) {
      problems.push('services.email.key missing or unset');
    }
  }

  return { ok: problems.length === 0, method, problems };
}

/**
 * Whether the account email-verification flow (the mailed link) is live, and
 * why not when it is not. Rules are ordered: the operator switching the feature
 * off is reported as `disabled` even if the rest is also incomplete.
 */
export function describeVerificationMail (config: ScopedConfigReader): VerificationMailStatus {
  const explicit = isVerifyEmailExplicit(config);

  const enabledSetting = config.get('services:email:enabled');
  const off =
    enabledSetting === false ||
    (enabledSetting != null &&
      typeof enabledSetting === 'object' &&
      (enabledSetting as { verifyEmail?: unknown }).verifyEmail === false);
  if (off) return { enabled: false, reason: 'disabled', explicit };

  // The mailed link points at this page; without it the mail is undeliverable
  // in the sense that matters (the holder cannot act on it).
  if (isMissingOrSentinel(config.get('auth:emailVerificationPageURL'))) {
    return { enabled: false, reason: 'missing-page-url', explicit };
  }

  if (!describeMailCapability(config).ok) {
    return { enabled: false, reason: 'mail-not-configured', explicit };
  }

  return { enabled: true, reason: null, explicit };
}

/**
 * True when the operator set `services.email.enabled.verifyEmail` themselves,
 * rather than inheriting the shipped default.
 *
 * A plain config object cannot prove where a value came from, so it counts as
 * explicit. That is the conservative direction: it can only make
 * `auth.emailVerificationPageURL` required, never silently optional.
 */
function isVerifyEmailExplicit (config: ScopedConfigReader): boolean {
  if (typeof config.getScopeAndValue !== 'function') return true;
  const scoped = config.getScopeAndValue('services:email:enabled:verifyEmail');
  if (scoped == null) return false;
  return scoped.scope !== 'default-file';
}
