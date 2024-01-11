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
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const { getLogger } = require('@pryv/boiler');
const DOT = '.';
/**
 * v1.7.5:
 * - migrate system streamIds in access permissions
 */
module.exports = async function (context, callback) {
  await SystemStreamsSerializer.init();
  const { isPrivateSystemStreamId } = SystemStreamsSerializer;
  const logger = getLogger('migration-1.7.5');
  logger.info('V1.7.1 => v1.7.5 Migration started');
  const accessesCollection = await context.database.getCollection({
    name: 'accesses'
  });
  await migrateAccessPermissions(accessesCollection);
  logger.info('V1.7.1 => v1.7.5 Migration finished');
  callback();
  async function migrateAccessPermissions (collection) {
    const cursor = collection.find({
      'permissions.streamId': { $regex: /^\./ }
    });
    let requests = [];
    let accessesMigrated = 0;
    while (await cursor.hasNext()) {
      const access = await cursor.next();
      if (access.type !== 'personal') {
        const oldPermissions = access.permissions;
        if (hasDotPermission(oldPermissions)) {
          const newPermissions = oldPermissions.map(translateToNewOrNothing);
          requests.push({
            updateOne: {
              filter: { _id: access._id },
              update: {
                $set: { permissions: newPermissions },
                $unset: { integrity: 1 }
              }
            }
          });
          accessesMigrated++;
          if (requests.length === 50) {
            // Execute per 1000 operations and re-init
            await collection.bulkWrite(requests);
            logger.info('Updated access permissions streamIds for ' +
                            accessesMigrated +
                            ' ' +
                            collection.namespace);
            requests = [];
          }
        }
      }
    }
    if (requests.length > 0) {
      await collection.bulkWrite(requests);
      logger.info('Updated access permissions streamIds for ' +
                accessesMigrated +
                ' ' +
                collection.namespace);
    }
    function hasDotPermission (permissions) {
      for (const permission of permissions) {
        if (permission.streamId != null && permission.streamId.startsWith(DOT)) { return true; }
      }
      return false;
    }
    function translateToNewOrNothing (permission) {
      const oldStreamId = permission.streamId;
      if (oldStreamId == null) { return permission; }
      if (!oldStreamId.startsWith(DOT)) { return permission; }
      const streamIdWithoutPrefix = oldStreamId.substring(1);
      let newStreamId;
      if (isPrivateSystemStreamId(streamIdWithoutPrefix)) {
        newStreamId = ':_system:' + streamIdWithoutPrefix;
      } else {
        newStreamId = ':system:' + streamIdWithoutPrefix;
      }
      permission.streamId = newStreamId;
      return permission;
    }
  }
};
