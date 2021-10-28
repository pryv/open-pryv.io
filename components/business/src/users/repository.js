/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
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
 */
// @flow

const bluebird = require('bluebird');
const _ = require('lodash');
const timestamp = require('unix-timestamp');

const User = require('./User');
const UserRepositoryOptions = require('./UserRepositoryOptions');
import type { Event } from 'business/src/events';
import type { Access } from 'business/src/accesses';
import type { SystemStream } from 'business/src/system-streams';
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const encryption = require('utils').encryption;
const errors = require('errors').factory;
const { safetyCleanDuplicate } = require('business/src/auth/service_register');

const cache = require('cache');

/**
 * Repository of the users
 */
class UsersRepository {
  storageLayer: {};
  eventsStorage: {};
  sessionsStorage: {};
  accessStorage: {};
  collectionInfo: {};
  uniqueFields: Array<string>;
  constructor() {
    this.uniqueFields = SystemStreamsSerializer.getUniqueAccountStreamsIdsWithoutPrefix();
  }

  async init() {
    const storage = require('storage');
    this.storageLayer = await storage.getStorageLayer();
    this.eventsStorage = this.storageLayer.events;
    this.sessionsStorage = this.storageLayer.sessions;
    this.accessStorage = this.storageLayer.accesses;
    this.collectionInfo = this.eventsStorage.getCollectionInfoWithoutUserId();

  }

  async getAll(): Promise<Array<User>> {
    const query: {} = {
      streamIds: { $in: [SystemStreamsSerializer.options.STREAM_ID_USERNAME] },
      deleted: null,
      headId: null,
    };

    const userIdObjects: Array<{}> = await bluebird.fromCallback(
      cb => this.eventsStorage.database.find(
        this.collectionInfo,
        this.eventsStorage.applyQueryToDB(query),
        this.eventsStorage.applyOptionsToDB(null),
        cb,
      ),
    );

    const users: Array<User> = [];
    for (const userIdObject of userIdObjects) {
      const user = await this.getUserById(userIdObject.userId);
      users.push(user);
    }
    return users;
  }

  
  async getAllUsernames(): Promise<Array<User>> {
    const query: {} = {
      streamIds: { $in: [SystemStreamsSerializer.options.STREAM_ID_USERNAME] },
      deleted: null,
      headId: null,
    };

    const userIdObjects: Array<{}> = await bluebird.fromCallback(
      cb => this.eventsStorage.database.find(
        this.collectionInfo,
        this.eventsStorage.applyQueryToDB(query),
        this.eventsStorage.applyOptionsToDB(null),
        cb,
      ),
    );

    const users: Array<User> = [];
    for (const userIdObject of userIdObjects) {
      users.push(new User({ id: userIdObject.userId, events: [userIdObject] }));
    }
    return users;
  }
  async getUserIdForUsername(username: string) {
    let userId = cache.get(cache.NS.USERID_BY_USERNAME, username);
    if (! userId) {
      const userIdEvent = await bluebird.fromCallback(
        cb => this.eventsStorage.database.findOne(
          this.collectionInfo,
          this.eventsStorage.applyQueryToDB(
            {
              $and: [
                {
                  streamIds: {
                    $in: [SystemStreamsSerializer.options.STREAM_ID_USERNAME],
                  },
                },
                { content: { $eq: username } },
              ],
            },
          ),
          null,
          cb,
        ),
      );
      userId = userIdEvent?.userId;
      cache.set(cache.NS.USERID_BY_USERNAME, username, userId);
    }
    return userId;
  }
  async getUserById(userId: string): Promise<?User> {
    const userAccountStreamsIds =  SystemStreamsSerializer.getAccountMap();
    
    const query: {} = {
      $and: [
        { streamIds: { $in: Object.keys(userAccountStreamsIds) } },
        { streamIds: { $eq: SystemStreamsSerializer.options.STREAM_ID_ACTIVE } },
      ],
    };

    const userAccountEvents: Array<Event> = await bluebird.fromCallback(
      cb => this.eventsStorage.find({ id: userId }, query, null, cb),
    );

    // convert events to the account info structure
    if (
      userAccountEvents.length == 0
    ) {
      return null;
    }
    const user = new User({ id: userId, events: userAccountEvents });
    return user;
  }
  async getUserByUsername(username: string): Promise<?User> {
    let userId = await this.getUserIdForUsername(username);
    if (userId) {
      const user = await this.getUserById(userId);
      if (! user) {
         cache.unset(cache.NS.USERID_BY_USERNAME, username);
      }
      return user;
    } 
    return null;
  }

