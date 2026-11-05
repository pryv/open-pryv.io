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
 * is a CONFIDENTIAL client registered with `canIntrospect` and active;
 * any other caller is refused with one uniform 401. A token whose session
 * lives on another core answers 421 with that core's URL (no forwarding). The
 * home core re-reads the session: deleted, expired, client revoked after the
 * session was minted, client suspended, under review or gone, or consent grant gone, means
 * `active: false`.
 *
 * The answer's `scope` is the scope tokens granted to a registry client's
 * session (the token endpoint's answer); it is omitted for an app-account
 * session, whose token response scope is not grammar tokens.
 *
 * Beyond the RFC members, an active answer carries `api_base` (the account's
 * API base URL, no credential in it) and, for a registry client's session,
 * `permissions` (the stream permissions the session holds now, as the core
 * enforces them): extension members, answered only to the confidential
 * callers above, never in a token response.
 *
 * A derived token (token exchange) answers the client whose authorization it
 * carries as `client_id`, and the resource server holding it as `act`
 * (`{ client_id }`, RFC 8693 § 4.1); it has no `aud`. Both clients must be
 * available for it to be active.
 */

import type { Request, Response } from 'express';
import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthClient, OAuthSessionIndex } from './storage.ts';
import type { HookCtx, ExtPermission } from './extension.ts';
import * as storage from './storage.ts';
import { getClient, isRegistryClient, clientUnavailable } from './clientRegistry.ts';
import { authenticateClient } from './clientSecret.ts';
import { decodeBasicAuth, clientIdFromAssertion, isConfidentialClient as isConfidential } from './clientAuth.ts';
import { issuerFromConfig } from './issuer.ts';
import { grantedScopeTokens } from './scopeGrammar.ts';
import { clientKeyOf, publicClientId } from './clientMetadataId.ts';
import { reportClientAuthRefusal } from './clientMetadata.ts';
import { runHook, toClientView, EXCHANGE_RESERVED_KEYS } from './extension.ts';
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
  /** The subject is the grant's alias (a pseudonymous grant). */
  aliased?: boolean;
  /** The grant's state (registry clients), as the last consent left it. */
  grantState?: unknown;
  /** The account's API base URL, no credential in it (alias-based when the grant is aliased). */
  apiBase?: string;
  dpopJkt?: string;
  /** A derived session (token exchange): when its subject session was created (seconds). */
  subjectCreated?: number;
} | null>;

export type IntrospectDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
  introspectAccess: IntrospectAccess;
  /** Public URL of a core, for the wrong-core answer. */
  coreUrlFor?: (coreId: string) => string | Promise<string>;
};

const INACTIVE = { active: false };

/** A client that authenticates (secret or key set on file). */
export function isConfidentialClient (client: OAuthClient | null | undefined): boolean {
  return isConfidential(client);
}

