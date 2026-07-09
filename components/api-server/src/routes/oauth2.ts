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
const { MethodContext } = require('business');
const storages = require('storages');
const cuid = require('cuid');
// Permission-lexicon single point + composite access refs.
const { permissionKey } = require('business/src/accesses/permissionSet.ts');
const { parseAccessRef } = require('business/src/accesses/refs.ts');

/** Trigger-scope parent for OAuth-driven CMC accepts on the user's account. */
const OAUTH_CMC_PARENT = ':_cmc:apps:oauth';

// Map a coarse OAuth scope token to a Pryv permission entry on the
// `*` wildcard stream id. This matches how /reg/access typically
// grants top-level scope (read/contribute/manage on all streams);
// finer-grained scope grammars can layer on later via the scope
// registry's pluggable parsers.
function scopeToPermission (scopeToken: string): { streamId: string; level: string } | null {
  if (scopeToken === 'pryv:read') return { streamId: '*', level: 'read' };
  if (scopeToken === 'pryv:write') return { streamId: '*', level: 'contribute' };
  if (scopeToken === 'pryv:manage') return { streamId: '*', level: 'manage' };
  return null;
}

function scopesToPermissions (scope: string[]): Array<{ streamId: string; level: string }> {
  const perms: Array<{ streamId: string; level: string }> = [];
  for (const s of scope) {
    const p = scopeToPermission(s);
    if (p != null) perms.push(p);
  }
  return perms;
}

export default function mountOAuth2 (expressApp: ExpressApp, app: AppLike): void {
  const config = app.config;
  const storageLayer = app.storageLayer;
  const api = app.api;

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
      return null;
    }
    if (context.access == null) return null;
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

    let permissions: Array<Record<string, unknown>>;
    let dataGrant: any = null;
    if (offer != null) {
      if (!Array.isArray(grantedPermissions) || grantedPermissions.length === 0) {
        throw new Error('oauth2.createAccess: granular grant requires grantedPermissions');
      }
      if (offer.offerEventId != null) {
        dataGrant = await findDataGrantByOffer(context, offer.offerEventId);
      }
      if (dataGrant == null) {
        // First authorization: drive the real CMC accept.
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
        const content = created?.event?.content ?? {};
        if (content.status === 'failed' || typeof content.dataGrantAccessId !== 'string') {
          throw new Error('oauth2.createAccess: consent accept failed' +
            (content.failure?.reason != null ? ': ' + content.failure.reason : ''));
        }
        dataGrant = await findDataGrantByOffer(context, offer.offerEventId ?? '');
        if (dataGrant == null) {
          // Cross-check by the id the plugin reported (offer id absent).
          const all = await apiCall(context, 'accesses.get', {});
          dataGrant = (all?.accesses ?? []).find((a: any) => a?.id === content.dataGrantAccessId) ?? null;
        }
        if (dataGrant == null) {
          throw new Error('oauth2.createAccess: data-grant not found after consent accept');
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
      permissions = dataGrant.permissions;
    } else {
      permissions = scopesToPermissions(scope);
    }

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
      ...(dataGrant != null ? { dataGrantAccessId: dataGrant.id, permissions } : {}),
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

  async function mintAccessDirect ({ userId, username, clientId, scope, expiresAt, dataGrantAccessId }: {
    userId: string; username: string; clientId: string; scope: string[]; expiresAt: number;
    dataGrantAccessId?: string;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string }> {
    if (typeof username !== 'string' || username.length === 0) {
      throw new Error('mintAccessDirect: username required');
    }
    const accessesRepository = (storageLayer as any).accesses;
    if (accessesRepository == null) {
      throw new Error('mintAccessDirect: storageLayer.accesses unavailable');
    }
    // Granular grants re-read the durable data-grant: revoked → the
    // refresh chain dies; alive → mint from its CURRENT permissions
    // (consent scope-updates propagate on refresh).
    let permissions;
    if (dataGrantAccessId != null) {
      const dataGrant = await readDataGrantHead(userId, username, dataGrantAccessId);
      permissions = dataGrant.permissions;
    } else {
      permissions = scopesToPermissions(scope);
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

  oauth2.registerRoutes(expressApp, {
    config,
    platform: storages.platformDB,
    mintRefreshedAccess: mintAccessDirect,
    mintClientAccess: mintAccessDirect,
    resolveAccountUserId,
    resolveUser,
    createAccess,
  });
}
