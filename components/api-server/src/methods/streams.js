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
const errors = require('errors').factory;
const commonFns = require('./helpers/commonFunctions');
const methodsSchema = require('../schema/streamsMethods');
const streamSchema = require('../schema/stream');
const slugify = require('utils').slugify;
const string = require('./helpers/string');
const utils = require('utils');
const treeUtils = utils.treeUtils;
const _ = require('lodash');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const ErrorMessages = require('errors/src/ErrorMessages');
const ErrorIds = require('errors/src/ErrorIds');
const APIError = require('errors/src/APIError');
const { getLogger, getConfig } = require('@pryv/boiler');
const logger = getLogger('methods:streams');
const { getMall, storeDataUtils } = require('mall');
const { changePrefixIdForStreams, replaceWithNewPrefix } = require('./helpers/backwardCompatibility');
const { pubsub } = require('messages');
const Readable = require('stream').Readable;
/**
 * Event streams API methods implementation.
 *
 * @param api
 * @param notifyTests
 * @param logging
 * @param auditSettings
 * @param updatesSettings
 */
module.exports = async function (api) {
  const config = await getConfig();
  const updatesSettings = config.get('updates');
  const mall = await getMall();
  const isStreamIdPrefixBackwardCompatibilityActive = config.get('backwardCompatibility:systemStreams:prefix:isActive');
  // RETRIEVAL
  api.register('streams.get', commonFns.getParamsValidation(methodsSchema.get.params), checkAuthorization, applyDefaultsForRetrieval, findAccessibleStreams, includeDeletionsIfRequested);
  function applyDefaultsForRetrieval (context, params, result, next) {
    params.parentId ??= null;
    params.includeDeletionsSince ??= null;
    next();
  }
  async function checkAuthorization (context, params, result, next) {
    if (params.parentId && params.id) {
      throw errors.invalidRequestStructure('Do not mix "parentId" and "id" parameter in request');
    }
    if (params.parentId) {
      if (isStreamIdPrefixBackwardCompatibilityActive &&
                !context.disableBackwardCompatibility) {
        params.parentId = replaceWithNewPrefix(params.parentId);
      }
    }
    const streamId = params.id || params.parentId || null;
    if (!streamId) { return next(); } // "*" is authorized for everyone
    if (!(await context.access.canListStream(streamId))) {
      return next(errors.forbidden('Insufficient permissions or non-existant stream [' + streamId + ']'));
    }
    return next();
  }
  async function findAccessibleStreams (context, params, result, next) {
    if (params.parentId) {
      if (isStreamIdPrefixBackwardCompatibilityActive &&
                !context.disableBackwardCompatibility) {
        params.parentId = replaceWithNewPrefix(params.parentId);
      }
    }
    let streamId = params.id || params.parentId || '*';
    let storeId = params.storeId; // might me null
    if (storeId == null) {
      // TODO: clarify smelly code (replace full stream id with in-store id?)
      [storeId, streamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamId);
    }
    let streams = await mall.streams.get(context.user.id, {
      id: streamId,
      storeId,
      childrenDepth: -1,
      includeTrashed: params.includeTrashed || params.state === 'all',
      excludedIds: context.access.getCannotListStreamsStreamIds(storeId)
    });
    if (streamId !== '*') {
      const fullStreamId = storeDataUtils.getFullItemId(storeId, streamId);
      const inResult = treeUtils.findById(streams, fullStreamId);
      if (!inResult) {
        return next(errors.unknownReferencedResource('unknown Stream:', params.parentId ? 'parentId' : 'id', fullStreamId, null));
      }
    } else if (!(await context.access.canListStream('*'))) {
      // request is "*" and not personal access
      // cherry pick accessible streams from result
      /********************************
       * This is not optimal (fetches all streams) and not accurate
       * This method can "duplicate" streams, if read rights have been given to a parent and one of it's children
       * Either:
       *  - detect parent / child relationships
       *  - pass a list of streamIds to store.streams.get() to get a consolidated answer
       *********************************/
      const listables = context.access.getListableStreamIds();
      const filteredStreams = [];
      for (const listable of listables) {
        const listableFullStreamId = storeDataUtils.getFullItemId(listable.storeId, listable.streamId);
        const inResult = treeUtils.findById(streams, listableFullStreamId);
        if (inResult) {
          const copy = structuredClone(inResult);
          filteredStreams.push(copy);
        } else {
          if (storeId === 'local' && listable.storeId !== 'local') {
            // fetch stream structures for listables not in local and add it to the result
            const listableStreamAndChilds = await mall.streams.get(context.user.id, {
              id: listable.streamId,
              storeId: listable.storeId,
              childrenDepth: -1,
              includeTrashed: params.includeTrashed || params.state === 'all',
              excludedIds: context.access.getCannotListStreamsStreamIds(listable.storeId)
            });
            filteredStreams.push(...listableStreamAndChilds);
          }
        }
      }
      streams = filteredStreams;
    }
    // remove non visible parentIds from
    for (const rootStream of streams) {
      if (rootStream.parentId != null &&
                !(await context.access.canListStream(rootStream.parentId))) {
        rootStream.parentId = null;
      }
    }
    // if request was made on parentId .. return only the children
    if (params.parentId && streams.length === 1) {
      streams = streams[0].children;
    }
    if (isStreamIdPrefixBackwardCompatibilityActive &&
            !context.disableBackwardCompatibility) {
      streams = changePrefixIdForStreams(streams);
    }
    result.streams = streams;
    next();
  }
  async function includeDeletionsIfRequested (context, params, result, next) {
    if (params.includeDeletionsSince == null) {
      return next();
    }
    let streamId = params.id || params.parentId || '*';
    let storeId = params.storeId; // might me null
    if (storeId == null) {
      // TODO: clarify smelly code (replace full stream id with in-store id?)
      [storeId, streamId] = storeDataUtils.parseStoreIdAndStoreItemId(streamId);
    }
    try {
      const deletedStreams = await mall.streams.getDeletions(context.user.id, params.includeDeletionsSince, [storeId]);
      result.streamDeletions = deletedStreams;
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    return next();
  }
  // CREATION
  api.register(
    'streams.create',
    forbidSystemStreamsActions,
    commonFns.getParamsValidation(methodsSchema.create.params),
    applyDefaultsForCreation,
    applyPrerequisitesForCreation,
    createStream);

  function applyDefaultsForCreation (context, params, result, next) {
    params.parentId ??= null;
    next();
  }
  async function applyPrerequisitesForCreation (context, params, result, next) {
    if (!(await context.access.canCreateChildOnStream(params.parentId))) {
      return process.nextTick(next.bind(null, errors.forbidden()));
    }
    // check if parentId is valid
    if (params.parentId != null) {
      const parentResults = await mall.streams.get(context.user.id, {
        id: params.parentId,
        includeTrashed: true,
        childrenDepth: 1
      });
      if (parentResults.length === 0) {
        return next(errors.unknownReferencedResource('unknown Stream:', 'parentId', params.parentId, null));
      }
      if (parentResults[0].trashed != null) {
        // trashed parent
        return next(errors.invalidOperation('parent stream is trashed', 'parentId', params.parentId));
      }
    }
    // strip ignored properties
    if (Object.hasOwnProperty.call(params, 'children')) {
      delete params.children;
    }

    if (params.id) {
      const [storeId, streamId] = storeDataUtils.parseStoreIdAndStoreItemId(params.id);
      const slugId = slugify(streamId);
      if (string.isReservedId(streamId) || string.isReservedId(slugId)) {
        return process.nextTick(next.bind(null, errors.invalidItemId('The specified id "' + params.id + '" is not allowed.')));
      }
      params.id = storeDataUtils.getFullItemId(storeId, slugId);
    }
    context.initTrackingProperties(params);
    next();
  }
  async function createStream (context, params, result, next) {
    try {
      const newStream = await mall.streams.create(context.user.id, params);
      result.stream = newStream;
      pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_STREAMS_CHANGED);
      next();
    } catch (err) {
      // Already an API error
      if (err instanceof APIError) {
        return next(err);
      }
      return next(errors.unexpectedError(err));
    }
  }
  // UPDATE
  api.register('streams.update', forbidSystemStreamsActions, commonFns.getParamsValidation(methodsSchema.update.params), commonFns.catchForbiddenUpdate(streamSchema('update'), updatesSettings.ignoreProtectedFields, logger), applyPrerequisitesForUpdate, updateStream);
  /**
   * Forbid to create or modify system streams, or add children to them
   *
   * @param {*} context
   * @param {*} params
   * @param {*} result
   * @param {*} next
   */
  function forbidSystemStreamsActions (context, params, result, next) {
    if (params.id != null) {
      if (isStreamIdPrefixBackwardCompatibilityActive &&
                !context.disableBackwardCompatibility) {
        params.id = replaceWithNewPrefix(params.id);
      }
      if (SystemStreamsSerializer.isSystemStreamId(params.id)) {
        return next(errors.invalidOperation(ErrorMessages[ErrorIds.ForbiddenAccountStreamsModification]));
      }
    }
    if (params.parentId != null) {
      if (isStreamIdPrefixBackwardCompatibilityActive &&
                !context.disableBackwardCompatibility) {
        params.parentId = replaceWithNewPrefix(params.parentId);
      }
      if (SystemStreamsSerializer.isSystemStreamId(params.parentId)) {
        return next(errors.invalidOperation(ErrorMessages[ErrorIds.ForbiddenAccountStreamsModification]));
      }
    }
    next();
  }
  async function applyPrerequisitesForUpdate (context, params, result, next) {
    if (params?.update?.parentId === params.id) {
      return next(errors.invalidOperation('The provided "parentId" is the same as the stream\'s "id".', params.update));
    }
    // check stream
    const stream = await context.streamForStreamId(params.id);
    if (!stream) {
      return process.nextTick(next.bind(null, errors.unknownResource('stream', params.id)));
    }
    if (!(await context.access.canUpdateStream(stream.id))) {
      return process.nextTick(next.bind(null, errors.forbidden()));
    }
    // check parent (even if null for root )
    if (!(await context.access.canCreateChildOnStream(params.update.parentId))) {
      return process.nextTick(next.bind(null, errors.forbidden()));
    }
    // check target parent if needed
    if (params.update.parentId && params.update.parentId !== stream.parentId) {
      const targetParentArray = await mall.streams.get(context.user.id, {
        id: params.update.parentId,
        includeTrashed: true,
        childrenDepth: 1
      });
      if (targetParentArray.length === 0) {
        // no parent
        return next(errors.unknownReferencedResource('parent stream', 'parentId', params.update.parentId));
      }
      const targetParent = targetParentArray[0];
      if (targetParent.trashed != null) {
        // trashed parent
        return next(errors.invalidOperation('parent stream is trashed', 'parentId', params.update.parentId));
      }
      if (targetParent.children != null) {
        for (const child of targetParent.children) {
          if (child.name === params.update.name) {
            return next(errors.itemAlreadyExists('sibling stream', {
              name: params.update.name
            }));
          }
        }
      }
    }
    context.updateTrackingProperties(params.update);
    next();
  }
  async function updateStream (context, params, result, next) {
    try {
      const updateData = structuredClone(params.update);
      updateData.id = params.id;
      const updatedStream = await mall.streams.update(context.user.id, updateData);
      result.stream = updatedStream;
      pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_STREAMS_CHANGED);
      return next();
    } catch (err) {
      if (err instanceof APIError) {
        return next(err);
      }
      return next(errors.unexpectedError(err));
    }
  }
  // DELETION
  api.register('streams.delete', forbidSystemStreamsActions, commonFns.getParamsValidation(methodsSchema.del.params), verifyStreamExistenceAndPermissions, deleteStream);
  async function verifyStreamExistenceAndPermissions (context, params, result, next) {
    params.mergeEventsWithParent ??= null;
    context.stream = await context.streamForStreamId(params.id);
    if (context.stream == null) {
      return process.nextTick(next.bind(null, errors.unknownResource('stream', params.id)));
    }
    if (!(await context.access.canDeleteStream(context.stream.id))) {
      return process.nextTick(next.bind(null, errors.forbidden()));
    }
    next();
  }
  function deleteStream (context, params, result, next) {
    if (context.stream.trashed == null) {
      // move to trash
      flagAsTrashed(context, params, result, next);
    } else {
      // actually delete
      deleteWithData(context, params, result, next);
    }
  }
  async function flagAsTrashed (context, params, result, next) {
    const updatedData = { trashed: true };
    context.updateTrackingProperties(updatedData);
    updatedData.id = params.id;
    try {
      const updatedStream = await mall.streams.update(context.user.id, updatedData);
      result.stream = updatedStream;
      pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_STREAMS_CHANGED);
      return next();
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
  }
  async function deleteWithData (context, params, result, next) {
    const [storeId, storeStreamId] = storeDataUtils.parseStoreIdAndStoreItemId(params.id);
    // Load stream and chlidren (context.stream does not have expanded children tree)
    const streamToDeleteSingleArray = await mall.streams.get(context.user.id, {
      id: storeStreamId,
      includeTrashed: true,
      childrenDepth: -1,
      storeId
    });

    const streamToDelete = streamToDeleteSingleArray[0]; // no need to check existence: done before in verifyStreamExistenceAndPermissions
    const streamAndDescendantIds = treeUtils.collectPluckFromRootItem(streamToDelete, 'id');
    // keep stream and children to delete in next step
    context.streamToDeleteAndDescendantIds = streamAndDescendantIds;
    const parentId = streamToDelete.parentId;
    const cleanDescendantIds = streamAndDescendantIds.map((s) => storeDataUtils.parseStoreIdAndStoreItemId(s)[1]);
    // check if root stream and linked events exist
    if (params.mergeEventsWithParent === true && parentId == null) {
      return next(errors.invalidOperation('Deleting a root stream with mergeEventsWithParent=true is rejected ' +
                'since there is no parent stream to merge linked events in.', { streamId: params.id }));
    }
    const events = await mall.events.getWithParamsByStore(context.user.id, {
      [storeId]: { streams: [{ any: cleanDescendantIds }], limit: 1 }
    });

    const hasLinkedEvents = !!events.length;
    if (hasLinkedEvents) {
      // has linked events -----------------
      if (params.mergeEventsWithParent === null) {
        return next(errors.invalidParametersFormat('There are events referring to the deleted items ' +
                    'and the `mergeEventsWithParent` parameter is missing.'));
      }
    }

    // --- all tests are passed
    // --- create result streams and start send result as they come
    const updatedEventsStream = new ItemsStream();
    result.addStream('updatedEvents', updatedEventsStream);
    const singleItemDeletedStream = new ItemsStream();
    result.addStream('streamDeletion', singleItemDeletedStream, false);
    next(); // <== call next here to avoid await blocking

    if (hasLinkedEvents) {
      if (params.mergeEventsWithParent) {
        // -- Case 1 -- Merge events with parent
        // add parent stream Id if needed and remove deleted stream ids
        // the following add "parentId" if not present and remove "streamAndDescendantIds"
        const query = { streams: [{ any: streamAndDescendantIds }] };
        await mall.events.updateMany(context.user.id, query, {
          addStreams: [parentId],
          removeStreams: streamAndDescendantIds
        }, function (event) {
          if (event == null) return;
          updatedEventsStream.add({ action: 'mergedToParent', id: event.id });
        });
      } else {
        // case  mergeEventsWithParent = false
        const eventsStream = await mall.events.getStreamedWithParamsByStore(context.user.id, { [storeId]: { streams: [{ any: cleanDescendantIds }] } });
        for await (const event of eventsStream) {
          const remaningStreamsIds = _.difference(event.streamIds, streamAndDescendantIds);
          if (remaningStreamsIds.length === 0) { // no more streams deleted event
            await mall.events.delete(context.user.id, event);
            updatedEventsStream.add({ action: 'deleted', id: event.id });
          } else { // update event without these streams
            event.streamIds = remaningStreamsIds;
            await mall.events.update(context.user.id, event);
            updatedEventsStream.add({ action: 'updatedStreamIds', id: event.id });
          }
        }
      }
      pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_EVENTS_CHANGED);
    }
    updatedEventsStream.add(null); // close stream
    // finally delete stream
    for (const streamIdToDelete of context.streamToDeleteAndDescendantIds) {
      try {
        await mall.streams.delete(context.user.id, streamIdToDelete);
      } catch (err) {
        logger.error('Failed deleted some streams', err);
      }
    }
    singleItemDeletedStream.push({ id: params.id });
    singleItemDeletedStream.push(null); // close stream
    pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_STREAMS_CHANGED);
  }
};

class ItemsStream extends Readable {
  buffer;
  constructor () {
    super({ objectMode: true });
    this.buffer = [];
  }

  add (item) { this.push(item); }

  _read () {
    let push = true;
    while (this.buffer.length > 0 && push) {
      push = this.push(this.buffer.shift());
    }
  }
}
