/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: who vouches for a client, and what the operator lets a client of
 * each level do (`oauth.clientRegistration`).
 *
 * - `mode`: `curated` (the default: the operator registers every client with
 *   the CLI) or `delegated` (Pryv accounts may also register registry clients,
 *   under the policy below; the registration itself comes with the developer
 *   API). `open` (anonymous RFC 7591 registration) is refused, as any other
 *   value.
 * - `whoMayRegister` (`delegated` only): `validatedPublishers` (the default)
 *   or `anyAccount`.
 * - `levels.<level>`: `{ consent: allow | testers | refuse, scopeTemplate?,
 *   maxGrants? }` for each of `nonValidated`, `publisherValidated`,
 *   `appValidated`. Absent: `allow`, no template, no cap.
 *
 * The level of a client (its badge) is computed by the server, never stored
 * as such: a client the operator registered is App Validated; a client a
 * developer registered is App Validated while its app review stands (the
 * digest of its vetted fields unchanged), else Publisher Validated when its
 * owner is a validated publisher, else Non-Validated; a metadata-document
 * client is Publisher Validated under `allowList`, Non-Validated under `any`.
 *
 * `maxGrants` counts, per client, the accounts that consented while the cap
 * applied (one platform row per account and client). The count is
 * approximate by design: two consents racing on two cores may both pass at
 * the cap, and an account's own revocation of its grant does not give its
 * unit back (the operator's `purge-grants` and `revoke` do).
 */

import crypto from 'node:crypto';

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthClient } from './storage.ts';
import { VETTED_FIELDS, vettedValue } from './clientRegistry.ts';
import { canonicalJson, resolveRequestedScope, checkMaxSet } from './scopeGrammar.ts';
import { clientMetadataSettings } from './clientMetadataConfig.ts';
import type { ClientStamp } from './clientMetadataId.ts';
import { clientStamp } from './clientMetadataId.ts';
import { logServerWarning } from './serverLog.ts';

type ConfigReader = { get (key: string): unknown };

export type ValidationLevel = 'nonValidated' | 'publisherValidated' | 'appValidated';
export type ConsentPolicy = 'allow' | 'testers' | 'refuse';
export type RegistrationMode = 'curated' | 'delegated';
export type WhoMayRegister = 'anyAccount' | 'validatedPublishers';

export const VALIDATION_LEVELS: readonly ValidationLevel[] = Object.freeze(['nonValidated', 'publisherValidated', 'appValidated']);
const CONSENT_POLICIES: readonly string[] = ['allow', 'testers', 'refuse'];
const TOP_KEYS = ['mode', 'whoMayRegister', 'levels'];
const LEVEL_KEYS = ['consent', 'scopeTemplate', 'maxGrants'];
/** Upper bound of `maxGrants`. */
export const MAX_GRANTS_LIMIT = 10_000_000;

export type LevelPolicy = {
  consent: ConsentPolicy;
  /** The maximum scope set of a client of this level (the extension's grammar), or null. */
  scopeTemplate: string[] | null;
  /** How many accounts a client of this level may reach, or null. */
  maxGrants: number | null;
};

export type ClientRegistrationSettings = {
  mode: RegistrationMode;
  whoMayRegister: WhoMayRegister;
  levels: Record<ValidationLevel, LevelPolicy>;
};

const ALLOW: LevelPolicy = Object.freeze({ consent: 'allow', scopeTemplate: null, maxGrants: null }) as LevelPolicy;

export const DEFAULT_CLIENT_REGISTRATION_SETTINGS: Readonly<ClientRegistrationSettings> = Object.freeze({
  mode: 'curated',
  whoMayRegister: 'validatedPublishers',
  levels: { nonValidated: ALLOW, publisherValidated: ALLOW, appValidated: ALLOW },
});

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function scopeTokens (v: unknown): string[] | null {
  if (typeof v === 'string') return v.split(/\s+/).filter((t) => t !== '');
  if (Array.isArray(v) && v.every((t) => typeof t === 'string')) return v.flatMap((t: string) => t.split(/\s+/)).filter((t) => t !== '');
  return null;
}

