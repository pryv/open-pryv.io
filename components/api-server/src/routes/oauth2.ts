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
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const oauth2 = require('oauth2');
const { getLogger } = require('@pryv/boiler');
const { MethodContext } = require('business');
const storages = require('storages');
// Use @paralleldrive/cuid2 (a production dependency) — the codebase migrated off
// the old `cuid`, which is a devDependency and is pruned by `--omit=dev` builds.
const { createId: cuid } = require('@paralleldrive/cuid2');
// Permission-lexicon single point + composite access refs.
const { permissionKey } = require('business/src/accesses/permissionSet.ts');
const { parseAccessRef } = require('business/src/accesses/refs.ts');
// Tree-aware consent guard: closes the hierarchical-masking gap that the
// pure entry-subset check (checkConsentGrant, run at /accept) cannot see.
const { assertGrantedWithinOffer } = require('business/src/accesses/consentEffectiveGuard.ts');
// Reuse-detection chain-revoke deps (mirror the accesses.delete method chain).
const cache = require('cache').default;
const { pubsub } = require('messages');
const { fromCallback } = require('utils');
const WebhooksRepository = require('business').webhooks.Repository;
// CMC back-channel revoke notify — pure DI HTTP sender, no MethodContext needed.
const { outbound: cmcOutbound } = require('cmc');

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
 */
