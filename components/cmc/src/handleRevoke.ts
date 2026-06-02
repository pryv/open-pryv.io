/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleRevoke entry point.
 *
 * Triggered by `consent/revoke-cmc` written to:
 *
 *   :_cmc:inbox                              (one-shot, before acceptance)
 *   :_cmc:apps:<app-code>:[<path>:]chats:<slug>      (after acceptance)
 *   :_cmc:apps:<app-code>:[<path>:]collectors:<slug> (after acceptance)
 *
 * Effect (acceptance-time chain):
 *   1. Find the local counterparty-access (by appCode + counterparty
 *      from the trigger or from content.counterparty).
 *   2. Find the paired data-grant access we issued to the peer (the
 *      `role: 'data-grant'` access whose clientData.cmc.peerAccessId
 *      points at the counterparty-access; or by reverse-lookup on
 *      counterparty identity).
 *   3. Delete the data-grant access locally (revokes peer's read into
 *      our data immediately).
 *   4. Deliver `consent/revoke-cmc` to the peer via the counterparty-access's
 *      stored apiEndpoint so they delete their half too.
 *   5. Delete our counterparty-access (we no longer trust the peer's
 *      back-channel either).
 *
 * Pre-acceptance revocation (written to :_cmc:inbox): only step 4 runs
 * with the capability URL standing in for the missing back-channel. The
 * counterparty-access pair doesn't exist yet; nothing to tear down
 * locally.
 *
 * Delivery failures DO NOT roll back the local deletes — local revocation
 * is the authoritative signal; peer eventual-consistency is the retry
 * loop's job. The orphan back-channel on the peer (if delivery never
 * succeeds) gets pruned by the peer's own operator script.
 */

const C = require('./constants.ts');
const slugMod = require('./slug.ts');
const outbound = require('./outbound.ts');

type Counterparty = { username: string; host: string };

type CmcClientData = {
  role?: string;
  appCode?: string;
  counterparty?: { username?: string; host?: string; apiEndpoint?: string };
  peerAccessId?: string;
  [k: string]: unknown;
};
type AccessLike = {
  id: string;
  type?: string;
  clientData?: { cmc?: CmcClientData; [k: string]: unknown };
};
type MallParams = Record<string, unknown>;

type MallLike = {
  accesses: {
    get: (userId: string, params?: MallParams) => Promise<AccessLike[]>;
    delete?: (userId: string, params: MallParams) => Promise<unknown>;
  };
};

type FetchResponse = { status: number; json?: () => Promise<unknown> };
type FetchInit = { method?: string; headers?: Record<string, string>; body?: unknown };
type OutboundDeps = {
  fetch: (url: string, init?: FetchInit) => Promise<FetchResponse>;
  timeoutMs?: number;
  logger?: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
};

type RevokeHandlerResult =
  | {
      ok: true;
      deletedAccessIds: string[];   // local accesses we deleted (counterparty + data-grant)
      peerNotified: boolean;
      peerDeliveryStatus?: number;
    }
  | {
      ok: false;
      reason: string;
      detail?: Record<string, unknown>;
    };

/**
 * Handle a `consent/revoke-cmc` trigger event.
 *
 * Inputs (on triggerEvent.content):
 *   - counterparty: { username, host }   — required for inbox revokes
 *   - appCode: string                    — optional; narrows access matching
 *   - capabilityUrl: string              — optional; pre-acceptance path
 *
 * The handler reads counterparty + appCode from triggerEvent.streamIds
 * when the trigger sits on a chats/collectors stream-id. Falls back to
 * content fields when triggered from :_cmc:inbox.
 */
