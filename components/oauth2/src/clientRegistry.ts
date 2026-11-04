/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — App-account client registry.
 *
 * Reads from the PlatformDB cache row at key `oauth-client/<clientId>`
 * via the storage.ts wrapper (NOT directly from the App-account
 * `:_app:*` streams). The cache row is the cluster-wide source of
 * truth for /oauth2/authorize validation on ANY core (the multi-core
 * discovery-before-session-creation invariant).
 *
 * Write side (called only from the operator CLI, `bin/oauth-client.js`;
 * the HTTP `POST /oauth2/register` endpoint is intentionally deferred)
 * writes the PlatformDB row only: this module validates it and forwards
 * it to storage. No App-account stream is written.
 *
 * Operator policy: `curated` registration mode only.
 * Errors are mapped at endpoint edge via `errorMap.ts`, NOT
 * auto-derived.
 */

import { createRequire } from 'node:module';

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthClient, ClientStatus } from './storage.ts';
import { MAX_SYNTH_ENTRIES, canonicalJson } from './scopeGrammar.ts';
import { validatePublicJwkSet, keyMatchesAlg, CLIENT_ASSERTION_ALGS } from './jwks.ts';
import { jwksUriProblem } from './jwksUri.ts';
import { isLifetime } from './clientLifetimes.ts';
import { MAX_PREVIOUS_SECRET_WINDOW_MS } from './clientSecret.ts';
const require = createRequire(import.meta.url);

const storage = require('./storage.ts');

/**
 * Look up a client by `client_id`. Returns null if no such client
 * is registered (caller maps to `invalid_client` / `unknown-client`).
 */
export async function getClient (platform: PlatformDB, clientId: string): Promise<OAuthClient | null> {
  return storage.getClient(platform, clientId);
}

/**
 * Validate a presented redirect_uri against a client's registered set.
 * RFC 9700 §2.1 + RFC 8252 §7.5: exact string match, ONE carve-out:
 * on plain-http URIs whose host is one of `LOOPBACK_HOSTS` (`127.0.0.1`,
 * `[::1]`, `localhost`) the port may vary.
 *
 * No regex, no prefix matching, no scheme normalization. Phishers
 * exploit lax matching.
 */
export function validateRedirectUri (registered: string[], presented: string): boolean {
  if (!Array.isArray(registered) || registered.length === 0) return false;
  if (typeof presented !== 'string' || presented.length === 0) return false;
  // RFC 6749 §3.1.2: a redirect_uri MUST NOT carry a fragment. Reject at the
  // authorize gate too (registration already rejects it) — defense-in-depth so
  // a fragment URI can never be accepted even if one slipped into storage.
  if (presented.includes('#')) return false;
  // The URL parser drops tabs and newlines, so such a URI could match and
  // then fail as a Location header: refuse control characters outright.
  for (let i = 0; i < presented.length; i++) {
    const c = presented.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }

  for (const r of registered) {
    if (r === presented) return true;
    if (matchLoopback(r, presented)) return true;
  }
  return false;
}

/**
 * Loopback carve-out: `http://127.0.0.1/cb` registered matches
 * `http://127.0.0.1:<any-port>/cb` presented. Same for `[::1]` and
 * `localhost`. The host string must be the same on both sides (a
 * `127.0.0.1` registration does not admit `localhost`, nor the reverse).
 * Exact match on everything else (scheme, host, userinfo, path,
 * query, fragment): RFC 8252 §7.3 relaxes ONLY the port.
 */
function matchLoopback (registered: string, presented: string): boolean {
  let r: URL; let p: URL;
  try { r = new URL(registered); p = new URL(presented); } catch { return false; }
  if (r.protocol !== 'http:') return false; // loopback carve-out is HTTP only (RFC 8252 §7.3)
  if (r.protocol !== p.protocol) return false;
  if (r.hostname !== p.hostname) return false;
  if (!LOOPBACK_HOSTS.includes(r.hostname)) return false;
  // port may differ — that's the carve-out.
  if (r.username !== p.username) return false;
  if (r.password !== p.password) return false;
  if (r.pathname !== p.pathname) return false;
  if (r.search !== p.search) return false;
  if (r.hash !== p.hash) return false;
  return true;
}

