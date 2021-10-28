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
const _ = require('lodash');

import type { Stream } from 'business/src/streams';
import type { SystemStream } from 'business/src/system-streams';
const { StreamProperties } = require('business/src/streams');
const treeUtils = require('utils').treeUtils;
const { getConfigUnsafe } = require('@pryv/boiler');
const { features } = require('api-server/config/components/systemStreams');

const PRYV_PREFIX = ':_system:';
const CUSTOMER_PREFIX = ':system:';

const IS_SHOWN: string = features.IS_SHOWN;
const IS_INDEXED: string = features.IS_INDEXED;
const IS_EDITABLE: string = features.IS_EDITABLE;
const IS_UNIQUE: string = features.IS_UNIQUE;
const IS_REQUIRED_IN_VALIDATION: string = features.IS_REQUIRED_IN_VALIDATION;

const ALL = 'all';

let singleton = null;

/**
 * Class that converts system->account events to the
 * Account information that matches the previous 
 * structure of the account info
 */
class SystemStreamsSerializer {

  // Nomenclature
  // no suffix: tree
  // array/flat: flattened tree
  // map (id as key)

  /**
   * "systemStreams" object in config
   */
  systemStreamsSettings: {};

  // static
  static allAsTree: ?Array<SystemStream>;
  static allMap: ?Map<string, boolean>;
  static allStreamIds: ?Array<string>;
  
  static readable: ?Array<Stream>;

  static readableAccountMap: ?Map<string, SystemStream>;
  static readableAccountMapForTests: ?Map<string, SystemStream>;
  static readableAccountStreamIds: ?Array<string>;

  static editableAccountMap: ?Map<string, SystemStream>;
  static editableAccountStreamIds: ?Array<string>;

  static accountMap: ?Map<string, Array<string>>;
  static accountMapWithOptions: ?Array<string>;
  static accountLeavesMap: ?Map<string, SystemStream>;
  static accountStreamIds: ?Array<string>;

  static indexedAccountStreamsIdsWithoutPrefix: ?Array<string>;
  static uniqueAccountStreamsIdsWithoutPrefix: ?Array<string>;

  static accountStreamsIdsForbiddenForReading: ?Array<string>;

  static allRootStreamIdsThatRequireReadRightsForEventsGet: ?Array<string>;
  
  static accountChildren: ?Array<SystemStream>;

  // Maps used for quick translation from without prefix to with
  static streamIdWithPrefixToWithout: ?Map<string, string>;
  static privateStreamIdWithoutPrefixToWith: ?Map<string, string>;
  static customerStreamIdWithoutPrefixToWith: ?Map<string, string>;
  static accountStreamIdWithoutPrefixToWith: ?Map<string, string>;

  static options: ?Map<string, string>;

  static getSerializer(): SystemStreamsSerializer {
    if (singleton) return singleton;
    singleton = new SystemStreamsSerializer();
    initializeSerializer(singleton);
    return singleton;
  }

  /**
   * Reloads the serializer based on the config provided as parameter.
   * See "config.default-streams.test.js" (V9QB, 5T5S, ARD9) for usage example
   */
  static reloadSerializer(config: {}): void {
    if (getConfigUnsafe(true).get('NODE_ENV') !== 'test') {
      console.error('this is meant to be used in test only');
      process.exit(1);
    }
    singleton = new SystemStreamsSerializer();
    singleton.systemStreamsSettings = config.get('systemStreams');
    
    this.allAsTree = null;
    this.allMap = null;
    this.allStreamIds = null;
    this.readable = null;
    this.readableAccountStreamIds = null;
    this.readableAccountMap = null;
    this.readableAccountMapForTests = null;
    this.editableAccountMap = null;
    this.editableAccountStreamIds = null;
    this.accountMap = null;
    this.accountMapWithOptions = null;
    this.accountLeavesMap = null;
    this.accountStreamIds = null;
    this.indexedAccountStreamsIdsWithoutPrefix = null;
    this.uniqueAccountStreamsIdsWithoutPrefix = null;
    this.accountStreamsIdsForbiddenForReading = null;
    this.accountChildren = null;
    this.streamIdWithPrefixToWithout = null;
    this.privateStreamIdWithoutPrefixToWith = null;
    this.accountStreamIdWithoutPrefixToWith = null;
    this.options = null;
    this.allRootStreamIdsThatRequireReadRightsForEventsGet = null;
    initializeSerializer(singleton);
  }

