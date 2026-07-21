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
 * Triggered by `consent/revoke-cmc` written to a user-managed
 * `:_cmc:apps:*` scope stream (the client helpers' default) or to a
 * plugin-managed chats / collectors stream:
 *
 *   :_cmc:apps:<app-code>:[<path>:]chats:<slug>
 *   :_cmc:apps:<app-code>:[<path>:]collectors:<slug>
 *
 * Effect (acceptance-time chain):
 *   1. Resolve the local counterparty-access — by the trigger's
 *      `content.accessId` (authoritative), falling back to the
 *      (appCode + counterparty) tuple from the trigger stream or
 *      content.counterparty for legacy triggers without an id.
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
 * There is NO pre-acceptance revoke flow through this handler: a
 * requester cancels an open invite via `consent/invalidate-link-cmc`,
 * and an invited party declines via `consent/refuse-cmc`. (An earlier
 * `content.capabilityUrl` branch tried to deliver pre-acceptance
 * revokes through the capability access; it was unreachable — no
 * client emits such triggers — and undeliverable — the capability
 * access has neither inbox permission nor counterparty role — so it
 * was removed.)
 *
 * Delivery failures DO NOT roll back the local deletes — local revocation
 * is the authoritative signal; peer eventual-consistency is the retry
 * loop's job. The orphan back-channel on the peer (if delivery never
 * succeeds) gets pruned by the peer's own operator script.
 */

const C = require('./constants.ts');
const slugMod = require('./slug.ts');
const outbound = require('./outbound.ts');
const { CmcErrorIds } = require('./errorIds.ts');

import type { OutboundDeps } from './_types.ts';

type Counterparty = { username: string; host: string };

import type { CmcAccessLike as AccessLike, MallAccessesLike } from './_types.ts';
type MallParams = Record<string, unknown>;

