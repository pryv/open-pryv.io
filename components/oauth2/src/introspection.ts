/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: `POST /oauth2/introspect` (RFC 7662).
 *
 * Every OAuth session token is indexed at mint time (`oauth-at/<sha256>`,
 * replicated, no token / username / alias in the row, see sessionIndex.ts),
 * so a resource server can ask any core whether a token is active. The caller
 * is a CONFIDENTIAL client registered with `canIntrospect` and not suspended;
 * any other caller is refused with one uniform 401. A token whose session
 * lives on another core answers 421 with that core's URL (no forwarding). The
 * home core re-reads the session: deleted, expired, client revoked after the
 * session was minted, client suspended or gone, or consent grant gone, means
 * `active: false`.
 *
 * Beyond the RFC members, an active answer carries `api_base` (the account's
 * API base URL, no credential in it) and, for a registry client's session,
 * `permissions` (the stream permissions the session holds now, as the core
 * enforces them): extension members, answered only to the confidential
 * callers above, never in a token response.
 */

import type { Request, Response } from 'express';
import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthClient, OAuthSessionIndex } from './storage.ts';
import type { HookCtx, ExtPermission } from './extension.ts';
import * as storage from './storage.ts';
import { getClient, isRegistryClient } from './clientRegistry.ts';
import { authenticateClient } from './clientSecret.ts';
import { decodeBasicAuth } from './clientAuth.ts';
import { issuerFromConfig } from './issuer.ts';
import { grantedScopeTokens } from './scopeGrammar.ts';
import { runHook, toClientView } from './extension.ts';
import { logServerError } from './serverLog.ts';
import { audit } from './audit.ts';

/** The session as the home core sees it; null when not live. */
export type IntrospectAccess = (params: {
  userId: string; accessId: string; clientId: string; dataGrantAccessId?: string;
}) => Promise<{
  permissions: ExtPermission[];
  created: number; // seconds
  expires: number; // seconds
  subject: string | null;
  /** The account's API base URL, no credential in it (alias-based when the grant is aliased). */
  apiBase?: string;
  dpopJkt?: string;
} | null>;

export type IntrospectDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
  introspectAccess: IntrospectAccess;
  /** Public URL of a core, for the wrong-core answer. */
  coreUrlFor?: (coreId: string) => string | Promise<string>;
};

const INACTIVE = { active: false };

/** A client that authenticates (secret or key on file). */
export function isConfidentialClient (client: OAuthClient | null | undefined): boolean {
  return client != null && (
    (typeof client.clientSecretHash === 'string' && client.clientSecretHash.length > 0) ||
    (client.jwks != null && Array.isArray(client.jwks.keys) && client.jwks.keys.length > 0));
}

export function handleIntrospect (deps: IntrospectDeps) {
  return async function introspect (req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const basic = decodeBasicAuth(req.headers?.authorization);
    const bodyClientId = typeof body.client_id === 'string' ? body.client_id : '';
    const clientId = basic?.client_id ?? bodyClientId;
    // Uniform refusal: unknown, public, not allowed, suspended, or bad credentials.
    const refuse = (): void => sendJson(res, 401, { error: 'invalid_client', error_description: 'client authentication failed' },
      { 'WWW-Authenticate': 'Basic realm="oauth2"' });
    if (clientId === '' || (basic != null && bodyClientId !== '' && bodyClientId !== basic.client_id)) return refuse();
    const caller = await getClient(deps.platform, clientId);
    if (caller == null || !isConfidentialClient(caller) || caller.canIntrospect !== true || caller.status === 'suspended') {
      return refuse();
    }
    const issuer = issuerFromConfig(deps.config);
    const auth = await authenticateClient({
      client: caller,
      clientId,
      presentedSecret: basic?.client_secret ?? (typeof body.client_secret === 'string' ? body.client_secret : undefined),
      assertion: typeof body.client_assertion === 'string' ? body.client_assertion : undefined,
      assertionType: typeof body.client_assertion_type === 'string' ? body.client_assertion_type : undefined,
      platform: deps.platform,
      expectedAudiences: [issuer, issuer + '/oauth2/introspect', issuer + '/oauth2/token'],
    });
    if (!auth.ok) return refuse();

    if (typeof body.token !== 'string' || body.token.length === 0) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'token is required' });
    }
    const answer = await introspectToken(deps, body.token, issuer);
    await audit('oauth.token.introspected', {
      clientId,
      active: answer.body.active === true,
      ...(answer.trail ?? {}),
    });
    return sendJson(res, answer.status, answer.body);
  };
}

