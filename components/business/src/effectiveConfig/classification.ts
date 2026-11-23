/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Classification of every configuration key reported by the effective
 * configuration document (`GET /system/admin/config/effective`).
 *
 * This table is an allow-list: a key is shown only when a `public` (or
 * `url-origin`) rule names it. A key no rule names is redacted at runtime
 * (class `unclassified`), and the unit test `[CFC1]` fails when a key of
 * `config/default-config.yml` has no rule, so a new key cannot ship without
 * a decision about it.
 *
 * Pattern segments: a literal, `*` (exactly one segment) or `**` (any number
 * of segments, zero included, only as the last segment). The most specific
 * matching rule wins: more literal segments first, then more `*`, then a rule
 * without `**`; on a tie, the first rule listed.
 *
 * Classes:
 * - `public`: the value is shown, after the value scan.
 * - `url-origin`: only the scheme, host and port of the URL are shown.
 * - `secret`: never shown; presence, type and a keyed fingerprint only.
 * - `opaque`: a whole subtree reported as one redacted entry (it can carry
 *   credentials in places no rule can name: headers, request bodies, options
 *   handed to plugins).
 *
 * Scope: `platform` when every core of a deployment is expected to hold the
 * same value (part of the `platform` digest), `core` when it differs by design
 * (host, ports, paths, local credentials, local tuning).
 */

export type RuleClass = 'public' | 'url-origin' | 'secret' | 'opaque';
export type RuleScope = 'platform' | 'core';
export type Rule = { pattern: string[], class: RuleClass, scope: RuleScope };

const P = 'public';
const U = 'url-origin';
const S = 'secret';
const O = 'opaque';
const p = 'platform';
const c = 'core';

/** Top-level keys reported in addition to those of `default-config.yml`. */
export const EXTRA_TOP_LEVEL_KEYS: readonly string[] = ['service', 'serviceInfoUrl', 'accessState'];