  async getStorageUsedByUserId(userId: string): Promise<?any>  {
    return {
      dbDocuments: await this.getOnePropertyValue(userId, 'dbDocuments') || 0,
      attachedFiles: await this.getOnePropertyValue(userId, 'attachedFiles') || 0
    };
  }

  async getOnePropertyValue(userId: string, propertyKey: string) {
    const res = await bluebird.fromCallback( 
      cb => this.eventsStorage.find(
        { id: userId}, 
        { streamIds: {$in: [SystemStreamsSerializer.addCorrectPrefixToAccountStreamId(propertyKey)] } }, 
        {limit: 1},
        cb));
    if (! res || ! res[0]) return null;
    return res[0].content;
  };

  async findExistingUniqueFields(fields: {}): Promise<{}> {
    const query = { $or: [] }
    Object.keys(fields).forEach(key => {
      query['$or'].push({
        $and:
          [
            { streamIds: SystemStreamsSerializer.addCorrectPrefixToAccountStreamId(key) },
            { content: fields[key] }
          ]
      });
    });

    const existingUsers = await bluebird.fromCallback(
      cb => this.eventsStorage.database.find(this.collectionInfo, query, {}, cb),
    );
    return existingUsers;
  }
  async createSessionForUser(
    username: string,
    appId: string,
    transactionSession: any,
  ): Promise<string> {
    return await bluebird.fromCallback(
      cb => this.sessionsStorage.generate(
        { username, appId },
        { transactionSession },
        cb,
      ),
    );
  }
  async createPersonalAccessForUser(
    userId: string,
    token: string,
    appId: string,
    transactionSession,
  ): Access {
    const accessData = {
      token: token,
      name: appId,
      type: UserRepositoryOptions.ACCESS_TYPE_PERSONAL,
      created: timestamp.now(),
      createdBy: UserRepositoryOptions.SYSTEM_USER_ACCESS_ID,
      modified: timestamp.now(),
      modifiedBy: UserRepositoryOptions.SYSTEM_USER_ACCESS_ID,
    };

    return await bluebird.fromCallback(
      cb => this.accessStorage.insertOne(
        { id: userId },
        accessData,
        cb,
        { transactionSession },
      ),
    );
  }
  validateAllStorageObjectsInitialized(): boolean {
    if (this.accessStorage == null || this.sessionsStorage == null) {
      throw (
        new Error(
          "Please initialize the user repository with all dependencies.",
        )
      );
    }
    return true;
  }
  async insertOne(user: User, withSession: ?boolean = false): Promise<User> {
    cache.unset(cache.NS.USERID_BY_USERNAME, user.username);
    // first explicitly create a collection, because it would fail in the transation
    await bluebird.fromCallback(
      cb => this.eventsStorage.database.getCollection(this.collectionInfo, cb),
    );

    await this.checkDuplicates(user);

    const transactionSession = await this.eventsStorage.database.startSession();
    await transactionSession.withTransaction(
      async () => {
        let accessId = UserRepositoryOptions.SYSTEM_USER_ACCESS_ID;
        if (
          withSession && this.validateAllStorageObjectsInitialized() &&
          user.appId != null
        ) {
          const token: string = await this.createSessionForUser(
            user.username,
            user.appId,
            transactionSession,
          );
          const access = await this.createPersonalAccessForUser(
            user.id,
            token,
            user.appId,
            transactionSession,
          );
          accessId = access?.id;
          user.token = access.token;
        }
        user.accessId = accessId;

        const events: Array<Event> = await user.getEvents();

        await bluebird.fromCallback(
          cb => this.eventsStorage.insertMany(
            { id: user.id },
            events,
            cb,
            { transactionSession },
          ),
        );
      },
      getTransactionOptions(),
    );
    return user;
  }
  async updateOne(user: User, update: {}, accessId: string): Promise<void> {
    // invalidate caches
    cache.unset(cache.NS.USERID_BY_USERNAME, user.username);
   
    await this.checkDuplicates(update);
    
    // change password into hash if it exists
    if (update.password != null) {
      update.passwordHash = await bluebird.fromCallback(
        cb => encryption.hash(update.password, cb),
      );
    }
    delete update.password;
    
    // Start a transaction session
    const transactionSession = await this.eventsStorage.database.startSession();
    await transactionSession.withTransaction(async () => {
      // update all account streams and don't allow additional properties
      for (const [streamIdWithoutPrefix, content] of Object.entries(update)) {
      //for (let i = 0; i < eventsForUpdate.length; i++) {
        await bluebird.fromCallback(cb => this.eventsStorage.updateOne(
          { id: user.id },
          {
            streamIds: {
              $all: [
                SystemStreamsSerializer.addCorrectPrefixToAccountStreamId(streamIdWithoutPrefix),
                SystemStreamsSerializer.options.STREAM_ID_ACTIVE,
              ]
            }
          },
          {
            content,
            modified: timestamp.now(),
            modifiedBy: accessId,
          },
          cb,
          { transactionSession }
        ));
      }
    }, getTransactionOptions());
  }
  async deleteOne(userId: string): Promise<number> {
    const userAccountStreamsIds: Array<string> = SystemStreamsSerializer.getAccountStreamIds();
    return await bluebird.fromCallback(
      cb => this.eventsStorage.database.deleteMany(
        this.eventsStorage.getCollectionInfo(userId),
        { streamIds: { $in: userAccountStreamsIds } },
        cb,
      ),
    );
  }
  async checkUserPassword(userId: string, password: string): Promise<boolean> {
    const currentPass = await getUserPasswordHash(userId, this.eventsStorage);
    let isValid: boolean = false;
    if (currentPass != null) {
      isValid = await bluebird.fromCallback(
        cb => encryption.compare(password, currentPass, cb),
      );
    }
    return isValid;
  }
  async count(): Promise<number> {
    return await bluebird.fromCallback(
      cb => {
        this.eventsStorage.count(
          {},
          { streamIds: SystemStreamsSerializer.options.STREAM_ID_USERNAME },
          cb,
        );
      },
    );
  }

