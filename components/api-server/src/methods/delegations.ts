/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Account-delegation method family (`delegations.*`).
 *
 * Wires the plugin's pure handshake orchestration (components/delegation) to
 * the api-server: mall access, identity resolution through the platform layer,
 * and cross-core delivery (admin-key system endpoint for the invite; bearer
 * marker-access method calls for everything after it — see the delivery note in
 * components/delegation/src/attach.ts).
 *
 * Client-facing methods require a personal token (delegate PATs count as
 * personal here — the detach-only genuine-login distinction lands in a later
 * phase). Controlled-side methods (accept/refuse response) authorize purely on
 * the forge-protected `clientData.delegation` marker of the calling access.
 */

const APIError = require('errors').APIError;
const errors = require('errors').factory;
const commonFns = require('./helpers/commonFunctions.ts');
const { getLogger, ready } = require('@pryv/boiler');
const { getUsersRepository } = require('business/src/users/index.ts');
const { getPlatform } = require('platform');
const { buildMallForCmc } = require('./helpers/cmcMall.ts');
const cmc = require('cmc');
const delegation = require('delegation');

import type { MethodNext } from './_types.ts';
import type { MethodContext as BaseMethodContext } from 'business/src/MethodContext.ts';
type MethodContext = BaseMethodContext & {
  access?: { isPersonal?: () => boolean; clientData?: { delegation?: { kind?: string; relId?: string } } | null } | null;
};

const DEFAULT_INVITE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function nowSeconds (): number { return Math.floor(Date.now() / 1000); }
function newRelId (): string { return require('cuid')(); }

/** Duck-typed guard for the plugin's DelegationError (crosses an untyped CJS boundary). */
function isDelegationErr (e: unknown): e is { id: string; message: string; httpStatus: number; data?: unknown } {
  return e != null && typeof (e as { id?: unknown }).id === 'string' && typeof (e as { httpStatus?: unknown }).httpStatus === 'number';
}

/** Convert a plugin DelegationError into an api-server APIError. */
function toApiError (err: unknown): Error {
  if (isDelegationErr(err)) {
    return new APIError(err.id, err.message, { httpStatus: err.httpStatus, data: err.data });
  }
  if (err instanceof Error) return errors.unexpectedError(err);
  return errors.unexpectedError(new Error(String(err)));
}

