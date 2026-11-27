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
 *   value. While the mode is `curated`, a client a developer registered
 *   (`origin: developer`, left from a `delegated` period) is not served: its
 *   row is kept, `/oauth2/authorize`, the consent and refresh refuse it.
 * - `whoMayRegister` (`delegated` only): `validatedPublishers` (the default)
 *   or `anyAccount`.
 * - `levels.<level>`: `{ consent: allow | testers | refuse, scopeTemplate?,
 *   maxGrants? }` for each of `nonValidated`, `publisherValidated`,
 *   `appValidated`. Absent: `allow`, no template, no cap. `refuse` also stops
 *   the refresh of grants already given.
 *
 * The level of a client (its badge) is computed by the server, never stored
 * as such: a client the operator registered is App Validated; a client a
 * developer registered is App Validated while its app review stands (the
 * digest of its reviewed fields unchanged), else Publisher Validated when its
 * owner is a validated publisher, else Non-Validated; a metadata-document
 * client is Publisher Validated when its host is on `allowedHosts` (mode
 * `allowList`) and not denied, else Non-Validated.
 *
 * `maxGrants` counts, per client, the accounts that consented while the cap
 * applied (one platform row per account and client), reserved before the
 * consent is written. The count is approximate by design: consents racing
 * at the cap (on one core or several) may all be refused, an account's own
 * revocation of its grant does not give its unit back (the operator's
 * `purge-grants` and `revoke` do).
 */

