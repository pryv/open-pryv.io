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
type EventLike = { id?: string; streamIds?: string[]; content?: unknown };

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
    context: { oldEvent?: EventLike; event?: EventLike },
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
    next();
  };
}

/**
 * Turn a delete of a pending item into a discard, and refuse it once terminal.
 *
 * Rather than writing here, it rewrites the in-flight event so the delete
 * chain's own trashing step persists the discarded, scrubbed content — one
 * write, and the surrounding machinery (integrity, tracking properties,
 * notifications) keeps working untouched.
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
    if (!isPending(content)) {
      // Consumed is a fact about the past; a delete must not rewrite it.
      return next(withId(
        deps.errors.forbidden('A shared secret that is no longer pending cannot be deleted.'),
        'shared-secret-immutable'));
    }
    target!.content = applyTransition(content, {
      status: C.STATUS_DISCARDED,
      info: C.INFO_DELETED,
      now: deps.now()
    });
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
  createEventUpdateGuard,
  createEventDeleteGuard,
  createStreamCreateGuard,
  createStreamDeleteGuard,
  touchesNamespace
};
