/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger, CmcAccessLike as AccessLike, MallLike } from './_types.ts';
import type { Features } from './features.ts';
import type { MemberSweep } from './memberSweep.ts';

const require = createRequire(import.meta.url);

/**
 * CMC plugin — requester-side incoming `consent/accept-cmc` handler.
 *
 * When the accepter posts a `consent/accept-cmc` event back to the requester's
 * platform via the capability URL, the event lands on the capability's
 * responses stream (`:_cmc:_internal:responses:<capId>`); one posted on
 * `:_cmc:inbox` is refused by inboxWriteHook. The requester needs to provision
 * the BACK-CHANNEL access — i.e. mint an access on their own account
 * scoped to the accepter's CMC namespace so future chat / system
 * deliveries from the requester to the accepter have an authoritated
 * apiEndpoint to POST to.
 *
 * Flow:
 *   1. Extract content.grantedAccess.apiEndpoint (the accepter's
 *      data-grant URL — that's where the requester's app can READ the
 *      accepted permissions).
 *   2. Extract content.from ({username, host} of the accepter, as
 *      delivered with the accept on the capability's responses stream).
 *   3. Read the original request event from one of the requester's
 *      `:_cmc:apps:<app>:[<path>:]` streams to find the appCode + scope.
 *   3b. Resolve the relationship's features against our own copy of the
 *      offer (the offer's, narrowed by the accept; see features.ts).
 *   4. Create the back-channel access:
 *      - permissions: create on `:_cmc:inbox` + rights on the collectors
 *        stream under the app scope, and on the chats stream only when
 *        the resolved `features.chat` is true.
 *      - clientData.cmc = {role:'counterparty', appCode, features,
 *        counterparty: {username, host, apiEndpoint, remoteChatStreamId
 *        (null without chat), remoteCollectorStreamId}}
 *      - The remote stream-ids are computed deterministically from our
 *        identity (the accepter mirrors the structure on their side).
 *   5. Auto-create the anchor streams on this side:
 *      - :_cmc:apps:<app>:[<path>:]chats
 *      - :_cmc:apps:<app>:[<path>:]chats:<accepter-slug>  (only with chat)
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
const anchors = require('./anchorStreams.ts');
const capabilityMod = require('./capability.ts');
const inviteState = require('./inviteState.ts');
const relationshipKey = require('./relationshipKey.ts');
const { CmcErrorIds } = require('./errorIds.ts');
const { featuresFromOffer, resolveFeatures }: typeof import('./features.ts') = require('./features.ts');
// Through the module object, so a test standing for an older core can turn
// the close-out off at call time (replacedGrants.setOlderPeerForTests).
const replacedGrants: typeof import('./replacedGrants.ts') = require('./replacedGrants.ts');
const crypto = require('node:crypto');

type Counterparty = { username: string; host: string };

type IncomingAcceptResult =
  | {
    ok: true;
    backChannelAccessId: string;
    backChannelApiEndpoint?: string;
    anchorStreamIds: string[];
    appCode: string;
    counterparty: Counterparty;
    // The accept re-paired an existing relationship to another grant of the
    // same account: the former pairing was closed out.
    rePaired?: boolean;
    // What became of the back-channel delivery to the accepter: posted,
    // queued for the retry loop, or failed for good (a 4xx, a refused
    // destination). Absent when nothing was sent (no fetch wired).
    backChannelDelivery?: 'delivered' | 'queued' | 'failed';
  }
  | {
    ok: false;
    reason: string;
    detail?: unknown;
  };

type SelfIdentity = { username: string; host: string };

/**
 * Process an incoming `consent/accept-cmc` event after it has been persisted
 * on the capability's responses stream. Provisions the back-channel access +
 * anchor streams, and mirrors a copy to the requester's :_cmc:inbox.
 *
 * On stream-create failures: we ignore "stream-already-exists" (idempotent —
 * a re-delivery of the same accept just rebuilds the same anchors). Other
 * stream-create errors fail the handler so an operator can investigate.
 */