/**
 * Problems (the boot refuses them) and warnings of an
 * `oauth.clientRegistration` block. `extensionInstalled`: whether an OAuth
 * extension serves registry clients on this core (`delegated` needs one);
 * left out, that check is not made.
 */
export function describeClientRegistrationConfig (raw: unknown, opts: { extensionInstalled?: boolean } = {}): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const at = 'oauth.clientRegistration';
  if (raw == null) return { problems, warnings };
  if (!isPlainObject(raw)) {
    problems.push(`${at} must be an object (mode, whoMayRegister, levels)`);
    return { problems, warnings };
  }
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.includes(k)) problems.push(`${at}.${k} is not a setting (known: ${TOP_KEYS.join(', ')})`);
  }
  const mode = raw.mode ?? 'curated';
  if (mode === 'open') {
    problems.push(`${at}.mode is "open": anonymous dynamic client registration (RFC 7591) is not offered; curated or delegated is expected`);
  } else if (mode !== 'curated' && mode !== 'delegated') {
    problems.push(`${at}.mode is ${JSON.stringify(mode)}: curated or delegated is expected`);
  }
  const who = raw.whoMayRegister;
  if (who != null && who !== 'anyAccount' && who !== 'validatedPublishers') {
    problems.push(`${at}.whoMayRegister is ${JSON.stringify(who)}: anyAccount or validatedPublishers is expected`);
  }
  if (mode === 'delegated') {
    if (opts.extensionInstalled === false) {
      problems.push(`${at}.mode is delegated: clients registered by developers are registry clients, which need an OAuth extension ` +
        '(customExtensions.oauthExtension)');
    }
    if (who === 'anyAccount') {
      warnings.push(`'${at}.whoMayRegister' is anyAccount: any account of the platform may register an application; its consent ` +
        `screen shows "Non-Validated" until reviewed (see ${at}.levels.nonValidated for what it may do meanwhile).`);
    }
  } else if (mode === 'curated' && who != null) {
    warnings.push(`'${at}.whoMayRegister' is set but not used: only the operator registers clients in mode curated.`);
  }
  const levels = raw.levels;
  if (levels != null) {
    if (!isPlainObject(levels)) {
      problems.push(`${at}.levels must be an object (${VALIDATION_LEVELS.join(', ')})`);
    } else {
      for (const [name, policy] of Object.entries(levels)) {
        const lat = `${at}.levels.${name}`;
        if (!VALIDATION_LEVELS.includes(name as ValidationLevel)) {
          problems.push(`${lat} is not a level (known: ${VALIDATION_LEVELS.join(', ')})`);
          continue;
        }
        if (policy == null) continue;
        if (!isPlainObject(policy)) {
          problems.push(`${lat} must be an object (consent, scopeTemplate, maxGrants)`);
          continue;
        }
        for (const k of Object.keys(policy)) {
          if (!LEVEL_KEYS.includes(k)) problems.push(`${lat}.${k} is not a setting (known: ${LEVEL_KEYS.join(', ')})`);
        }
        if (policy.consent != null && !CONSENT_POLICIES.includes(policy.consent as string)) {
          problems.push(`${lat}.consent is ${JSON.stringify(policy.consent)}: allow, testers or refuse is expected`);
        }
        if (policy.scopeTemplate != null) {
          const tokens = scopeTokens(policy.scopeTemplate);
          if (tokens == null || tokens.length === 0) {
            problems.push(`${lat}.scopeTemplate must be a non-empty scope string, in the grammar of the installed OAuth extension`);
          }
        }
        if (policy.maxGrants != null && !(Number.isInteger(policy.maxGrants) && (policy.maxGrants as number) >= 1 &&
            (policy.maxGrants as number) <= MAX_GRANTS_LIMIT)) {
          problems.push(`${lat}.maxGrants must be an integer from 1 to ${MAX_GRANTS_LIMIT}`);
        }
      }
    }
  }
  return { problems, warnings };
}

let memo: { key: string; settings: ClientRegistrationSettings } | null = null;

/**
 * The settings in force, with the defaults. A block with problems (the boot
 * refuses it) reads as the defaults.
 */
