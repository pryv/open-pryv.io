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

'use strict';
const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const treeUtils = require('utils/src/treeUtils');
const validation = require('api-server/src/schema/validation');
const string = require('api-server/src/methods/helpers/string');
const slugify = require('slug');
const systemStreamSchema = require('./systemStreamSchema');
import type { SystemStream } from 'business/src/system-streams';

const IS_SHOWN: string = 'isShown';
const IS_INDEXED: string = 'isIndexed';
const IS_EDITABLE: string = 'isEditable';
const IS_UNIQUE: string = 'isUnique';
const IS_REQUIRED_IN_VALIDATION: string = 'isRequiredInValidation';
const REGEX_VALIDATION: string = 'regexValidation';

const { DataStore } = require('mall/interfaces/DataStore');

module.exports.features = {
  IS_SHOWN,
  IS_INDEXED,
  IS_EDITABLE,
  IS_UNIQUE,
  IS_REQUIRED_IN_VALIDATION,
  REGEX_VALIDATION,
};

const DEFAULT: string = 'default';

const PRYV_PREFIX: string = ':_system:';
const CUSTOMER_PREFIX: string = ':system:';

const DEFAULT_VALUES_FOR_FIELDS: {} = {
  [IS_INDEXED]: false, // if true will be sent to service-register to be able to query across the platform
  [IS_UNIQUE]: false, // if true will be sent to service-register and enforced uniqueness on mongodb
  [IS_SHOWN]: true, // if true, will be returned in events.get
  [IS_EDITABLE]: true, // if true, user will be allowed to edit through events.put
  [IS_REQUIRED_IN_VALIDATION]: false, // if true, the field will be required in the validation
  created: DataStore.UNKOWN_DATE,
  modified: DataStore.UNKOWN_DATE,
  createdBy: DataStore.BY_SYSTEM,
  modifiedBy: DataStore.BY_SYSTEM,
};

/**
 * Fetches "systemStreams" and "custom:systemStreams" from the config provided in parameter
 * Applies the following:
 * - default values
 * - sets default account
 * - children and parentId values
 * Stores the result in "systemStreams"
 */
