/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger, OutboundDeps, CmcAccessLike as AccessLike, MallEventsLike, MallAccessesLike } from './_types.ts';

import type { MemberSweep } from './memberSweep.ts';
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
const relationshipKey = require('./relationshipKey.ts');
const slugMod = require('./slug.ts');

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

type MallLike = { events: MallEventsLike; accesses?: MallAccessesLike };

/**
 * Group accounts: the scope streams a membership still covers after an
 * update (its `read` / `contribute` permissions on user-creatable
 * `:_cmc:apps:*` ids). A ledger record whose relationship scope is under none
 * of them is swept (`narrowed`).
 */
function coveredScopesOf (access: AccessLike): string[] {
  const out: string[] = [];
  for (const p of access?.permissions ?? []) {
    const sid = (p as { streamId?: unknown })?.streamId;
    const level = (p as { level?: unknown })?.level;
    if (typeof sid === 'string' && C.isUserCreatableStreamId(sid) && (level === 'read' || level === 'contribute' || level === 'manage')) out.push(sid);
  }
  return out;
}

function isUnderAny (scope: string, roots: string[]): boolean {
  return roots.some((r) => scope === r || scope.startsWith(r + ':'));
}

/**
 * The collectors stream on OUR side for the relationship this access
 * serves: `<scope>:collectors:<peer-slug>`, the anchor stream provisioned at
 * accept time, where `<scope>` is the relationship's own scope (stamped on
 * the access, or read from its channel permissions; see
 * relationshipKey.scopeOfAccess). Only when no scope can be resolved (an
 * access minted before either existed) does it fall back to the app root,
 * `:_cmc:apps:<appCode>:collectors:<peer-slug>`. Null when the peer is
 * unknown.
 */
function localCollectorStreamFor (before: AccessLike | undefined, after: AccessLike): string | null {
  const cmc = after?.clientData?.cmc;
  const peer = cmc?.counterparty;
  if (peer?.username == null || peer?.host == null) return null;
  let peerSlug: string;
  try {
    // Same slug the anchor streams were provisioned with.
    peerSlug = slugMod.counterpartySlug({ username: peer.username, host: peer.host });
  } catch {
    peerSlug = peer.username + '--' + peer.host.toLowerCase().replace(/\./g, '-');
  }
  const scope = relationshipKey.scopeOfAccess(after) ?? relationshipKey.scopeOfAccess(before);
  if (typeof scope === 'string' && scope.startsWith(C.NS_APPS + ':')) {
    const streamId = C.collectorStreamUnder(scope, peerSlug);
    // Accept only a well-formed channel stream of that very scope.
    if (relationshipKey.scopeOfChannelStream(streamId) === scope) return streamId;
  }
  const appCode: string | null = typeof cmc?.appCode === 'string' ? cmc.appCode : null;
  if (appCode == null) return null;
  return C.NS_APPS + ':' + appCode + ':collectors:' + peerSlug;
}

