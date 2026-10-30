/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: whole-scope grammar dispatch for registry clients.
 *
 * A registry client's `scope` string is handed whole to the extension's
 * grammar (its tokens need not carry a `<namespace>:` prefix, and may contain
 * colons in their value, so per-token dispatch through `scopeRegistry` cannot
 * work). App-account clients keep the namespaced path unchanged.
 *
 * The core owns two tokens and strips them before the grammar sees the string:
 * `openid` (reserved: not available on this core, refused) and
 * `offline_access` (refresh-token issuance).
 *
 * The requested offer must stay within the client's maximum scope set (its
 * registered `scope`, parsed by the same grammar): every requested stream
 * entry needs a maximum entry on the same stream granting at least the same
 * capabilities; feature entries match by identity.
 *
 * Whatever the grammar answers, the core refuses (both in the requested offer
 * and in the maximum set) account and system streams, every stream (`*`) and
 * the `manage` level, and two entries on one stream in a requested offer:
 * see `callParse`.
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { OAuthClient } from './storage.ts';
import type { ExtPermission, SynthOffer, OAuthExtension } from './extension.ts';
const require = createRequire(import.meta.url);

const { getExtension, toClientView, extensionGeneration } = require('./extension.ts');
const { logServerError } = require('./serverLog.ts');
const { normalizePermissions, isStreamPermission, levelCapabilityExcess, permissionKey } =
  require('business/src/accesses/permissionSet.ts');
const { canonicalStreamId, parseStoreIdAndStoreItemId, AccountStoreId } =
  require('mall/src/helpers/storeDataUtils.ts');

/** Scope tokens the core owns (never handed to the grammar). */
export const CORE_SCOPE_TOKENS = ['openid', 'offline_access'];

/** Upper bound on the entries of a synthesised offer. */
export const MAX_SYNTH_ENTRIES = 1000;

/**
 * Whether this core can serve pseudonymous subjects (a `pairwise` client, or
 * an offer asking for a pseudonym). Not yet: such requests are refused at
 * /oauth2/authorize (and wherever the offer is re-derived). The single switch
 * every reader keys off.
 */
export const PSEUDONYM_SUBJECTS_AVAILABLE: boolean = false;

/** Refusal of every pseudonymous subject while they are not available. */
export const PSEUDONYM_REFUSED = 'pseudonymous subjects are not available on this core';

export type ResolvedScope = {
  ok: true;
  /** The request's tokens, de-duplicated, as presented (the signed state carries these). */
  requested: string[];
  /** Core tokens requested and allowed for this client. */
  coreTokens: string[];
  /** The grammar's own tokens (handed back to `echo`). */
  grammarTokens: string[];
  offer: SynthOffer;
  /** Pins the offer between /authorize and /accept. */
  digest: string;
};

export type ResolveScopeResult = ResolvedScope | { ok: false; description: string };

const maxSetCache = new Map<string, ExtPermission[]>();
const MAX_SET_CACHE_SIZE = 500;

/** Split a scope string into de-duplicated tokens, order kept. */
export function splitScope (scopeString: string): string[] {
  if (typeof scopeString !== 'string') return [];
  return [...new Set(scopeString.split(/\s+/).filter((t) => t.length > 0))];
}

/**
 * Resolve a registry client's requested scope into a synthesised consent
 * offer. Never throws for a client error; a grammar that throws or answers
 * out of contract is logged and reported as `invalid_scope`.
 */
export function resolveRequestedScope (client: OAuthClient, scopeString: string): ResolveScopeResult {
  const ext: OAuthExtension | null = getExtension();
  if (ext == null) return { ok: false, description: 'no scope grammar registered on this core' };

  // Pseudonymous subjects (a pairwise client, or an offer asking for one)
  // are refused until a session can carry the grant's alias everywhere.
  if (!PSEUDONYM_SUBJECTS_AVAILABLE && client.subjectType === 'pairwise') {
    return { ok: false, description: PSEUDONYM_REFUSED };
  }

  const requested = splitScope(scopeString);
  const coreTokens: string[] = [];
  for (const t of CORE_SCOPE_TOKENS) {
    if (!requested.includes(t)) continue;
    if (t === 'openid') return { ok: false, description: 'openid is not available on this core' };
    // Refresh tokens only for clients registered for the refresh grant.
    if (t === 'offline_access' && !(client.grantTypes ?? []).includes('refresh_token')) continue;
    coreTokens.push(t);
  }
  const rest = requested.filter((t) => !CORE_SCOPE_TOKENS.includes(t));

  const parsed = callParse(ext, client, rest.join(' '), 'request');
  if (!parsed.ok) return parsed;
  const offer = parsed.offer;
  if (!PSEUDONYM_SUBJECTS_AVAILABLE && offer.randomAlias === true) {
    return { ok: false, description: PSEUDONYM_REFUSED };
  }
  // A pairwise client always gets the grant's alias as the subject; decided
  // here so the consent shows it and the digest pins it.
  if (client.subjectType === 'pairwise') offer.randomAlias = true;
  if (offer.permissions.length === 0) {
    return { ok: false, description: 'the requested scope grants no data access' };
  }
  if (offer.permissions.length > MAX_SYNTH_ENTRIES) {
    return { ok: false, description: `the requested scope expands to more than ${MAX_SYNTH_ENTRIES} permissions` };
  }

  const max = maxSet(ext, client);
  if (!max.ok) return { ok: false, description: 'the client\'s registered scope ' + max.description };
  const outside = offer.permissions.filter((p) => !coveredBy(p, max.permissions));
  if (outside.length > 0) {
    return {
      ok: false,
      description: 'client is not registered for the requested scope (' + outside.length + ' permission(s) beyond its maximum scope set)',
    };
  }

  return {
    ok: true,
    requested,
    coreTokens,
    grammarTokens: parsed.tokens,
    offer,
    digest: offerDigest(ext, client, offer),
  };
}

