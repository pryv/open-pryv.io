/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: `POST /oauth2/revoke` (RFC 7009), a client revoking its own token.
 *
 * The client authenticates as at the token endpoint (a public client names
 * itself with `client_id`). The token is looked up as an access token (the
 * session index) and as a refresh token (this core's rows, then the other
 * cores'), in the order `token_type_hint` suggests. Revoking either token of
 * a refresh chain ends that chain (its session and its refresh token); the
 * consent grant and the chains of other devices or launches of the same
 * client stay:
 *
 *   - access token: its session is deleted through the accesses.delete
 *     teardown, which also ends the session's refresh chain;
 *   - refresh token: the token is ended (removed, marked revoked), then the
 *     session it currently backs is deleted the same way. A refresh token
 *     issued before refresh rows named their session ends alone; its session
 *     lives out its own lifetime.
 *
 * Withdrawing the consent itself is the user's act (from the account), or the
 * server's on refresh-token reuse (theft evidence), never a revocation.
 *
 * An unknown token, a token issued to another client, or one already ended
 * answers 200 like a revoked one (no oracle). A token whose session or chain
 * lives on another core answers 421 with that core's URL: only the home core
 * can delete what lives in its storage.
 */

import type { Request, Response } from 'express';
import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import * as storage from './storage.ts';
import { getClient } from './clientRegistry.ts';
import { authenticateClient } from './clientSecret.ts';
import { decodeBasicAuth, clientIdFromAssertion } from './clientAuth.ts';
import { clientKeyOf } from './clientMetadataId.ts';
import { reportClientAuthRefusal } from './clientMetadata.ts';
import { issuerFromConfig } from './issuer.ts';
import { logServerError } from './serverLog.ts';
import { audit } from './audit.ts';

/** Delete a session of the client on this core; resolves to whether one was deleted. */
export type RevokeSession = (params: { userId: string; accessId: string; clientId: string }) => Promise<boolean>;

export type RevocationDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
  revokeSession: RevokeSession;
  /** Public URL of a core, for the wrong-core answer. */
  coreUrlFor?: (coreId: string) => string | Promise<string>;
};

type Outcome = { kind: 'none' } | { kind: 'done' } | { kind: 'wrong-core'; coreId: string };

export function handleRevoke (deps: RevocationDeps) {
  return async function revoke (req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const basic = decodeBasicAuth(req.headers?.authorization);
    const bodyClientId = typeof body.client_id === 'string' ? body.client_id : '';
    // Next to a client_assertion, client_id is optional (RFC 7523 §3): the
    // assertion's iss names the client, authenticated below as any other.
    // A metadata-document client names itself by its URL (body or assertion):
    // its row key here.
    const clientId = basic?.client_id ?? clientKeyOf(bodyClientId !== ''
      ? bodyClientId
      : clientIdFromAssertion(body.client_assertion, body.client_assertion_type) ?? '');
    const refuse = async (): Promise<void> => {
      await reportClientAuthRefusal(deps.platform, clientId, 'revoke');
      sendJson(res, 401, { error: 'invalid_client', error_description: 'client authentication failed' },
        basic != null ? { 'WWW-Authenticate': 'Basic realm="oauth2"' } : {});
    };
    if (clientId === '' || (basic != null && bodyClientId !== '' && bodyClientId !== basic.client_id)) return refuse();
    const client = await getClient(deps.platform, clientId);
    if (client == null) return refuse();
    const issuer = issuerFromConfig(deps.config);
    const auth = await authenticateClient({
      client,
      clientId,
      presentedSecret: basic?.client_secret ?? (typeof body.client_secret === 'string' ? body.client_secret : undefined),
      assertion: typeof body.client_assertion === 'string' ? body.client_assertion : undefined,
      assertionType: typeof body.client_assertion_type === 'string' ? body.client_assertion_type : undefined,
      platform: deps.platform,
      expectedAudiences: [issuer, issuer + '/oauth2/revoke', issuer + '/oauth2/token'],
    });
    if (!auth.ok) return refuse();
    if (typeof body.token !== 'string' || body.token.length === 0) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'token is required' });
    }
    const token = body.token;
    const lookups = body.token_type_hint === 'refresh_token'
      ? [revokeRefreshToken, revokeAccessToken]
      : [revokeAccessToken, revokeRefreshToken];
    for (const lookup of lookups) {
      const outcome = await lookup(deps, clientId, token);
      if (outcome.kind === 'none') continue;
      if (outcome.kind === 'wrong-core' && typeof deps.coreUrlFor === 'function') {
        return sendJson(res, 421, { error: 'wrong_core', coreUrl: await deps.coreUrlFor(outcome.coreId) });
      }
      break;
    }
    res.statusCode = 200;
    res.setHeader('Cache-Control', 'no-store');
    res.end();
  };
}

