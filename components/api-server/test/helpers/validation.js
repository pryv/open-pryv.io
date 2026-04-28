/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Helper stuff for validating objects against schemas.
 */

const ErrorIds = require('errors').ErrorIds;
const Action = require('../../src/schema/Action');
const encryption = require('utils').encryption;
const { jsonValidator } = require('utils');
const validator = jsonValidator();
const assert = require('node:assert');
const util = require('util');
const _ = require('lodash');
const accountStreams = require('business/src/system-streams');
const { removeSystemEvents, removeSystemStreams, separateSystemEvents } = require('test-helpers/src/systemStreamFilters');
const { integrity } = require('business');

/**
 * Expose common JSON schemas.
 */
const schemas = exports.schemas = {
  access: require('../../src/schema/access'),
  event: require('../../src/schema/event'),
  stream: require('../../src/schema/stream'),
  user: require('../../src/schema/user'),
  errorResult: {
    type: 'object',
    additionalProperties: false,
    properties: {
      error: require('../../src/schema/methodError'),
      meta: { type: 'object' }
    },
    required: ['error', 'meta']
  }
};

/**
 * Checks the given response matches basic expectations.
 *
 * @param {Object} response
 * @param {Object} expected Properties (mandatory unless mentioned):
 *    - {Number} status
 *    - {Object} schema
 *    - {Function} sanitizeFn A data cleanup function to apply before checking response body
 *    - {String} sanitizeTarget The key of the response body property to apply the sanitize fn to
 *    - {Object} body Optional
 * @param {Function} [done] Optional
 */
exports.check = function (response, expected, done) {
  assert.ok(response, '"response" must be a valid HTTP response object');

  assert.strictEqual(response.statusCode, expected.status);

  // ignore common metadata
  const meta = response.body.meta;
  delete response.body.meta;

  if (expected.schema) {
    checkJSON(response, expected.schema);
  }
  // service info .. also expose an "access" property
  if (response.body.access != null && response.body.api == null) {
    checkAccessIntegrity(response.body.access);
  }
  if (response.body.event != null) {
    checkEventIntegrity(response.body.event);
  }
  if (response.body.events != null) {
    response.body.events.forEach(checkEventIntegrity);
  }
  if (response.body.eventDeletions != null) {
    response.body.eventDeletions.forEach(checkEventDeletionIntegrity);
  }

  if (expected.sanitizeFn) {
    assert.ok(expected.sanitizeTarget);
    expected.sanitizeFn(response.body[expected.sanitizeTarget]);
  }
  if (expected.body) {
    try {
      assert.deepStrictEqual(response.body, expected.body);
    } catch (e) {
      if (e.messgae) e.message = e.message.substr(0, 3000);
      throw (e);
    }
  }

  // restore ignored metadata
  response.body.meta = meta;

  if (done) { done(); }
};

function checkEventDeletionIntegrity (e) {
  // deletion integrity can be null
  if (e.intergity != null) checkEventIntegrity(e);
}

function checkEventIntegrity (e) {
  if (!integrity.events.isActive) return;
  const int = integrity.events.hash(e);
  if (e.integrity !== int) {
    throw (new Error('Received item with bad integrity checkum. \nexpected [' + int + '] \ngot: \n' + JSON.stringify(e, null, 2)));
  }
}

function checkAccessIntegrity (access) {
  if (!integrity.accesses.isActive) return;
  const int = integrity.accesses.hash(access);
  if (access.integrity !== int) {
    throw (new Error('Received item with bad integrity checkum. \nexpected [' + int + '] \ngot: \n' + JSON.stringify(access, null, 2)));
  }
}

/**
 * Specific check for errors.
 *
 * @param {Object} response
 * @param {Object} expected Must have `error` object with properties (mandatory unless mentioned):
 *    - {Number} status
 *    - {String} id
 *    - {Object} data Optional
 * @param {Function} [done] Optional
 */
exports.checkError = function (response, expected, done) {
  try {
    assert.strictEqual(response.statusCode, expected.status);
    checkJSON(response, schemas.errorResult);

    const error = response.body.error;
    assert.strictEqual(error.id, expected.id);

    if (expected.data != null) {
      assert.deepStrictEqual(error.data, expected.data);
    }
    if (done) done();
  } catch (e) {
    if (done) return done(e);
    throw (e);
  }
};

function checkJSON (response, schema) {
  assert.ok(response.headers['content-type'].includes('application/json'));
  checkSchema(response.body, schema);
}

/**
 * Checks the given data against the given JSON schema.
 *
 * @param data
 * @param {Object} schema
 */
function checkSchema (data, schema) {
  assert.strictEqual(validator.validate(data, schema), true,
    util.inspect(validator.getLastErrors(), { depth: 5 }));
}
exports.checkSchema = checkSchema;

/**
 * Checks the given item against its 'STORE' schema identified by the given name.
 *
 * @param {Object} item
 * @param {String} schemaName
 */