import crypto from 'node:crypto';

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthClient } from './storage.ts';
import type { ExtPermission } from './extension.ts';
import { VETTED_FIELDS, MAX_STATUS_LOG, vettedValue, localizedTextProblem } from './clientRegistry.ts';
import { updatePlatformKv } from 'business/src/admin/store.ts';
import type { AdminStore } from 'business/src/admin/store.ts';
import { canonicalJson, checkMaxSet, permissionsWithin } from './scopeGrammar.ts';
import { clientMetadataSettings, hostListed } from './clientMetadataConfig.ts';
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
/** Upper bound of `maxGrants` (the count lists the client's rows). */
export const MAX_GRANTS_LIMIT = 100_000;

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
const REFUSE: LevelPolicy = Object.freeze({ consent: 'refuse', scopeTemplate: null, maxGrants: null }) as LevelPolicy;

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
        if (name === 'appValidated' && (policy.consent === 'refuse' || policy.consent === 'testers')) {
          warnings.push(`'${lat}.consent' is ${policy.consent}: it applies to the clients the operator registered too ` +
            '(they are App Validated and have no testers), so none of them can be used.');
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
let failClosedReported = '';

/**
 * The settings in force, with the defaults. A block with problems (the boot
 * refuses it) fails closed: mode `curated`, every level refused, reported
 * once on the server trail.
 */
export function clientRegistrationSettings (config: ConfigReader | null | undefined): ClientRegistrationSettings {
  const raw = config?.get('oauth:clientRegistration');
  let key: string;
  try { key = JSON.stringify(raw ?? null); } catch { key = ''; }
  if (memo != null && memo.key === key && key !== '') return memo.settings;
  const settings = buildSettings(raw, key);
  memo = { key, settings };
  return settings;
}

function buildSettings (raw: unknown, key: string): ClientRegistrationSettings {
  const d = DEFAULT_CLIENT_REGISTRATION_SETTINGS;
  if (raw == null) return { mode: d.mode, whoMayRegister: d.whoMayRegister, levels: { ...d.levels } };
  const problems = describeClientRegistrationConfig(raw).problems;
  if (!isPlainObject(raw) || problems.length > 0) {
    if (failClosedReported !== key) {
      failClosedReported = key;
      logServerWarning('oauth.clientRegistration has problems (' + problems.join('; ') + '): every client is refused until it is fixed');
    }
    return { mode: 'curated', whoMayRegister: d.whoMayRegister, levels: { nonValidated: REFUSE, publisherValidated: REFUSE, appValidated: REFUSE } };
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
    const max = templateMaxSet(level, template);
    if (!max.ok) {
      logServerWarning(`oauth.clientRegistration.levels.${level}.scopeTemplate: ${max.description}; /oauth2/authorize will refuse ` +
        'every client of that level (invalid_scope) until the template is fixed');
    }
  }
}

/**
 * The maximum permission set of a level's template, parsed once with a
 * neutral client (no field of any requesting client), memoised by the
 * grammar under an id that names the template.
 */
function templateMaxSet (level: ValidationLevel, template: string[]): { ok: true; permissions: ExtPermission[] } | { ok: false; description: string } {
  const digest = crypto.createHash('sha256').update(template.join(' ')).digest('hex').slice(0, 32);
  const probe = {
    clientId: 'level-template-' + level + '-' + digest,
    kind: 'registry',
    redirectUris: ['https://client.invalid/cb'],
    grantTypes: ['authorization_code'],
    scope: template,
    updatedAt: 0,
  } as OAuthClient;
  try {
    return checkMaxSet(probe);
  } catch (err) {
    return { ok: false, description: 'could not be checked: ' + (err as Error).message };
  }
}

/**
 * Whether the permissions a request resolved to (for the real client, as the
 * consent shows and grants them) fit the template of the client's level:
 * null when they do (or there is no template), else the refusal description.
 * A template the grammar refuses refuses everything (fail closed).
 */
export function scopeTemplateRefusal (level: ValidationLevel, template: string[] | null, permissions: ExtPermission[]): string | null {
  if (template == null) return null;
  const max = templateMaxSet(level, template);
  if (max.ok && permissionsWithin(permissions, max.permissions)) return null;
  return NOT_VALIDATED + ': it may not request this scope yet';
}

// --- The fields an app review vouches for --- //

/**
 * The display identity fields: what the consent screen shows of the app.
 * Not vetted for an operator's client (their change does not put it under
 * review), but part of what an app review approves.
 */
export const DISPLAY_IDENTITY_FIELDS = ['clientName', 'name', 'description', 'logoUri', 'clientUri', 'policyUri', 'tosUri'] as const;

/**
 * The fields an app review covers, by review version (`validation.app.v`; a
 * review stored without one is version 1). A later version may add fields:
 * a review keeps being compared with the list it was made under, so a
 * longer list never downgrades the apps already reviewed.
 *
 * Version 1: the vetted fields (`VETTED_FIELDS`), the display identity, and
 * what else changes what the app does or who stands behind it: plain-http
 * redirects, the subject type, the entry ceiling, DPoP binding, the token
 * response extras, the application type, the kind, the consent offers and the
 * owning account. Left out on purpose: `regions` (where it is served, not
 * what it does), `status` / `statusLog` (the operator's own trail),
 * `updatedAt` / `registeredAt` / `registeredBy`, the secrets (a rotation must
 * not drop the badge), `contacts`, `softwareId` and the metadata cache state.
 */
const DIGEST_FIELD_LISTS: Readonly<Record<number, readonly string[]>> = Object.freeze({
  1: Object.freeze([
    ...VETTED_FIELDS, ...DISPLAY_IDENTITY_FIELDS,
    'allowInsecureRedirect', 'subjectType', 'maxEntries', 'dpopBoundAccessTokens', 'tokenResponseExtras', 'applicationType',
    'kind', 'cmcOffers', 'owner',
  ]),
});

/** The review version `validate` writes. */
export const VALIDATION_DIGEST_VERSION = 1;

/** The fields the current review version covers. */
export const VALIDATION_DIGEST_FIELDS: readonly string[] = DIGEST_FIELD_LISTS[VALIDATION_DIGEST_VERSION];

/** Digest of the reviewed fields of a client row (base64url SHA-256) for a review version, or null for an unknown version. */
export function validationDigest (client: OAuthClient, version: number = VALIDATION_DIGEST_VERSION): string | null {
  const fields = DIGEST_FIELD_LISTS[version];
  if (fields == null) return null;
  const row = client as unknown as Record<string, unknown>;
  const pairs = fields.map((k) => [k, vettedValue(row[k])]);
  return crypto.createHash('sha256').update(canonicalJson(pairs)).digest('base64url');
}

/** Whether a row's stored app review still matches the row. */
export function reviewStands (client: OAuthClient): boolean {
  const app = client.validation?.app;
  if (app == null || typeof app.digest !== 'string') return false;
  const digest = validationDigest(client, Number.isInteger(app.v) ? app.v as number : 1);
  return digest != null && digest === app.digest;
}

// --- Publishers --- //

export const PREFIX_PUBLISHER = 'dev-publisher/';
export const PUBLISHER_STATUSES: readonly string[] = Object.freeze(['none', 'pending', 'validated', 'suspended']);
const MAX_PUBLISHER_NAME = 128;
const MAX_PUBLISHER_REGIONS = 32;
const MAX_REASON_LENGTH = 500;
const PUBLISHER_ID_RE = /^[A-Za-z0-9.~-]{1,64}$/;
const REGION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type PublisherStatus = 'none' | 'pending' | 'validated' | 'suspended';

/** The decision about a publisher (an account that owns apps), as the badge reads it. */
export type PublisherRow = { status: PublisherStatus; displayName?: string };

/** One decision about a publisher (the reviewers' trail). */
export type PublisherLogEntry = { at: number; by: string; from: PublisherStatus | 'absent'; to: PublisherStatus; reason: string };

/**
 * The publisher row as the platform store holds it: the decision, the name
 * shown once validated, the regions whose reviewers decide about it (absent:
 * a reviewer at scope `platform`), and the trail of decisions (last 50).
 */
export type PublisherRecord = PublisherRow & { regions?: string[]; statusLog?: PublisherLogEntry[]; updatedAt?: number };

function displayNameProblem (v: unknown): string | null {
  if (typeof v !== 'string') return 'must be a string';
  return localizedTextProblem(v, MAX_PUBLISHER_NAME, false);
}

/** Why a publisher id is refused, or null (the characters of an account id a client row may name as its owner). */
export function publisherIdProblem (userId: unknown): string | null {
  return typeof userId === 'string' && PUBLISHER_ID_RE.test(userId) ? null : 'must be 1 to 64 of A-Z a-z 0-9 . ~ -';
}

/** Why a publisher's region list is refused, or null (region keys, as a client's `regions`). */
export function publisherRegionsProblem (regions: unknown): string | null {
  if (!Array.isArray(regions) || regions.length === 0 || regions.length > MAX_PUBLISHER_REGIONS ||
      regions.some((r) => typeof r !== 'string' || !REGION_KEY_RE.test(r))) {
    return `must be a list of 1 to ${MAX_PUBLISHER_REGIONS} region keys (letters, digits, ".", "_", "-")`;
  }
  if (new Set(regions).size !== regions.length) return 'lists a region twice';
  return null;
}

/** Why a reviewer's reason is refused, or null: a text of 1 to 500 characters, no control characters. */
export function reviewReasonProblem (reason: unknown): string | null {
  if (typeof reason !== 'string') return `must be a text of 1 to ${MAX_REASON_LENGTH} characters`;
  return localizedTextProblem(reason, MAX_REASON_LENGTH, false);
}

function parsePublisher (raw: string | null): PublisherRecord | null {
  if (raw == null) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isPlainObject(v) || !PUBLISHER_STATUSES.includes(v.status as string)) return null;
  return {
    status: v.status as PublisherStatus,
    ...(v.displayName != null && displayNameProblem(v.displayName) == null ? { displayName: v.displayName as string } : {}),
    ...(v.regions != null && publisherRegionsProblem(v.regions) == null ? { regions: v.regions as string[] } : {}),
    ...(Array.isArray(v.statusLog) ? { statusLog: v.statusLog.filter(isPlainObject) as PublisherLogEntry[] } : {}),
    ...(Number.isFinite(v.updatedAt) ? { updatedAt: v.updatedAt as number } : {}),
  };
}

