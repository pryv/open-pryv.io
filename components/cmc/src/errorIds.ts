/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin — typed error-id catalogue.
 *
 * Stable, kebab-case `error.id` strings the plugin emits via the
 * trigger event's `content.failure.reason` and (where applicable)
 * via Pryv API error responses. Clients can pattern-match on these
 * strings to drive per-outcome UX without parsing English
 * `error.message`.
 *
 * Naming convention: `cmc-<subject>-<state>`. The set below is the
 * authoritative catalogue — every new error.id the plugin introduces
 * should land here first and be referenced everywhere else via
 * `CmcErrorIds.<NAME>`.
 *
 * Mirror in `pryv` (lib-js) under `pryv.cmc.errorIds` so client code
 * can import the same constants.
 */

const CmcErrorIds = {
  // --- Capability lifecycle ---
  // The capability URL/access could not be authenticated. Covers
  // "token never existed" + "token expired (past TTL)" — both look
  // identical at the auth middleware (401) and the plugin can't
  // distinguish them without tombstones (out of scope; see
  // HANDOVER-RESPONSE.md).
  CAPABILITY_INVALID: 'cmc-capability-invalid',
  // The capability was already accepted/refused (single-use mode only —
  // open-link mode does not transition to 'consumed' on accept; see
  // `_plans/XX-cmc-capability-open-link-later/PLAN.md`). Distinct from
  // INVALID: the access still exists, the write-hook detected
  // `clientData.cmc.capability.state === 'consumed'` and rejected the
  // re-click. Lets the patient app show "you already accepted this
  // invite" instead of the generic "invite no longer valid".
  CAPABILITY_CONSUMED: 'cmc-capability-consumed',
  // The capability (the LINK / join mechanism) was explicitly
  // invalidated by the requester. Open-link mode use case: "stop
  // accepting NEW patients via this link." Already-established
  // relationships (data-grant + back-channel pairs minted before
  // invalidation) are UNTOUCHED — they continue to work for chat /
  // system / revoke. Per-relationship revocation uses the existing
  // `consent/revoke-cmc` event, NOT this error.
  // State will be added by the open-link Phase 2 plan; the error.id
  // is enumerated here so the catalogue is stable.
  CAPABILITY_INVALIDATED: 'cmc-capability-invalidated',
  // Open-link mode same-patient re-click. A counterparty whose
  // `{username, host}` is already in the capability access's
  // `clientData.cmc.capability.acceptedBy` list tried to accept again
  // through the same capability URL. The response-stream write-hook
  // rejects with this id so the patient app can show "you already
  // accepted this invite" instead of silently re-running the handler
  // (which would mint a duplicate back-channel).
  CAPABILITY_ALREADY_ACCEPTED_BY_YOU: 'cmc-capability-already-accepted-by-you',
  // Capability fetch timed out (network / peer down).
  CAPABILITY_TIMEOUT: 'cmc-capability-timeout',
  // Capability resolved but the offer stream was empty — should not happen
  // in normal flow (the plugin pre-populates the offer at mint), so
  // surface a distinct id for ops.
  CAPABILITY_EMPTY: 'cmc-capability-empty',
  // Capability resolved but the offer stream held more than one event —
  // protocol invariant violation; ops investigation needed.
  CAPABILITY_MULTIPLE_OFFERS: 'cmc-capability-multiple-offers',

  // --- Trigger-event content shape ---
  // The accept-cmc trigger event's content omitted `capabilityUrl`.
  HANDLER_MISSING_CAPABILITY_URL: 'cmc-handler-missing-capability-url',
  // The trigger event's content omitted `capabilityId` (used by the
  // open-link `consent/invalidate-link-cmc` handler).
  HANDLER_MISSING_CAPABILITY_ID: 'cmc-handler-missing-capability-id',
  // The offer event is missing the server-stamped `capabilityId`.
  HANDLER_OFFER_MISSING_CAPABILITY_ID: 'cmc-handler-offer-missing-capability-id',
  // The offer carries no `request.permissions` array (or it's empty).
  OFFER_EMPTY_PERMISSIONS: 'cmc-offer-empty-permissions',

  // --- Handler routing ---
  // Dispatch invoked a handler with a trigger whose `.type` doesn't match.
  HANDLER_WRONG_TYPE: 'cmc-handler-wrong-type',
  // Handler threw an unexpected error not classified above.
  HANDLER_THREW: 'cmc-handler-threw',
  // readOfferViaCapability threw without a more specific id.
  HANDLER_OFFER_READ_FAILED: 'cmc-handler-offer-read-failed',

  // --- Counterparty resolution ---
  // The offer event doesn't carry enough information to derive the
  // counterparty's `{username, host}`. Should not happen with the bug #18
  // stamp in place.
  HANDLER_COUNTERPARTY_UNKNOWN: 'cmc-handler-counterparty-unknown',

  // --- Access mint (data-grant + back-channel) ---
  // mall.accesses.create rejected the payload.
  HANDLER_DATA_GRANT_CREATE_FAILED: 'cmc-handler-data-grant-create-failed',
  // The created access did not return an `apiEndpoint` — wiring bug
  // (mallAccessesAdapter is supposed to stamp it; surface for ops).
  HANDLER_DATA_GRANT_NO_APIENDPOINT: 'cmc-handler-data-grant-no-apiendpoint',
  // Build of the data-grant payload threw before the access call.
  HANDLER_BUILD_DATA_GRANT_FAILED: 'cmc-handler-build-data-grant-failed',
  // Back-channel access mint failed (`handleIncomingAccept` couldn't
  // create the access; rare, usually a uniqueness collision the duplicate
  // handler should catch — see HANDOVER BLOCK-2 / Plan-68 bugs #12-#13).
  BACK_CHANNEL_CREATE_FAILED: 'cmc-back-channel-create-failed',

  // --- Outbound delivery (peer POST) ---
  // outbound fetch to the peer threw an exception (network, DNS).
  HANDLER_DELIVERY_THREW: 'cmc-handler-delivery-threw',
  // Peer returned a non-retryable 4xx (excluding 401 on the capability,
  // which becomes CAPABILITY_UNKNOWN).
  HANDLER_DELIVERY_REJECTED: 'cmc-handler-delivery-rejected',
  // Peer returned 5xx, a timeout, or a network error — retryable.
  HANDLER_DELIVERY_FAILED: 'cmc-handler-delivery-failed',

  // --- Chat / system / revoke routing (per-handler) ---
  // The trigger stream-id is shaped right for the family (chats/
  // collectors) but doesn't parse as a chat/collector under
  // :_cmc:apps:<app>.
  CHAT_STREAM_NOT_CHAT: 'cmc-chat-stream-not-chat',
  // No counterparty-role access matched the parsed slug.
  CHAT_COUNTERPARTY_ACCESS_NOT_FOUND: 'cmc-chat-counterparty-access-not-found',
  // Counterparty access lacks `apiEndpoint` on `clientData.cmc.counterparty`.
  // Typically the two-phase access materialization hasn't finished —
  // see IMPLEMENTERS-GUIDE Step 4 "Two-phase access materialization".
  CHAT_NO_REMOTE_APIENDPOINT: 'cmc-chat-no-remote-apiendpoint',
  // Same as above for the chat stream-id.
  CHAT_NO_REMOTE_CHAT_STREAM: 'cmc-chat-no-remote-chat-stream',
} as const;

type CmcErrorId = (typeof CmcErrorIds)[keyof typeof CmcErrorIds];

export { CmcErrorIds };
export type { CmcErrorId };
