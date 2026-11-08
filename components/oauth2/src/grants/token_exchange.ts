/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
 * (RFC 8693), for resource servers in front of a core.
 *
 * A resource server (a confidential registry client registered with
 * `canExchange`) presents the access token a user's client sent it, issued
 * for one of the audiences the resource server is registered for, and gets a
 * derived session of the same user: a session of the same grant, with the
 * subject session's permissions, alias and expiry at most, named after the
 * resource server, no refresh token. One derived session per subject session
 * and resource server: a repeated exchange answers the same token.
 *
 * Checks, in order (nothing is consumed; a refusal leaves the subject token
 * as it was): client authentication (401, uniform), the caller's role and
 * status, the request shape, the subject's index row (unknown, derived or
 * audience-less: `invalid_grant`), the subject's audience against the
 * caller's list (`invalid_target`), the optional `subject_token_resource`
 * against that audience (`invalid_target`), the home core (another core:
 * 421 `wrong_core`), the subject session and its client on the home core,
 * and the account a per-user audience names (`invalid_grant`).
 *
 * Deliberate departure from RFC 8693 § 2.2.2: an unusable subject token is
 * `invalid_grant`, not `invalid_request`, so a resource server can tell "the
 * user's authorization is gone" from "the request is malformed".
 */

import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { ExtPermission } from '../extension.ts';
import type { OAuthClient, OAuthSessionIndex } from '../storage.ts';
import * as storage from '../storage.ts';
import { audit } from '../audit.ts';
import { getClient, isRegistryClient, clientUnavailable } from '../clientRegistry.ts';
import { authenticateClient } from '../clientSecret.ts';
import { isConfidentialClient } from '../clientAuth.ts';
import { tokenEndpointAudiences, issuerFromConfig } from '../issuer.ts';
import { prepareRegistryResponse } from '../responseHooks.ts';
import type { RegistryResponseParts } from '../responseHooks.ts';
import { isValidResource, matchAudience, sameResource, withinResourceCap } from '../resourceIndicator.ts';
import { USERNAME_PLACEHOLDER } from '../audienceTemplate.ts';
import type { PlatformRoutedLabel } from '../audienceAccount.ts';
import { AUDIENCE_ACCOUNT_MISMATCH, labelNamesAccount } from '../audienceAccount.ts';
import { clientLifetimes } from '../clientLifetimes.ts';
import { indexSession } from '../sessionIndex.ts';
import { logServerError } from '../serverLog.ts';

export const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/** Shortest derived lifetime issued, in milliseconds (`expires_in` is at least 1). */
const MIN_DERIVED_LIFETIME_MS = 2000;

/** The subject session as the home core sees it; null when not live. */
export type SubjectSession = {
  username: string;
  /** Seconds. */
  created: number;
  /** Seconds. */
  expires: number;
  /** What the session row stores, without its selfRevoke override (the scope echo input). */
  permissions: ExtPermission[];
  /** The id the client sees for the user (stable id, or the grant's alias). */
  subject: string;
  aliased: boolean;
  grantState?: unknown;
  /** The account's API base URL, no credential in it (the alias when aliased). */
  apiBase: string;
  /** The account's address aliases (a per-user audience may name one). */
  addressAliases?: string[];
  /**
   * The account's former usernames it still holds (from the home core's users
   * index): an authorization made at a former address keeps exchanging.
   */
  formerUsernames?: string[];
};

export type ReadSubjectSession = (params: {
  userId: string; accessId: string; clientId: string; dataGrantAccessId?: string;
}) => Promise<SubjectSession | null>;

/**
 * Find or mint the derived session of (subject session, resource server) on
 * this core: a live one, created after `notBefore`, is reused; an expired one,
 * or one created at or before `notBefore`, is deleted and replaced. Throws an
 * error with `code: 'subject-inactive'` when the subject session is gone
 * meanwhile (a derived session minted meanwhile is deleted again).
 */
export type IssueDerivedSession = (params: {
  userId: string;
  username: string;
  /** The resource server. */
  clientId: string;
  subjectAccessId: string;
  subjectClientId: string;
  /** Upper bound of the derived expiry (ms since epoch). */
  expiresAt: number;
  /**
   * The resource server's revoke epoch (ms), or null: a derived session
   * created at or before it is not reused (it is deleted and a new one minted).
   */
  notBefore: number | null;
}) => Promise<{ accessId: string; accessToken: string; expires: number; reused: boolean }>;

