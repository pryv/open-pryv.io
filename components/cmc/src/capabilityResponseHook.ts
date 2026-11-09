/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';

import type { CmcLogger, MallAccessesLike } from './_types.ts';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — events.create middleware that gates writes to a
 * per-capability responses stream (`:_cmc:_internal:responses:<capId>`)
 * by the capability access's lifecycle state.
 *
 * Background:
 *   When bob's plugin POSTs `consent/accept-cmc` to alice via the
 *   capability URL, the event lands on alice's responses stream. Before
 *   this hook, today's flow let the events.create succeed and then ran
 *   `handleIncomingAccept` via the dispatch middleware; a re-click on
 *   the same capabilityUrl would silently re-mint a back-channel
 *   (covered by the bug #12 duplicate-name fix, but with no signal
 *   back to the client).
 *
 *   This hook intercepts at events.create time and rejects with a
 *   typed error.id when the capability access's state isn't 'open' —
 *   the patient app sees `cmc-capability-consumed` or
 *   `cmc-capability-invalidated` instead of a generic success that
 *   it has to disambiguate from the trigger event's status updates.
 *
 *   Open-link mode (`clientData.cmc.capability.mode === 'open-link'`)
 *   does NOT transition to 'consumed' on accept — see capability.ts
 *   doc — so this hook only blocks re-clicks on capabilities whose
 *   state is `'consumed'` or `'invalidated'`.
 */

const C = require('./constants.ts');
const capabilityMod = require('./capability.ts');

type ErrorFactory = {
  invalidOperation: (message: string, details?: Record<string, unknown>) => Error;
};

type CapabilityCd = {
  state?: string;
  mode?: string;
  stateChangedAt?: number;
  [k: string]: unknown;
};
type NewEventLike = {
  streamIds?: string[];
  type?: string;
  content?: { from?: { username?: string; host?: string } };
};
type MwContext = {
  newEvent?: NewEventLike;
  user?: { id?: string };
  access?: { clientData?: { cmc?: { capabilityId?: string | null; capability?: CapabilityCd; [k: string]: unknown }; [k: string]: unknown }; [k: string]: unknown };
  [k: string]: unknown;
};
type MwNext = (err?: unknown) => void;
type Middleware = (context: MwContext, params: unknown, result: unknown, next: MwNext) => unknown | Promise<unknown>;

const { CmcErrorIds } = require('./errorIds.ts');

/**
 * `mall` is optional: without it the open-link re-click check is skipped (unit
 * constructions that only exercise the state gate).
 *
 * `claimAccept` takes the single-use link for the accept being written, in
 * the name of its accepter (`content.from`): create-if-absent on a key of the
 * account and the capability, shared by the API workers of the core, held a
 * short while. The link only turns `consumed` once `handleIncomingAccept` has
 * handled that accept, so without the claim two accepts arriving together both
 * read `open` and both open a relationship. While the claim is held, an accept
 * of another accepter is refused as consumed; the holder's own accept passes
 * again (a re-delivery, which heals its relationship in place). If the accept
 * fails before the consume, the link takes other accepters once the claim
 * expires. A store that cannot answer lets the accept through (the state
 * check above still applies). Without `claimAccept` the check is skipped.
 */