export function clientRegistrationSettings (config: ConfigReader | null | undefined): ClientRegistrationSettings {
  const raw = config?.get('oauth:clientRegistration');
  let key: string;
  try { key = JSON.stringify(raw ?? null); } catch { key = ''; }
  if (memo != null && memo.key === key && key !== '') return memo.settings;
  const settings = buildSettings(raw);
  memo = { key, settings };
  return settings;
}

function buildSettings (raw: unknown): ClientRegistrationSettings {
  const d = DEFAULT_CLIENT_REGISTRATION_SETTINGS;
  if (!isPlainObject(raw) || describeClientRegistrationConfig(raw).problems.length > 0) {
    return { mode: d.mode, whoMayRegister: d.whoMayRegister, levels: { ...d.levels } };
  }
  const levels = { ...d.levels };
  const rawLevels = isPlainObject(raw.levels) ? raw.levels : {};
  for (const name of VALIDATION_LEVELS) {
    const p = rawLevels[name];
    if (!isPlainObject(p)) continue;
    levels[name] = {
      consent: (p.consent as ConsentPolicy | undefined) ?? 'allow',
      scopeTemplate: p.scopeTemplate != null ? scopeTokens(p.scopeTemplate) : null,
      maxGrants: Number.isInteger(p.maxGrants) ? p.maxGrants as number : null,
    };
  }
  return {
    mode: raw.mode === 'delegated' ? 'delegated' : 'curated',
    whoMayRegister: raw.whoMayRegister === 'anyAccount' ? 'anyAccount' : 'validatedPublishers',
    levels,
  };
}

/** The policy applied to a client of `level`. */
export function levelPolicy (config: ConfigReader | null | undefined, level: ValidationLevel): LevelPolicy {
  return clientRegistrationSettings(config).levels[level];
}

/**
 * Boot: refuse a block with problems (throws, naming them), report its
 * warnings, and check each scope template against the installed grammar
 * (a refused template is reported, never fatal: every client of that level
 * is then refused at /oauth2/authorize).
 */
export function checkClientRegistrationAtBoot (config: ConfigReader, extensionInstalled: boolean): void {
  const report = describeClientRegistrationConfig(config.get('oauth:clientRegistration'), { extensionInstalled });
  if (report.problems.length > 0) {
    throw new Error('oauth.clientRegistration: ' + report.problems.join('; '));
  }
  for (const w of report.warnings) logServerWarning(w);
  if (!extensionInstalled) return;
  const settings = clientRegistrationSettings(config);
  for (const level of VALIDATION_LEVELS) {
    const template = settings.levels[level].scopeTemplate;
    if (template == null) continue;
    let max: ReturnType<typeof checkMaxSet>;
    try {
      max = checkMaxSet(templateProbe(level, template, null));
    } catch (err) {
      max = { ok: false, description: 'could not be checked: ' + (err as Error).message };
    }
    if (!max.ok) {
      logServerWarning(`oauth.clientRegistration.levels.${level}.scopeTemplate: ${max.description}; /oauth2/authorize will refuse ` +
        'every client of that level (invalid_scope) until the template is fixed');
    }
  }
}

// A client row with the template as its maximum scope set, under an id of
// its own (the grammar memoises the maximum set by client id).
function templateProbe (level: ValidationLevel, template: string[], client: OAuthClient | null): OAuthClient {
  const digest = crypto.createHash('sha256').update(template.join(' ')).digest('hex').slice(0, 16);
  return {
    ...(client ?? { redirectUris: ['https://client.invalid/cb'], grantTypes: ['authorization_code'], kind: 'registry' }),
    clientId: 'level-template-' + level + '-' + digest,
    scope: template,
    updatedAt: 0,
  } as OAuthClient;
}

/**
 * Whether a requested scope fits the template of the client's level: null
 * when it does (or there is no template), else the refusal description.
 */
export function scopeTemplateRefusal (client: OAuthClient, level: ValidationLevel, template: string[] | null,
  scopeString: string, opts: { oidcEnabled?: boolean } = {}): string | null {
  if (template == null) return null;
  const fits = resolveRequestedScope(templateProbe(level, template, client), scopeString, opts);
  if (fits.ok) return null;
  return 'this application is not validated on this platform: it may not request this scope yet';
}

