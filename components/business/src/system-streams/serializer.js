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
// @flow
const _ = require('lodash');
const treeUtils = require('utils').treeUtils;


const { getConfigUnsafe } = require('boiler');


const readable = 'readable-default-streams';
const allAccountStreams = 'all-default-streams';
const editableAccountStreams = 'editable-default-streams';
const indexedStreams = 'indexed-default-streams';
const uniqueStreams = 'unique-default-streams';

const accountStreamsConfigPath = 'systemStreams:account';


let singleton = null;

/**
 * Class that converts system->account events to the
 * Account information that matches the previous 
 * structure of the account info
 */
class SystemStreamsSerializer {
  systemStreamsSettings;

  // singleton calcualted values
  // static
  readableAccountStreams: Array<object>;
  readableAccountStreamsForTests: Array<object>;
  editableAccountStreams: Array<object>;
  allAccountStreams: Array<object>;
  allAccountStreamsIdsForAccess: Array<String>;
  allAccountStreamsLeaves: Array<object>;
  indexedAccountStreamsIdsWithoutDot: Array<String>;
  uniqueAccountStreamsIdsWithoutDot: Array<String>;
  accountStreamsIdsForbiddenForEditing: Array<String>;
  accountStreamsIdsForbiddenForReading: Array<String>;
  flatAccountStreamSettings: Array<object>;
  accountStreamsConfig;

  // not static
  allSystemStreamsIds: Array<String>;
  systemStreamsList: Array<object>;
  

  static getSerializer() {
    if (singleton) return singleton;
    singleton = new SystemStreamsSerializer();
    return singleton;
  }

  constructor () {
    this.systemStreamsSettings = getConfigUnsafe(true).get('systemStreams');
    if (this.systemStreamsSettings == null) {
      throw Error("Not valid system streams settings.");
    }
  }

  /**
   * Get AccountStremsConfigContent
   * cached,
   */
  static getAccountStreamsConfig () {
    if (! SystemStreamsSerializer.accountStreamsConfig){
      SystemStreamsSerializer.accountStreamsConfig =  getConfigUnsafe(true).get(accountStreamsConfigPath);
    }
    return SystemStreamsSerializer.accountStreamsConfig;
  }

  /**
   * Get the names of all readable streams that belongs to the system->account stream
   * and could be returned to the user
   */
  static getReadableAccountStreams () {
    if (!SystemStreamsSerializer.readableAccountStreams){
      SystemStreamsSerializer.readableAccountStreams = getStreamsNames(
        SystemStreamsSerializer.getAccountStreamsConfig(),
        readable
      );
    }
    return SystemStreamsSerializer.readableAccountStreams;
  }

  /**
   * The same as getReadableAccountStreams (), just skips storageUsed because it is 
   * a parent and no events are created by default for it directly.
   */
  static getReadableAccountStreamsForTests () {
    if (!SystemStreamsSerializer.readableAccountStreamsForTests) {
      let streams = getStreamsNames(SystemStreamsSerializer.getAccountStreamsConfig(), readable);
      delete streams[SystemStreamsSerializer.addDotToStreamId('storageUsed')];
      SystemStreamsSerializer.readableAccountStreamsForTests = streams;
    }
    return SystemStreamsSerializer.readableAccountStreamsForTests;
  }

  /**
   * Get only those streams that user is allowed to edit 
   */
  static getEditableAccountStreams () {
    if (!SystemStreamsSerializer.editableAccountStreams) {
      SystemStreamsSerializer.editableAccountStreams = getStreamsNames(SystemStreamsSerializer.getAccountStreamsConfig(), editableAccountStreams);
      SystemStreamsSerializer.editableAccountStreams = getStreamsNames(SystemStreamsSerializer.getAccountStreamsConfig(), editableAccountStreams);
    }
    return SystemStreamsSerializer.editableAccountStreams;
  }

  /**
   * Get the names of all streams that belongs to the system->account stream
   * should be used only for internal usage because contains fields that 
   * should not be returned to the user
   */
  static getAllAccountStreams () {
    if (!SystemStreamsSerializer.allAccountStreams) {
      SystemStreamsSerializer.allAccountStreams = getStreamsNames(SystemStreamsSerializer.getAccountStreamsConfig(), allAccountStreams);
    }
    return SystemStreamsSerializer.allAccountStreams;
  }