export type TokenExchangeDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
  readSubjectSession: ReadSubjectSession;
  issueDerivedSession: IssueDerivedSession;
  /** Public URL of a core, for the wrong-core answer. */
  coreUrlFor?: (coreId: string) => string | Promise<string>;
  /** The host labels the platform answers itself; absent: none is. */
  isPlatformRoutedLabel?: PlatformRoutedLabel;
  /**
   * The issuer the token request is served by, which a client assertion
   * names (a per-user one on an account's host); absent: the configured
   * issuer. The exchange itself keeps the configured issuer.
   */
  requestIssuer?: string;
};

export type TokenExchangeParams = {
  client_id?: unknown;
  client_secret?: unknown;
  basic?: { client_id: string; client_secret: string } | null;
  client_assertion?: unknown;
  client_assertion_type?: unknown;
  subject_token?: unknown;
  subject_token_type?: unknown;
  requested_token_type?: unknown;
  actor_token?: unknown;
  actor_token_type?: unknown;
  scope?: unknown;
  resource?: unknown;
  audience?: unknown;
  /** Where the resource server received the subject token (optional, see step 5b). */
  subject_token_resource?: unknown;
};

type Refusal = { ok: false; status: number; error: string; description?: string; extra?: Record<string, unknown> };
type Outcome = { ok: true; body: Record<string, unknown> } | Refusal;

const NOT_ACTIVE = 'subject token is not active';
const CLIENT_NOT_AVAILABLE = 'the subject token\'s client is not available';

