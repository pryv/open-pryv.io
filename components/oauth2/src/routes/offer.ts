/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — `POST /oauth2/authorize/offer` handler.
 *
 * For a registry client the signed state carries no consent offer, only its
 * digest (the offer can hold hundreds of entries, too large for a URL). The
 * consent UI posts the state here and gets the offer plus the client's
 * display fields. The offer is re-derived from the state's scope through the
 * extension's grammar and must match the digest; the same re-derivation runs
 * at /accept, so what the user saw is what gets minted.
 *
 * Unauthenticated like /oauth2/authorize: the state's HMAC bounds it.
 */

import { createRequire } from 'node:module';

import type { Request, Response } from 'express';
import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthClient } from '../storage.ts';
import type { SignedStatePayload } from '../signedState.ts';
import type { ResolvedScope } from '../scopeGrammar.ts';
const require = createRequire(import.meta.url);

const { verifyState } = require('../signedState.ts');
const { getClient, isRegistryClient } = require('../clientRegistry.ts');
const { resolveRequestedScope } = require('../scopeGrammar.ts');
const { hasSigningKeys } = require('../signingKeys.ts');

export type OfferDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
};

export type StateOffer =
  | { ok: true; client: OAuthClient; resolved: ResolvedScope }
  | { ok: false; status: number; error: string; description: string };

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
  const resolved = resolveRequestedScope(client, payload.scope.join(' '),
    { oidcEnabled: hasSigningKeys(deps.config) });
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

function sendJson (res: Response, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
