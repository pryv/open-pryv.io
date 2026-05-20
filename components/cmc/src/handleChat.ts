/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleChat entry point.
 *
 * Triggered when an app writes `message/chat-cmc` to its OWN per-counterparty
 * chat stream:
 *
 *   :_cmc:apps:<app-code>:[<user-path>:]chats:<counterparty-slug>
 *
 * The handler:
 *   1. Parses the trigger stream-id (chatOrchestration.parseChatStreamId).
 *   2. Resolves the user's counterparty-access for this (appCode,
 *      counterparty) pair.
 *   3. Reads remote apiEndpoint + remoteChatStreamId off the access's
 *      clientData.cmc.counterparty (stamped at acceptance time).
 *   4. POSTs message/chat-cmc to the peer's chats stream via outbound.
 *
 * Same shape as handleSystemEvent. Kept separate so future divergence
 * (e.g. chats may need local read-receipt sentinels; system messages
 * don't) is a localised change.
 */

const C = require('./constants.ts');
const slugMod = require('./slug.ts');
const chatOrch = require('./chatOrchestration.ts');

type Counterparty = { username: string; host: string };

type AccessLike = {
  id: string;
  type?: string;
  clientData?: any;
};

type OutboundDeps = {
  fetch: (url: string, init?: any) => Promise<any>;
  timeoutMs?: number;
  logger?: { debug: Function; warn: Function };
};

type ChatHandlerResult =
  | {
      ok: true;
      eventType: string;
      remoteEventId?: string;
    }
  | {
      ok: false;
      reason: string;
      detail?: any;
    };

/**
 * Handle a `message/chat-cmc` trigger event.
 */
async function handleChat (params: {
  userId: string;
  triggerEvent: { id?: string; type: string; content: any; streamIds?: string[] };
  selfIdentity: Counterparty;
  deps: {
    mall: { accesses: { get: (userId: string, params?: any) => Promise<AccessLike[]> } };
    fetch: OutboundDeps['fetch'];
    timeoutMs?: number;
    logger?: { debug: Function; warn: Function };
  };
}): Promise<ChatHandlerResult> {
  const { userId, triggerEvent, selfIdentity, deps } = params;

  if (triggerEvent.type !== C.ET_CHAT) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: triggerEvent.type } };
  }

  // Pick the chat stream from the trigger's streamIds.
  const streamIds = Array.isArray(triggerEvent.streamIds) ? triggerEvent.streamIds : [];
  let parsed: any = null;
  for (const sid of streamIds) {
    parsed = chatOrch.parseChatStreamId(sid);
    if (parsed != null) break;
  }
  if (parsed == null) {
    return { ok: false, reason: 'cmc-chat-stream-not-chat', detail: { streamIds } };
  }

  // Resolve the counterparty access. Match on (username, slugifyHost(host),
  // appCode) — the access's stored hostSlug must round-trip from the live host.
  const accessesList = await deps.mall.accesses.get(userId, {});
  let chosen: AccessLike | null = null;
  for (const acc of accessesList) {
    const cmc = acc?.clientData?.cmc;
    if (cmc?.role !== 'counterparty') continue;
    const cp = cmc?.counterparty;
    if (cp == null) continue;
    if (cp.username !== parsed.counterparty.username) continue;
    const accHostSlug = slugMod.slugifyHost(cp.host);
    if (accHostSlug !== parsed.counterparty.hostSlug) continue;
    if (cmc?.appCode != null && cmc.appCode !== parsed.appCode) continue;
    chosen = acc;
    break;
  }
  if (chosen == null) {
    return { ok: false, reason: 'cmc-chat-counterparty-access-not-found', detail: {
      appCode: parsed.appCode,
      counterpartySlug: parsed.counterpartySlug,
    } };
  }

  const cmc = chosen.clientData?.cmc;

  // Phase 2.2 features gating — the offer's negotiated `features.chat`
  // is the relationship's binding contract (per Plan 68 locked
  // decision: "an access is a contract that MUST be true"). When the
  // counterparty access carries `clientData.cmc.features.chat ===
  // false`, the send is rejected so the documented feature flag isn't
  // a silent no-op. Absent / `true` → permit (default-permit on
  // omission to match offer-side default).
  if (cmc?.features?.chat === false) {
    return { ok: false, reason: 'cmc-chat-disabled', detail: { accessId: chosen.id } };
  }

  const remoteApiEndpoint: string | undefined = cmc?.counterparty?.apiEndpoint;
  const remoteChatStreamId: string | undefined = cmc?.counterparty?.remoteChatStreamId;
  if (typeof remoteApiEndpoint !== 'string' || remoteApiEndpoint.length === 0) {
    return { ok: false, reason: 'cmc-chat-no-remote-apiendpoint', detail: { accessId: chosen.id } };
  }
  if (typeof remoteChatStreamId !== 'string' || remoteChatStreamId.length === 0) {
    return { ok: false, reason: 'cmc-chat-no-remote-chat-stream', detail: { accessId: chosen.id } };
  }

  // Body shape mirrors chatOrchestration.deliverChatToPeer but we pass the
  // full payload through so apps can attach metadata (attachments, etc.).
  const content = triggerEvent.content?.content;
  let delivery: any;
  try {
    delivery = await chatOrch.deliverChatToPeer({
      remoteApiEndpoint,
      remoteChatStreamId,
      content,
      selfIdentity,
      deps,
    });
  } catch (err: any) {
    return { ok: false, reason: 'cmc-handler-delivery-threw', detail: { message: String(err?.message || err) } };
  }

  if (!delivery.ok) {
    return {
      ok: false,
      reason: 'cmc-handler-delivery-failed',
      detail: { status: delivery.status, peerReason: delivery.reason },
    };
  }

  return {
    ok: true,
    eventType: triggerEvent.type,
    remoteEventId: delivery.body?.event?.id,
  };
}

export {
  handleChat,
};
