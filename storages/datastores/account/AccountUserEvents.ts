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
const { matchesConditions } = require('../../shared/contentQueryConditions.ts');
import type { NormalizedCondition } from '../../shared/contentQueryConditions.ts';

type StreamConfig = { id: string; type: string; [k: string]: unknown };
type Event = {
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
};
type StreamCondition = { any?: string[]; not?: string[] };
type StreamGroup = StreamCondition | StreamCondition[];
type EventOptions = { sortAscending?: boolean; skip?: number; limit?: number };
type FieldHistoryEntry = { value: unknown; time: number; createdBy?: string };
type Storage = {
  getAccountField (userId: string, fieldName: string): Promise<unknown>;
  getAccountFields (userId: string): Promise<Record<string, unknown>>;
  getAccountFieldHistory (userId: string, fieldName: string): Promise<FieldHistoryEntry[]>;
  setAccountField (userId: string, fieldName: string, value: unknown, by: string, time: number): Promise<void>;
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
 */
function create (fieldStreamMap: Map<string, StreamConfig>, getStorage: () => Promise<Storage>) {
  return ds.createUserEvents({

    async getOne (userId: string, eventId: string): Promise<Event | null> {
      const storage = await getStorage();
      const fieldName = toFieldName(eventId);
      const streamConfig = fieldStreamMap.get(fieldName);
      if (!streamConfig) return null;
      const value = await storage.getAccountField(userId, fieldName);
      if (value == null) return null;
      return fieldToEvent(fieldName, value, streamConfig);
    },

    async get (userId: string, query: EventQuery, options: EventOptions): Promise<Event[]> {
      const storage = await getStorage();
      const fields = await storage.getAccountFields(userId);
      let events: Event[] = [];
      for (const [fieldName, value] of Object.entries(fields)) {
        const streamConfig = fieldStreamMap.get(fieldName);
        if (!streamConfig) continue;
        events.push(fieldToEvent(fieldName, value, streamConfig));
      }
      events = filterByQuery(events, query);
      events = applyOptions(events, options);
      return events;
    },

    async getStreamed (userId: string, query: EventQuery, options: EventOptions): Promise<ReadableType> {
      const events = await (this as { get: (uid: string, q: EventQuery, o: EventOptions) => Promise<Event[]> }).get(userId, query, options);
      return Readable.from(events);
    },

    async getDeletionsStreamed (_userId: string, _query: EventQuery, _options: EventOptions): Promise<ReadableType> {
      return Readable.from([]);
    },

    async getHistory (userId: string, eventId: string): Promise<Event[]> {
      const storage = await getStorage();
      const fieldName = toFieldName(eventId);
      const streamConfig = fieldStreamMap.get(fieldName);
      if (!streamConfig) return [];
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

    async create (userId: string, eventData: Partial<Event>): Promise<Event> {
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

    async update (userId: string, eventData: Partial<Event>): Promise<boolean> {
      const fieldName = toFieldName(eventData.id!);
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
 */
function fieldToEvent (fieldName: string, value: unknown, streamConfig: StreamConfig, time?: number, createdBy?: string): Event {
  const now = time || timestamp.now();
  return {
    id: fieldName,
    streamIds: [streamConfig.id],
    type: streamConfig.type,
    content: value,
    time: now,
    created: now,
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
function filterByQuery (events: Event[], query: EventQuery | null | undefined): Event[] {
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
 * Check if an event's streamIds match the normalized stream query.
 * @param streamGroups - normalized stream query groups
 */
function matchesStreamQuery (eventStreamIds: string[], streamGroups: StreamGroup[]): boolean {
  const sids = new Set(eventStreamIds);
  // OR between groups
  for (const group of streamGroups) {
    if (matchesGroup(sids, group)) return true;
  }
  return false;
}

/**
 * Check if streamIds match all conditions in a group (AND).
 * A group is an array of condition objects: { any: [...] } or { not: [...] }
 */
function matchesGroup (sids: Set<string>, group: StreamGroup): boolean {
  // Handle both normalized format (array of conditions) and simple format (single object)
  const conditions: StreamCondition[] = Array.isArray(group) ? group : [group];
  for (const cond of conditions) {
    if (cond.any) {
      // At least one of 'any' must be in the event's streamIds
      if (!cond.any.some((sid) => sids.has(sid))) return false;
    }
    if (cond.not) {
      // None of 'not' must be in the event's streamIds
      if (cond.not.some((sid) => sids.has(sid))) return false;
    }
  }
  return true;
}

/**
 * Apply skip/limit/sort options.
 */
function applyOptions (events: Event[], options: EventOptions | null | undefined): Event[] {
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
