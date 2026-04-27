/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

'use strict';

const treeUtils = require('utils/src/treeUtils');
const validation = require('api-server/src/schema/validation');
const systemStreamSchema = require('./systemStreamSchema');

const { defaults: dataStoreDefaults } = require('@pryv/datastore');

const DEFAULT = 'default';

const PRYV_PREFIX = ':_system:';
const CUSTOMER_PREFIX = ':system:';

const DEFAULT_VALUES_FOR_FIELDS = {
  isIndexed: false,
  isUnique: false,
  isShown: true,
  isEditable: true,
  isRequiredInValidation: false,
  created: dataStoreDefaults.UnknownDate,
  modified: dataStoreDefaults.UnknownDate,
  createdBy: dataStoreDefaults.SystemAccessId,
  modifiedBy: dataStoreDefaults.SystemAccessId
};

/**
 * Fetches "systemStreams" and "custom:systemStreams" from the config provided in parameter
 * Applies the following:
 * - default values
 * - sets default account
 * - children and parentId values
 * Stores the result in "systemStreams"
 * @param {{}} config
 * @returns {{}}
 */
function load (config) {
  // default system streams that should be not changed
  let defaultAccountStreams = [
    {
      id: 'account',
      name: 'Account',
      type: 'none/none',
      children: [
        {
          id: 'language',
          name: 'Language',
          type: 'language/iso-639-1',
          [DEFAULT]: 'en',
          isIndexed: true
        },
        {
          id: 'appId',
          name: 'appId',
          type: 'identifier/string',
          [DEFAULT]: '',
          isIndexed: true,
          isRequiredInValidation: true,
          isShown: false,
          isEditable: false
        },
        {
          id: 'invitationToken',
          name: 'Invitation Token',
          type: 'token/string',
          [DEFAULT]: 'no-token',
          isIndexed: true,
          isShown: false,
          isEditable: false
        },
        {
          id: 'referer',
          name: 'Referer',
          type: 'identifier/string',
          [DEFAULT]: null,
          isIndexed: true,
          isShown: false,
          isEditable: false
        },
        {
          id: 'storageUsed',
          name: 'Storage used',
          type: 'data-quantity/b',
          children: [
            {
              id: 'dbDocuments',
              name: 'Db Documents',
              type: 'data-quantity/b',
              [DEFAULT]: 0,
              isEditable: false
            },
            {
              id: 'attachedFiles',
              name: 'Attached files',
              type: 'data-quantity/b',
              [DEFAULT]: 0,
              isEditable: false
            }
          ]
        }
      ]
    }
  ];
  defaultAccountStreams = extendSystemStreamsWithDefaultValues(defaultAccountStreams);
  defaultAccountStreams = ensurePrefixForStreamIds(defaultAccountStreams);

  let customAccountStreams = config.get('custom:systemStreams:account');
  if (customAccountStreams == null) { customAccountStreams = []; }
  customAccountStreams =
        extendSystemStreamsWithDefaultValues(customAccountStreams);
  customAccountStreams = ensurePrefixForStreamIds(customAccountStreams, CUSTOMER_PREFIX);

  defaultAccountStreams[0].children =
        defaultAccountStreams[0].children.concat(customAccountStreams);
  const fullAccountStreams = defaultAccountStreams; // for readability

  let otherCustomStreams = config.get('custom:systemStreams:other');
  if (otherCustomStreams == null) { otherCustomStreams = []; }
  otherCustomStreams = extendSystemStreamsWithDefaultValues(otherCustomStreams);
  otherCustomStreams = ensurePrefixForStreamIds(otherCustomStreams, CUSTOMER_PREFIX);
  treeUtils.cloneAndApply(otherCustomStreams, (s) => {
    // ugly reuse of treeUtils.cloneAndApply() because we don't modify the array
    validateOtherStreams(s);
    return s;
  });

  let systemStreams = fullAccountStreams
    .concat(otherCustomStreams);
  systemStreams = addParentIdAndChildren(systemStreams);

  let seen = new Map();
  let seenWithPrefix = new Map();

  treeUtils.cloneAndApply(systemStreams, (s) => {
    // ugly reuse of treeUtils.cloneAndApply() because we don't modify the array
    validateSystemStreamWithSchema(s);
    [seen, seenWithPrefix] = throwIfNotUnique(seen, seenWithPrefix, s.id);
    return s;
  });

  config.set('systemStreams', systemStreams);

  return config;
}
module.exports.load = load;

/**
 * @param {Array<SystemStream>} streams
 * @returns {any[]}
 */
function addParentIdAndChildren (streams) {
  for (let stream of streams) {
    stream = addParentIdToChildren(stream);
    stream.parentId = null;
  }
  return streams;

  function addParentIdToChildren (stream) {
    if (stream.children == null) {
      stream.children = [];
      return stream;
    }
    stream.children.forEach((childStream) => {
      childStream.parentId = stream.id;
      childStream = addParentIdToChildren(childStream);
    });
    return stream;
  }
}

