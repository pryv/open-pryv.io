/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const schema = module.exports = {
  dbSchema: {
    eventid: { type: 'TEXT UNIQUE', index: true, coerce: 'txt' },
    headId: { type: 'TEXT DEFAULT NULL', coerce: 'txt' },
    streamIds: { type: 'TEXT', coerce: 'txt' },
    time: { type: 'REAL', index: true, coerce: 'num' },
    deleted: { type: 'REAL DEFAULT NULL', index: true, coerce: 'num' },
    endTime: { type: 'REAL', index: true, coerce: 'num' },
    type: { type: 'TEXT', index: true, coerce: 'txt' },
    content: { type: 'TEXT', coerce: 'txt' },
    description: { type: 'TEXT', coerce: 'txt' },
    clientData: { type: 'TEXT', coerce: 'txt' },
    integrity: { type: 'TEXT', coerce: 'txt' },
    attachments: { type: 'TEXT', coerce: 'txt' },
    trashed: { type: 'INTEGER DEFAULT 0', index: true, coerce: 'bool' },
    created: { type: 'REAL', index: true, coerce: 'num' },
    createdBy: { type: 'TEXT', index: true, coerce: 'txt' },
    modified: { type: 'REAL', index: true, coerce: 'num' },
    modifiedBy: { type: 'TEXT', index: true, coerce: 'txt' }
  },

  ALL_EVENTS_TAG: '..',

  toDB,
  fromDB,
  fromDBHistory,
  coerceValueForColumn
};

const IDS_SEPARATOR = ' ';

/**
 * @param {Object} event
 * @returns {Object}
 */
function toDB (event) {
  const dbEvent = {};
  dbEvent.eventid = event.id;

  if (event.streamIds == null) {
    dbEvent.streamIds = schema.ALL_EVENTS_TAG;
  } else {
    if (!Array.isArray(event.streamIds)) throw new Error('streamIds must be an Array');
    dbEvent.streamIds = event.streamIds.join(IDS_SEPARATOR) + IDS_SEPARATOR + schema.ALL_EVENTS_TAG;
  }

  dbEvent.time = nullIfUndefined(event.time);

  dbEvent.endTime = nullIfUndefined(event.endTime);
  dbEvent.deleted = nullIfUndefined(event.deleted);
  dbEvent.integrity = nullIfUndefined(event.integrity);
  dbEvent.headId = nullIfUndefined(event.headId);

  dbEvent.type = nullIfUndefined(event.type);

  dbEvent.content = nullOrJSON(event.content);

  dbEvent.description = nullIfUndefined(event.description);
  dbEvent.created = nullIfUndefined(event.created);
  dbEvent.clientData = nullOrJSON(event.clientData);
  dbEvent.attachments = nullOrJSON(event.attachments);
  dbEvent.trashed = (event.trashed) ? 1 : 0;
  dbEvent.createdBy = nullIfUndefined(event.createdBy);
  dbEvent.modifiedBy = nullIfUndefined(event.modifiedBy);
  dbEvent.modified = nullIfUndefined(event.modified);

  return dbEvent;
}

function nullIfUndefined (value) {
  return (typeof value !== 'undefined') ? value : null;
}

function nullOrJSON (value) {
  if (typeof value === 'undefined' || value === null) return null;
  return JSON.stringify(value);
}

/**
 * @param {Object} dbEvent
 * @returns {Object}
 */
function fromDB (dbEvent) {
  if (dbEvent.streamIds != null) {
    dbEvent.streamIds = dbEvent.streamIds.split(IDS_SEPARATOR);
    dbEvent.streamIds.pop(); // pop removes the last element which is set on all events ALL_EVENTS_TAG
    if (dbEvent.streamIds.length === 0) delete dbEvent.streamIds; // it was a "deleted" event
  }

  dbEvent.id = dbEvent.eventid;
  delete dbEvent.eventid;

  if (dbEvent.trashed === 1) {
    dbEvent.trashed = true;
  } else {
    delete dbEvent.trashed; // don't return to API if false
  }

  if (dbEvent.content != null) {
    dbEvent.content = JSON.parse(dbEvent.content);
  }

  if (dbEvent.attachments != null) {
    dbEvent.attachments = JSON.parse(dbEvent.attachments);
  }

  if (dbEvent.clientData != null) {
    dbEvent.clientData = JSON.parse(dbEvent.clientData);
  }

  for (const key of Object.keys(dbEvent)) {
    // delete all `null` fields except `endTime` (in which case `null` means "running")
    if (key !== 'endTime' && dbEvent[key] == null) delete dbEvent[key];
  }

  return dbEvent;
}

function fromDBHistory (event) {
  event = fromDB(event);
  event.id = event.headId;
  delete event.headId;
  return event;
}

/**
 * - Add eventual '' to values that are not of type "REAL" and escape possible '
 * - Transform booleans to 0/1
 * - Check that numbers are numbers
 * Does not handle "null" values
 * @param {string} column
 * @param {*} value
 */
function coerceValueForColumn (column, value) {
  return coerceFns[schema.dbSchema[column].coerce](value);
}

const coerceFns = {
  txt: (value) => { return "'" + (value + '').replaceAll("'", "\\'") + "'"; },
  num: (value) => { return (typeof value === 'number') ? value : parseFloat(value); },
  bool: (value) => { return value ? 1 : 0; }
};
