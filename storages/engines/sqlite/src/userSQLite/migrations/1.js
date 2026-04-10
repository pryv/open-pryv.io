/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Migration of v0 to 1 is done in the following steps:
// 1. Open v0
// 2. Copy events to v1
// 3. Delete v0 file

// We cannot simply update the schema as we cannot alter NULLABLE state of columns

// changes:
// - renamed duration to endTime
// - added deleted
// - added attachments
// changed most of the fields to be nullable
// - added headId

const SQLite3 = require('better-sqlite3');
const fs = require('fs/promises');

module.exports = async function migrateUserDB (v0dbPath, v1userDB, logger) {
  const v0db = new SQLite3(v0dbPath);
  const v0EventsIterator = v0db.prepare('SELECT * FROM events').iterate();
  const res = { count: 0 };

  v1userDB.db.exec('BEGIN');
  for (const eventData of v0EventsIterator) {
    eventData.eventid = eventData.id;
    delete eventData.id;

    if (eventData.duration) { // NOT null, 0, undefined
      eventData.endTime = eventData.time + eventData.duration;
    } else {
      eventData.endTime = eventData.time;
    }

    if (eventData.streamIds != null) {
      eventData.streamIds = eventData.streamIds.split(' ');
    }

    if (eventData.content != null) {
      eventData.content = JSON.parse(eventData.content);
    }
    delete eventData.duration;
    res.count++;
    v1userDB.createEventSync(eventData);
  }
  v1userDB.db.exec('COMMIT');

  v0db.close();
  await fs.unlink(v0dbPath);
  return res;
};
