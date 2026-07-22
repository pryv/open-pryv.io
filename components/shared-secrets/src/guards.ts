/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared secrets — write guards on the reserved namespace.
 *
 * The items are ordinary events, which means the ordinary events API can reach
 * them. That must not be a way around the lifecycle: rewriting an item's content
 * would let a holder swap the payload or resurrect a spent secret, and deleting
 * one outright would erase the record of a hand-off that did happen.
 *
 * So: no updates at all, and a delete is re-read as "discard" — the item stays
 * as history with its secret scrubbed, exactly like any other terminal
 * transition. Once terminal, it is immutable.
 */

import * as C from './constants.ts';
import { applyTransition, isPending } from './item.ts';
import type { ItemContent } from './item.ts';

type ErrorsFactory = {
  forbidden (msg?: string): Error & { data?: Record<string, unknown> };
  invalidOperation (msg?: string, data?: unknown): Error & { data?: Record<string, unknown> };
};
type EventLike = { id?: string; streamIds?: string[]; type?: string; content?: unknown };

function withId (err: Error & { data?: Record<string, unknown> }, id: string) {
  err.data = Object.assign({}, err.data, { id });
  return err;
}

function touchesNamespace (event: EventLike | null | undefined): boolean {
  return (event?.streamIds ?? []).some((id) => C.isSharedSecretStreamId(id));
}

/**
 * Refuse events.update on the namespace.
 *
 * Reads the event the update chain already loaded, so this costs no extra query.
 */
function createEventUpdateGuard (deps: { errors: ErrorsFactory }) {
  return function sharedSecretsUpdateGuard (
    context: { oldEvent?: EventLike; event?: EventLike; newEvent?: EventLike },
    params: unknown,
    result: unknown,
    next: (err?: unknown) => void
  ) {
    const target = context.oldEvent ?? context.event;
    if (touchesNamespace(target)) {
      return next(withId(
        deps.errors.forbidden('A shared secret cannot be modified.'),
        'shared-secret-immutable'));
    }
    // The RESULT of the update matters as much as its subject: moving an
    // ordinary event into the namespace, or stamping it with the reserved type,
    // would mint a redeemable secret that never passed creation validation —
    // no TTL ceiling, no size cap, and no returnUrl scheme check, which is the
    // one that hands a javascript: URL to an unauthenticated third party.
    const after = context.newEvent;
    if (touchesNamespace(after) || after?.type === C.EVENT_TYPE) {
      return next(withId(
        deps.errors.forbidden('An event cannot be turned into a shared secret.'),
        'shared-secret-reserved-type'));
    }
    next();
  };
}

/**
 * Delete of a namespace item:
 *  - pending → discard. Rewrites the in-flight event so the delete chain's own
 *    trashing step persists the discarded, scrubbed content (one write, integrity
 *    and notifications intact). The trashing update is a compare-and-set on
 *    "still untrashed" (see flagAsTrashed), so a delete racing a concurrent
 *    retrieve cannot overwrite a consume with a discard.
 *  - terminal → let the normal delete proceed. A consumed/discarded item is
 *    already trashed and its secret is gone, so the standard second-delete
 *    hard-removes the record: the owner's (or a personal token's) Art.17 purge
 *    path. Permission is enforced upstream — a foreign access never reaches here.
 *
 * The status is NEVER rewritten backwards: a terminal item is deleted outright,
 * not turned back into `discarded`.
 */
function createEventDeleteGuard (deps: { errors: ErrorsFactory; now: () => number }) {
  return function sharedSecretsDeleteGuard (
    context: { oldEvent?: EventLike },
    params: unknown,
    result: unknown,
    next: (err?: unknown) => void
  ) {
    const target = context.oldEvent;
    if (!touchesNamespace(target)) return next();

    const content = target!.content as ItemContent;
    if (!isPending(content)) return next(); // terminal → hard delete, no rewrite

    target!.content = applyTransition(content, {
      status: C.STATUS_DISCARDED,
      info: C.INFO_DELETED,
      now: deps.now()
    });
    next();
  };
}

/**
 * Refuse hand-made events in the namespace, and shared-secret items outside it.
 *
 * Both halves matter. Writing INTO the namespace by hand would plant an item the
 * lifecycle guards never sanctioned; writing the item TYPE outside it would
 * forge a redeemable secret in an ordinary stream — which sidesteps the
 * `secretSharing` opt-out entirely and, living outside the guards, could be
 * updated back to pending and redeemed again and again. The plugin's own writes
 * go through the mall directly and never reach this chain.
 */