/**
 * Parse a registry client's maximum scope set (its registered `scope`). Used
 * at /authorize (memoised) and by the boot pass over registry rows.
 */
export function checkMaxSet (client: OAuthClient): { ok: true; permissions: ExtPermission[] } | { ok: false; description: string } {
  const ext: OAuthExtension | null = getExtension();
  if (ext == null) return { ok: false, description: 'cannot be read: no scope grammar registered on this core' };
  return maxSet(ext, client);
}

function callParse (
  ext: OAuthExtension, client: OAuthClient, scopeString: string, purpose: 'request' | 'max'
): { ok: true; tokens: string[]; offer: SynthOffer } | { ok: false; description: string } {
  let out: unknown;
  try {
    out = ext.scopeGrammar.parse(scopeString, { client: toClientView(client), purpose });
  } catch (err: unknown) {
    logServerError(`oauth extension ${ext.name}: scopeGrammar.parse threw`, err);
    return { ok: false, description: 'scope could not be parsed' };
  }
  const r = out as { ok?: unknown; tokens?: unknown; offer?: { permissions?: unknown }; description?: unknown } | null;
  if (r?.ok === false) {
    return { ok: false, description: typeof r.description === 'string' ? r.description : 'invalid scope' };
  }
  if (r?.ok !== true || !Array.isArray(r.tokens) || r.tokens.some((t) => typeof t !== 'string') ||
      r.offer == null || typeof r.offer !== 'object' || !Array.isArray(r.offer.permissions)) {
    logServerError(`oauth extension ${ext.name}: scopeGrammar.parse answered out of contract`, new Error(String(JSON.stringify(out)).slice(0, 200)));
    return { ok: false, description: 'scope could not be parsed' };
  }
  // Display names would make the consent create missing streams under the
  // user's personal context: never taken from a grammar.
  const raw = (r.offer.permissions as unknown[]).map((p) => {
    if (p == null || typeof p !== 'object' || (!('defaultName' in p) && !('name' in p))) return p;
    const { defaultName: _d, name: _n, ...rest } = p as Record<string, unknown>;
    return rest;
  });
  if (raw.some((p, i) => p !== (r.offer as { permissions: unknown[] }).permissions[i])) {
    logServerError(`oauth extension ${ext.name}: scopeGrammar.parse set defaultName / name on a permission (${purpose}); removed`,
      new Error('contract error: defaultName / name'));
  }
  let permissions: ExtPermission[];
  try {
    permissions = normalizePermissions(raw, { consent: true });
  } catch (err: unknown) {
    logServerError(`oauth extension ${ext.name}: scopeGrammar.parse produced invalid permissions`, err);
    return { ok: false, description: 'scope could not be parsed' };
  }
  const seen = new Set<string>();
  for (const p of permissions) {
    const refused = refusedPermission(p);
    if (refused != null) {
      logServerError(`oauth extension ${ext.name}: scopeGrammar.parse offered a refused permission (${purpose})`, new Error(refused));
      return { ok: false, description: refused };
    }
    // One entry per stream in an offer (the maximum set is a list of
    // ceilings, where several entries on one stream are harmless).
    if (purpose === 'request' && isStreamPermission(p)) {
      const id: string = canonicalStreamId(String(p.streamId));
      if (seen.has(id)) {
        // The detail (which stream) goes to the server trail only: the
        // description reaches the app on the error redirect.
        logServerError(`oauth extension ${ext.name}: contract error in scopeGrammar.parse (${purpose})`,
          new Error(`stream ${String(p.streamId)} appears more than once in the synthesised permissions`));
        return { ok: false, description: 'conflicting permissions on a requested resource' };
      }
      seen.add(id);
    }
  }
  const offer: SynthOffer = { ...(r.offer as SynthOffer), permissions, randomAlias: (r.offer as SynthOffer).randomAlias === true };
  return { ok: true, tokens: r.tokens as string[], offer };
}