  constructor () {
    this.systemStreamsSettings = getConfigUnsafe(true).get('systemStreams');
    if (this.systemStreamsSettings == null) {
      throw Error('Invalid system streams settings');
    }
  }

  /**
   * Get all root streamIds that need explicit rights to be readable (all stream starting by PRYV_PRFIX) 
   */
  static getAllRootStreamIdsThatRequireReadRightsForEventsGet (): Array<string> {
    if (SystemStreamsSerializer.allRootStreamIdsThatRequireReadRightsForEventsGet) return SystemStreamsSerializer.allRootStreamIdsThatRequireReadRightsForEventsGet;
    SystemStreamsSerializer.allRootStreamIdsThatRequireReadRightsForEventsGet = [];
    for (const rootStream of SystemStreamsSerializer.getAll()) {
      if (rootStream.id.indexOf(PRYV_PREFIX) === 0 && rootStream.id !== ':_system:helpers') SystemStreamsSerializer.allRootStreamIdsThatRequireReadRightsForEventsGet.push(rootStream.id);
    }
    // ---- TODO FIND A NICE WAY TO ACHIEVE THIS
    return SystemStreamsSerializer.allRootStreamIdsThatRequireReadRightsForEventsGet;
  }

  /**
   * Get AccountStremsConfigContent
   * cached,
   */
  static getAccountChildren (): Array<SystemStream> {
    if ( SystemStreamsSerializer.accountChildren != null ) return SystemStreamsSerializer.accountChildren;
    SystemStreamsSerializer.accountChildren = treeUtils.findById(this.allAsTree, PRYV_PREFIX + 'account').children;
    return SystemStreamsSerializer.accountChildren;
  }

  /**
   * Returns readable account stream in a map: string -> stream
   */
  static getReadableAccountMap(): Map<string, SystemStream> {
    if ( SystemStreamsSerializer.readableAccountMap != null ) return SystemStreamsSerializer.readableAccountMap;
    SystemStreamsSerializer.readableAccountMap = filterMapStreams(
      SystemStreamsSerializer.getAccountChildren(),
      IS_SHOWN,
    );
    return SystemStreamsSerializer.readableAccountMap;
  }

  /**
   * Returns keys of getReadableAccountMap
   */
  static getReadableAccountStreamIds(): Array<string> {
    if (SystemStreamsSerializer.readableAccountStreamIds != null) return SystemStreamsSerializer.readableAccountStreamIds;
    SystemStreamsSerializer.readableAccountStreamIds = Object.keys(SystemStreamsSerializer.getReadableAccountMap());
    return SystemStreamsSerializer.readableAccountStreamIds;
  }

  /**
   * Same as getReadableAccountMap, but without storageUsed
   */
  static getReadableAccountMapForTests(): Map<string, SystemStream> {
    if ( SystemStreamsSerializer.readableAccountMapForTests != null ) return SystemStreamsSerializer.readableAccountMapForTests;
    
    const streams = filterMapStreams(SystemStreamsSerializer.getAccountChildren(), IS_SHOWN);
    delete streams[SystemStreamsSerializer.addPrivatePrefixToStreamId('storageUsed')];
    SystemStreamsSerializer.readableAccountMapForTests = streams;
    
    return SystemStreamsSerializer.readableAccountMapForTests;
  }

  /**
   * Returns editable account streams in a map streamId -> stream
   */
  static getEditableAccountMap(): Map<string, SystemStream> {
    if ( SystemStreamsSerializer.editableAccountMap != null ) return SystemStreamsSerializer.editableAccountMap;
    
    SystemStreamsSerializer.editableAccountMap = filterMapStreams(SystemStreamsSerializer.getAccountChildren(), IS_EDITABLE);

    return SystemStreamsSerializer.editableAccountMap;
  }


