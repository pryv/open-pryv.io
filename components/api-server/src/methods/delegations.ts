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
const { getStorageLayer } = require('storage');
const { fromCallback } = require('utils');
const { buildMallForCmc } = require('./helpers/cmcMall.ts');
const { buildSystemCreateAccountDeps } = require('./helpers/delegationAccounts.ts');
const cmc = require('cmc');
const delegation = require('delegation');
// Production id generator (the legacy `cuid` package is dev-only and is pruned
// from production builds; `@paralleldrive/cuid2` is the shipped dependency).
const { createId: createCuid } = require('@paralleldrive/cuid2');

import type { MethodNext } from './_types.ts';
import type { MethodContext as BaseMethodContext } from 'business/src/MethodContext.ts';
type MethodContext = BaseMethodContext & {
  access?: { isPersonal?: () => boolean; clientData?: { delegation?: { kind?: string; relId?: string; delegate?: { username?: string; hostSlug?: string } } } | null } | null;
};

const DEFAULT_INVITE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function nowSeconds (): number { return Math.floor(Date.now() / 1000); }
function newRelId (): string { return createCuid(); }

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
  const storageLayer = await getStorageLayer();
  const sessionsStorage = storageLayer.sessions;
  const adminAccessKey = config.get('auth:adminAccessKey');
  const slugifyHost: (h: string) => string = cmc.slug.slugifyHost;
  const postToPeer = cmc.postToPeer;
  const thisCoreId = config.get('core:id');

  // Audit singleton (only when auditing is on). Used to record a
  // controlled-side token issuance on the SAME-CORE dispatch path, which does
  // not pass through the audited method wrapper (the cross-core path does, so
  // its issuance is audited automatically). Kept behind the flag so the direct
  // dispatch stays audit-parity with cross-core.
  const isAuditActive = config.get('audit:active') === true;
  const audit = isAuditActive ? require('audit').default : null;
  const noopTracing = {
    startSpan (_n: string): void {},
    finishSpan (_n: string): void {},
    logForSpan (_n: string, _ctx: Record<string, unknown>): void {},
  };

  /**
   * Record a `delegations.issueToken` audit event on the controlled account (B)
   * for a SAME-CORE issuance. Mirrors the record the cross-core method wrapper
   * writes: same methodId, attributed to B's control access (so the delegate
   * identity is stamped from its marker). Best-effort — a failed audit-write
   * must not fail the token issuance the caller already completed.
   */
  async function recordSameCoreIssueTokenAudit (bUserId: string, relId: string): Promise<void> {
    if (audit == null) return;
    try {
      const controlAccess = await delegation.store.findMarkerAccess(mall, bUserId, relId, 'control');
      if (controlAccess == null) return;
      const context = {
        methodId: 'delegations.issueToken',
        user: { id: bUserId },
        access: { id: controlAccess.id, clientData: controlAccess.clientData },
        tracing: noopTracing,
        source: { name: 'delegation-same-core' },
        originalQuery: {},
      };
      await audit.validApiCall(context, {});
    } catch (err) {
      logger.warn('same-core issueToken audit-write failed (continuing)', {
        error: String((err as Error)?.message || err),
      });
    }
  }

  /**
   * Reuse-or-generate a session for {username, appId} and return its id — the
   * exact login-flow behaviour (sessionsStorage.getMatching else generate). The
   * returned id becomes the delegate PAT token, so a re-issue for the same
   * delegate returns the SAME token while the session is alive.
   */
  async function mintSession (username: string, appId: string): Promise<string> {
    const sessionData = { username, appId };
    const existing = await fromCallback((cb: (e: unknown, id: string | null) => void) => sessionsStorage.getMatching(sessionData, cb)) as string | null;
    if (existing != null) return existing;
    return await fromCallback((cb: (e: unknown, id: string) => void) => sessionsStorage.generate(sessionData, null, cb)) as string;
  }

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
    // Cross-core: resolve the peer core's public URL through the platform
    // helper, which knows the explicit `core.url` a peer advertises through its
    // registry row and otherwise derives the URL from `core.id + dns.domain`.
    // Reading the registry row here instead would only ever see an explicit
    // `core.url`, which neither the config wizard nor the bootstrap bundle
    // writes — that made every cross-core call fail on a normal dns-active
    // deployment. `resolveTargetCore()` below already went through the helper.
    const coreBaseUrl = platform.coreIdToUrl(coreId);
    const host = safeHost(coreBaseUrl);
    // The helper falls back to THIS core's own URL when it can resolve neither
    // (no cached peer url, no domain). Delivering a cross-core invite to
    // ourselves would be worse than refusing it, so "resolved to self" counts
    // as unresolved: we already know coreId is not this core.
    const selfBaseUrl = thisCoreId != null ? platform.coreIdToUrl(thisCoreId) : null;
    if (host == null || (selfBaseUrl != null && coreBaseUrl === selfBaseUrl)) {
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
   * Validate + resolve the target core for a create-from-delegate request. An
   * absent/empty `core` param defaults to A's own core. A provided `core` is
   * validated against the platform core registry (its id or URL); an unknown
   * value → delegation-unknown-core (400). Single-core accepts only its own core
   * id/url.
   */
  async function resolveTargetCore (core: string | undefined): Promise<{ isSelf: boolean; hostSlug: string; host: string; coreBaseUrl?: string }> {
    const self = await selfHost();
    const selfRes = { isSelf: true, hostSlug: slugifyHost(self), host: self };
    const wanted = String(core ?? '').trim();
    if (wanted.length === 0) return selfRes;

    if (platform.isSingleCore) {
      if (wanted === thisCoreId || wanted === platform.coreId || wanted === platform.coreIdToUrl(platform.coreId)) {
        return selfRes;
      }
      throw delegation.attach.delegationError(
        delegation.errorIds.DelegationErrorIds.UNKNOWN_CORE,
        'Unknown target core "' + wanted + '"', 400);
    }

    const cores = (await platform.getAllCoreInfos()) as Array<{ id: string }>;
    const match = cores.find((c) => c.id === wanted || platform.coreIdToUrl(c.id) === wanted);
    if (match == null) {
      throw delegation.attach.delegationError(
        delegation.errorIds.DelegationErrorIds.UNKNOWN_CORE,
        'Unknown target core "' + wanted + '"', 400);
    }
    if (thisCoreId != null && match.id === thisCoreId) return selfRes;
    const coreBaseUrl = platform.coreIdToUrl(match.id);
    const host = safeHost(coreBaseUrl) ?? self;
    return { isSelf: false, hostSlug: slugifyHost(host), host, coreBaseUrl };
  }

  /**
   * Build the create-account deliverer. Same-core dispatches directly to the
   * plugin's target-core handler (no HTTP), reusing this core's provision/rollback
   * deps; cross-core posts to the admin-key-gated system endpoint.
   */
  function makeCallCreateAccount () {
    return async function callCreateAccount (target: { isSelf: boolean; coreBaseUrl?: string }, payload: Record<string, unknown>) {
      if (target.isSelf) {
        try {
          const sysDeps = await buildSystemCreateAccountDeps();
          const res = await delegation.handleSystemCreateAccount(sysDeps, payload);
          return { ok: true, status: 200, body: res };
        } catch (err) {
          if (isDelegationErr(err)) return { ok: false, status: err.httpStatus, body: { id: err.id } };
          throw err;
        }
      }
      const base = String(target.coreBaseUrl).replace(/\/$/, '');
      const res = await fetch(base + '/system/delegation/create-account', {
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

  /**
   * Build the detach-notify caller for a controlled account's B→A mirror-sync.
   * Same-core dispatches directly to the A-side handler; cross-core posts to A's
   * notify endpoint (bearer = the notify marker access). Best-effort: the caller
   * swallows failure and A reconciles the mirror lazily.
   */
  function makeNotifyDetach (delegateUsername: string) {
    return async function notifyDetach (notifyApiEndpoint: string, relId: string) {
      const target = await resolveTarget(delegateUsername);
      if (target.isSelf && target.userId != null) {
        try {
          const res = await delegation.handleDetachNotify({ mall, now: nowSeconds }, { aUserId: target.userId, relId });
          return { ok: true, status: 200, body: res };
        } catch (err) {
          if (isDelegationErr(err)) return { ok: false, status: err.httpStatus, body: { id: err.id } };
          throw err;
        }
      }
      const r = await postToPeer({
        apiEndpoint: notifyApiEndpoint,
        path: 'delegations/controlled-side/detach-notify',
        body: {},
        deps: { fetch, logger: getLogger('delegations:outbound') },
      });
      if (r.ok) return { ok: true, status: r.status, body: r.body };
      return { ok: false, status: r.status, body: (r as { body?: unknown }).body ?? null };
    };
  }

  /** Destroy a session by its id (the delegate PAT token IS the session id). */
  async function destroySession (token: string): Promise<void> {
    await fromCallback((cb: (e: unknown) => void) => sessionsStorage.destroy(token, cb));
  }

  /**
   * Build the control-side caller for a controlled account — the token-mint
   * channel. Same-core dispatches directly to the PAT-mint handler (no HTTP,
   * relId taken from A's mirror + A's own identity); cross-core posts to the
   * controlled account's core via the control bearer endpoint.
   */
  function makeCallControl (controlledUsername: string, aUsername: string) {
    return async function callControl (controlApiEndpoint: string, relId: string) {
      const target = await resolveTarget(controlledUsername);
      if (target.isSelf && target.userId != null) {
        try {
          const res = await delegation.handleIssueToken(
            { mall, now: nowSeconds, mintSession },
            { bUserId: target.userId, bUsername: controlledUsername, relId, expectDelegateUsername: aUsername });
          // Same-core issuance skips the audited method wrapper the cross-core
          // path goes through; record the issuance on B so both paths leave one
          // issuance audit record attributed to the delegate.
          await recordSameCoreIssueTokenAudit(target.userId, relId);
          return { ok: true, status: 200, body: res };
        } catch (err) {
          if (isDelegationErr(err)) return { ok: false, status: err.httpStatus, body: { id: err.id } };
          throw err;
        }
      }
      const r = await postToPeer({
        apiEndpoint: controlApiEndpoint,
        path: 'delegations/controlled-side/token',
        body: {},
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

  /**
   * THE SECURITY CRUX — genuine-login gate for detach + invite-cancel. Accepts
   * ONLY a clean B login: a `type:'personal'` access carrying NO forge-protected
   * `clientData.delegation` marker. A delegate PAT is also personal, so the type
   * check alone is insufficient — the marker's ABSENCE is the discriminator, and
   * the marker is forge-protected (create + update, all token classes), so a
   * clean personal token provably came from B's own login flow. A control access
   * (shared) is rejected by the type check. Violation → 403.
   */
  function requireGenuineLogin (context: MethodContext, _params: unknown, _result: unknown, next: MethodNext) {
    if (!delegation.isGenuineLoginAccess(context?.access)) {
      return next(new APIError(
        delegation.errorIds.DelegationErrorIds.GENUINE_LOGIN_REQUIRED,
        'This operation requires a direct login to this account; a delegated session cannot remove a delegation relationship',
        { httpStatus: 403 }));
    }
    next();
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

  // cancelInvite (B) — invite-status only. Cancelling a pending invite removes a
  // relationship record, so it is genuine-login-gated like detach (a delegate
  // PAT cannot cancel B's invites).
  api.register('delegations.cancelInvite',
    requireGenuineLogin,
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

  // getToken (A) — issue a delegate PAT for an active controlled account. The
  // control endpoint is loaded server-side (never sent to A's client); the PAT +
  // B's apiEndpoint are returned so A's client can talk to B's core directly.
  api.register('delegations.getToken',
    commonFns.requirePersonalAccess,
    async function (context: MethodContext, params: { username?: string }, result: Record<string, unknown>, next: MethodNext) {
      try {
        const controlledUsername = String(params.username || '');
        const deps = {
          mall, now: nowSeconds,
          callControl: makeCallControl(controlledUsername, context.user.username),
        };
        const res = await delegation.getToken(deps, { aUserId: context.user.id, controlledUsername });
        Object.assign(result, res);
        next();
      } catch (err) { next(toApiError(err)); }
    });

  // createAccount (A) — create a brand-new controlled account, active at birth.
  // A picks the target core (default = A's own core), pre-provisions the notify
  // channel, and calls the target core (same-core direct / cross-core system
  // endpoint); on success A stores the active mirror. Optional email + optional
  // password (random hash → reachable only via delegates until one sets a real
  // password). Personal token (delegate PATs count → chains).
  api.register('delegations.createAccount',
    commonFns.requirePersonalAccess,
    async function (context: MethodContext, params: { username?: string; email?: string; password?: string; core?: string; language?: string }, result: Record<string, unknown>, next: MethodNext) {
      try {
        const self = await selfIdentity(context.user.username);
        const deps = {
          mall, now: nowSeconds, idGen: newRelId, self,
          resolveTargetCore,
          callCreateAccount: makeCallCreateAccount(),
        };
        const res = await delegation.createControlledAccount(deps, {
          aUserId: context.user.id,
          aUsername: context.user.username,
          username: String(params.username || ''),
          email: params.email,
          password: params.password,
          core: params.core,
          language: params.language,
        });
        Object.assign(result, res);
        next();
      } catch (err) { next(toApiError(err)); }
    });

  // detachDelegate (B) — THE authoritative teardown, genuine-login-gated. Active
  // relationship → full B-side teardown (PAT session + access, control access,
  // capability sweep, anchor) then best-effort A-notify; pending invite → cancel.
  api.register('delegations.detachDelegate',
    requireGenuineLogin,
    async function (context: MethodContext, params: { username?: string }, result: Record<string, unknown>, next: MethodNext) {
      try {
        const delegateUsername = String(params.username || '');
        const self = await selfIdentity(context.user.username);
        const deps = {
          mall, now: nowSeconds, self,
          destroySession,
          resolveTarget,
          deliverInvite: makeDeliverInvite(),
          notifyDetach: makeNotifyDetach(delegateUsername),
        };
        const outcome = await delegation.detachDelegate(deps, {
          bUserId: context.user.id, bUsername: context.user.username, delegateUsername,
        });
        if (outcome.revokedChildAccesses) {
          logger.info('detach revoked ' + outcome.revokedChildAccesses + ' access(es) granted through the delegation');
        }
        next();
      } catch (err) { next(toApiError(err)); }
    });

  // dismissControlled (A) — local housekeeping: drop a `stale` mirror row. NOT a
  // detach (removes no authority, never touches B). Personal token (PATs count).
  api.register('delegations.dismissControlled',
    commonFns.requirePersonalAccess,
    async function (context: MethodContext, params: { username?: string }, result: Record<string, unknown>, next: MethodNext) {
      try {
        await delegation.dismissControlledMirror(mall, context.user.id, String(params.username || ''));
        next();
      } catch (err) { next(toApiError(err)); }
    });

  // ======================================================= controlled-side

  // issueToken — A's core → B's core (bearer = control access). Mints/refreshes
  // the delegate PAT on B (session-backed personal access). Also reachable as a
  // direct public call by a control bearer — that is fine, it IS the credential.
  api.register('delegations.issueToken',
    requireMarker('control'),
    async function (context: MethodContext, _params: unknown, result: Record<string, unknown>, next: MethodNext) {
      try {
        const marker = context.access?.clientData?.delegation;
        const res = await delegation.handleIssueToken(
          { mall, now: nowSeconds, mintSession },
          {
            bUserId: context.user.id,
            bUsername: context.user.username,
            relId: String(marker?.relId),
            expectDelegateUsername: marker?.delegate?.username,
          });
        Object.assign(result, res);
        next();
      } catch (err) { next(toApiError(err)); }
    });

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

  // notifyDetach — B's core → A's core (bearer = notify marker). Best-effort
  // teardown mirror-sync: drops A's mirror + notify access for the relationship.
  api.register('delegations.notifyDetach',
    requireMarker('notify'),
    async function (context: MethodContext, params: { relId?: string }, result: Record<string, unknown>, next: MethodNext) {
      try {
        const relId = context.access?.clientData?.delegation?.relId ?? params.relId;
        const res = await delegation.handleDetachNotify({ mall, now: nowSeconds }, {
          aUserId: context.user.id, relId: String(relId),
        });
        Object.assign(result, res);
        next();
      } catch (err) { next(toApiError(err)); }
    });

  logger.debug('delegations.* methods registered');
}
