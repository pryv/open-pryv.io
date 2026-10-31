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
 *
 * Signed in (optional `username` + `userToken`, the owner's personal token):
 * the answer is the consent screen composed with the user's current grant
 * (`offer` entries flagged `currentlyGranted`), with `shownDigest` (to post
 * back at /accept), `currentGrant: { subjectMode } | null` and
 * `subjectChange`; never memoised. A token that does not sign in answers the
 * request alone, plus `authenticated: false`.
 */

import crypto from 'node:crypto';

import type { Request, Response } from 'express';
import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthClient } from '../storage.ts';
import type { SignedStatePayload } from '../signedState.ts';
import type { ResolvedScope } from '../scopeGrammar.ts';
import { verifyState, stateKeyFromConfig } from '../signedState.ts';
import { hasSigningKeys } from '../signingKeys.ts';
import { getClient, isRegistryClient } from '../clientRegistry.ts';
import { resolveRequestedScope } from '../scopeGrammar.ts';
import { extensionGeneration } from '../extension.ts';
import type { CurrentGrant } from '../consentComposition.ts';
import { composeShownOffer, subjectModeOf } from '../consentComposition.ts';

/** A signed-in user, as the host app's resolver answers it. */
export type OfferSession = {
  userId: string;
  username: string;
  /** The token is a personal one (only those may see the user's grants). */
  personal?: boolean;
  /** Host-app data piggybacked (e.g. the MethodContext). */
  _context?: unknown;
};

export type OfferDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
  /** Optional sign-in for the composed answer (same resolver as /accept). */
  resolveUser?: (params: { username: string; userToken: string }) =>
  Promise<OfferSession | { refused: true; description: string } | null>;
  /** The user's current grant for the client, or null. */
  readRegistryGrant?: (params: { session: OfferSession; clientId: string }) => Promise<CurrentGrant | null>;
};

export type StateOffer =
  | { ok: true; client: OAuthClient; resolved: ResolvedScope }
  | { ok: false; status: number; error: string; description: string };

/** Bound on the memoised re-derivations (one per live state). */
export const OFFER_CACHE_SIZE = 1000;

type CacheEntry = { resolved: ResolvedScope; expiresAt: number };
const offerCache = new Map<string, CacheEntry>();

function cacheKey (payload: SignedStatePayload, client: OAuthClient, oidcEnabled: boolean): string {
  // The installed grammar, the digest, the scope and the client version
  // together name one re-derivation; a client edit (new `updatedAt`) or
  // another grammar never hits an old entry.
  return crypto.createHash('sha256')
    .update(JSON.stringify([extensionGeneration(), oidcEnabled, payload.clientId, String(client.updatedAt), payload.scope, payload.offerRef?.digest]))
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
  const oidcEnabled = hasSigningKeys(deps.config);
  const key = cacheKey(payload, client, oidcEnabled);
  const cached = cacheGet(key);
  if (cached != null) return { ok: true, client, resolved: cached };
  const resolved = resolveRequestedScope(client, payload.scope.join(' '), { oidcEnabled });
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

/**
 * The signed-in user behind an optional `username` + `userToken` pair: the
 * session of a valid PERSONAL token, else null (any failure, a refused or a
 * non-personal token alike: no oracle beyond what /accept already gives).
 */
async function personalSession (deps: OfferDeps, body: Record<string, unknown>): Promise<OfferSession | null> {
  if (deps.resolveUser == null) return null;
  if (typeof body.username !== 'string' || body.username.length === 0 ||
      typeof body.userToken !== 'string' || body.userToken.length === 0) return null;
  let s: OfferSession | { refused: true } | null;
  try {
    s = await deps.resolveUser({ username: body.username, userToken: body.userToken });
  } catch {
    return null;
  }
  if (s == null || (s as { refused?: unknown }).refused === true) return null;
  const session = s as OfferSession;
  return session.personal === true ? session : null;
}

export function handleOffer (deps: OfferDeps) {
  return async function offer (req: Request, res: Response): Promise<void> {
    const stateKey = stateKeyFromConfig(deps.config);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.state !== 'string' || body.state.length === 0) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'state is required' });
    }
    const verified = verifyState(stateKey, body.state);
    if (!verified.ok) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: `signed state ${verified.reason}` });
    }
    const r = await resolveStateOffer(deps, verified.payload);
    if (!r.ok) return sendJson(res, r.status, { error: r.error, error_description: r.description });
    const c = r.client;
    const answer: Record<string, unknown> = {
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
    };
    const signInAttempted = body.username !== undefined || body.userToken !== undefined;
    if (!signInAttempted) return sendJson(res, 200, answer);

    // Signed in: the composition of the user's current grant and the request
    // (what /accept will check a `shownDigest` against). Never memoised.
    const session = await personalSession(deps, body);
    if (session == null) return sendJson(res, 200, { ...answer, authenticated: false });
    const current = deps.readRegistryGrant != null
      ? await deps.readRegistryGrant({ session, clientId: c.clientId })
      : null;
    const composition = composeShownOffer(r.resolved, current, c);
    if (!composition.ok) {
      return sendJson(res, 400, {
        error: 'invalid_scope',
        error_description: 'conflicting permission level on a requested resource: ' + composition.error.message,
        reason: 'permission-level-conflict',
      });
    }
    return sendJson(res, 200, {
      ...answer,
      authenticated: true,
      offer: composition.shown,
      shownDigest: composition.shownDigest,
      currentGrant: current == null ? null : { subjectMode: subjectModeOf(current.aliased) },
      subjectChange: composition.subjectChange,
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