function createEventCreateGuard (deps: { errors: ErrorsFactory }) {
  return function sharedSecretsEventCreateGuard (
    context: unknown,
    params: { streamIds?: unknown; streamId?: unknown; type?: unknown },
    result: unknown,
    next: (err?: unknown) => void
  ) {
    const streamIds: unknown[] = Array.isArray(params?.streamIds)
      ? params.streamIds
      : (params?.streamId != null ? [params.streamId] : []);
    const inNamespace = streamIds.some((id) => C.isSharedSecretStreamId(id));

    if (inNamespace) {
      return next(withId(
        deps.errors.forbidden('Shared secrets can only be created through their own endpoint.'),
        'shared-secret-reserved-stream'));
    }
    if (params?.type === C.EVENT_TYPE) {
      return next(withId(
        deps.errors.forbidden('The shared-secret event type is reserved.'),
        'shared-secret-reserved-type'));
    }
    next();
  };
}

/** Refuse hand-made stream creation anywhere in the namespace. */
function createStreamCreateGuard (deps: { errors: ErrorsFactory }) {
  return function sharedSecretsStreamCreateGuard (
    context: unknown,
    params: { id?: unknown; parentId?: unknown },
    result: unknown,
    next: (err?: unknown) => void
  ) {
    if (C.isSharedSecretStreamId(params?.id) || C.isSharedSecretStreamId(params?.parentId)) {
      return next(withId(
        deps.errors.invalidOperation('The shared-secrets namespace is managed by the server.'),
        'shared-secret-reserved-stream'));
    }
    next();
  };
}

/**
 * Refuse renaming or re-parenting the namespace's streams.
 *
 * Without this, an access holding a broad `manage` grant could move a victim's
 * substream OUT of the namespace — after which none of the namespace rules
 * apply to it any more, and its pending secrets read like ordinary events. The
 * root is protected for the same reason, personal tokens included: reparenting
 * it would expose every access's secrets at once.
 */
function createStreamUpdateGuard (deps: { errors: ErrorsFactory }) {
  return function sharedSecretsStreamUpdateGuard (
    context: unknown,
    params: { id?: unknown; update?: { parentId?: unknown } },
    result: unknown,
    next: (err?: unknown) => void
  ) {
    if (C.isSharedSecretStreamId(params?.id) ||
        C.isSharedSecretStreamId(params?.update?.parentId)) {
      return next(withId(
        deps.errors.invalidOperation('The shared-secrets namespace is managed by the server.'),
        'shared-secret-reserved-stream'));
    }
    next();
  };
}

/** Refuse deletion of the namespace's streams, including by a personal token. */
function createStreamDeleteGuard (deps: { errors: ErrorsFactory }) {
  return function sharedSecretsStreamDeleteGuard (
    context: unknown,
    params: { id?: unknown },
    result: unknown,
    next: (err?: unknown) => void
  ) {
    if (C.isSharedSecretStreamId(params?.id)) {
      return next(withId(
        deps.errors.invalidOperation('The shared-secrets namespace is managed by the server.'),
        'shared-secret-reserved-stream'));
    }
    next();
  };
}

type StreamNode = { id?: string; children?: StreamNode[] };
type AccessLike = { id: string; isPersonal (): boolean };

/**
 * Drop shared-secret substreams the access does not own, at any depth.
 *
 * The streams listing filters by a static excluded-ids list built from stored
 * permissions, which cannot express "your own substream only" — so without this
 * an app could enumerate the namespace root and learn which other accesses have
 * secrets outstanding. Personal tokens see everything, as everywhere else.
 */
function filterVisibleStreams<T extends StreamNode> (streams: T[], access: AccessLike): T[] {
  if (access == null || access.isPersonal()) return streams;
  const ownStream = C.streamIdForAccess(access.id);
  return streams
    .filter((s) => !C.isSharedSecretStreamId(s.id) || s.id === ownStream || s.id === C.NS)
    .map((s) => (Array.isArray(s.children)
      ? Object.assign({}, s, { children: filterVisibleStreams(s.children, access) })
      : s));
}

export {
  filterVisibleStreams,
  createEventCreateGuard,
  createEventUpdateGuard,
  createEventDeleteGuard,
  createStreamCreateGuard,
  createStreamUpdateGuard,
  createStreamDeleteGuard,
  touchesNamespace
};