const RULE_TABLE: Array<[string, RuleClass, RuleScope]> = [
  ['dnsLess.**', P, p],
  ['reporting.**', P, p],
  ['http.**', P, c],

  ['storages.*.engine', P, c],
  ['storages.platform.integrityCheckIntervalMs', P, c],
  ['storages.contentIndexes.**', P, p],
  ['storages.engines.postgresql.host', P, c],
  ['storages.engines.postgresql.port', P, c],
  ['storages.engines.postgresql.database', P, c],
  ['storages.engines.postgresql.user', S, c],
  ['storages.engines.postgresql.password', S, c],
  ['storages.engines.postgresql.max', P, c],
  ['storages.engines.postgresql.auditPoolSize', P, c],
  ['storages.engines.postgresql.auditReadPoolSize', P, c],
  ['storages.engines.postgresql.statementTimeoutMs', P, c],
  ['storages.engines.postgresql.idleInTransactionTimeoutMs', P, c],
  ['storages.engines.sqlite.path', P, c],
  ['storages.engines.filesystem.previewsDirPath', P, c],
  ['storages.engines.influxdb.host', P, c],
  ['storages.engines.influxdb.port', P, c],
  ['storages.engines.rqlite.url', U, c],
  ['storages.engines.rqlite.raftPort', P, c],
  ['storages.engines.rqlite.httpBindAddr', P, c],
  ['storages.engines.rqlite.dataDir', P, c],
  ['storages.engines.rqlite.binPath', P, c],
  ['storages.engines.rqlite.external', P, c],
  ['storages.engines.rqlite.readyTimeoutMs', P, c],
  ['storages.engines.rqlite.logFile', P, c],
  ['storages.engines.rqlite.tls.**', P, c],
  ['storages.engines.s3.endpoint', U, c],
  ['storages.engines.s3.region', P, c],
  ['storages.engines.s3.bucket', P, c],
  ['storages.engines.s3.forcePathStyle', P, c],
  ['storages.engines.s3.keyPrefix', P, c],
  ['storages.engines.s3.accessKeyId', S, c],
  ['storages.engines.s3.secretAccessKey', S, c],

  ['eventFiles.**', P, c],
  ['invitationTokens', S, p],

  ['auth.adminAccessKey', S, p],
  ['auth.filesReadTokenSecret', S, p],
  ['auth.passwordComplexityMinCharCategories', P, p],
  ['auth.passwordComplexityMinLength', P, p],
  ['auth.passwordAgeMaxDays', P, p],
  ['auth.passwordAgeMinDays', P, p],
  ['auth.passwordPreventReuseHistoryLength', P, p],
  ['auth.passwordAttempts.**', P, p],
  ['auth.passwordCheckConcurrency', P, c],
  ['auth.passwordCheckQueue', P, c],
  ['auth.usernameChangeLimit', P, p],
  ['auth.trustedApps', P, p],
  ['auth.passwordResetPageURL', P, p],
  ['auth.passwordResetRequestMaxAge', P, p],
  ['auth.emailVerificationPageURL', P, p],
  ['auth.sessionMaxAge', P, p],

  ['sso.enabled', P, c],
  ['sso.landingPageURL', P, c],
  ['sso.callbackBaseURL', P, c],
  ['sso.stateKey', S, c],
  ['sso.providers', P, c],
  ['sso.providers.*.issuer', U, c],
  ['sso.providers.*.clientId', P, c],
  ['sso.providers.*.label', P, c],
  ['sso.providers.*.clientSecret', S, c],

  ['customExtensions.**', P, c],

  ['services.mfa.mode', P, p],
  ['services.mfa.active', P, p],
  ['services.mfa.defaultMethod', P, p],
  ['services.mfa.methods.totp.active', P, p],
  ['services.mfa.methods.totp.issuer', P, p],
  ['services.mfa.methods.totp.digits', P, p],
  ['services.mfa.methods.totp.periodSeconds', P, p],
  ['services.mfa.methods.totp.driftSteps', P, p],
  ['services.mfa.methods.totp.secretsKey', S, p],
  ['services.mfa.methods.sms.active', P, p],
  ['services.mfa.methods.sms.mode', P, p],
  ['services.mfa.methods.sms.endpoints', O, c],
  ['services.mfa.methods.sms.contentKeys', P, p],
  ['services.mfa.methods.sms.codeLength', P, p],
  ['services.mfa.methods.sms.codeTtlSeconds', P, p],
  ['services.mfa.methods.sms.sendLimits.**', P, p],
  ['services.mfa.sms.endpoints', O, c],
  ['services.mfa.sessions.**', P, p],
  ['services.mfa.attempts.**', P, p],
  ['services.mfa.allowLoginWhenMethodInactive', P, p],
  ['services.email.*', P, p],
  ['services.email.enabled.**', P, p],
  ['services.email.from.**', P, p],
  ['services.email.url', U, c],
  ['services.email.key', S, c],
  ['services.email.templatesRootDir', P, c],
  ['services.email.smtp.host', P, c],
  ['services.email.smtp.port', P, c],
  ['services.email.smtp.secure', P, c],
  ['services.email.smtp.auth.user', S, c],
  ['services.email.smtp.auth.pass', S, c],

  ['testNotifications.**', P, c],
  ['updates.**', P, p],
  ['tcpBroker.**', P, c],
  ['webhooks.**', P, p],
  ['versioning.**', P, p],
  ['user-account.**', P, p],
  ['account.**', P, p],
  ['account.autoDeletion.transfer.identitySecretsKey', S, p],
  ['accountErasure.ledger.enabled', P, p],
  ['accountErasure.ledger.retentionDays', P, p],
  ['accountErasure.ledger.hmacKey', S, p],
  ['custom.systemStreams.**', P, p],
  ['custom.dataStores', P, p],
  ['custom.dataStores.*.id', P, p],
  ['custom.dataStores.*.name', P, p],
  ['custom.dataStores.*.path', P, p],
  ['custom.dataStores.*.settings', O, p],
  ['caching.**', P, c],
  ['logs.**', P, c],
  ['logs.custom.settings', O, c],
  ['uploads.**', P, p],
  ['limits.**', P, c],
  ['socketIO.**', P, c],
  ['access.**', P, c],
  ['access.returnOrigins', P, p],
  ['accessState.**', P, c],
  ['accesses.**', P, c],
  ['trace.**', P, c],
  ['integrity.**', P, p],
  ['accessTracking.**', P, p],
  ['core.**', P, c],
  ['dns.domain', P, p],
  ['dns.**', P, c],
  ['dns.staticEntries.**', P, p],

  ['hostedSites', P, p],
  ['hostedSites.*.static', P, c],
  ['hostedSites.*.proxy', U, p],
  ['hostedSites.*.headers.**', P, p],
  ['hostedSites.*.frameAncestors', P, p],
  ['hostedSites.*.hsts', P, p],
  ['adapterRoutes', P, p],
  ['adapterRoutes.*.upstream', U, c],
  ['adapterRoutes.*.paths', P, p],
  ['adapterRoutes.*.maxBodyBytes', P, c],
  ['adapterRoutes.*.idleTimeoutMs', P, c],
  ['hostings.**', P, p],
  ['cluster.**', P, c],

  ['platform.piiMode', P, p],
  ['platform.piiAlgorithm', P, p],
  ['platform.piiHmacKey', S, p],

  ['letsEncrypt.enabled', P, p],
  ['letsEncrypt.email', P, p],
  ['letsEncrypt.renewBeforeDays', P, p],
  ['letsEncrypt.staging', P, p],
  ['letsEncrypt.atRestKey', S, p],
  ['letsEncrypt.certRenewer', P, c],
  ['letsEncrypt.tlsDir', P, c],
  ['letsEncrypt.onRotateScript', P, c],
  ['letsEncrypt.directoryUrl', P, c],

  ['observability.enabled', P, p],
  ['observability.provider', P, p],
  ['observability.appName', P, p],
  ['observability.logLevel', P, p],
  ['observability.otlp.endpoint', U, p],
  ['observability.otlp.headers', O, p],
  ['observability.otlp.flushIntervalSeconds', P, p],

  ['migrations.**', P, c],
  ['audit.active', P, p],
  ['audit.onUserDelete', P, p],
  ['audit.storage.**', P, c],
  // The syslog options are handed to a transport: only the known ones are shown.
  ['audit.syslog.active', P, c],
  ['audit.syslog.options.host', P, c],
  ['audit.syslog.options.port', P, c],
  ['audit.syslog.options.protocol', P, c],
  ['audit.syslog.options.path', P, c],
  ['audit.syslog.options.localhost', P, c],
  ['audit.syslog.options.app_name', P, c],
  ['audit.syslog.formats.*.template', P, c],
  ['audit.syslog.formats.*.level', P, c],
  ['audit.syslog.formats.*.plugin', P, c],
  ['audit.syslog.filter.methods.include', P, c],
  ['audit.syslog.filter.methods.exclude', P, c],

  // OAuth: explicit leaves (the section holds signing keys and state keys).
  ['oauth.issuer', P, p],
  ['oauth.consentUrl', P, p],
  ['oauth.audAllowList', P, p],
  ['oauth.requireAppAccountMfa', P, p],
  ['oauth.accessTokenTTL', P, p],
  ['oauth.refreshTokenTTL', P, p],
  ['oauth.refreshTokenAbsoluteTTL', P, p],
  ['oauth.refreshReuseGraceSeconds', P, p],
  ['oauth.refreshRetireGraceSeconds', P, p],
  ['oauth.dpop.clockSkewSeconds', P, p],
  ['oauth.dpop.keyRevokeCheckSeconds', P, p],
  ['oauth.clientRevokeCheckSeconds', P, p],
  ['oauth.clientRegistration.mode', P, p],
  ['oauth.logoHosts', P, p],
  ['oauth.stateKey', S, c],
  ['oauth.signingKeys', P, c],
  ['oauth.signingKeys.*.kid', P, c],
  ['oauth.signingKeys.*.privateKeyFile', P, c],
  ['oauth.signingKeys.*.privateKeyPem', S, c],
  ['oauth.idTokenTTL', P, p],
  ['oauth.grantTypesSupported', P, p],
  ['oauth.audienceBoundSessions', P, c],
  ['oauth.perUserIssuer', P, p],
  ['oauth.extensionOptions', O, p],
  ['oauth.extensionHookTimeoutMs', P, p],
  ['oauth.clientMetadataDocuments.mode', P, p],
  ['oauth.clientMetadataDocuments.allowedHosts', P, p],
  ['oauth.clientMetadataDocuments.deniedHosts', P, p],
  ['oauth.clientMetadataDocuments.cacheSeconds', P, p],
  ['oauth.clientMetadataDocuments.staleGraceSeconds', P, p],
  ['oauth.clientMetadataDocuments.negativeCacheSeconds', P, p],
  ['oauth.clientMetadataDocuments.fetchTimeoutMs', P, p],
  ['oauth.clientMetadataDocuments.maxDocumentBytes', P, p],
  ['oauth.clientMetadataDocuments.fetchesPerMinute', P, p],
  ['oauth.clientMetadataDocuments.newClientsPerMinute', P, p],
  ['oauth.clientMetadataDocuments.unconsentedRowSeconds', P, p],
  ['oauth.clientMetadataDocuments.authMethods', P, p],
  ['oauth.clientMetadataDocuments.client.scope', P, p],
  ['oauth.clientMetadataDocuments.client.allowedAudiences', P, p],
  ['oauth.clientMetadataDocuments.client.launchTypes', P, p],
  ['oauth.clientMetadataDocuments.client.subjectType', P, p],
  ['oauth.clientMetadataDocuments.client.maxEntries', P, p],
  ['oauth.clientMetadataDocuments.client.offlineAccessAllowed', P, p],
  ['oauth.clientMetadataDocuments.client.accessTokenTTL', P, p],
  ['oauth.clientMetadataDocuments.client.refreshTokenTTL', P, p],
  ['oauth.clientMetadataDocuments.client.refreshTokenAbsoluteTTL', P, p],
  ['oauth.clientMetadataDocuments.client.regions', P, p],

  ['sharedSecrets.**', P, p],
  ['delegation.**', P, p],
  ['cmc.**', P, p],

  ['service.**', P, p],
  ['serviceInfoUrl', U, p]
];