function withSessionSelfRevoke (permissions: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return permissions
    .filter((p) => p.feature !== 'selfRevoke')
    .concat([{ feature: 'selfRevoke', setting: 'allowed' }]);
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
  token?: unknown;
  permissions?: Array<Record<string, unknown>>;
  deleted?: unknown;
  expires?: number | null;
  createdBy?: unknown;
  // Widened vs the narrow role/offer view: reuse-detection reads the CMC
  // counterparty back-channel address off the data-grant to notify the app.
  clientData?: { cmc?: {
    role?: string; offerEventId?: string; acceptEventId?: string;
    counterparty?: { apiEndpoint?: string };
    backChannelApiEndpoint?: string;
  } };
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
      null,
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
    {
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
        const pollStartedAt = Date.now();
        const deadline = pollStartedAt + 10_000;
        let polls = 0;
        while (dataGrant == null) {
          polls++;
          const all = await apiCall(context, 'accesses.get', {});
          dataGrant = (all?.accesses ?? []).find((a: DataGrant) =>
            a?.clientData?.cmc?.role === 'counterparty' &&
            a?.clientData?.cmc?.acceptEventId === acceptEventId) ?? null;
          if (dataGrant != null) break;
          const trigger = await apiCall(context, 'events.getOne', { id: acceptEventId });
          const content = trigger?.event?.content ?? {};
          if (content.status === 'failed') {
            const failure = content.failure as { reason?: unknown } | undefined;
            throw new Error('oauth2.createAccess: consent accept failed' +
              (failure?.reason != null ? ': ' + failure.reason : ''));
          }
          if (Date.now() > deadline) {
            // Name what we actually saw: how long we waited, how many
            // polls, and the trigger's last known status. A bare "timed
            // out" cannot distinguish a slow dispatch from a lost one.
            throw new Error(
              'oauth2.createAccess: timed out waiting for the consent data-grant after ' +
              (Date.now() - pollStartedAt) + 'ms (' + polls + ' polls, acceptEventId=' +
              acceptEventId + ', last trigger status=' + JSON.stringify(content.status) + ')');
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } else {
        // Re-authorization: widen the data-grant if this consent grants
        // entries the current grant lacks (never narrows — the user
        // manages narrowing via consent scope-update / access update).
        const currentKeys = new Set((dataGrant.permissions ?? []).map(permissionKey));
        const missing = grantedPermissions.filter((g) => !currentKeys.has(permissionKey(g)));
        if (missing.length > 0) {
          const updated = await apiCall(context, 'accesses.update', {
            id: dataGrant.id,
            update: { permissions: (dataGrant.permissions ?? []).concat(missing) },
          });
          if (updated?.access != null) dataGrant = updated.access;
        }
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
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (head == null || head.deleted != null ||
        (typeof head.expires === 'number' && head.expires <= nowSeconds)) {
      const revoked = new Error('consent data-grant revoked or expired') as Error & { code: string };
      revoked.code = 'data-grant-revoked';
      throw revoked;
    }
    return head;
  }

  async function mintAccessDirect ({ userId, username, clientId, permissions, expiresAt, dpopJkt }: {
    userId: string; username: string; clientId: string;
    permissions: Array<Record<string, unknown>>; expiresAt: number;
    dpopJkt?: string;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string }> {
    if (typeof username !== 'string' || username.length === 0) {
      throw new Error('mintAccessDirect: username required');
    }
    const accessesRepository = (storageLayer as { accesses?: AccessesRepo }).accesses;
    if (accessesRepository == null) {
      throw new Error('mintAccessDirect: storageLayer.accesses unavailable');
    }
    const now = Math.floor(Date.now() / 1000);
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
      ...(dpopJkt != null ? { clientData: { dpop: { jkt: dpopJkt } } } : {}),
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
  // Grant-specific mint callbacks over mintAccessDirect:
  //   - refresh: the chain is bound to the durable data-grant — re-read
  //     it (revoked → typed throw the grant maps to invalid_grant) and
  //     mint from its CURRENT permissions (scope-updates propagate).
  //   - client_credentials: the app account IS the principal; the
  //     minted access manages the app's OWN per-user storage (cmc
  //     scopes are rejected upstream by the grant).
  // ---------------------------------------------------------------------
  async function mintRefreshedAccess ({ userId, username, clientId, expiresAt, dataGrantAccessId, permissions, jkt }: {
    userId: string; username: string; clientId: string; scope: string[]; expiresAt: number;
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
    // Session grant ∩ data-grant's CURRENT permissions: consent
    // narrowing propagates on refresh; widening needs a fresh consent.
    const currentKeys = new Set((dataGrant.permissions ?? []).map(permissionKey));
    const effective = permissions.filter((p) => currentKeys.has(permissionKey(p)));
    if (effective.length === 0) {
      const revoked = new Error('consent no longer covers any of this grant\'s permissions') as Error & { code: string };
      revoked.code = 'data-grant-revoked';
      throw revoked;
    }
    // Session selfRevoke override AFTER the intersection — the intersection
    // compares the chain's granted subset against the data-grant verbatim;
    // the override only shapes the minted session row.
    return mintAccessDirect({ userId, username, clientId, permissions: withSessionSelfRevoke(effective), expiresAt, ...(jkt != null ? { dpopJkt: jkt } : {}) });
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
        { clientData: { ...existingClientData, dpop: { jkt } }, modified: Math.floor(Date.now() / 1000) }, cb));
    cache.unsetUserData(userId);
    pubsub.notifications.emit(username, pubsub.USERNAME_BASED_ACCESSES_CHANGED);
  }

  async function mintClientAccess ({ userId, username, clientId, expiresAt }: {
    userId: string; username: string; clientId: string; scope: string[]; expiresAt: number;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string }> {
    // SECURITY POSTURE (by design — not a scope leak): client_credentials
    // acts as the app ITSELF on the app's OWN account (`accountUsername`),
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
  // revokeChain — collapse a refresh chain on detected reuse. Storage-direct:
  // soft-delete the durable data-grant + all live oauth session accesses for
  // (user, client) + their descendants, cascade webhooks, invalidate the access
  // cache cluster-wide, then best-effort notify the counterparty app. Mirrors
  // the accesses.delete method chain's teardown without a MethodContext.
  // ---------------------------------------------------------------------
  async function revokeChain ({ userId, username, clientId, dataGrantAccessId }: {
    userId: string; username: string; clientId: string; dataGrantAccessId?: string;
  }): Promise<void> {
    const sl = storageLayer as { accesses?: AccessesRepo; webhooks?: unknown; events?: unknown };
    const accessesRepository = sl.accesses;
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

    // 2. Collect the delete set: data-grant head + live oauth session accesses +
    //    their descendants (a stolen app session can mint shared sub-accesses;
    //    leaving them alive = incomplete revoke). Dedup by id; skip already-deleted.
    const ids = new Set<string>();
    if (dataGrant != null && typeof dataGrant.id === 'string') ids.add(dataGrant.id);
    const sessions: DataGrant[] = (await fromCallback((cb: (e: unknown, r: DataGrant[] | null) => void) =>
      accessesRepository.find(user, { type: 'app', name: 'oauth:' + clientId, deleted: null }, null, cb))) ?? [];
    for (const s of sessions) if (typeof s.id === 'string') ids.add(s.id);
    for (const id of [...ids]) {
      const kids: DataGrant[] = (await fromCallback((cb: (e: unknown, r: DataGrant[] | null) => void) =>
        accessesRepository.find(user, { createdBy: id, deleted: null }, null, cb))) ?? [];
      for (const k of kids) if (typeof k.id === 'string') ids.add(k.id);
    }
    const idList = [...ids];

    // 3. Webhooks cascade BEFORE the delete (retry-safe), then soft-delete all ids.
    const webhooksRepository = new WebhooksRepository(sl.webhooks, sl.events, sl.accesses);
    for (const id of idList) {
      try { await webhooksRepository.deleteByAccess(user, id); } catch (err: unknown) {
        logger.warn('oauth2.revokeChain: webhook cascade failed for ' + id, err);
      }
    }
    if (idList.length > 0) {
      await fromCallback((cb: (e: unknown) => void) =>
        accessesRepository.delete(user, { $or: idList.map((id) => ({ id })) }, cb));
    }
    // Parity gap vs accesses.delete: it also releases any `randomAlias` reservation
    // carried by a deleted access. Not replicated here — oauth session/app accesses
    // do not mint aliases, and the ALIASES primitive is not shipped, so no alias can
    // leak today. Revisit if aliased descendants become reachable.

    // 4. Cache invalidation (MANDATORY): the cache validates a token on `expires`
    //    only, never `deleted`, so soft-deleted rows keep validating from cache.
    //    unsetUserData clears every access-logic for the user cluster-wide,
    //    covering sessions + descendants + the data-grant head (app-held token).
    cache.unsetUserData(userId);
    pubsub.notifications.emit(username, pubsub.USERNAME_BASED_ACCESSES_CHANGED);
    await oauth2.emitAudit('oauth.token.revoked', { clientId, userId, reason: 'refresh-token reuse detected' });

    // 5. CMC back-channel notify (best-effort; informational — the peer applies no
    //    teardown to an inbound counterparty-role revoke, it learns at its next
    //    failing refresh). apiEndpoint is null until the app completed the
    //    back-channel handshake → skip quietly; delivery failure never rolls back.
    const cmcCd = dataGrant?.clientData?.cmc;
    const apiEndpoint = cmcCd?.counterparty?.apiEndpoint ?? cmcCd?.backChannelApiEndpoint;
    if (typeof apiEndpoint === 'string' && apiEndpoint.length > 0) {
      try {
        // postToPeer returns a discriminated union — it does NOT throw on an HTTP
        // or network failure, so check the result explicitly (the catch only sees
        // apiEndpoint-parse throws). Best-effort: a failed notify never rolls back.
        const delivery = await cmcOutbound.postToPeer({
          apiEndpoint,
          path: 'events',
          body: { streamIds: [':_cmc:inbox'], type: 'consent/revoke-cmc', content: { from: { username, host: selfHost(username) }, reason: 'refresh-token-reuse' } },
          deps: { fetch: (u: string, i: unknown) => globalThis.fetch(u, i as RequestInit), timeoutMs: 15000, logger },
        });
        if (delivery != null && delivery.ok === false) {
          logger.warn('oauth2.revokeChain: CMC revoke notify not delivered', delivery);
        }
      } catch (err: unknown) { logger.warn('oauth2.revokeChain: CMC revoke notify failed', err); }
    } else {
      logger.debug('oauth2.revokeChain: data-grant has no counterparty apiEndpoint — CMC notify skipped');
    }
  }

  // Self-identity host for the CMC notify `from` — mirrors cmcSelfIdentityFor:
  // dns.domain → host of service.api/register → localhost. Resolve the per-user
  // `{username}` template (DNS-per-user deploys) so the host is a real name, not
  // a literal placeholder (new URL('https://{username}.pryv.me/') does not throw).
  function selfHost (username: string): string {
    const sub = (v: string): string => v.replace('{username}', username);
    const dnsDomain = config.get('dns:domain');
    if (typeof dnsDomain === 'string' && dnsDomain.length > 0) return sub(dnsDomain);
    for (const key of ['service:api', 'service:register']) {
      const url = config.get(key);
      if (typeof url === 'string' && url.length > 0) {
        try { return new URL(sub(url)).host; } catch { /* try next */ }
      }
    }
    return 'localhost';
  }

  oauth2.registerRoutes(expressApp, {
    config,
    platform: storages.platformDB,
    mintRefreshedAccess,
    mintClientAccess,
    resolveAccountUserId,
    revokeChain,
    bindAccessDpop,
    resolveUser,
    createAccess,
  });
}