  /**
   * Get only those streams that user is allowed to edit 
   */
  static getEditableAccountStreamIds(): Array<string> {
    if ( SystemStreamsSerializer.editableAccountStreamIds != null ) return SystemStreamsSerializer.editableAccountStreamIds;
    
    SystemStreamsSerializer.editableAccountStreamIds = Object.keys(SystemStreamsSerializer.getEditableAccountMap());

    return SystemStreamsSerializer.editableAccountStreamIds;
  }

  /**
   * Returns account system streams
   * streamId -> stream
   * 
   * should be used only for internal usage because contains fields that 
   * should not be returned to the user
   */
  static getAccountMap(): Map<string, SystemStream> {
    if ( SystemStreamsSerializer.accountMap != null ) return SystemStreamsSerializer.accountMap;
    
    SystemStreamsSerializer.accountMap = filterMapStreams(SystemStreamsSerializer.getAccountChildren(), ALL);
    return SystemStreamsSerializer.accountMap;
  }

  /**
   * Returns keys of getAccountMap
   * streamId -> stream
   * 
   * should be used only for internal usage because contains fields that 
   * should not be returned to the user
   */
  static getAccountStreamIds(): Array<string> {
    if ( SystemStreamsSerializer.accountStreamIds != null ) return SystemStreamsSerializer.accountStreamIds;
    
    SystemStreamsSerializer.accountStreamIds = Object.keys(SystemStreamsSerializer.getAccountMap());
    return SystemStreamsSerializer.accountStreamIds;
  }

  /**
   * Similar to getAccountMap, but the result gets organized into categories:
   * 
   */
  static getAccountStreamIdsForUser(): Map<string, Array<string>> {
    if ( SystemStreamsSerializer.allAccountStreamIdsForUser != null ) return SystemStreamsSerializer.allAccountStreamIdsForUser;
    
    const returnObject = new Map();
    returnObject.uniqueAccountFields = [];
    returnObject.readableAccountFields = [];
    returnObject.accountFields = [];
    returnObject.accountFieldsWithPrefix = [];

    const accountStreams = SystemStreamsSerializer.getAccountMap();
    
    Object.keys(accountStreams).forEach(streamId => {
      returnObject.accountFieldsWithPrefix.push(streamId);
      const streamIdWithoutPrefix = SystemStreamsSerializer.removePrefixFromStreamId(streamId);
      if (accountStreams[streamId].isUnique == true) {
        returnObject.uniqueAccountFields.push(streamIdWithoutPrefix);
      }
      if (accountStreams[streamId].isShown == true) {
        returnObject.readableAccountFields.push(streamIdWithoutPrefix);
      }    
      returnObject.accountFields.push(streamIdWithoutPrefix);
    });
    SystemStreamsSerializer.allAccountStreamIdsForUser = returnObject;
    
    return SystemStreamsSerializer.allAccountStreamIdsForUser;
  }

  /**
   * Return not only account stream but also helper streams
   * @returns {array} of StreamIds
   */
  static getAccountMapWithOptions (): Map<string, boolean> {
    if ( SystemStreamsSerializer.accountMapWithOptions != null ) return SystemStreamsSerializer.accountMapWithOptions;
    const accountMapWithOptions = _.cloneDeep(SystemStreamsSerializer.getAccountMap());
    accountMapWithOptions[SystemStreamsSerializer.options.STREAM_ID_ACCOUNT] = true;
    accountMapWithOptions[SystemStreamsSerializer.options.STREAM_ID_ACTIVE] = true;
    accountMapWithOptions[SystemStreamsSerializer.options.STREAM_ID_UNIQUE] = true;
    accountMapWithOptions[SystemStreamsSerializer.options.STREAM_ID_HELPERS] = true;

    SystemStreamsSerializer.accountMapWithOptions = accountMapWithOptions;

    return SystemStreamsSerializer.accountMapWithOptions;
  }