async function handleIncomingAccept (params: {
  userId: string;
  acceptEvent: { id?: string; type: string; content: Record<string, unknown>; streamIds?: string[]; createdBy?: string; created?: number };
  selfIdentity: SelfIdentity;
  deps: {
    mall: MallLike;
    logger?: CmcLogger;
    fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
    notifyEventChanged?: (userId: string, event: { id?: string }) => void;
    // The member accesses made through a former grant are swept when an
    // accept re-pairs the relationship (replacedGrants.closeOutFormerPairing).
    memberSweep?: Partial<Pick<MemberSweep, 'sweepRelationship'>>;
  };
}): Promise<IncomingAcceptResult> {
  const { userId, acceptEvent, selfIdentity, deps } = params;
  const { mall } = deps;

  if (acceptEvent.type !== C.ET_ACCEPT) {
    return { ok: false, reason: 'cmc-incoming-accept-wrong-type', detail: { type: acceptEvent.type } };
  }

  const grantedApiEndpoint = (acceptEvent.content?.grantedAccess as { apiEndpoint?: string } | undefined)?.apiEndpoint;
  if (typeof grantedApiEndpoint !== 'string' || grantedApiEndpoint.length === 0) {
    return { ok: false, reason: 'cmc-incoming-accept-no-granted-apiendpoint' };
  }

  const cp = acceptEvent.content?.from as { username?: string; host?: string } | undefined;
  if (cp == null || typeof cp.username !== 'string' || typeof cp.host !== 'string') {
    return { ok: false, reason: 'cmc-incoming-accept-from-missing' };
  }
  // Usernames are lowercase: a case variant would miss the relationship it
  // names in the lookup below while still landing on its streams and name.
  const counterparty: Counterparty = { username: cp.username.toLowerCase(), host: cp.host };

  // The capability this accept came through, taken from the responses stream
  // it was written to (the only stream the capability token can write, so
  // server-controlled), never from the content, which the accepter writes: an
  // accept leaving `capabilityId` out would otherwise skip the capability
  // lookup, keep its own `inviteEventId` on the inbox mirror and leave a
  // single-use link open. A content value naming another capability fails
  // the accept before any relationship is created; off a responses stream
  // (no server-controlled key) the content value is ignored.
  const capabilityIdToConsume = capabilityIdOfResponsesStream(acceptEvent.streamIds);
  const claimedCapabilityId = acceptEvent.content?.capabilityId;
  if (capabilityIdToConsume != null && claimedCapabilityId != null && claimedCapabilityId !== capabilityIdToConsume) {
    return {
      ok: false,
      reason: 'cmc-incoming-accept-capability-mismatch',
      detail: {
        capabilityId: typeof claimedCapabilityId === 'string' ? claimedCapabilityId : null,
        responsesStreamCapabilityId: capabilityIdToConsume,
      },
    };
  }

  // The scope stream-id under which to anchor the chat/collectors streams,
  // and its appCode. Priority order (most authoritative first):
  //   1. On a responses stream, this side's offer copy for that capability
  //      (its `originStreamId`, stamped at mint): server-controlled.
  //   2. acceptEvent.content.requesterOriginStreamId, then requesterAppCode:
  //      set by the accepter's handleAccept from the offer it read.
  //   3. resolveRequestScope: the request event the accept names by id,
  //      in this side's own store.
  //   4. Fall back to 'unknown': the back-channel access still gets
  //      created; chat/system handlers won't match it but the
  //      handshake itself is recorded.
  let scopeStreamId: string | null = null;
  let appCode: string | null = null;
  // This side's copy of the offer, read once: it serves the scope fallback
  // below and the features resolution.
  const offerCopy = await findOfferCopy({ userId, acceptEvent, mall });
  // An accept on a responses stream answers the offer this side minted for
  // that capability: its copy decides the scope, and the accepter's content
  // (which could name any other scope of this account) is only a fallback
  // when the copy carries none. An honest accepter echoes the same value.
  if (offerCopy.via === 'responses-stream') {
    const fromCopy = await resolveRequestScope({ userId, acceptEvent, mall, requestEvent: offerCopy.event });
    if (fromCopy.scopeStreamId != null && fromCopy.appCode != null) {
      scopeStreamId = fromCopy.scopeStreamId;
      appCode = fromCopy.appCode;
    }
  }
  const fromAcceptContent = acceptEvent.content?.requesterAppCode;
  const originStreamFromAccept = acceptEvent.content?.requesterOriginStreamId;
  if (scopeStreamId == null && typeof originStreamFromAccept === 'string' && originStreamFromAccept.length > 0 &&
      originStreamFromAccept.startsWith(C.NS_APPS + ':')) {
    // Without a scope from the offer copy: the accepter passed back the requester's
    // per-request streamId (e.g. :_cmc:apps:my-app:study-1). Anchors
    // land exactly here, so chat/system triggers in the same scope
    // resolve cleanly.
    scopeStreamId = originStreamFromAccept;
    appCode = C.getAppCode(originStreamFromAccept) ?? null;
  }
  if (scopeStreamId == null && typeof fromAcceptContent === 'string' && fromAcceptContent.length > 0) {
    appCode = fromAcceptContent;
    scopeStreamId = C.NS_APPS + ':' + appCode;
  }
  if (scopeStreamId == null) {
    try {
      const lookup = await resolveRequestScope({ userId, acceptEvent, mall, requestEvent: offerCopy.event });
      scopeStreamId = lookup.scopeStreamId;
      appCode = lookup.appCode;
    } catch (err: unknown) {
      return { ok: false, reason: 'cmc-incoming-accept-scope-lookup-failed', detail: { message: String((err as Error)?.message || err) } };
    }
    if (scopeStreamId == null || appCode == null) {
      appCode = 'unknown';
      scopeStreamId = C.NS_APPS + ':' + appCode;
    }
  }

  // Compute the relevant slugs + stream-ids. The peer's stream-ids
  // mirror the structure on their account (both sides derive from
  // app-scope + counterparty slug — deterministic).
  // Re-delivery of an accept for a relationship we already hold must update
  // THAT relationship's access, not mint a second one. Match on the scope
  // rather than the name: an access minted before names carried the scope
  // still resolves (the selector derives its scope from its own channel
  // permissions), so it is healed in place (below) instead of being
  // duplicated under the new name. Looked up here: its features cap the
  // resolution that follows.
  let existingForScope: AccessLike | null = null;
  if (typeof mall.accesses.get === 'function' && typeof mall.accesses.update === 'function') {
    try {
      const existingList = await mall.accesses.get(userId, {});
      existingForScope = relationshipKey.selectRelationshipAccess({
        accesses: existingList,
        counterparty: {
          username: counterparty.username,
          hostSlug: slugMod.slugifyHost(counterparty.host),
        },
        scopeStreamId,
        appCode,
        logger: deps.logger,
      });
    } catch (err: unknown) {
      // Non-fatal: fall through to create, which has its own duplicate path.
      deps.logger?.warn?.('cmc/handleIncomingAccept: back-channel reuse lookup failed', {
        error: String((err as Error)?.message || err),
      });
    }
  }
  // `content.from` is declared by the accepter: the relationship it names is
  // only healed by an accept from the account it was made with. Checked
  // before anything is written.
  if (existingForScope != null && !mayHealRelationship(existingForScope, grantedApiEndpoint, capabilityIdToConsume)) {
    return refuseForeignHeal(existingForScope, deps.logger);
  }
  // When this accept was received here (its `created`, this core's clock;
  // read back by id for a retry, whose snapshot does not carry it). Stamped
  // on the relationship: an accept received BEFORE the one the relationship
  // is paired with (an older accept a retry delivers late) is refused before
  // anything is written, or it would re-pair the relationship to a grant the
  // accepter has just ended as replaced. A relationship without the stamp
  // (paired before it existed) has no such guard.
  // An age that could not be read (a storage error on a retry, the only case
  // the guard exists for) is never taken as a pass on a stamped relationship:
  // a retryable failure.
  const age = await acceptCreatedAt({ userId, acceptEvent, mall });
  if (age === 'unreadable' && existingForScope != null && receivedAtOf(existingForScope) != null) {
    return { ok: false, reason: 'cmc-incoming-accept-age-unreadable', detail: { backChannelAccessId: existingForScope.id ?? null } };
  }
  const acceptReceivedAt = age === 'unreadable' ? null : age;
  if (existingForScope != null && isSupersededAccept(existingForScope, acceptReceivedAt)) {
    return refuseSupersededAccept(existingForScope, acceptEvent, deps.logger);
  }

  // The relationship's features, resolved against OUR copy of the offer: the
  // offer's, narrowed by what the accepter sent. A peer that sends a wider
  // value (an older core, or a forged delivery) cannot turn on here a feature
  // this side's offer turned off, as long as the copy is found: by the
  // responses stream the accept was written to (server-controlled), else by
  // the id the accept names. An accept whose offer copy is gone has no
  // server-controlled key (one a peer would post on the inbox is refused by
  // the inbox hook): it can only narrow a relationship this side already
  // holds, never widen it. For a new
  // relationship without a readable copy the delivered value decides.
  // Stamped on the back-channel and the inbox mirror; with `chat: false` no
  // chat leaf and no chat permission exist.
  const offeredFeatures = offerFeatures(offerCopy, acceptEvent, deps.logger);
  let negotiatedFeatures: Features = resolveFeatures(
    offeredFeatures,
    (acceptEvent?.content as { features?: { chat?: unknown; systemMessaging?: unknown } | null } | undefined)?.features
  );
  if (offerCopy.via !== 'responses-stream' && existingForScope != null) {
    const existingCmc = existingForScope.clientData?.cmc as { features?: unknown; inviteEventId?: unknown } | undefined;
    let ceiling = existingCmc?.features as { chat?: unknown; systemMessaging?: unknown } | null | undefined;
    // A relationship recorded before features were stamped: its invite, our
    // own request, says what was offered.
    if (ceiling == null && typeof existingCmc?.inviteEventId === 'string' && mall.events?.getOne != null) {
      try {
        const invite = await mall.events.getOne(userId, existingCmc.inviteEventId) as OfferCopyEvent | null;
        if (invite != null && invite.type === C.ET_REQUEST) ceiling = featuresFromOffer(invite.content);
      } catch (_e) {
        // No invite to read: the legacy contract (permissive) stands.
      }
    }
    negotiatedFeatures = resolveFeatures(negotiatedFeatures, ceiling);
  }

  const peerSlug = slugMod.counterpartySlug({ username: counterparty.username, host: counterparty.host });
  const selfSlug = slugMod.counterpartySlug({ username: selfIdentity.username, host: selfIdentity.host });
  const chatStream: string | null = negotiatedFeatures.chat ? C.chatStreamUnder(scopeStreamId, peerSlug) : null;
  const collectorStream = C.collectorStreamUnder(scopeStreamId, peerSlug);
  const remoteChatStreamId: string | null = negotiatedFeatures.chat ? C.chatStreamUnder(scopeStreamId, selfSlug) : null;
  const remoteCollectorStreamId = C.collectorStreamUnder(scopeStreamId, selfSlug);

  // Provision the anchor streams (no chat leaf without chat). Idempotent.
  const provisioned = await anchors.provisionAnchorStreams({
    userId,
    scopeStreamId,
    peerSlug,
    mall,
    chat: negotiatedFeatures.chat,
  });
  if (!provisioned.ok) {
    return {
      ok: false,
      reason: 'cmc-incoming-accept-anchor-stream-create-failed',
      detail: { streamId: provisioned.failedStreamId, message: provisioned.failureMessage },
    };
  }
  const created = provisioned.created;

  // Mint the back-channel access. Permissions:
  //   - create-only on :_cmc:inbox (so the peer can deliver to us)
  //   - contribute on the collectors anchor stream, and on the chats one when
  //     the relationship has chat (so the peer can deliver system messages,
  //     and chats, targeted to our slug)
  //
  // Name disambiguator: appCode + peerSlug (separated by `--`) so two
  // distinct apps with the same counterparty don't collide. If a stale
  // access with the same name exists (e.g. from a re-delivery or a
  // previous run that minted under different scope rules), update it
  // in-place rather than failing the whole handshake — re-delivery is a
  // legitimate retry path and the access's clientData + permissions
  // must reflect the LATEST acceptance.
  // The name must be unique PER RELATIONSHIP, not per (app, peer): two
  // studies run by one collector with one patient are separate
  // relationships with separate channels. Naming them alike made the
  // second handshake collide with the first and update it in place,
  // repointing the first relationship's permissions and counterparty at
  // the second's scope — after which deliveries on the first went to the
  // second's streams.
  //
  // The suffix is a hash of the full scope rather than a transliteration of
  // it: mapping ':'→'-' would collapse distinct scopes (`study:a` and
  // `study-a`) onto one name, and the by-name reuse path would then heal the
  // wrong relationship's access — resurrecting the very overwrite this fix
  // removes. A hash cannot collide two different scopes. The bare app-root
  // scope keeps the historical name so single-relationship deployments are
  // untouched. (Matching is by scope, not by name — see the reuse lookup
  // below — so the name only needs to be collision-free, not readable.)
  const scopeSuffix = (typeof scopeStreamId === 'string' &&
                       scopeStreamId !== C.NS_APPS + ':' + appCode)
    ? '--' + crypto.createHash('sha1').update(scopeStreamId).digest('hex').slice(0, 12)
    : '';
  const accessName = 'cmc-back-channel-' + appCode + '--' + peerSlug + scopeSuffix;
  // The capability this accept came through. Stamped on the back-channel
  // access: for an open-link invite, the relationship accesses carrying it ARE
  // the list of who joined. Also used below to consume the link and enrich the
  // mirror. `capabilityIdToConsume` is resolved at the top, from the stream.
  // An accept on a responses stream is written with the capability token, so
  // its `createdBy` names the capability access: read it by id rather than
  // scanning every access. `<accessId> <callerId>` when a callerId was given.
  const createdBy = typeof acceptEvent.createdBy === 'string' ? acceptEvent.createdBy : '';
  const capabilityAccessIdHint = createdBy.split(' ')[0] || null;

  // Look up the local capability access once. Three consumers below: the
  // back-channel access's `inviteEventId` stamp, the inbox-mirror enrichment,
  // and the state-flip block. The accepter's plugin only knows `capabilityId`
  // from the URL/cap-id; only the requester (here) can read
  // `clientData.cmc.requestEventId`, which is the original invite trigger event
  // id from `consent/request-cmc` — the one the doctor's app uses with
  // `cmc.revokeRelationship({inviteEventId})`.
  let capabilityAccess: { id?: string; token?: string; [k: string]: unknown } | null = null;
  if (typeof capabilityIdToConsume === 'string' && capabilityIdToConsume.length > 0) {
    try {
      capabilityAccess = await capabilityMod.findCapabilityAccess({
        userId, capabilityId: capabilityIdToConsume, accessId: capabilityAccessIdHint, deps: { mall },
      });
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/handleIncomingAccept: capability access lookup failed (non-fatal)', {
        capabilityId: capabilityIdToConsume,
        error: String((err as Error)?.message || err),
      });
    }
  }
  // The responses-stream write-hook checked the capability state when the
  // accept was written; the requester may have withdrawn the link
  // (handleInvalidateLink) in the window since. Re-read it here, before minting
  // the relationship, and refuse if it flipped, so an accept racing a
  // withdrawal does not open a relationship the requester believes closed.
  const capabilityStateNow =
    (capabilityAccess?.clientData as { cmc?: { capability?: { state?: string } } } | undefined)?.cmc?.capability?.state;
  if (capabilityStateNow === 'invalidated') {
    return { ok: false, reason: CmcErrorIds.CAPABILITY_INVALIDATED };
  }
  const inviteEventId: string | null =
    ((capabilityAccess?.clientData as { cmc?: { requestEventId?: string } } | undefined)?.cmc?.requestEventId ?? null) as string | null;
  // The offer copy this accept answers, already on the wire from the accepter
  // (`acceptOrchestration` sends it as `originalEventId`). Stamping it here is
  // what lets a revoke forwarded from THIS side carry an id the accepter's app
  // can match against its own accept trigger.
  const offerEventId: string | null =
    typeof acceptEvent?.content?.originalEventId === 'string'
      ? acceptEvent.content.originalEventId
      : null;

  // The chat permission only for a relationship with chat.
  const backChannelPermissions: Array<{ streamId: string; level: string }> = [
    { streamId: C.NS_INBOX, level: 'create-only' },
  ];
  if (chatStream != null) backChannelPermissions.push({ streamId: chatStream, level: 'contribute' });
  backChannelPermissions.push({ streamId: collectorStream, level: 'contribute' });
  const accessParams = {
    type: 'shared',
    name: accessName,
    permissions: backChannelPermissions,
    clientData: {
      cmc: {
        role: 'counterparty',
        appCode,
        // Names THIS relationship on both accounts — see relationshipKey.ts.
        scopeStreamId: typeof scopeStreamId === 'string' ? scopeStreamId : null,
        // Correlate back to the capability: an open-link invite's joins are the
        // relationship accesses carrying it. null for legacy accepters
        // (pre-stamp); heal-in-place rewrites clientData so it self-refreshes.
        capabilityId: typeof capabilityIdToConsume === 'string' && capabilityIdToConsume.length > 0 ? capabilityIdToConsume : null,
        // Correlation ids a revoke forwarded from this side can carry, so the
        // peer's app can match the arrival to the invite it already holds
        // instead of to our local access id, which it never saw. Null for
        // relationships whose accept predates the stamp; the heal-in-place
        // path rewrites clientData, so they self-refresh on the next accept.
        offerEventId,
        inviteEventId,
        // The peer's accept trigger this relationship descends from: a revoke
        // naming another one is for an earlier relationship, re-established
        // since (handleIncomingRevoke). Null from a peer of an earlier release.
        peerAcceptEventId: typeof acceptEvent.content?.acceptEventId === 'string' && acceptEvent.content.acceptEventId.length > 0
          ? acceptEvent.content.acceptEventId
          : null,
        // When that accept was received (see the guard above); an accept of
        // unknown age keeps the relationship's previous value.
        peerAcceptReceivedAt: acceptReceivedAt ?? receivedAtOf(existingForScope),
        // The resolved features: handleChat / handleSystem on this side, and
        // the inbound features gate, enforce them.
        features: negotiatedFeatures,
        counterparty: {
          username: counterparty.username,
          host: counterparty.host,
          apiEndpoint: grantedApiEndpoint,
          remoteChatStreamId,
          remoteCollectorStreamId,
        },
      },
    },
  };
  // Immediately before the mint, read the capability again from storage (the
  // copy above may be seconds old): a withdrawal that completed meanwhile
  // must stop the relationship here, not after it exists.
  if (typeof capabilityIdToConsume === 'string' && capabilityIdToConsume.length > 0) {
    let fresh: Awaited<ReturnType<typeof capabilityMod.findCapabilityAccess>> | undefined;
    try {
      fresh = await capabilityMod.findCapabilityAccess({
        userId, capabilityId: capabilityIdToConsume, accessId: capabilityAccess?.id ?? capabilityAccessIdHint, deps: { mall },
      });
    } catch (err: unknown) {
      // A storage error is not a verdict: the responses-stream write hook
      // already checked this capability once when the accept was written, so
      // the mint goes on with that check, and the failure is logged.
      deps.logger?.warn?.('cmc/handleIncomingAccept: capability re-read before the mint failed (continuing)', {
        capabilityId: capabilityIdToConsume, error: String((err as Error)?.message || err),
      });
    }
    if (fresh !== undefined) {
      const freshState = (fresh?.clientData as { cmc?: { capability?: { state?: string } } } | undefined)?.cmc?.capability?.state;
      if (freshState === 'invalidated') {
        return { ok: false, reason: CmcErrorIds.CAPABILITY_INVALIDATED };
      }
      // The access found a moment ago is gone (deleted since, which is how a
      // link is torn down for good): the same withdrawal verdict as a state
      // flip, since that is what the deletion means for this accept. Not
      // raised when the first lookup found nothing either: that orphan case
      // is handled above, with the write hook's check as the authority.
      if (fresh == null && capabilityAccess != null) {
        return { ok: false, reason: CmcErrorIds.CAPABILITY_INVALIDATED };
      }
    }
  }
  // A relationship we already hold for this scope is healed in place.
  // `healedFrom` keeps it as it was before: a re-pairing is closed out below.
  let access: AccessLike | null = null;
  let healedFrom: AccessLike | null = null;
  if (existingForScope != null) {
    try {
      // `update` exists: the lookup that set existingForScope required it.
      const updated = await mall.accesses.update!(userId, {
        id: existingForScope.id,
        update: {
          permissions: accessParams.permissions,
          clientData: accessParams.clientData,
        },
      });
      access = updated ?? existingForScope;
      healedFrom = existingForScope;
    } catch (err: unknown) {
      // Non-fatal: fall through to create, which has its own duplicate path.
      deps.logger?.warn?.('cmc/handleIncomingAccept: back-channel reuse update failed', {
        error: String((err as Error)?.message || err),
      });
    }
  }
  try {
    if (access == null) access = await mall.accesses.create(userId, accessParams);
  } catch (err: unknown) {
    // Duplicate name (re-delivery / re-run) — look up the existing access
    // and update its clientData + permissions to reflect the latest
    // handshake state. This makes re-delivery idempotent and lets us heal
    // accesses that were minted under earlier (buggy) scope rules.
    const msg = String((err as Error)?.message || err);
    const isDuplicate = (err as { id?: string })?.id === 'item-already-exists' ||
      (err as { id?: string })?.id === 'duplicate-key' ||
      /duplicate key|already exists|item-already-exists/i.test(msg);
    if (!isDuplicate) {
      return {
        ok: false,
        reason: 'cmc-incoming-accept-back-channel-create-failed',
        detail: { message: msg },
      };
    }
    const existing = await findAccessByName({ mall, userId, name: accessName });
    if (existing == null) {
      return {
        ok: false,
        reason: 'cmc-incoming-accept-back-channel-duplicate-but-not-found',
        detail: { name: accessName },
      };
    }
    if (!mayHealRelationship(existing, grantedApiEndpoint, capabilityIdToConsume)) {
      return refuseForeignHeal(existing, deps.logger);
    }
    if (isSupersededAccept(existing, acceptReceivedAt)) {
      return refuseSupersededAccept(existing, acceptEvent, deps.logger);
    }
    if (typeof mall.accesses.update === 'function') {
      try {
        const updated = await mall.accesses.update(userId, {
          id: existing.id,
          update: {
            permissions: accessParams.permissions,
            clientData: {
              ...accessParams.clientData,
              cmc: { ...accessParams.clientData.cmc, peerAcceptReceivedAt: acceptReceivedAt ?? receivedAtOf(existing) },
            },
          },
        });
        access = updated ?? existing;
        healedFrom = existing;
      } catch (uerr: unknown) {
        // Partial healing — at least surface the existing access id so the
        // chat/system handlers can still find it; permissions might be
        // stale but the resolver matches on (appCode, counterparty) which
        // we just refreshed in-memory below if update succeeded.
        deps.logger?.warn?.('cmc/handleIncomingAccept: existing back-channel access update failed', {
          accessId: existing.id,
          error: String((uerr as Error)?.message || uerr),
        });
        access = existing;
      }
    } else {
      access = existing;
    }
  }

  // A re-pairing: the same account accepted again (another invite on the
  // same scope, a new grant) and the relationship was healed to the new
  // grant. The latest accept replaces the former: the member accesses made
  // through the former grant are swept through it, and the former invite is
  // stamped `revoked` with `replacedBy`. The accepter's core ends the former
  // grant itself when the back-channel below reaches the new one
  // (replacedGrants.ts). The same accept delivered again (same grant) closes
  // nothing out. Directly after the heal: once it is written, the former
  // endpoint survives only in `healedFrom`, so a failure or a crash later in
  // this handler must not come between them (a retry would find the
  // relationship on the new endpoint, with nothing left to close out).
  let rePaired = false;
  if (healedFrom != null && replacedGrants.isRePairing(healedFrom, grantedApiEndpoint)) {
    rePaired = true;
    await replacedGrants.closeOutFormerPairing({
      userId,
      former: healedFrom,
      newInviteEventId: inviteEventId,
      deps: { mall, logger: deps.logger, notifyEventChanged: deps.notifyEventChanged, memberSweep: deps.memberSweep },
    });
  }

  const capabilityMode = (capabilityAccess?.clientData as { cmc?: { capability?: { mode?: string } } } | undefined)?.cmc?.capability?.mode;

  // Single-use lifecycle: flip the capability access's
  // `clientData.cmc.capability.state` from 'open' to 'consumed' so a
  // subsequent re-click via the same capabilityUrl can be rejected
  // with `cmc-capability-consumed` by the responses-stream write-hook
  // (instead of silently re-running this handler and minting a
  // duplicate back-channel access). Open-link mode skips this step:
  // capabilities with `mode: 'open-link'` keep state='open' until
  // explicit invalidation, and write nothing here: the back-channel access
  // just minted is the record of this join, which is what the response-stream
  // write-hook reads to refuse a same-subject re-click. Best-effort; the
  // back-channel access is already minted so the relationship is established.
  //
  // Runs BEFORE the invite is stamped 'accepted' and before the outbound
  // back-channel delivery: an app that sees the accepted trigger may at once
  // answer the same link again (refusal or second accept), and that answer
  // must meet a consumed capability, not an open one.
  //
  // `capabilityIdToConsume` and `capabilityAccess` were resolved above
  // (for the inbox-mirror enrichment). Reuse to avoid a second lookup.
  if (typeof capabilityIdToConsume === 'string' && capabilityIdToConsume.length > 0) {
    try {
      if (capabilityMode === 'single-use' || capabilityMode == null) {
        // Default 'single-use' for legacy capabilities minted before
        // this field existed.
        await capabilityMod.markCapabilityConsumed({
          userId,
          capabilityId: capabilityIdToConsume,
          accessId: capabilityAccess?.id ?? capabilityAccessIdHint,
          deps: { mall, logger: deps.logger },
        });
      }
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/handleIncomingAccept: capability state-flip failed (non-fatal)', {
        capabilityId: capabilityIdToConsume,
        error: String((err as Error)?.message || err),
      });
    }
  }

  // Single-use: the invite now has its counterparty; record the outcome on
  // the trigger the requester's app watches. Open-link invites are not
  // written: one subject joining does not change the link, and concurrent
  // accepts would race on the record. Best-effort.
  if (capabilityAccess != null && capabilityMode !== 'open-link') {
    const stamp = await inviteState.stampInvite({
      userId,
      inviteEventId,
      transition: 'accepted',
      fields: {
        acceptedBy: { username: counterparty.username, host: counterparty.host },
        acceptedAt: Date.now() / 1000,
        backChannelAccessId: access.id,
      },
      deps: { mall, logger: deps.logger, notifyEventChanged: deps.notifyEventChanged },
    });
    if (!stamp.ok || stamp.skipped != null) {
      deps.logger?.debug?.('cmc/handleIncomingAccept: invite not stamped accepted', { inviteEventId, stamp });
    }
  }

  // Mirror the accept to :_cmc:inbox so the requester's app sees it via
  // standard inbox subscription (per INTERNALS.md flow 3 step 11). The
  // accept event itself lives in :_cmc:_internal:responses:<capId>; the
  // mirror is a copy on :_cmc:inbox that carries the same content
  // (grantedAccess.apiEndpoint + from + features). Best-effort — the
  // back-channel access is already created so the app can be notified
  // separately even if this mirror fails (e.g. inbox stream not yet
  // provisioned and lazy-provision didn't run on this code path).
  if (acceptEvent.streamIds?.includes(C.NS_INBOX) !== true && deps.mall.events != null) {
    try {
      // Augment the mirror's content with handles the doctor's app can
      // only discover via the requester side:
      //   - `backChannelAccessId` — the data-grant id we just minted
      //     locally. Power-user revoke path
      //     (`cmc.revokeRelationship({accessId, scopeStreamId})`)
      //     needs this.
      //   - `inviteEventId` — the original `consent/request-cmc`
      //     trigger event id, read from the capability access's
      //     `clientData.cmc.requestEventId`. Convenience revoke path
      //     (`cmc.revokeRelationship({inviteEventId})`) matches against
      //     this on the inbox event.
      const mirrorContent: Record<string, unknown> = {
        ...(acceptEvent.content || {}),
        // The resolved value, not the one the peer sent.
        features: negotiatedFeatures,
        backChannelAccessId: access.id,
      };
      // Only the id resolved from the capability access: one the accepter put
      // in the content could point the requester's app at another invite.
      if (inviteEventId != null) mirrorContent.inviteEventId = inviteEventId;
      else delete mirrorContent.inviteEventId;
      // A membership accept (this account asked to join a group): marked so a
      // member app matches it; from our own copy of the offer when there is
      // one, else from the delivered accept.
      const ownOfferRequest = (offerCopy.event?.content as { request?: { membership?: unknown } } | undefined)?.request;
      const isMembership = offerCopy.event != null
        ? ownOfferRequest?.membership === true
        : acceptEvent.content?.membership === true;
      if (isMembership) mirrorContent.membership = true;
      else delete mirrorContent.membership;
      await deps.mall.events.create(userId, {
        streamIds: [C.NS_INBOX],
        type: C.ET_ACCEPT,
        time: Date.now() / 1000,
        content: mirrorContent,
      });
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/handleIncomingAccept: inbox mirror failed (non-fatal)', {
        error: String((err as Error)?.message || err),
      });
    }
  }

  // Deliver back-channel info to the peer (accepter). The peer's
  // data-grant access carries `:_cmc:inbox` create-only specifically
  // for this — we POST a `consent/back-channel-cmc` event there containing
  // our back-channel apiEndpoint + remote stream-ids. The peer's
  // dispatch routes it to handleIncomingBackChannel, which updates the
  // data-grant access's clientData.cmc.counterparty so the peer's chat
  // / system handlers can find an apiEndpoint to POST to when sending
  // back to us. Best-effort — if delivery fails, the peer can't send
  // chat/system to us, but the data-grant for read access is intact and
  // the operator can retry.
  //
  // A delivery that fails retryably (the accepter's core down, a 5xx, a
  // timeout, a 408 / 429) is queued as a delivery record and re-sent by the
  // retry loop on the delivery schedule (retryQueue.ts): without it the
  // accepter's grant never learns where to reach this side, and an older
  // grant this accept replaces is never ended on the accepter's core. A 4xx
  // (the accepter's answer) or a refused destination is logged.
  let backChannelDelivery: 'delivered' | 'queued' | 'failed' | undefined;
  if (typeof deps.fetch === 'function' && access.apiEndpoint != null) {
    const outbound = require('./outbound.ts');
    const delivery = {
      apiEndpoint: grantedApiEndpoint,
      path: 'events',
      body: {
        streamIds: [C.NS_INBOX],
        type: C.ET_BACK_CHANNEL,
        content: {
          from: { username: selfIdentity.username, host: selfIdentity.host },
          apiEndpoint: access.apiEndpoint,
          // Left out for a relationship without chat: optional on receipt,
          // and the published event-type schema types it as a string, so
          // a null would be refused.
          ...(chatStream != null ? { remoteChatStreamId: chatStream } : {}),
          remoteCollectorStreamId: collectorStream,
          appCode,
          // Lets the accepter stamp the back-channel onto the grant for
          // THIS relationship rather than guessing from (peer, appCode).
          // Older accepters ignore it and fall back to deriving the scope
          // from remoteChatStreamId.
          scopeStreamId,
        },
      },
    };
    // Without the token: this is the peer's data-grant endpoint, a live
    // credential to their account, and a warn line goes to the operator's
    // log stream and on to whatever aggregates it. The host is what
    // identifies the failed delivery.
    const peerHost = outbound.stripCredentials(grantedApiEndpoint);
    let sent: { ok: boolean; reason?: string; status?: number; retryAfterMs?: number } | null = null;
    try {
      sent = await outbound.postToPeer({ ...delivery, deps: { fetch: deps.fetch, timeoutMs: deps.timeoutMs, logger: deps.logger } });
    } catch (err: unknown) {
      // Only the endpoint parser throws (postToPeer reports its failures): a
      // malformed endpoint cannot be retried.
      deps.logger?.warn?.('cmc/handleIncomingAccept: back-channel info delivery failed (non-fatal)', {
        peerApiEndpoint: peerHost,
        error: String((err as Error)?.message || err),
      });
      backChannelDelivery = 'failed';
    }
    if (sent?.ok === true) {
      backChannelDelivery = 'delivered';
    } else if (sent != null && outbound.isRetryableFailure(sent) && typeof mall.events?.create === 'function') {
      try {
        const retryQueue = require('./retryQueue.ts');
        await retryQueue.enqueueDelivery({
          userId,
          delivery,
          originalEventId: typeof acceptEvent.id === 'string' ? acceptEvent.id : null,
          originalType: C.ET_BACK_CHANNEL,
          failureReason: 'cmc-back-channel-delivery-failed',
          failureDetail: { peerReason: sent.reason, status: sent.status, ...(typeof sent.retryAfterMs === 'number' ? { retryAfterMs: sent.retryAfterMs } : {}) },
          deps: { mall, logger: deps.logger },
        });
        backChannelDelivery = 'queued';
      } catch (err: unknown) {
        deps.logger?.warn?.('cmc/handleIncomingAccept: back-channel info delivery failed and could not be queued', {
          peerApiEndpoint: peerHost, reason: sent.reason, status: sent.status, error: String((err as Error)?.message || err),
        });
        backChannelDelivery = 'failed';
      }
    } else if (sent != null) {
      deps.logger?.warn?.('cmc/handleIncomingAccept: back-channel info delivery failed and is not retried', {
        peerApiEndpoint: peerHost, reason: sent.reason, status: sent.status,
      });
      backChannelDelivery = 'failed';
    }
  }

  return {
    ok: true,
    backChannelAccessId: access.id,
    backChannelApiEndpoint: access.apiEndpoint,
    anchorStreamIds: created,
    // appCode is guaranteed non-null by the scope-resolution branches
    // above (the fallback sets it to 'unknown'), but TS narrowing
    // doesn't carry through the multiple if-chains. Coerce to string.
    appCode: appCode as string,
    counterparty,
    ...(rePaired ? { rePaired } : {}),
    ...(backChannelDelivery != null ? { backChannelDelivery } : {}),
  };
}