exports.checkStoredItem = function (item, schemaName) {
  checkSchema(item, schemas[schemaName](Action.STORE));
};

function checkMeta (parentObject) {
  assert.ok(parentObject.meta);

  const meta = parentObject.meta;

  assert.match(meta.apiVersion, /^\d+\.\d+\.\d+/);
  assert.match(meta.serverTime + '', /^\d+\.?\d*$/);
  assert.ok(meta.serial);
}
exports.checkMeta = checkMeta;

/**
 * Specific error check for convenience.
 */
exports.checkErrorInvalidParams = function (res, done) {
  assert.strictEqual(res.statusCode, 400);

  checkJSON(res, schemas.errorResult);
  const body = res.body;
  const error = body.error;

  assert.ok(error);
  assert.strictEqual(error.id, ErrorIds.InvalidParametersFormat);
  assert.ok(res.body.error.data); // expect validation errors

  if (done) done();
};

/**
 * Specific error check for convenience.
 */
exports.checkErrorInvalidAccess = function (res, done) {
  assert.strictEqual(res.statusCode, 401);

  checkJSON(res, schemas.errorResult);
  assert.strictEqual(res.body.error.id, ErrorIds.InvalidAccessToken);

  if (done) done();
};

/**
 * Specific error check for convenience.
 */
exports.checkErrorForbidden = function (res, done) {
  assert.strictEqual(res.statusCode, 403);
  checkJSON(res, schemas.errorResult);
  assert.strictEqual(res.body.error.id, ErrorIds.Forbidden);

  if (done) done();
};

/**
 * Specific error check for convenience.
 */
exports.checkErrorUnknown = function (res, done) {
  assert.strictEqual(res.statusCode, 404);

  checkJSON(res, schemas.errorResult);
  assert.strictEqual(res.body.error.id, ErrorIds.UnknownResource);

  if (done) done();
};

/**
 * Checks equality between the given objects, allowing for a slight difference in `created` and
 * `modified` times.
 * If `expected` has no change tracking properties, those in `actual` are ignored in the check
 * (warning: removes tracking properties from `actual`).
 * Recurses to sub-objects in `children` if defined (warning: removes `children` properties from
 * `actual` and `expected` if not empty).
 */
exports.checkObjectEquality = checkObjectEquality;
function checkObjectEquality (actual, expected, verifiedProps = []) {
  let isApprox = false;
  if (expected.created) {
    checkApproxTimeEquality(actual.created, expected.created);
    isApprox = isApprox || actual.created !== expected.created;
  }
  verifiedProps.push('created');

  if (!expected.createdBy) {
    verifiedProps.push('createdBy');
  }

  if (expected.modified) {
    checkApproxTimeEquality(actual.modified, expected.modified);
    isApprox = isApprox || actual.modified !== expected.modified;
  }
  verifiedProps.push('modified');

  if (expected.deleted) {
    checkApproxTimeEquality(actual.deleted, expected.deleted);
    isApprox = isApprox || actual.deleted !== expected.deleted;
  }
  verifiedProps.push('deleted');

  if (!expected.modifiedBy) {
    verifiedProps.push('modifiedBy');
  }

  if (expected.children != null) {
    assert.ok(actual.children);
    assert.strictEqual(actual.children.length, expected.children.length);

    for (let i = 0, n = expected.children.length; i < n; i++) {
      const subApprox = checkObjectEquality(actual.children[i], expected.children[i]);
      isApprox = isApprox || subApprox;
    }
  }
  verifiedProps.push('children');

  if (expected.attachments != null) {
    assert.ok(actual.attachments);

    assert.strictEqual(actual.attachments.length, expected.attachments.length,
      `Must have ${expected.attachments.length} attachments.`);

    const expectMap = new Map();
    for (const ex of expected.attachments) { expectMap.set(ex.id, ex); }

    for (const act of actual.attachments) {
      const ex = expectMap.get(act.id);
      assert.ok(ex != null);

      checkObjectEquality(act, ex);
    }
  }
  verifiedProps.push('attachments');

  // Integrity cannot be checked when "approximate results"
  if (isApprox) verifiedProps.push('integrity');

  const remaining = _.omit(actual, verifiedProps);
  const expectedRemaining = _.omit(expected, verifiedProps);
  assert.deepStrictEqual(remaining, expectedRemaining);
  return isApprox; // (forward to eventual recursive calls)
}

function checkApproxTimeEquality (actual, expected, epsilon = 2) {
  const diff = (expected - actual);
  assert.ok(Math.abs(diff) < epsilon);
}

/**
 * @param response
 * @param {Array} expectedHeaders Each item must have name and value properties.
 */