/**
 * Core guard on every synthesised permission, whatever the grammar answers:
 * a registry client never gets an account or system stream (any core-reserved
 * `:_<namespace>:` stream, `:system:` fields, the account store; judged on
 * the canonical id, so `:local::system:email` or `:account::system:email` are
 * caught), nor every stream (`*`, `:local:`), nor the `manage` level (it
 * lets the holder create accesses and change streams). Feature permissions
 * are not concerned. Returns the refusal description, null when acceptable.
 */
export function refusedPermission (p: ExtPermission): string | null {
  if (!isStreamPermission(p)) return null;
  const raw = String(p.streamId);
  if (p.level === 'manage') return `level manage is not available to this client (stream ${raw})`;
  const id: string = canonicalStreamId(raw);
  if (id === '*') return 'a permission on every stream (' + raw + ') is not available to this client';
  if (id.startsWith(':_') || id.startsWith(':system:') ||
      parseStoreIdAndStoreItemId(id)[0] === AccountStoreId) {
    return `stream ${raw} is an account or system stream, not available to this client`;
  }
  return null;
}

function maxSet (ext: OAuthExtension, client: OAuthClient): { ok: true; permissions: ExtPermission[] } | { ok: false; description: string } {
  const key = String(extensionGeneration()) + '|' + client.clientId + '|' + String(client.updatedAt);
  const cached = maxSetCache.get(key);
  if (cached != null) return { ok: true, permissions: cached };
  const scope = (client.scope ?? []).filter((t) => !CORE_SCOPE_TOKENS.includes(t));
  const parsed = callParse(ext, client, scope.join(' '), 'max');
  if (!parsed.ok) {
    logServerError(`oauth client ${client.clientId}: registered scope rejected`, new Error(parsed.description));
    return { ok: false, description: 'is refused: ' + parsed.description };
  }
  if (maxSetCache.size >= MAX_SET_CACHE_SIZE) maxSetCache.clear();
  maxSetCache.set(key, parsed.offer.permissions);
  return { ok: true, permissions: parsed.offer.permissions };
}

function coveredBy (p: ExtPermission, max: ExtPermission[]): boolean {
  if (isStreamPermission(p)) {
    // Same stream in any spelling (`a` and `:local:a`).
    const id: string = canonicalStreamId(String(p.streamId));
    return max.some((m) => isStreamPermission(m) && canonicalStreamId(String(m.streamId)) === id &&
      levelCapabilityExcess(p.level, m.level).length === 0);
  }
  const k = permissionKey(p);
  return max.some((m) => permissionKey(m) === k);
}

/** Digest of what the consent shows: grammar identity, client version, offer. */
export function offerDigest (ext: OAuthExtension, client: OAuthClient, offer: SynthOffer): string {
  const canonical = canonicalJson({ grammar: ext.name, apiVersion: ext.apiVersion, clientUpdatedAt: client.updatedAt, offer });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

export function canonicalJson (v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v != null && typeof v === 'object') {
    const keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * The tokens a grant honestly covers: core tokens granted plus the grammar's
 * echo over the permissions actually minted. This is the RFC `scope` answer
 * and the `scopeTokens` of every response hook. The echo may only answer
 * tokens the client requested: anything else is an extension error (thrown,
 * the caller answers `server_error`), so a scope the user never saw is never
 * reported as granted.
 */
export function grantedScopeTokens (
  client: OAuthClient,
  coreTokens: string[],
  grammarTokens: string[],
  permissions: ExtPermission[]
): string[] {
  const ext: OAuthExtension | null = getExtension();
  if (ext == null) throw new Error('no scope grammar registered on this core');
  const echoed = ext.scopeGrammar.echo({ permissions, requestedTokens: grammarTokens, client: toClientView(client) });
  if (!Array.isArray(echoed) || echoed.some((t) => typeof t !== 'string')) {
    throw new Error(`oauth extension ${ext.name}: scopeGrammar.echo must return an array of strings`);
  }
  const requested = new Set(grammarTokens);
  const outside = echoed.filter((t) => !requested.has(t));
  if (outside.length > 0) {
    throw new Error(`oauth extension ${ext.name}: scopeGrammar.echo answered token(s) the client did not request: ${outside.slice(0, 5).join(' ')}`);
  }
  return [...new Set([...coreTokens, ...echoed])];
}

/** Test-only: drop memoised maximum scope sets. */
export function _resetForTests (): void {
  maxSetCache.clear();
}
