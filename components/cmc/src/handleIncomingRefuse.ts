/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin — requester-side incoming `consent/refuse-cmc`.
 *
 * The invited party's core delivers a refusal through the capability URL onto
 * `:_cmc:_internal:responses:<capId>`. Nothing is minted and nothing is sent
 * back: the handler records the outcome on the invite trigger.
 *
 *   - single-use: the invite becomes `refused` (who refused, when, why). The
 *     link stays open, so the same party may still accept it later.
 *   - open-link: nothing to record. One party declining does not change a link
 *     other parties may still join.
 */

import * as capabilityMod from './capability.ts';
import * as inviteState from './inviteState.ts';
import * as C from './constants.ts';
import type { CmcLogger, MallLike } from './_types.ts';

type RefuseEvent = {
  id?: string;
  type: string;
  content?: Record<string, unknown> | null;
  createdBy?: string;
};

type IncomingRefuseResult =
  | { ok: true; capabilityId: string; inviteRefused: boolean }
  | { ok: false; reason: string; detail?: unknown };

async function handleIncomingRefuse (params: {
  userId: string;
  event: RefuseEvent;
  deps: {
    mall: MallLike;
    logger?: CmcLogger;
    notifyEventChanged?: (userId: string, event: { id?: string }) => void;
  };
}): Promise<IncomingRefuseResult> {
  const { userId, event, deps } = params;
  if (event.type !== C.ET_REFUSE) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: event.type } };
  }
  const capabilityId = event.content?.capabilityId;
  if (typeof capabilityId !== 'string' || capabilityId.length === 0) {
    return { ok: false, reason: 'cmc-incoming-refuse-missing-capability-id' };
  }
  // Written with the capability token, so `createdBy` names the capability
  // access (`<accessId> <callerId>` when a callerId was given).
  const accessIdHint = (typeof event.createdBy === 'string' ? event.createdBy : '').split(' ')[0] || null;
  const capabilityAccess = await capabilityMod.findCapabilityAccess({
    userId, capabilityId, accessId: accessIdHint, deps: { mall: deps.mall },
  });
  if (capabilityAccess == null) {
    return { ok: false, reason: 'capability-access-not-found', detail: { capabilityId } };
  }
  if (capabilityAccess.clientData?.cmc?.capability?.mode === 'open-link') {
    return { ok: true, capabilityId, inviteRefused: false };
  }

  const from = event.content?.from as { username?: unknown; host?: unknown } | undefined;
  const reason = event.content?.reason;
  const stamp = await inviteState.stampInvite({
    userId,
    inviteEventId: capabilityAccess.clientData?.cmc?.requestEventId,
    transition: 'refused',
    fields: {
      // Asserted by the refusing party's core, like `from` on an accept.
      refusedBy: typeof from?.username === 'string' && typeof from?.host === 'string'
        ? { username: from.username, host: from.host }
        : null,
      refusedAt: Date.now() / 1000,
      ...(reason != null ? { reason } : {}),
    },
    deps: { mall: deps.mall, logger: deps.logger, notifyEventChanged: deps.notifyEventChanged },
  });
  if (!stamp.ok || stamp.skipped != null) {
    deps.logger?.debug?.('cmc/handleIncomingRefuse: invite not stamped refused', { capabilityId, stamp });
  }
  return { ok: true, capabilityId, inviteRefused: stamp.ok && stamp.written };
}

export { handleIncomingRefuse };