/** The whole publisher row of an account (regions and trail included), or null. */
export async function readPublisher (platform: PlatformDB, userId: string): Promise<PublisherRecord | null> {
  if (publisherIdProblem(userId) != null || typeof platform?.getPlatformKv !== 'function') return null;
  return parsePublisher(await platform.getPlatformKv(PREFIX_PUBLISHER + userId));
}

/** Every publisher row, by account id (unreadable rows left out). */
export async function listPublishers (platform: PlatformDB): Promise<Array<{ userId: string; row: PublisherRecord }>> {
  const out: Array<{ userId: string; row: PublisherRecord }> = [];
  for (const { key, value } of await platform.listPlatformKvEntries(PREFIX_PUBLISHER)) {
    const row = parsePublisher(value);
    if (row != null) out.push({ userId: key.slice(PREFIX_PUBLISHER.length), row });
  }
  return out.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

/** Why a publisher decision was refused (nothing was written). */
export class PublisherDecisionError extends Error {
  code: 'unknown-publisher' | 'invalid';
  constructor (code: 'unknown-publisher' | 'invalid', message: string) {
    super(message);
    this.name = 'PublisherDecisionError';
    this.code = code;
  }
}

/** A decision about a publisher (`decidePublisher`); `displayName` / `regions` left out are kept, null removes them. */
export type PublisherDecision = {
  status: string;
  displayName?: string | null;
  regions?: string[] | null;
  reason: string;
  by: string;
  allow?: (row: PublisherRecord | null) => boolean;
  now?: number;
};

/**
 * Record a decision about a publisher: its status, and (when given) its
 * display name (null removes it) and regions (null removes them), with a trail
 * entry `{ at, by, from, to, reason }` (last 50). A compare-and-set update of
 * the row: never written over a change it did not read. `allow` is asked
 * about the stored row inside the update (false answers `unknown-publisher`,
 * as for a row the caller may not see). The badge of the publisher's apps
 * follows at the next read on every core (`resolveClientValidation` reads the
 * row at each offer).
 */
export async function decidePublisher (platform: PlatformDB, userId: string, decision: PublisherDecision):
Promise<{ row: PublisherRecord; before: PublisherRecord | null; changed: boolean }> {
  const idProblem = publisherIdProblem(userId);
  if (idProblem != null) throw new PublisherDecisionError('invalid', 'userId ' + idProblem);
  if (!PUBLISHER_STATUSES.includes(decision.status)) throw new PublisherDecisionError('invalid', 'status must be one of ' + PUBLISHER_STATUSES.join(', '));
  if (decision.displayName != null) {
    const problem = displayNameProblem(decision.displayName);
    if (problem != null) throw new PublisherDecisionError('invalid', 'displayName ' + problem);
  }
  if (decision.regions != null) {
    const problem = publisherRegionsProblem(decision.regions);
    if (problem != null) throw new PublisherDecisionError('invalid', 'regions ' + problem);
  }
  const reasonProblem = reviewReasonProblem(decision.reason);
  if (reasonProblem != null) throw new PublisherDecisionError('invalid', 'reason ' + reasonProblem);
  if (typeof decision.by !== 'string' || decision.by.length === 0 || decision.by.length > 128) throw new Error('decidePublisher: by must be 1 to 128 characters');
  const now = decision.now ?? Date.now();
  let before: PublisherRecord | null = null;
  const done = await updatePlatformKv(platform as unknown as AdminStore, PREFIX_PUBLISHER + userId, (raw) => {
    before = parsePublisher(raw);
    if (decision.allow != null && !decision.allow(before)) throw new PublisherDecisionError('unknown-publisher', 'no publisher ' + userId);
    const next: PublisherRecord = { status: decision.status as PublisherStatus };
    const displayName = decision.displayName === undefined ? before?.displayName : decision.displayName;
    if (displayName != null) next.displayName = displayName;
    const regions = decision.regions === undefined ? before?.regions : decision.regions;
    if (regions != null) next.regions = regions;
    const entry: PublisherLogEntry = { at: now, by: decision.by, from: before?.status ?? 'absent', to: next.status, reason: decision.reason };
    next.statusLog = [...(before?.statusLog ?? []), entry].slice(-MAX_STATUS_LOG);
    next.updatedAt = now;
    return { next: JSON.stringify(next), result: next };
  });
  if (done == null) throw new Error('decidePublisher: no change made');
  return { row: done.result, before, changed: done.after !== done.before };
}

/** The publisher row of an account, or null (absent or unreadable: not validated). A display name breaking the rules is dropped. */
export async function getPublisher (platform: PlatformDB, userId: string): Promise<PublisherRow | null> {
  if (typeof userId !== 'string' || userId.length === 0 || typeof platform?.getPlatformKv !== 'function') return null;
  const raw = await platform.getPlatformKv(PREFIX_PUBLISHER + userId);
  if (raw == null) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isPlainObject(v) || !PUBLISHER_STATUSES.includes(v.status as string)) return null;
  return {
    status: v.status as PublisherRow['status'],
    ...(v.displayName != null && displayNameProblem(v.displayName) == null ? { displayName: v.displayName as string } : {}),
  };
}

