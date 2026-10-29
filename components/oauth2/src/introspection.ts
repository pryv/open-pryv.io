/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — `POST /oauth2/introspect` (RFC 7662) and the session index.
 *
 * Every OAuth session token is indexed at mint time (`oauth-at/<sha256>`,
 * replicated, no token / username / alias in the row), so a resource server
 * can ask any core whether a token is active. The caller is a CONFIDENTIAL
 * client registered with `canIntrospect`. A token whose session lives on
 * another core answers 421 with that core's URL (no forwarding). The home
 * core re-reads the session: deleted, expired, client revoked after the
 * session was minted, or consent data-grant gone, means `active: false`.
 */

import { createRequire } from 'node:module';

import type { Request, Response } from 'express';
import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthSessionIndex } from './storage.ts';
import type { HookCtx, ExtPermission } from './extension.ts';
const require = createRequire(import.meta.url);

const storage = require('./storage.ts');
const { getClient, isRegistryClient } = require('./clientRegistry.ts');
const { authenticateClient } = require('./clientSecret.ts');
const { issuerFromConfig } = require('./issuer.ts');
const { grantedScopeTokens } = require('./scopeGrammar.ts');
const { runHook, toClientView } = require('./extension.ts');
const { logServerError } = require('./serverLog.ts');

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
  introspectAccess?: IntrospectAccess;
  /** Public URL of a core, for the wrong-core answer. */
  coreUrlFor?: (coreId: string) => string | Promise<string>;
};

/** Write the index row of a freshly minted session. Never fails the mint. */
export async function indexSession (platform: PlatformDB, accessToken: string, row: OAuthSessionIndex): Promise<void> {
  try {
    await storage.setSessionIndex(platform, accessToken, row);
  } catch (err: unknown) {
    logServerError('introspection: session index write failed (the token will introspect inactive)', err);
  }
}

const INACTIVE = { active: false };

export function handleIntrospect (deps: IntrospectDeps) {
  return async function introspect (req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Loaded here: the token route loads the grants, which load this module.
    const { decodeBasicAuth } = require('./routes/token.ts');
    const basic = decodeBasicAuth(req.headers?.authorization);
    const clientId = basic?.client_id ?? (typeof body.client_id === 'string' ? body.client_id : '');
    const caller = clientId !== '' ? await getClient(deps.platform, clientId) : null;
    // Uniform refusal: unknown, public, not allowed, or bad credentials.
    const refuse = (): void => sendJson(res, 401, { error: 'invalid_client', error_description: 'client authentication failed' },
      { 'WWW-Authenticate': 'Basic realm="oauth2"' });
    const confidential = caller != null && (caller.clientSecretHash != null || caller.jwks != null);
    if (!confidential || caller.canIntrospect !== true || caller.status === 'suspended') return refuse();
    const issuer = issuerFromConfig(deps.config);
    const auth = await authenticateClient({
      client: caller,
      clientId,
      presentedSecret: basic?.client_secret ?? body.client_secret,
      assertion: body.client_assertion,
      assertionType: body.client_assertion_type,
      platform: deps.platform,
      expectedAudiences: [issuer, issuer + '/oauth2/introspect', issuer + '/oauth2/token'],
    });
    if (!auth.ok) return refuse();

    if (typeof body.token !== 'string' || body.token.length === 0) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'token is required' });
    }
    const answer = await introspectToken(deps, body.token, issuer);
    return sendJson(res, answer.status, answer.body);
  };
}

async function introspectToken (
  deps: IntrospectDeps, token: string, issuer: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const row: OAuthSessionIndex | null = await storage.getSessionIndex(deps.platform, token);
  if (row == null) return { status: 200, body: INACTIVE };
  const coreId = String(deps.config.get('core:id') ?? 'single');
  if (row.coreId !== coreId) {
    if (typeof deps.coreUrlFor !== 'function') return { status: 200, body: INACTIVE };
    return { status: 421, body: { error: 'wrong_core', coreUrl: await deps.coreUrlFor(row.coreId) } };
  }
  if (typeof deps.introspectAccess !== 'function') return { status: 200, body: INACTIVE };
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
  if (isRegistryClient(client)) {
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
      exp: session.expires,
      iat: session.created,
      ...(session.subject != null ? { sub: session.subject } : {}),
      // Only here: the caller is a confidential resource server, which reaches
      // the account with the app's own token. Never in token responses.
      ...(typeof session.apiBase === 'string' ? { api_base: session.apiBase } : {}),
      iss: issuer,
      token_type: session.dpopJkt != null ? 'DPoP' : 'Bearer',
      ...(row.audience != null ? { aud: row.audience } : {}),
      ...(session.dpopJkt != null ? { cnf: { jkt: session.dpopJkt } } : {}),
    },
  };
}

function sendJson (res: Response, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}