/**
 * Persist a client (cluster-wide) — called from the CLI write path
 * AFTER the App-account `:_app:*` streams have been updated. The
 * dual-write is atomic at the CLI layer; this module owns the
 * cache-row format + validation.
 */
export async function persistClient (platform: PlatformDB, client: OAuthClient): Promise<void> {
  if (typeof client?.clientId !== 'string' || client.clientId.length === 0) {
    throw new Error('clientId required');
  }
  if (!Array.isArray(client.redirectUris) || client.redirectUris.length === 0) {
    throw new Error('redirectUris required (at least one)');
  }
  for (const uri of client.redirectUris) {
    if (typeof uri !== 'string' || uri.length === 0) {
      throw new Error('redirectUris: each entry must be a non-empty string');
    }
    // RFC 6749 §3.1.2: the redirection endpoint URI MUST NOT include a
    // fragment. authorize appends `?code=…&state=…`; on a fragment URI that
    // query lands INSIDE the fragment (`…#frag?code=…`) and the browser never
    // sends `code` to the server — the flow silently breaks. Reject at
    // registration so a mis-registered client fails loud, not at redeem time.
    if (uri.includes('#')) {
      throw new Error(`redirectUris: "${uri}" must not contain a fragment (#) — RFC 6749 §3.1.2`);
    }
  }
  if (!Array.isArray(client.grantTypes) || client.grantTypes.length === 0) {
    throw new Error('grantTypes required (at least one)');
  }
  if (client.kind === 'registry') {
    validateRegistryClient(client);
  } else {
    validateCmcOffers(client);
    if (client.canExchange != null) throw new Error('token exchange is available to registry clients only');
  }
  validateVettingAndDisplay(client);
  const validated = { ...client, updatedAt: Date.now() };
  // Inline public JWK Set (private_key_jwt): validate on write; any key
  // carrying private material is rejected outright, so the
  // no-credentials-in-PlatformDB invariant holds. Store the sanitized set
  // (only accepted members survive).
  if (validated.jwks != null) {
    try {
      validated.jwks = validatePublicJwkSet(validated.jwks);
    } catch (err) {
      throw new Error(`jwks: ${(err as Error).message}`);
    }
  }
  // A rotated secret whose window ended is never accepted: not carried along.
  if (typeof validated.previousSecretExpiresAt === 'number' && validated.previousSecretExpiresAt <= Date.now()) {
    delete validated.previousSecretHash;
    delete validated.previousSecretExpiresAt;
  }
  validateAuthAndLifetimes(validated);
  await storage.setClient(platform, validated);
}

/**
 * Key reference, pinned algorithms, rotated secret and lifetimes: the same
 * rules for every client kind.
 */
