/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { EventsQueryState } from '../../interfaces/_shared/types.ts';
import type { Readable as ReadableType } from 'node:stream';
const require = createRequire(import.meta.url);

const ds = require('@pryv/datastore');
const { Readable } = require('stream');
const timestamp = require('unix-timestamp');
const { matchesConditions, matchesStreamQuery } = require('utils').eventMatchQuery;
import type { NormalizedCondition, StreamGroup } from 'utils';

type StreamConfig = { id: string; type: string; [k: string]: unknown };
type EventLike = {
  id: string;
  headId?: string;
  streamIds: string[];
  type: string;
  content: unknown;
  time: number;
  created: number;
  createdBy: string;
  modified: number;
  modifiedBy: string;
};
type EventQuery = {
  state?: EventsQueryState;
  streams?: StreamGroup[];
  types?: string[];
  running?: boolean;
  fromTime?: number;
  toTime?: number;
  modifiedSince?: number;
  content?: NormalizedCondition[];
  clientData?: NormalizedCondition[];
  /** Also return derived events (see DerivedField); set only by the API layer. */
  includeDerived?: boolean;
};
type EventOptions = { sortAscending?: boolean; skip?: number; limit?: number };
type FieldHistoryEntry = { value: unknown; time: number; createdBy?: string };
type FieldWithMeta = { value: unknown; time: number; createdBy?: string; firstTime: number };
type Storage = {
  getAccountField (userId: string, fieldName: string): Promise<unknown>;
  getAccountFields (userId: string): Promise<Record<string, unknown>>;
  getAccountFieldsWithMeta (userId: string): Promise<Record<string, FieldWithMeta>>;
  getAccountFieldHistory (userId: string, fieldName: string): Promise<FieldHistoryEntry[]>;
  setAccountField (userId: string, fieldName: string, value: unknown, by: string, time: number): Promise<void>;
};

/**
 * A read-only event computed from another account field and emitted in the
 * same stream (e.g. the verification state of the primary email). Nothing is
 * stored: the provider derives it at read time. Registered by the layer that
 * owns the logic (see `registerDerivedField` in index.ts), so this adapter
 * does not depend on it.
 */
type DerivedField = {
  /** Field whose event this one accompanies. */
  baseField: string;
  /** Event type of the derived event. */
  type: string;
  /** Content for the base field's current event, and when it last changed; null: no derived event. */
  provider: (userId: string, baseEvent: EventLike) => Promise<{ content: unknown, modified?: number | null } | null>;
};

/**
 * Account store UserEvents adapter.
 * Translates event get/create/update to baseStorage field operations.
 *
 * Each account field maps to one "event":
 *   - event.id = field name (e.g. 'email', 'language')
 *   - event.streamIds = [streamId] (just the field's stream ID)
 *   - event.content = field value
 *   - event.type = stream's configured type
 *
 * Platform coordination for indexed/unique fields is handled by callers
 * (account.js updateDataOnPlatform, repository.insertOne, etc.).
 *
 * @param fieldStreamMap - fieldName → stream config
 *   (only leaf streams that represent actual fields, not parent containers)
 * @param getStorage - returns userAccountStorage (async)
 * @param derivedFields - derived field name → definition. Derived events are
 *   returned by `get` only when the query sets `includeDerived` (internal
 *   readers map account events to fields by stream and must never see them),
 *   and by `getOne` when asked for by id. They cannot be written.
 */