/**
 * Whether an accept may heal `existing`, the relationship access its declared
 * counterparty and scope resolved to. Only when it comes from the same
 * account: the granted apiEndpoint is the one recorded on the relationship
 * (scheme, host and path; the token may change). A relationship recorded
 * without an endpoint is healed only through the capability it was made with.
 */
function mayHealRelationship (existing: AccessLike, grantedApiEndpoint: string, capabilityId: string | null): boolean {
  const cmc = existing.clientData?.cmc as { counterparty?: { apiEndpoint?: unknown }; capabilityId?: unknown } | undefined;
  const recorded = cmc?.counterparty?.apiEndpoint;
  if (typeof recorded === 'string' && recorded.length > 0) {
    const a = endpointIdentity(recorded);
    return a != null && a === endpointIdentity(grantedApiEndpoint);
  }
  return capabilityId != null && cmc?.capabilityId === capabilityId;
}

/** `protocol//host/path` of an apiEndpoint, credentials and trailing slash dropped; null if not a URL. */
function endpointIdentity (apiEndpoint: string): string | null {
  const outbound = require('./outbound.ts');
  try {
    const u = new URL(outbound.stripCredentials(apiEndpoint));
    return u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, '');
  } catch (_e) {
    return null;
  }
}

/**
 * When this core received the accept: its `created`. A retry re-dispatches a
 * snapshot without it, so the stored event is read by id then. Null when
 * neither is available (no id, no stored event), `'unreadable'` when the read
 * failed.
 */