exports.checkHeaders = function (response, expectedHeaders) {
  expectedHeaders.forEach(function (expected) {
    const value = response.headers[expected.name.toLowerCase()];
    assert.ok(value);
    if (expected.value) {
      assert.strictEqual(value, expected.value);
    }
    if (expected.valueRegExp) {
      assert.match(value, expected.valueRegExp);
    }
  });
};

/**
 * Checks file read token validity for the event(s)' attachments.
 *
 * @param {Object|Array} eventOrEvents
 * @param access
 * @param secret
 */
exports.checkFilesReadToken = function (eventOrEvents, access, secret) {
  if (Array.isArray(eventOrEvents)) {
    eventOrEvents.forEach(checkEvent);
  } else {
    checkEvent(eventOrEvents);
  }

  function checkEvent (evt) {
    if (!evt.attachments) { return; }

    evt.attachments.forEach(function (att) {
      assert.strictEqual(att.readToken, encryption.fileReadToken(att.id, access.id, access.token, secret));
    });
  }
};

/**
 * Strips off per-client read-only properties such as `attachments[].readToken`.
 * Does nothing if no event is passed.
 *
 * @param {Object} event
 */
exports.sanitizeEvent = function (event) {
  if (!event) { return; }

  if (event.attachments) {
    event.attachments.forEach(function (att) {
      delete att.readToken;
    });
  }

  return event;
};

/**
 * Array counterpart of `sanitizeEvent`.
 *
 * @param {Array} events
 */
exports.sanitizeEvents = function (events) {
  if (!events) { return; }

  events.forEach(exports.sanitizeEvent);
  return events;
};

/**
 * Strips off items deletions from the given array.
 *
 * @param {Array} items
 * @returns {Array}
 */
exports.removeDeletions = function (items) {
  return items.filter(function (e) { return !e.deleted; });
};

/**
 * Strips off items deletions and history from the given array
 *
 * @param {Array} items
 * @returns {Array}
 */
exports.removeDeletionsAndHistory = function (items) {
  return items.filter(function (e) { return !(e.deleted || e.headId); });
};

exports.removeAccountStreamsEvents = function (items) {
  return removeSystemEvents(items);
};

exports.separateAccountStreamsAndOtherEvents = function (items) {
  const { events, systemEvents } = separateSystemEvents(items);
  return { events, accountStreamsEvents: systemEvents };
};

exports.removeAccountStreams = function (streams) {
  return removeSystemStreams(streams);
};

// TODO: cleanup this mess, we shouldn't have data creation logic in "validation", nor these `require()` mid-file
exports.addStoreStreams = async function (streams, storesId, atTheEnd) {
  const { getMall } = require('mall');
  const streamsUtils = require('mall/src/helpers/streamsUtils');

  // -- ADD stores
  const mall = await getMall();
  for (const storeDescription of [...mall.storeDescriptionsByStore.values()].reverse()) {
    if (isShown(storeDescription.id)) {
      const stream = streamsUtils.createStoreRootStream(storeDescription, {
        children: [],
        childrenHidden: true // To be discussed
      });
      if (atTheEnd) {
        streams.push(stream);
      } else {
        streams.unshift(stream);
      }
    }
  }
  return streams;

  function isShown (storeId) {
    const storeDataUtils = require('mall/src/helpers/storeDataUtils');
    // Passthrough stores (local, account) don't have pseudo-root streams
    if (storeDataUtils.isPassthroughStore(storeId)) return false;
    if (storesId == null) return true;
    return storesId.includes(storeId);
  }
};

/*
 * Strips off item from tracking properties
 */
exports.removeTrackingPropertiesForOne = function (item) {
  if (item == null) return;
  delete item.created;
  delete item.createdBy;
  delete item.modified;
  delete item.modifiedBy;
  return item;
};

/**
 * Strips off items from tracking properties
 */
exports.removeTrackingProperties = function (items) {
  items.forEach(exports.removeTrackingPropertiesForOne);
  return items;
};

/**
 * Checks that:
 * - all account events are present
 * - they have "unique" streamId when needed
 * - they have correct type
 */
exports.validateAccountEvents = function (actualAccountEvents) {
  // get streams ids from the config that should be retrieved

  const expectedAccountStreams = Object.fromEntries(Object.entries(accountStreams.accountMap).filter(([, s]) => s.isShown));
  delete expectedAccountStreams[':_system:storageUsed'];
  // iterate through expected account events and check that they exists in actual
  // account events
  const expectedSreamIds = Object.keys(expectedAccountStreams);
  expectedSreamIds.forEach(streamId => {
    let foundEvent = false;
    actualAccountEvents.forEach(event => {
      if (event.streamIds.includes(streamId)) {
        foundEvent = true;
        // validate type
        assert.strictEqual(event.type, expectedAccountStreams[streamId].type, `type mismatch between ${event} and ${expectedAccountStreams[streamId]}`);
      }
    });
    assert.strictEqual(foundEvent, true, `account event ${streamId} not found.`);
  });
};
