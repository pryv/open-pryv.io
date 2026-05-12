/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ds = require('@pryv/datastore');
const { Readable } = require('stream');
const timestamp = require('unix-timestamp');

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
function create (fieldStreamMap: any, getStorage: any) {
  return ds.createUserEvents({

    async getOne (userId: any, eventId: any) {
      const storage = await getStorage();
      const fieldName = toFieldName(eventId);
      const streamConfig = fieldStreamMap.get(fieldName);
      if (!streamConfig) return null;
      const value = await storage.getAccountField(userId, fieldName);
      if (value == null) return null;
      return fieldToEvent(fieldName, value, streamConfig);
    },

    async get (userId: any, query: any, options: any) {
      const storage = await getStorage();
      const fields = await storage.getAccountFields(userId);
      let events: any[] = [];
      for (const [fieldName, value] of Object.entries(fields)) {
        const streamConfig = fieldStreamMap.get(fieldName);
        if (!streamConfig) continue;
        events.push(fieldToEvent(fieldName, value, streamConfig));
      }
      events = filterByQuery(events, query);
      events = applyOptions(events, options);
      return events;
    },

    async getStreamed (userId: any, query: any, options: any) {
      const events = await this.get(userId, query, options);
      return Readable.from(events);
    },

    async getDeletionsStreamed (userId: any, query: any, options: any) {
      return Readable.from([]);
    },

    async getHistory (userId: any, eventId: any) {
      const storage = await getStorage();
      const fieldName = toFieldName(eventId);
      const streamConfig = fieldStreamMap.get(fieldName);
      if (!streamConfig) return [];
      const history = await storage.getAccountFieldHistory(userId, fieldName);
      // Skip the first entry (current value) — history should only contain previous versions
      const previousVersions = history.slice(1);
      return previousVersions.map((entry: any) => ({
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

    async create (userId: any, eventData: any) {
      const fieldName = eventIdFromStreamIds(eventData.streamIds, fieldStreamMap);
      if (!fieldName) {
        throw ds.errors.invalidRequestStructure('Event must belong to a known account stream');
      }
      const streamConfig = fieldStreamMap.get(fieldName);
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

    async update (userId: any, eventData: any) {
      const fieldName = toFieldName(eventData.id);
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

    async delete (userId: any, eventId: any) {
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
function toFieldName (eventId: any) {
  const lastColon = eventId.lastIndexOf(':');
  return lastColon >= 0 ? eventId.substring(lastColon + 1) : eventId;
}

/**
 * Convert a stored field to an event object.
 */
function fieldToEvent (fieldName: any, value: any, streamConfig: any, time?: any, createdBy?: any) {
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
function eventIdFromStreamIds (streamIds: any, fieldMap: any) {
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
function filterByQuery (events: any, query: any) {
  if (!query) return events;

  // Account events are never trashed — return empty for 'trashed' state
  if (query.state === 'trashed') {
    return [];
  }

  if (query.streams && query.streams.length > 0) {
    events = events.filter((e: any) => matchesStreamQuery(e.streamIds, query.streams));
  }

  if (query.types && query.types.length > 0) {
    const typeSet = new Set(query.types);
    events = events.filter((e: any) => typeSet.has(e.type));
  }

  // Account events are never "running" period events (no duration concept)
  if (query.running === true) {
    return [];
  }

  if (query.fromTime != null) {
    events = events.filter((e: any) => e.time >= query.fromTime);
  }
  if (query.toTime != null) {
    events = events.filter((e: any) => e.time < query.toTime);
  }

  if (query.modifiedSince != null) {
    events = events.filter((e: any) => e.modified >= query.modifiedSince);
  }

  return events;
}

/**
 * Check if an event's streamIds match the normalized stream query.
 * @param streamGroups - normalized stream query groups
 */
function matchesStreamQuery (eventStreamIds: any, streamGroups: any) {
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
function matchesGroup (sids: any, group: any) {
  // Handle both normalized format (array of conditions) and simple format (single object)
  const conditions = Array.isArray(group) ? group : [group];
  for (const cond of conditions) {
    if (cond.any) {
      // At least one of 'any' must be in the event's streamIds
      if (!cond.any.some((sid: any) => sids.has(sid))) return false;
    }
    if (cond.not) {
      // None of 'not' must be in the event's streamIds
      if (cond.not.some((sid: any) => sids.has(sid))) return false;
    }
  }
  return true;
}

/**
 * Apply skip/limit/sort options.
 */
function applyOptions (events: any, options: any) {
  if (!options) return events;
  if (options.sortAscending === true) {
    events.sort((a: any, b: any) => a.time - b.time);
  } else if (options.sortAscending === false) {
    events.sort((a: any, b: any) => b.time - a.time);
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