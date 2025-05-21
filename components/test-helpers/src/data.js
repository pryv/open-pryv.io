/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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

/**
 * Regroups shared test data and related  helper functions.
 */

const async = require('async');
const childProcess = require('child_process');
const dependencies = require('./dependencies');
const mkdirp = require('mkdirp');
const settings = dependencies.settings;
const storage = dependencies.storage;
const fs = require('fs');
const path = require('path');
const _ = require('lodash');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const { getUsersRepository, User } = require('business/src/users');
const { userLocalDirectory } = require('storage');
const charlatan = require('charlatan');
const { getConfigUnsafe, getConfig, getLogger } = require('@pryv/boiler');
const { getMall } = require('mall');
const logger = getLogger('test-helpers:data');
const { integrity } = require('business');

// users

const users = (exports.users = require('./data/users'));
const defaultUser = users[0];

exports.resetUsers = async () => {
  logger.debug('resetUsers');
  await getConfig(); // lock up to the time config is ready
  await SystemStreamsSerializer.init();
  const customAccountProperties = buildCustomAccountProperties();
  const usersRepository = await getUsersRepository();
  await usersRepository.deleteAll();
  for (const user of users) {
    const userObj = new User(_.merge(customAccountProperties, user)); // might alter storage "dump data" script
    await usersRepository.insertOne(userObj, false, true);
  }
};

// accesses

const accesses = (exports.accesses = require('./data/accesses'));

exports.resetAccesses = function (done, user, personalAccessToken, addToId) {
  const u = user || defaultUser;
  if (personalAccessToken) {
    accesses[0].token = personalAccessToken;
  }
  if (addToId) {
    const data = structuredClone(accesses);
    for (let i = 0; i < data.length; i++) {
      data[i].id += u.id;
    }
    resetMongoDBCollectionFor(storage.user.accesses, u, data, done);
    return;
  }
  resetMongoDBCollectionFor(storage.user.accesses, u, accesses, done);
};

// profile

const profile = (exports.profile = require('./data/profile'));

exports.resetProfile = function (done, user) {
  resetMongoDBCollectionFor(storage.user.profile, user || defaultUser, profile, done);
};

// followed slices

const followedSlicesURL = 'http://' +
    settings.http.ip +
    ':' +
    settings.http.port +
    '/' +
    users[0].username;

const followedSlices = (exports.followedSlices =
    require('./data/followedSlices')(followedSlicesURL));

exports.resetFollowedSlices = function (done, user) {
  resetMongoDBCollectionFor(storage.user.followedSlices, user || defaultUser, followedSlices, done);
};

// events

const events = (exports.events = require('./data/events'));
const dynCreateAttachmentIdMap = {}; // contains real ids of created attachment per event:
exports.dynCreateAttachmentIdMap = dynCreateAttachmentIdMap;

// add createdAttachmentsId to events
function addCorrectAttachmentIds (allEvents) {
  const allEventsCorrected = structuredClone(allEvents);
  for (const e of allEventsCorrected) {
    if (dynCreateAttachmentIdMap[e.id]) {
      e.attachments = dynCreateAttachmentIdMap[e.id];
    }
    integrity.events.set(e);
  }
  return allEventsCorrected;
}
exports.addCorrectAttachmentIds = addCorrectAttachmentIds;