function validateAuthAndLifetimes (client: OAuthClient): void {
  if (client.jwksUri != null) {
    if (client.jwks != null) throw new Error('jwks and jwksUri exclude each other');
    const problem = jwksUriProblem(client.jwksUri);
    if (problem != null) throw new Error(problem);
  }
  const algs = client.tokenEndpointAuthSigningAlgs;
  if (algs != null) {
    if (!Array.isArray(algs) || algs.length === 0 || algs.some((a) => !CLIENT_ASSERTION_ALGS.includes(a))) {
      throw new Error('tokenEndpointAuthSigningAlgs must be a non-empty list of ' + CLIENT_ASSERTION_ALGS.join(', '));
    }
    if (new Set(algs).size !== algs.length) throw new Error('tokenEndpointAuthSigningAlgs lists an algorithm twice');
    if (client.jwks == null && client.jwksUri == null) {
      throw new Error('tokenEndpointAuthSigningAlgs needs a key set (jwks or jwksUri)');
    }
    if (client.jwks != null) {
      const unmatched = algs.filter((alg) => !client.jwks!.keys.some((k) => keyMatchesAlg(k, alg)));
      if (unmatched.length > 0) throw new Error('tokenEndpointAuthSigningAlgs: no key of the jwks fits ' + unmatched.join(', '));
    }
  }
  for (const key of ['accessTokenTTL', 'refreshTokenTTL', 'refreshTokenAbsoluteTTL'] as const) {
    if (client[key] != null && !isLifetime(client[key])) throw new Error(key + ' must be a positive integer (seconds)');
  }
  if (client.refreshTokenTTL != null && client.refreshTokenAbsoluteTTL != null &&
      client.refreshTokenTTL > client.refreshTokenAbsoluteTTL) {
    throw new Error('refreshTokenTTL must not exceed refreshTokenAbsoluteTTL');
  }
  if (client.offlineAccessAllowed != null && typeof client.offlineAccessAllowed !== 'boolean') {
    throw new Error('offlineAccessAllowed must be true or false');
  }
  if (client.previousSecretHash != null || client.previousSecretExpiresAt != null) {
    if (typeof client.previousSecretHash !== 'string' || client.previousSecretHash.length === 0 ||
        typeof client.previousSecretExpiresAt !== 'number' || !Number.isFinite(client.previousSecretExpiresAt)) {
      throw new Error('previousSecretHash and previousSecretExpiresAt go together');
    }
    if (typeof client.clientSecretHash !== 'string' || client.clientSecretHash.length === 0) {
      throw new Error('a previous secret needs a current one');
    }
    if (client.previousSecretExpiresAt > Date.now() + MAX_PREVIOUS_SECRET_WINDOW_MS) {
      throw new Error('the previous secret may stay valid 30 days at most');
    }
  }
}

/**
 * `cmcOffers` consistency rules, enforced at registration so authorize
 * never hits a dangling reference:
 *   - each offer name matches the `cmc:<name>` token grammar;
 *   - each capabilityUrl is an absolute https URL carrying the
 *     capability token as userinfo (`https://<token>@<host>/`);
 *   - every `cmc:<name>` token in `scope` has a matching offer entry.
 */
function validateCmcOffers (client: OAuthClient): void {
  const { isValidCmcOfferName } = require('./scopeRegistry.ts');
  const offers = client.cmcOffers ?? {};
  if (typeof offers !== 'object' || Array.isArray(offers)) {
    throw new Error('cmcOffers must be an object map of name → { capabilityUrl }');
  }
  for (const [name, entry] of Object.entries(offers)) {
    if (!isValidCmcOfferName(name)) {
      throw new Error(`cmcOffers: invalid offer name "${name}"`);
    }
    const capabilityUrl = (entry as { capabilityUrl?: unknown })?.capabilityUrl;
    if (typeof capabilityUrl !== 'string' || capabilityUrl.length === 0) {
      throw new Error(`cmcOffers["${name}"]: capabilityUrl required`);
    }
    let u: URL;
    try { u = new URL(capabilityUrl); } catch {
      throw new Error(`cmcOffers["${name}"]: capabilityUrl is not a valid URL`);
    }
    if (u.protocol !== 'https:' || u.username.length === 0) {
      throw new Error(`cmcOffers["${name}"]: capabilityUrl must be https with the capability token as userinfo (https://<token>@<host>/)`);
    }
  }
  for (const token of (client.scope ?? [])) {
    if (typeof token === 'string' && token.startsWith('cmc:')) {
      const name = token.slice('cmc:'.length);
      if (offers[name] == null) {
        throw new Error(`scope token "${token}" has no matching cmcOffers["${name}"] entry`);
      }
    }
  }
}

const AUTH_METHODS = ['none', 'client_secret_basic', 'private_key_jwt'];

/**
 * Rules for a registry client (operator-registered, no app account). Its
 * `scope` is a maximum scope set in the installed extension's grammar, which
 * the CLI process does not load: it is checked at /authorize.
 */