export async function handleTokenExchange (deps: TokenExchangeDeps, params: TokenExchangeParams): Promise<Outcome> {
  // 1. Client authentication, before anything else: an unauthenticated
  //    caller learns nothing, and nothing is audited for it.
  const unauthenticated: Refusal = { ok: false, status: 401, error: 'invalid_client', description: 'client authentication failed' };
  const clientId = typeof params.client_id === 'string' ? params.client_id : '';
  if (clientId === '' || (params.basic != null && params.basic.client_id !== clientId)) return unauthenticated;
  const caller = await getClient(deps.platform, clientId);
  if (caller == null || !isConfidentialClient(caller)) return unauthenticated;
  const auth = await authenticateClient({
    client: caller,
    clientId,
    presentedSecret: params.basic?.client_secret ?? (typeof params.client_secret === 'string' ? params.client_secret : undefined),
    assertion: typeof params.client_assertion === 'string' ? params.client_assertion : undefined,
    assertionType: typeof params.client_assertion_type === 'string' ? params.client_assertion_type : undefined,
    platform: deps.platform,
    expectedAudiences: tokenEndpointAudiences(deps.config, deps.requestIssuer),
  });
  if (!auth.ok) return unauthenticated;

  const refuse = async (reason: string, refusal: Refusal): Promise<Refusal> => {
    await audit('oauth.token.exchange_refused', { clientId, reason });
    return refusal;
  };

  // 2. The caller's role, and its status (not its regions: they say where its
  //    users are served, not where it may exchange, as for introspection).
  if (!isRegistryClient(caller) || caller.canExchange !== true) {
    return await refuse('not-entitled', { ok: false, status: 400, error: 'unauthorized_client', description: 'client is not registered for token exchange' });
  }
  const unavailable = clientUnavailable(caller, null);
  if (unavailable != null) {
    return await refuse('not-entitled', { ok: false, status: 400, error: 'unauthorized_client', description: unavailable.description });
  }

  // 3. The request.
  const issuer = issuerFromConfig(deps.config);
  const shape = requestShapeRefusal(params, issuer, caller.allowedAudiences ?? []);
  if (shape != null) return await refuse('request-shape', shape);
  const subjectToken = params.subject_token as string;

  // 4. The subject's index row: where it lives, whose it is, its audience.
  const row: OAuthSessionIndex | null = await storage.getSessionIndex(deps.platform, subjectToken);
  // A derived token is never a subject (no chaining); a token issued for no
  // resource server is not exchangeable (and is usable at the API as is).
  if (row == null || row.exchange != null || row.audience == null) {
    return await refuse('subject-inactive', { ok: false, status: 400, error: 'invalid_grant', description: NOT_ACTIVE });
  }

  // 5. Confused deputy: the subject token must have been issued for one of
  //    the audiences this resource server is registered for (an exact one, or
  //    an address its per-user audience names). Checked before the home core
  //    is named: the audience is on the cluster-wide index row, so a resource
  //    server the token was not issued for learns no core URL.
  const audience = row.audience;
  const callerAudiences = caller.allowedAudiences ?? [];
  const matched = withinResourceCap(audience, callerAudiences) ? matchAudience(audience, callerAudiences) : null;
  if (matched == null) {
    return await refuse('foreign-audience', {
      ok: false, status: 400, error: 'invalid_target', description: 'the subject token was issued for a resource this client is not registered for',
    });
  }
  // 5b. Where the resource server received the subject token, when it says
  //     so: the token must have been issued for that resource (a token for
  //     one account's address presented at another's is not exchanged). Also
  //     before the home core is named.
  const presentedAt = params.subject_token_resource;
  if (typeof presentedAt === 'string' && presentedAt !== '' && !sameResource(audience, presentedAt)) {
    return await refuse('subject-resource-mismatch', {
      ok: false, status: 400, error: 'invalid_target', description: 'the subject token was not issued for the resource it was presented at',
    });
  }
  const coreId = String(deps.config.get('core:id') ?? 'single');
  if (row.coreId !== coreId) {
    if (typeof deps.coreUrlFor !== 'function') {
      return await refuse('wrong-core', { ok: false, status: 400, error: 'invalid_grant', description: NOT_ACTIVE });
    }
    return await refuse('wrong-core', { ok: false, status: 421, error: 'wrong_core', extra: { coreUrl: await deps.coreUrlFor(row.coreId) } });
  }

  // 6. The subject session on its home core, and the client it was issued to.
  let subject: SubjectSession | null;
  try {
    subject = await deps.readSubjectSession({
      userId: row.userId,
      accessId: row.accessId,
      clientId: row.clientId,
      ...(row.dataGrantAccessId != null ? { dataGrantAccessId: row.dataGrantAccessId } : {}),
    });
  } catch (err: unknown) {
    logServerError('token exchange: subject session read failed', err);
    return { ok: false, status: 500, error: 'server_error', description: 'failed to issue the derived token' };
  }
  if (subject == null) return await refuse('subject-inactive', { ok: false, status: 400, error: 'invalid_grant', description: NOT_ACTIVE });
  // An address named by a per-user audience must be the subject account's
  // own (the consent checked it; this closes any row written otherwise).
  if (matched.label != null && !labelNamesAccount(matched.label, subject, deps.isPlatformRoutedLabel)) {
    return await refuse(AUDIENCE_ACCOUNT_MISMATCH, { ok: false, status: 400, error: 'invalid_grant', description: NOT_ACTIVE });
  }
  const subjectClient: OAuthClient | null = await getClient(deps.platform, row.clientId);
  // The scope echo and the derived permissions are the grant's: a registry
  // client's session only.
  if (subjectClient != null && !isRegistryClient(subjectClient)) {
    return await refuse('subject-inactive', { ok: false, status: 400, error: 'invalid_grant', description: NOT_ACTIVE });
  }
  const revokedAt = await storage.getRevokedAt(deps.platform, row.clientId);
  if (subjectClient == null || storage.issuedBeforeClientRevoke(subject.created * 1000, revokedAt) ||
      clientUnavailable(subjectClient, deps.config) != null) {
    return await refuse('subject-client-unavailable', { ok: false, status: 400, error: 'invalid_grant', description: CLIENT_NOT_AVAILABLE });
  }

  // 7. The lifetime first: never longer than the subject session, nor than
  //    the resource server's own access-token lifetime (a refusal here runs
  //    no hook). Then the response parts (hooks included), so a failing hook
  //    leaves no derived session behind; then the derived session (a live
  //    one found, or minted), its index row, the audit and the answer. The
  //    scope is the grammar's echo over the subject's permissions, without
  //    the core tokens (`offline_access`, `openid`): the derived token comes
  //    with no refresh token and no id_token.
  const now = Date.now();
  const expiresAt = Math.min(subject.expires * 1000, now + clientLifetimes(deps.config, caller).accessTokenTTL * 1000);
  if (expiresAt - now < MIN_DERIVED_LIFETIME_MS) {
    return await refuse('subject-inactive', { ok: false, status: 400, error: 'invalid_grant', description: NOT_ACTIVE });
  }
  const coreTokens: string[] = [];
  let parts: RegistryResponseParts;
  try {
    parts = await prepareRegistryResponse({
      client: subjectClient,
      actor: caller,
      grantType: 'token-exchange',
      issuer,
      config: deps.config,
      coreTokens,
      grammarTokens: row.grammarTokens ?? [],
      permissions: subject.permissions,
      subject: subject.subject,
      aliased: subject.aliased,
      grantState: subject.grantState,
    });
  } catch (err: unknown) {
    logServerError('token exchange: registry token response failed', err);
    return { ok: false, status: 500, error: 'server_error', description: 'failed to issue the derived token' };
  }

  // A derived session made before the resource server's revoke epoch (an id
  // revoked and registered again keeps its tombstone) is refused at the data
  // API: it is replaced, never handed out again.
  const notBefore = await storage.getRevokedAt(deps.platform, clientId);
  let issued: { accessId: string; accessToken: string; expires: number; reused: boolean };
  try {
    issued = await deps.issueDerivedSession({
      userId: row.userId,
      username: subject.username,
      clientId,
      subjectAccessId: row.accessId,
      subjectClientId: row.clientId,
      expiresAt,
      notBefore,
    });
  } catch (err: unknown) {
    if ((err as { code?: string } | null)?.code === 'subject-inactive') {
      return await refuse('subject-inactive', { ok: false, status: 400, error: 'invalid_grant', description: NOT_ACTIVE });
    }
    logServerError('token exchange: derived session failed', err);
    return { ok: false, status: 500, error: 'server_error', description: 'failed to issue the derived token' };
  }
  const exchange = { subjectClientId: row.clientId, subjectAccessId: row.accessId };
  // Written at every exchange: its lifetime follows the derived session's.
  await indexSession(deps.platform, issued.accessToken, {
    userId: row.userId,
    accessId: issued.accessId,
    clientId,
    coreId,
    expiresAt: issued.expires * 1000,
    ...(row.dataGrantAccessId != null ? { dataGrantAccessId: row.dataGrantAccessId } : {}),
    // Introspection answers the same scope as the exchange did.
    coreTokens,
    grammarTokens: row.grammarTokens ?? [],
    exchange,
  });
  await audit('oauth.token.exchanged', {
    clientId,
    userId: row.userId,
    accessId: issued.accessId,
    ...(row.dataGrantAccessId != null ? { dataGrantAccessId: row.dataGrantAccessId } : {}),
    ...exchange,
    reused: issued.reused,
    grantedScope: parts.scopeTokens,
  });
  // Core members last: a static extra cannot replace them.
  return {
    ok: true,
    body: {
      ...parts.extra,
      access_token: issued.accessToken,
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.floor(issued.expires - Date.now() / 1000)),
      scope: parts.scopeTokens.join(' '),
      api_base: subject.apiBase,
    },
  };
}

