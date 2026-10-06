/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import * as C from './constants.ts';

/**
 * CMC plugin: the server-owned fields of a consent accept event.
 *
 * Three content fields of `consent/accept-cmc` form the subject-side record of
 * a consent, and only the server writes them (`ACCEPT_SERVER_OWNED_FIELDS`):
 *   - `approvedBy = { delegate: { username, hostSlug? }, relId }`: who gave the
 *     consent and through which account delegation, when it was not the
 *     account owner. Stamped here, on create. (`content.acceptedBy` is taken:
 *     the dispatch stamps it with the accepter's data-grant endpoint.)
 *   - `ownerConfirmedAt` and `withdrawal`: the owner's decision on a consent a
 *     delegate gave, written by the delegation plugin when the delegate is
 *     removed (kept, or ended). Never written here.
 *
 * The rule, for any token:
 *   - events.create (`createAcceptStampingHook`): the three fields are removed
 *     from the client's content; when the writing access is
 *     delegation-derived, `approvedBy` is set from that access's own marker
 *     (read by the injected `lineageOf`, the delegation plugin's reader, so
 *     this plugin does not import it). The content validator lets extra keys
 *     through, so without the removal a client could write them itself.
 *   - events.update (`createAcceptPreserveHook`, `preserveServerOwnedContent`):
 *     the stored values are kept, client-supplied ones are dropped, the rest
 *     of the content is as sent. A content update replaces the content whole,
 *     so the stored values are put back explicitly, and again at write time
 *     on the row as stored then, so a stamp written meanwhile is kept. The
 *     dispatch status fields (`CMC_SERVER_OWNED_FIELDS`: `status`, `failure`)
 *     get the same treatment on every CMC event type.
 * Server writers (the dispatch status stamps, the incoming accept, the
 * delegation detach) go through the mall and never reach these hooks.
 *
 * The record is history; what the delegation controls is the data grant,
 * which carries the same lineage on its own forge-protected
 * `clientData.delegation` (see handleAccept.ts).
 */

/** The marker shape `lineageOf` returns (only the fields read here). */
type Lineage = { relId?: unknown; delegate?: unknown } | null;
type LineageOf = (access: unknown) => Lineage;

type EventLike = { type?: string; content?: unknown };
type MwContext = {
  newEvent?: EventLike;
  oldEvent?: EventLike;
  access?: unknown;
};
type MwNext = (err?: unknown) => void;
type Middleware = (context: MwContext, params: unknown, result: unknown, next: MwNext) => unknown;

type ApprovedBy = { delegate: { username: string; hostSlug?: string }; relId: string };

function isPlainObject (value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The `approvedBy` record for an accept written with `access`, or null when
 * `access` is not delegation-derived. Only the identity fields are copied:
 * nothing from the marker beyond the delegate's username / host slug and the
 * relationship id.
 */
function approvedByFor (lineageOf: LineageOf, access: unknown): ApprovedBy | null {
  const lineage = lineageOf(access);
  if (lineage == null) return null;
  const delegate = isPlainObject(lineage.delegate) ? lineage.delegate : {};
  // A malformed marker stamps nothing: handleAccept's lineage check is the one
  // place that refuses it.
  if (typeof delegate.username !== 'string' || delegate.username === '' ||
      typeof lineage.relId !== 'string' || lineage.relId === '') return null;
  const record: ApprovedBy = {
    delegate: { username: delegate.username },
    relId: lineage.relId,
  };
  if (typeof delegate.hostSlug === 'string' && delegate.hostSlug.length > 0) {
    record.delegate.hostSlug = delegate.hostSlug;
  }
  return record;
}

/**
 * events.create hook. Wired after the CMC accept gate (so a refused write is
 * never stamped) and before the event is stored.
 */
function createAcceptStampingHook (deps: { lineageOf: LineageOf }): Middleware {
  return function cmcAcceptStampingHook (context, _params, _result, next) {
    const event = context?.newEvent;
    if (event?.type !== C.ET_ACCEPT || !isPlainObject(event.content)) return next();
    for (const field of C.ACCEPT_SERVER_OWNED_FIELDS) delete event.content[field];
    const approvedBy = approvedByFor(deps.lineageOf, context.access);
    if (approvedBy != null) event.content.approvedBy = approvedBy;
    next();
  };
}

/**
 * The content to write when `event` (an updated copy) replaces `storedEvent`:
 * the event's content with every server-owned field taken from the stored
 * one (absent there, absent here). Server-owned: `CMC_SERVER_OWNED_FIELDS` on
 * every CMC event type, plus `ACCEPT_SERVER_OWNED_FIELDS` on an accept. The
 * event's content as is for any other type or a non-object content.
 * Pure: the api-server calls it again on the row as stored at write time.
 */
function preserveServerOwnedContent (storedEvent: EventLike | null | undefined, event: EventLike): unknown {
  if (!C.isCmcEventType(event?.type) || !isPlainObject(event.content)) return event?.content;
  const storedContent = storedEvent?.type === event.type ? storedEvent?.content : undefined;
  const stored = isPlainObject(storedContent) ? storedContent : {};
  const fields = event.type === C.ET_ACCEPT
    ? [...C.CMC_SERVER_OWNED_FIELDS, ...C.ACCEPT_SERVER_OWNED_FIELDS]
    : C.CMC_SERVER_OWNED_FIELDS;
  // Copy: the merged event may share the content object with the update.
  const content: Record<string, unknown> = { ...event.content };
  for (const field of fields) {
    if (stored[field] === undefined) {
      delete content[field];
    } else {
      content[field] = stored[field];
    }
  }
  return content;
}

/**
 * events.update hook. Wired after the update prerequisites, which load the
 * stored event onto `context.oldEvent` and the merged one onto
 * `context.newEvent`. (The api-server applies `preserveServerOwnedContent`
 * again against the row as stored at write time.)
 */
function createAcceptPreserveHook (): Middleware {
  return function cmcAcceptPreserveHook (context, _params, _result, next) {
    const event = context?.newEvent;
    if (event == null) return next();
    event.content = preserveServerOwnedContent(context.oldEvent, event);
    next();
  };
}

export {
  createAcceptStampingHook,
  createAcceptPreserveHook,
  preserveServerOwnedContent,
  approvedByFor,
};
