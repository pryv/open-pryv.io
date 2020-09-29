/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
 * 
 */
const bluebird = require('bluebird');
const SystemStreamsSerializer = require('components/business/src/system-streams/serializer');
const UsersRepository = require('components/business/src/users/repository');
const User = require('components/business/src/users/User');

/**
 * v1.6.0: Account in events
 *
 * - create events from users collection documents matching the system streams definition
 * - create indexes for unique fields
 * - TODO delete users collection
 */
module.exports = async function (context, callback) {
  console.log('V1.5.22 => v1.6.0 Migration started');

  const UserEventsStorage = new (require('../user/Events'))(context.database);
  // get streams ids from the config that should be retrieved
  const userAccountStreams = SystemStreamsSerializer.getAllAccountStreams();
  const userAccountStreamIds = Object.keys(userAccountStreams);
  let usersRepository = new UsersRepository(UserEventsStorage);

  await migrateAccounts(UserEventsStorage);
  console.log('Accounts were migrated, now creating the indexes');
  await createIndex(userAccountStreams, userAccountStreamIds, UserEventsStorage);
  console.log('V1.5.22 => v1.6.0 Migration finished');
  callback();

  async function migrateAccounts () {
    const usersCollection = await bluebird.fromCallback(cb =>
      context.database.getCollection({ name: 'users' }, cb));
    const cursor = await usersCollection.find({});

    //let requests = [];
    let shouldContinue: boolean;
    let insertedUser;
    let user;
    let i = 0;
    while (await cursor.hasNext()) {
      user = await cursor.next();
      if (i % 200 === 0) {
        console.log(`Migrating ${i} user`);
      }
      i += 1;
      try {
        user.id = user._id;
        const userObj: User = new User(user);
        insertedUser = await usersRepository.insertOne(userObj);
      } catch (err) {
        shouldContinue = isExpectedUniquenessError(err);
        if (shouldContinue == false) {
          console.log(err,'err');
          throw new Error(err);
        }
      }
    }
  }
  function isExpectedUniquenessError (err): boolean {
    if (err.isDuplicate) {
      let fieldName = err.getDuplicateSystemStreamId();
      if (['username', 'email'].includes(fieldName)) {
        // one of the expected fields, so the migration could be continued
        return true;
      }
    }
    return false;
  }

  async function createIndex (userAccountStreams, userAccountStreamIds, UserEventsStorage) {
    console.log('Building new indexes');
    
    for (let i=0; i<userAccountStreamIds.length; i++) {
      const streamId = userAccountStreamIds[i];
      const streamData = userAccountStreams[streamId];
      const streamIdWithoutDot = SystemStreamsSerializer.removeDotFromStreamId(streamId);
      if (streamData.isUnique) {
        await bluebird.fromCallback(cb => UserEventsStorage.database.db.collection('events')
          .createIndex({ [streamIdWithoutDot + '__unique']: 1 },
            {
              unique: true,
              partialFilterExpression: {
                [streamIdWithoutDot + '__unique']: { '$exists': true },
                streamIds: SystemStreamsSerializer.options.STREAM_ID_UNIQUE
              },
              background: true
            }, cb));
      }
    }
  }

};
