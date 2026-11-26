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

import { PLACEHOLDER_PATTERN, weakSecretReason } from '../secretValues.ts';

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
   * True when `services.email.sendVerifyEmail` was set by the operator, as
   * opposed to coming from the shipped default file. Drives how strict the boot
   * validation is about `auth.emailVerificationPageURL`.
   */
  explicit: boolean;
};

const METHODS: readonly string[] = ['in-process', 'microservice', 'mandrill'];

/**
 * A value is treated as "missing / unset" when it would render the feature
 * non-functional: null/undefined, the empty string, a `REPLACE` or `${VAR}`
 * sentinel, or a template placeholder such as `OVERRIDE ME` (the shared
 * predicate in secretValues.ts).
 */
function isMissingOrSentinel (value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  if (value.includes('REPLACE')) return true;
  if (/\$\{[A-Z_][A-Z0-9_]*\}/.test(value)) return true;
  return PLACEHOLDER_PATTERN.test(value);
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
    // SMTP delivery: we need somewhere to send. `services.email.from` is
    // deliberately NOT required here, because the sender is optional at the
    // transport (the renderer omits the header when it is unset) and this
    // predicate now decides whether the verification feature runs at all:
    // demanding a key the runtime never demanded would turn a deployment that
    // was sending mail into one that silently stops. A missing sender is a
    // deliverability concern for the relay to raise, not a reason to declare
    // this platform incapable of mail.
    if (isMissingOrSentinel(config.get('services:email:smtp:host'))) {
      problems.push('services.email.smtp.host missing or unset');
    }
  } else {
    // HTTP delivery (external mail service or Mandrill): endpoint plus key.
    if (isMissingOrSentinel(config.get('services:email:url'))) {
      problems.push('services.email.url missing or unset');
    }
    const key = config.get('services:email:key');
    if (isMissingOrSentinel(key) || weakSecretReason(key) != null) {
      problems.push('services.email.key missing or unset');
    }
  }

  return { ok: problems.length === 0, method, problems };
}

export type MergeLanguage = 'mailchimp' | 'handlebars';
export const MERGE_LANGUAGES: readonly MergeLanguage[] = ['mailchimp', 'handlebars'];

/**
 * `services.email.mergeLanguage`: the merge-tag language Mandrill uses to fill
 * the variables of a send (its `merge_language`). Unset, Mandrill applies the
 * account's default, Mailchimp merge tags (`*|VAR|*`), whose HTML escaping its
 * documentation does not state; `handlebars` escapes `{{VAR}}`. Only read with
 * method `mandrill`.
 */
export function describeMergeLanguage (config: ConfigReader): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const value = config.get('services:email:mergeLanguage');
  if (value != null && value !== '') {
    if (typeof value !== 'string' || !(MERGE_LANGUAGES as readonly string[]).includes(value)) {
      problems.push("services.email.mergeLanguage must be 'handlebars' or 'mailchimp' (or unset)");
    }
  } else if (config.get('services:email:method') === 'mandrill' && config.get('services:email:enabled') !== false) {
    warnings.push('services.email.mergeLanguage is not set (method mandrill): Mandrill fills the template variables ' +
      'with its account default, Mailchimp merge tags (*|VAR|*), whose HTML escaping it does not document, so a value ' +
      "such as a name or an administrator's reason may reach the mail as HTML. Set 'services.email.mergeLanguage: " +
      "handlebars' and write the Mandrill templates with {{VAR}} (escaped), or set 'mailchimp' to keep *|VAR|* " +
      'templates and silence this warning.');
  }
  return { problems, warnings };
}

/**
 * True when `services.email` (the object) selects in-process delivery but
 * names no SMTP host: mail is not configured, so a send is skipped rather than
 * attempted and reported as a failure. Typical of a fresh install whose
 * operator has not set up SMTP yet.
 */
export function isInProcessSmtpMissing (email: unknown): boolean {
  if (email == null || typeof email !== 'object') return false;
  const { method, smtp } = email as { method?: unknown; smtp?: { host?: unknown } | null };
  if (method !== 'in-process') return false;
  return isMissingOrSentinel(smtp?.host);
}

/**
 * The mail classes, each with its own switch `services.email.send<Kind>`
 * (see `mailSwitchKey`). The value is the class name used in messages.
 */