exports.resetEvents = function resetEvents (done, user) {
  // deleteData(storage.user.events, user || defaultUser, events, done);
  user = user || defaultUser;
  const eventsToWrite = events.map((e) => {
    const eventToWrite = structuredClone(e);
    delete eventToWrite.tags;
    return eventToWrite;
  });
  let mall;
  async.series([
    async function removeNonAccountEvents () {
      mall = await getMall();
      await mall.events.localRemoveAllNonAccountEventsForUser(user.id);
    },
    async function createEvents () {
      for (const event of eventsToWrite) {
        const eventSource = structuredClone(event);
        if (eventSource.attachments != null && eventSource.attachments.length > 0) {
          const attachments = eventSource.attachments;
          delete eventSource.attachments;
          const attachmentItems = [];
          for (const file of attachments) {
            const filePath = path.resolve(__dirname, 'data/attachments/' + file.fileName);
            file.attachmentData = fs.createReadStream(filePath);
            attachmentItems.push(file);
          }
          const e = await mall.events.createWithAttachments(user.id, eventSource, attachmentItems);
          dynCreateAttachmentIdMap[event.id] = e.attachments;
        } else {
          await mall.events.create(user.id, eventSource, null, true);
        }
      }
    },
    function removeZerosDuration (done2) {
      events.forEach((e) => {
        if (e.duration === 0) { delete e.duration; }
      });
      done2();
    }
  ], done);
};

// streams

const streams = (exports.streams = require('./data/streams'));

exports.resetStreams = function (done, user) {
  const myUser = user || defaultUser;
  let mall = null;
  async function addStreams (arrayOfStreams) {
    for (const stream of arrayOfStreams) {
      const children = stream?.children || [];
      const streamData = structuredClone(stream);
      delete streamData.children;
      await mall.streams.create(myUser.id, streamData);
      await addStreams(children);
    }
  }
  async.series([
    async () => {
      mall = await getMall();
      await mall.streams.deleteAll(myUser.id, 'local');
      await addStreams(streams);
    }
  ], done);
};

/**
 * @returns {void}
 */
function resetMongoDBCollectionFor (storage, user, items, done) {
  async.series([
    storage.removeAll.bind(storage, user),
    storage.insertMany.bind(storage, user, items)
  ], done);
}

// attachments

/**
 * Source attachments directory path (!= server storage path)
 */
const testsAttachmentsDirPath = (exports.testsAttachmentsDirPath = path.join(__dirname, '/data/attachments/'));

const attachments = {
  document: getAttachmentInfo('document', 'document.pdf', 'application/pdf'),
  image: getAttachmentInfo('image', 'image (space and special chars)é__.png', 'image/png'),
  text: getAttachmentInfo('text', 'text.txt', 'text/plain')
};
exports.attachments = attachments;

// following https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity
// compute sri with openssl
// cat FILENAME.js | openssl dgst -sha384 -binary | openssl base64 -A
// replaces: 'sha256 ' + crypto.createHash('sha256').update(data).digest('hex');
/**
 * @returns {string}
 */
function getSubresourceIntegrity (filePath) {
  const algorithm = 'sha256';
  return (algorithm +
        '-' +
        childProcess.execSync(`cat "${filePath}" | openssl dgst -${algorithm} -binary | openssl base64 -A`));
}

/**
 * @returns {{ id: any; filename: any; path: any; data: any; size: any; type: any; integrity: string; }}
 */
function getAttachmentInfo (id, filename, type) {
  const filePath = path.join(testsAttachmentsDirPath, filename);
  const data = fs.readFileSync(filePath);
  const integrity = getSubresourceIntegrity(filePath);
  return {
    id,
    filename,
    path: filePath,
    data,
    size: data.length,
    type,
    integrity
  };
}

// data dump & restore (for testing data migration)

/**
 * Dumps test data into a `data` subfolder named after the provided version.
 * DB data is mongodumped, attachments data is tarballed.
 * The output folder will be overwritten if it already exists.
 *
 * @param {String} mongoFolder Path to MongoDB base folder
 * @param {Function} callback
 */
