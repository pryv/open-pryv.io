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

'use strict';

const _ = require('lodash');
const treeUtils = require('utils/src/treeUtils');
const validation = require('api-server/src/schema/validation');
const systemStreamSchema = require('./systemStreamSchema');

const IS_SHOWN = 'isShown';
const IS_INDEXED = 'isIndexed';
const IS_EDITABLE = 'isEditable';
const IS_UNIQUE = 'isUnique';
const IS_REQUIRED_IN_VALIDATION = 'isRequiredInValidation';
const REGEX_VALIDATION = 'regexValidation';

const { defaults: dataStoreDefaults } = require('@pryv/datastore');

module.exports.features = {
  IS_SHOWN,
  IS_INDEXED,
  IS_EDITABLE,
  IS_UNIQUE,
  IS_REQUIRED_IN_VALIDATION,
  REGEX_VALIDATION
};

const DEFAULT = 'default';

const PRYV_PREFIX = ':_system:';
const CUSTOMER_PREFIX = ':system:';

const DEFAULT_VALUES_FOR_FIELDS = {
  [IS_INDEXED]: false,
  [IS_UNIQUE]: false,
  [IS_SHOWN]: true,
  [IS_EDITABLE]: true,
  [IS_REQUIRED_IN_VALIDATION]: false,
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
          [IS_INDEXED]: true
        },
        {
          id: 'appId',
          name: 'appId',
          type: 'identifier/string',
          [DEFAULT]: '',
          [IS_INDEXED]: true,
          [IS_REQUIRED_IN_VALIDATION]: true,
          [IS_SHOWN]: false,
          [IS_EDITABLE]: false
        },
        {
          id: 'invitationToken',
          name: 'Invitation Token',
          type: 'token/string',
          [DEFAULT]: 'no-token',
          [IS_INDEXED]: true,
          [IS_SHOWN]: false,
          [IS_EDITABLE]: false
        },
        {
          id: 'referer',
          name: 'Referer',
          type: 'identifier/string',
          [DEFAULT]: null,
          [IS_INDEXED]: true,
          [IS_SHOWN]: false,
          [IS_EDITABLE]: false
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
              [IS_EDITABLE]: false
            },
            {
              id: 'attachedFiles',
              name: 'Attached files',
              type: 'data-quantity/b',
              [DEFAULT]: 0,
              [IS_EDITABLE]: false
            }
          ]
        }
      ]
    }
  ];
  defaultAccountStreams = extendSystemStreamsWithDefaultValues(defaultAccountStreams);
  defaultAccountStreams = ensurePrefixForStreamIds(defaultAccountStreams);

  let helpers = [
    {
      id: 'helpers',
      name: 'Helpers',
      type: 'none/none',
      children: [
        {
          id: 'active',
          name: 'Active',
          type: 'identifier/string'
        },
        {
          id: 'unique',
          name: 'Unique',
          type: 'identifier/string',
          [IS_SHOWN]: false
        }
      ]
    }
  ];
  helpers = extendSystemStreamsWithDefaultValues(helpers);
  helpers = ensurePrefixForStreamIds(helpers);

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
    .concat(otherCustomStreams)
    .concat(helpers);
  systemStreams = addParentIdAndChildren(systemStreams);

  let seen = new Map();
  let seenWithPrefix = new Map();
  const isBackwardCompatibilityActive = config.get('backwardCompatibility:systemStreams:prefix:isActive');

  treeUtils.cloneAndApply(systemStreams, (s) => {
    // ugly reuse of treeUtils.cloneAndApply() because we don't modify the array
    validateSystemStreamWithSchema(s);
    [seen, seenWithPrefix] = throwIfNotUnique(seen, seenWithPrefix, s.id, isBackwardCompatibilityActive);
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
    const stream = _.extend({}, DEFAULT_VALUES_FOR_FIELDS, s);
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
  return treeUtils.cloneAndApply(systemStreams, (s) => _.extend({}, s, { id: _addPrefixToStreamId(s.id, prefix) }));
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
    if (systemStream[IS_UNIQUE] && !systemStream[IS_INDEXED]) {
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
    if (systemStream[IS_UNIQUE]) {
      throw new Error('Config error: custom "other" system stream cannot be unique. Only "account" streams can be unique. Stream: ' +
                JSON.stringify(systemStream, null, 2));
    }
  }
  function throwIfIndexed (systemStream) {
    if (systemStream[IS_INDEXED]) {
      throw new Error('Config error: custom "other" system stream cannot be indexed. Only "account" streams can be indexed. Stream: ' +
                JSON.stringify(systemStream, null, 2));
    }
  }
  function throwIfNonEditable (systemStream) {
    if (!systemStream[IS_EDITABLE]) {
      throw new Error('Config error: custom "other" system stream cannot be non-editable. Only "account" streams can be non-editable. Stream: ' +
                JSON.stringify(systemStream, null, 2));
    }
  }
  function throwIfRequiredAtRegistration (systemStream) {
    if (systemStream[IS_REQUIRED_IN_VALIDATION]) {
      throw new Error('Config error: custom "other" system stream cannot be required at registration. Only "account" streams can be required at registration. Stream: ' +
                JSON.stringify(systemStream, null, 2));
    }
  }
  function throwIfNonVisible (systemStream) {
    if (!systemStream[IS_SHOWN]) {
      throw new Error('Config error: custom "other" system stream cannot be non visible. Only "account" streams can non visible. Stream: ' +
                JSON.stringify(systemStream, null, 2));
    }
  }
}

/**
 * @param {Map<string, boolean>} seen
 * @param {Map<string, boolean>} seenWithPrefix
 * @param {string} streamId
 * @param {boolean} isBackwardCompatible
 * @returns {Map<string, boolean>[]}
 */
function throwIfNotUnique (seen, seenWithPrefix, streamId, isBackwardCompatible = false) {
  const streamIdWithoutPrefix = _removePrefixFromStreamId(streamId);

  if (seenWithPrefix[streamId]) {
    throw new Error(`Config error: Custom system stream id duplicate. Remove duplicate custom system stream with streamId: "${streamIdWithoutPrefix}".`);
  } else if (seen[streamIdWithoutPrefix] && isBackwardCompatible) {
    throw new Error(`Config error: Custom system stream id unicity collision with default one. Deactivate retro-compatibility prefix or change streamId: "${streamIdWithoutPrefix}".`);
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