  /**
   * Returns true if the provided streamId is an account system stream
   */
  static isAccountStreamId(streamId: string): boolean {
    return SystemStreamsSerializer.getAccountMapWithOptions()[streamId] != null;
  }

  /**
   * Returns true if the provided streamId is a system stream
   */
  static isSystemStreamId(streamId: string): boolean {
    return SystemStreamsSerializer.getAllMap()[streamId] != null;
  }

  /**
   * The same as getAccountMap () but returnes only streams leaves (not parents)
   */
  static getAccountLeavesMap(): Map<string, SystemStream> {
    if (SystemStreamsSerializer.accountLeavesMap != null) return SystemStreamsSerializer.accountLeavesMap
      
    const flatStreamsList = treeUtils.flattenTreeWithoutParents(SystemStreamsSerializer.getAccountChildren());
    let streamsMap = {};

    for (let i = 0; i < flatStreamsList.length; i++) {
      streamsMap[flatStreamsList[i].id] = flatStreamsList[i];
    }
    SystemStreamsSerializer.accountLeavesMap = streamsMap;
    return SystemStreamsSerializer.accountLeavesMap;
  }

  /**
    * Get streamIds of fields that should be indexed
    */
  static getIndexedAccountStreamsIdsWithoutPrefix(): Array<string> {
    if (SystemStreamsSerializer.indexedAccountStreamsIdsWithoutPrefix != null) return SystemStreamsSerializer.indexedAccountStreamsIdsWithoutPrefix;
    let indexedStreamIds = Object.keys(filterMapStreams(SystemStreamsSerializer.getAccountChildren(), IS_INDEXED));
    SystemStreamsSerializer.indexedAccountStreamsIdsWithoutPrefix = indexedStreamIds.map(
      streamId => {
        return SystemStreamsSerializer.removePrefixFromStreamId(streamId)
      }
    );
    return SystemStreamsSerializer.indexedAccountStreamsIdsWithoutPrefix;
  }

/**
 * Returns streamIds of fields that are unique. Without prefix
 */
  static getUniqueAccountStreamsIdsWithoutPrefix(): Array<string> {
    if (SystemStreamsSerializer.uniqueAccountStreamsIdsWithoutPrefix != null) return SystemStreamsSerializer.uniqueAccountStreamsIdsWithoutPrefix;
    const uniqueStreamIds = Object.keys(filterMapStreams(SystemStreamsSerializer.getAccountChildren(), IS_UNIQUE));
    SystemStreamsSerializer.uniqueAccountStreamsIdsWithoutPrefix =
      uniqueStreamIds.map(streamId => {
        return SystemStreamsSerializer.removePrefixFromStreamId(streamId)
    });
    return SystemStreamsSerializer.uniqueAccountStreamsIdsWithoutPrefix;
  }

  /**
   * Get steams that are NOT allowed to view for the user
   * this function will be used to exclude streamIds from queries
   */
  static getAccountStreamsIdsForbiddenForReading(): Array<string> {
    if (SystemStreamsSerializer.accountStreamsIdsForbiddenForReading != null) return SystemStreamsSerializer.accountStreamsIdsForbiddenForReading;
    const accountMap = SystemStreamsSerializer.getAccountMap();
    const readableStreams = SystemStreamsSerializer.getReadableAccountMap();
    SystemStreamsSerializer.accountStreamsIdsForbiddenForReading = _.difference(
      Object.keys(accountMap),
      Object.keys(readableStreams),
    );
    
    return SystemStreamsSerializer.accountStreamsIdsForbiddenForReading;
  }

  /**
   * Modification that is done for each systemStreamId
   * @param string streamIdWithDot
   */
  static removeDotFromStreamId(streamIdWithDot: string): string {
    if (streamIdWithDot.startsWith('.')) {
      streamIdWithDot = streamIdWithDot.substr(1, streamIdWithDot.length);
    }
    return streamIdWithDot;
  }

