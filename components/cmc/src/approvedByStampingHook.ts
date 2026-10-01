/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import * as C from './constants.ts';

/**
 * CMC plugin: `content.approvedBy` on a consent accept, who approved it and
 * through which account delegation, when it was not the account owner.
 *
 * A delegate (a carer managing the account) may accept a consent for the
 * account it manages. The accept event then records
 * `content.approvedBy = { delegate: { username, hostSlug? }, relId }`, so the
 * managed person sees who gave the consent and through which relationship.
 * (`content.acceptedBy` is taken: the dispatch stamps it with the accepter's
 * data-grant endpoint.)
 *
 * The field is server-owned:
 *   - events.create (`createApprovedByStampingHook`): any client-supplied
 *     `approvedBy` is removed, whoever writes; when the writing access is
 *     delegation-derived, the field is set from that access's own marker
 *     (read by the injected `lineageOf`, the delegation plugin's reader, so
 *     this plugin does not import it). The content validator lets extra keys
 *     through, so without the removal a client could write the field itself.
 *   - events.update (`createApprovedByPreserveHook`): the stored value is
 *     kept, a client-supplied one is dropped. A content update replaces the
 *     content whole, so the stored value is put back explicitly.
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
function createApprovedByStampingHook (deps: { lineageOf: LineageOf }): Middleware {
  return function cmcApprovedByStampingHook (context, _params, _result, next) {
    const event = context?.newEvent;
    if (event?.type !== C.ET_ACCEPT || !isPlainObject(event.content)) return next();
    delete event.content.approvedBy;
    const approvedBy = approvedByFor(deps.lineageOf, context.access);
    if (approvedBy != null) event.content.approvedBy = approvedBy;
    next();
  };
}

/**
 * events.update hook. Wired after the update prerequisites, which load the
 * stored event onto `context.oldEvent` and the merged one onto
 * `context.newEvent`.
 */
function createApprovedByPreserveHook (): Middleware {
  return function cmcApprovedByPreserveHook (context, _params, _result, next) {
    const event = context?.newEvent;
    if (event?.type !== C.ET_ACCEPT || !isPlainObject(event.content)) return next();
    const old = context.oldEvent;
    const stored = (old?.type === C.ET_ACCEPT && isPlainObject(old.content)) ? old.content.approvedBy : undefined;
    // Copy: the merged event may share the content object with the update.
    const content: Record<string, unknown> = { ...event.content };
    if (stored === undefined) {
      delete content.approvedBy;
    } else {
      content.approvedBy = stored;
    }
    event.content = content;
    next();
  };
}

export {
  createApprovedByStampingHook,
  createApprovedByPreserveHook,
  approvedByFor,
};