function load(config: {}): {} {
  // default system streams that should be not changed
  let defaultAccountStreams: Array<SystemStream> = 
    [{
      id: 'account',
      name: 'Account',
      type: 'none/none',
      children: [
        {
          id: 'username',
          name: 'Username',
          type: 'identifier/string',
          [IS_INDEXED]: true,
          [IS_UNIQUE]: true,
          [IS_REQUIRED_IN_VALIDATION]: true,
          [IS_EDITABLE]: false,
        },
        {
          id: 'language',
          name: 'Language',
          type: 'language/iso-639-1',
          [DEFAULT]: 'en',
          [IS_INDEXED]: true,
        },
        {
          id: 'appId',
          name: 'appId',
          type: 'identifier/string',
          [DEFAULT]: '',
          [IS_INDEXED]: true,
          [IS_REQUIRED_IN_VALIDATION]: true,
          [IS_SHOWN]: false,
          [IS_EDITABLE]: false,
        },
        {
          id: 'invitationToken',
          name: 'Invitation Token',
          type: 'token/string',
          [DEFAULT]: 'no-token',
          [IS_INDEXED]: true,
          [IS_SHOWN]: false,
          [IS_EDITABLE]: false,
        },
        {
          id: 'passwordHash',
          name: 'Password Hash',
          type: 'password-hash/string',
          [IS_SHOWN]: false,
          [IS_EDITABLE]: false,
        },
        {
          id: 'referer',
          name: 'Referer',
          type: 'identifier/string',
          [DEFAULT]: null,
          [IS_INDEXED]: true,
          [IS_SHOWN]: false,
          [IS_EDITABLE]: false,
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
              [IS_EDITABLE]: false,
            },
            {
              id: 'attachedFiles',
              name: 'Attached files',
              type: 'data-quantity/b',
              [DEFAULT]: 0,
              [IS_EDITABLE]: false,
            }
          ]
        }
      ]
    }];
  defaultAccountStreams = extendSystemStreamsWithDefaultValues(defaultAccountStreams);
  defaultAccountStreams = ensurePrefixForStreamIds(defaultAccountStreams)

  let helpers: Array<SystemStream> = [{
    id: 'helpers',
    name: 'Helpers',
    type: 'none/none',
    children: [
      {
        id: 'active',
        name: 'Active',
        type: 'identifier/string',
      },
      {
        id: 'unique',
        name: 'Unique',
        type: 'identifier/string',
        [IS_SHOWN]: false,
      }
    ]
  }];
  helpers = extendSystemStreamsWithDefaultValues(helpers);
  helpers = ensurePrefixForStreamIds(helpers);

  let customAccountStreams: Array<SystemStream> = config.get('custom:systemStreams:account');
  if (customAccountStreams == null) customAccountStreams = [];
  customAccountStreams = extendSystemStreamsWithDefaultValues(customAccountStreams);
  customAccountStreams = ensurePrefixForStreamIds(customAccountStreams, CUSTOMER_PREFIX);

  defaultAccountStreams[0].children = defaultAccountStreams[0].children.concat(customAccountStreams);
  const fullAccountStreams: Array<SystemStream> = defaultAccountStreams; // for readability
  
  let otherCustomStreams: Array<SystemStream> = config.get('custom:systemStreams:other');
  if (otherCustomStreams == null) otherCustomStreams = [];
  otherCustomStreams = extendSystemStreamsWithDefaultValues(otherCustomStreams);
  otherCustomStreams = ensurePrefixForStreamIds(otherCustomStreams, CUSTOMER_PREFIX);
  treeUtils.cloneAndApply(otherCustomStreams, s => { // ugly reuse of treeUtils.cloneAndApply() because we don't modify the array
    validateOtherStreams(s);
    return s;
  });

  let systemStreams: Array<SystemStream> = fullAccountStreams.concat(otherCustomStreams).concat(helpers);
  systemStreams = addParentIdAndChildren(systemStreams);

  let seen: Map<string, boolean> = new Map();
  let seenWithPrefix: Map<string, boolean> = new Map();
  const isBackwardCompatibilityActive: boolean = config.get('backwardCompatibility:systemStreams:prefix:isActive');

  treeUtils.cloneAndApply(systemStreams, s => { // ugly reuse of treeUtils.cloneAndApply() because we don't modify the array
    validateSystemStreamWithSchema(s);
    [seen, seenWithPrefix] = throwIfNotUnique(seen, seenWithPrefix, s.id, isBackwardCompatibilityActive);
    return s;
  });

  config.set('systemStreams', systemStreams);

  return config;
}
module.exports.load = load;

function addParentIdAndChildren(streams: Array<SystemStream>): Array<SystemStream> {
  for(let stream of streams) {
    stream = addParentIdToChildren(stream);
    stream.parentId = null;
  }
  return streams;

  function addParentIdToChildren(stream: SystemStream): SystemStream {
    if (stream.children == null) {
      stream.children = [];
      return stream;
    }
    stream.children.forEach(childStream => {
      childStream.parentId = stream.id;
      childStream = addParentIdToChildren(childStream);
    });
    return stream;
  }
}

/**
 * Extend system stream properties with default values
 * @param {*} streams 
 */