function validateRegistryClient (client: OAuthClient): void {
  if (client.accountUserId != null) throw new Error('registry client: accountUserId is not allowed (no app account)');
  if (client.cmcOffers != null && Object.keys(client.cmcOffers).length > 0) {
    throw new Error('registry client: cmcOffers are not allowed (offers are synthesised from the scope)');
  }
  if (!AUTH_METHODS.includes(client.tokenEndpointAuthMethod as string)) {
    throw new Error('registry client: tokenEndpointAuthMethod must be one of ' + AUTH_METHODS.join(', '));
  }
  if (client.tokenEndpointAuthMethod === 'client_secret_basic' && client.clientSecretHash == null) {
    throw new Error('registry client: client_secret_basic needs a client secret');
  }
  if (client.tokenEndpointAuthMethod === 'private_key_jwt' && client.jwks == null && client.jwksUri == null) {
    throw new Error('registry client: private_key_jwt needs a jwks or a jwksUri');
  }
  if (client.tokenEndpointAuthMethod !== 'private_key_jwt' && (client.jwksUri != null || client.tokenEndpointAuthSigningAlgs != null)) {
    throw new Error('registry client: jwksUri and tokenEndpointAuthSigningAlgs go with private_key_jwt only');
  }
  if (client.grantTypes.includes('client_credentials')) {
    throw new Error('registry client: client_credentials is not available (no app account)');
  }
  if (client.subjectType != null && client.subjectType !== 'public' && client.subjectType !== 'pairwise') {
    throw new Error('registry client: subjectType must be public or pairwise');
  }
  if (client.dpopBoundAccessTokens === true) {
    throw new Error('registry client: DPoP-bound tokens are not available for this kind of client');
  }
  if (!Array.isArray(client.scope) || client.scope.length === 0) {
    throw new Error('registry client: scope (the maximum scope set) is required');
  }
  const audiences = client.allowedAudiences ?? [];
  if (!Array.isArray(audiences)) throw new Error('allowedAudiences must be an array');
  if (audiences.length === 0 && client.anyAudience !== true) {
    throw new Error('registry client: at least one audience is required (or register it explicitly for any audience)');
  }
  if (audiences.length > 0 && client.anyAudience === true) {
    throw new Error('registry client: an audience list and "any audience" exclude each other');
  }
  for (const a of audiences) {
    let u: URL;
    try { u = new URL(a); } catch { throw new Error(`allowedAudiences: "${a}" is not a valid URL`); }
    if (u.protocol !== 'https:' || u.hash !== '') throw new Error(`allowedAudiences: "${a}" must be an absolute https URL without fragment`);
  }
  // The resource-server role of token exchange: the caller authenticates, and
  // a subject token is matched against its own audience list.
  if (client.canExchange != null && typeof client.canExchange !== 'boolean') {
    throw new Error('registry client: canExchange must be true or false');
  }
  if (client.canExchange === true) {
    if (client.tokenEndpointAuthMethod !== 'client_secret_basic' && client.tokenEndpointAuthMethod !== 'private_key_jwt') {
      throw new Error('registry client: token exchange needs a confidential client (client_secret_basic or private_key_jwt)');
    }
    if (client.anyAudience === true || audiences.length === 0) {
      throw new Error('registry client: token exchange needs an audience list (not "any audience"): the audiences it may exchange tokens for');
    }
  }
  const insecure = insecureRedirectUris(client.redirectUris);
  if (insecure.length > 0 && client.allowInsecureRedirect !== true) {
    throw new Error('registry client: plain http redirect URIs are allowed on loopback hosts only (' + insecure.join(', ') +
      '); register the client explicitly for insecure redirects to keep them');
  }
  for (const [k, v] of Object.entries(client.tokenResponseExtras ?? {})) {
    if (!['string', 'boolean', 'number'].includes(typeof v)) throw new Error(`tokenResponseExtras["${k}"] must be a string, boolean or number`);
  }
  if (client.logoUri != null) {
    const problem = logoUriProblem(client.logoUri);
    if (problem != null) throw new Error('logoUri: ' + problem);
  }
  if (client.allowFeatures != null) {
    if (!Array.isArray(client.allowFeatures) ||
        client.allowFeatures.some((f) => !REGISTRY_DEFAULT_FORBIDDEN_FEATURES.includes(f))) {
      throw new Error('registry client: allowFeatures may only list ' + REGISTRY_DEFAULT_FORBIDDEN_FEATURES.join(', '));
    }
  }
}

/**
 * Features a registry client's grant forbids unless the client row lists them
 * in `allowFeatures`: the core applies them after every consent (never shown
 * on the consent screen; a forbid always wins over an allow).
 */
