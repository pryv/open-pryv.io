/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — requester-side incoming `cmc/accept-v1` handler.
 *
 * When the accepter posts a `cmc/accept-v1` event back to the requester's
 * platform via the capability URL, the event lands on the requester's
 * `:_cmc:inbox` (after going through inboxWriteHook's counterparty
 * validation + content.from stamping). The requester needs to provision
 * the BACK-CHANNEL access — i.e. mint an access on their own account
 * scoped to the accepter's CMC namespace so future chat / system
 * deliveries from the requester to the accepter have an authoritated
 * apiEndpoint to POST to.
 *
 * Flow:
 *   1. Extract content.grantedAccess.apiEndpoint (the accepter's
 *      data-grant URL — that's where the requester's app can READ the
 *      accepted permissions).
 *   2. Extract content.from (server-stamped by inboxWriteHook —
 *      {username, host} of the accepter).
 *   3. Read the original request event from one of the requester's
 *      `:_cmc:apps:<app>:[<path>:]` streams to find the appCode + scope.
 *   4. Create the back-channel access:
 *      - permissions: create on `:_cmc:inbox` + rights on the chats
 *        and collectors streams under the app scope.
 *      - clientData.cmc = {role:'counterparty', appCode, counterparty:
 *        {username, host, apiEndpoint, remoteChatStreamId,
 *        remoteCollectorStreamId}}
 *      - The remote stream-ids are computed deterministically from our
 *        identity (the accepter mirrors the structure on their side).
 *   5. Auto-create the anchor streams on this side:
 *      - :_cmc:apps:<app>:[<path>:]chats
 *      - :_cmc:apps:<app>:[<path>:]chats:<accepter-slug>
 *      - :_cmc:apps:<app>:[<path>:]collectors
 *      - :_cmc:apps:<app>:[<path>:]collectors:<accepter-slug>
 *
 * Returns { ok, accessId, anchorStreamIds } on success, or
 * { ok:false, reason, detail } on failure (so the caller can log /
 * surface to operator audit; the inbox write-hook itself never reverts
 * the inbox event — the audit record is the durable proof).
 */

const C = require('./constants.ts');
const slugMod = require('./slug.ts');

type Counterparty = { username: string; host: string };

type AccessLike = {
  id: string;
  permissions?: any[];
  clientData?: any;
};

type IncomingAcceptResult =
  | {
      ok: true;
      backChannelAccessId: string;
      backChannelApiEndpoint?: string;
      anchorStreamIds: string[];
      appCode: string;
      counterparty: Counterparty;
    }
  | {
      ok: false;
      reason: string;
      detail?: any;
    };

type MallLike = {
  accesses: { create: (userId: string, params: any) => Promise<any> };
  events: {
    get: (userId: string, params?: any) => Promise<any[]>;
    update?: (userId: string, params: any) => Promise<any>;
  };
  streams: { create: (userId: string, params: any) => Promise<any> };
};

type SelfIdentity = { username: string; host: string };

/**
 * Process an incoming `cmc/accept-v1` event after it has been persisted
 * in the requester's :_cmc:inbox. Provisions the back-channel access +
 * anchor streams.
 *
 * On stream-create failures: we ignore "stream-already-exists" (idempotent —
 * a re-delivery of the same accept just rebuilds the same anchors). Other
 * stream-create errors fail the handler so an operator can investigate.
 */