// --- The fields an app review vouches for --- //

/**
 * The display identity fields: what the consent screen shows of the app.
 * Not vetted for an operator's client (their change does not put it under
 * review), but part of what an app review approves.
 */
export const DISPLAY_IDENTITY_FIELDS = ['clientName', 'name', 'description', 'logoUri', 'clientUri', 'policyUri', 'tosUri'] as const;

/** The fields the digest of an app review covers: the vetted fields and the display identity. */
export const VALIDATION_DIGEST_FIELDS: readonly string[] = Object.freeze([...VETTED_FIELDS, ...DISPLAY_IDENTITY_FIELDS]);

/** Digest of the reviewed fields of a client row (base64url SHA-256). */
export function validationDigest (client: OAuthClient): string {
  const row = client as unknown as Record<string, unknown>;
  const pairs = VALIDATION_DIGEST_FIELDS.map((k) => [k, vettedValue(row[k])]);
  return crypto.createHash('sha256').update(canonicalJson(pairs)).digest('base64url');
}

// --- Publishers --- //

const PREFIX_PUBLISHER = 'dev-publisher/';
const PUBLISHER_STATUSES = ['none', 'pending', 'validated', 'suspended'];

/** The decision about a publisher (an account that owns apps), as the platform store holds it. */
export type PublisherRow = { status: 'none' | 'pending' | 'validated' | 'suspended'; displayName?: string };

/** The publisher row of an account, or null (absent or unreadable: not validated). */
export async function getPublisher (platform: PlatformDB, userId: string): Promise<PublisherRow | null> {
  if (typeof userId !== 'string' || userId.length === 0 || typeof platform?.getPlatformKv !== 'function') return null;
  const raw = await platform.getPlatformKv(PREFIX_PUBLISHER + userId);
  if (raw == null) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isPlainObject(v) || !PUBLISHER_STATUSES.includes(v.status as string)) return null;
  return {
    status: v.status as PublisherRow['status'],
    ...(typeof v.displayName === 'string' && v.displayName.length > 0 ? { displayName: v.displayName } : {}),
  };
}

/** Write a publisher decision (operator tools and tests; the review routes come later). */
export async function setPublisher (platform: PlatformDB, userId: string, row: PublisherRow): Promise<void> {
  if (typeof userId !== 'string' || userId.length === 0) throw new Error('setPublisher: userId required');
  if (!PUBLISHER_STATUSES.includes(row?.status)) throw new Error('setPublisher: status must be one of ' + PUBLISHER_STATUSES.join(', '));
  await platform.setPlatformKv(PREFIX_PUBLISHER + userId, JSON.stringify(row));
}

// --- The level --- //

/** What the consent screen is told about who vouches for the client. */
export type ClientValidation = {
  level: ValidationLevel;
  /** A developer's client: its publisher (the owning account). */
  publisher?: { name?: string; validated: boolean };
  /** App Validated by review: when the review was passed (ms since epoch). */
  validatedAt?: number;
};

/**
 * The level of a client (see the module comment). `publisher`: the owner's
 * publisher row, for a developer's client. `config` is read for a
 * metadata-document client only (`oauth:clientMetadataDocuments` mode).
 */
export function clientValidationLevel (client: OAuthClient, publisher: PublisherRow | null, config: ConfigReader | null): ClientValidation {
  if (client.origin === 'metadata-document') {
    const mode = config != null ? clientMetadataSettings(config).mode : 'any';
    return { level: mode === 'allowList' ? 'publisherValidated' : 'nonValidated' };
  }
  if (client.origin === 'developer') {
    const pub = publisher != null
      ? { publisher: { ...(publisher.displayName != null ? { name: publisher.displayName } : {}), validated: publisher.status === 'validated' } }
      : {};
    const app = client.validation?.app;
    if (app != null && typeof app.digest === 'string' && app.digest === validationDigest(client)) {
      return { level: 'appValidated', ...pub, ...(Number.isFinite(app.at) ? { validatedAt: app.at } : {}) };
    }
    if (publisher?.status === 'validated') return { level: 'publisherValidated', ...pub };
    return { level: 'nonValidated', ...pub };
  }
  // Registered by the operator (the CLI): the operator vouches for it.
  return { level: 'appValidated' };
}

