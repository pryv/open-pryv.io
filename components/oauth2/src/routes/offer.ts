/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: `POST /oauth2/authorize/offer` handler.
 *
 * For a registry client the signed state carries no consent offer, only its
 * digest (the offer can hold hundreds of entries, too large for a URL). The
 * consent UI posts the state here and gets the offer plus the client's
 * display fields. The offer is re-derived from the state's scope through the
 * extension's grammar and must match the digest; the same re-derivation runs
 * at /accept, so what the user saw is what gets minted.
 *
 * Unauthenticated like /oauth2/authorize: the state's HMAC bounds it. The
 * re-derivation is memoised per state (bounded, for the state's lifetime), so
 * replaying one valid state does not run the grammar again.
 */

import crypto from 'node:crypto';

import type { Request, Response } from 'express';
import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthClient } from '../storage.ts';
import type { SignedStatePayload } from '../signedState.ts';
import type { ResolvedScope } from '../scopeGrammar.ts';
import { verifyState } from '../signedState.ts';
import { getClient, isRegistryClient } from '../clientRegistry.ts';
import { resolveRequestedScope } from '../scopeGrammar.ts';
import { extensionGeneration } from '../extension.ts';

export type OfferDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
};

export type StateOffer =
  | { ok: true; client: OAuthClient; resolved: ResolvedScope }
  | { ok: false; status: number; error: string; description: string };

/** Bound on the memoised re-derivations (one per live state). */
export const OFFER_CACHE_SIZE = 1000;

type CacheEntry = { resolved: ResolvedScope; expiresAt: number };
const offerCache = new Map<string, CacheEntry>();

function cacheKey (payload: SignedStatePayload, client: OAuthClient): string {
  // The installed grammar, the digest, the scope and the client version
  // together name one re-derivation; a client edit (new `updatedAt`) or
  // another grammar never hits an old entry.
  return crypto.createHash('sha256')
    .update(JSON.stringify([extensionGeneration(), payload.clientId, String(client.updatedAt), payload.scope, payload.offerRef?.digest]))
    .digest('base64url');
}

function cacheGet (key: string): ResolvedScope | null {
  const entry = offerCache.get(key);
  if (entry == null) return null;
  if (entry.expiresAt <= Date.now()) {
    offerCache.delete(key);
    return null;
  }
  // Least recently used goes first: re-insert on hit.
  offerCache.delete(key);
  offerCache.set(key, entry);
  return entry.resolved;
}

function cacheSet (key: string, resolved: ResolvedScope, expiresAt: number): void {
  offerCache.delete(key);
  offerCache.set(key, { resolved, expiresAt });
  while (offerCache.size > OFFER_CACHE_SIZE) {
    const oldest = offerCache.keys().next().value;
    if (oldest === undefined) break;
    offerCache.delete(oldest);
  }
}

/**
 * Re-derive the synthesised offer a state points at. Refuses a suspended or
 * unknown client and a digest mismatch (the client or the grammar changed
 * since /authorize: the user must restart).
 */
export async function resolveStateOffer (
  deps: OfferDeps, payload: SignedStatePayload
): Promise<StateOffer> {
  if (payload.offerRef?.kind !== 'synthesised') {
    return { ok: false, status: 400, error: 'invalid_request', description: 'signed state carries no offer reference' };
  }
  const client = await getClient(deps.platform, payload.clientId);
  if (client == null || !isRegistryClient(client)) {
    return { ok: false, status: 400, error: 'invalid_request', description: 'unknown client' };
  }
  if (client.status === 'suspended') {
    return { ok: false, status: 403, error: 'access_denied', description: 'this client is suspended' };
  }
  const key = cacheKey(payload, client);
  const cached = cacheGet(key);
  if (cached != null) return { ok: true, client, resolved: cached };
  const resolved = resolveRequestedScope(client, payload.scope.join(' '));
  if (!resolved.ok) {
    return { ok: false, status: 400, error: 'invalid_scope', description: resolved.description };
  }
  if (resolved.digest !== payload.offerRef.digest) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_request',
      description: 'the consent request changed since it was issued, restart the authorization flow',
    };
  }
  // `exp` is in seconds (the state's own lifetime).
  cacheSet(key, resolved, payload.exp * 1000);
  return { ok: true, client, resolved };
}

export function handleOffer (deps: OfferDeps) {
  return async function offer (req: Request, res: Response): Promise<void> {
    const adminKey = String(deps.config.get('auth:adminAccessKey') ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.state !== 'string' || body.state.length === 0) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'state is required' });
    }
    const verified = verifyState(adminKey, body.state);
    if (!verified.ok) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: `signed state ${verified.reason}` });
    }
    const r = await resolveStateOffer(deps, verified.payload);
    if (!r.ok) return sendJson(res, r.status, { error: r.error, error_description: r.description });
    const c = r.client;
    return sendJson(res, 200, {
      client: {
        clientId: c.clientId,
        clientName: c.clientName,
        logoUri: c.logoUri,
        clientUri: c.clientUri,
        policyUri: c.policyUri,
        tosUri: c.tosUri,
      },
      offer: { allowUserChoice: false, ...r.resolved.offer },
      scope: r.resolved.requested,
    });
  };
}

/** Test-only: empty the memoised re-derivations. */
export function _resetForTests (): void {
  offerCache.clear();
}

function sendJson (res: Response, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
