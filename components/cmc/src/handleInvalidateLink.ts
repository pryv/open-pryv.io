/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger } from './_types.ts';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleInvalidateLink (capability lifecycle).
 *
 * Triggered by `consent/invalidate-link-cmc` written to one of the
 * requester's own `:_cmc:apps:*` streams. The plugin flips the
 * referenced capability access's `clientData.cmc.capability.state` from
 * `'open'` to `'invalidated'` so subsequent accepts via the same
 * capability URL are rejected by the responses-stream write-hook.
 *
 * No outbound delivery: the requester is invalidating their own
 * capability locally; there is no peer to notify. The next attempted
 * accept on this capability gets a typed `cmc-capability-invalidated`
 * error from the write-hook.
 *
 * Idempotent (already-invalidated capability) and tolerant (single-use
 * capabilities are auto-consumed on first accept, so invalidate is a
 * no-op for them).
 *
 * Already-established data-grant + back-channel relationships minted
 * BEFORE invalidation are NOT touched — use `consent/revoke-cmc` for
 * per-relationship teardown.
 */

const C = require('./constants.ts');
const capabilityMod = require('./capability.ts');
const inviteState = require('./inviteState.ts');
const { CmcErrorIds } = require('./errorIds.ts');

import type { CmcAccessLike as AccessLike, MallAccessesLike, MallEventsLike } from './_types.ts';

type MallLike = { accesses: MallAccessesLike; events?: MallEventsLike };

type InvalidateLinkEventContent = {
  capabilityId?: unknown;
  reason?: unknown;
};

type InvalidateLinkResult =
  | {
      ok: true;
      eventType: string;
      capabilityId: string;
      alreadyConsumed?: boolean;
    }
  | {
      ok: false;
      reason: string;
      detail?: unknown;
    };

/**
 * Handle a `consent/invalidate-link-cmc` trigger event.
 *
 * Inputs (on triggerEvent.content):
 *   - capabilityId: string (required) — the capability access to invalidate.
 *   - reason: object (optional) — localized reason text (advisory).
 */
async function handleInvalidateLink (params: {
  userId: string;
  triggerEvent: { id?: string; type: string; content: InvalidateLinkEventContent; streamIds?: string[] };
  deps: {
    mall: MallLike;
    logger?: CmcLogger;
    notifyEventChanged?: (userId: string, event: { id?: string }) => void;
  };
}): Promise<InvalidateLinkResult> {
  const { userId, triggerEvent, deps } = params;
  const { mall } = deps;

  if (triggerEvent.type !== C.ET_INVALIDATE_LINK) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: triggerEvent.type } };
  }

  const capabilityId: unknown = triggerEvent.content?.capabilityId;
  if (typeof capabilityId !== 'string' || capabilityId.length === 0) {
    return { ok: false, reason: 'cmc-handler-missing-capability-id' };
  }

  const acc = await capabilityMod.findCapabilityAccess({
    userId, capabilityId, deps: { mall },
  });
  if (acc == null) {
    return { ok: false, reason: 'capability-access-not-found', detail: { capabilityId } };
  }

  // The scope check: the trigger's stream must hold the invite this
  // capability was minted for (the invite's stream, or an ancestor of it),
  // so a token with contribute on one app scope cannot close the invites of
  // another by guessing their capability ids. The invite's stream is read
  // from the server-written copy of the offer in the capability's own
  // internal stream (`originStreamId`, which no client can edit or delete),
  // and from the invite event itself only for a capability minted before
  // that stamp existed. Neither readable: refused.
  const triggerScopes = (Array.isArray(triggerEvent.streamIds) ? triggerEvent.streamIds : [])
    .filter((s): s is string => typeof s === 'string' && s.startsWith(C.NS_APPS + ':'));
  let inviteStreams: string[] | null = null;
  if (mall.events?.get != null) {
    try {
      const copies = await mall.events.get(userId, { streams: [{ any: [C.offerStreamIdFor(capabilityId)] }], limit: 5 });
      const copy = (Array.isArray(copies) ? copies : []).find((e) => e?.type === C.ET_REQUEST);
      const origin = (copy?.content as { originStreamId?: unknown } | null | undefined)?.originStreamId;
      if (typeof origin === 'string' && origin.length > 0) inviteStreams = [origin];
    } catch (_e) { inviteStreams = null; }
  }
  const requestEventId = acc.clientData?.cmc?.requestEventId;
  if (inviteStreams == null && typeof requestEventId === 'string' && requestEventId.length > 0 && mall.events?.getOne != null) {
    try {
      const invite = await mall.events.getOne(userId, requestEventId);
      if (invite != null && Array.isArray(invite.streamIds)) inviteStreams = invite.streamIds.filter((s): s is string => typeof s === 'string');
    } catch (_e) { inviteStreams = null; }
  }
  const inScope = inviteStreams != null && inviteStreams.some((s) => triggerScopes.some((t) => s === t || s.startsWith(t + ':')));
  if (!inScope) {
    return { ok: false, reason: CmcErrorIds.INVALIDATE_LINK_SCOPE_MISMATCH, detail: { capabilityId } };
  }

  // Defensive: single-use capabilities auto-consume on first accept;
  // there's nothing to invalidate. Return ok with an advisory flag so
  // the dispatch surface can stamp a meaningful status without
  // surfacing a "failure" to the requester's app.
  const mode = acc.clientData?.cmc?.capability?.mode;
  if (mode === 'single-use') {
    return { ok: true, eventType: triggerEvent.type, capabilityId, alreadyConsumed: true };
  }

  const flip = await capabilityMod.markCapabilityInvalidated({
    userId, capabilityId, accessId: acc.id, deps: { mall },
  });
  if (!flip.ok) {
    return {
      ok: false,
      reason: flip.reason || 'cmc-invalidate-link-failed',
      detail: { capabilityId },
    };
  }

  // Record the outcome on the invite trigger the requester's app watches.
  // Best-effort: the link is closed either way.
  const inviteEventId = acc.clientData?.cmc?.requestEventId;
  if (mall.events != null) {
    const stamp = await inviteState.stampInvite({
      userId,
      inviteEventId,
      transition: 'invalidated',
      fields: {
        invalidatedAt: Date.now() / 1000,
        ...(triggerEvent.content?.reason != null ? { reason: triggerEvent.content.reason } : {}),
      },
      deps: { mall: { events: mall.events }, logger: deps.logger, notifyEventChanged: deps.notifyEventChanged },
    });
    if (!stamp.ok || stamp.skipped != null) {
      deps.logger?.debug?.('cmc/handleInvalidateLink: invite not stamped invalidated', { inviteEventId, stamp });
    }
  }

  return { ok: true, eventType: triggerEvent.type, capabilityId };
}

export { handleInvalidateLink };