function create (fieldStreamMap: Map<string, StreamConfig>, getStorage: () => Promise<Storage>, derivedFields: Map<string, DerivedField> = new Map()) {
  /** A derived definition for `name`; a real (operator-declared) field of the same name wins. */
  function derivedDef (name: string): DerivedField | undefined {
    return fieldStreamMap.has(name) ? undefined : derivedFields.get(name);
  }

  async function derivedEvent (userId: string, fieldName: string, base: EventLike): Promise<EventLike | null> {
    const def = derivedDef(fieldName)!;
    if (base.content == null) return null;
    const derived = await def.provider(userId, base);
    if (derived == null) return null;
    return {
      id: fieldName,
      streamIds: base.streamIds,
      type: def.type,
      content: derived.content,
      // the base event's time, so that the base event stays first in time-sorted results
      time: base.time,
      created: base.created,
      createdBy: 'system',
      modified: Math.max(base.modified, derived.modified ?? 0),
      modifiedBy: 'system'
    };
  }

  /**
   * `events` with, after each base event, the derived events that accompany it.
   * `events` are already filtered by stream (a derived event shares its base's
   * streamIds); a derived type the query's `types` excludes is not computed.
   */
  async function withDerived (userId: string, events: EventLike[], types?: string[]): Promise<EventLike[]> {
    if (derivedFields.size === 0) return events;
    const result: EventLike[] = [];
    for (const event of events) {
      result.push(event);
      for (const [name, def] of derivedFields) {
        if (def.baseField !== event.id || derivedDef(name) == null) continue;
        if (types != null && types.length > 0 && !types.includes(def.type)) continue;
        const derived = await derivedEvent(userId, name, event);
        if (derived != null) result.push(derived);
      }
    }
    return result;
  }

  function refuseDerived (fieldName: string): void {
    if (derivedDef(fieldName) != null) {
      throw ds.errors.unsupportedOperation('This account event is read-only (derived from another field).', { id: fieldName });
    }
  }

  return ds.createUserEvents({

    async getOne (userId: string, eventId: string): Promise<EventLike | null> {
      const storage = await getStorage();
      const fieldName = toFieldName(eventId);
      const def = derivedDef(fieldName);
      if (def != null) {
        const base = await (this as { getOne: (uid: string, id: string) => Promise<EventLike | null> }).getOne(userId, def.baseField);
        return base == null ? null : await derivedEvent(userId, fieldName, base);
      }
      const streamConfig = fieldStreamMap.get(fieldName);
      if (!streamConfig) return null;
      const field = (await storage.getAccountFieldsWithMeta(userId))[fieldName];
      if (field == null || field.value == null) return null;
      return fieldToEvent(fieldName, field.value, streamConfig, field.time, field.createdBy, field.firstTime);
    },

    async get (userId: string, query: EventQuery, options: EventOptions): Promise<EventLike[]> {
      const storage = await getStorage();
      const fields = await storage.getAccountFieldsWithMeta(userId);
      let events: EventLike[] = [];
      for (const [fieldName, field] of Object.entries(fields)) {
        const streamConfig = fieldStreamMap.get(fieldName);
        if (!streamConfig) continue;
        events.push(fieldToEvent(fieldName, field.value, streamConfig, field.time, field.createdBy, field.firstTime));
      }
      if (query?.includeDerived === true) {
        // stream filter first, so that derived events are computed only for base events kept
        if (query.streams && query.streams.length > 0) {
          events = events.filter((e) => matchesStreamQuery(e.streamIds, query.streams!));
        }
        events = await withDerived(userId, events, query.types);
      }
      events = filterByQuery(events, query);
      events = applyOptions(events, options);
      return events;
    },

    async getStreamed (userId: string, query: EventQuery, options: EventOptions): Promise<ReadableType> {
      const events = await (this as { get: (uid: string, q: EventQuery, o: EventOptions) => Promise<EventLike[]> }).get(userId, query, options);
      return Readable.from(events);
    },

    async getDeletionsStreamed (_userId: string, _query: EventQuery, _options: EventOptions): Promise<ReadableType> {
      return Readable.from([]);
    },

    async getHistory (userId: string, eventId: string): Promise<EventLike[]> {
      const storage = await getStorage();
      const fieldName = toFieldName(eventId);
      const streamConfig = fieldStreamMap.get(fieldName);
      if (!streamConfig) return []; // (a derived event has no history)
      const history = await storage.getAccountFieldHistory(userId, fieldName);
      // Skip the first entry (current value) — history should only contain previous versions
      const previousVersions = history.slice(1);
      return previousVersions.map((entry) => ({
        id: fieldName,
        headId: fieldName,
        streamIds: [streamConfig.id],
        type: streamConfig.type,
        content: entry.value,
        time: entry.time,
        created: entry.time,
        createdBy: entry.createdBy || 'system',
        modified: entry.time,
        modifiedBy: entry.createdBy || 'system'
      }));
    },

    async create (userId: string, eventData: Partial<EventLike>): Promise<EventLike> {
      const fieldName = eventIdFromStreamIds(eventData.streamIds, fieldStreamMap);
      if (!fieldName) {
        throw ds.errors.invalidRequestStructure('Event must belong to a known account stream');
      }
      const streamConfig = fieldStreamMap.get(fieldName)!;
      if (!streamConfig) {
        throw ds.errors.invalidRequestStructure(`Unknown account field: ${fieldName}`);
      }
      // Editability is enforced at the API layer (events.js, account.js).
      // Internal system operations need to create non-editable field events.
      const storage = await getStorage();
      const time = eventData.time || timestamp.now();
      const createdBy = eventData.createdBy || 'system';
      await storage.setAccountField(userId, fieldName, eventData.content, createdBy, time);
      return fieldToEvent(fieldName, eventData.content, streamConfig, time, createdBy);
    },

    async update (userId: string, eventData: Partial<EventLike>): Promise<boolean> {
      const fieldName = toFieldName(eventData.id!);
      refuseDerived(fieldName);
      const streamConfig = fieldStreamMap.get(fieldName);
      if (!streamConfig) return false;
      // Editability is enforced at the API layer (events.js, account.js).
      // Internal system operations (e.g. storageUsed computation) need to
      // update non-editable fields, so no guard here.
      const storage = await getStorage();
      const time = eventData.modified || timestamp.now();
      const modifiedBy = eventData.modifiedBy || 'system';
      await storage.setAccountField(userId, fieldName, eventData.content, modifiedBy, time);
      return true;
    },

    async delete (_userId: string, eventId: string): Promise<never> {
      // Account events represent current field values — deletion is blocked.
      // To clear a field, use update with content = null.
      throw ds.errors.unsupportedOperation(
        'Account events cannot be deleted. Use update to change the value.',
        { eventId }
      );
    }
  });
}