function thisCore (deps: RevocationDeps): string {
  return String(deps.config.get('core:id') ?? 'single');
}

async function revokeAccessToken (deps: RevocationDeps, clientId: string, token: string): Promise<Outcome> {
  const row = await storage.getSessionIndex(deps.platform, token);
  if (row == null) return { kind: 'none' };
  // Another client's token: answered like an unknown one, nothing done.
  if (row.clientId !== clientId) return { kind: 'done' };
  if (row.coreId !== thisCore(deps)) return { kind: 'wrong-core', coreId: row.coreId };
  const deleted = await deps.revokeSession({ userId: row.userId, accessId: row.accessId, clientId });
  if (deleted) {
    await audit('oauth.token.revoked', {
      clientId, userId: row.userId, accessId: row.accessId, reason: 'access token revoked by the client',
    });
  } else {
    // The session is already gone: still end what the index row names.
    try {
      if (typeof row.refreshTokenHash === 'string') await storage.revokeRefreshByHash(deps.platform, row.coreId, row.refreshTokenHash);
      await storage.deleteSessionIndex(deps.platform, token);
    } catch (err: unknown) {
      logServerError('revoke: ending the chain of a gone session failed', err);
    }
  }
  return { kind: 'done' };
}

async function revokeRefreshToken (deps: RevocationDeps, clientId: string, token: string): Promise<Outcome> {
  const self = thisCore(deps);
  const found = await storage.findRefreshCore(deps.platform, token, [self, ...await otherCoreIds(deps.platform, self)]);
  if (found == null) return { kind: 'none' };
  if (found.row.clientId !== clientId) return { kind: 'done' };
  if (found.coreId !== self) return { kind: 'wrong-core', coreId: found.coreId };
  const row = await storage.revokeRefresh(deps.platform, self, token);
  // Rotated or revoked meanwhile: nothing left to end.
  if (row == null) return { kind: 'done' };
  let accessId: string | undefined;
  if (typeof row.accessId === 'string') {
    try {
      // Its own refresh chain is already ended above (the teardown's chain
      // end then finds the revoked marker and changes nothing).
      if (await deps.revokeSession({ userId: row.userId, accessId: row.accessId, clientId })) accessId = row.accessId;
    } catch (err: unknown) {
      // The token itself is ended; the session dies with its own lifetime.
      logServerError('revoke: deleting the session of the revoked refresh token failed', err);
    }
  }
  await audit('oauth.token.revoked', {
    clientId, userId: row.userId, ...(accessId != null ? { accessId } : {}), reason: 'refresh token revoked by the client',
  });
  return { kind: 'done' };
}

/** The other cores' ids (refresh rows are keyed by their issuing core). */
async function otherCoreIds (platform: PlatformDB, self: string): Promise<string[]> {
  if (typeof platform.getAllCoreInfos !== 'function') return [];
  try {
    const cores = await platform.getAllCoreInfos();
    return (cores ?? []).map((c) => c?.id).filter((id): id is string => typeof id === 'string' && id.length > 0 && id !== self);
  } catch (err: unknown) {
    logServerError('revoke: listing the cores failed (only this core\'s refresh tokens are found)', err);
    return [];
  }
}

function sendJson (res: Response, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}