/** The level of a client, its owner's publisher row read from the platform store. */
export async function resolveClientValidation (platform: PlatformDB, config: ConfigReader | null, client: OAuthClient): Promise<ClientValidation> {
  const owner = client.origin === 'developer' ? client.owner?.userId : undefined;
  const publisher = typeof owner === 'string' ? await getPublisher(platform, owner) : null;
  return clientValidationLevel(client, publisher, config);
}

/**
 * The display stamp of an access minted for a client (`clientStamp`), with
 * the client's level at that moment (`validation.level`); null when the
 * client gets no stamp.
 */
export async function validatedClientStamp (platform: PlatformDB, config: ConfigReader | null, row: OAuthClient | null): Promise<ClientStamp | null> {
  const stamp = clientStamp(row);
  if (stamp == null || row == null) return stamp;
  const { level } = await resolveClientValidation(platform, config, row);
  return { ...stamp, validation: { level } };
}

// --- Consent policy --- //

export type PolicyRefusal = { status: number; error: string; description: string; reason: string };

export const NOT_VALIDATED = 'this application is not validated on this platform';

/**
 * The refusal of a consent by the policy of the client's level, or null.
 * `userId`: the account consenting (null at /oauth2/authorize, where
 * `testers` and `maxGrants` cannot be decided yet).
 */
export async function consentPolicyRefusal (platform: PlatformDB, client: OAuthClient, policy: LevelPolicy,
  userId: string | null): Promise<PolicyRefusal | null> {
  if (policy.consent === 'refuse') {
    return { status: 403, error: 'access_denied', description: NOT_VALIDATED, reason: 'client-not-validated' };
  }
  if (userId == null) return null;
  if (policy.consent === 'testers') {
    // Testers: the owning account (the app team's tester list comes with the
    // developer space).
    const owner = client.origin === 'developer' ? client.owner?.userId : undefined;
    if (owner !== userId) {
      return { status: 403, error: 'access_denied', description: NOT_VALIDATED + ': only its testers may use it', reason: 'client-testers-only' };
    }
  }
  if (policy.maxGrants != null && !(await hasLevelGrant(platform, client.clientId, userId)) &&
      (await countLevelGrants(platform, client.clientId)) >= policy.maxGrants) {
    return {
      status: 403,
      error: 'access_denied',
      description: NOT_VALIDATED + ': it has reached the number of accounts it may reach until it is validated',
      reason: 'client-grant-limit',
    };
  }
  return null;
}

// --- The grant count of `maxGrants` --- //

const PREFIX_LEVEL_GRANT = 'oauth-level-grant/';

function levelGrantKey (clientId: string, userId: string): string {
  return PREFIX_LEVEL_GRANT + clientId + '/' + userId;
}

export async function hasLevelGrant (platform: PlatformDB, clientId: string, userId: string): Promise<boolean> {
  return (await platform.getPlatformKv(levelGrantKey(clientId, userId))) != null;
}

export async function countLevelGrants (platform: PlatformDB, clientId: string): Promise<number> {
  return (await platform.listPlatformKvKeys(PREFIX_LEVEL_GRANT + clientId + '/')).length;
}

/** Count an account that consented to the client (idempotent). */
export async function recordLevelGrant (platform: PlatformDB, clientId: string, userId: string): Promise<void> {
  await platform.setPlatformKv(levelGrantKey(clientId, userId), JSON.stringify({ at: Date.now() }));
}

/** Give back every unit of a client (its grants purged or the client revoked). Returns the count released. */
export async function releaseLevelGrants (platform: PlatformDB, clientId: string): Promise<number> {
  if (typeof platform?.listPlatformKvKeys !== 'function') return 0;
  const keys = await platform.listPlatformKvKeys(PREFIX_LEVEL_GRANT + clientId + '/');
  for (const k of keys) await platform.deletePlatformKv(k);
  return keys.length;
}

/** Test-only: forget the memoised settings. */
export function _resetForTests (): void {
  memo = null;
}
