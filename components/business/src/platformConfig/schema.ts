/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The platform-wide configuration keys the platform store may hold in this
 * release. A key outside `SCHEMA` cannot be written (API and CLI) and a row
 * of such a key is ignored when the store is read.
 *
 * Every key classified `platform` in `effectiveConfig/classification.ts` is
 * either in `SCHEMA` or listed in `NOT_IN_STORE` with the reason it stays in
 * the configuration files (a unit test checks it).
 */

export type KeyDef = {
  /** JSON schema of the value (draft-04). */
  schema: Record<string, unknown>;
  /** `live`: read at use, a change applies at once; `restart`: read at boot. */
  appliesAt: 'live' | 'restart';
  /**
   * A write needs a recent second factor (administrator session), and the
   * audit records and answers show a fingerprint, not the value.
   */
  sensitive: boolean;
  /**
   * A write needs a recent second factor (administrator session); the value
   * stays shown (a key with platform-wide reach whose value is public).
   */
  stepUp?: boolean;
  /** The administration capability the key belongs to (business/src/admin/capabilities.ts). */
  capability: string;
};

export type SchemaMap = Readonly<Record<string, KeyDef>>;

// An http(s) URL: no whitespace, quotes, angle brackets nor backslash, no
// credentials (`@` before the path).
const URL_TAIL = '[^\\s"\'<>\\\\@/]+(/[^\\s"\'<>\\\\]*)?$';
const URL_VALUE = Object.freeze({ type: 'string', maxLength: 2048, pattern: '^https?://' + URL_TAIL });
const HTTPS_URL_VALUE = Object.freeze({ type: 'string', maxLength: 2048, pattern: '^https://' + URL_TAIL });

/**
 * The keys of the current batch: the service information (`/service/info`).
 * A key still needs a local value where the boot checks require one
 * (config-validation: name, home, support, terms, eventTypes); a row replaces
 * it once the core runs. `service.assets` is held by its leaf
 * (`service.assets.definitions`): an object value would merge with the local
 * one rather than replace it.
 *
 * `service.assets.definitions` (what every app's sign-in button and the auth
 * pages load) and `service.eventTypes` (the catalogue every core validates
 * events with) reach the whole platform: https only, and a write needs a
 * recent second factor.
 */
export const SCHEMA: SchemaMap = Object.freeze({
  // No control character (line breaks included).
  'service.name': { schema: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }, appliesAt: 'live', sensitive: false, capability: 'config' },
  'service.home': { schema: URL_VALUE, appliesAt: 'live', sensitive: false, capability: 'config' },
  'service.support': { schema: URL_VALUE, appliesAt: 'live', sensitive: false, capability: 'config' },
  'service.terms': { schema: URL_VALUE, appliesAt: 'live', sensitive: false, capability: 'config' },
  // Read when the API methods are registered (api-server) and at boot (hfs-server):
  // /service/info shows a new value at once, the cores validate with it after a restart.
  'service.eventTypes': { schema: HTTPS_URL_VALUE, appliesAt: 'restart', sensitive: false, stepUp: true, capability: 'config' },
  'service.assets.definitions': { schema: HTTPS_URL_VALUE, appliesAt: 'live', sensitive: false, stepUp: true, capability: 'config' }
});

/**
 * Key names: dotted segments of letters, digits and `-`. No `_` nor `%`
 * (wildcards of the prefix listing of the store) and no `:` (the separator
 * of configuration paths).
 */
const KEY_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)*$/;
export const KEY_NAME_MAX_LENGTH = 200;

export function isValidKeyName (key: unknown): key is string {
  return typeof key === 'string' && key.length <= KEY_NAME_MAX_LENGTH && KEY_NAME_RE.test(key);
}

// --- keys classified `platform` that stay in the configuration files ---- //

const SECRET = 'secret: stays in the configuration files (no credential in the platform store)';
const SERVICE_OTHERS = 'not scheduled: the other service.* values (derived at boot, per core, or not editable yet)';
const BATCH_2 = 'later batch 2 (account policy, OAuth registration): sensitive, step-up on write';
const BATCH_3 = 'later batch 3 (bulk policy)';
const BATCH_4 = 'later batch 4 (dns): decided with its batch';
const BATCH_5 = 'later batch 5 (custom.systemStreams): own decision';
const HOSTINGS = 'later: hostings, once the role scopes computed on it are released';
const NEW_KEYS = 'added to the schema by the change that introduces the key';
const UNSCHEDULED = 'not scheduled: no batch decided yet';
const YAML_TOPOLOGY = 'YAML-only by decision: topology, read at boot before the platform store';
const YAML_PII = 'YAML-only by decision: read before the storages, a change needs a data migration';
const YAML_OWN_ROWS = 'YAML-only by decision: has its own platform-store rows (bin/observability.js)';
const YAML_PER_CORE = 'YAML-only by decision: tied to what each core serves, checked at boot';
const YAML_KEY_SCOPE = 'YAML-only by decision: governs the admin key itself, set on each core';
const YAML_CODE = 'YAML-only by decision: loads code at boot';
const YAML_SOURCE = 'YAML-only by decision: where the service information is fetched from at boot';