export const REGISTRY_DEFAULT_FORBIDDEN_FEATURES: readonly string[] = Object.freeze(['webhooks', 'secretSharing', 'accessCreation']);

/** The default forbids that apply to this registry client. */
export function defaultForbiddenFeatures (client: OAuthClient): string[] {
  const allowed = Array.isArray(client.allowFeatures) ? client.allowFeatures : [];
  return REGISTRY_DEFAULT_FORBIDDEN_FEATURES.filter((f) => !allowed.includes(f));
}

/** The vetting statuses of a client row (absent reads as `active`). */
export const CLIENT_STATUSES: readonly ClientStatus[] = Object.freeze(['active', 'suspended', 'review']);
/** Bound on a row's status trail (oldest entries go first). */
export const MAX_STATUS_LOG = 50;
/** Bounds on the operator-registered display and vetting fields. */
const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_LANGUAGES = 32;
const MAX_SOFTWARE_ID_LENGTH = 256;
const MAX_REGIONS = 32;
const MAX_LOGO_URI_LENGTH = 2048;
const LANGUAGE_CODE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
const REGION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;
// eslint-disable-next-line no-control-regex
const CONTROL_BUT_NEWLINE_RE = /[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

/**
 * Status, status trail, display texts, software id, regions and the entry
 * ceiling: the same rules for every client kind (each field optional).
 */
function validateVettingAndDisplay (client: OAuthClient): void {
  if (client.status != null && !CLIENT_STATUSES.includes(client.status)) {
    throw new Error('status must be one of ' + CLIENT_STATUSES.join(', '));
  }
  if (client.statusLog != null) {
    if (!Array.isArray(client.statusLog) || client.statusLog.length > MAX_STATUS_LOG ||
        client.statusLog.some((e) => e == null || typeof e !== 'object' || typeof e.at !== 'number' || typeof e.reason !== 'string' ||
          typeof e.by !== 'string' || typeof e.from !== 'string' || typeof e.to !== 'string')) {
      throw new Error(`statusLog must be a list of at most ${MAX_STATUS_LOG} status changes`);
    }
  }
  if (client.name != null) {
    const problem = localizedTextProblem(client.name, MAX_NAME_LENGTH, false);
    if (problem != null) throw new Error('name: ' + problem);
  }
  if (client.description != null) {
    const problem = localizedTextProblem(client.description, MAX_DESCRIPTION_LENGTH, true);
    if (problem != null) throw new Error('description: ' + problem);
  }
  if (client.softwareId != null && (typeof client.softwareId !== 'string' || client.softwareId.length === 0 ||
      client.softwareId.length > MAX_SOFTWARE_ID_LENGTH || CONTROL_RE.test(client.softwareId))) {
    throw new Error(`softwareId must be 1 to ${MAX_SOFTWARE_ID_LENGTH} printable characters`);
  }
  if (client.regions != null) {
    if (!Array.isArray(client.regions) || client.regions.length > MAX_REGIONS ||
        client.regions.some((r) => typeof r !== 'string' || !REGION_KEY_RE.test(r))) {
      throw new Error(`regions must be a list of at most ${MAX_REGIONS} region keys (letters, digits, ".", "_", "-")`);
    }
    if (new Set(client.regions).size !== client.regions.length) throw new Error('regions lists a region twice');
  }
  if (client.maxEntries != null && !(Number.isInteger(client.maxEntries) && client.maxEntries > 0 && client.maxEntries <= MAX_SYNTH_ENTRIES)) {
    throw new Error(`maxEntries must be an integer from 1 to ${MAX_SYNTH_ENTRIES}`);
  }
}

/**
 * Why a display text is refused, or null: a non-empty string of at most
 * `maxLength` characters without control characters (newlines allowed in a
 * description), or a non-empty map of such strings keyed by language code.
 */
export function localizedTextProblem (v: unknown, maxLength: number, newlines: boolean): string | null {
  const re = newlines ? CONTROL_BUT_NEWLINE_RE : CONTROL_RE;
  const textOk = (t: unknown): boolean => typeof t === 'string' && t.trim().length > 0 && t.length <= maxLength && !re.test(t);
  if (typeof v === 'string') return textOk(v) ? null : `a non-empty text of at most ${maxLength} characters, no control characters`;
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return 'a text, or a map of texts by language code';
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_LANGUAGES) return `1 to ${MAX_LANGUAGES} languages`;
  for (const [lang, text] of entries) {
    if (!LANGUAGE_CODE_RE.test(lang)) return `"${lang}" is not a language code (e.g. en, fr, de-CH)`;
    if (!textOk(text)) return `the "${lang}" text must be non-empty, at most ${maxLength} characters, no control characters`;
  }
  return null;
}