export const RULES: readonly Rule[] = RULE_TABLE.map(([pattern, cls, scope]) => ({ pattern: pattern.split('.'), class: cls, scope }));

/**
 * Paths whose name looks like a secret (see `nameLooksSecret`) but whose
 * value is not one. A `public` leaf with a secret-looking name and no entry
 * here is redacted: a wildcard rule cannot expose a future `limits.fooSecret`.
 */
const NAME_EXCEPTION_TABLE: string[] = [
  'auth.passwordComplexityMinCharCategories',
  'auth.passwordComplexityMinLength',
  'auth.passwordAgeMaxDays',
  'auth.passwordAgeMinDays',
  'auth.passwordPreventReuseHistoryLength',
  'auth.passwordAttempts.**',
  'auth.passwordCheckConcurrency',
  'auth.passwordCheckQueue',
  'auth.passwordResetPageURL',
  'auth.passwordResetRequestMaxAge',
  'services.email.enabled.resetPassword',
  'services.email.resetPasswordTemplate',
  'account.emailVerification.tokenMaxAgeMs',
  'oauth.accessTokenTTL',
  'oauth.refreshTokenTTL',
  'oauth.refreshTokenAbsoluteTTL',
  'oauth.idTokenTTL',
  'oauth.clientMetadataDocuments.client.accessTokenTTL',
  'oauth.clientMetadataDocuments.client.refreshTokenTTL',
  'oauth.clientMetadataDocuments.client.refreshTokenAbsoluteTTL',
  'oauth.signingKeys.*.privateKeyFile',
  'cluster.tokens.path',
  'webhooks.allowedPrivateHosts',
  'cmc.allowedPrivateHosts',
  'hostedSites.*.headers.**',
  'service.**'
];
export const NAME_EXCEPTIONS: readonly string[][] = NAME_EXCEPTION_TABLE.map((s) => s.split('.'));

