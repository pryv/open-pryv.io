/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleInvalidateLink (Phase 2 capability lifecycle).
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

type MallLike = {
  accesses: {
    update?: (userId: string, params: any) => Promise<any>;
    get?: (userId: string, params?: any) => Promise<any[]>;
  };
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
      detail?: any;
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
  triggerEvent: { id?: string; type: string; content: any; streamIds?: string[] };
  deps: { mall: MallLike; logger?: { debug?: Function; warn?: Function } };
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

  // Defensive: single-use capabilities auto-consume on first accept;
  // there's nothing to invalidate. Return ok with an advisory flag so
  // the dispatch surface can stamp a meaningful status without
  // surfacing a "failure" to the requester's app.
  const mode = acc.clientData?.cmc?.capability?.mode;
  if (mode === 'single-use') {
    return { ok: true, eventType: triggerEvent.type, capabilityId, alreadyConsumed: true };
  }

  const flip = await capabilityMod.markCapabilityInvalidated({
    userId, capabilityId, deps: { mall },
  });
  if (!flip.ok) {
    return {
      ok: false,
      reason: flip.reason || 'cmc-invalidate-link-failed',
      detail: { capabilityId },
    };
  }

  return { ok: true, eventType: triggerEvent.type, capabilityId };
}

export { handleInvalidateLink };