/**
 * Extend system stream properties with default values
 * @param {Array<SystemStream>} streams  undefined
 * @returns {any[]}
 */
function extendSystemStreamsWithDefaultValues (streams) {
  return treeUtils.cloneAndApply(streams, (s) => {
    const stream = Object.assign({}, DEFAULT_VALUES_FOR_FIELDS, s);
    if (stream.name == null) {
      stream.name = stream.id;
    }
    return stream;
  });
}

/**
 * Adds the prefix to each "id" property of the provided system streams array.
 *
 * @param {Array<SystemStream>} systemStreams  array of system streams
 * @param {string} prefix  the prefix to add
 * @returns {any[]}
 */
function ensurePrefixForStreamIds (systemStreams, prefix = PRYV_PREFIX) {
  return treeUtils.cloneAndApply(systemStreams, (s) => Object.assign({}, s, { id: _addPrefixToStreamId(s.id, prefix) }));
  function _addPrefixToStreamId (streamId, prefix) {
    if (streamId.startsWith(prefix)) { return streamId; }
    return prefix + streamId;
  }
}

/**
 * @param {SystemStream} systemStream
 * @returns {void}
 */
function validateSystemStreamWithSchema (systemStream) {
  validation.validate(systemStream, systemStreamSchema, function (err) {
    if (err) {
      throw err;
    }
  });
  throwIfUniqueAndNotIndexed(systemStream);
  function throwIfUniqueAndNotIndexed (systemStream) {
    if (systemStream.isUnique && !systemStream.isIndexed) {
      throw new Error('Config error: custom system stream cannot be unique and not indexed. Stream: ' +
                JSON.stringify(systemStream, null, 2));
    }
  }
}

/**
 * @param {SystemStream} systemStream
 * @returns {void}
 */
function validateOtherStreams (systemStream) {
  throwIfUnique(systemStream);
  throwIfIndexed(systemStream);
  throwIfNonEditable(systemStream);
  throwIfRequiredAtRegistration(systemStream);
  throwIfNonVisible(systemStream);

  function throwIfUnique (systemStream) {
    if (systemStream.isUnique) {
      throw new Error('Config error: custom "other" system stream cannot be unique. Only "account" streams can be unique. Stream: ' +
                JSON.stringify(systemStream, null, 2));
    }
  }
  function throwIfIndexed (systemStream) {
    if (systemStream.isIndexed) {
      throw new Error('Config error: custom "other" system stream cannot be indexed. Only "account" streams can be indexed. Stream: ' +
                JSON.stringify(systemStream, null, 2));
    }
  }
  function throwIfNonEditable (systemStream) {
    if (!systemStream.isEditable) {
      throw new Error('Config error: custom "other" system stream cannot be non-editable. Only "account" streams can be non-editable. Stream: ' +
                JSON.stringify(systemStream, null, 2));
    }
  }
  function throwIfRequiredAtRegistration (systemStream) {
    if (systemStream.isRequiredInValidation) {
      throw new Error('Config error: custom "other" system stream cannot be required at registration. Only "account" streams can be required at registration. Stream: ' +
                JSON.stringify(systemStream, null, 2));
    }
  }
  function throwIfNonVisible (systemStream) {
    if (!systemStream.isShown) {
      throw new Error('Config error: custom "other" system stream cannot be non visible. Only "account" streams can non visible. Stream: ' +
                JSON.stringify(systemStream, null, 2));
    }
  }
}

/**
 * @param {Map<string, boolean>} seen
 * @param {Map<string, boolean>} seenWithPrefix
 * @param {string} streamId
 * @returns {Map<string, boolean>[]}
 */
function throwIfNotUnique (seen, seenWithPrefix, streamId) {
  const streamIdWithoutPrefix = _removePrefixFromStreamId(streamId);

  if (seenWithPrefix[streamId]) {
    throw new Error(`Config error: Custom system stream id duplicate. Remove duplicate custom system stream with streamId: "${streamIdWithoutPrefix}".`);
  } else {
    seenWithPrefix[streamId] = true;
    seen[streamIdWithoutPrefix] = true;
    return [seen, seenWithPrefix];
  }

  function _removePrefixFromStreamId (streamIdWithPrefix) {
    if (streamIdWithPrefix.startsWith(PRYV_PREFIX)) { return streamIdWithPrefix.substr(PRYV_PREFIX.length); }
    if (streamIdWithPrefix.startsWith(CUSTOMER_PREFIX)) { return streamIdWithPrefix.substr(CUSTOMER_PREFIX.length); }
    throw new Error('Config error: should not crash here');
  }
}
