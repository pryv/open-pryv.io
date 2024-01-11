/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
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
