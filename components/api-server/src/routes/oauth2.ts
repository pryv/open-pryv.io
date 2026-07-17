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
const cuid = require('cuid');
// Permission-lexicon single point + composite access refs.
const { permissionKey } = require('business/src/accesses/permissionSet.ts');
const { parseAccessRef } = require('business/src/accesses/refs.ts');
// Tree-aware consent guard: closes the hierarchical-masking gap that the
// pure entry-subset check (checkConsentGrant, run at /accept) cannot see.
const { assertGrantedWithinOffer } = require('business/src/accesses/consentEffectiveGuard.ts');

/** Trigger-scope parent for OAuth-driven CMC accepts on the user's account. */
const OAUTH_CMC_PARENT = ':_cmc:apps:oauth';

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
    const context: any = new MethodContext(
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
  async function apiCall (context: any, methodId: string, params: Record<string, unknown>): Promise<any> {
    context.methodId = methodId;
    return await new Promise((resolve, reject) => {
      api.call(context, params, (err: unknown, result: any) => {
        if (err != null) return reject(err);
        resolve(result);
      });
    });
  }

  // Idempotent streams.create — swallows "already exists" only.
  async function ensureStream (context: any, id: string, parentId: string, name: string): Promise<void> {
    try {
      await apiCall(context, 'streams.create', { id, parentId, name });
    } catch (err: any) {
      const errId = err?.id ?? err?.data?.id;
      if (errId === 'item-already-exists') return;
      throw err;
    }
  }

  // The durable consent record for a granular OAuth grant is the CMC
  // data-grant on the user's account, keyed by the offer event id.
  async function findDataGrantByOffer (context: any, offerEventId: string): Promise<any | null> {
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
    session: { userId: string; username: string; [k: string]: unknown };
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
    const context: any = session._context;
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

    let dataGrant: any = null;
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
          dataGrant = (all?.accesses ?? []).find((a: any) =>
            a?.clientData?.cmc?.role === 'counterparty' &&
            a?.clientData?.cmc?.acceptEventId === acceptEventId) ?? null;
          if (dataGrant != null) break;
          const trigger = await apiCall(context, 'events.getOne', { id: acceptEventId });
          const content = trigger?.event?.content ?? {};
          if (content.status === 'failed') {
            throw new Error('oauth2.createAccess: consent accept failed' +
              (content.failure?.reason != null ? ': ' + content.failure.reason : ''));
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
        const missing = grantedPermissions.filter((g) => !currentKeys.has(permissionKey(g as any)));
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
    // governs.
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
      permissions,
      expireAfter,
    };
    const result = await apiCall(context, 'accesses.create', params);
    const a = result?.access;
    if (a == null || typeof a.id !== 'string' || typeof a.token !== 'string') {
      throw new Error('oauth2.createAccess: accesses.create returned no usable access');
    }
    return {
      accessId: a.id,
      accessToken: a.token,
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
  async function readDataGrantHead (userId: string, username: string, dataGrantAccessId: string): Promise<any> {
    const accessesRepository = (storageLayer as any).accesses;
    const base = parseAccessRef(dataGrantAccessId).base;
    const head: any = await new Promise((resolve, reject) => {
      accessesRepository.findOne({ id: userId, username }, { id: base }, null,
        (err: unknown, found: unknown) => (err != null ? reject(err) : resolve(found)));
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (head == null || head.deleted != null ||
        (typeof head.expires === 'number' && head.expires <= nowSeconds)) {
      const revoked: any = new Error('consent data-grant revoked or expired');
      revoked.code = 'data-grant-revoked';
      throw revoked;
    }
    return head;
  }

  async function mintAccessDirect ({ userId, username, clientId, permissions, expiresAt }: {
    userId: string; username: string; clientId: string;
    permissions: Array<Record<string, unknown>>; expiresAt: number;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string }> {
    if (typeof username !== 'string' || username.length === 0) {
      throw new Error('mintAccessDirect: username required');
    }
    const accessesRepository = (storageLayer as any).accesses;
    if (accessesRepository == null) {
      throw new Error('mintAccessDirect: storageLayer.accesses unavailable');
    }
    const now = Math.floor(Date.now() / 1000);
    const newToken = accessesRepository.generateToken();
    const newAccessRow: any = {
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
    };
    const ApiEndpoint = require('utils').ApiEndpoint;
    return await new Promise((resolve, reject) => {
      accessesRepository.insertOne({ id: userId, username }, newAccessRow,
        (err: any, newAccess: any) => {
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
  async function mintRefreshedAccess ({ userId, username, clientId, expiresAt, dataGrantAccessId, permissions }: {
    userId: string; username: string; clientId: string; scope: string[]; expiresAt: number;
    dataGrantAccessId?: string;
    permissions?: Array<Record<string, unknown>>;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string }> {
    if (dataGrantAccessId == null || !Array.isArray(permissions) || permissions.length === 0) {
      const revoked: any = new Error('refresh chain carries no consent data-grant binding');
      revoked.code = 'data-grant-revoked';
      throw revoked;
    }
    const dataGrant = await readDataGrantHead(userId, username, dataGrantAccessId);
    // Session grant ∩ data-grant's CURRENT permissions: consent
    // narrowing propagates on refresh; widening needs a fresh consent.
    const currentKeys = new Set((dataGrant.permissions ?? []).map(permissionKey));
    const effective = permissions.filter((p) => currentKeys.has(permissionKey(p as any)));
    if (effective.length === 0) {
      const revoked: any = new Error('consent no longer covers any of this grant\'s permissions');
      revoked.code = 'data-grant-revoked';
      throw revoked;
    }
    return mintAccessDirect({ userId, username, clientId, permissions: effective, expiresAt });
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

  oauth2.registerRoutes(expressApp, {
    config,
    platform: storages.platformDB,
    mintRefreshedAccess,
    mintClientAccess,
    resolveAccountUserId,
    resolveUser,
    createAccess,
  });
}