export default async function produceDelegationsApiMethods (api: { register (...args: unknown[]): unknown }): Promise<void> {
  const config = await ready();
  const logger = getLogger('methods:delegations');

  const delegationActive = config.get('delegation:active') !== false;
  if (!delegationActive) {
    logger.info('delegation:active is false — delegations.* methods are not registered');
    return;
  }

  const mall = await buildMallForCmc();
  const usersRepository = await getUsersRepository();
  const platform = await getPlatform();
  const adminAccessKey = config.get('auth:adminAccessKey');
  const slugifyHost: (h: string) => string = cmc.slug.slugifyHost;
  const postToPeer = cmc.postToPeer;
  const thisCoreId = config.get('core:id');

  // ---- identity -----------------------------------------------------------

  async function selfHost (): Promise<string> {
    let host = config.get('dns:domain') as string | undefined;
    if (host == null || host === '') {
      const apiUrl = (config.get('service:api') || config.get('service:register')) as string | undefined;
      if (typeof apiUrl === 'string' && apiUrl.length > 0) {
        try { host = new URL(apiUrl.replace('{username}', 'x')).host; } catch (_e) { /* fallthrough */ }
      }
    }
    if (host == null || host === '') host = 'localhost';
    return host;
  }

  async function selfIdentity (username: string): Promise<{ username: string; host: string; hostSlug: string }> {
    const host = await selfHost();
    return { username, host, hostSlug: slugifyHost(host) };
  }

  async function localUserId (username: string): Promise<string | null> {
    try {
      const id = await usersRepository.getUserIdForUsername(username);
      return id ?? null;
    } catch (_e) { return null; }
  }

  /**
   * Resolve a username to its owning account on this platform. Single-core
   * collapses to a local lookup. Cross-core derivation is best-effort from the
   * platform core registry.
   */
  async function resolveTarget (username: string): Promise<{ found: boolean; isSelf: boolean; userId?: string; hostSlug: string; host: string; coreBaseUrl?: string }> {
    const self = await selfHost();
    if (platform.isSingleCore) {
      const id = await localUserId(username);
      return { found: id != null, isSelf: true, userId: id ?? undefined, hostSlug: slugifyHost(self), host: self };
    }
    const coreId = await platform.getUserCore(username);
    if (coreId == null) {
      return { found: false, isSelf: false, hostSlug: slugifyHost(self), host: self };
    }
    if (thisCoreId != null && coreId === thisCoreId) {
      const id = await localUserId(username);
      return { found: id != null, isSelf: true, userId: id ?? undefined, hostSlug: slugifyHost(self), host: self };
    }
    // Cross-core: derive the peer core's base URL + host from the registry.
    const info = (await platform.getCoreInfo(coreId)) as { baseUrl?: string; url?: string; host?: string } | null;
    const coreBaseUrl = info?.baseUrl || info?.url || null;
    const host = info?.host || (coreBaseUrl != null ? safeHost(coreBaseUrl) : null);
    if (coreBaseUrl == null || host == null) {
      throw delegation.attach.delegationError(
        delegation.errorIds.DelegationErrorIds.UNKNOWN_CORE,
        'Could not resolve the delegate account core endpoint', 400);
    }
    return { found: true, isSelf: false, hostSlug: slugifyHost(host), host, coreBaseUrl };
  }

  function safeHost (url: string): string | null {
    try { return new URL(url).host; } catch (_e) { return null; }
  }

  // ---- cross-core delivery ------------------------------------------------

  function makeDeliverInvite () {
    return async function deliverInvite (target: { isSelf: boolean; coreBaseUrl?: string }, payload: Record<string, unknown>) {
      if (target.isSelf) {
        try {
          const res = await delegation.handleSystemInvite(
            { mall, now: nowSeconds, resolveLocalUserId: localUserId },
            payload);
          return { ok: true, status: 200, body: res };
        } catch (err) {
          if (isDelegationErr(err)) return { ok: false, status: err.httpStatus, body: { id: err.id } };
          throw err;
        }
      }
      // cross-core: admin-key gated system endpoint.
      const base = String(target.coreBaseUrl).replace(/\/$/, '');
      const res = await fetch(base + '/system/delegation/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: String(adminAccessKey) },
        body: JSON.stringify(payload),
      });
      let body: unknown = null;
      try { body = await res.json(); } catch (_e) { body = null; }
      return { ok: res.ok, status: res.status, body };
    };
  }

  /**
   * Build the controlled-side caller for a given controlled account. Same-core
   * dispatches directly to the plugin handler (no HTTP); cross-core posts to
   * the controlled account's core via the capability bearer endpoint.
   */
  function makeCallControlledSide (controlledUsername: string) {
    return async function callControlledSide (endpoint: string, action: 'accept-response' | 'refuse-response' | 'accept-complete', body: Record<string, unknown>) {
      const target = await resolveTarget(controlledUsername);
      if (target.isSelf && target.userId != null) {
        const deps = { mall, now: nowSeconds };
        try {
          if (action === 'accept-response') {
            const res = await delegation.handleAcceptResponse(deps, { bUserId: target.userId, ...(body as object) } as never);
            return { ok: true, status: 200, body: res };
          }
          if (action === 'accept-complete') {
            const res = await delegation.handleAcceptComplete(deps, { bUserId: target.userId, ...(body as object) } as never);
            return { ok: true, status: 200, body: res };
          }
          const res = await delegation.handleRefuseResponse(deps, { bUserId: target.userId, ...(body as object) } as never);
          return { ok: true, status: 200, body: res };
        } catch (err) {
          if (isDelegationErr(err)) return { ok: false, status: err.httpStatus, body: { id: err.id } };
          throw err;
        }
      }
      const r = await postToPeer({
        apiEndpoint: endpoint,
        path: 'delegations/controlled-side/' + action,
        body,
        deps: { fetch, logger: getLogger('delegations:outbound') },
      });
      if (r.ok) return { ok: true, status: r.status, body: r.body };
      return { ok: false, status: r.status, body: (r as { body?: unknown }).body ?? null };
    };
  }

  // ---- marker gate for controlled-side methods ----------------------------

  function requireMarker (kind: string) {
    return function delegationMarkerGate (context: MethodContext, _params: unknown, _result: unknown, next: MethodNext) {
      const marker = context?.access?.clientData?.delegation;
      if (marker == null || marker.kind !== kind) {
        return next(errors.invalidAccessToken('This method requires a valid delegation ' + kind + ' credential', 403));
      }
      next();
    };
  }

  // ======================================================= client-facing

  // requestAttach (B)
  api.register('delegations.requestAttach',
    commonFns.requirePersonalAccess,
    async function (context: MethodContext, params: { delegateUsername?: string }, result: Record<string, unknown>, next: MethodNext) {
      try {
        const self = await selfIdentity(context.user.username);
        const deps = {
          mall, now: nowSeconds, idGen: newRelId, self,
          inviteTtlSeconds: DEFAULT_INVITE_TTL_SECONDS,
          resolveTarget,
          deliverInvite: makeDeliverInvite(),
        };
        const delegationResult = await delegation.requestAttach(deps, {
          bUserId: context.user.id,
          bUsername: context.user.username,
          delegateUsername: String(params.delegateUsername || ''),
        });
        result.delegation = delegationResult;
        next();
      } catch (err) { next(toApiError(err)); }
    });

  // acceptAttach (A)
  api.register('delegations.acceptAttach',
    commonFns.requirePersonalAccess,
    async function (context: MethodContext, params: { username?: string }, result: Record<string, unknown>, next: MethodNext) {
      try {
        const controlledUsername = String(params.username || '');
        const self = await selfIdentity(context.user.username);
        const deps = {
          mall, now: nowSeconds, idGen: newRelId, self,
          callControlledSide: makeCallControlledSide(controlledUsername),
        };
        const delegationResult = await delegation.acceptAttach(deps, {
          aUserId: context.user.id, aUsername: context.user.username, controlledUsername,
        });
        result.delegation = delegationResult;
        next();
      } catch (err) { next(toApiError(err)); }
    });

  // refuseAttach (A)
  api.register('delegations.refuseAttach',
    commonFns.requirePersonalAccess,
    async function (context: MethodContext, params: { username?: string }, result: Record<string, unknown>, next: MethodNext) {
      try {
        const controlledUsername = String(params.username || '');
        const self = await selfIdentity(context.user.username);
        const deps = {
          mall, now: nowSeconds, idGen: newRelId, self,
          callControlledSide: makeCallControlledSide(controlledUsername),
        };
        await delegation.refuseAttach(deps, { aUserId: context.user.id, controlledUsername });
        next();
      } catch (err) { next(toApiError(err)); }
    });

  // cancelInvite (B) — invite-status only
  api.register('delegations.cancelInvite',
    commonFns.requirePersonalAccess,
    async function (context: MethodContext, params: { username?: string }, result: Record<string, unknown>, next: MethodNext) {
      try {
        const self = await selfIdentity(context.user.username);
        const deps = { mall, now: nowSeconds, self, resolveTarget, deliverInvite: makeDeliverInvite() };
        await delegation.cancelInvite(deps, {
          bUserId: context.user.id, bUsername: context.user.username,
          delegateUsername: String(params.username || ''),
        });
        next();
      } catch (err) { next(toApiError(err)); }
    });

  // listDelegates (B)
  api.register('delegations.listDelegates',
    commonFns.requirePersonalAccess,
    async function (context: MethodContext, _params: unknown, result: Record<string, unknown>, next: MethodNext) {
      try {
        const r = await delegation.listDelegates(mall, context.user.id);
        result.delegates = r.delegates;
        next();
      } catch (err) { next(toApiError(err)); }
    });

  // listControlled (A)
  api.register('delegations.listControlled',
    commonFns.requirePersonalAccess,
    async function (context: MethodContext, _params: unknown, result: Record<string, unknown>, next: MethodNext) {
      try {
        const r = await delegation.listControlled(mall, context.user.id);
        result.controlled = r.controlled;
        next();
      } catch (err) { next(toApiError(err)); }
    });

  // ======================================================= controlled-side

  // acceptResponse — A's core → B's core (bearer = invite capability)
  api.register('delegations.acceptResponse',
    requireMarker('invite-capability'),
    async function (context: MethodContext, params: { relId?: string; delegate?: { username: string; hostSlug: string }; notifyApiEndpoint?: string }, result: Record<string, unknown>, next: MethodNext) {
      try {
        const relId = context.access?.clientData?.delegation?.relId ?? params.relId;
        const res = await delegation.handleAcceptResponse({ mall, now: nowSeconds }, {
          bUserId: context.user.id,
          relId: String(relId),
          delegate: params.delegate!,
          notifyApiEndpoint: params.notifyApiEndpoint,
        });
        Object.assign(result, res);
        next();
      } catch (err) { next(toApiError(err)); }
    });

  // refuseResponse — A's core → B's core (bearer = invite capability)
  api.register('delegations.refuseResponse',
    requireMarker('invite-capability'),
    async function (context: MethodContext, params: { relId?: string }, result: Record<string, unknown>, next: MethodNext) {
      try {
        const relId = context.access?.clientData?.delegation?.relId ?? params.relId;
        const res = await delegation.handleRefuseResponse({ mall, now: nowSeconds }, {
          bUserId: context.user.id, relId: String(relId),
        });
        Object.assign(result, res);
        next();
      } catch (err) { next(toApiError(err)); }
    });

  // acceptComplete — A's core → B's core (bearer = invite capability). Best-effort
  // capability GC after A commits its mirror; idempotent (already gone → ok).
  api.register('delegations.acceptComplete',
    requireMarker('invite-capability'),
    async function (context: MethodContext, params: { relId?: string }, result: Record<string, unknown>, next: MethodNext) {
      try {
        const relId = context.access?.clientData?.delegation?.relId ?? params.relId;
        const res = await delegation.handleAcceptComplete({ mall, now: nowSeconds }, {
          bUserId: context.user.id, relId: String(relId),
        });
        Object.assign(result, res);
        next();
      } catch (err) { next(toApiError(err)); }
    });

  logger.debug('delegations.* methods registered');
}