/**
 * Overwrite a publisher row with a bare decision, without trail nor
 * compare-and-set (tests and tools seeding a state). Reviewers' decisions go
 * through `decidePublisher`.
 */
export async function setPublisher (platform: PlatformDB, userId: string, row: PublisherRow): Promise<void> {
  if (typeof userId !== 'string' || userId.length === 0) throw new Error('setPublisher: userId required');
  if (!PUBLISHER_STATUSES.includes(row?.status)) throw new Error('setPublisher: status must be one of ' + PUBLISHER_STATUSES.join(', '));
  if (row.displayName != null) {
    const problem = displayNameProblem(row.displayName);
    if (problem != null) throw new Error('setPublisher: displayName ' + problem);
  }
  await platform.setPlatformKv(PREFIX_PUBLISHER + userId, JSON.stringify(row));
}

// --- The level --- //

/** What the consent screen is told about who vouches for the client. */
export type ClientValidation = {
  level: ValidationLevel;
  /** A developer's client: its publisher (the owning account); `name` only once validated. */
  publisher?: { name?: string; validated: boolean };
  /** App Validated by review: when the review was passed (ms since epoch). */
  validatedAt?: number;
};

// A metadata-document client's host is vouched for when listed (and not denied).
function metadataHostVouched (client: OAuthClient, config: ConfigReader | null): boolean {
  if (config == null) return false;
  const settings = clientMetadataSettings(config);
  if (settings.mode !== 'allowList') return false;
  let u: URL;
  try { u = new URL(String(client.metadataUrl)); } catch { return false; }
  return hostListed(u.hostname, u.port, settings.allowedHosts, 'allow') && !hostListed(u.hostname, u.port, settings.deniedHosts, 'deny');
}