const SECRET_WORDS = /secret|passw|passphrase|passcode|pwd|psk|credential|token|hmac|salt|pepper|seed|private|pem$|apikey|api[-_]key|[_-]key$|cookie|signature|bearer|authorization|jwt|^otp|[_-]otp|dsn|connectionstring/;
const SECRET_NAMES = /^(key|keys|pass|auth|headers)$/;
const CAMEL_KEY = /[a-z0-9]Key$/;

/** True when a path segment name suggests a secret value. */
export function nameLooksSecret (segment: string): boolean {
  const lower = segment.toLowerCase();
  return SECRET_WORDS.test(lower) || SECRET_NAMES.test(lower) || CAMEL_KEY.test(segment);
}

/** True when a path (top-level segment excepted) has a secret-looking segment name. */
export function pathLooksSecret (segments: readonly string[]): boolean {
  for (let i = 1; i < segments.length; i++) {
    if (/^\d+$/.test(segments[i])) continue;
    if (nameLooksSecret(segments[i])) return true;
  }
  return false;
}

/** Specificity score of a pattern match, or -1 when it does not match. */
export function matchScore (pattern: readonly string[], segments: readonly string[]): number {
  let literals = 0;
  let singles = 0;
  for (let i = 0; i < pattern.length; i++) {
    const part = pattern[i];
    if (part === '**') {
      if (i !== pattern.length - 1) return -1;
      return literals * 100 + singles * 10;
    }
    if (i >= segments.length) return -1;
    if (part === '*') { singles++; continue; }
    if (part !== segments[i]) return -1;
    literals++;
  }
  if (pattern.length !== segments.length) return -1;
  return literals * 100 + singles * 10 + 1;
}

/** The rule that applies to a path, or null when none does. */
export function findRule (segments: readonly string[]): Rule | null {
  let best: Rule | null = null;
  let bestScore = -1;
  for (const rule of RULES) {
    const score = matchScore(rule.pattern, segments);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

/** True when a path is listed in NAME_EXCEPTIONS. */
export function isNameException (segments: readonly string[]): boolean {
  return NAME_EXCEPTIONS.some((pattern) => matchScore(pattern, segments) >= 0);
}