  /**
   * Checks for duplicates for unique fields. Throws item already exists error if any.
   * 
   * @param {User} user - a user object or 
   */
  async checkDuplicates(user: User): Promise<void> {
    const orClause: Array<{}> = [];
    this.uniqueFields.forEach(field => {
      if (user[field] != null) {
        orClause.push({
          content: { $eq: user[field] },
          streamIds: SystemStreamsSerializer.addCorrectPrefixToAccountStreamId(field),
          deleted: null,
          headId: null,
        });
      }
    });

    if (orClause.length === 0) return;

    const query: {} = { $or: orClause };
    
    const duplicateEvents: ?Array<Event> = await bluebird.fromCallback(
      cb => this.eventsStorage.find(
        this.collectionInfo,
        this.eventsStorage.applyQueryToDB(query),
        this.eventsStorage.applyOptionsToDB(null),
        cb,
      ),
    );
    if (duplicateEvents != null && duplicateEvents.length > 0) {
      const uniquenessErrors = {};
      duplicateEvents.forEach(
        duplicate => {
          const key = extractDuplicateField(
            this.uniqueFields,
            duplicate.streamIds,
          );
          uniquenessErrors[key] = user[key];
        },
      );
      throw (
        errors.itemAlreadyExists(
          "user",
          uniquenessErrors,
        )
      );
    }
    return;

    function extractDuplicateField(streamIdsWithoutPrefix, streamIdsWithPrefix): string {
      const intersection: Array<string> = streamIdsWithoutPrefix.filter(streamIdWithoutPrefix => 
        streamIdsWithPrefix.includes(SystemStreamsSerializer.addCorrectPrefixToAccountStreamId(streamIdWithoutPrefix))
      )
      return intersection[0];
    }
  }
}

/**
   * Get object with transaction options
   */
function getTransactionOptions() {
  return {
    readPreference: 'primary',
    readConcern: { level: 'local' },
    writeConcern: { w: 'majority' },
  };
}

/**
 * Get user password hash
 * @param string userId 
 */
async function getUserPasswordHash(userId: string, storage: any): Promise<?string> {
  const userPass: Event = await bluebird.fromCallback(cb =>
    storage.findOne({ id: userId },
      {
        $and: [
          { streamIds: SystemStreamsSerializer.options.STREAM_ID_PASSWORDHASH }
        ]
      }, null, cb));
  return (userPass?.content != null) ? userPass.content : null;
}


let usersRepository = null;
let usersRepositoryInitializing = false;
async function getUsersRepository() {
  while (usersRepositoryInitializing) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!usersRepository) {
    usersRepositoryInitializing = true;
    usersRepository = new UsersRepository();
    await usersRepository.init();
    usersRepositoryInitializing = false;
  }
  return usersRepository;
}

module.exports = {
  getUsersRepository,
};
