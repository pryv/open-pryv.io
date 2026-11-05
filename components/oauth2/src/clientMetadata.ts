/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: client metadata documents. A client whose `client_id` is an https
 * URL publishes, at that URL, a JSON document in the RFC 7591 shape. When
 * `oauth.clientMetadataDocuments.mode` is `allowList` or `any`,
 * `/oauth2/authorize` accepts such a `client_id`: the document is fetched,
 * validated, and written as a registry client row (`origin:
 * 'metadata-document'`, stored under `url~` + digest of the URL) whose
 * identity and display fields come from the document and whose reach comes
 * from the operator's template, never from the document. From that row on,
 * every existing path runs unchanged.
 *
 * The fetch goes through `peerFetch` (private, loopback, link-local and
 * reserved addresses refused, a pinned checked lookup, no redirect followed)
 * plus: https only whatever `cluster.allowInsecurePeerUrl` says, a 200 answer
 * only, `application/json` only, `maxDocumentBytes` declared and counted,
 * `fetchTimeoutMs`, a budget per host (10 a minute) and per core
 * (`fetchesPerMinute`), one fetch for concurrent misses on one URL. The
 * document body never reaches a log or an audit row.
 *
 * Caches: the row is the cluster-wide positive cache (used without a fetch
 * for `cacheSeconds`; a failed refetch keeps it usable until `fetchedAt +
 * staleGraceSeconds`; past it `/authorize` refuses the client but the row
 * stays, so live grants, refresh chains and introspection go on); a refused
 * or invalid URL is not fetched again on this core for `negativeCacheSeconds`.
 * A refetch happens at `/authorize` and in the operator CLI only.
 */

import crypto from 'node:crypto';
import { domainToUnicode } from 'node:url';

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthClient } from './storage.ts';
import * as storage from './storage.ts';
import { peerFetch, platformHostMatcher, type PeerSettings } from 'business/src/outbound/peerFetch.ts';
import { clientMetadataSettings, hostListed, type ClientMetadataSettings } from './clientMetadataConfig.ts';
import { clientIdUrlSyntaxProblem, metadataClientKey, isMetadataClientKey, METADATA_KEY_PREFIX } from './clientMetadataId.ts';
import { localizedTextProblem, logoUriProblem, insecureRedirectUris, persistMetadataClient } from './clientRegistry.ts';
import { validatePublicJwkSet, keyMatchesAlg, CLIENT_ASSERTION_ALGS, type PublicJwkSet } from './jwks.ts';
import { jwksUriProblem } from './jwksUri.ts';
import { canonicalJson } from './scopeGrammar.ts';
import { issuerFromConfig } from './issuer.ts';
import { audit } from './audit.ts';
import { logServerWarning, logServerDebug, logServerError } from './serverLog.ts';

type Config = { get (key: string): unknown };

/** The user-agent the fetch announces (no platform host in it). */
export const METADATA_FETCH_USER_AGENT = 'open-pryv.io client-metadata';

/** What the user-agent is told (the reason stays server-side). */
export const METADATA_INVALID = 'client metadata document invalid';
export const METADATA_UNAVAILABLE = 'client metadata document unavailable, retry later';
export const METADATA_STALE = 'client metadata document unavailable';

const MAX_REDIRECT_URIS = 32;
const MAX_URI_LENGTH = 2048;
const MAX_CONTACTS = 8;
const MAX_CONTACT_LENGTH = 256;
const MAX_SOFTWARE_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 128;
const KNOWN_GRANT_TYPES = ['authorization_code', 'refresh_token'];
const NEGATIVE_CACHE_SIZE = 1024;
const BUDGET_WINDOW_MS = 60 * 1000;
const LAST_USED_WRITE_INTERVAL_MS = 3600 * 1000;
/** Days a metadata-document row outlives the absolute refresh lifetime after its last use. */
const PRUNE_EXTRA_MS = 7 * 24 * 3600 * 1000;

// The document members this server reads; any other is ignored.
const READ_MEMBERS = new Set(['client_id', 'redirect_uris', 'token_endpoint_auth_method', 'grant_types', 'response_types',
  'client_name', 'client_uri', 'policy_uri', 'tos_uri', 'logo_uri', 'software_id', 'contacts', 'token_endpoint_auth_methods_supported']);
