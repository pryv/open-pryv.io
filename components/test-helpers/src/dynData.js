/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Dynamic test data generator.
 * Creates test datasets with unique IDs to enable parallel test execution.
 * Each instance has isolated data that doesn't conflict with other instances.
 */

const cuid = require('cuid');
const path = require('path');
const fs = require('fs');
const { deepMerge } = require('utils');
const { integrity } = require('business');

// Static data templates
const staticUsers = require('./data/users');
const staticAccesses = require('./data/accesses');
const staticStreams = require('./data/streams');
const staticEvents = require('./data/events');
const staticProfile = require('./data/profile');

/**
 * Creates a new dynamic data instance with unique IDs.
 * @param {Object} options
 * @param {string} [options.prefix] - Prefix for generated IDs (default: cuid())
 * @returns {DynData}
 */
function createDynData (options = {}) {
  const prefix = options.prefix || cuid().slice(0, 8);

  // ID mapping: original ID -> dynamic ID
  const idMap = new Map();

  /**
   * Generate a dynamic ID from a static ID
   */
  function dynId (staticId) {
    if (!staticId) return staticId;
    if (idMap.has(staticId)) return idMap.get(staticId);

    const newId = `${staticId}_${prefix}`;
    idMap.set(staticId, newId);
    return newId;
  }

  /**
   * Generate a cuid-like event id with prefix.
   * Must match pattern ^c[a-z0-9-]{24}$ (exactly 25 chars starting with 'c')
   * Format: c(1) + prefix(5) + 'testeventnum'(12) + number(7) = 25 chars
   */
  function getTestEventId (n) {
    n = n + '';
    const paddedNumber = n.length >= 7 ? n : new Array(7 - n.length + 1).join('0') + n;
    // Ensure prefix is 5 lowercase alphanumeric chars (to distinguish test1 vs test2)
    const shortPrefix = prefix.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 5).padEnd(5, 'x');
    return `c${shortPrefix}testeventnum${paddedNumber}`;
  }

  // Generate dynamic users
  // Username pattern: ^[a-z0-9][a-z0-9-]{3,58}[a-z0-9]$ - use hyphen, not underscore
  const users = staticUsers.map(user => {
    const dynUser = structuredClone(user);
    dynUser.id = dynId(user.id);
    dynUser.username = `${user.username}-${prefix}`;
    dynUser.email = `${prefix}_${user.email}`;
    return dynUser;
  });

  const defaultUser = users[0];

  // Generate dynamic streams (recursive for children)
  function generateDynStreams (staticStreamList, parentDynId = null) {
    return staticStreamList.map(stream => {
      const dynStream = structuredClone(stream);
      dynStream.id = dynId(stream.id);
      if (stream.parentId) {
        dynStream.parentId = dynId(stream.parentId);
      } else if (parentDynId) {
        dynStream.parentId = parentDynId;
      }
      if (stream.children && stream.children.length > 0) {
        dynStream.children = generateDynStreams(stream.children, dynStream.id);
      }
      return dynStream;
    });
  }

  const streams = generateDynStreams(staticStreams);

  // Flatten streams for easier access
  function flattenStreams (streamList) {
    const result = [];
    for (const stream of streamList) {
      const flatStream = { ...stream };
      delete flatStream.children;
      result.push(flatStream);
      if (stream.children && stream.children.length > 0) {
        result.push(...flattenStreams(stream.children));
      }
    }
    return result;
  }

  // Generate dynamic accesses
  const accesses = staticAccesses.map(access => {
    const dynAccess = structuredClone(access);
    dynAccess.id = dynId(access.id);
    dynAccess.token = `${access.token}_${prefix}`;
    dynAccess.apiEndpoint = dynAccess.apiEndpoint.replace(access.token, dynAccess.token);
    dynAccess.apiEndpoint = dynAccess.apiEndpoint.replace(staticUsers[0].username, users[0].username);

    // Update permissions to reference dynamic stream IDs
    if (dynAccess.permissions) {
      dynAccess.permissions = dynAccess.permissions.map(perm => ({
        ...perm,
        streamId: perm.streamId === '*' ? '*' : dynId(perm.streamId)
      }));
    }
    return dynAccess;
  });

  // Generate dynamic events
  const events = [];

  // Map event headId indices to new event IDs
  // headIdx: original event index that this event's headId points to
  const headIdMapping = {
    17: 16, // e_17 headId -> e_16
    18: 16, // e_18 headId -> e_16
    20: 19, // e_20 headId -> e_19
    21: 19, // e_21 headId -> e_19
    26: 25 // e_26 headId -> e_25
  };

  // Generate events with proper references
  for (let i = 0; i < staticEvents.length; i++) {
    const staticEvent = staticEvents[i];
    const dynEvent = structuredClone(staticEvent);
    dynEvent.id = getTestEventId(i);

    // Map streamIds
    if (dynEvent.streamIds) {
      dynEvent.streamIds = dynEvent.streamIds.map(sid => dynId(sid));
    }

    // Map headId for history events
    if (staticEvent.headId && headIdMapping[i] !== undefined) {
      dynEvent.headId = getTestEventId(headIdMapping[i]);
    }

    // Always recalculate integrity for all events
    // For history events, temporarily use headId as id for integrity calculation
    let origId = null;
    if (dynEvent.headId) {
      origId = dynEvent.id;
      dynEvent.id = dynEvent.headId;
      delete dynEvent.headId;
    }
    integrity.events.set(dynEvent, false);
    if (origId) {
      dynEvent.headId = dynEvent.id;
      dynEvent.id = origId;
    }

    events.push(dynEvent);
  }

  // Generate dynamic profile
  const profile = staticProfile.map(p => {
    const dynProfile = structuredClone(p);
    // Profile IDs are special: 'public', 'private', and app name
    if (p.id !== 'public' && p.id !== 'private') {
      dynProfile.id = accesses[4].name;
    }
    return dynProfile;
  });

  // Attachments are static (files on disk)
  const testsAttachmentsDirPath = path.join(__dirname, '/data/attachments/');
  const attachments = {
    document: getAttachmentInfo('document', 'document.pdf', 'application/pdf'),
    image: getAttachmentInfo('image', 'image (space and special chars)é__.png', 'image/png'),
    text: getAttachmentInfo('text', 'text.txt', 'text/plain')
  };

  function getAttachmentInfo (id, filename, type) {
    const filePath = path.join(testsAttachmentsDirPath, filename);
    const data = fs.readFileSync(filePath);
    const algorithm = 'sha256';
    const { execSync } = require('child_process');
    const integrityHash = algorithm + '-' +
      execSync(`cat "${filePath}" | openssl dgst -${algorithm} -binary | openssl base64 -A`);
    return {
      id,
      filename,
      path: filePath,
      data,
      size: data.length,
      type,
      integrity: integrityHash
    };
  }

  // Track created attachment IDs for events
  const dynCreateAttachmentIdMap = {};

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

  // ========== Reset Functions (No dropCollection!) ==========

  let dependencies = null;
  let mall = null;

  async function ensureDependencies () {
    if (!dependencies) {
      dependencies = require('./dependencies');
    }
    if (!mall) {
      const { getMall } = require('mall');
      mall = await getMall();
    }
  }

  /**
   * Reset users - delete and recreate
   */
  async function resetUsers () {
    await ensureDependencies();
    const { getUsersRepository, User } = require('business/src/users');
    const accountStreams = require('business/src/system-streams');
    const { getConfig, getConfigUnsafe } = require('@pryv/boiler');

    await getConfig();
    await accountStreams.init();

    const usersRepository = await getUsersRepository();

    // Delete users created by this instance
    for (const user of users) {
      try {
        await usersRepository.deleteOne(user.id, user.username, true);
      } catch (e) {
        // User might not exist, ignore
      }
    }

    // Build custom account properties
    const customStreams = getConfigUnsafe(true).get('custom:systemStreams:account');
    const customProperties = {};
    if (customStreams) {
      const charlatan = require('charlatan');
      customStreams.forEach((stream) => {
        customProperties[accountStreams.toFieldName(stream.id)] = charlatan.Number.number(3);
      });
    }

    // Recreate users
    for (const user of users) {
      const userObj = new User(deepMerge(customProperties, user));
      await usersRepository.insertOne(userObj, false, true);
    }
  }

  /**
   * Reset accesses - delete by ID and recreate
   */
  async function resetAccesses (done, user, personalAccessToken, addToId) {
    await ensureDependencies();
    const storage = dependencies.storage.user.accesses;
    const u = user || defaultUser;

    const accessesToUse = structuredClone(accesses);
    if (personalAccessToken) {
      accessesToUse[0].token = personalAccessToken;
    }
    if (addToId) {
      for (let i = 0; i < accessesToUse.length; i++) {
        accessesToUse[i].id += u.id;
      }
    }

    // Delete accesses by ID (using removeOne with query)
    for (const access of accessesToUse) {
      await new Promise(resolve => {
        storage.removeOne(u, { id: access.id }, () => resolve());
      });
    }

    // Insert new accesses
    await new Promise((resolve, reject) => {
      storage.insertMany(u, accessesToUse, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (done) done();
  }

  /**
   * Reset profile - delete and recreate
   */
  async function resetProfile (done, user) {
    await ensureDependencies();
    const storage = dependencies.storage.user.profile;
    const u = user || defaultUser;

    // Remove all profile entries
    await new Promise(resolve => {
      storage.removeAll(u, () => resolve());
    });

    // Insert profile data
    await new Promise((resolve, reject) => {
      storage.insertMany(u, profile, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (done) done();
  }

  /**
   * Reset streams - delete all and recreate using mall
   * Supports both callback and Promise patterns
   */
  function resetStreams (done, user) {
    const u = user || defaultUser;

    async function addStreams (arrayOfStreams) {
      for (const stream of arrayOfStreams) {
        const children = stream?.children || [];
        const streamData = structuredClone(stream);
        delete streamData.children;
        await mall.streams.create(u.id, streamData);
        await addStreams(children);
      }
    }

    const promise = (async () => {
      await ensureDependencies();
      // Delete all local streams for this user
      await mall.streams.deleteAll(u.id, 'local');
      await addStreams(streams);
    })();

    if (typeof done === 'function') {
      // Callback mode - don't return Promise
      promise.then(() => done()).catch(done);
    } else {
      // Promise mode - return the Promise
      return promise;
    }
  }

  /**
   * Reset events - delete and recreate using mall
   * Supports both callback and Promise patterns
   */
  function resetEvents (done, user) {
    const u = user || defaultUser;

    const eventsToWrite = events.map((e) => structuredClone(e));

    const promise = (async () => {
      await ensureDependencies();

      // Remove all non-account events
      await mall.events.localRemoveAllNonAccountEventsForUser(u.id);

      // Create events
      for (const event of eventsToWrite) {
        const eventSource = structuredClone(event);
        if (eventSource.attachments != null && eventSource.attachments.length > 0) {
          const attachmentsList = eventSource.attachments;
          delete eventSource.attachments;
          const attachmentItems = [];
          for (const file of attachmentsList) {
            const filePath = path.resolve(__dirname, 'data/attachments/' + file.fileName);
            file.attachmentData = fs.createReadStream(filePath);
            attachmentItems.push(file);
          }
          const e = await mall.events.createWithAttachments(u.id, eventSource, attachmentItems);
          dynCreateAttachmentIdMap[event.id] = e.attachments;
        } else {
          await mall.events.create(u.id, eventSource, null, true);
        }
      }

      // Clean up zero durations
      events.forEach((e) => {
        if (e.duration === 0) { delete e.duration; }
      });
    })();

    if (typeof done === 'function') {
      // Callback mode - don't return Promise
      promise.then(() => done()).catch(done);
    } else {
      // Promise mode - return the Promise
      return promise;
    }
  }

  /**
   * Cleanup all data created by this instance
   */
  async function cleanup () {
    await ensureDependencies();
    const { getUsersRepository } = require('business/src/users');
    const usersRepository = await getUsersRepository();

    // Delete users (cascades to other data)
    for (const user of users) {
      try {
        await usersRepository.deleteOne(user.id, user.username, true);
      } catch (e) {
        // Ignore errors
      }
    }
  }

  // Return the dynData instance
  return {
    // Data arrays
    users,
    accesses,
    streams,
    events,
    profile,
    attachments,
    testsAttachmentsDirPath,

    // Helper functions
    addCorrectAttachmentIds,
    dynCreateAttachmentIdMap,
    flattenStreams: () => flattenStreams(streams),

    // Reset functions
    resetUsers,
    resetAccesses,
    resetProfile,
    resetStreams,
    resetEvents,

    // Cleanup
    cleanup,

    // Prefix for debugging
    prefix,

    // ID mapping helper
    dynId
  };
}

module.exports = createDynData;