type PostHookDeps = {
  mall: MallLike;
  // Group accounts (memberSweep.ts): a narrowed membership is swept for the
  // relationships it no longer covers.
  memberSweep?: Pick<MemberSweep, 'sweepMembership'>;
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
    if (cmc == null || (cmc.role !== 'counterparty' && cmc.role !== 'data-grant' && cmc.role !== C.ROLE_MEMBER)) {
      return { ran: false, reason: 'not-a-cmc-managed-access' };
    }

    // A membership narrowed: what was minted for the member under a scope it
    // no longer holds is swept (the member keeps what the membership still
    // covers). Runs before the member is told of the change.
    if (cmc.role === C.ROLE_MEMBER && deps.memberSweep != null) {
      const covered = coveredScopesOf(after);
      try {
        await deps.memberSweep.sweepMembership(userId, after, 'narrowed', {
          recordFilter: (record) => typeof record.scopeStreamId === 'string' && !isUnderAny(record.scopeStreamId, covered),
        });
      } catch (err: unknown) {
        // Not retried by the periodic pass (the membership is live): the
        // children of the scopes it dropped expire on their own, within maxTtl.
        deps.logger?.warn?.('cmc/accessesUpdateHook: the member sweep failed (the children expire on their own)', {
          accessId: after.id, error: String((err as Error)?.message ?? err),
        });
      }
    }

    // Requester side stores the peer path on `counterparty.apiEndpoint`;
    // the accepter side mirrors it there once the back-channel lands —
    // fall back to the original `backChannelApiEndpoint` field for
    // accesses minted before the mirror existed (same resolution as the
    // revoke forwarding paths).
    const apiEndpoint: string | undefined =
      cmc?.counterparty?.apiEndpoint ?? cmc?.backChannelApiEndpoint;
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

    const localCollectorStreamId = localCollectorStreamFor(before, after);

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

    // Step 2: deliver to peer via the stored apiEndpoint. Target the
    // peer's COLLECTORS stream (stored on the access at handshake time),
    // exactly like handleSystemScopeUpdate does — NOT their :_cmc:inbox:
    // `consent/scope-update-cmc` is a SYSTEM-family type and the peer's
    // inboxWriteHook only admits the lifecycle family there, so an inbox
    // delivery is rejected with `cmc-event-type-not-allowed`. On the
    // collectors stream the peer's counterparty-from-stamping hook stamps
    // `content.from` from the delivering access's stored identity.
    const remoteCollectorStreamId: string | undefined = cmc?.counterparty?.remoteCollectorStreamId;
    if (typeof remoteCollectorStreamId !== 'string' || remoteCollectorStreamId.length === 0) {
      deps.logger?.warn?.('cmc/accessesUpdateHook: no remoteCollectorStreamId on access — peer not notified', {
        accessId: after.id,
      });
      return { ran: true, peerNotified: false, localAuditEventId };
    }
    let peerNotified = false;
    let peerDeliveryStatus: number | undefined;
    try {
      const delivery = await outbound.postToPeer({
        apiEndpoint,
        path: 'events',
        body: {
          streamIds: [remoteCollectorStreamId],
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

/**
 * streams.delete, group accounts: deleting a team stream under
 * `:_cmc:apps:*` for good narrows every membership that covers it, exactly
 * as an `accesses.update` dropping that team would (reason `narrowed`): the
 * accesses minted for the members under that stream are deleted on the
 * patient cores. The record is written on the nearest surviving ancestor
 * (the deleted stream's parent when it is a team stream, else the apps
 * root), with `uncovered: [streamId]` so the sweep's re-check does not read
 * the membership's permission on the dead stream as coverage.
 *
 * Returns `narrowOnStreamDeleted(userId, stream)`, which the route calls
 * once the deletion is certain (every check of `deleteWithData` passed): a
 * refused delete must not revoke anyone nor write a record. Fire and forget,
 * like the update hook; trashing a stream is not a narrowing and never
 * reaches this.
 */
function createStreamDeleteNarrowing (deps: {
  mall: { accesses: { get: (userId: string, params: Record<string, unknown>) => Promise<unknown> } };
  memberSweep: Pick<MemberSweep, 'sweepMembership'>;
  logger?: CmcLogger;
}) {
  return function narrowOnStreamDeleted (userId: string, stream: { id?: string; parentId?: string | null }): void {
    const streamId = typeof stream?.id === 'string' ? stream.id : null;
    if (streamId == null || userId == null || !C.isUserCreatableStreamId(streamId)) return;
    const parentId = stream?.parentId;
    const recordStream = typeof parentId === 'string' && C.isUserCreatableStreamId(parentId) ? parentId : C.NS_APPS;
    const under = (scope: unknown): boolean => typeof scope === 'string' && (scope === streamId || scope.startsWith(streamId + ':'));
    Promise.resolve()
      .then(async () => {
        const all = await deps.mall.accesses.get(userId, {}) as AccessLike[];
        for (const access of Array.isArray(all) ? all : []) {
          if ((access as { deleted?: unknown })?.deleted != null || access?.clientData?.cmc?.role !== C.ROLE_MEMBER) continue;
          const covered = coveredScopesOf(access);
          const touches = covered.some((c) => under(c) || streamId.startsWith(c + ':'));
          if (!touches) continue;
          await deps.memberSweep.sweepMembership(userId, access, 'narrowed', {
            recordFilter: (record) => under(record.scopeStreamId),
            uncovered: [streamId],
            streamId: recordStream,
          });
        }
      })
      .catch((err: unknown) => {
        deps.logger?.warn?.('cmc/streamDeleteNarrowing: the member sweep failed (the children expire on their own)', {
          streamId, error: String((err as Error)?.message ?? err),
        });
      });
  };
}

export {
  createAccessesUpdatePostHook,
  createStreamDeleteNarrowing,
  isSuppressed,
  runWithSuppression,
  coveredScopesOf,
};