export const MAIL_KINDS = {
  welcome: 'welcome',
  resetPassword: 'password-reset',
  verifyEmail: 'email-verification',
  mfaChange: 'MFA-change',
  externalIdReleased: 'external-id-release',
  accountDeletionScheduled: 'auto-deletion confirmation',
  accountDeletionReminder: 'auto-deletion reminder',
  accountDeletionBlocked: 'auto-deletion on-hold',
  accountTransferNamed: 'transfer beneficiary named',
  accountTransferClaim: 'transfer claim link',
  accountTransferStarted: 'transfer started',
  accountTransferCancelled: 'transfer cancelled',
  accountTransferLapsed: 'transfer lapsed',
  accountTransferCompleted: 'transfer completed'
} as const;

export type MailKind = keyof typeof MAIL_KINDS;

const KIND_LIST = Object.keys(MAIL_KINDS) as MailKind[];

/** `services.email` key of the switch of `kind`: `send` + the kind, first letter upper-cased. */
export function mailSwitchKey (kind: MailKind): string {
  return 'send' + kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * The one rule of the mail switches. `enabled` is the whole-feature switch
 * (`services.email.enabled`), `send` the switch of the class. A mail is on when
 * neither is set to anything but `true`. Fail-closed: a value that is not a
 * boolean (the former object form of `enabled`, an empty YAML value, a quoted
 * `'false'`) reads as off; the boot refuses such values anyway.
 */
function switchesAllow (enabled: unknown, send: unknown): boolean {
  return (enabled === undefined || enabled === true) && (send === undefined || send === true);
}

/** Whether mails of `kind` are switched on in `email` (the `services.email` object). */
export function isMailKindSwitchedOn (email: unknown, kind: MailKind): boolean {
  if (email == null || typeof email !== 'object') return false;
  const settings = email as Record<string, unknown>;
  return switchesAllow(settings.enabled, settings[mailSwitchKey(kind)]);
}

/**
 * Same rule as `isMailKindSwitchedOn`, read key by key from a config. A
 * `services.email` that is set but not an object (YAML `email:` left empty)
 * is off, as it is for `isMailKindSwitchedOn`.
 */
export function isMailKindSwitchedOnInConfig (config: ConfigReader, kind: MailKind): boolean {
  const email = config.get('services:email');
  if (email !== undefined && (email === null || typeof email !== 'object')) return false;
  return switchesAllow(config.get('services:email:enabled'), config.get('services:email:' + mailSwitchKey(kind)));
}

export function enabledMailKinds (config: ConfigReader): MailKind[] {
  return KIND_LIST.filter((kind) => isMailKindSwitchedOnInConfig(config, kind));
}

/**
 * Whether a mail of `kind` would actually be sent: its class is switched on
 * (`services.email.enabled` and `services.email.send<Kind>`) and mail is
 * configured. These are the two runtime gates (the per-class switch at the send
 * site, and the in-process skip when no SMTP host is set), so an advertised
 * value cannot disagree with a send.
 */
export function isMailKindLive (config: ConfigReader, kind: MailKind): boolean {
  return isMailKindSwitchedOnInConfig(config, kind) && describeMailCapability(config).ok;
}

/** `services.email` of one configuration scope, highest scope first. */
export type EmailSwitchLayer = { scope: string; info: string; email: unknown };

export type EmailSwitchProblem = {
  /** Dotted path of the key the problem is about. */
  key: string;
  message: string;
  scope: string;
  info: string;
};

function isPlainObject (value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function describeNonBoolean (value: unknown): string {
  if (value === null) return 'an empty value';
  if (typeof value === 'string') return 'the string ' + JSON.stringify(value.length > 20 ? value.slice(0, 20) + '...' : value);
  if (Array.isArray(value)) return 'a list';
  return 'a ' + typeof value;
}

function whereFound (layer: EmailSwitchLayer): string {
  return layer.info !== '' ? `${layer.scope} (${layer.info})` : layer.scope;
}

/**
 * Problems of the mail switches, for the boot validation and
 * `bin/check-config.js` (one rule for both). Pure.
 *
 * Every scope is read, not only the resolved value: a scope holding the former
 * object form of `services.email.enabled` under a higher `enabled: true` would
 * be hidden by the resolution, and a mail its operator switched off would be
 * sent. Each such scope gives one problem, naming every key found with its
 * replacement. The winning value of `enabled` and of each `send<Kind>` must be
 * a boolean when set. Switch names that are not mail classes (`send...` typos)
 * are not checked here.
 */
export function describeEmailSwitches (layers: EmailSwitchLayer[]): EmailSwitchProblem[] {
  const problems: EmailSwitchProblem[] = [];
  for (const layer of layers) {
    if (!isPlainObject(layer.email) || !isPlainObject(layer.email.enabled)) continue;
    problems.push({ key: 'services.email.enabled', message: legacyEnabledMessage(layer, layer.email.enabled), scope: layer.scope, info: layer.info });
  }
  const winning = (key: string): { value: unknown; layer: EmailSwitchLayer } | null => {
    for (const layer of layers) {
      if (!isPlainObject(layer.email)) continue;
      const value = layer.email[key];
      if (value !== undefined) return { value, layer };
    }
    return null;
  };
  const enabled = winning('enabled');
  if (enabled != null && typeof enabled.value !== 'boolean' && !isPlainObject(enabled.value)) {
    problems.push({
      key: 'services.email.enabled',
      message: `services.email.enabled must be true or false, found ${describeNonBoolean(enabled.value)} in ${whereFound(enabled.layer)}: ` +
        'set it to true (each mail follows its own services.email.send... switch) or false (no mail at all), or remove it.',
      scope: enabled.layer.scope,
      info: enabled.layer.info
    });
  }
  for (const kind of KIND_LIST) {
    const key = mailSwitchKey(kind);
    const found = winning(key);
    if (found == null || typeof found.value === 'boolean') continue;
    problems.push({
      key: 'services.email.' + key,
      message: `services.email.${key} must be true or false, found ${describeNonBoolean(found.value)} in ${whereFound(found.layer)}: ` +
        'set it to true or false, or remove it (the default is true).',
      scope: found.layer.scope,
      info: found.layer.info
    });
  }
  return problems;
}

function legacyEnabledMessage (layer: EmailSwitchLayer, switches: Record<string, unknown>): string {
  const env = layer.scope === 'env';
  const oldKey = (k: string) => env ? `services__email__enabled__${k}` : `services.email.enabled.${k}`;
  const newKey = (k: string) => env ? `services__email__${k}` : `services.email.${k}`;
  const sep = env ? '=' : ': ';
  const lines: string[] = [];
  for (const [k, value] of Object.entries(switches)) {
    if (!(KIND_LIST as string[]).includes(k)) {
      lines.push(`  ${oldKey(k)}: not a mail switch, remove it`);
      continue;
    }
    const shown = typeof value === 'boolean' ? String(value) : '<not a boolean>';
    const target = typeof value === 'boolean' ? String(value) : 'true or false';
    lines.push(`  ${oldKey(k)}${sep}${shown}  ->  ${newKey(mailSwitchKey(k as MailKind))}${sep}${target}`);
  }
  const head = 'services.email.enabled must be true or false. The per-mail switches moved out of it, and this core does not start ' +
    'rather than send mails that were switched off. Found in ' + whereFound(layer) + (lines.length > 0 ? ':' : ', as an empty object.');
  const tail = 'Move each line to its new key, then set services.email.enabled to true or remove it (false still turns every mail off).';
  return [head, ...lines, tail].join('\n');
}

/**
 * Whether the account email-verification flow (the mailed link) is live, and
 * why not when it is not. Rules are ordered: the operator switching the feature
 * off is reported as `disabled` even if the rest is also incomplete.
 */
export function describeVerificationMail (config: ScopedConfigReader): VerificationMailStatus {
  const explicit = isVerifyEmailExplicit(config);

  if (!isMailKindSwitchedOnInConfig(config, 'verifyEmail')) return { enabled: false, reason: 'disabled', explicit };

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
 * True when the operator set `services.email.sendVerifyEmail` themselves,
 * rather than inheriting the shipped default.
 *
 * A plain config object cannot prove where a value came from, so it counts as
 * explicit. That is the conservative direction: it can only make
 * `auth.emailVerificationPageURL` required, never silently optional.
 */
function isVerifyEmailExplicit (config: ScopedConfigReader): boolean {
  if (typeof config.getScopeAndValue !== 'function') return true;
  const scoped = config.getScopeAndValue('services:email:' + mailSwitchKey('verifyEmail'));
  if (scoped == null) return false;
  return scoped.scope !== 'default-file';
}