/** `application/json`, or a more specific `application/<subtype>+json` (RFC 6838 restricted name); lower-cased, no parameters. */
const JSON_MEDIA_TYPE_RE = /^application\/(?:json|[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\+json)$/;
/** The redirect URI schemes a metadata document may list (http on a loopback host only, checked apart). */
export const REDIRECT_SCHEMES: readonly string[] = Object.freeze(['https:', 'http:']);
// Read for a `private_key_jwt` document only (ignored with `none`).
const KEY_MEMBERS = ['jwks_uri', 'jwks', 'token_endpoint_auth_signing_alg'];
// Control and bidirectional-formatting characters (as for registered display texts).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

/** Why a metadata document URL is refused before any fetch. */
export type UrlRefusal = { reason: 'url' | 'host-policy'; detail: string };

/**
 * Why `url` may not be a client here, or null: the URL rules
 * (`clientIdUrlSyntaxProblem`), not a host of this platform (its API hosts,
 * the public URL host, the issuer host: a user can publish JSON on the
 * platform, the platform is not a client host), and the host policy (the
 * deny-list in both modes, the allow-list in `allowList` mode).
 */
export function clientIdUrlProblem (url: string, settings: ClientMetadataSettings, config: Config): UrlRefusal | null {
  const syntax = clientIdUrlSyntaxProblem(url);
  if (syntax != null) return { reason: 'url', detail: 'the client_id ' + syntax };
  const u = new URL(url);
  if (isPlatformHost(u.hostname, config)) return { reason: 'url', detail: 'the client_id names a host of this platform' };
  if (hostListed(u.hostname, u.port, settings.deniedHosts, 'deny')) return { reason: 'host-policy', detail: 'the host is denied' };
  if (settings.mode === 'allowList' && !hostListed(u.hostname, u.port, settings.allowedHosts, 'allow')) {
    return { reason: 'host-policy', detail: 'the host is not on the allow-list' };
  }
  if (settings.mode === 'off') return { reason: 'host-policy', detail: 'client metadata documents are off' };
  return null;
}

/** This platform's own hosts: API hosts (as `peerFetch` trusts them), the public URL's, the issuer's. */
export function isPlatformHost (hostname: string, config: Config): boolean {
  const h = hostname.toLowerCase();
  const matcher = platformHostMatcher({ coreUrl: config.get('core:url'), dnsDomain: config.get('dns:domain'), serviceApi: config.get('service:api') });
  if (matcher(h)) return true;
  for (const base of [config.get('dnsLess:publicUrl'), config.get('core:url'), issuerFromConfig(config)]) {
    if (typeof base !== 'string' || base === '') continue;
    try {
      if (new URL(base).hostname.toLowerCase() === h) return true;
    } catch { /* not a URL: ignored */ }
  }
  return false;
}

/** What a client row takes from its document (the template gives the rest). */
export type DocumentFields = {
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: 'none' | 'private_key_jwt';
  /** Kept on the row's `metadata`, not a row field. */
  authMethodSource?: AuthMethodSource;
  jwksUri?: string;
  jwks?: PublicJwkSet;
  tokenEndpointAuthSigningAlgs?: string[];
  clientName?: string;
  name?: Record<string, string>;
  clientUri?: string;
  policyUri?: string;
  tosUri?: string;
  logoUri?: string;
  softwareId?: string;
  contacts?: string[];
};

export type DocumentCheck =
  | { ok: true; fields: DocumentFields; ignored: string[]; dropped: string[] }
  | { ok: false; detail: string };

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** An optional https link of the document, kept only on the document's own host. */
function sameHostLink (v: unknown, metadataHost: string): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_URI_LENGTH || CONTROL_RE.test(v)) return null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.hash !== '' || v.includes('#')) return null;
  return u.host === metadataHost ? v : null;
}

/**
 * Validate a client metadata document fetched from `url`: what the row takes
 * from it, or why it is invalid. Members that grant reach (`scope`, ...) and
 * any member not read here are ignored.
 */
export function clientMetadataProblem (doc: unknown, url: string, settings: ClientMetadataSettings): DocumentCheck {
  if (!isPlainObject(doc)) return { ok: false, detail: 'the document is not a JSON object' };
  const metadataHost = new URL(url).host;
  // client_id: exactly the URL, as a string.
  if (doc.client_id !== url) return { ok: false, detail: 'client-id-mismatch: client_id does not equal the document URL' };

  // redirect_uris: the registry rules (plain http on a loopback host only).
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return { ok: false, detail: `redirect_uris: 1 to ${MAX_REDIRECT_URIS} URIs are required` };
  }
  for (const uri of uris) {
    if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_URI_LENGTH) {
      return { ok: false, detail: `redirect_uris: each entry must be a string of 1 to ${MAX_URI_LENGTH} characters` };
    }
    if (uri.includes('#')) return { ok: false, detail: 'redirect_uris: a redirect URI must not carry a fragment' };
    for (let i = 0; i < uri.length; i++) {
      const c = uri.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) return { ok: false, detail: 'redirect_uris: a redirect URI carries a control character' };
    }
    let parsed: URL;
    try { parsed = new URL(uri); } catch { return { ok: false, detail: 'redirect_uris: a redirect URI is not an absolute URI' }; }
    // The document is not the operator's: a consent UI hands the user-agent
    // to this URI, so only a web address may be one (no javascript:, data:,
    // file:, a private-use scheme, ...).
    if (!REDIRECT_SCHEMES.includes(parsed.protocol)) {
      return { ok: false, detail: 'redirect_uris: only https (and plain http on a loopback host) redirect URIs are accepted' };
    }
  }
  if (new Set(uris).size !== uris.length) return { ok: false, detail: 'redirect_uris: a URI is listed twice' };
  if (insecureRedirectUris(uris).length > 0) {
    return { ok: false, detail: 'redirect_uris: plain http is allowed on a loopback host only (localhost, 127.0.0.1, [::1])' };
  }

  const selected = selectAuthMethod(doc, settings);
  if (!selected.ok) return selected;
  const method = selected.method;
  if ((method !== 'none' && method !== 'private_key_jwt') || !settings.authMethods.includes(method)) {
    return { ok: false, detail: 'unsupported-auth-method: ' + JSON.stringify(method) + ' (accepted: ' + settings.authMethods.join(', ') + ')' };
  }
  const fields: DocumentFields = {
    redirectUris: [...uris as string[]],
    grantTypes: [],
    tokenEndpointAuthMethod: method,
    authMethodSource: selected.source,
  };
  // The key members, read for a client that authenticates with its keys only.
  const keyMembersIgnored: string[] = [];
  if (method === 'private_key_jwt') {
    const keys = documentKeys(doc, new URL(url).host);
    if (!keys.ok) return { ok: false, detail: keys.detail };
    Object.assign(fields, keys.fields);
    keyMembersIgnored.push(...keys.ignored);
  } else {
    for (const k of KEY_MEMBERS) if (doc[k] != null) keyMembersIgnored.push(k);
  }

  // grant_types: RFC 7591 default, then the ones this server serves.
  const grants = doc.grant_types ?? ['authorization_code'];
  if (!Array.isArray(grants) || grants.some((g) => typeof g !== 'string')) return { ok: false, detail: 'grant_types must be a list of strings' };
  fields.grantTypes = KNOWN_GRANT_TYPES.filter((g) => grants.includes(g));
  if (!fields.grantTypes.includes('authorization_code')) {
    return { ok: false, detail: 'unsupported-grant-types: authorization_code is required' };
  }
  const responseTypes = doc.response_types;
  if (responseTypes != null && (!Array.isArray(responseTypes) || !responseTypes.includes('code'))) {
    return { ok: false, detail: 'unsupported-response-types: code is required' };
  }

  // Display: the name (and its localized members), and the links on the
  // document's own host only.
  const dropped: string[] = [];
  if (doc.client_name != null) {
    if (localizedTextProblem(doc.client_name, MAX_NAME_LENGTH, false) != null || typeof doc.client_name !== 'string') {
      return { ok: false, detail: `client_name must be a text of at most ${MAX_NAME_LENGTH} characters, no control characters` };
    }
    fields.clientName = doc.client_name;
  }
  const localized: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!k.startsWith('client_name#')) continue;
    localized[k.slice('client_name#'.length)] = v as string;
  }
  if (Object.keys(localized).length > 0) {
    const problem = localizedTextProblem(localized, MAX_NAME_LENGTH, false);
    if (problem != null) return { ok: false, detail: 'client_name#<language>: ' + problem };
    fields.name = localized;
  }
  for (const [member, key] of [['client_uri', 'clientUri'], ['policy_uri', 'policyUri'], ['tos_uri', 'tosUri']] as const) {
    if (doc[member] == null) continue;
    const kept = sameHostLink(doc[member], metadataHost);
    if (kept != null) fields[key] = kept;
    else dropped.push(member);
  }
  if (doc.logo_uri != null) {
    if (logoUriProblem(doc.logo_uri) == null && sameHostLink(doc.logo_uri, metadataHost) != null) fields.logoUri = doc.logo_uri as string;
    else dropped.push('logo_uri');
  }
  if (doc.software_id != null) {
    const s = doc.software_id;
    if (typeof s === 'string' && s.length > 0 && s.length <= MAX_SOFTWARE_ID_LENGTH && !CONTROL_RE.test(s)) fields.softwareId = s;
    else dropped.push('software_id');
  }
  if (doc.contacts != null) {
    const c = doc.contacts;
    if (Array.isArray(c) && c.length <= MAX_CONTACTS &&
        c.every((x) => typeof x === 'string' && x.length > 0 && x.length <= MAX_CONTACT_LENGTH && !CONTROL_RE.test(x))) {
      fields.contacts = [...c as string[]];
    } else {
      dropped.push('contacts');
    }
  }
  const ignored = [
    ...Object.keys(doc).filter((k) => !READ_MEMBERS.has(k) && !KEY_MEMBERS.includes(k) && !k.startsWith('client_name#')),
    ...keyMembersIgnored,
  ];
  return { ok: true, fields, ignored, dropped };
}

