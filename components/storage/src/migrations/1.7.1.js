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

const { getLogger } = require('@pryv/boiler');
/**
 * v1.7.1:
 * - change delete date from numbers to daate
 */
module.exports = async function (context, callback) {
  const logger = getLogger('migration-1.7.1');
  logger.info('V1.7.0 => v1.7.1 Migration started');

  const eventsCollection = await context.database.getCollection({ name: 'events' });
  const streamsCollection = await context.database.getCollection({ name: 'streams' });
  const accessesCollection = await context.database.getCollection({ name: 'accesses' });
  const webhooksCollection = await context.database.getCollection({ name: 'webhooks' });

  await migrateDeletedDates(accessesCollection);
  await migrateDeletedDates(eventsCollection);
  await migrateDeletedDates(streamsCollection);
  await migrateDeletedDates(webhooksCollection);

  logger.info('V1.7.0 => v1.7.1 Migration finished');
  callback();

  // ----------------- DELETED Dates to Number

  async function migrateDeletedDates (collection) {
    const cursor = collection.find({ deleted: { $type: 'date' } });
    let requests = [];
    let document;
    let eventsMigrated = 0;
    while (await cursor.hasNext()) {
      document = await cursor.next();
      eventsMigrated++;
      requests.push({
        updateOne: {
          filter: { _id: document._id },
          update: {
            $set: { deleted: document.deleted.getTime() / 1000 }
          }
        }
      });

      if (requests.length === 1000) {
        // Execute per 1000 operations and re-init
        await collection.bulkWrite(requests);
        console.log('Updated date for ' + eventsMigrated + ' ' + collection.namespace);
        requests = [];
      }
    }

    if (requests.length > 0) {
      await collection.bulkWrite(requests);
      console.log('Updated date for ' + eventsMigrated + ' ' + collection.namespace);
    }
    console.log('Finalizing date update for ' + collection.namespace);
  }
};