async function handleRevoke (params: {
  userId: string;
  triggerEvent: { id?: string; type: string; content: Record<string, unknown>; streamIds?: string[] };
  selfIdentity: Counterparty;
  deps: { mall: MallLike } & OutboundDeps;
}): Promise<RevokeHandlerResult> {
  const { userId, triggerEvent, selfIdentity, deps } = params;
  const { mall } = deps;

  if (triggerEvent.type !== C.ET_REVOKE) {
    return { ok: false, reason: 'cmc-handler-wrong-type', detail: { type: triggerEvent.type } };
  }

  // Source the (counterparty, appCode) tuple. Priority:
  //   1. triggerEvent.streamIds — parse chats/collectors streams to extract slug + appCode
  //   2. triggerEvent.content.{counterparty, appCode} — when triggered from :_cmc:inbox
  let counterparty: Counterparty | null = null;
  let appCode: string | null = null;
  const streamIds = Array.isArray(triggerEvent.streamIds) ? triggerEvent.streamIds : [];
  for (const sid of streamIds) {
    const parsed = parseChatsOrCollectorsStreamId(sid);
    if (parsed != null) {
      appCode = parsed.appCode;
      // Need the canonical host for outbound + access matching. The slug
      // gives us hostSlug; we keep both and match on slug below.
      counterparty = {
        username: parsed.counterparty.username,
        // hostSlug → host fallback (caller-supplied content.counterparty
        // takes priority if present, but we always have slug to match
        // existing accesses).
        host: parsed.counterparty.hostSlug.replace(/-/g, '.'),
      };
      break;
    }
  }
  // Inbox / pre-acceptance: take counterparty from content.
  if (counterparty == null && triggerEvent.content?.counterparty != null) {
    const cp = triggerEvent.content.counterparty as { username?: string; host?: string };
    if (typeof cp?.username === 'string' && typeof cp?.host === 'string') {
      counterparty = { username: cp.username, host: cp.host };
    }
  }
  if (counterparty == null) {
    return { ok: false, reason: 'cmc-revoke-counterparty-missing', detail: { streamIds } };
  }
  if (appCode == null && typeof triggerEvent.content?.appCode === 'string') {
    appCode = triggerEvent.content.appCode;
  }

  // Pre-acceptance path: just deliver to peer via capabilityUrl. No local
  // teardown — the access pair doesn't exist yet.
  if (typeof triggerEvent.content?.capabilityUrl === 'string' && triggerEvent.content.capabilityUrl.length > 0) {
    const delivery = await deliverRevokeViaCapability({
      capabilityUrl: triggerEvent.content.capabilityUrl,
      counterparty: selfIdentity,
      reason: triggerEvent.content?.reason,
      deps,
    });
    if (!delivery.ok) {
      return {
        ok: false,
        reason: 'cmc-handler-delivery-failed',
        detail: { status: delivery.status, peerReason: delivery.reason },
      };
    }
    return {
      ok: true,
      deletedAccessIds: [],
      peerNotified: true,
      peerDeliveryStatus: delivery.status,
    };
  }

  // Acceptance-time path: find the counterparty-access and its paired
  // data-grant access, then tear both down.
  const accesses = await mall.accesses.get(userId, {});
  const counterpartyAccess = findCounterpartyAccess(accesses, counterparty, appCode);
  if (counterpartyAccess == null) {
    return { ok: false, reason: 'cmc-revoke-counterparty-access-not-found', detail: {
      counterparty,
      appCode,
    } };
  }

  // Find the paired data-grant (issued by us; readable to peer). Look-up
  // priority: peerAccessId pointer, then counterparty-tuple match.
  const dataGrantAccess = findPairedDataGrant(accesses, counterpartyAccess, counterparty, appCode);

  // Step 3: delete the data-grant first (revokes peer's read immediately).
  const deletedIds: string[] = [];
  if (dataGrantAccess != null && mall.accesses.delete != null) {
    try {
      await mall.accesses.delete(userId, { id: dataGrantAccess.id });
      deletedIds.push(dataGrantAccess.id);
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/handleRevoke: failed to delete data-grant access', {
        accessId: dataGrantAccess.id,
        error: String((err as Error)?.message || err),
      });
    }
  }

  // Step 4: deliver to peer via stored back-channel apiEndpoint. Best
  // effort — local revocation is authoritative even on delivery failure.
  const remoteApiEndpoint: string | undefined =
    counterpartyAccess.clientData?.cmc?.counterparty?.apiEndpoint;
  let peerNotified = false;
  let peerDeliveryStatus: number | undefined;
  if (typeof remoteApiEndpoint === 'string' && remoteApiEndpoint.length > 0) {
    try {
      const delivery = await outbound.postToPeer({
        apiEndpoint: remoteApiEndpoint,
        path: 'events',
        body: {
          streamIds: [C.NS_INBOX],
          type: C.ET_REVOKE,
          content: {
            from: selfIdentity,
            reason: triggerEvent.content?.reason,
          },
        },
        deps,
      });
      peerNotified = !!delivery.ok;
      peerDeliveryStatus = delivery.status;
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/handleRevoke: peer notify failed', {
        error: String((err as Error)?.message || err),
      });
    }
  }

  // Step 5: delete the counterparty-access.
  if (mall.accesses.delete != null) {
    try {
      await mall.accesses.delete(userId, { id: counterpartyAccess.id });
      deletedIds.push(counterpartyAccess.id);
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/handleRevoke: failed to delete counterparty access', {
        accessId: counterpartyAccess.id,
        error: String((err as Error)?.message || err),
      });
    }
  }

  return {
    ok: true,
    deletedAccessIds: deletedIds,
    peerNotified,
    peerDeliveryStatus,
  };
}