const GROUPS: ReadonlyArray<[string, readonly string[]]> = [
  [SECRET, [
    'invitationTokens', 'auth.adminAccessKey', 'auth.filesReadTokenSecret', 'services.mfa.methods.totp.secretsKey',
    'account.autoDeletion.transfer.identitySecretsKey', 'accountErasure.ledger.hmacKey', 'platform.piiHmacKey',
    'letsEncrypt.atRestKey', 'observability.otlp.headers', 'oauth.extensionOptions', 'custom.dataStores.*.settings'
  ]],
  [SERVICE_OTHERS, ['service.**']],
  [BATCH_2, [
    'auth.passwordComplexityMinCharCategories', 'auth.passwordComplexityMinLength', 'auth.passwordAgeMaxDays',
    'auth.passwordAgeMinDays', 'auth.passwordPreventReuseHistoryLength', 'auth.passwordAttempts.**',
    'auth.sessionMaxAge', 'services.mfa.mode', 'oauth.clientRegistration.mode', 'oauth.clientRegistration.**'
  ]],
  [BATCH_3, [
    'versioning.**', 'integrity.**', 'uploads.**', 'webhooks.**', 'accessTracking.**', 'user-account.**', 'updates.**',
    'audit.active', 'services.email.*', 'services.email.from.**',
    'letsEncrypt.enabled', 'letsEncrypt.email', 'letsEncrypt.renewBeforeDays', 'letsEncrypt.staging'
  ]],
  [BATCH_4, ['dns.domain', 'dns.staticEntries.**']],
  [BATCH_5, ['custom.systemStreams.**']],
  [HOSTINGS, ['hostings.**']],
  [NEW_KEYS, ['portal.spaces', 'portal.modules.disabled', 'portal.modules.order']],
  [YAML_TOPOLOGY, ['dnsLess.**', 'portal.site', 'portal.url', 'portal.cors.allowedOrigins']],
  [YAML_PII, ['platform.piiMode', 'platform.piiAlgorithm']],
  [YAML_OWN_ROWS, [
    'observability.enabled', 'observability.provider', 'observability.appName', 'observability.logLevel',
    'observability.otlp.endpoint', 'observability.otlp.flushIntervalSeconds'
  ]],
  [YAML_PER_CORE, [
    'hostedSites', 'hostedSites.*.proxy', 'hostedSites.*.headers.**', 'hostedSites.*.frameAncestors', 'hostedSites.*.hsts',
    'adapterRoutes', 'adapterRoutes.*.paths'
  ]],
  [YAML_KEY_SCOPE, ['auth.adminAccessKeyScope']],
  [YAML_CODE, ['custom.dataStores', 'custom.dataStores.*.id', 'custom.dataStores.*.name', 'custom.dataStores.*.path']],
  [YAML_SOURCE, ['serviceInfoUrl']],
  [UNSCHEDULED, [
    'reporting.**', 'storages.contentIndexes.**',
    'auth.usernameChangeLimit', 'auth.trustedApps', 'auth.passwordResetPageURL', 'auth.passwordResetRequestMaxAge',
    'auth.emailVerificationPageURL',
    'services.mfa.active', 'services.mfa.defaultMethod', 'services.mfa.methods.totp.active', 'services.mfa.methods.totp.issuer',
    'services.mfa.methods.totp.digits', 'services.mfa.methods.totp.periodSeconds', 'services.mfa.methods.totp.driftSteps',
    'services.mfa.methods.sms.active', 'services.mfa.methods.sms.mode', 'services.mfa.methods.sms.contentKeys',
    'services.mfa.methods.sms.codeLength', 'services.mfa.methods.sms.codeTtlSeconds', 'services.mfa.methods.sms.sendLimits.**',
    'services.mfa.sessions.**', 'services.mfa.attempts.**', 'services.mfa.allowLoginWhenMethodInactive',
    'account.**', 'accountErasure.ledger.enabled', 'accountErasure.ledger.retentionDays', 'access.returnOrigins',
    'setup.codeTtlHours', 'setup.registrationWhilePending',
    'admin.session.ttlMinutes', 'admin.session.stepUpMinutes', 'admin.session.requireMfa',
    'audit.onUserDelete',
    'oauth.**', 'sharedSecrets.**', 'delegation.**', 'cmc.**'
  ]]
];

/**
 * Patterns of `classification.ts` rules of scope `platform` that are not in
 * `SCHEMA`, with the reason. A pattern here covers the rule patterns it
 * matches (`oauth.**` covers every `oauth.` rule not listed on its own).
 */
export const NOT_IN_STORE: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  GROUPS.flatMap(([reason, patterns]) => patterns.map((p) => [p, reason]))
));
