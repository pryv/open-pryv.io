/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — whole-scope grammar dispatch for registry clients.
 *
 * A registry client's `scope` string is handed whole to the extension's
 * grammar (its tokens need not carry a `<namespace>:` prefix, and may contain
 * colons in their value, so per-token dispatch through `scopeRegistry` cannot
 * work). App-account clients keep the namespaced path unchanged.
 *
 * The core owns two tokens and strips them before the grammar sees the string:
 * `openid` (id_token issuance) and `offline_access` (refresh-token issuance).
 *
 * The requested offer must stay within the client's maximum scope set (its
 * registered `scope`, parsed by the same grammar): every requested stream
 * entry needs a maximum entry on the same stream granting at least the same
 * capabilities; feature entries match by identity.
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { OAuthClient } from './storage.ts';
import type { ExtPermission, SynthOffer, OAuthExtension } from './extension.ts';
const require = createRequire(import.meta.url);

const { getExtension, toClientView } = require('./extension.ts');
const { logServerError } = require('./serverLog.ts');
const { normalizePermissions, isStreamPermission, levelCapabilityExcess, permissionKey } =
  require('business/src/accesses/permissionSet.ts');

/** Scope tokens the core owns (never handed to the grammar). */
export const CORE_SCOPE_TOKENS = ['openid', 'offline_access'];

/** Upper bound on the entries of a synthesised offer. */
export const MAX_SYNTH_ENTRIES = 1000;

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
export function resolveRequestedScope (
  client: OAuthClient,
  scopeString: string,
  opts: { oidcEnabled: boolean }
): ResolveScopeResult {
  const ext: OAuthExtension | null = getExtension();
  if (ext == null) return { ok: false, description: 'no scope grammar registered on this core' };

  const requested = splitScope(scopeString);
  const coreTokens: string[] = [];
  for (const t of CORE_SCOPE_TOKENS) {
    if (!requested.includes(t)) continue;
    if (t === 'openid' && !opts.oidcEnabled) {
      return { ok: false, description: 'openid is not available on this core (no signing key configured)' };
    }
    // Refresh tokens only for clients registered for the refresh grant.
    if (t === 'offline_access' && !(client.grantTypes ?? []).includes('refresh_token')) continue;
    coreTokens.push(t);
  }
  const rest = requested.filter((t) => !CORE_SCOPE_TOKENS.includes(t));

  const parsed = callParse(ext, client, rest.join(' '), 'request');
  if (!parsed.ok) return parsed;
  const offer = parsed.offer;
  if (offer.permissions.length === 0) {
    return { ok: false, description: 'the requested scope grants no data access' };
  }
  if (offer.permissions.length > MAX_SYNTH_ENTRIES) {
    return { ok: false, description: `the requested scope expands to more than ${MAX_SYNTH_ENTRIES} permissions` };
  }

  const max = maxSet(ext, client);
  if (max == null) return { ok: false, description: 'the client\'s registered scope cannot be parsed' };
  const outside = offer.permissions.filter((p) => !coveredBy(p, max));
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
      r.offer == null || !Array.isArray(r.offer.permissions)) {
    logServerError(`oauth extension ${ext.name}: scopeGrammar.parse answered out of contract`, new Error(JSON.stringify(out)?.slice(0, 200)));
    return { ok: false, description: 'scope could not be parsed' };
  }
  let permissions: ExtPermission[];
  try {
    permissions = normalizePermissions(r.offer.permissions, { consent: true });
  } catch (err: unknown) {
    logServerError(`oauth extension ${ext.name}: scopeGrammar.parse produced invalid permissions`, err);
    return { ok: false, description: 'scope could not be parsed' };
  }
  const offer: SynthOffer = { ...(r.offer as SynthOffer), permissions, randomAlias: (r.offer as SynthOffer).randomAlias === true };
  return { ok: true, tokens: r.tokens as string[], offer };
}

function maxSet (ext: OAuthExtension, client: OAuthClient): ExtPermission[] | null {
  const key = ext.name + '|' + client.clientId + '|' + String(client.updatedAt);
  const cached = maxSetCache.get(key);
  if (cached != null) return cached;
  const scope = (client.scope ?? []).filter((t) => !CORE_SCOPE_TOKENS.includes(t));
  const parsed = callParse(ext, client, scope.join(' '), 'max');
  if (!parsed.ok) {
    logServerError(`oauth client ${client.clientId}: registered scope rejected by the grammar`, new Error(parsed.description));
    return null;
  }
  if (maxSetCache.size >= MAX_SET_CACHE_SIZE) maxSetCache.clear();
  maxSetCache.set(key, parsed.offer.permissions);
  return parsed.offer.permissions;
}

function coveredBy (p: ExtPermission, max: ExtPermission[]): boolean {
  if (isStreamPermission(p)) {
    return max.some((m) => isStreamPermission(m) && m.streamId === p.streamId &&
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

function canonicalJson (v: unknown): string {
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
 * and the `scopeTokens` of every response hook.
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
  return [...new Set([...coreTokens, ...echoed])];
}

/** Test-only — drop memoised maximum scope sets. */
export function _resetForTests (): void {
  maxSetCache.clear();
}