  /**
   * Removes the system stream prefix, if any
   * @param string streamIdWithPrefix
   */
  static removePrefixFromStreamId(streamIdWithPrefix: string): string {
    const streamIdWithoutPrefix = SystemStreamsSerializer.streamIdWithPrefixToWithout[streamIdWithPrefix];
    return streamIdWithoutPrefix ? streamIdWithoutPrefix : streamIdWithPrefix;
  }

  /**
   * Checks if a streamId starts with a system stream prefix. To be used only in accesses.create!
   * Don't let prefix checks leak into the code, use maps instead for performance and readability.
   * @param {string} streamIdWithPrefix 
   */
  static hasSystemStreamPrefix(streamIdWithPrefix: string): boolean {
    return streamIdWithPrefix.startsWith(PRYV_PREFIX) || streamIdWithPrefix.startsWith(CUSTOMER_PREFIX);
  }

  /**
  * Adds private systeam stream prefix to stream id, if available
  * @param string streamId
  */
  static addPrivatePrefixToStreamId(streamId: string): string {
    const streamIdWithPrefix = SystemStreamsSerializer.privateStreamIdWithoutPrefixToWith[streamId];
    if (streamIdWithPrefix == null) throw new Error('trying to call addCustomerPrefixToStreamId() with non-private streamId: ' + streamId)
    return streamIdWithPrefix;
  }

  static isPrivateSystemStreamId(streamId: string): boolean {
    return SystemStreamsSerializer.privateStreamIdWithoutPrefixToWith[streamId] != null;
  }

  /**
  * Adds customer systeam stream prefix to stream id, if available
  * @param string streamId
  */
  static addCustomerPrefixToStreamId(streamId: string): string {
    const streamIdWithPrefix = SystemStreamsSerializer.customerStreamIdWithoutPrefixToWith[streamId];
    if (streamIdWithPrefix == null) throw new Error('trying to call addCustomerPrefixToStreamId() with non-customer streamId: ' + streamId)
    return streamIdWithPrefix;
  }

  static isCustomerSystemStreamId(streamId: string): boolean {
    return SystemStreamsSerializer.customerStreamIdWithoutPrefixToWith[streamId] != null;
  }

  static addCorrectPrefixToAccountStreamId(streamId: string): string {
    const streamIdWithPrefix: string = SystemStreamsSerializer.accountStreamIdWithoutPrefixToWith[streamId];
    if (streamIdWithPrefix == null) throw new Error('trying to call addCorrectPrefixToAccountStreamId() with non-account streamId: ' + streamId);
    return streamIdWithPrefix;
  }

  /**
   * Get all ids of all system streams
   */
  static getAllSystemStreamsIds() {
    return this.allStreamIds;
  }

  /**
   * Builds allAsTree
   * Returns a streams tree of all system streams
   */
  static getAll(): Array<SystemStream> {
    if ( SystemStreamsSerializer.allAsTree != null ) return SystemStreamsSerializer.allAsTree;
    SystemStreamsSerializer.allAsTree = this.systemStreamsSettings;
    return SystemStreamsSerializer.allAsTree;
  }

  static getAllMap(): Map<string, SystemStream> {
    if ( SystemStreamsSerializer.allMap != null ) return SystemStreamsSerializer.allMap;
    SystemStreamsSerializer.allMap = filterMapStreams(this.getAll(), ALL);
    return SystemStreamsSerializer.allMap;
  }

  /**
   * Return all readable system streams
   */
  static getReadable(): Array<Stream> {
    if (SystemStreamsSerializer.readable) return SystemStreamsSerializer.readable;
    SystemStreamsSerializer.readable = treeUtils.filterTree(this.allAsTree, false, s => s[IS_SHOWN]);
    SystemStreamsSerializer.readable = treeUtils.cloneAndApply(this.readable, s => _.pick(s, StreamProperties));
    return SystemStreamsSerializer.readable;
  }
}

/**
 * Filters streams and returns them as a Map:
 * streamId -> stream
 * 
 * @param Array<SysteamStream> streams - tree of system streams
 * @param string filter - boolean value used for filtering
 */