/**
 * Parse either a chats or collectors stream-id. Returns null if neither.
 */
function parseChatsOrCollectorsStreamId (streamId: string): {
  appCode: string;
  counterparty: { username: string; hostSlug: string };
} | null {
  if (typeof streamId !== 'string') return null;
  const m = streamId.match(/^(:_cmc:apps:([^:]+)(?::[^:]+)*):(?:chats|collectors):([a-z0-9-]+--[a-z0-9-]+)$/);
  if (m == null) return null;
  const appCode = m[2];
  const slug = m[3];
  let counterparty;
  try {
    counterparty = slugMod.parseCounterpartySlug(slug);
  } catch (_e) {
    return null;
  }
  return { appCode, counterparty };
}

function findCounterpartyAccess (
  accesses: AccessLike[],
  counterparty: Counterparty,
  appCode: string | null
): AccessLike | null {
  for (const acc of accesses) {
    const cmc = acc?.clientData?.cmc;
    if (cmc?.role !== 'counterparty') continue;
    const cp = cmc?.counterparty;
    if (cp == null) continue;
    if (cp.username !== counterparty.username) continue;
    if (cp.host !== counterparty.host && slugMod.slugifyHost(cp.host) !== slugMod.slugifyHost(counterparty.host)) continue;
    if (appCode != null && cmc?.appCode != null && cmc.appCode !== appCode) continue;
    return acc;
  }
  return null;
}

function findPairedDataGrant (
  accesses: AccessLike[],
  counterpartyAccess: AccessLike,
  counterparty: Counterparty,
  appCode: string | null
): AccessLike | null {
  // Prefer explicit pointer.
  const peerAccessId = counterpartyAccess.clientData?.cmc?.peerAccessId;
  if (typeof peerAccessId === 'string') {
    for (const acc of accesses) {
      if (acc.id === peerAccessId) return acc;
    }
  }
  // Fallback: any access whose clientData.cmc.role='data-grant' AND
  // clientData.cmc.counterparty matches.
  for (const acc of accesses) {
    const cmc = acc?.clientData?.cmc;
    if (cmc?.role !== 'data-grant') continue;
    const cp = cmc?.counterparty;
    if (cp == null) continue;
    if (cp.username !== counterparty.username) continue;
    if (cp.host !== counterparty.host && slugMod.slugifyHost(cp.host) !== slugMod.slugifyHost(counterparty.host)) continue;
    if (appCode != null && cmc?.appCode != null && cmc.appCode !== appCode) continue;
    return acc;
  }
  return null;
}

/**
 * Pre-acceptance revoke: post via the original capability URL (same
 * shape as deliverRefuseViaCapability in acceptOrchestration).
 */
async function deliverRevokeViaCapability (params: {
  capabilityUrl: string;
  counterparty: Counterparty;
  reason: unknown;
  deps: OutboundDeps;
}): Promise<{ ok: boolean; status?: number; reason?: string }> {
  return outbound.postToPeer({
    apiEndpoint: params.capabilityUrl,
    path: 'events',
    body: {
      streamIds: [C.NS_INBOX],
      type: C.ET_REVOKE,
      content: {
        from: params.counterparty,
        reason: params.reason,
      },
    },
    deps: params.deps,
  });
}

export {
  handleRevoke,
  parseChatsOrCollectorsStreamId,
  findCounterpartyAccess,
  findPairedDataGrant,
  deliverRevokeViaCapability,
};