type MallLike = { accesses: MallAccessesLike };


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
 *   - accessId: string                   — the relationship access to revoke
 *                                          (authoritative; the client helpers
 *                                          always send it)
 *   - counterparty: { username, host }   — legacy fallback selector
 *   - appCode: string                    — optional; narrows tuple matching
 *
 * The handler reads counterparty + appCode from triggerEvent.streamIds
 * when the trigger sits on a chats/collectors stream-id. Falls back to
 * content fields for triggers that carry them instead.
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
  // Legacy triggers may carry the counterparty in content instead of a
  // parseable stream id.
  if (counterparty == null && triggerEvent.content?.counterparty != null) {
    const cp = triggerEvent.content.counterparty as { username?: string; host?: string };
    if (typeof cp?.username === 'string' && typeof cp?.host === 'string') {
      counterparty = { username: cp.username, host: cp.host };
    }
  }
  // Explicit target: the client helpers always send `content.accessId`
  // (it is required by the revoke content schema). With several
  // relationships to the same counterparty the tuple match below is
  // ambiguous, so the explicit id is the authoritative selector.
  const explicitAccessId =
    (typeof triggerEvent.content?.accessId === 'string' && triggerEvent.content.accessId.length > 0)
      ? triggerEvent.content.accessId
      : null;
  if (counterparty == null && explicitAccessId == null) {
    return { ok: false, reason: 'cmc-revoke-counterparty-missing', detail: { streamIds } };
  }
  if (appCode == null && typeof triggerEvent.content?.appCode === 'string') {
    appCode = triggerEvent.content.appCode;
  }

  // Acceptance-time path: find the counterparty-access and its paired
  // data-grant access, then tear both down.
  //
  // Selection order:
  //   1. `content.accessId` (when present) — resolved by id and required
  //      to be a CMC relationship access. NO tuple fallback when the id
  //      doesn't resolve: on a duplicate revoke (access already gone,
  //      e.g. after a raw accesses.delete) a fallback would select a
  //      DIFFERENT relationship to the same counterparty and tear that
  //      one down instead.
  //   2. (username, host, appCode) tuple match — legacy triggers without
  //      an explicit id.
  const accesses = await mall.accesses.get(userId, {});
  let counterpartyAccess: AccessLike | null = null;
  if (explicitAccessId != null) {
    const byId = accesses.find((a) => a.id === explicitAccessId) ?? null;
    if (byId != null && byId.clientData?.cmc?.role === 'counterparty') {
      counterpartyAccess = byId;
    }
    if (counterpartyAccess == null) {
      return { ok: false, reason: 'cmc-revoke-counterparty-access-not-found', detail: {
        accessId: explicitAccessId,
        counterparty,
        appCode,
      } };
    }
    // The trigger may sit on a plain app-scope stream (the client
    // helpers default to the invite's own stream, which is neither
    // chats nor collectors) — derive the counterparty identity from
    // the resolved access when the trigger didn't provide one.
    const cp = counterpartyAccess.clientData?.cmc?.counterparty;
    if (counterparty == null && typeof cp?.username === 'string' && typeof cp?.host === 'string') {
      counterparty = { username: cp.username, host: cp.host };
    }
  } else {
    counterpartyAccess = findCounterpartyAccess(accesses, counterparty!, appCode);
    if (counterpartyAccess == null) {
      return { ok: false, reason: 'cmc-revoke-counterparty-access-not-found', detail: {
        counterparty,
        appCode,
      } };
    }
  }

  // Find the paired data-grant (issued by us; readable to peer). Look-up
  // priority: peerAccessId pointer, then counterparty-tuple match.
  const dataGrantAccess = findPairedDataGrant(accesses, counterpartyAccess, counterparty, appCode);

  // Permission check — the trigger-writing access must be able to delete
  // each target (data-grant + counterparty) per the standard
  // AccessLogic.canDeleteAccess rule (the same rule the api-server's
  // accesses.delete route enforces). Reuses the existing primitive —
  // honours the `selfRevoke` feature permission on the target accesses.
  // No parallel "can revoke" logic.
  //
  // Personal token: always passes (isPersonal short-circuits).
  // Self-revoke (the access being revoked is the same as the trigger
  //   writer): passes if the target carries selfRevoke != 'forbidden'
  //   (default allow). This is the natural Pryv model — a relationship's
  //   data-grant access can be used by its holder to terminate the
  //   relationship without bouncing to the user.
  // App-token created the target: passes (createdBy match).
  // Otherwise: rejected with cmc-revoke-forbidden.
  //
  // Plugin-managed peer-delivered revokes never reach this handler — the
  // dispatch's `isPeerDeliveredEvent` short-circuit on OUTBOUND_LOOPABLE_TYPES
  // returns 'skipped' before this code runs. So we don't need to special-case
  // counterparty/capability accesses here.
  const triggerAccess = (deps as { triggerAccess?: { canDeleteAccess?: (access: { type: string; id?: string; createdBy?: string }) => boolean | Promise<boolean> } })?.triggerAccess;
  async function canTriggerDelete (target: { type?: string; id?: string; createdBy?: string }): Promise<boolean> {
    if (triggerAccess?.canDeleteAccess == null) return true;
    if (typeof target.type !== 'string' || typeof target.id !== 'string') return true;
    try {
      return await triggerAccess.canDeleteAccess({ type: target.type, id: target.id, createdBy: target.createdBy });
    } catch (_e) {
      return false;
    }
  }
  if (dataGrantAccess != null) {
    const ok = await canTriggerDelete(dataGrantAccess as { type?: string; id?: string; createdBy?: string });
    if (!ok) {
      return {
        ok: false,
        reason: CmcErrorIds.REVOKE_FORBIDDEN,
        detail: { message: 'trigger-writing access lacks permissions to delete the data-grant access', accessId: dataGrantAccess.id },
      };
    }
  }
  {
    const ok = await canTriggerDelete(counterpartyAccess as { type?: string; id?: string; createdBy?: string });
    if (!ok) {
      return {
        ok: false,
        reason: CmcErrorIds.REVOKE_FORBIDDEN,
        detail: { message: 'trigger-writing access lacks permissions to delete the counterparty access', accessId: counterpartyAccess.id },
      };
    }
  }

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
  // Requester side stores the peer path on `counterparty.apiEndpoint`;
  // the accepter side mirrors it there once the back-channel lands, but
  // fall back to the original `backChannelApiEndpoint` field for
  // accesses minted before the mirror existed.
  const remoteApiEndpoint: string | undefined =
    counterpartyAccess.clientData?.cmc?.counterparty?.apiEndpoint ??
    counterpartyAccess.clientData?.cmc?.backChannelApiEndpoint;
  let peerNotified = false;
  let peerDeliveryStatus: number | undefined;
  if (typeof remoteApiEndpoint === 'string' && remoteApiEndpoint.length > 0) {
    // `accessId` is REQUIRED by the peer's revoke content schema
    // (validators.validateRevoke) — without it the peer's content
    // validation hook rejects the inbox write with 400 and the
    // revocation is never observable on the other side. Use the id of
    // the relationship access being torn down here; stamp the
    // correlation ids (appCode / offer / accept event ids) when the
    // access carries them so the peer can match the revocation to the
    // originating invite.
    const revokeContent: Record<string, unknown> = {
      accessId: counterpartyAccess.id,
      from: selfIdentity,
      reason: triggerEvent.content?.reason,
    };
    const cpCmc = counterpartyAccess.clientData?.cmc;
    if (typeof cpCmc?.appCode === 'string') revokeContent.appCode = cpCmc.appCode;
    if (typeof cpCmc?.offerEventId === 'string') revokeContent.offerEventId = cpCmc.offerEventId;
    if (typeof cpCmc?.acceptEventId === 'string') revokeContent.acceptEventId = cpCmc.acceptEventId;
    try {
      const delivery = await outbound.postToPeer({
        apiEndpoint: remoteApiEndpoint,
        path: 'events',
        body: {
          streamIds: [C.NS_INBOX],
          type: C.ET_REVOKE,
          content: revokeContent,
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
  counterparty: Counterparty | null,
  appCode: string | null
): AccessLike | null {
  // Prefer explicit pointer.
  const peerAccessId = counterpartyAccess.clientData?.cmc?.peerAccessId;
  if (typeof peerAccessId === 'string') {
    for (const acc of accesses) {
      if (acc.id === peerAccessId) return acc;
    }
  }
  // Tuple fallback needs a counterparty identity to match against.
  if (counterparty == null) return null;
  // Fallback: every access whose clientData.cmc.role='data-grant' AND
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

export {
  handleRevoke,
  parseChatsOrCollectorsStreamId,
  findCounterpartyAccess,
  findPairedDataGrant,
};