  /**
   * Return not only account stream but also helper streams
   * @returns {array} of StreamIds
   */
  static getAllAccountStreamsIdsForAccess () {
    if (!SystemStreamsSerializer.allAccountStreamsIdsForAccess) {
      let allAccountStreamsIds = Object.keys(SystemStreamsSerializer.getAllAccountStreams());
      allAccountStreamsIds.push(SystemStreamsSerializer.options.STREAM_ID_ACCOUNT);
      allAccountStreamsIds.push(SystemStreamsSerializer.options.STREAM_ID_ACTIVE);
      allAccountStreamsIds.push(SystemStreamsSerializer.options.STREAM_ID_UNIQUE);
      allAccountStreamsIds.push(SystemStreamsSerializer.options.STREAM_ID_HELPERS);
      SystemStreamsSerializer.allAccountStreamsIdsForAccess = allAccountStreamsIds;
    }
    return SystemStreamsSerializer.allAccountStreamsIdsForAccess;
  }

  /**
   * Return true is this streamid is a system stream
   * @param {string} streamId 
   * @returns {boolean} 
   */
  static isAccountStreamId(streamId) {
    return SystemStreamsSerializer.getAllAccountStreamsIdsForAccess().includes(streamId);
  }

  /**
   * The same as getAllAccountStreams () but returnes only streams leaves (not parents)
   */
  static getAllAccountStreamsLeaves () {
    if (!SystemStreamsSerializer.allAccountStreamsLeaves) {
      
      const flatStreamsList = treeUtils.flattenTreeWithoutParents(SystemStreamsSerializer.getAccountStreamsConfig());
      let flatStreamsListObj = {};
      let i;
      for (i = 0; i < flatStreamsList.length; i++) {
        flatStreamsListObj[flatStreamsList[i].id] = flatStreamsList[i];
      }
      SystemStreamsSerializer.allAccountStreamsLeaves = flatStreamsListObj;
    }
    return SystemStreamsSerializer.allAccountStreamsLeaves;
  }

/**
 * Get streamIds of fields that should be indexed
 */
  static getIndexedAccountStreamsIdsWithoutDot () {
    if (!SystemStreamsSerializer.indexedAccountStreamsIdsWithoutDot) {
      let indexedStreamIds = Object.keys(getStreamsNames(SystemStreamsSerializer.getAccountStreamsConfig(), indexedStreams));
      SystemStreamsSerializer.indexedAccountStreamsIdsWithoutDot = indexedStreamIds.map(
        streamId => {
          return SystemStreamsSerializer.removeDotFromStreamId(streamId)
        }
      );
    }
    return SystemStreamsSerializer.indexedAccountStreamsIdsWithoutDot;
  }

/**
 * Get streamIds of fields that should be unique
 */
  static getUniqueAccountStreamsIdsWithoutDot () {
    if (!SystemStreamsSerializer.uniqueAccountStreamsIdsWithoutDot) {
      let uniqueStreamIds = Object.keys(getStreamsNames(SystemStreamsSerializer.getAccountStreamsConfig(), uniqueStreams));
      SystemStreamsSerializer.uniqueAccountStreamsIdsWithoutDot =
        uniqueStreamIds.map(streamId => {
          return SystemStreamsSerializer.removeDotFromStreamId(streamId)
        });
    }
    return SystemStreamsSerializer.uniqueAccountStreamsIdsWithoutDot;
  }

  /**
   * Get steams that are NOT allowed to edit - this function will be used to 
   * exclude from queries
   */
  static getAccountStreamsIdsForbiddenForEditing () {
    if (!SystemStreamsSerializer.accountStreamsIdsForbiddenForEditing) {
      let allStreams = SystemStreamsSerializer.getAllAccountStreams();
      let editableStreams = SystemStreamsSerializer.getEditableAccountStreams();

      SystemStreamsSerializer.accountStreamsIdsForbiddenForEditing = _.difference(
          _.keys(allStreams),
          _.keys(editableStreams)
        );
    }
    return SystemStreamsSerializer.accountStreamsIdsForbiddenForEditing;
  }