/** Where a document's client authentication method was read from. */
export type AuthMethodSource = 'singular' | 'plural' | 'default';

/** In the order the server prefers them, when only the plural member names the methods. */
const PREFERRED_AUTH_METHODS = ['private_key_jwt', 'none'];
const MAX_PLURAL_AUTH_METHODS = 8;

/**
 * The client authentication method of a document, from
 * `token_endpoint_auth_method` (S) and `token_endpoint_auth_methods_supported`
 * (P): P, when present, is 1 to 8 distinct strings; S present decides, and
 * must then be listed in P when P is given; S absent, P present: the first of
 * `private_key_jwt`, `none` listed in P and accepted by the operator (the
 * strongest method the client says it can do; it fails closed when it then
 * does not); both absent: `none` (RFC 7591's default, a secret, cannot apply:
 * a document carries no secret).
 */
function selectAuthMethod (doc: Record<string, unknown>, settings: ClientMetadataSettings):
  { ok: true; method: unknown; source: AuthMethodSource } | { ok: false; detail: string } {
  const s = doc.token_endpoint_auth_method;
  const p = doc.token_endpoint_auth_methods_supported;
  if (p != null && !(Array.isArray(p) && p.length > 0 && p.length <= MAX_PLURAL_AUTH_METHODS &&
      p.every((m) => typeof m === 'string' && m.length > 0) && new Set(p).size === p.length)) {
    return { ok: false, detail: `unsupported-auth-method: token_endpoint_auth_methods_supported must be a list of 1 to ${MAX_PLURAL_AUTH_METHODS} distinct strings` };
  }
  const plural = p as string[] | undefined;
  if (s != null) {
    if (plural != null && (typeof s !== 'string' || !plural.includes(s))) {
      return { ok: false, detail: 'auth-method-inconsistent: token_endpoint_auth_method ' + JSON.stringify(s) + ' is not listed in token_endpoint_auth_methods_supported' };
    }
    return { ok: true, method: s, source: 'singular' };
  }
  if (plural != null) {
    const method = PREFERRED_AUTH_METHODS.find((m) => plural.includes(m) && settings.authMethods.includes(m));
    if (method == null) {
      return { ok: false, detail: 'unsupported-auth-method: token_endpoint_auth_methods_supported lists none of the accepted methods (' + settings.authMethods.join(', ') + ')' };
    }
    return { ok: true, method, source: 'plural' };
  }
  return { ok: true, method: 'none', source: 'default' };
}

/**
 * The key set of a `private_key_jwt` document: its `jwks_uri` (https, on the
 * document's own host: the key set is the client's identity and lives where
 * its document does) or, without one, its inline public `jwks`; `jwks_uri`
 * wins when both are given (the inline set is then ignored). An optional
 * `token_endpoint_auth_signing_alg` pins the one algorithm accepted.
 */