export function handleIntrospect (deps: IntrospectDeps) {
  return async function introspect (req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const basic = decodeBasicAuth(req.headers?.authorization);
    const bodyClientId = typeof body.client_id === 'string' ? body.client_id : '';
    // Next to a client_assertion, client_id is optional (RFC 7523 §3): the
    // assertion's iss names the client, authenticated below as any other.
    // A metadata-document client names itself by its URL (body or assertion):
    // its row key here (such a client is never allowed to introspect: refused below).
    const clientId = basic?.client_id ?? clientKeyOf(bodyClientId !== ''
      ? bodyClientId
      : clientIdFromAssertion(body.client_assertion, body.client_assertion_type) ?? '');
    // Uniform refusal: unknown, public, not allowed, not active, or bad credentials.
    // The caller's regions are not checked: they say where its users are
    // served, not where it may ask about a token (whose home core this is).
    const refuse = async (): Promise<void> => {
      await reportClientAuthRefusal(deps.platform, clientId, 'introspect');
      sendJson(res, 401, { error: 'invalid_client', error_description: 'client authentication failed' },
        { 'WWW-Authenticate': 'Basic realm="oauth2"' });
    };
    if (clientId === '' || (basic != null && bodyClientId !== '' && bodyClientId !== basic.client_id)) return refuse();
    const caller = await getClient(deps.platform, clientId);
    if (caller == null || !isConfidentialClient(caller) || caller.canIntrospect !== true || clientUnavailable(caller, null) != null) {
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
  trail?: { userId?: string; tokenClientId?: string; actorClientId?: string; reason?: string };
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
  // A derived session (token exchange) is the resource server's, and carries
  // the authorization of the client the subject token was issued to: both
  // must be available. The resource server by its status only (as at the
  // exchange), the subject's client by its status and regions.
  const exchange = row.exchange ?? null;
  const tokenClientId = exchange?.subjectClientId ?? row.clientId;
  if (exchange != null) {
    if (await revokedSince(deps, row.clientId, session.created)) return { status: 200, body: INACTIVE };
    const actor = await getClient(deps.platform, row.clientId);
    if (actor == null || clientUnavailable(actor, null) != null) return { status: 200, body: INACTIVE };
  }
  // A derived token carries the subject session's authorization: the subject
  // client's revoke epoch is compared with the subject session's creation.
  const authorizedAt = exchange != null ? (session.subjectCreated ?? session.created) : session.created;
  if (await revokedSince(deps, tokenClientId, authorizedAt)) return { status: 200, body: INACTIVE };
  const client = await getClient(deps.platform, tokenClientId);
  if (client == null || clientUnavailable(client, deps.config) != null) return { status: 200, body: INACTIVE };

  // The stored session permissions without the session-only selfRevoke
  // override (the glue strips it): the scope answer is computed over them, as
  // at /token.
  const permissions = session.permissions;
  let scopeTokens: string[] = row.grammarTokens ?? [];
  let extra: Record<string, unknown> = {};
  const registry = isRegistryClient(client);
  if (registry) {
    try {
      // Told whether the subject is an alias, as at /token and at refresh,
      // so the scope answer is the same one.
      const aliased = session.aliased === true;
      scopeTokens = grantedScopeTokens(client, row.coreTokens ?? [], row.grammarTokens ?? [], permissions,
        { aliased, grantState: session.grantState });
      const ctx: HookCtx = {
        clientId: client.clientId,
        client: toClientView(client),
        subject: session.subject,
        aliased,
        grantState: session.grantState,
        grantType: 'introspection',
        scopeTokens,
        permissions,
        issuer,
        ...(row.audience != null ? { audience: row.audience } : {}),
        ...(exchange != null ? { actor: { clientId: row.clientId } } : {}),
      };
      // A derived token's answer reserves `act` too, in that context only.
      extra = await runHook('introspectionClaims', ctx, exchange != null ? EXCHANGE_RESERVED_KEYS.introspectionClaims : []);
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
      // Omitted (RFC 7662: OPTIONAL) when the session carries no grammar
      // tokens (an app-account session): an empty scope would read as "none".
      ...(registry || (row.grammarTokens?.length ?? 0) > 0 ? { scope: scopeTokens.join(' ') } : {}),
      // A derived token: the client whose authorization it carries, and the
      // resource server holding it as the actor (RFC 8693 § 4.1). A
      // metadata-document client is answered by its URL.
      client_id: publicClientId(client),
      ...(exchange != null ? { act: { client_id: row.clientId } } : {}),
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
    trail: { userId: row.userId, tokenClientId, ...(exchange != null ? { actorClientId: row.clientId } : {}) },
  };
}

/** Whether `clientId` was revoked by the operator after a session created at `createdSeconds`. */
async function revokedSince (deps: IntrospectDeps, clientId: string, createdSeconds: number): Promise<boolean> {
  const revokedAt = await storage.getRevokedAt(deps.platform, clientId);
  return storage.issuedBeforeClientRevoke(createdSeconds * 1000, revokedAt);
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