function extendSystemStreamsWithDefaultValues (
  streams: Array<SystemStream>
): Array<SystemStream>{
  return treeUtils.cloneAndApply(streams, s => { 
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
 * @param {Array<systemStream>} systemStreams array of system streams
 * @param {string} prefix the prefix to add
 */
function ensurePrefixForStreamIds(systemStreams: Array<SystemStream>, prefix: string = PRYV_PREFIX): Array<SystemStream> {
  return treeUtils.cloneAndApply(systemStreams, s => _.extend({}, s, { id: _addPrefixToStreamId(s.id, prefix)}));

  function _addPrefixToStreamId(streamId: string, prefix: string): string {
    if (streamId.startsWith(prefix)) return streamId;
    return prefix + streamId;
  }
}

function validateSystemStreamWithSchema(systemStream: SystemStream): void {
  validation.validate(systemStream, systemStreamSchema, function (err) {
    if (err) {
      throw err;
    }
  });

  throwIfUniqueAndNotIndexed(systemStream);

  function throwIfUniqueAndNotIndexed(systemStream: SystemStream): void {
    if (systemStream[IS_UNIQUE] && ! systemStream[IS_INDEXED]) throw new Error('Config error: custom system stream cannot be unique and not indexed. Stream: ' + JSON.stringify(systemStream, null, 2));
  }
}

function validateOtherStreams(systemStream: SystemStream): void {
  throwIfUnique(systemStream);
  throwIfIndexed(systemStream);
  throwIfNonEditable(systemStream);
  throwIfRequiredAtRegistration(systemStream);
  throwIfNonVisible(systemStream);

  function throwIfUnique(systemStream: SystemStream): void {
    if (systemStream[IS_UNIQUE]) throw new Error('Config error: custom "other" system stream cannot be unique. Only "account" streams can be unique. Stream: ' + 
    JSON.stringify(systemStream, null, 2));
  }
  function throwIfIndexed(systemStream: SystemStream): void {
    if (systemStream[IS_INDEXED]) throw new Error('Config error: custom "other" system stream cannot be indexed. Only "account" streams can be indexed. Stream: ' + 
    JSON.stringify(systemStream, null, 2));
  }
  function throwIfNonEditable(systemStream: SystemStream): void {
    if (! systemStream[IS_EDITABLE]) throw new Error('Config error: custom "other" system stream cannot be non-editable. Only "account" streams can be non-editable. Stream: ' + 
    JSON.stringify(systemStream, null, 2));
  }
  function throwIfRequiredAtRegistration(systemStream: SystemStream): void {
    if (systemStream[IS_REQUIRED_IN_VALIDATION]) throw new Error('Config error: custom "other" system stream cannot be required at registration. Only "account" streams can be required at registration. Stream: ' + 
    JSON.stringify(systemStream, null, 2));
  }
  function throwIfNonVisible(systemStream: SystemStream): void {
    if (! systemStream[IS_SHOWN]) throw new Error('Config error: custom "other" system stream cannot be non visible. Only "account" streams can non visible. Stream: ' + 
    JSON.stringify(systemStream, null, 2));
  }
}

function throwIfNotUnique(
  seen: Map<string, boolean>,
  seenWithPrefix: Map<string, boolean>,
  streamId: string,
  isBackwardCompatible: boolean = false
): Array<Map<string, boolean>> {
  const streamIdWithoutPrefix: string = _removePrefixFromStreamId(streamId);
  
  if (seenWithPrefix[streamId]) {
    throw new Error(`Config error: Custom system stream id duplicate. Remove duplicate custom system stream with streamId: "${streamIdWithoutPrefix}".`);
  } else if (seen[streamIdWithoutPrefix] && isBackwardCompatible) {
    throw new Error(`Config error: Custom system stream id unicity collision with default one. Deactivate retro-compatibility prefix or change streamId: "${streamIdWithoutPrefix}".`);
  } else {
    seenWithPrefix[streamId] = true;
    seen[streamIdWithoutPrefix] = true;
    return [seen, seenWithPrefix];
  }

  function _removePrefixFromStreamId(streamIdWithPrefix: string): string {
    if (streamIdWithPrefix.startsWith(PRYV_PREFIX)) return streamIdWithPrefix.substr(PRYV_PREFIX.length);
    if (streamIdWithPrefix.startsWith(CUSTOMER_PREFIX)) return streamIdWithPrefix.substr(CUSTOMER_PREFIX.length);
    throw new Error('Config error: should not crash here');
}
}