async function handleIncomingAccept (params: {
  userId: string;
  acceptEvent: { id?: string; type: string; content: any; streamIds?: string[] };
  selfIdentity: SelfIdentity;
  deps: {
    mall: MallLike;
    logger?: { debug: Function; warn: Function };
  };
}): Promise<IncomingAcceptResult> {
  const { userId, acceptEvent, selfIdentity, deps } = params;
  const { mall } = deps;

  if (acceptEvent.type !== C.ET_ACCEPT) {
    return { ok: false, reason: 'cmc-incoming-accept-wrong-type', detail: { type: acceptEvent.type } };
  }

  const grantedApiEndpoint: string | undefined = acceptEvent.content?.grantedAccess?.apiEndpoint;
  if (typeof grantedApiEndpoint !== 'string' || grantedApiEndpoint.length === 0) {
    return { ok: false, reason: 'cmc-incoming-accept-no-granted-apiendpoint' };
  }

  const cp = acceptEvent.content?.from;
  if (cp == null || typeof cp.username !== 'string' || typeof cp.host !== 'string') {
    return { ok: false, reason: 'cmc-incoming-accept-from-missing' };
  }
  const counterparty: Counterparty = { username: cp.username, host: cp.host };

  // The accepter's accept references the original request via either
  // content.capabilityId or content.requestEventId. We use the request
  // event to recover the appCode + the scope stream-id under which to
  // anchor the chat/collectors streams.
  let scopeStreamId: string | null = null;
  let appCode: string | null = null;
  try {
    const lookup = await resolveRequestScope({ userId, acceptEvent, mall });
    scopeStreamId = lookup.scopeStreamId;
    appCode = lookup.appCode;
  } catch (err: any) {
    return { ok: false, reason: 'cmc-incoming-accept-scope-lookup-failed', detail: { message: String(err?.message || err) } };
  }
  if (scopeStreamId == null || appCode == null) {
    // Fall back to a minimal valid scope so we can still mint a back-channel
    // access. The accepter's mirror will use whatever appCode they were
    // configured with — they don't read ours.
    appCode = 'unknown';
    scopeStreamId = C.NS_APPS + ':' + appCode;
  }

  // Compute the four anchor stream-ids on OUR side. The peer's stream-ids
  // mirror the same structure on their account (deterministic — both
  // sides derive from app scope + counterparty slug).
  const peerSlug = slugMod.counterpartySlug({ username: counterparty.username, host: counterparty.host });
  const selfSlug = slugMod.counterpartySlug({ username: selfIdentity.username, host: selfIdentity.host });
  const chatsParent = C.chatsParentUnder(scopeStreamId);
  const collectorsParent = C.collectorsParentUnder(scopeStreamId);
  const chatStream = C.chatStreamUnder(scopeStreamId, peerSlug);
  const collectorStream = C.collectorStreamUnder(scopeStreamId, peerSlug);
  const remoteScopeStreamId = scopeStreamId; // peer mirrors structure
  const remoteChatStreamId = C.chatStreamUnder(remoteScopeStreamId, selfSlug);
  const remoteCollectorStreamId = C.collectorStreamUnder(remoteScopeStreamId, selfSlug);

  // Provision the four anchor streams. Idempotent: stream-already-exists
  // is treated as success.
  const created: string[] = [];
  for (const sid of [chatsParent, collectorsParent, chatStream, collectorStream]) {
    const parentId = parentOf(sid);
    try {
      await mall.streams.create(userId, {
        id: sid,
        name: sid.split(':').pop() ?? sid,
        parentId,
      });
      created.push(sid);
    } catch (err: any) {
      const code = err?.id || err?.code || err?.errorId;
      if (code === 'stream-already-exists' || /already.*exist/i.test(String(err?.message || ''))) {
        created.push(sid);
        continue;
      }
      return {
        ok: false,
        reason: 'cmc-incoming-accept-anchor-stream-create-failed',
        detail: { streamId: sid, message: String(err?.message || err) },
      };
    }
  }

  // Mint the back-channel access. Permissions:
  //   - create-only on :_cmc:inbox (so the peer can deliver to us)
  //   - read/contribute on chats + collectors anchor streams (so the
  //     peer can deliver chat + system messages targeted to our slug)
  let access: AccessLike;
  try {
    access = await mall.accesses.create(userId, {
      type: 'shared',
      name: 'cmc-back-channel-' + peerSlug,
      permissions: [
        { streamId: C.NS_INBOX, level: 'create-only' },
        { streamId: chatStream, level: 'contribute' },
        { streamId: collectorStream, level: 'contribute' },
      ],
      clientData: {
        cmc: {
          role: 'counterparty',
          appCode,
          counterparty: {
            username: counterparty.username,
            host: counterparty.host,
            apiEndpoint: grantedApiEndpoint,
            remoteChatStreamId,
            remoteCollectorStreamId,
          },
        },
      },
    });
  } catch (err: any) {
    return {
      ok: false,
      reason: 'cmc-incoming-accept-back-channel-create-failed',
      detail: { message: String(err?.message || err) },
    };
  }

  return {
    ok: true,
    backChannelAccessId: access.id,
    backChannelApiEndpoint: (access as any).apiEndpoint,
    anchorStreamIds: created,
    appCode,
    counterparty,
  };
}

/**
 * Best-effort lookup of the original request event's scope. The accept
 * event carries either `originalEventId` or `capabilityId`; we use it
 * to find the request event in our streams and return the streamId
 * + appCode it was written under. Returns nulls if we can't resolve
 * (caller falls back to a synthetic scope).
 */
async function resolveRequestScope (params: {
  userId: string;
  acceptEvent: any;
  mall: MallLike;
}): Promise<{ scopeStreamId: string | null; appCode: string | null }> {
  const { userId, acceptEvent, mall } = params;
  const reqId = acceptEvent.content?.originalEventId ?? acceptEvent.content?.requestEventId;
  if (typeof reqId !== 'string' || reqId.length === 0) {
    return { scopeStreamId: null, appCode: null };
  }
  try {
    const events = await mall.events.get(userId, { id: reqId, limit: 1 });
    const ev = events?.[0];
    const reqStreamIds: string[] = Array.isArray(ev?.streamIds) ? ev.streamIds : [];
    for (const sid of reqStreamIds) {
      const appCode = C.getAppCode(sid);
      if (appCode != null) {
        return { scopeStreamId: sid, appCode };
      }
    }
  } catch (_e) {
    // Lookup failure → fall back.
  }
  return { scopeStreamId: null, appCode: null };
}

/**
 * Parent stream-id for a given :_cmc:* path. Strips the trailing
 * `:<segment>` to yield the parent.
 */
function parentOf (streamId: string): string {
  const idx = streamId.lastIndexOf(':');
  if (idx <= 0) return streamId;
  return streamId.substring(0, idx);
}

export {
  handleIncomingAccept,
  resolveRequestScope,
};