type Answer = {
  status: number;
  body: Record<string, unknown>;
  /** What the audit row adds (never the token). */
  trail?: { userId?: string; tokenClientId?: string; reason?: string };
};

async function introspectToken (deps: IntrospectDeps, token: string, issuer: string): Promise<Answer> {
  const row: OAuthSessionIndex | null = await storage.getSessionIndex(deps.platform, token);
  if (row == null) return { status: 200, body: INACTIVE };
  const coreId = String(deps.config.get('core:id') ?? 'single');
  if (row.coreId !== coreId) {
    if (typeof deps.coreUrlFor !== 'function') return { status: 200, body: INACTIVE };
    return { status: 421, body: { error: 'wrong_core', coreUrl: await deps.coreUrlFor(row.coreId) }, trail: { reason: 'wrong-core' } };
  }
  const session = await deps.introspectAccess({
    userId: row.userId,
    accessId: row.accessId,
    clientId: row.clientId,
    ...(row.dataGrantAccessId != null ? { dataGrantAccessId: row.dataGrantAccessId } : {}),
  });
  if (session == null) return { status: 200, body: INACTIVE };
  const revokedAt = await storage.getRevokedAt(deps.platform, row.clientId);
  if (revokedAt != null && session.created * 1000 <= revokedAt) return { status: 200, body: INACTIVE };
  const client = await getClient(deps.platform, row.clientId);
  if (client == null || client.status === 'suspended') return { status: 200, body: INACTIVE };

  // The session row carries the session-only selfRevoke override; the scope
  // answer is computed over the granted permissions, as at /token.
  const permissions = session.permissions.filter((p) => p.feature !== 'selfRevoke');
  let scopeTokens: string[] = row.grammarTokens ?? [];
  let extra: Record<string, unknown> = {};
  const registry = isRegistryClient(client);
  if (registry) {
    try {
      scopeTokens = grantedScopeTokens(client, row.coreTokens ?? [], row.grammarTokens ?? [], permissions);
      const ctx: HookCtx = {
        clientId: client.clientId,
        client: toClientView(client),
        subject: session.subject,
        grantType: 'introspection',
        scopeTokens,
        permissions,
        issuer,
      };
      extra = await runHook('introspectionClaims', ctx);
    } catch (err: unknown) {
      logServerError('introspection: registry claims failed', err);
      return { status: 500, body: { error: 'server_error', error_description: 'failed to build the introspection answer' } };
    }
  }
  return {
    status: 200,
    body: {
      ...extra,
      active: true,
      scope: scopeTokens.join(' '),
      client_id: row.clientId,
      exp: Math.floor(session.expires),
      iat: Math.floor(session.created),
      ...(session.subject != null ? { sub: session.subject } : {}),
      // Only here: the caller is a confidential resource server, which reaches
      // the account with the app's own token. Never in token responses.
      ...(typeof session.apiBase === 'string' ? { api_base: session.apiBase } : {}),
      // Registry sessions: the stream reach the core enforces (an extension
      // member of RFC 7662), so the resource server needs no extra call.
      ...(registry ? { permissions: streamPermissions(permissions) } : {}),
      iss: issuer,
      token_type: session.dpopJkt != null ? 'DPoP' : 'Bearer',
      ...(row.audience != null ? { aud: row.audience } : {}),
      ...(session.dpopJkt != null ? { cnf: { jkt: session.dpopJkt } } : {}),
    },
    trail: { userId: row.userId, tokenClientId: row.clientId },
  };
}

/** Stream entries only (features are not the resource server's business). */
function streamPermissions (permissions: ExtPermission[]): Array<{ streamId: string; level: string }> {
  const out: Array<{ streamId: string; level: string }> = [];
  for (const p of permissions) {
    if (typeof p.streamId === 'string' && typeof p.level === 'string') out.push({ streamId: p.streamId, level: p.level });
  }
  return out;
}

function sendJson (res: Response, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}
