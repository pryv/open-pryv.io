/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = require('path').dirname(__filename);

/**
 * Regroups shared test data and related  helper functions.
 */

const childProcess = require('child_process');

const dependenciesMod = require('./dependencies.ts');
const dependencies = dependenciesMod.default ?? dependenciesMod;
const settings = dependencies.settings;
const storage = dependencies.storage;
const fs = require('fs');
const path = require('path');
const { deepMerge } = require('utils');
const accountStreams = require('business/src/system-streams/index.ts');
const { getUsersRepository, User } = require('business/src/users/index.ts');
const { userLocalDirectory } = require('storage');
const charlatan = require('charlatan');
const { getConfigUnsafe, getConfig, getLogger } = require('@pryv/boiler');
const { getMall } = require('mall');
const logger = getLogger('test-helpers:data');
const { integrity } = require('business');

// users

const users = require('./data/users.ts').default;
export { users };
const defaultUser = users[0];

export const resetUsers = async () => {
  logger.debug('resetUsers');
  await getConfig(); // lock up to the time config is ready
  await accountStreams.init();
  const customAccountProperties = buildCustomAccountProperties();
  const usersRepository = await getUsersRepository();
  await usersRepository.deleteAll();
  for (const user of users) {
    const userObj = new User(deepMerge(customAccountProperties, user)); // might alter storage "dump data" script
    await usersRepository.insertOne(userObj, false, true);
  }
};

// accesses

const accesses = require('./data/accesses.ts').default;
export { accesses };

export const resetAccesses = function (done: any, user: any, personalAccessToken: any, addToId: any) {
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

const profile = require('./data/profile.ts').default;
export { profile };

export const resetProfile = function (done: any, user: any) {
  resetMongoDBCollectionFor(storage.user.profile, user || defaultUser, profile, done);
};

// events

const events = require('./data/events.ts').default;
const { ensureIntegrity: ensureEventsIntegrity } = require('./data/events.ts');
export { events };
const dynCreateAttachmentIdMap: any = {}; // contains real ids of created attachment per event:
export { dynCreateAttachmentIdMap };

// add createdAttachmentsId to events
function addCorrectAttachmentIds (allEvents: any) {
  const allEventsCorrected = structuredClone(allEvents);
  for (const e of allEventsCorrected) {
    if (dynCreateAttachmentIdMap[e.id]) {
      e.attachments = dynCreateAttachmentIdMap[e.id];
    }
    integrity.events.set(e);
  }
  return allEventsCorrected;
}
export { addCorrectAttachmentIds };

export const resetEvents = function resetEvents (done: any, user: any) {
  // deleteData(storage.user.events, user || defaultUser, events, done);
  user = user || defaultUser;
  // Lazy-attach integrity to fixture events — the static .map() at
  // data/events.ts module-load no longer does this (post-Plan-57 8a-ii)
  // because integrity computation needs post-boiler-init algorithm.
  ensureEventsIntegrity();
  const eventsToWrite = events.map((e: any) => structuredClone(e));
  (async () => {
    try {
      const mall = await getMall();
      await mall.events.localRemoveAllNonAccountEventsForUser(user.id);
      for (const event of eventsToWrite) {
        const eventSource = structuredClone(event);
        if (eventSource.attachments != null && eventSource.attachments.length > 0) {
          const attachments = eventSource.attachments;
          delete eventSource.attachments;
          const attachmentItems: any[] = [];
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
      events.forEach((e: any) => {
        if (e.duration === 0) { delete e.duration; }
      });
      done();
    } catch (err) {
      done(err);
    }
  })();
};

// streams

const streams = require('./data/streams.ts').default;
export { streams };

export const resetStreams = function (done: any, user: any) {
  const myUser = user || defaultUser;
  let mall: any = null;
  async function addStreams (arrayOfStreams: any) {
    for (const stream of arrayOfStreams) {
      const children = stream?.children || [];
      const streamData = structuredClone(stream);
      delete streamData.children;
      await mall.streams.create(myUser.id, streamData);
      await addStreams(children);
    }
  }
  (async () => {
    try {
      mall = await getMall();
      await mall.streams.deleteAll(myUser.id, 'local');
      await addStreams(streams);
      done();
    } catch (err) {
      done(err);
    }
  })();
};

function resetMongoDBCollectionFor (storage: any, user: any, items: any, done: any) {
  storage.removeAll(user, function (err: any) {
    if (err) return done(err);
    storage.insertMany(user, items, done);
  });
}

// attachments

/**
 * Source attachments directory path (!= server storage path)
 */
const testsAttachmentsDirPath = path.join(__dirname, '/data/attachments/');
export { testsAttachmentsDirPath };

const attachments = {
  document: getAttachmentInfo('document', 'document.pdf', 'application/pdf'),
  image: getAttachmentInfo('image', 'image (space and special chars)é__.png', 'image/png'),
  text: getAttachmentInfo('text', 'text.txt', 'text/plain')
};
export { attachments };

// following https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity
// compute sri with openssl
// cat FILENAME.js | openssl dgst -sha384 -binary | openssl base64 -A
// replaces: 'sha256 ' + crypto.createHash('sha256').update(data).digest('hex');
function getSubresourceIntegrity (filePath: any) {
  const algorithm = 'sha256';
  return (algorithm +
        '-' +
        childProcess.execSync(`cat "${filePath}" | openssl dgst -${algorithm} -binary | openssl base64 -A`));
}

function getAttachmentInfo (id: any, filename: any, type: any) {
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

/**
 * Fetches the database structure for a given version
 *
 */
export const getStructure = function (version: any) {
  return require(path.join(__dirname, '/structure/', version));
};

function buildCustomAccountProperties () {
  const customStreams = getConfigUnsafe(true).get('custom:systemStreams:account');
  if (customStreams == null) { return {}; }
  const customProperties: any = {};
  customStreams.forEach((stream: any) => {
    customProperties[accountStreams.toFieldName(stream.id)] = charlatan.Number.number(3);
  });
  return customProperties;
}

function deleteUsersDataDirectory () {
  const basePath = userLocalDirectory.getBasePath();
  fs.rmSync(basePath, { recursive: true, force: true });
}
