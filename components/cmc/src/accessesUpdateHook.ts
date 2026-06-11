/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger, OutboundDeps } from './_types.ts';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — accesses.update post-hook + cls-style suppression.
 *
 * After any successful `accesses.update`, the post-hook examines the
 * updated access:
 *
 *   - If the access is NOT a CMC counterparty / data-grant access
 *     (clientData.cmc.role missing), skip — nothing to do.
 *   - If the suppression flag is set (this update was triggered by a
 *     CMC handler that's already going to deliver the notification),
 *     skip to avoid double-fire.
 *   - Otherwise: auto-deliver a `consent/scope-update-cmc` event to
 *     the peer via the access's stored apiEndpoint AND write a local
 *     audit event under the user's collectors stream so the user's
 *     app sees the change in real time.
 *
 * Suppression mechanism: an AsyncLocalStorage-backed flag. CMC handlers
 * that intentionally call accesses.update (e.g. handleSystemScopeUpdate)
 * wrap the call in `runWithSuppression()` so the post-hook reads the
 * flag and skips.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const C = require('./constants.ts');
const outbound = require('./outbound.ts');

// One process-wide suppression context. CMC handlers enter via
// runWithSuppression(); the post-hook reads via isSuppressed().
interface SuppressionStore { suppressed?: boolean }
interface AsyncStorageLike<T> {
  getStore (): T | undefined;
  run<R> (store: T, fn: () => R): R;
}
const suppressionStorage = new AsyncLocalStorage() as AsyncStorageLike<SuppressionStore>;

function isSuppressed (): boolean {
  return suppressionStorage.getStore()?.suppressed === true;
}

function runWithSuppression<T> (fn: () => Promise<T>): Promise<T> {
  return suppressionStorage.run({ suppressed: true }, fn);
}

type CmcAccessClientData = {
  cmc?: {
    role?: string;
    appCode?: string;
    counterparty?: { username?: string; host?: string; apiEndpoint?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

type AccessLike = {
  id: string;
  permissions?: unknown[];
  clientData?: CmcAccessClientData;
};

type MallLike = {
  events: { create: (userId: string, params: Record<string, unknown>) => Promise<{ id?: string; [k: string]: unknown }> };
  accesses?: { get: (userId: string, params?: Record<string, unknown>) => Promise<AccessLike[]> };
};



type PostHookDeps = {
  mall: MallLike;
} & OutboundDeps;

type PostHookResult = {
  ran: boolean;
  reason?: string;
  peerNotified?: boolean;
  peerDeliveryStatus?: number;
  localAuditEventId?: string;
};

/**
 * Build a post-hook callable. Invocation: `await hook(userId, before, after)`.
 *
 * `before` is the access pre-update (may be undefined if the caller
 * doesn't supply it). `after` is the updated access.
 *
 * Returns a PostHookResult describing what happened (used by tests +
 * operator audit). Never throws — failures are logged.
 */
function createAccessesUpdatePostHook (deps: PostHookDeps) {
  return async function accessesUpdatePostHook (
    userId: string,
    before: AccessLike | undefined,
    after: AccessLike
  ): Promise<PostHookResult> {
    if (isSuppressed()) {
      return { ran: false, reason: 'suppressed-by-cmc-handler' };
    }

    const cmc = after?.clientData?.cmc;
    // Only counterparty / data-grant accesses matter to CMC. Other roles
    // (e.g. capability) don't get scope-update notifications.
    if (cmc?.role !== 'counterparty' && cmc?.role !== 'data-grant') {
      return { ran: false, reason: 'not-a-cmc-managed-access' };
    }

    const apiEndpoint: string | undefined = cmc?.counterparty?.apiEndpoint;
    if (typeof apiEndpoint !== 'string' || apiEndpoint.length === 0) {
      deps.logger?.debug?.('cmc/accessesUpdateHook: no peer apiEndpoint on access', { accessId: after.id });
      return { ran: false, reason: 'no-peer-apiendpoint' };
    }

    // Build the scope-update payload.
    const payload = {
      source: 'post-hook',
      previousPermissions: before?.permissions ?? null,
      newPermissions: after?.permissions ?? null,
      newAccessId: after.id,
    };

    // Pick the collectors stream-id on OUR side under the access's app scope.
    // The access stores appCode and (in some cases) the originating scope —
    // we build the collectors stream id deterministically from appCode + slug.
    const appCode: string | null = typeof cmc.appCode === 'string' ? cmc.appCode : null;
    const peer = cmc?.counterparty;
    let localCollectorStreamId: string | null = null;
    if (appCode != null && peer?.username != null && peer?.host != null) {
      const hostSlug = peer.host.toLowerCase().replace(/\./g, '-');
      const peerSlug = peer.username + '--' + hostSlug;
      localCollectorStreamId = C.NS_APPS + ':' + appCode + ':collectors:' + peerSlug;
    }

    // Step 1: write the local audit event (so the user's app gets a socket
    // push). Best-effort; failure doesn't block peer delivery.
    let localAuditEventId: string | undefined;
    if (localCollectorStreamId != null) {
      try {
        const ev = await deps.mall.events.create(userId, {
          streamIds: [localCollectorStreamId],
          type: C.ET_SYSTEM_SCOPE_UPDATE,
          time: Date.now() / 1000,
          content: payload,
        });
        localAuditEventId = ev?.id;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger?.warn?.('cmc/accessesUpdateHook: local audit-event create failed', {
          accessId: after.id,
          error: message,
        });
      }
    }

    // Step 2: deliver to peer via the stored apiEndpoint. We POST to their
    // :_cmc:inbox (peer's inboxWriteHook will validate + stamp content.from).
    let peerNotified = false;
    let peerDeliveryStatus: number | undefined;
    try {
      const delivery = await outbound.postToPeer({
        apiEndpoint,
        path: 'events',
        body: {
          streamIds: [C.NS_INBOX],
          type: C.ET_SYSTEM_SCOPE_UPDATE,
          content: payload,
        },
        deps,
      });
      peerNotified = !!delivery.ok;
      peerDeliveryStatus = delivery.status;
      if (!peerNotified) {
        deps.logger?.warn?.('cmc/accessesUpdateHook: peer delivery failed', {
          accessId: after.id,
          reason: (delivery as { reason?: string }).reason,
          status: delivery.status,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger?.warn?.('cmc/accessesUpdateHook: peer delivery threw', {
        accessId: after.id,
        error: message,
      });
    }

    return {
      ran: true,
      peerNotified,
      peerDeliveryStatus,
      localAuditEventId,
    };
  };
}

export {
  createAccessesUpdatePostHook,
  isSuppressed,
  runWithSuppression,
};