async function acceptCreatedAt (params: {
  userId: string;
  acceptEvent: { id?: string; created?: number };
  mall: MallLike;
}): Promise<number | null | 'unreadable'> {
  const { userId, acceptEvent, mall } = params;
  if (typeof acceptEvent.created === 'number' && Number.isFinite(acceptEvent.created)) return acceptEvent.created;
  if (typeof acceptEvent.id !== 'string' || acceptEvent.id.length === 0 || mall.events?.getOne == null) return null;
  try {
    const stored = await mall.events.getOne(userId, acceptEvent.id);
    const created = stored?.created;
    return typeof created === 'number' && Number.isFinite(created) ? created : null;
  } catch (_e) {
    return 'unreadable';
  }
}

/** The relationship's `peerAcceptReceivedAt`, or null. */
function receivedAtOf (access: AccessLike | null | undefined): number | null {
  const v = access?.clientData?.cmc?.peerAcceptReceivedAt;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** An accept received before the one `existing` is paired with. */
function isSupersededAccept (existing: AccessLike, acceptReceivedAt: number | null): boolean {
  const pairedAt = receivedAtOf(existing);
  return pairedAt != null && acceptReceivedAt != null && acceptReceivedAt < pairedAt;
}

function refuseSupersededAccept (existing: AccessLike, acceptEvent: { id?: string }, logger?: CmcLogger): IncomingAcceptResult {
  logger?.info?.('cmc/handleIncomingAccept: an accept older than the one the relationship is paired with was refused (a later accept replaced it)', {
    accessId: existing.id ?? null, acceptEventId: acceptEvent.id ?? null,
  });
  return { ok: false, reason: CmcErrorIds.INCOMING_ACCEPT_SUPERSEDED, detail: { backChannelAccessId: existing.id ?? null } };
}

function refuseForeignHeal (existing: AccessLike, logger?: CmcLogger): IncomingAcceptResult {
  logger?.warn?.('cmc/handleIncomingAccept: accept names a counterparty whose relationship belongs to another endpoint, refused', {
    accessId: existing.id ?? null,
  });
  return { ok: false, reason: 'cmc-incoming-accept-counterparty-endpoint-mismatch' };
}

/** The capability id of the first responses stream among `streamIds`, or null. */
function capabilityIdOfResponsesStream (streamIds: string[] | undefined): string | null {
  for (const sid of streamIds ?? []) {
    const capabilityId = C.capabilityIdFromResponsesStreamId(sid);
    if (capabilityId != null) return capabilityId;
  }
  return null;
}

type OfferCopyEvent = { type?: string; streamIds?: string[]; content?: Record<string, unknown> };
type OfferCopy = { event: OfferCopyEvent | null; via: 'responses-stream' | 'delivered-id' | null };

/**
 * This side's copy of the offer the accept answers. Looked up first by a
 * server-controlled key: an accept made through a capability sits in
 * `:_cmc:_internal:responses:<capId>` (the only stream the capability token
 * can write), and the offer copy is the request in `:_cmc:_internal:offer:<capId>`.
 * Then by the id the accept names (`originalEventId`, else `requestEventId`),
 * which the peer wrote. `event: null` when neither reaches a request: the
 * capability's streams were collected, or the delivery names nothing readable.
 */
async function findOfferCopy (params: {
  userId: string;
  acceptEvent: { content?: Record<string, unknown>; streamIds?: string[] };
  mall: MallLike;
}): Promise<OfferCopy> {
  const { userId, acceptEvent, mall } = params;
  for (const sid of acceptEvent.streamIds ?? []) {
    const capabilityId = C.capabilityIdFromResponsesStreamId(sid);
    if (capabilityId == null || mall.events?.get == null) continue;
    try {
      const events = await mall.events.get(userId, {
        streams: [{ any: [C.offerStreamIdFor(capabilityId)] }],
        limit: 5,
      }) as OfferCopyEvent[];
      const ev = events.find((e) => e?.type === C.ET_REQUEST);
      if (ev != null) return { event: ev, via: 'responses-stream' };
    } catch (_e) {
      // Streams collected: no copy (below).
    }
    // The capability names its offer: when that copy is gone, the id the
    // peer names (possibly another request of ours) is not consulted.
    return { event: null, via: null };
  }
  const reqId = acceptEvent.content?.originalEventId ?? acceptEvent.content?.requestEventId;
  if (typeof reqId === 'string' && reqId.length > 0 && mall.events?.getOne != null) {
    try {
      // getOne, not get({ id }): the events query does not filter on `id`, so
      // get() would hand back the newest event of any kind.
      const ev = await mall.events.getOne(userId, reqId) as OfferCopyEvent | null;
      if (ev != null && ev.type === C.ET_REQUEST) return { event: ev, via: 'delivered-id' };
    } catch (_e) {
      // Fall through.
    }
  }
  return { event: null, via: null };
}

/**
 * The features this side's own copy of the offer grants. Without a copy every
 * feature counts as offered, so the accepter's value alone decides: what this
 * side did before it resolved features itself. That is a trust decision on
 * the peer's word, so it is logged at warn.
 */
function offerFeatures (
  offerCopy: OfferCopy,
  acceptEvent: { id?: string; content?: Record<string, unknown> },
  logger?: CmcLogger
): Features {
  if (offerCopy.event != null) return featuresFromOffer(offerCopy.event.content);
  const reqId = acceptEvent.content?.originalEventId ?? acceptEvent.content?.requestEventId;
  logger?.warn?.('cmc/handleIncomingAccept: offer copy not found, features resolved from the accept alone', {
    acceptEventId: acceptEvent.id ?? null,
    originalEventId: typeof reqId === 'string' ? reqId : null,
  });
  return featuresFromOffer(null);
}

/**
 * Best-effort lookup of the original request event's scope. The offer copy
 * is found by the accept's responses stream, else by the `originalEventId`
 * it names; we return the streamId
 * + appCode it was written under. Returns nulls if we can't resolve
 * (caller falls back to a synthetic scope). `requestEvent`, when given
 * (null included), is the request already looked up by the caller.
 */
async function resolveRequestScope (params: {
  userId: string;
  acceptEvent: { id?: string; type?: string; content?: Record<string, unknown>; streamIds?: string[]; [k: string]: unknown };
  mall: MallLike;
  requestEvent?: OfferCopyEvent | null;
}): Promise<{ scopeStreamId: string | null; appCode: string | null }> {
  const { userId, acceptEvent, mall } = params;
  try {
    const ev = params.requestEvent !== undefined
      ? params.requestEvent
      : (await findOfferCopy({ userId, acceptEvent, mall })).event;
    if (ev == null || ev.type !== C.ET_REQUEST) return { scopeStreamId: null, appCode: null };
    // The requester's trigger sits on its app-scope stream.
    const reqStreamIds: string[] = Array.isArray(ev.streamIds) ? ev.streamIds : [];
    for (const sid of reqStreamIds) {
      const appCode = C.getAppCode(sid);
      if (appCode != null) {
        return { scopeStreamId: sid, appCode };
      }
    }
    // The capability offer only sits on `:_cmc:_internal:offer:<capId>`, but it
    // carries the requester's scope stamped at mint.
    const origin = ev.content?.originStreamId;
    if (typeof origin === 'string') {
      const appCode = C.getAppCode(origin);
      if (appCode != null) return { scopeStreamId: origin, appCode };
    }
  } catch (_e) {
    // Lookup failure → fall back.
  }
  return { scopeStreamId: null, appCode: null };
}

/**
 * Look up an access by its `name` field. Returns null if not found or if
 * the mall doesn't expose an accesses.get method.
 */
async function findAccessByName (params: {
  mall: MallLike;
  userId: string;
  name: string;
}): Promise<AccessLike | null> {
  const { mall, userId, name } = params;
  if (typeof mall.accesses.get !== 'function') return null;
  try {
    const list = await mall.accesses.get(userId, {});
    const arr = (Array.isArray(list) ? list : ((list as { accesses?: unknown[] })?.accesses ?? [])) as AccessLike[];
    for (const a of arr) {
      if (a?.name === name) return a;
    }
  } catch (_e) {
    return null;
  }
  return null;
}

export {
  handleIncomingAccept,
  resolveRequestScope,
  findAccessByName,
};