/** Why a logo URI is refused, or null: an absolute https URL, no user information, no fragment. */
export function logoUriProblem (uri: unknown): string | null {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_LOGO_URI_LENGTH) {
    return `an https URL of at most ${MAX_LOGO_URI_LENGTH} characters is expected`;
  }
  let u: URL;
  try { u = new URL(uri); } catch { return `"${uri}" is not a valid URL`; }
  if (u.protocol !== 'https:') return `"${uri}" must be an https URL`;
  if (u.username !== '' || u.password !== '' || u.hash !== '') return `"${uri}" must carry no user information and no fragment`;
  return null;
}

/**
 * The `oauth:logoHosts` allow-list (hosts, `host:port` for another port than
 * 443), lower-cased; empty when unset or malformed: no logo is accepted.
 */
export function logoHostsFromConfig (config: { get (key: string): unknown }): string[] {
  const hosts = config.get('oauth:logoHosts');
  if (!Array.isArray(hosts)) return [];
  return hosts.filter((h): h is string => typeof h === 'string' && h.length > 0).map((h) => h.toLowerCase());
}

/** Whether a logo URI is https and on the allow-list. */
export function logoAllowed (uri: unknown, hosts: string[]): boolean {
  if (logoUriProblem(uri) != null) return false;
  return hosts.includes(new URL(uri as string).host.toLowerCase());
}

/** The logo a consent screen may show for this client, or undefined. */
export function servedLogoUri (client: OAuthClient, config: { get (key: string): unknown }): string | undefined {
  return logoAllowed(client.logoUri, logoHostsFromConfig(config)) ? client.logoUri : undefined;
}

/**
 * The region of this core: the key of the `hostings` region holding its
 * `core:hosting` (`default` when the platform declares no hierarchy), or null
 * when the hierarchy does not list its hosting.
 */
export function coreRegion (config: { get (key: string): unknown }): string | null {
  const hosting = String(config.get('core:hosting') || 'default');
  const regions = (config.get('hostings') as { regions?: unknown } | null | undefined)?.regions;
  if (regions == null || typeof regions !== 'object') return 'default';
  for (const [key, region] of Object.entries(regions as Record<string, { zones?: Record<string, { hostings?: Record<string, unknown> }> }>)) {
    for (const zone of Object.values(region?.zones ?? {})) {
      if (zone?.hostings != null && Object.hasOwn(zone.hostings, hosting)) return key;
    }
  }
  return null;
}

/** Why a client may not be used here and now, or null when it may. */
export type ClientRefusal = { reason: 'suspended' | 'review' | 'region'; description: string };

/**
 * Whether this client may be served: its status is `active` (absent reads as
 * active; suspended, under review or any other value is refused) and, when
 * it lists regions, this core's region is one of them (`config` given).
 */
export function clientUnavailable (client: OAuthClient, config?: { get (key: string): unknown } | null): ClientRefusal | null {
  const status = client.status ?? 'active';
  if (status === 'suspended') return { reason: 'suspended', description: 'this client is suspended' };
  if (status !== 'active') return { reason: 'review', description: 'this client is under review' };
  if (config != null && Array.isArray(client.regions) && client.regions.length > 0) {
    const region = coreRegion(config);
    if (region == null || !client.regions.includes(region)) {
      return { reason: 'region', description: 'this client is not available in this region' };
    }
  }
  return null;
}

