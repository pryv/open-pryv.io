/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import * as C from './constants.ts';
import { takeCredentials } from './credentialScrub.ts';

/**
 * CMC plugin — events.create middleware that takes the access token OUT of a
 * lifecycle record before it is persisted, and hands it to the orchestration
 * on the side.
 *
 * Why before persist. The dispatch loop's status stamps already scrub, but
 * they rewrite a row that `events.create` has already stored, so between the
 * two the stored record holds a live credential. `notify` fires in that
 * window, telling the account's socket.io subscribers to fetch the row, and
 * an export taken in it sees the token too. Stripping here means the store
 * never holds the credential at all: there is no window to measure.
 *
 * What it covers, and why only these:
 *   - `consent/accept-cmc` / `consent/refuse-cmc` on the user's own
 *     `:_cmc:apps:<app-code>`: `content.capabilityUrl`, the invite URL with
 *     the requester's capability token.
 *   - `consent/back-channel-cmc` on `:_cmc:inbox`: `content.apiEndpoint`, the
 *     COUNTERPARTY's back-channel token, in a stream apps poll by design.
 *
 * `consent/request-cmc` is deliberately EXCLUDED: its `capabilityUrl` is the
 * invite the app hands out, `listInvites` reads it back, and the capability
 * mint hook stamps it here on purpose. `grantedAccess.apiEndpoint`, on a
 * peer-delivered accept, is likewise untouched — `waitForAccept()` reads it
 * off the stored event and apps open a connection with it. Neither is a key
 * `takeCredentials` knows about, so both pass through even if this hook sees
 * them.
 *
 * Ordering. Wired AFTER the validating hooks (content validation, the accept
 * gate, the inbox and capability-response guards) so they judge the record as
 * sent and a rejected write has nothing to strip; and BEFORE `createEvent`, so
 * the store computes integrity over the stripped content and the create
 * response returns the same row a later `events.getOne` will.
 *
 * The originals travel on `context.cmc.credentials`, which
 * `createDispatchMiddleware` puts back onto its own in-memory copy of the
 * event. The handler and the retry snapshot therefore still see usable values;
 * only what is written to storage loses them.
 */

// Only the two fields this hook reads or writes are modelled. Deliberately
// NOT an open bag: the context carries far more, but naming only what is
// touched here keeps the hook's contract with the chain explicit.
type StashEvent = { type?: string; content?: Record<string, unknown> | null };
type MwContext = {
  newEvent?: StashEvent;
  cmc?: Record<string, unknown>;
};
type MwNext = (err?: unknown) => void;
type Middleware = (context: MwContext, params: unknown, result: unknown, next: MwNext) => unknown;

/** The record types a client or a peer can write carrying a credential. */
const STASHED_TYPES: Set<string> = new Set([
  C.ET_ACCEPT,
  C.ET_REFUSE,
  C.ET_BACK_CHANNEL,
]);

function createCredentialStashHook (): Middleware {
  return function cmcCredentialStashHook (context, _params, _result, next) {
    const event = context?.newEvent;
    if (event == null || typeof event.type !== 'string') return next();
    if (!STASHED_TYPES.has(event.type)) return next();

    const taken = takeCredentials(event.content);
    if (taken == null) return next();

    event.content = taken.content;
    context.newEvent = event;
    context.cmc = context.cmc || {};
    context.cmc.credentials = taken.stash;
    next();
  };
}

export {
  createCredentialStashHook,
};