  /**
   * Get steams that are NOT allowed to view for the user
   * this function will be used to exclude streamIds from queries
   */
  static getAccountStreamsIdsForbiddenForReading () {
    if (!SystemStreamsSerializer.accountStreamsIdsForbiddenForReading) {
      let allStreams = SystemStreamsSerializer.getAllAccountStreams();
      let readableStreams = SystemStreamsSerializer.getReadableAccountStreams();
      SystemStreamsSerializer.accountStreamsIdsForbiddenForReading = _.difference(
        _.keys(allStreams),
        _.keys(readableStreams)
      );
    }
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
  * Reverse modification that is done for each systemStreamId
  * @param string streamIdWithDot
  */
  static addDotToStreamId (streamIdWithoutDot: string): string {
    if (! streamIdWithoutDot.startsWith('.')) {
      streamIdWithoutDot = '.' + streamIdWithoutDot;
    }
    return streamIdWithoutDot;
  }
  /**
   * Build flattened account stream settings and converted from an array to object
   */
  static getFlatAccountStreamSettings () {
    if (!SystemStreamsSerializer.flatAccountStreamSettings) {
      let accountSettings = {};
      const flatStreamsList = treeUtils.flattenTree(SystemStreamsSerializer.getAccountStreamsConfig());

      // convert list to object
      let i;
      for (i = 0; i < flatStreamsList.length; i++) {
        accountSettings[flatStreamsList[i].id] = flatStreamsList[i];
      }
      SystemStreamsSerializer.flatAccountStreamSettings = accountSettings;
    } 
    return SystemStreamsSerializer.flatAccountStreamSettings;
  }

  /**
   * Get all ids of all system streams
   */
  getAllSystemStreamsIds () {
    if (!SystemStreamsSerializer.allSystemStreamsIds) {
      let systemStreams = [];
      let i;
      const streamKeys = Object.keys(this.systemStreamsSettings);

      for (i = 0; i < streamKeys.length; i++) {
        systemStreams.push(SystemStreamsSerializer.addDotToStreamId(streamKeys[i]));
        _.merge(systemStreams,
          Object.keys(getStreamsNames(this.systemStreamsSettings[streamKeys[i]])))
      }
      SystemStreamsSerializer.allSystemStreamsIds = systemStreams;
    }
    return SystemStreamsSerializer.allSystemStreamsIds;
  }

  /**
   * Build streams from systemStreams settings
   * parent is formed just providing hte name, id, parentId null and children
   */
  getSystemStreamsList () {
    if (!SystemStreamsSerializer.systemStreamsList) {
      let systemStreams = [];
      let i;
      const streamKeys = Object.keys(this.systemStreamsSettings);

      for (i = 0; i < streamKeys.length; i++) {
        systemStreams.push({
          name: streamKeys[i],
          id: SystemStreamsSerializer.addDotToStreamId(streamKeys[i]),
          parentId: null,
          children: buildSystemStreamsFromSettings(
            this.systemStreamsSettings[streamKeys[i]],
            [],
            SystemStreamsSerializer.addDotToStreamId(streamKeys[i])
          )
        });
      }
      SystemStreamsSerializer.systemStreamsList = systemStreams;
    }
    return SystemStreamsSerializer.systemStreamsList;
  }
}

/**
 * Converts systemStreams settings to the actual simple streams objects
 * @param object settings 
 * @param array systemStreams 
 * @param string parentName 
 */
function buildSystemStreamsFromSettings (settings, systemStreams, parentName: string): [] {
  let streamIndex;
  
  settings.forEach(stream => {
    if (stream.isShown) {
      systemStreams.push({
        name: stream.name ? stream.name : stream.id ,
        id: stream.id,
        parentId: parentName,
        children: []
      });
      if (stream.children != null) {
        systemStreams[systemStreams.length - 1].children = buildSystemStreamsFromSettings(stream.children, systemStreams[systemStreams.length - 1].children, stream.id)
      }
    }
  });
  
  return systemStreams;
}

/**
 * Iterate throught the tree and add keys to the flat list streamsNames
 * @param {*} streams - tree structure object
 * @param enum string whatToReturn - enum values should be retrieved with 
 *  getReadableAccountStreams(), getAllAccountStreams (), getEditableAccountStreams;
 * if they are equal to false or true
 */
function getStreamsNames (streams, whatToReturn) {
  let flatStreamsListObj = {};
  
  if (Array.isArray(streams) === false) {
    return flatStreamsListObj;
  }
  const flatStreamsList = treeUtils.flattenTree(streams);

  // convert list to objects
  let i;
  for (i = 0; i < flatStreamsList.length; i++){
    // if the stream value is equal to false, it should be not visible 
    // (except when all account streams should be returned)
    switch (whatToReturn) {
      case readable:
        if (!flatStreamsList[i].isShown) {
          continue;
        }
        break;
      case allAccountStreams:
        break;
      case indexedStreams:
        if (!flatStreamsList[i].isIndexed) {
          continue;
        }
        break;
      case uniqueStreams:
        if (!flatStreamsList[i].isUnique) {
          continue;
        }
        break;
      case editableAccountStreams:
        if (!flatStreamsList[i].isEditable) {
          continue;
        }
        break;
      default:
        if (!flatStreamsList[i].isShown) {
          continue;
        }
        break;
    }
    flatStreamsListObj[flatStreamsList[i].id] = flatStreamsList[i]
  }
  return flatStreamsListObj;
}

SystemStreamsSerializer.options = {
  STREAM_ID_ACTIVE: '.active',
  STREAM_ID_UNIQUE: '.unique',
  STREAM_ID_USERNAME: '.username',
  STREAM_ID_PASSWORDHASH: '.passwordHash',
  STREAM_ID_HELPERS: '.helpers',
  STREAM_ID_ACCOUNT: '.account',
}
module.exports = SystemStreamsSerializer;