/**
 * The level of a client (see the module comment). `publisher`: the owner's
 * publisher row, for a developer's client. `config` is read for a
 * metadata-document client only (`oauth:clientMetadataDocuments`; without
 * it, such a client is Non-Validated).
 */
export function clientValidationLevel (client: OAuthClient, publisher: PublisherRow | null, config: ConfigReader | null): ClientValidation {
  if (client.origin === 'metadata-document') {
    return { level: metadataHostVouched(client, config) ? 'publisherValidated' : 'nonValidated' };
  }
  if (client.origin === 'developer') {
    const validated = publisher?.status === 'validated';
    const pub = publisher != null
      ? { publisher: { ...(validated && publisher.displayName != null ? { name: publisher.displayName } : {}), validated } }
      : {};
    if (reviewStands(client)) {
      const at = client.validation?.app?.at;
      return { level: 'appValidated', ...pub, ...(Number.isFinite(at) ? { validatedAt: at } : {}) };
    }
    if (validated) return { level: 'publisherValidated', ...pub };
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

// --- Serving and consent policy --- //

export type PolicyRefusal = { status: number; error: string; description: string; reason: string };

export const NOT_VALIDATED = 'this application is not validated on this platform';
export const DEVELOPER_CLIENTS_NOT_SERVED = 'applications registered by developers are not served on this platform';

/**
 * Whether the client may be served at all, before any account is known:
 * refused while the mode is `curated` for a developer's client, and when its
 * level's policy is `refuse`. Applies at /oauth2/authorize, the consent and
 * refresh.
 */
export function servingRefusal (client: OAuthClient, policy: LevelPolicy, config: ConfigReader | null): PolicyRefusal | null {
  if (client.origin === 'developer' && clientRegistrationSettings(config).mode !== 'delegated') {
    return { status: 403, error: 'access_denied', description: DEVELOPER_CLIENTS_NOT_SERVED, reason: 'developer-clients-not-served' };
  }
  if (policy.consent === 'refuse') {
    return { status: 403, error: 'access_denied', description: NOT_VALIDATED, reason: 'client-not-validated' };
  }
  return null;
}

/** The level, policy and serving refusal of a client, in one read. */
export async function clientPolicy (platform: PlatformDB, config: ConfigReader | null, client: OAuthClient):
Promise<{ validation: ClientValidation; policy: LevelPolicy; refused: PolicyRefusal | null }> {
  const validation = await resolveClientValidation(platform, config, client);
  const policy = levelPolicy(config, validation.level);
  return { validation, policy, refused: servingRefusal(client, policy, config) };
}

/**
 * The refusal of a consent by the account rule of the client's level
 * (`testers`), or null. The `maxGrants` cap is `reserveLevelGrant`.
 */
export function testersRefusal (client: OAuthClient, policy: LevelPolicy, userId: string): PolicyRefusal | null {
  if (policy.consent !== 'testers') return null;
  // Testers: the owning account (the app team's tester list comes with the
  // developer space).
  const owner = client.origin === 'developer' ? client.owner?.userId : undefined;
  if (owner === userId) return null;
  return { status: 403, error: 'access_denied', description: NOT_VALIDATED + ': only its testers may use it', reason: 'client-testers-only' };
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

/** Give back one account's unit (its reservation, when the consent failed). */
export async function releaseLevelGrant (platform: PlatformDB, clientId: string, userId: string): Promise<void> {
  await platform.deletePlatformKv(levelGrantKey(clientId, userId));
}

/**
 * Reserve the account's unit under the cap, before the consent is written:
 * an account already counted passes; otherwise its row is written first, then
 * the rows counted, and past the cap the row is removed and the consent
 * refused (accounts racing at the cap may all be refused: the safe side).
 * `reserved`: a new row was written (to release if the consent fails).
 */
export async function reserveLevelGrant (platform: PlatformDB, clientId: string, userId: string, max: number):
Promise<{ refused: PolicyRefusal | null; reserved: boolean }> {
  if (await hasLevelGrant(platform, clientId, userId)) return { refused: null, reserved: false };
  await recordLevelGrant(platform, clientId, userId);
  if ((await countLevelGrants(platform, clientId)) > max) {
    await releaseLevelGrant(platform, clientId, userId);
    return {
      refused: {
        status: 403,
        error: 'access_denied',
        description: NOT_VALIDATED + ': it has reached the number of accounts it may reach until it is validated',
        reason: 'client-grant-limit',
      },
      reserved: false,
    };
  }
  return { refused: null, reserved: true };
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
  failClosedReported = '';
}