function filterMapStreams (streams: Array<SystemStream>, filter: string = IS_SHOWN): Map<string, SystemStream> {
  let streamsMap: Map<string, SystemStream> = new Map();
  
  if (! Array.isArray(streams)) {
    return streamsMap;
  }
  const flatStreamsList = treeUtils.flattenTree(streams);

  // convert list to objects
  for (let i = 0; i < flatStreamsList.length; i++){
    
    if (filter === ALL || flatStreamsList[i][filter]) {
      streamsMap[flatStreamsList[i].id] = flatStreamsList[i]
    } else {
      // escape it
    }
  }
  return streamsMap;
}

module.exports = SystemStreamsSerializer;

function initializeSerializer(serializer) {
  SystemStreamsSerializer.getAll.call(serializer);

  const allAsArray: Array<SystemStream> = treeUtils.flattenTree(SystemStreamsSerializer.allAsTree);
  const allStreamIds: Array<string> = allAsArray.map(s => s.id);
  initializeTranslationMaps(allStreamIds);

  SystemStreamsSerializer.allAsArray = allAsArray;
  SystemStreamsSerializer.allStreamIds = allStreamIds;

  const options = {
    STREAM_ID_ACTIVE: 'active',
    STREAM_ID_UNIQUE: 'unique',
    STREAM_ID_USERNAME: 'username',
    STREAM_ID_PASSWORDHASH: 'passwordHash',
    STREAM_ID_HELPERS: 'helpers',
    STREAM_ID_ACCOUNT: 'account',
  };
  Object.keys(options).forEach(k => {
    options[k] = SystemStreamsSerializer.addPrivatePrefixToStreamId(options[k]);
  });
  SystemStreamsSerializer.options = options;

  function initializeTranslationMaps(streamIdsWithPrefix: Array<string>) {
    SystemStreamsSerializer.privateStreamIdWithoutPrefixToWith = new Map();
    SystemStreamsSerializer.customerStreamIdWithoutPrefixToWith = new Map();
    SystemStreamsSerializer.streamIdWithPrefixToWithout = new Map();
    SystemStreamsSerializer.accountStreamIdWithoutPrefixToWith = new Map();

    streamIdsWithPrefix.forEach(streamIdWithPrefix => {
      const streamIdWithoutPrefix = _removePrefixFromStreamId(streamIdWithPrefix);
      SystemStreamsSerializer.streamIdWithPrefixToWithout[streamIdWithPrefix] = streamIdWithoutPrefix;
      if (isCustomer(streamIdWithPrefix)) {
        SystemStreamsSerializer.customerStreamIdWithoutPrefixToWith[streamIdWithoutPrefix] = streamIdWithPrefix;
      } else {
        SystemStreamsSerializer.privateStreamIdWithoutPrefixToWith[streamIdWithoutPrefix] = streamIdWithPrefix;
      }
      if (isAccount(streamIdWithPrefix)) {
        SystemStreamsSerializer.accountStreamIdWithoutPrefixToWith[streamIdWithoutPrefix] = streamIdWithPrefix;
      }
    });

    function isCustomer(streamIdWithPrefix: string): boolean {
      return streamIdWithPrefix.startsWith(CUSTOMER_PREFIX);
    }
    function isAccount(streamIdWithPrefix: string): boolean {
      return SystemStreamsSerializer.getAccountMap()[streamIdWithPrefix] != null;
    }
  }
}

/**
 * Removes the prefix from the streamId
 * Only to be used at initialization!
 * 
 * @param streamId 
 */
function _removePrefixFromStreamId(streamId: string): string {
  if (streamId.startsWith(PRYV_PREFIX)) return streamId.substr(PRYV_PREFIX.length);
  if (streamId.startsWith(CUSTOMER_PREFIX)) return streamId.substr(CUSTOMER_PREFIX.length);
  throw new Error('serializer initialization: removePrefixFromStreamId(streamId) should be called with a prefixed streamId');
}