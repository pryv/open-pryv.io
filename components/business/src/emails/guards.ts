/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Multiple emails, write guards on the reserved container stream.
 *
 * The items are ordinary events, so the ordinary events API can reach them.
 * That must not be a way around the lifecycle: hand-writing an item, or
 * rewriting one's content, would let any holder (personal tokens included)
 * forge `status: 'verified'` and claim an address they never proved they own.
 * So: no create, no update, no move into the namespace, no delete through the
 * events API. Every sanctioned mutation goes through the account methods, which
 * write to the mall directly and never reach this chain.
 */

import * as C from './constants.ts';

type ErrorsFactory = {
  forbidden (msg?: string): Error & { data?: Record<string, unknown> };
  invalidOperation (msg?: string): Error & { data?: Record<string, unknown> };
};
type EventLike = { id?: string; streamIds?: string[]; type?: string; content?: unknown };

function withId (err: Error & { data?: Record<string, unknown> }, id: string) {
  err.data = Object.assign({}, err.data, { id });
  return err;
}

/** True when the event belongs to the reserved container. */
function touchesNamespace (event: EventLike | null | undefined): boolean {
  return (event?.streamIds ?? []).some((id) => C.isEmailStreamId(id));
}

/** Refuse hand-made events in the container. */
function createEventCreateGuard (deps: { errors: ErrorsFactory }) {
  return function emailsEventCreateGuard (
    context: unknown,
    params: { streamIds?: unknown; streamId?: unknown },
    result: unknown,
    next: (err?: unknown) => void
  ) {
    const streamIds: unknown[] = Array.isArray(params?.streamIds)
      ? params.streamIds
      : (params?.streamId != null ? [params.streamId] : []);
    if (streamIds.some((id) => C.isEmailStreamId(id))) {
      return next(withId(
        deps.errors.forbidden('Emails can only be managed through the account methods.'),
        'emails-reserved-stream'));
    }
    next();
  };
}

/**
 * Refuse events.update on the container, and refuse moving an ordinary event
 * INTO it (which would mint a container item that never passed the account
 * methods, so its `status` was never earned).
 */
function createEventUpdateGuard (deps: { errors: ErrorsFactory }) {
  return function emailsEventUpdateGuard (
    context: { oldEvent?: EventLike; event?: EventLike; newEvent?: EventLike },
    params: unknown,
    result: unknown,
    next: (err?: unknown) => void
  ) {
    const target = context.oldEvent ?? context.event;
    if (touchesNamespace(target) || touchesNamespace(context.newEvent)) {
      return next(withId(
        deps.errors.forbidden('Emails can only be managed through the account methods.'),
        'emails-reserved-stream'));
    }
    next();
  };
}

/** Refuse deletion of a container item, personal tokens included. */
function createEventDeleteGuard (deps: { errors: ErrorsFactory }) {
  return function emailsEventDeleteGuard (
    context: { oldEvent?: EventLike },
    params: unknown,
    result: unknown,
    next: (err?: unknown) => void
  ) {
    if (touchesNamespace(context.oldEvent)) {
      return next(withId(
        deps.errors.forbidden('Emails can only be managed through the account methods.'),
        'emails-reserved-stream'));
    }
    next();
  };
}

/**
 * The container is an ordinary local-store stream, so the streams API can also
 * reach it. Deleting it would drop every email event WITHOUT releasing the
 * PlatformDB uniqueness rows (leaking those addresses platform-wide and breaking
 * container/row lockstep); re-parenting or renaming it would break resolution.
 * So the streams API cannot create under, edit, move, or delete the namespace —
 * the same posture the shared-secrets namespace takes.
 */
function createStreamCreateGuard (deps: { errors: ErrorsFactory }) {
  return function emailsStreamCreateGuard (
    context: unknown,
    params: { id?: unknown; parentId?: unknown },
    result: unknown,
    next: (err?: unknown) => void
  ) {
    if (C.isEmailStreamId(params?.id) || C.isEmailStreamId(params?.parentId)) {
      return next(withId(
        deps.errors.invalidOperation('The emails namespace is managed by the server.'),
        'emails-reserved-stream'));
    }
    next();
  };
}

function createStreamUpdateGuard (deps: { errors: ErrorsFactory }) {
  return function emailsStreamUpdateGuard (
    context: unknown,
    params: { id?: unknown; update?: { parentId?: unknown } },
    result: unknown,
    next: (err?: unknown) => void
  ) {
    if (C.isEmailStreamId(params?.id) || C.isEmailStreamId(params?.update?.parentId)) {
      return next(withId(
        deps.errors.invalidOperation('The emails namespace is managed by the server.'),
        'emails-reserved-stream'));
    }
    next();
  };
}

function createStreamDeleteGuard (deps: { errors: ErrorsFactory }) {
  return function emailsStreamDeleteGuard (
    context: unknown,
    params: { id?: unknown },
    result: unknown,
    next: (err?: unknown) => void
  ) {
    if (C.isEmailStreamId(params?.id)) {
      return next(withId(
        deps.errors.invalidOperation('The emails namespace is managed by the server.'),
        'emails-reserved-stream'));
    }
    next();
  };
}

export {
  touchesNamespace,
  createEventCreateGuard,
  createEventUpdateGuard,
  createEventDeleteGuard,
  createStreamCreateGuard,
  createStreamUpdateGuard,
  createStreamDeleteGuard
};