/** The request parameters (RFC 8693 § 2.1) this server accepts, or the refusal. */
function requestShapeRefusal (params: TokenExchangeParams, issuer: string, callerAudiences: readonly string[]): Refusal | null {
  if (params.actor_token != null || params.actor_token_type != null) {
    return { ok: false, status: 400, error: 'invalid_request', description: 'actor tokens are not supported' };
  }
  if (typeof params.subject_token !== 'string' || params.subject_token === '') {
    return { ok: false, status: 400, error: 'invalid_request', description: 'subject_token is required' };
  }
  if (params.subject_token_type !== ACCESS_TOKEN_TYPE) {
    return { ok: false, status: 400, error: 'invalid_request', description: 'subject_token_type must be ' + ACCESS_TOKEN_TYPE };
  }
  if (params.requested_token_type != null && params.requested_token_type !== ACCESS_TOKEN_TYPE) {
    return { ok: false, status: 400, error: 'invalid_request', description: 'requested_token_type must be ' + ACCESS_TOKEN_TYPE };
  }
  // Refused rather than ignored: a client that asked to narrow must not
  // believe it did.
  if (params.scope != null && params.scope !== '') {
    return { ok: false, status: 400, error: 'invalid_scope', description: 'scope narrowing is not available on this grant' };
  }
  for (const value of [params.resource, params.audience]) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) return { ok: false, status: 400, error: 'invalid_target', description: 'one resource per request' };
    if (typeof value !== 'string') return { ok: false, status: 400, error: 'invalid_request', description: 'resource and audience must be strings' };
    if (!withinResourceCap(value, [issuer]) || !sameResource(value, issuer)) {
      return { ok: false, status: 400, error: 'invalid_target', description: 'the requested resource is not this server' };
    }
  }
  // Not the target of the requested token (that is `resource`): the resource
  // URL the subject token was presented at, one plain URL (no placeholder).
  const presentedAt = params.subject_token_resource;
  if (presentedAt != null && presentedAt !== '') {
    if (Array.isArray(presentedAt)) return { ok: false, status: 400, error: 'invalid_target', description: 'one resource per request' };
    if (typeof presentedAt !== 'string') {
      return { ok: false, status: 400, error: 'invalid_request', description: 'subject_token_resource must be a string' };
    }
    if (!withinResourceCap(presentedAt, callerAudiences) || !isValidResource(presentedAt) || presentedAt.includes(USERNAME_PLACEHOLDER)) {
      return { ok: false, status: 400, error: 'invalid_target', description: 'subject_token_resource is not a valid resource' };
    }
  }
  return null;
}