function documentKeys (doc: Record<string, unknown>, metadataHost: string):
  { ok: true; fields: Partial<DocumentFields>; ignored: string[] } | { ok: false; detail: string } {
  const fields: Partial<DocumentFields> = {};
  const ignored: string[] = [];
  if (doc.jwks_uri != null) {
    const problem = jwksUriProblem(doc.jwks_uri);
    if (problem != null) return { ok: false, detail: 'jwks_uri: ' + problem };
    const jwksUri = doc.jwks_uri as string;
    if (CONTROL_RE.test(jwksUri) || jwksUri.includes('#')) return { ok: false, detail: 'jwks_uri: a control character or a fragment' };
    if (new URL(jwksUri).host !== metadataHost) {
      return { ok: false, detail: 'jwks_uri must be on the host of the metadata document (' + metadataHost + ')' };
    }
    fields.jwksUri = jwksUri;
    if (doc.jwks != null) ignored.push('jwks');
  } else if (doc.jwks != null) {
    try {
      fields.jwks = validatePublicJwkSet(doc.jwks);
    } catch (err: unknown) {
      return { ok: false, detail: 'jwks: ' + (err as Error).message };
    }
  } else {
    return { ok: false, detail: 'private_key_jwt needs a jwks_uri or a jwks' };
  }
  const alg = doc.token_endpoint_auth_signing_alg;
  if (alg != null) {
    if (typeof alg !== 'string' || !CLIENT_ASSERTION_ALGS.includes(alg)) {
      return { ok: false, detail: 'token_endpoint_auth_signing_alg ' + JSON.stringify(alg) + ' (accepted: ' + CLIENT_ASSERTION_ALGS.join(', ') + ')' };
    }
    if (fields.jwks != null && !fields.jwks.keys.some((k) => keyMatchesAlg(k, alg))) {
      return { ok: false, detail: 'token_endpoint_auth_signing_alg ' + alg + ': no key of the jwks fits it' };
    }
    fields.tokenEndpointAuthSigningAlgs = [alg];
  }
  return { ok: true, fields, ignored };
}

export type FetchOutcome =
  | { ok: true; doc: unknown }
  | { ok: false; kind: 'unreachable' | 'invalid'; detail: string };

/**
 * GET the document at `url` (no cache, no budget): a 200 `application/json`
 * answer of at most `maxDocumentBytes`, UTF-8 without a byte order mark,
 * parsed as JSON.
 */
export async function fetchClientMetadataDocument (url: string, settings: ClientMetadataSettings,
  opts: { peerSettings?: PeerSettings } = {}): Promise<FetchOutcome> {
  if (!url.startsWith('https://')) return { ok: false, kind: 'invalid', detail: 'not an https URL' };
  let res: Response;
  try {
    const init = {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': METADATA_FETCH_USER_AGENT },
      signal: AbortSignal.timeout(settings.fetchTimeoutMs),
      redirect: 'manual',
    };
    // `peerSettings`: tests only (the counterparty allow-list of the run).
    res = opts.peerSettings != null ? await peerFetch(url, init, opts.peerSettings) : await peerFetch(url, init);
  } catch (err: unknown) {
    const e = err as { code?: string; kind?: string; name?: string; message?: string } | null;
    if (e?.code === 'EPEERREFUSED') return { ok: false, kind: 'unreachable', detail: 'refused: ' + e.kind };
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { ok: false, kind: 'unreachable', detail: 'timed out' };
    return { ok: false, kind: 'unreachable', detail: 'fetch failed: ' + (e?.message ?? String(err)) };
  }
  if (res.status !== 200) {
    await discardBody(res);
    return { ok: false, kind: 'unreachable', detail: 'HTTP status ' + res.status + (res.status >= 300 && res.status < 400 ? ' (redirects are not followed)' : '') };
  }
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!JSON_MEDIA_TYPE_RE.test(contentType)) {
    await discardBody(res);
    return { ok: false, kind: 'invalid', detail: 'content type ' + JSON.stringify(contentType) + ' (application/json expected)' };
  }
  const declared = res.headers.get('content-length');
  if (declared != null && Number(declared) > settings.maxDocumentBytes) {
    await discardBody(res);
    return { ok: false, kind: 'invalid', detail: `document larger than ${settings.maxDocumentBytes} bytes (declared)` };
  }
  const body = await readCapped(res, settings.maxDocumentBytes);
  if (body == null) return { ok: false, kind: 'invalid', detail: `document larger than ${settings.maxDocumentBytes} bytes` };
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    return { ok: false, kind: 'invalid', detail: 'the document starts with a byte order mark' };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return { ok: false, kind: 'invalid', detail: 'the document is not UTF-8' };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, kind: 'invalid', detail: 'the document is not JSON' };
  }
  if (!isPlainObject(doc)) return { ok: false, kind: 'invalid', detail: 'the document is not a JSON object' };
  return { ok: true, doc };
}