exports.dumpCurrent = function (mongoFolder, version, callback) {
  const mongodump = path.resolve(mongoFolder, 'bin/mongodump');
  const outputFolder = getDumpFolder(version);
  logger.info('Dumping current test data to ' + outputFolder);
  async.series([
    clearAllData,
    storage.versions.migrateIfNeeded.bind(storage.versions),
    exports.resetUsers,
    exports.resetAccesses,
    exports.resetProfile,
    exports.resetFollowedSlices,
    exports.resetStreams,
    exports.resetEvents,
    fs.rm.bind(null, outputFolder, { recursive: true, force: true }),
    childProcess.exec.bind(null, mongodump +
            (settings.database.authUser
              ? ' -u ' +
                    settings.database.authUser +
                    ' -p ' +
                    settings.database.authPassword
              : '') +
            ' --host ' +
            settings.database.host +
            ':' +
            settings.database.port +
            ' --db ' +
            settings.database.name +
            ' --out ' +
            getDumpDBSubfolder(outputFolder)),
    childProcess.exec.bind(null, 'tar -C ' +
            settings.eventFiles.attachmentsDirPath +
            ' -czf ' +
            getDumpFilesArchive(outputFolder) +
            ' .')
  ], function (err) {
    if (err) {
      return callback(err);
    }
    callback();
  });
};

/**
 *
 * @param {String} versionNum Must match an existing dumped version (e.g. "0.3.0")
 * @param {String} mongoFolder Path to MongoDB base folder
 * @param callback
 */
exports.restoreFromDump = function (versionNum, mongoFolder, callback) {
  const mongorestore = path.resolve(mongoFolder, 'bin/mongorestore');
  const sourceFolder = getDumpFolder(versionNum);
  const sourceDBFolder = getDumpDBSubfolder(sourceFolder);
  const sourceFilesArchive = getDumpFilesArchive(sourceFolder);
  logger.info('Restoring v' + versionNum + ' data from ' + sourceFolder);
  if (!fs.existsSync(sourceDBFolder) || !fs.existsSync(sourceFilesArchive)) {
    throw new Error('Missing source dump or part of it at ' + sourceFolder);
  }
  async.series([
    clearAllData,
    childProcess.exec.bind(null, mongorestore +
            ' --nsFrom "pryv-node.*" --nsTo "pryv-node-test.*" ' +
            (settings.database.authUser
              ? ' -u ' +
                    settings.database.authUser +
                    ' -p ' +
                    settings.database.authPassword
              : '') +
            ' --host ' +
            settings.database.host +
            ':' +
            settings.database.port +
            ' ' +
            sourceDBFolder),
    function (done) {
      mkdirp.sync(settings.eventFiles.attachmentsDirPath);
      done();
    },
    childProcess.exec.bind(null, 'tar -xzf ' +
            sourceFilesArchive +
            ' -C ' +
            settings.eventFiles.attachmentsDirPath)
  ], function (err) {
    if (err) {
      return callback(err);
    }
    logger.info('OK');
    callback();
  });
};

/**
 * Fetches the database structure for a given version
 *
 * @param {String} version
 * @returns {Object} structure
 */
exports.getStructure = function (version) {
  return require(path.join(__dirname, '/structure/', version));
};

/**
 * @returns {void}
 */
function clearAllData (callback) {
  deleteUsersDataDirectory();
  storage.database.dropDatabase(callback);
}

/**
 * @returns {any}
 */
function getDumpFolder (versionNum) {
  return path.resolve(__dirname, 'data/dumps', versionNum);
}

/**
 * @returns {any}
 */
function getDumpDBSubfolder (dumpFolder) {
  return path.resolve(dumpFolder, 'db');
}

/**
 * @returns {any}
 */
function getDumpFilesArchive (dumpFolder) {
  return path.resolve(dumpFolder, 'event-files.tar.gz');
}

/**
 * @returns {{}}
 */
function buildCustomAccountProperties () {
  const accountStreams = getConfigUnsafe(true).get('custom:systemStreams:account');
  if (accountStreams == null) { return {}; }
  const customProperties = {};
  accountStreams.forEach((stream) => {
    customProperties[SystemStreamsSerializer.removePrefixFromStreamId(stream.id)] = charlatan.Number.number(3);
  });
  return customProperties;
}

function deleteUsersDataDirectory () {
  const basePath = userLocalDirectory.getBasePath();
  fs.rmSync(basePath, { recursive: true, force: true });
}
