/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 route mount + host-app wiring.
 *
 * Builds the two callbacks the oauth2 component needs from the rest of
 * the api-server:
 *
 *   - `resolveUser({username, userToken})` — constructs a MethodContext
 *     for the user, validates the personal access token via
 *     `retrieveExpandedAccess`, returns a session handle carrying the
 *     populated context. Returns null on validation failure (errors
 *     from the access lookup surface as APIError; we swallow into null
 *     so the OAuth endpoint can render a 401 cleanly).
 *
 *   - `createAccess({session, clientId, scope, expiresAt})` — runs
 *     the full `accesses.create` method on behalf of the resolved
 *     user, so all the existing hooks (validation, CMC, etc.) fire.
 *     Maps the coarse-grained OAuth scope tokens to per-stream
 *     permissions (the App account is the OAuth client; the access
 *     is created on the user's home core).
 *
 * Then hands both off to `oauth2.registerRoutes`. If `service:api`,
 * `auth:adminAccessKey`, or `oauth:consentUrl` is missing, the oauth2
 * module soft-degrades with a warn — see its routes.ts.
 */

import type { Application as ExpressApp } from 'express';
import type { AppLike } from './_types.ts';
import type { ConsentTrigger, AwaitConsentDeps } from './consentPoll.ts';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const oauth2 = require('oauth2');
const delegation = require('delegation');
const { getLogger } = require('@pryv/boiler');
const { MethodContext } = require('business');
const { peerFetch } = require('business/src/outbound/peerFetch.ts');
const storages = require('storages');
// Use @paralleldrive/cuid2 (a production dependency) — the codebase migrated off
// the old `cuid`, which is a devDependency and is pruned by `--omit=dev` builds.
const { createId: cuid } = require('@paralleldrive/cuid2');
// Permission-lexicon single point + composite access refs.
const { permissionKey, mergeStreamPermissions, PermissionMergeConflictError } =
  require('business/src/accesses/permissionSet.ts');
const { parseAccessRef } = require('business/src/accesses/refs.ts');
const AccessLogic = require('business/src/accesses/AccessLogic.ts').default;
// Tree-aware consent guard: closes the hierarchical-masking gap that the
// pure entry-subset check (checkConsentGrant, run at /accept) cannot see.
const { assertGrantedWithinOffer } = require('business/src/accesses/consentEffectiveGuard.ts');
// Reuse-detection chain-revoke deps (mirror the accesses.delete method chain).
const cache = require('cache').default;
const { pubsub } = require('messages');
const { fromCallback } = require('utils');
// The teardown accesses.delete uses (webhooks, aliases, index, scrub, cache).
const { deleteAccessChain, accessChainIds } = require('../methods/helpers/accessDeletion.ts');
// CMC back-channel revoke notify — pure DI HTTP sender, no MethodContext needed.
const { outbound: cmcOutbound } = require('cmc');
const cmcRelationshipKey = require('cmc/src/relationshipKey.ts');
const { selfIdentityHost } = require('../methods/helpers/selfIdentityHost.ts');
// Outcome-driven CMC consent poll: keys on the trigger's terminal status so a
// transient data-grant about to be rolled back on a peer refusal is never
// observed as a success. See consentPoll.ts.
const { awaitConsentOutcome } = require('./consentPoll.ts') as {
  awaitConsentOutcome: <G>(deps: AwaitConsentDeps<G>) => Promise<G>;
};

/** Trigger-scope parent for OAuth-driven CMC accepts on the user's account. */
const OAUTH_CMC_PARENT = ':_cmc:apps:oauth';

/**
 * Session-credential selfRevoke override, applied at every session-access
 * mint (accept-time pre-mint + refresh-rotation re-mint). The offer's
 * `selfRevoke` feature binds the DURABLE consent capability (the data-grant),
 * not the ephemeral session credential: a client may always revoke its own
 * token, and the server itself relies on that to delete a pre-minted access
 * whose authorization code dies unexchanged. Any inherited `selfRevoke` entry
 * is replaced with an explicit allow; all other permissions pass through
 * verbatim. The data-grant keeps the offer's feature permissions untouched.
 * Other feature entries (e.g. `webhooks: forbidden`) bind the session
 * credential too, on purpose: only `selfRevoke` is overridden here.
 */
function withSessionSelfRevoke (permissions: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return permissions
    .filter((p) => p.feature !== 'selfRevoke')
    .concat([{ feature: 'selfRevoke', setting: 'allowed' }]);
}

/**
 * Whether two permission sets hold the same entries (order and display names
 * ignored). A set whose duplicate entries a merge collapsed compares as
 * changed, so the merge result is written.
 */
function samePermissionKeys (a: Array<Record<string, unknown>>, b: Array<Record<string, unknown>>): boolean {
  const ka: string[] = a.map(permissionKey);
  const kb = new Set<string>(b.map(permissionKey));
  return ka.length === kb.size && new Set(ka).size === kb.size && ka.every((k) => kb.has(k));
}

/**
 * Structural view of the members this module touches on a business
 * MethodContext (the runtime value comes from `require('business')`, which
 * is untyped through the createRequire shim). Modelling the used surface
 * keeps the wiring off `any` without importing the full class type.
 */
type Ctx = {
  methodId: string | null;
  user: { id: string; username: string };
  access: unknown;
  init: () => Promise<void>;
  retrieveExpandedAccess: (storage: unknown) => Promise<void>;
};

/** The API-method result shape this module reads (method-dependent, partial). */
type OAuthMethodResult = {
  access?: DataGrant & { token?: unknown; apiEndpoint?: unknown };
  accesses?: DataGrant[];
  event?: { id?: unknown; content?: Record<string, unknown> };
};

/** A CMC data-grant access row, as read back from accesses.get / findOne. */
type DataGrant = {
  id: string;
  type?: string;
  name?: string;
  alias?: string | null;
  token?: unknown;
  permissions?: Array<Record<string, unknown>>;
  deleted?: unknown;
  expires?: number | null;
  createdBy?: unknown;
  // Widened vs the narrow role/offer view: reuse-detection reads the CMC
  // counterparty back-channel address off the data-grant to notify the app.
  clientData?: {
    cmc?: {
      role?: string;
      offerEventId?: string;
      acceptEventId?: string;
      counterparty?: { apiEndpoint?: string };
      backChannelApiEndpoint?: string;
    }
  };
};

/** The storage-layer accesses repository surface this module calls directly. */
type AccessesRepo = {
  findOne: (user: { id: string; username: string }, query: Record<string, unknown>, opts: unknown, cb: (err: unknown, found: DataGrant | null) => void) => void;
  find: (user: { id: string; username: string }, query: Record<string, unknown>, opts: unknown, cb: (err: unknown, found: DataGrant[] | null) => void) => void;
  delete: (user: { id: string; username: string }, query: Record<string, unknown>, cb: (err: unknown) => void) => void;
  insertOne: (user: { id: string; username: string }, row: Record<string, unknown>, cb: (err: unknown, created: { id?: unknown; token?: unknown } | null) => void) => void;
  updateOne: (user: { id: string; username: string }, query: Record<string, unknown>, update: Record<string, unknown>, cb: (err: unknown) => void) => void;
  generateToken: () => string;
};

export default function mountOAuth2 (expressApp: ExpressApp, app: AppLike): void {
  const config = app.config;
  const storageLayer = app.storageLayer;
  const api = app.api;
  const logger = getLogger('routes:oauth2');

  // ---------------------------------------------------------------------
  // resolveUser — validates {username, userToken} via MethodContext.
  // customAuthStepFn is resolved lazily on each request (matches the
  // initContext middleware pattern — load only when a request hits).
  // ---------------------------------------------------------------------
  async function resolveUser ({ username, userToken }: { username: string; userToken: string }) {
    const customAuthStepFn = app.getCustomAuthFunction != null
      ? app.getCustomAuthFunction('oauth2.resolveUser')
      : null;
    const context: Ctx = new MethodContext(
      { name: 'oauth2', ip: null },
      username,
      userToken,
      customAuthStepFn,
      {},
      {},
      null
    );
    try {
      await context.init();
      await context.retrieveExpandedAccess(storageLayer);
    } catch (err) {
      // Swallowed on purpose — the endpoint renders a clean 401 rather
      // than leaking why. Record it on the server trail: without this,
      // every context/auth failure is an indistinguishable null.
      logger.warn('resolveUser: context init/access lookup failed', err);
      return null;
    }
    if (context.access == null) {
      logger.warn('resolveUser: no access on context after retrieveExpandedAccess');
      return null;
    }
    // A token obtained through account delegation acts on this account for
    // the delegate. The OAuth access (and its refresh-minted successors) is
    // written outside accesses.create and would carry no delegation lineage,
    // so it would outlive the delegation: only the owner may consent here.
    if (delegation.isDelegationDerivedAccess(context.access)) {
      return {
        refused: true as const,
        description: 'A token obtained through account delegation cannot grant OAuth access; ' +
          'the account owner must sign in and consent.',
      };
    }
    return {
      userId: context.user.id,
      username: context.user.username,
      // Carry the live context through so createAccess can call api on it.
      _context: context,
    };
  }

  // ---------------------------------------------------------------------
  // apiCall — run an API method on an already-authenticated context.
  // The api dispatcher reads methodId off the context (set by the
  // setMethodId middleware on the normal route path; we set it here).
  // ---------------------------------------------------------------------
  async function apiCall (context: Ctx, methodId: string, params: Record<string, unknown>): Promise<OAuthMethodResult> {
    context.methodId = methodId;
    return await new Promise((resolve, reject) => {
      api.call(context, params, (err: unknown, result: unknown) => {
        if (err != null) return reject(err);
        resolve(result as OAuthMethodResult);
      });
    });
  }

  // Idempotent streams.create — swallows "already exists" only.
  async function ensureStream (context: Ctx, id: string, parentId: string, name: string): Promise<void> {
    try {
      await apiCall(context, 'streams.create', { id, parentId, name });
    } catch (err: unknown) {
      const e = err as { id?: string; data?: { id?: string } } | null;
      const errId = e?.id ?? e?.data?.id;
      if (errId === 'item-already-exists') return;
      throw err;
    }
  }

  // The durable consent record for a granular OAuth grant is the CMC
  // data-grant on the user's account, keyed by the offer event id.
  async function findDataGrantByOffer (context: Ctx, offerEventId: string): Promise<DataGrant | null> {
    const result = await apiCall(context, 'accesses.get', {});
    for (const a of (result?.accesses ?? [])) {
      const cmcCd = a?.clientData?.cmc;
      if (cmcCd?.role === 'counterparty' && cmcCd?.offerEventId === offerEventId) return a;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // createAccess — mints the short-TTL OAuth app access under the
  // resolved user's auth (full accesses.create chain runs).
  //
  // Granular (cmc-offer) grants first ensure the durable CMC
  // data-grant exists:
  //   - first authorization → a real `consent/accept-cmc` trigger is
  //     written with the user's personal token (the CMC plugin
  //     orchestrates the data-grant + back-channel pair + audit);
  //   - re-authorization → the existing data-grant is reused, widened
  //     via accesses.update when the new consent grants entries the
  //     current grant lacks (the CMC post-hook notifies the app).
  // The short-TTL access is then minted from the data-grant's CURRENT
  // permissions — the data-grant is the single source of granted
  // authority, and CMC revocation/scope-update governs the chain.
  // ---------------------------------------------------------------------
  async function createAccess ({ session, clientId, scope, expiresAt, offer, grantedPermissions }: {
    session: { userId: string; username: string; _context?: Ctx };
    clientId: string;
    scope: string[];
    expiresAt: number;
    offer?: {
      offerName: string;
      capabilityUrl: string;
      capabilityId: string | null;
      offerEventId: string | null;
      permissions: Array<Record<string, unknown>>;
    };
    grantedPermissions?: Array<Record<string, unknown>>;
  }): Promise<{
    accessId: string;
    accessToken: string;
    apiEndpoint: string;
    dataGrantAccessId?: string;
    permissions?: Array<Record<string, unknown>>;
  }> {
    const context = session._context;
    if (context == null) {
      throw new Error('oauth2.createAccess: session missing _context (resolveUser did not run?)');
    }

    if (offer == null || !Array.isArray(grantedPermissions) || grantedPermissions.length === 0) {
      throw new Error('oauth2.createAccess: a granular consent grant (offer + grantedPermissions) is required');
    }

    // Effective-permission guard (hierarchical-masking class). /accept
    // already ran the pure entry-subset check; here — with the user's
    // stream tree available — verify the granted subset does not WIDEN the
    // offer at any stream (a dropped restrictive descendant re-inheriting a
    // broader ancestor). Reject as a consent error the endpoint maps to 400.
    const eff = await assertGrantedWithinOffer({
      userId: context.user.id,
      granted: grantedPermissions,
      offered: offer.permissions,
    });
    if (!eff.ok) {
      const e = new Error(
        'granted permissions widen the offer under the stream hierarchy: ' +
        JSON.stringify(eff.violations)) as Error & { code: string };
      e.code = 'consent-widens-offer';
      throw e;
    }

    let dataGrant: DataGrant | null = null;
    if (offer.offerEventId != null) {
      dataGrant = await findDataGrantByOffer(context, offer.offerEventId);
    }
    if (dataGrant == null) {
      // First authorization: drive the real CMC accept. The plugin's
      // dispatch is fire-and-forget w.r.t. the events.create response,
      // so poll for the data-grant (keyed by the accept event id the
      // plugin stamps on it) while watching the trigger for failure.
      const scopeStreamId = OAUTH_CMC_PARENT + ':' + clientId;
      await ensureStream(context, OAUTH_CMC_PARENT, ':_cmc:apps', 'OAuth2 grants');
      await ensureStream(context, scopeStreamId, OAUTH_CMC_PARENT, clientId);
      const created = await apiCall(context, 'events.create', {
        streamIds: [scopeStreamId],
        type: 'consent/accept-cmc',
        content: {
          capabilityUrl: offer.capabilityUrl,
          grantedPermissions,
        },
      });
      const acceptEventId = created?.event?.id;
      if (typeof acceptEventId !== 'string') {
        throw new Error('oauth2.createAccess: consent accept trigger was not created');
      }
      // Key on the trigger's TERMINAL status, never on the mere presence of
      // the data-grant. handleAccept creates the grant BEFORE delivering the
      // accept to the peer and rolls it back on a 4xx refusal, so trusting a
      // grant the instant it appears could mint an OAuth access against a
      // consent that is about to be refused (an invalidated / consumed link).
      // The dispatch stamps `status: 'completed'` (+ dataGrantAccessId) on
      // success and `status: 'failed'` (+ failure) on refusal; resolve the
      // grant only once the trigger says completed.
      dataGrant = await awaitConsentOutcome<DataGrant>({
        getTrigger: async () => {
          const trigger = await apiCall(context, 'events.getOne', { id: acceptEventId });
          return (trigger?.event?.content ?? {}) as ConsentTrigger;
        },
        resolveDataGrant: async (trigger) => {
          const all = await apiCall(context, 'accesses.get', {});
          const list: DataGrant[] = all?.accesses ?? [];
          // Prefer the id the dispatch stamped; fall back to the acceptEventId
          // match for robustness if the stamp is somehow absent.
          if (typeof trigger.dataGrantAccessId === 'string') {
            const byId = list.find((a) => a?.id === trigger.dataGrantAccessId);
            if (byId != null) return byId;
          }
          return list.find((a) =>
            a?.clientData?.cmc?.role === 'counterparty' &&
            a?.clientData?.cmc?.acceptEventId === acceptEventId) ?? null;
        },
        // Success now waits for the FULL accept delivery round-trip (the
        // trigger reaches `completed` only after the peer answers), so the
        // deadline MUST exceed the outbound per-attempt delivery timeout
        // (cmc outbound DEFAULT_TIMEOUT_MS = 15s) with margin. A shorter
        // budget would turn a slow-but-successful peer (10-15s: cold
        // container, cross-region) into a 500 for a consent that then
        // completes in the background.
        deadlineMs: 25_000,
        sleepMs: 100,
        describe: 'acceptEventId=' + acceptEventId,
      });
    } else {
      // Re-authorization: join this consent into the data-grant, stream by
      // stream (never narrows: the user manages narrowing via consent
      // scope-update / access update). A stream granted at another level
      // gets the level covering both; when no level covers exactly both
      // (`read` and `create-only`), the consent is refused rather than
      // granting a capability nobody consented to.
      const currentPermissions = dataGrant.permissions ?? [];
      const merged = mergeStreamPermissions(currentPermissions, grantedPermissions, 'join');
      if (merged.conflicts.length > 0) throw new PermissionMergeConflictError(merged.conflicts);
      if (!samePermissionKeys(currentPermissions, merged.permissions)) {
        const updated = await apiCall(context, 'accesses.update', {
          id: dataGrant.id,
          update: { permissions: merged.permissions },
        });
        if (updated?.access != null) dataGrant = updated.access;
      }
    }
    // The short-TTL OAuth access mirrors EXACTLY this session's
    // granted subset; the durable data-grant (granted + CMC channel
    // anchors) is the consent ceiling that revocation/scope-update
    // governs. The minted row additionally carries the session
    // selfRevoke override (see withSessionSelfRevoke) — the CHAIN keeps
    // the granted subset verbatim (returned `permissions` below), so
    // the refresh-time intersection with the data-grant stays exact.
    const permissions: Array<Record<string, unknown>> = grantedPermissions;

    const expireAfter = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    // Pryv enforces (type, name, deviceName) uniqueness on access rows.
    // Every OAuth authorize-then-token flow mints a fresh access (its
    // own refresh-token chain) — disambiguate via a session-unique
    // deviceName, keeping the human-readable name on the clientId.
    const params = {
      type: 'app',
      name: 'oauth:' + clientId,
      deviceName: 'oauth-session-' + cuid(),
      permissions: withSessionSelfRevoke(permissions),
      expireAfter,
      clientData: sessionClientData(dataGrant.id),
    };
    const result = await apiCall(context, 'accesses.create', params);
    const a = result?.access;
    if (a == null || typeof a.id !== 'string' || typeof a.token !== 'string') {
      throw new Error('oauth2.createAccess: accesses.create returned no usable access');
    }
    return {
      accessId: a.id,
      accessToken: a.token as string,
      apiEndpoint: typeof a.apiEndpoint === 'string' ? a.apiEndpoint : '',
      dataGrantAccessId: dataGrant.id,
      permissions,
    };
  }

  // ---------------------------------------------------------------------
  // Storage-layer-direct access-mint path. Shared by:
  //   - mintRefreshedAccess (refresh_token grant — user gone, original
  //     accesses.create chain ran at /accept and already validated)
  //   - mintClientAccess (client_credentials grant — no end-user; the
  //     app account IS the principal; secret verified by the grant)
  // The two callbacks are identical except for the audit-event tag at
  // the grant level; both are safe storage-direct inserts (no widening
  // of authority — scope, user, permission shape all server-controlled).
  // ---------------------------------------------------------------------
  // Live head row of the durable data-grant, or a typed throw when the
  // consent has been revoked. Storage keeps the head row queryable by
  // the composite ref's base id (serial bumps rotate the wire id only).
  async function readDataGrantHead (userId: string, username: string, dataGrantAccessId: string): Promise<DataGrant> {
    const accessesRepository = (storageLayer as { accesses: AccessesRepo }).accesses;
    const base = parseAccessRef(dataGrantAccessId).base;
    const head: DataGrant | null = await new Promise((resolve, reject) => {
      accessesRepository.findOne({ id: userId, username }, { id: base }, null,
        (err: unknown, found: DataGrant | null) => (err != null ? reject(err) : resolve(found)));
    });
    // Not rounded: `expires` carries sub-second precision, and a "now" rounded
    // down to the second would keep a just-expired grant alive up to 1 s.
    const nowSeconds = Date.now() / 1000;
    if (head == null || head.deleted != null ||
        (typeof head.expires === 'number' && head.expires <= nowSeconds)) {
      const revoked = new Error('consent data-grant revoked or expired') as Error & { code: string };
      revoked.code = 'data-grant-revoked';
      throw revoked;
    }
    return head;
  }

  // A session access names the consent data-grant it was minted under, so
  // deleting that grant deletes the session with it (accessDeletion.ts)
  // instead of leaving it valid until its own expiry. Written only here;
  // accesses.update refuses to change it.
  function sessionClientData (dataGrantAccessId: string, dpopJkt?: string): Record<string, unknown> {
    return {
      oauth: { dataGrantId: parseAccessRef(dataGrantAccessId).base },
      ...(dpopJkt != null ? { dpop: { jkt: dpopJkt } } : {}),
    };
  }

  async function mintAccessDirect ({ userId, username, clientId, permissions, expiresAt, dpopJkt, dataGrantAccessId }: {
    userId: string;
    username: string;
    clientId: string;
    permissions: Array<Record<string, unknown>>;
    expiresAt: number;
    dpopJkt?: string;
    dataGrantAccessId?: string;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string }> {
    if (typeof username !== 'string' || username.length === 0) {
      throw new Error('mintAccessDirect: username required');
    }
    const accessesRepository = (storageLayer as { accesses?: AccessesRepo }).accesses;
    if (accessesRepository == null) {
      throw new Error('mintAccessDirect: storageLayer.accesses unavailable');
    }
    // Millisecond precision, like every other access (timestamp.now()): the
    // client-revoke check compares `created` with a revoke epoch in ms, so a
    // time rounded down to the second would put a session minted just after a
    // revoke (same second) before it, and refuse it as revoked.
    const now = Date.now() / 1000;
    const newToken = accessesRepository.generateToken();
    const newAccessRow: Record<string, unknown> = {
      type: 'app',
      name: 'oauth:' + clientId,
      deviceName: 'oauth-session-' + cuid(),
      token: newToken,
      permissions,
      created: now,
      createdBy: 'system',
      modified: now,
      modifiedBy: 'system',
      expires: Math.floor(expiresAt / 1000),
      // Sender-constrained sessions carry the key thumbprint the
      // resource layer checks the per-request proof against.
      ...(dataGrantAccessId != null
        ? { clientData: sessionClientData(dataGrantAccessId, dpopJkt) }
        : (dpopJkt != null ? { clientData: { dpop: { jkt: dpopJkt } } } : {})),
    };
    const ApiEndpoint = require('utils').ApiEndpoint;
    return await new Promise((resolve, reject) => {
      accessesRepository.insertOne({ id: userId, username }, newAccessRow,
        (err: unknown, newAccess: { id?: unknown; token?: unknown } | null) => {
          if (err != null) return reject(err);
          if (newAccess == null || typeof newAccess.id !== 'string' || typeof newAccess.token !== 'string') {
            return reject(new Error('mintAccessDirect: accesses.insertOne returned no usable access'));
          }
          resolve({
            accessId: newAccess.id,
            accessToken: newAccess.token,
            apiEndpoint: ApiEndpoint.build(username, newAccess.token),
          });
        });
    });
  }

  // ---------------------------------------------------------------------
  // resolveAccountUserId — App account's username → its userId. Needed
  // by client_credentials to target the app's own per-user storage.
  // ---------------------------------------------------------------------
  async function resolveAccountUserId (username: string): Promise<string | null> {
    if (typeof username !== 'string' || username.length === 0) return null;
    const { getUsersLocalIndex } = require('storage');
    const usersIndex = await getUsersLocalIndex();
    const id = await usersIndex.getUserId(username);
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  // ---------------------------------------------------------------------
  // resolveUsername — userId → canonical username, from this core's local
  // index. OAuth2 code / refresh rows carry the user id only (PlatformDB is
  // replicated and must not hold usernames); null when the user is gone.
  // ---------------------------------------------------------------------
  async function resolveUsername (userId: string): Promise<string | null> {
    if (typeof userId !== 'string' || userId.length === 0) return null;
    const { getUsersLocalIndex } = require('storage');
    const usersIndex = await getUsersLocalIndex();
    const name = await usersIndex.getUsername(userId);
    return typeof name === 'string' && name.length > 0 ? name : null;
  }

  // ---------------------------------------------------------------------
  // Grant-specific mint callbacks over mintAccessDirect:
  //   - refresh: the chain is bound to the durable data-grant — re-read
  //     it (revoked → typed throw the grant maps to invalid_grant) and
  //     mint from its CURRENT permissions (scope-updates propagate).
  //   - client_credentials: the app account IS the principal; the
  //     minted access manages the app's OWN per-user storage (cmc
  //     scopes are rejected upstream by the grant).
  // ---------------------------------------------------------------------
  async function mintRefreshedAccess ({ userId, username, clientId, expiresAt, dataGrantAccessId, permissions, jkt }: {
    userId: string;
    username: string;
    clientId: string;
    scope: string[];
    expiresAt: number;
    dataGrantAccessId?: string;
    permissions?: Array<Record<string, unknown>>;
    jkt?: string;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string }> {
    if (dataGrantAccessId == null || !Array.isArray(permissions) || permissions.length === 0) {
      const revoked = new Error('refresh chain carries no consent data-grant binding') as Error & { code: string };
      revoked.code = 'data-grant-revoked';
      throw revoked;
    }
    const dataGrant = await readDataGrantHead(userId, username, dataGrantAccessId);
    // Session grant ∩ data-grant's CURRENT permissions, stream by stream:
    // consent narrowing propagates on refresh (a stream narrowed from
    // `contribute` to `read` is kept at `read`), widening needs a fresh
    // consent, and the grant's forbidden features always reach the session.
    const effective = mergeStreamPermissions(permissions, dataGrant.permissions ?? [], 'meet').permissions;
    // A mask alone (`none`) is no reach.
    const hasReach = effective.some((p: Record<string, unknown>) =>
      typeof p.streamId === 'string' && p.level !== 'none');
    if (!hasReach) {
      const revoked = new Error('consent no longer covers any of this grant\'s permissions') as Error & { code: string };
      revoked.code = 'data-grant-revoked';
      throw revoked;
    }
    // The meet is entry by entry; complete it with the stream tree, as
    // accesses.create does for a child access. A narrower entry of the grant
    // (an exclusion mask or a create-only carve-out the owner added below a
    // stream the session keeps) and a narrower entry of the chain's own
    // consent (a child the grant no longer lists, under a broader parent) are
    // appended at their narrower level. Both passes only narrow, and skip the
    // streams the meet already holds, so their order does not matter. Never
    // creates reach: an entry is appended only under one the session holds.
    await new AccessLogic(userId, dataGrant as Record<string, unknown>).inheritCarveOuts({ permissions: effective });
    await new AccessLogic(userId, { id: 'oauth-refresh-chain', type: 'app', permissions })
      .inheritCarveOuts({ permissions: effective });
    // Session selfRevoke override AFTER the intersection — the intersection
    // compares the chain's granted subset against the data-grant verbatim;
    // the override only shapes the minted session row.
    return mintAccessDirect({ userId, username, clientId, permissions: withSessionSelfRevoke(effective), expiresAt, dataGrantAccessId, ...(jkt != null ? { dpopJkt: jkt } : {}) });
  }

  // ---------------------------------------------------------------------
  // bindAccessDpop — stamp the DPoP key thumbprint onto the access that
  // was pre-minted at /authorize/accept (the proof only appears at
  // /token). Storage-direct read-merge-update so other clientData
  // survives, then cluster-wide cache invalidation: the resource layer
  // must see the binding on the very next request.
  // ---------------------------------------------------------------------
  async function bindAccessDpop ({ userId, username, accessId, jkt }: {
    userId: string; username: string; accessId: string; jkt: string;
  }): Promise<void> {
    const accessesRepository = (storageLayer as { accesses?: AccessesRepo }).accesses;
    if (accessesRepository == null) throw new Error('oauth2.bindAccessDpop: storageLayer.accesses unavailable');
    const user = { id: userId, username };
    const access = await fromCallback((cb: (e: unknown, r: DataGrant | null) => void) =>
      accessesRepository.findOne(user, { id: accessId }, null, cb));
    if (access == null) throw new Error('oauth2.bindAccessDpop: access not found: ' + accessId);
    const existingClientData: Record<string, unknown> = (access.clientData != null && typeof access.clientData === 'object')
      ? { ...access.clientData }
      : {};
    // Pass `modified` so the integrity-aware updateOne recomputes the
    // tamper-evidence hash over the post-update row itself (it skips the
    // recompute when `modified` is absent) — hand-computing the hash here
    // would have to replicate the storage layer's canonicalization.
    await fromCallback((cb: (e: unknown) => void) =>
      accessesRepository.updateOne(user, { id: accessId },
        { clientData: { ...existingClientData, dpop: { jkt } }, modified: Date.now() / 1000 }, cb));
    cache.unsetUserData(userId);
    pubsub.notifications.emit(username, pubsub.USERNAME_BASED_ACCESSES_CHANGED);
  }

  // ---------------------------------------------------------------------
  // resolveAccess / revokeAccessLocal: the authorization_code exchange
  // reads back the access pre-minted at /accept (the code row carries its
  // id, not its token, since the platform store is replicated to every
  // core), and deletes it when the exchange fails after the code was
  // consumed. Storage-direct on this core, which is the issuing core.
  // ---------------------------------------------------------------------
  // Only an OAuth session access of that client qualifies: a code row names an
  // access by id, and must not be able to reach any other access of the user.
  async function findOAuthSessionAccess (userId: string, username: string, accessId: string, clientId: string): Promise<DataGrant | null> {
    const accessesRepository = (storageLayer as { accesses?: AccessesRepo }).accesses;
    if (accessesRepository == null) throw new Error('oauth2: storageLayer.accesses unavailable');
    const access = await fromCallback((cb: (e: unknown, r: DataGrant | null) => void) =>
      accessesRepository.findOne({ id: userId, username }, { id: accessId }, null, cb));
    if (access == null || access.type !== 'app' || access.name !== 'oauth:' + clientId) return null;
    return access;
  }

  async function resolveAccess ({ userId, username, accessId, clientId }: {
    userId: string; username: string; accessId: string; clientId: string;
  }): Promise<{ accessToken: string; apiEndpoint: string } | null> {
    const access = await findOAuthSessionAccess(userId, username, accessId, clientId);
    if (access == null || access.deleted != null || typeof access.token !== 'string') return null;
    if (typeof access.expires === 'number' && access.expires <= Date.now() / 1000) return null;
    // Same builder accesses.create uses, so the exchange returns what /accept minted.
    const ApiEndpoint = require('utils').ApiEndpoint;
    return { accessToken: access.token, apiEndpoint: ApiEndpoint.buildForAccess(access, username) };
  }

  async function revokeAccessLocal ({ userId, username, accessId, clientId }: {
    userId: string; username: string; accessId: string; clientId: string;
  }): Promise<void> {
    const accessesRepository = (storageLayer as { accesses?: AccessesRepo }).accesses;
    if (accessesRepository == null) throw new Error('oauth2.revokeAccessLocal: storageLayer.accesses unavailable');
    if (await findOAuthSessionAccess(userId, username, accessId, clientId) == null) return;
    const user = { id: userId, username };
    await fromCallback((cb: (e: unknown) => void) => accessesRepository.delete(user, { id: accessId }, cb));
    // The cache validates tokens on `expires` only, never `deleted`.
    cache.unsetUserData(userId);
    pubsub.notifications.emit(username, pubsub.USERNAME_BASED_ACCESSES_CHANGED);
  }

  async function mintClientAccess ({ userId, username, clientId, expiresAt }: {
    userId: string; username: string; clientId: string; scope: string[]; expiresAt: number;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string }> {
    // SECURITY POSTURE (by design — not a scope leak): client_credentials
    // acts as the app ITSELF on the app's OWN account (the client row's `accountUserId`),
    // which the app already fully controls by owning it. The minted access is
    // therefore `*/manage` on that one account — NOT an end-user's data and
    // NOT cross-account. The `scope` argument is DELIBERATELY ignored here:
    // for this grant the registered scope tokens are opaque advertisement
    // labels (subset-checked in the grant handler), they do NOT restrict the
    // minted authority. Operators who need a sandboxed server-to-server token
    // (least privilege below the account owner) should provision a separate,
    // narrowly-scoped account rather than expect `scope` to constrain this
    // grant.
    return mintAccessDirect({
      userId,
      username,
      clientId,
      permissions: [{ streamId: '*', level: 'manage' }],
      expiresAt,
    });
  }

  // ---------------------------------------------------------------------
  // revokeChain — collapse a refresh chain on detected reuse, without a
  // MethodContext: delete the durable data-grant + all live oauth session
  // accesses for (user, client) + their descendants through the accesses.delete
  // teardown, invalidate the access cache cluster-wide, then best-effort notify
  // the counterparty app.
  // ---------------------------------------------------------------------
  async function revokeChain ({ userId, username, clientId, dataGrantAccessId }: {
    userId: string; username: string; clientId: string; dataGrantAccessId?: string;
  }): Promise<void> {
    const accessesRepository = (storageLayer as { accesses?: AccessesRepo }).accesses;
    if (accessesRepository == null) throw new Error('oauth2.revokeChain: storageLayer.accesses unavailable');
    const user = { id: userId, username };

    // 1. Read the data-grant head BEFORE deleting (need clientData.cmc for the
    //    notify). Raw null-tolerant findOne — NOT readDataGrantHead, which throws
    //    on exactly the deleted/expired state a revoke must tolerate.
    let dataGrant: DataGrant | null = null;
    if (dataGrantAccessId != null) {
      const base = parseAccessRef(dataGrantAccessId).base;
      dataGrant = await fromCallback((cb: (e: unknown, r: DataGrant | null) => void) =>
        accessesRepository.findOne(user, { id: base }, null, cb));
    }

    // 2. Delete through the teardown accesses.delete uses (accessDeletion.ts):
    //    webhooks stopped, aliases released, breach-scope index tombstoned,
    //    credential URLs scrubbed, cache busted per token. The data-grant goes
    //    first and takes the sessions minted under it with their sub-accesses
    //    (a stolen session can mint shared sub-accesses; leaving them alive =
    //    incomplete revoke); then any live session of this client still left
    //    (minted under another grant of the client, or before sessions named
    //    their grant), with its own sub-accesses.
    if (dataGrant != null && typeof dataGrant.id === 'string' && dataGrant.deleted == null) await deleteOrForce(dataGrant.id);
    for (const id of await liveSessionIds()) await deleteOrForce(id);

    async function liveSessionIds (): Promise<string[]> {
      const sessions: DataGrant[] = (await fromCallback((cb: (e: unknown, r: DataGrant[] | null) => void) =>
        accessesRepository!.find(user, { type: 'app', name: 'oauth:' + clientId, deleted: null }, null, cb))) ?? [];
      return sessions.map((s) => s.id).filter((id): id is string => typeof id === 'string');
    }
    // A failing side effect (a webhook store error) must not leave the chain
    // alive: fall back to the bare soft-delete of the whole chain (the access,
    // what it manages, the grant's sessions and what they created).
    async function deleteOrForce (id: string): Promise<void> {
      try {
        await deleteAccessChain(user, { id });
      } catch (err: unknown) {
        logger.warn('oauth2.revokeChain: teardown of ' + id + ' failed, soft-deleting its chain bare', err);
        let ids = [id];
        try { ids = await accessChainIds(user, id); } catch (readErr: unknown) {
          logger.warn('oauth2.revokeChain: could not read the chain of ' + id + ', soft-deleting it alone', readErr);
        }
        for (const chainId of ids) {
          await fromCallback((cb: (e: unknown) => void) => accessesRepository!.delete(user, { id: chainId }, cb));
        }
      }
    }

    // 3. Cache invalidation (MANDATORY): the cache validates a token on `expires`
    //    only, never `deleted`, so soft-deleted rows keep validating from cache.
    //    unsetUserData clears every access-logic for the user cluster-wide,
    //    covering a row the bare fallback above deleted.
    cache.unsetUserData(userId);
    pubsub.notifications.emit(username, pubsub.USERNAME_BASED_ACCESSES_CHANGED);
    await oauth2.emitAudit('oauth.token.revoked', { clientId, userId, reason: 'refresh-token reuse detected' });

    // 5. CMC back-channel notify (best-effort). The peer ENFORCES an inbound
    //    revoke it accepts (handleIncomingRevoke tears down the back-channel
    //    access it holds), which is what a user-initiated revoke does too: the
    //    data-grant deleted above held this side's only pointer to that access.
    //    apiEndpoint is null until the app completed the back-channel handshake
    //    → skip quietly; delivery failure never rolls back.
    const cmcCd = dataGrant?.clientData?.cmc;
    const apiEndpoint = cmcCd?.counterparty?.apiEndpoint ?? cmcCd?.backChannelApiEndpoint;
    if (dataGrant != null && typeof apiEndpoint === 'string' && apiEndpoint.length > 0) {
      // Same content as a user-initiated revoke (cmc handleRevoke): `accessId`
      // is required by the revoke content schema and `reason` is a localized
      // object, so the peer's inbox accepts the write; the correlation ids let
      // the peer match THIS relationship.
      const revokeContent: Record<string, unknown> = {
        accessId: dataGrant.id,
        from: { username, host: selfHost(username) },
        reason: { en: 'Refresh-token reuse was detected; this consent was revoked.' },
      };
      for (const key of ['appCode', 'offerEventId', 'acceptEventId', 'inviteEventId'] as const) {
        const value = (cmcCd as Record<string, unknown> | undefined)?.[key];
        if (typeof value === 'string') revokeContent[key] = value;
      }
      const revokedScope = cmcRelationshipKey.scopeOfAccess(dataGrant);
      if (typeof revokedScope === 'string') revokeContent.scopeStreamId = revokedScope;
      try {
        // postToPeer returns a discriminated union — it does NOT throw on an HTTP
        // or network failure, so check the result explicitly (the catch only sees
        // apiEndpoint-parse throws). Best-effort: a failed notify never rolls back.
        const delivery = await cmcOutbound.postToPeer({
          apiEndpoint,
          path: 'events',
          body: { streamIds: [':_cmc:inbox'], type: 'consent/revoke-cmc', content: revokeContent },
          deps: { fetch: peerFetch, timeoutMs: 15000, logger },
        });
        if (delivery != null && delivery.ok === false) {
          logger.warn('oauth2.revokeChain: CMC revoke notify not delivered', delivery);
        }
      } catch (err: unknown) { logger.warn('oauth2.revokeChain: CMC revoke notify failed', err); }
    } else {
      logger.debug('oauth2.revokeChain: data-grant has no counterparty apiEndpoint — CMC notify skipped');
    }
  }

  // Self-identity host for the CMC notify `from`, derived like
  // cmcSelfIdentityFor. The per-user `{username}` template (DNS-per-user
  // deploys) resolves to the real name, not a literal placeholder.
  function selfHost (username: string): string {
    return selfIdentityHost(config, username);
  }

  oauth2.registerRoutes(expressApp, {
    config,
    platform: storages.platformDB,
    mintRefreshedAccess,
    mintClientAccess,
    resolveAccountUserId,
    revokeChain,
    bindAccessDpop,
    resolveAccess,
    revokeAccessLocal,
    resolveUsername,
    resolveUser,
    createAccess,
  });
}