/** The body, or null as soon as it passes `max` bytes (the rest is not read). */
async function readCapped (res: Response, max: number): Promise<Buffer | null> {
  if (res.body == null) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

async function discardBody (res: Response): Promise<void> {
  try { await res.body?.cancel(); } catch { /* nothing to free */ }
}

/** Fetch and validate (the CLI's `check-metadata`, and every refetch). */
export async function fetchAndCheckClientMetadata (url: string, settings: ClientMetadataSettings):
Promise<{ ok: true; fields: DocumentFields; ignored: string[]; dropped: string[] } | { ok: false; kind: 'unreachable' | 'invalid'; detail: string }> {
  const fetched = await fetchClientMetadataDocument(url, settings);
  if (!fetched.ok) return fetched;
  const checked = clientMetadataProblem(fetched.doc, url, settings);
  if (!checked.ok) return { ok: false, kind: 'invalid', detail: checked.detail };
  return checked;
}

// The row fields derived from the document and the template (the digest
// covers them; a change bumps `updatedAt`).
const DERIVED_FIELDS = ['redirectUris', 'grantTypes', 'tokenEndpointAuthMethod', 'jwksUri', 'jwks', 'tokenEndpointAuthSigningAlgs',
  'clientName', 'name', 'clientUri', 'policyUri', 'tosUri', 'logoUri', 'softwareId', 'contacts',
  'scope', 'allowedAudiences', 'launchTypes', 'subjectType', 'maxEntries', 'offlineAccessAllowed',
  'accessTokenTTL', 'refreshTokenTTL', 'refreshTokenAbsoluteTTL', 'regions', 'allowFeatures'] as const;

function contentDigest (row: Partial<OAuthClient>): string {
  const picked: Record<string, unknown> = {};
  for (const k of DERIVED_FIELDS) if (row[k] !== undefined) picked[k] = row[k];
  return crypto.createHash('sha256').update(canonicalJson(picked)).digest('base64url');
}

/**
 * The client row of the document at `url`: identity and display from the
 * document, reach from the template, the hard-coded limits of such a row,
 * and what the operator set on the previous row (status and its trail).
 * `updatedAt` changes only when a derived field changed.
 */
export function buildMetadataClientRow (url: string, fields: DocumentFields, settings: ClientMetadataSettings,
  existing: OAuthClient | null, now: number): OAuthClient {
  const t = settings.client;
  const { authMethodSource, ...documentFields } = fields;
  const derived: Partial<OAuthClient> = {
    ...documentFields,
    contacts: fields.contacts ?? [],
    scope: [...t.scope],
    allowedAudiences: [...t.allowedAudiences],
    launchTypes: [...t.launchTypes],
    subjectType: t.subjectType,
    maxEntries: t.maxEntries,
    ...(t.offlineAccessAllowed ? {} : { offlineAccessAllowed: false }),
    ...(t.accessTokenTTL != null ? { accessTokenTTL: t.accessTokenTTL } : {}),
    ...(t.refreshTokenTTL != null ? { refreshTokenTTL: t.refreshTokenTTL } : {}),
    ...(t.refreshTokenAbsoluteTTL != null ? { refreshTokenAbsoluteTTL: t.refreshTokenAbsoluteTTL } : {}),
    ...(t.regions.length > 0 ? { regions: [...t.regions] } : {}),
    allowFeatures: [],
  };
  const digest = contentDigest(derived);
  const unchanged = existing?.metadata?.contentDigest === digest && typeof existing.updatedAt === 'number';
  return {
    ...(derived as OAuthClient),
    clientId: metadataClientKey(url),
    kind: 'registry',
    origin: 'metadata-document',
    metadataUrl: url,
    registeredBy: 'metadata-document',
    registeredAt: existing?.registeredAt ?? now,
    status: existing?.status ?? 'active',
    ...(Array.isArray(existing?.statusLog) ? { statusLog: existing!.statusLog } : {}),
    metadata: {
      fetchedAt: now,
      expiresAt: now + settings.cacheSeconds * 1000,
      contentDigest: digest,
      lastUsedAt: Math.max(existing?.metadata?.lastUsedAt ?? 0, now),
      ...(authMethodSource != null ? { authMethodSource } : {}),
      ...(existing?.metadata?.firstConsentAt != null ? { firstConsentAt: existing.metadata.firstConsentAt } : {}),
      ...(existing?.metadata?.operatorRefreshedAt != null ? { operatorRefreshedAt: existing.metadata.operatorRefreshedAt } : {}),
    },
    updatedAt: unchanged ? existing!.updatedAt : now,
  };
}

/** The derived fields that differ between two versions of a row. */
export function changedMetadataFields (before: OAuthClient | null, after: OAuthClient): string[] {
  if (before == null) return [];
  return DERIVED_FIELDS.filter((k) => canonicalJson(before[k] ?? null) !== canonicalJson(after[k] ?? null));
}

// --- Per-core state: negative cache, budgets, in-flight refreshes --- //

type Negative = { kind: 'unreachable' | 'invalid'; detail: string; until: number };
const negativeCache = new Map<string, Negative>();
const fetchTimes: number[] = [];
const creationTimes: number[] = [];
const hostFetchTimes = new Map<string, number[]>();
const refusalSamples = new Map<string, { since: number; suppressed: number }>();
const inflight = new Map<string, Promise<RefreshOutcome>>();

const REFUSAL_WINDOW_MS = 60 * 1000;
const MAX_REFUSAL_SAMPLE_KEYS = 4096;
const MAX_REFUSED_URL_LENGTH = 256;

/**
 * Refusals cost an unauthenticated caller nothing: their log lines and audit
 * rows are sampled, at most one per (host, reason) and minute on this core.
 * The first refusal of a window is emitted and carries the count of those
 * suppressed in the window before it.
 */
export function sampledRefusal (host: string, reason: string, now: number): { emit: boolean; suppressed: number } {
  const key = host + '|' + reason;
  const entry = refusalSamples.get(key);
  if (entry != null && now - entry.since < REFUSAL_WINDOW_MS) {
    entry.suppressed++;
    return { emit: false, suppressed: 0 };
  }
  refusalSamples.delete(key);
  refusalSamples.set(key, { since: now, suppressed: 0 });
  if (refusalSamples.size > MAX_REFUSAL_SAMPLE_KEYS) {
    for (const [k, e] of refusalSamples) if (now - e.since >= REFUSAL_WINDOW_MS) refusalSamples.delete(k);
    while (refusalSamples.size > MAX_REFUSAL_SAMPLE_KEYS) {
      const oldest = refusalSamples.keys().next().value;
      if (oldest === undefined) break;
      refusalSamples.delete(oldest);
    }
  }
  return { emit: true, suppressed: entry?.suppressed ?? 0 };
}

type Refusal = { clientId: string; metadataUrl: string; host: string; reason: string; detail: string };

/**
 * Audit (and, with `warning`, log) a refused metadata document URL or
 * document; sampled unless `sampled` is false (the operator CLI). The URL is
 * cut to 256 characters; the document body never reaches either.
 */
async function reportRefusal (refusal: Refusal, now: number, warning: string | null, sampled: boolean = true): Promise<void> {
  const s = sampled ? sampledRefusal(refusal.host, refusal.reason, now) : { emit: true, suppressed: 0 };
  if (!s.emit) return;
  if (warning != null) logServerWarning(warning + (s.suppressed > 0 ? ` (and ${s.suppressed} more in the last minute)` : ''));
  await audit('oauth.client.metadata_refused', {
    clientId: refusal.clientId,
    metadataUrl: refusal.metadataUrl.slice(0, MAX_REFUSED_URL_LENGTH),
    host: refusal.host,
    reason: refusal.reason,
    detail: refusal.detail,
    ...(s.suppressed > 0 ? { suppressed: s.suppressed } : {}),
  });
}

function rememberNegative (url: string, entry: Negative): void {
  negativeCache.delete(url);
  negativeCache.set(url, entry);
  while (negativeCache.size > NEGATIVE_CACHE_SIZE) {
    const oldest = negativeCache.keys().next().value;
    if (oldest === undefined) break;
    negativeCache.delete(oldest);
  }
}

function negativeFor (url: string, now: number): Negative | null {
  const entry = negativeCache.get(url);
  if (entry == null) return null;
  if (entry.until <= now) {
    negativeCache.delete(url);
    return null;
  }
  return entry;
}

/** Take one fetch from this core's budgets (per core and per host), or false when either is spent. */
function takeFetchBudget (host: string, settings: ClientMetadataSettings, now: number): boolean {
  const since = now - BUDGET_WINDOW_MS;
  while (fetchTimes.length > 0 && fetchTimes[0] <= since) fetchTimes.shift();
  const perHost = (hostFetchTimes.get(host) ?? []).filter((t) => t > since);
  if (fetchTimes.length >= settings.fetchesPerMinute || perHost.length >= settings.fetchesPerMinutePerHost) {
    hostFetchTimes.set(host, perHost);
    return false;
  }
  fetchTimes.push(now);
  perHost.push(now);
  hostFetchTimes.set(host, perHost);
  // Hosts with no fetch in the window are forgotten.
  if (hostFetchTimes.size > 4096) {
    for (const [h, times] of hostFetchTimes) if (times.every((t) => t <= since)) hostFetchTimes.delete(h);
  }
  return true;
}

/** Whether this core may write another new client row this minute (`newClientsPerMinute`); the caller pushes the unit. */
function creationBudgetLeft (settings: ClientMetadataSettings, now: number): boolean {
  const since = now - BUDGET_WINDOW_MS;
  while (creationTimes.length > 0 && creationTimes[0] <= since) creationTimes.shift();
  return creationTimes.length < settings.newClientsPerMinute;
}

type RefreshOutcome =
  | { ok: true; client: OAuthClient }
  | { ok: false; kind: 'unreachable' | 'invalid'; detail: string; gone?: true };

/**
 * Fetch the document, validate it and write the row (the template applied
 * again). Audited once per fetch; concurrent callers share it.
 */
async function refreshRow (platform: PlatformDB, url: string, settings: ClientMetadataSettings,
  existing: OAuthClient | null, now: number, sampled: boolean = true, operator: boolean = false): Promise<RefreshOutcome> {
  const host = new URL(url).host;
  const checked = await fetchAndCheckClientMetadata(url, settings);
  if (!checked.ok) {
    await reportRefusal({ clientId: metadataClientKey(url), metadataUrl: url, host, reason: checked.kind, detail: checked.detail }, now,
      `client metadata document on ${host}: ${checked.kind} (${checked.detail})`, sampled);
    return checked;
  }
  if (checked.ignored.length > 0) logServerDebug(`client metadata document on ${host}: members ignored: ${checked.ignored.join(', ')}`);
  if (checked.dropped.length > 0) logServerDebug(`client metadata document on ${host}: dropped (not on the document's host, or malformed): ${checked.dropped.join(', ')}`);
  // The row as it stands now, not as read before the fetch: an operator
  // suspend, a revoke or another core's write during the fetch wins.
  const current = await storage.getClient(platform, metadataClientKey(url));
  if (existing != null && current == null) {
    logServerWarning(`client metadata document on ${host}: the client was removed during the fetch; not written again`);
    return { ok: false, kind: 'invalid', detail: 'the client was removed during the fetch', gone: true };
  }
  existing = current;
  const row = buildMetadataClientRow(url, checked.fields, settings, existing, now);
  // The operator fetched it by hand: the row is permanent (never pruned as provisional).
  if (operator && row.metadata != null) row.metadata.operatorRefreshedAt = now;
  try {
    await persistMetadataClient(platform, row);
  } catch (err: unknown) {
    // The document passed; the row is refused by the registry rules (the
    // template, most likely): an operator matter.
    const s = sampled ? sampledRefusal(host, 'derived-row', now) : { emit: true, suppressed: 0 };
    if (s.emit) logServerError(`client metadata document on ${host}: the derived client row is refused`, err);
    await reportRefusal({ clientId: row.clientId, metadataUrl: url, host, reason: 'invalid', detail: 'derived row refused: ' + (err as Error).message },
      now, null, sampled);
    return { ok: false, kind: 'invalid', detail: 'derived row refused: ' + (err as Error).message };
  }
  const changedFields = changedMetadataFields(existing, row);
  await audit('oauth.client.metadata_fetched', {
    clientId: row.clientId,
    metadataUrl: url,
    host,
    outcome: existing == null ? 'created' : (row.updatedAt === existing.updatedAt ? 'unchanged' : 'refreshed'),
    ...(changedFields.length > 0 ? { changedFields } : {}),
    ...(existing == null && isProvisionalRow(row) ? { provisional: true } : {}),
  });
  return { ok: true, client: row };
}

function sharedRefresh (platform: PlatformDB, url: string, settings: ClientMetadataSettings,
  existing: OAuthClient | null, now: number): Promise<RefreshOutcome> {
  let pending = inflight.get(url);
  if (pending == null) {
    pending = refreshRow(platform, url, settings, existing, now).finally(() => { inflight.delete(url); });
    inflight.set(url, pending);
  }
  return pending;
}

export type ResolveOutcome =
  | { ok: true; client: OAuthClient }
  | { ok: false; reason: 'url' | 'host-policy' | 'unreachable' | 'invalid' | 'budget' | 'stale'; message: string };

/**
 * The client row a metadata document URL names, at `/oauth2/authorize`:
 * checked against the URL rules and the host policy, then read from the
 * cache row, or fetched (a missing or expired row) within the budgets.
 */
export async function resolveMetadataClient (deps: { platform: PlatformDB; config: Config }, url: string,
  opts: { now?: number } = {}): Promise<ResolveOutcome> {
  const settings = clientMetadataSettings(deps.config);
  const now = opts.now ?? Date.now();
  const refused = clientIdUrlProblem(url, settings, deps.config);
  if (refused != null) {
    let host = '';
    try { host = new URL(url).host; } catch { host = ''; }
    await reportRefusal({
      clientId: refused.reason === 'url' && clientIdUrlSyntaxProblem(url) != null ? '' : metadataClientKey(url),
      metadataUrl: url,
      host,
      reason: refused.reason,
      detail: refused.detail,
    }, now, null);
    return {
      ok: false,
      reason: refused.reason,
      message: refused.reason === 'url'
        ? 'client_id is not an accepted client metadata document URL: ' + refused.detail.replace(/^the client_id /, '')
        : 'the host of this client_id is not accepted here',
    };
  }
  const key = metadataClientKey(url);
  const existing = await storage.getClient(deps.platform, key);
  if (existing != null && existing.origin !== 'metadata-document') {
    return { ok: false, reason: 'invalid', message: METADATA_INVALID };
  }
  if (existing?.metadata != null && existing.metadata.expiresAt > now) {
    await touchLastUsed(deps.platform, existing, now);
    return { ok: true, client: existing };
  }
  const withinGrace = existing?.metadata != null && now < existing.metadata.fetchedAt + settings.staleGraceSeconds * 1000;
  const keepStale = async (why: string): Promise<ResolveOutcome> => {
    const s = sampledRefusal(new URL(url).host, 'stale', now);
    if (s.emit) {
      logServerWarning(`client metadata document on ${new URL(url).host}: ${why}; the stored client is used until its stale grace ends` +
        (s.suppressed > 0 ? ` (and ${s.suppressed} more in the last minute)` : ''));
    }
    await touchLastUsed(deps.platform, existing!, now);
    return { ok: true, client: existing! };
  };
  const negative = negativeFor(url, now);
  if (negative != null) {
    if (withinGrace) return { ok: true, client: existing! };
    return { ok: false, reason: negative.kind, message: messageFor(negative.kind, existing) };
  }
  const host = new URL(url).host;
  // A new client (no row yet) also takes a unit of the smaller creation
  // budget: rows written before any consent are what an unauthenticated
  // caller could pile up. A refetch of an existing row never takes one.
  const creating = existing == null && !inflight.has(url);
  if (creating && !creationBudgetLeft(settings, now)) {
    await reportRefusal({ clientId: key, metadataUrl: url, host, reason: 'budget', detail: 'new client budget spent' }, now,
      `client metadata documents: new client budget spent (host ${host}); refused without a fetch`);
    return { ok: false, reason: 'budget', message: METADATA_UNAVAILABLE };
  }
  // A fetch of this URL in flight is joined, without taking a budget unit.
  if (!inflight.has(url) && !takeFetchBudget(host, settings, now)) {
    await reportRefusal({ clientId: key, metadataUrl: url, host, reason: 'budget', detail: 'fetch budget spent' }, now,
      `client metadata documents: fetch budget spent (host ${host}); refused without a fetch`);
    if (withinGrace) return { ok: true, client: existing! };
    return { ok: false, reason: 'budget', message: METADATA_UNAVAILABLE };
  }
  if (creating) creationTimes.push(now);
  const outcome = await sharedRefresh(deps.platform, url, settings, existing, now);
  if (outcome.ok) return outcome;
  // Revoked during the fetch: the stale copy is not served, nothing is cached.
  if (outcome.gone === true) return { ok: false, reason: 'invalid', message: METADATA_UNAVAILABLE };
  rememberNegative(url, { kind: outcome.kind, detail: outcome.detail, until: now + settings.negativeCacheSeconds * 1000 });
  if (withinGrace) return await keepStale(outcome.kind);
  return { ok: false, reason: existing != null ? 'stale' : outcome.kind, message: messageFor(outcome.kind, existing) };
}

function messageFor (kind: 'unreachable' | 'invalid', existing: OAuthClient | null): string {
  if (existing != null) return METADATA_STALE;
  return kind === 'invalid' ? METADATA_INVALID : METADATA_UNAVAILABLE;
}

/** Record a use of the row, at most once an hour (its `updatedAt` kept). */
async function touchLastUsed (platform: PlatformDB, row: OAuthClient, now: number): Promise<void> {
  const m = row.metadata;
  if (m == null || now - m.lastUsedAt < LAST_USED_WRITE_INTERVAL_MS) return;
  try {
    // Written over the row as it stands now (an operator status change or a
    // refetch since the request's read is kept); skipped when the row is gone
    // or its content changed meanwhile (that writer recorded the use).
    const current = await storage.getClient(platform, row.clientId);
    if (current?.metadata == null || current.metadata.contentDigest !== m.contentDigest) return;
    await storage.setClient(platform, { ...current, metadata: { ...current.metadata, lastUsedAt: now } });
  } catch (err) {
    logServerError('client metadata: could not record a use of ' + row.clientId, err);
  }
}

/**
 * A metadata-document client refused `invalid_client` at `/oauth2/token`,
 * `/oauth2/revoke` or `/oauth2/introspect`: logged and audited
 * (`oauth.client.metadata_refused`, reason `client-auth`) with the endpoint
 * and grant type, sampled per client, endpoint, grant type and minute, so an
 * operator sees why a connector fails. Any other client: nothing.
 */
export async function reportClientAuthRefusal (platform: PlatformDB, clientId: string, endpoint: 'token' | 'revoke' | 'introspect',
  grantType: string = ''): Promise<void> {
  if (!isMetadataClientKey(clientId)) return;
  const what = endpoint + (grantType !== '' ? ' ' + grantType.slice(0, 128) : '');
  const s = sampledRefusal(clientId, 'client-auth|' + what, Date.now());
  if (!s.emit) return;
  let row: OAuthClient | null = null;
  try { row = await storage.getClient(platform, clientId); } catch { row = null; }
  const url = row?.metadataUrl ?? '';
  let host = '';
  try { host = url !== '' ? new URL(url).host : ''; } catch { host = ''; }
  logServerWarning(`client metadata document client ${url !== '' ? url : clientId}: invalid_client at /oauth2/${what}` +
    (s.suppressed > 0 ? ` (and ${s.suppressed} more in the last minute)` : ''));
  await audit('oauth.client.metadata_refused', {
    clientId,
    metadataUrl: url.slice(0, MAX_REFUSED_URL_LENGTH),
    host,
    reason: 'client-auth',
    detail: '/oauth2/' + what + ': client authentication failed',
    ...(s.suppressed > 0 ? { suppressed: s.suppressed } : {}),
  });
}

/**
 * Operator: fetch the document now (no cache, no budget) and write the row.
 * Resolves to the row and the fields that changed, or the refusal.
 */
export async function refreshMetadataClient (platform: PlatformDB, config: Config, url: string, opts: { now?: number } = {}):
Promise<{ ok: true; client: OAuthClient; changedFields: string[]; created: boolean } | { ok: false; reason: string; detail: string }> {
  const settings = clientMetadataSettings(config);
  // Off (or a block with problems, which reads as off): there is no template
  // in force to build the client from; nothing is fetched.
  if (settings.mode === 'off') {
    return {
      ok: false,
      reason: 'mode-off',
      detail: 'oauth.clientMetadataDocuments is off on this core (mode: off, or the block has problems: check-config): the template is not in force, nothing fetched',
    };
  }
  const refused = clientIdUrlProblem(url, settings, config);
  if (refused != null) return { ok: false, reason: refused.reason, detail: refused.detail };
  const now = opts.now ?? Date.now();
  const existing = await storage.getClient(platform, metadataClientKey(url));
  negativeCache.delete(url);
  const outcome = await refreshRow(platform, url, settings, existing, now, false, true);
  if (!outcome.ok) return { ok: false, reason: outcome.kind, detail: outcome.detail };
  return { ok: true, client: outcome.client, changedFields: changedMetadataFields(existing, outcome.client), created: existing == null };
}

/** Whether a metadata-document row is provisional: no consent reached it and the operator never fetched it by hand. */
export function isProvisionalRow (row: OAuthClient): boolean {
  return row.metadata?.firstConsentAt == null && row.metadata?.operatorRefreshedAt == null;
}

/**
 * Master sweep over the metadata-document rows:
 * - provisional rows (no consent, no operator refresh) older than
 *   `unconsentedRowSeconds` are deleted with no tombstone (`deleteClientRow`:
 *   nothing was issued for them), whatever their status;
 * - permanent rows not used for the absolute refresh lifetime (the
 *   template's, else the platform's) plus 7 days are deleted through
 *   `deleteClient` (a revoke tombstone is written: every session of theirs
 *   is dead by then); suspended ones are kept (an operator decision).
 * Returns the number of rows deleted, and how many of them were provisional.
 */
export async function pruneMetadataClients (platform: PlatformDB, config: Config, now: number = Date.now()):
Promise<{ pruned: number; provisional: number }> {
  const settings = clientMetadataSettings(config);
  const absolute = settings.client.refreshTokenAbsoluteTTL ?? (Number(config.get('oauth:refreshTokenAbsoluteTTL')) || 90 * 24 * 3600);
  const horizon = absolute * 1000 + PRUNE_EXTRA_MS;
  const provisionalHorizon = settings.unconsentedRowSeconds * 1000;
  let pruned = 0;
  let provisional = 0;
  for (const id of await storage.listClientIds(platform)) {
    if (!isMetadataClientKey(id)) continue;
    let row: OAuthClient | null;
    try { row = await storage.getClient(platform, id); } catch { continue; }
    if (row == null || row.origin !== 'metadata-document') continue;
    if (isProvisionalRow(row)) {
      if (now - (row.registeredAt ?? row.metadata?.fetchedAt ?? 0) <= provisionalHorizon) continue;
      await storage.deleteClientRow(platform, id);
      pruned++;
      provisional++;
      continue;
    }
    if ((row.status ?? 'active') !== 'active') continue;
    const lastUsed = row.metadata?.lastUsedAt ?? row.metadata?.fetchedAt ?? 0;
    if (now - lastUsed <= horizon) continue;
    await storage.deleteClient(platform, id);
    pruned++;
  }
  return { pruned, provisional };
}

/**
 * `/oauth2/authorize/accept`: the first consent a user gives a
 * metadata-document client makes its row permanent (`firstConsentAt`, one
 * write per client). Written over the row as it stands now (its status and
 * a concurrent refetch kept), skipped when the row is gone; `updatedAt`
 * unchanged. Never fails the consent.
 */
export async function recordFirstConsent (platform: PlatformDB, clientId: string, now: number = Date.now()): Promise<void> {
  if (!isMetadataClientKey(clientId)) return;
  try {
    const current = await storage.getClient(platform, clientId);
    if (current?.origin !== 'metadata-document' || current.metadata == null || current.metadata.firstConsentAt != null) return;
    await storage.setClient(platform, { ...current, metadata: { ...current.metadata, firstConsentAt: now } });
  } catch (err) {
    logServerError('client metadata: could not record the first consent of ' + clientId, err);
  }
}

/** The host a consent screen shows next to the client's name: ASCII form, and the Unicode form when it differs. */
export function metadataHostOf (url: string): { metadataHost: string; metadataHostUnicode?: string } {
  const host = new URL(url).hostname;
  const unicode = domainToUnicode(host);
  return { metadataHost: host, ...(unicode !== '' && unicode !== host ? { metadataHostUnicode: unicode } : {}) };
}

/** Tests: forget the per-core state (negative cache, budgets, in-flight fetches). */
export function _resetClientMetadataForTests (): void {
  negativeCache.clear();
  fetchTimes.length = 0;
  creationTimes.length = 0;
  hostFetchTimes.clear();
  refusalSamples.clear();
  inflight.clear();
}

export { METADATA_KEY_PREFIX };