/**
 * The fields whose change (in any direction) moves an active registry client
 * to review: where its codes and tokens land, how it proves who it is, what
 * it may reach and for how long. The launch types count too: the core does
 * not act on them, but an extension may grant on them. The token exchange
 * role too: it decides which users' authorizations the client may reach (every
 * one issued for an audience it lists). Not the subject type
 * (its own confirmation and the user's acknowledgement), the display texts,
 * regions nor the entry ceiling.
 */
export const VETTED_FIELDS = [
  'redirectUris', 'scope', 'jwks', 'jwksUri', 'tokenEndpointAuthMethod', 'tokenEndpointAuthSigningAlgs', 'grantTypes',
  'allowedAudiences', 'anyAudience', 'allowFeatures', 'canIntrospect', 'canExchange', 'launchTypes',
  'accessTokenTTL', 'refreshTokenTTL', 'refreshTokenAbsoluteTTL', 'offlineAccessAllowed',
] as const;

/** The vetted fields that differ between two versions of a row. */
export function changedVettedFields (before: OAuthClient, after: OAuthClient): string[] {
  return VETTED_FIELDS.filter((k) => canonicalJson(vettedValue(before[k])) !== canonicalJson(vettedValue(after[k])));
}

// An empty list is the same as none (a row written before a list field
// existed has none at all, e.g. `launchTypes`).
function vettedValue (v: unknown): unknown {
  return v == null || (Array.isArray(v) && v.length === 0) ? null : v;
}

const GRANT_LIST_FIELDS = ['scope', 'allowedAudiences', 'allowFeatures', 'launchTypes'] as const;
// `canExchange` withdrawn: the derived sessions already issued live out their
// (short) lifetime, as a narrowed grant's sessions do.
const GRANT_FLAG_FIELDS = ['anyAudience', 'canExchange'] as const;

/**
 * The fields of what a client may be granted that an update narrowed (an
 * entry removed, a flag withdrawn). Grants given before keep what the core
 * stored for them: the row is read at the next consent, not re-applied to
 * live grants. (Not `offlineAccessAllowed` nor `grantTypes`: the refresh
 * grant reads them.) The extension hooks see the current row at each refresh
 * and introspection.
 */
export function narrowedGrantFields (before: OAuthClient, after: OAuthClient): string[] {
  const lists = GRANT_LIST_FIELDS.filter((k) => {
    // `--any-audience` clears the list: a widening, not a narrowing.
    if (k === 'allowedAudiences' && after.anyAudience === true) return false;
    const kept = new Set((after[k] as string[] | undefined) ?? []);
    return ((before[k] as string[] | undefined) ?? []).some((v) => !kept.has(v));
  });
  const flags = GRANT_FLAG_FIELDS.filter((k) => before[k] === true && after[k] !== true);
  return [...lists, ...flags];
}

// The loopback host strings (`localhost` counts: RFC 6761 reserves it for
// loopback, and browsers resolve it to the loopback interface without a DNS
// lookup). One list, one rule: on plain http these hosts need no explicit
// insecure-redirect registration, and `validateRedirectUri` lets their port
// vary (RFC 8252 § 7.3), host string compared exactly. Resource indicators
// use the same list for their plain-http carve-out.
export const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];

/**
 * The plain-http redirect URIs of a list that do not point at the loopback
 * host (anything an on-path attacker could read the code from). Other
 * schemes (https, a native app's private scheme) are not concerned.
 */
export function insecureRedirectUris (uris: string[] | undefined): string[] {
  return (uris ?? []).filter((uri) => {
    let u: URL;
    try { u = new URL(uri); } catch { return false; }
    return u.protocol === 'http:' && !LOOPBACK_HOSTS.includes(u.hostname);
  });
}

/** Whether a client is registered without an app account. */
export function isRegistryClient (client: OAuthClient | null | undefined): boolean {
  return client?.kind === 'registry';
}

/**
 * Remove a client from the cache — called from the CLI revoke path.
 * Idempotent on a missing client.
 */
export async function removeClient (platform: PlatformDB, clientId: string): Promise<void> {
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new Error('clientId required');
  }
  await storage.deleteClient(platform, clientId);
}

/**
 * List registered clientIds. Used by the CLI `list` subcommand.
 */
export async function listClientIds (platform: PlatformDB): Promise<string[]> {
  return storage.listClientIds(platform);
}