/**
 * Extract the unprefixed field name from an event ID.
 * Handles both prefixed (':_system:language') and plain ('language') IDs.
 */
function toFieldName (eventId: string): string {
  const lastColon = eventId.lastIndexOf(':');
  return lastColon >= 0 ? eventId.substring(lastColon + 1) : eventId;
}

/**
 * Convert a stored field to an event object.
 * `time` and `modified` are the time of the current value, `created` the time of
 * the field's first entry (defaults to `time`); both come from the stored
 * history so that time and `modifiedSince` filters see real dates.
 * `createdBy` / `modifiedBy` are both the author of the current value.
 */
function fieldToEvent (fieldName: string, value: unknown, streamConfig: StreamConfig, time?: number, createdBy?: string, created?: number): EventLike {
  const now = time ?? timestamp.now();
  return {
    id: fieldName,
    streamIds: [streamConfig.id],
    type: streamConfig.type,
    content: value,
    time: now,
    created: created ?? now,
    createdBy: createdBy || 'system',
    modified: now,
    modifiedBy: createdBy || 'system'
  };
}

/**
 * Extract the field name from an event's streamIds.
 * Matches against the fieldStreamMap to find the corresponding field.
 */
function eventIdFromStreamIds (streamIds: string[] | undefined, fieldMap: Map<string, StreamConfig>): string | null {
  if (!streamIds || streamIds.length === 0) return null;
  for (const sid of streamIds) {
    const lastColon = sid.lastIndexOf(':');
    const fieldName = lastColon >= 0 ? sid.substring(lastColon + 1) : sid;
    if (fieldMap.has(fieldName)) return fieldName;
  }
  return null;
}

/**
 * Filter events by query (streams, types, state).
 *
 * Handles the normalized stream query format from Mall:
 *   query.streams = [ group1, group2, ... ]
 *   Each group is an array of conditions: [{ any: [...] }, { not: [...] }, ...]
 *   Within a group: AND (all conditions must match)
 *   Between groups: OR (any group matching is enough)
 */
function filterByQuery (events: EventLike[], query: EventQuery | null | undefined): EventLike[] {
  if (!query) return events;

  // Account events are never trashed — return empty for 'trashed' state
  if (query.state === 'trashed') {
    return [];
  }

  if (query.streams && query.streams.length > 0) {
    events = events.filter((e) => matchesStreamQuery(e.streamIds, query.streams!));
  }

  if (query.types && query.types.length > 0) {
    const typeSet = new Set(query.types);
    events = events.filter((e) => typeSet.has(e.type));
  }

  // Account events are never "running" period events (no duration concept)
  if (query.running === true) {
    return [];
  }

  if (query.fromTime != null) {
    events = events.filter((e) => e.time >= query.fromTime!);
  }
  if (query.toTime != null) {
    events = events.filter((e) => e.time < query.toTime!);
  }

  if (query.modifiedSince != null) {
    events = events.filter((e) => e.modified >= query.modifiedSince!);
  }

  if (query.content != null || query.clientData != null) {
    const conditions = [...(query.content ?? []), ...(query.clientData ?? [])];
    // Account events carry no clientData — the matcher treats it as absent.
    events = events.filter((e) => matchesConditions({ content: e.content }, conditions));
  }

  return events;
}

/**
 * Apply skip/limit/sort options.
 */
function applyOptions (events: EventLike[], options: EventOptions | null | undefined): EventLike[] {
  if (!options) return events;
  if (options.sortAscending === true) {
    events.sort((a, b) => a.time - b.time);
  } else if (options.sortAscending === false) {
    events.sort((a, b) => b.time - a.time);
  }
  if (options.skip) {
    events = events.slice(options.skip);
  }
  if (options.limit) {
    events = events.slice(0, options.limit);
  }
  return events;
}

export { create };
export type { DerivedField };