function createCapabilityResponseHook (deps: {
  errors: ErrorFactory;
  mall?: { accesses: MallAccessesLike };
  logger?: CmcLogger;
  claimAccept?: (userId: string, capabilityId: string, accepter: string) => Promise<boolean>;
}): Middleware {
  return async function cmcCapabilityResponseHook (context, _params, _result, next) {
    const event = context?.newEvent;
    if (event == null) return next();
    const streamIds: string[] = Array.isArray(event.streamIds) ? event.streamIds : [];
    const isResponseStream = streamIds.some((id: string) =>
      typeof id === 'string' && id.startsWith(C.NS_INTERNAL + ':responses:')
    );
    if (!isResponseStream) return next();

    // The actor's access is the capability access. Its clientData.cmc
    // carries the lifecycle state. Reject when not 'open'.
    const capabilityCd = context?.access?.clientData?.cmc?.capability;
    if (capabilityCd == null) {
      // No capability marker on the access — either this isn't a CMC
      // capability access or it was minted before the lifecycle field
      // existed. Legacy back-compat: pass through (the legacy
      // single-use-without-state-flip behaviour).
      return next();
    }
    const state = capabilityCd.state;
    if (state === 'consumed') {
      return next(deps.errors.invalidOperation(
        'Capability already accepted; the link is single-use and has been consumed',
        { id: CmcErrorIds.CAPABILITY_CONSUMED, stateChangedAt: capabilityCd.stateChangedAt }
      ));
    }
    if (state === 'invalidated') {
      return next(deps.errors.invalidOperation(
        'Capability has been invalidated by the requester; no new accepts allowed',
        { id: CmcErrorIds.CAPABILITY_INVALIDATED, stateChangedAt: capabilityCd.stateChangedAt }
      ));
    }
    // Open-link mode same-patient re-click detection: when the access
    // is still 'open' and the incoming `content.from.{username, host}`
    // still holds a live relationship through this capability, reject
    // with `cmc-capability-already-accepted-by-you`. Lets the patient
    // app distinguish "I already clicked this" from "this is a fresh
    // invite still claimable by someone else." A subject whose
    // relationship was revoked can join again. `acceptedBy` arrays left on
    // older capability accesses are not consulted.
    const capabilityId = context?.access?.clientData?.cmc?.capabilityId;
    const userId = context?.user?.id;
    if (state === 'open' && capabilityCd.mode === 'open-link' && deps.mall != null &&
        typeof capabilityId === 'string' && typeof userId === 'string') {
      let live = null;
      try {
        live = await capabilityMod.findLiveRelationshipForCapability({
          userId, capabilityId, counterparty: event?.content?.from, deps: { mall: deps.mall },
        });
      } catch (err: unknown) {
        // Fail open: a lookup error must not lock subjects out of the link. A
        // same-subject re-accept that slips through heals the existing
        // relationship in place.
        deps.logger?.warn?.('cmc/capabilityResponseHook: relationship lookup failed', {
          capabilityId, error: String((err as Error)?.message || err),
        });
      }
      if (live != null) {
        return next(deps.errors.invalidOperation(
          'You have already accepted this open-link consent',
          { id: CmcErrorIds.CAPABILITY_ALREADY_ACCEPTED_BY_YOU, acceptedAt: live.created }
        ));
      }
    }
    // Single-use (the default for a link minted before modes): one accept takes
    // the link. A refusal does not consume it, so it takes no claim.
    if (state === 'open' && capabilityCd.mode !== 'open-link' && event.type === C.ET_ACCEPT &&
        deps.claimAccept != null && typeof capabilityId === 'string' && typeof userId === 'string') {
      const from = event.content?.from;
      // An accept naming no accepter claims the link for nobody: any other
      // accept is refused while it holds it, and so is a second one of these.
      const accepter = typeof from?.username === 'string' && typeof from?.host === 'string'
        ? from.username.toLowerCase() + '|' + from.host.toLowerCase()
        : '';
      let claimed = true;
      try {
        claimed = await deps.claimAccept(userId, capabilityId, accepter);
      } catch (err: unknown) {
        deps.logger?.warn?.('cmc/capabilityResponseHook: accept claim failed, accept let through', {
          capabilityId, error: String((err as Error)?.message || err),
        });
      }
      if (!claimed) {
        return next(deps.errors.invalidOperation(
          'Capability already accepted; the link is single-use and another accept took it',
          { id: CmcErrorIds.CAPABILITY_CONSUMED }
        ));
      }
    }
    // 'open' (or any unknown future state): proceed.
    next();
  };
}

export { createCapabilityResponseHook };
