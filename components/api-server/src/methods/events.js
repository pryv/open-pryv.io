/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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

const utils = require('utils');
const errors = require('errors').factory;
const async = require('async');
const fs = require('fs');
const commonFns = require('./helpers/commonFunctions');
const methodsSchema = require('../schema/eventsMethods');
const eventSchema = require('../schema/event');
const timestamp = require('unix-timestamp');
const _ = require('lodash');

const { getMall, storeDataUtils } = require('mall');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const { getUsersRepository } = require('business/src/users');
const ErrorIds = require('errors/src/ErrorIds');
const ErrorMessages = require('errors/src/ErrorMessages');
const APIError = require('errors/src/APIError');
const assert = require('assert');

const eventsGetUtils = require('./helpers/eventsGetUtils');

const { getAPIVersion } = require('middleware/src/project_version');

const { TypeRepository, isSeriesType } = require('business').types;

const { getLogger, getConfig } = require('@pryv/boiler');
const { getPlatform } = require('platform');

const { pubsub } = require('messages');

const CleanDeletedEventsStream = require('./streams/CleanDeletedEventsStream');

const BOTH_STREAMID_STREAMIDS_ERROR = 'It is forbidden to provide both "streamId" and "streamIds", please opt for "streamIds" only.';

const {
  convertStreamIdsToOldPrefixOnResult,
  changeMultipleStreamIdsPrefix,
  changeStreamIdsPrefixInStreamQuery,
  TAG_PREFIX,
  TAG_ROOT_STREAMID,
  replaceTagsWithStreamIds,
  putOldTags
} = require('./helpers/backwardCompatibility');
const { integrity } = require('business');

// Type repository that will contain information about what is allowed/known
// for events.
const typeRepo = new TypeRepository();

/**
 * Events API methods implementations.
 * @param api
 */
module.exports = async function (api) {
  const config = await getConfig();
  const authSettings = config.get('auth');
  const eventTypesUrl = config.get('service:eventTypes');
  const updatesSettings = config.get('updates');
  const openSourceSettings = config.get('openSource');
  const usersRepository = await getUsersRepository();
  const mall = await getMall();
  const platform = await getPlatform();
  await eventsGetUtils.init();

  // Initialise the project version as soon as we can.
  const version = await getAPIVersion();

  // Update types and log error
  typeRepo
    .tryUpdate(eventTypesUrl, version)
    .catch((err) => getLogger('typeRepo').warn(err));

  const logger = getLogger('methods:events');

  const STREAM_ID_ACTIVE = SystemStreamsSerializer.options.STREAM_ID_ACTIVE;

  const isStreamIdPrefixBackwardCompatibilityActive = config.get('backwardCompatibility:systemStreams:prefix:isActive');

  const isTagsBackwardCompatibilityActive = config.get('backwardCompatibility:tags:isActive');

  // RETRIEVAL

  api.register(
    'events.get',
    eventsGetUtils.coerceStreamsParam,
    commonFns.getParamsValidation(methodsSchema.get.params),
    eventsGetUtils.applyDefaultsForRetrieval,
    applyTagsDefaultsForRetrieval,
    eventsGetUtils.transformArrayOfStringsToStreamsQuery,
    eventsGetUtils.validateStreamsQueriesAndSetStore,
    changeStreamIdsPrefixInStreamQuery.bind(
      null,
      isStreamIdPrefixBackwardCompatibilityActive
    ), // using currying to pass "isStreamIdPrefixBackwardCompatibilityActive" argument
    eventsGetUtils.streamQueryCheckPermissionsAndReplaceStars,
    eventsGetUtils.streamQueryAddForcedAndForbiddenStreams,
    eventsGetUtils.streamQueryExpandStreams,
    eventsGetUtils.streamQueryAddHiddenStreams,
    migrateTagsToStreamQueries,
    eventsGetUtils.findEventsFromStore.bind(
      null,
      authSettings.filesReadTokenSecret,
      isStreamIdPrefixBackwardCompatibilityActive,
      isTagsBackwardCompatibilityActive
    ),
    includeLocalStorageDeletionsIfRequested
  );

  function applyTagsDefaultsForRetrieval (context, params, result, next) {
    if (!context.access.canGetEventsWithAnyTag()) {
      const accessibleTags = Object.keys(context.access.tagPermissionsMap);
      params.tags = params.tags
        ? _.intersection(params.tags, accessibleTags)
        : accessibleTags;
    }
    next();
  }
  /**
   * Backward compatibility for tags
   */
  function migrateTagsToStreamQueries (context, params, result, next) {
    if (!isTagsBackwardCompatibilityActive) { return next(); }
    if (params.tags == null) { return next(); }
    for (const query of params.arrayOfStreamQueriesWithStoreId) {
      if (query.storeId === 'local') {
        if (query.and == null) { query.and = []; }
        query.and.push({ any: params.tags.map((t) => TAG_PREFIX + t) });
      }
    }
    next();
  }
  async function includeLocalStorageDeletionsIfRequested (context, params, result, next) {
    if (params.modifiedSince == null || !params.includeDeletions) {
      return next();
    }
    const deletedEvents = await mall.events.getDeletionsStreamed('local', context.user.id, { deletedSince: params.modifiedSince },
      { limit: params.limit, skip: params.skip, sortAscending: params.sortAscending });
    // remove properties of events that shouldn't be exposed
    result.addStream('eventDeletions', deletedEvents.pipe(new CleanDeletedEventsStream()));
    next();
  }

  api.register(
    'events.getOne',
    commonFns.getParamsValidation(methodsSchema.getOne.params),
    findEvent,
    checkIfAuthorized,
    backwardCompatibilityOnResult,
    includeHistoryIfRequested
  );

  async function findEvent (context, params, result, next) {
    try {
      const event = await mall.events.getOne(context.user.id, params.id);
      if (event == null) { return next(errors.unknownResource('event', params.id)); }
      context.event = event;
      next();
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
  }
  async function checkIfAuthorized (context, params, result, next) {
    if (!context.event) { return next(); }
    const event = context.event;
    delete context.event;
    const systemStreamIdsForbiddenForReading = SystemStreamsSerializer.getAccountStreamsIdsForbiddenForReading();
    let canReadEvent = false;
    // special case no streamIds on event && deleted
    if (event.streamIds == null) { // event might be deleted - limit result to deleted property
      result.event = { id: event.id, deleted: event.deleted };
      return next();
    }

    for (const streamId of event.streamIds) {
      // ok if at least one
      if (systemStreamIdsForbiddenForReading.includes(streamId)) {
        canReadEvent = false;
        break;
      }
      if (await context.access.canGetEventsOnStreamAndWithTags(streamId, event.tags)) {
        canReadEvent = true;
      }
    }
    // might return 404 to avoid discovery of existing forbidden events
    if (!canReadEvent) { return next(errors.forbidden()); }
    event.attachments = setFileReadToken(context.access, event.attachments);
    // To remove when streamId not necessary
    event.streamId = event.streamIds[0];
    result.event = event;
    return next();
  }
  async function includeHistoryIfRequested (context, params, result, next) {
    if (!params.includeHistory) {
      return next();
    }
    // history is fetched in an extra step due to initial implementation,
    // now that mall.events.get return all in a single call, it coul be implement all at once
    try {
      const events = await mall.events.getHistory(context.user.id, params.id);
      result.history = [];
      events.forEach((e) => {
        // To remove when streamId not necessary
        _applyBackwardCompatibilityOnEvent(e, context);
        if (result.event.streamIds == null) { // event might be deleted - limit result to modified property
          result.event = { id: e.id, modified: e.modified };
        } else {
          result.history.push(e);
        }
      });
      next();
    } catch (err) {
      next(errors.unexpectedError(err));
    }
  }

  // -------------------------------------------------------------------- CREATE

  api.register(
    'events.create',
    commonFns.getParamsValidation(methodsSchema.create.params),
    normalizeStreamIdAndStreamIds,
    applyPrerequisitesForCreation,
    createStreamsForTagsIfNeeded,
    validateEventContentAndCoerce,
    verifycanCreateEventsOnStreamAndWIthTags,
    doesEventBelongToAccountStream,
    validateSystemStreamsContent,
    validateAccountStreamsForCreation,
    appendAccountStreamsDataForCreation,
    createOnPlatform,
    handleSeries,
    createEvent,
    removeActiveFromSibling,
    backwardCompatibilityOnResult,
    addIntegrityToContext,
    notify
  );

  function applyPrerequisitesForCreation (context, params, result, next) {
    const event = context.newEvent;
    // default time is now
    event.time ??= timestamp.now();
    if (event.tags == null) {
      event.tags = [];
    }
    event.tags = cleanupEventTags(event.tags);
    context.initTrackingProperties(event);
    context.newEvent = event;
    next();
  }
  /**
   * Check if previous event (or "new event" for events creation) belongs to the account
   * streams
   *
   * @param {*} context
   * @param {*} params
   * @param {*} result
   * @param {*} next
   */
  function doesEventBelongToAccountStream (context, params, result, next) {
    const allAccountStreamsIds = SystemStreamsSerializer.getAccountStreamIds();
    const isUpdate = context.oldEvent != null && context.newEvent != null;
    const isDelete = context.oldEvent != null && context.newEvent == null;
    if (isUpdate) {
      context.oldAccountStreamIds = _.intersection(allAccountStreamsIds, context.oldEvent.streamIds); // rename to oldEvent/newEvent
      context.accountStreamIds = _.intersection(allAccountStreamsIds, context.newEvent.streamIds);
      context.doesEventBelongToAccountStream =
                context.oldAccountStreamIds.length > 0;
    } else if (isDelete) {
      context.oldAccountStreamIds = _.intersection(allAccountStreamsIds, context.oldEvent.streamIds);
      context.doesEventBelongToAccountStream =
                context.oldAccountStreamIds.length > 0;
    } else {
      context.accountStreamIds = _.intersection(allAccountStreamsIds, context.newEvent.streamIds);
      context.doesEventBelongToAccountStream =
                context.accountStreamIds.length > 0;
    }
    next();
  }
  /**
   *
   */
  function validateAccountStreamsForCreation (context, params, result, next) {
    if (!context.doesEventBelongToAccountStream) { return next(); }
    throwIfUserTriesToAddMultipleAccountStreamIds(context.accountStreamIds); // assert context.accountStreamIds.length === 1 - probably OK for mixing custom and account
    context.accountStreamId = context.accountStreamIds[0];
    throwIfStreamIdIsNotEditable(context.accountStreamId);
    next();
  }
  async function verifycanCreateEventsOnStreamAndWIthTags (context, params, result, next) {
    for (const streamId of context.newEvent.streamIds) {
      // refuse if any context is not accessible
      if (!(await context.access.canCreateEventsOnStreamAndWIthTags(streamId, context.newEvent.tags))) {
        return next(errors.forbidden());
      }
    }
    next();
  }
  /**
   * Do additional actions if event belongs to account stream
   */
  async function appendAccountStreamsDataForCreation (context, params, result, next) {
    if (!context.doesEventBelongToAccountStream) {
      return next();
    }
    const editableAccountStreamsMap = SystemStreamsSerializer.getEditableAccountMap();
    context.accountStreamIdWithoutPrefix =
            SystemStreamsSerializer.removePrefixFromStreamId(context.accountStreamId);
    context.systemStream = editableAccountStreamsMap[context.accountStreamId];
    // when new account event is created, all other should be marked as nonactive
    context.newEvent.streamIds.push(STREAM_ID_ACTIVE);
    context.removeActiveEvents = true;
    context.newEvent.streamIds = addUniqueStreamIdIfNeeded(context.newEvent.streamIds, context.systemStream.isUnique);
    next();
  }
  /**
   * register this new information on the platform
   */
  async function createOnPlatform (context, params, result, next) {
    if (!context.doesEventBelongToAccountStream) {
      return next();
    }
    try {
      if (context.systemStream.isIndexed) {
        // assume can be unique as per test #42A1
        const isActive = context.newEvent.streamIds.includes(STREAM_ID_ACTIVE) ||
                    context.oldEvent.streamIds.includes(STREAM_ID_ACTIVE);
        const operations = [
          {
            action: 'create',
            key: context.accountStreamIdWithoutPrefix,
            value: context.newEvent.content,
            isUnique: context.systemStream.isUnique,
            isActive
          }
        ];
        await platform.updateUserAndForward(context.user.username, operations);
      }
    } catch (err) {
      return next(err);
    }
    next();
  }
  /**
   * register this new information on the platform
   */
  async function updateOnPlatform (context, params, result, next) {
    if (!context.doesEventBelongToAccountStream) {
      return next();
    }
    try {
      if (context.systemStream.isIndexed) {
        // assume can be unique as per test #42A1
        const operations = [
          {
            action: 'update',
            key: context.accountStreamIdWithoutPrefix,
            value: context.newEvent.content,
            previousValue: context.oldEvent.content,
            isUnique: context.systemStream.isUnique,
            isActive: context.newEvent.streamIds.includes(STREAM_ID_ACTIVE) ||
                            context.oldEvent.streamIds.includes(STREAM_ID_ACTIVE)
          }
        ];
        await platform.updateUserAndForward(context.user.username, operations);
      }
    } catch (err) {
      return next(err);
    }
    next();
  }
  function handleSeries (context, params, result, next) {
    if (isSeriesType(context.newEvent.type)) {
      if (openSourceSettings.isActive) {
        return next(errors.unavailableMethod());
      }
      try {
        context.newEvent.content = createSeriesEventContent(context);
      } catch (err) {
        return next(err);
      }
      // As long as there is no data, event duration is considered to be 0.
      context.newEvent.duration = 0;
    }
    next();
  }
  async function createEvent (context, params, result, next) {
    let newEvent = null;
    // if event has attachments
    const files = sanitizeRequestFiles(params.files);
    delete params.files;
    if (files != null && files.length > 0) {
      const attachmentItems = [];
      for (const file of files) {
        attachmentItems.push({
          fileName: file.originalname,
          type: file.mimetype,
          size: file.size,
          integrity: file.integrity,
          attachmentData: fs.createReadStream(file.path) // simulate full pass-thru of attachement until implemented
        });
      }
      try {
        newEvent = await mall.events.createWithAttachments(context.user.id, context.newEvent, attachmentItems);
        newEvent.attachments = setFileReadToken(context.access, newEvent.attachments);
      } catch (err) {
        if (err instanceof APIError) { return next(err); }
        return next(errors.unexpectedError(err));
      }
    } else {
      try {
        newEvent = await mall.events.create(context.user.id, context.newEvent);
      } catch (err) {
        if (err instanceof APIError) { return next(err); }
        return next(errors.unexpectedError(err));
      }
    }
    // To remove when streamId not necessary
    newEvent.streamId = newEvent.streamIds[0];
    result.event = newEvent;
    return next();
  }
  function backwardCompatibilityOnResult (context, params, result, next) {
    if (result.event != null) { _applyBackwardCompatibilityOnEvent(result.event, context); }
    next();
  }
  function _applyBackwardCompatibilityOnEvent (event, context) {
    if (isStreamIdPrefixBackwardCompatibilityActive && !context.disableBackwardCompatibility) {
      convertStreamIdsToOldPrefixOnResult(event);
    }
    if (isTagsBackwardCompatibilityActive) { event = putOldTags(event); }
    event.streamId = event.streamIds[0];
  }
  function addUniqueStreamIdIfNeeded (streamIds, isUnique) {
    if (!isUnique) {
      return streamIds;
    }
    if (!streamIds.includes(SystemStreamsSerializer.options.STREAM_ID_UNIQUE)) {
      streamIds.push(SystemStreamsSerializer.options.STREAM_ID_UNIQUE);
    }
    return streamIds;
  }
  /**
   * Creates the event's body according to its type and context.
   */
  function createSeriesEventContent (context) {
    const seriesTypeName = context.newEvent.type;
    const eventType = typeRepo.lookup(seriesTypeName);
    // assert: Type is a series type, so this should be always true:
    assert.ok(eventType.isSeries());
    return {
      elementType: eventType.elementTypeName(),
      fields: eventType.fields(),
      required: eventType.requiredFields()
    };
  }
  function addIntegrityToContext (context, params, result, next) {
    if (result?.event?.integrity != null) {
      context.auditIntegrityPayload = {
        key: integrity.events.key(result.event),
        integrity: result.event.integrity
      };
      if (process.env.NODE_ENV === 'test' &&
                !openSourceSettings.isActive &&
                integrity.events.isActive) {
        // double check integrity when running tests only
        if (result.event.integrity !== integrity.events.hash(result.event)) {
          return next(new Error('integrity mismatch' + JSON.stringify(result.event)));
        }
      }
    }
    next();
  }

  // -------------------------------------------------------------------- UPDATE

  api.register(
    'events.update',
    commonFns.getParamsValidation(methodsSchema.update.params),
    commonFns.catchForbiddenUpdate(eventSchema('update'),
      updatesSettings.ignoreProtectedFields, logger),
    normalizeStreamIdAndStreamIds,
    applyPrerequisitesForUpdate,
    createStreamsForTagsIfNeeded,
    validateEventContentAndCoerce,
    doesEventBelongToAccountStream,
    validateSystemStreamsContent,
    validateAccountStreamsForUpdate,
    appendAccountStreamsDataForUpdate,
    updateOnPlatform,
    updateEvent,
    backwardCompatibilityOnResult,
    removeActiveFromSibling,
    addIntegrityToContext,
    notify
  );

  async function applyPrerequisitesForUpdate (context, params, result, next) {
    const eventUpdate = context.newEvent;
    try {
      eventUpdate.tags = cleanupEventTags(eventUpdate.tags);
    } catch (err) {
      return next(err);
    }
    context.updateTrackingProperties(eventUpdate);
    let event;
    try {
      event = await mall.events.getOne(context.user.id, params.id);
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    if (!event) {
      return next(errors.unknownResource('event', params.id));
    }
    // 1. check that have contributeContext on at least 1 existing streamId
    let canUpdateEvent = false;
    for (let i = 0; i < event.streamIds.length; i++) {
      if (await context.access.canUpdateEventsOnStreamAndWIthTags(event.streamIds[i], event.tags)) {
        canUpdateEvent = true;
        break;
      }
    }
    if (!canUpdateEvent) { return next(errors.forbidden()); }
    if (hasStreamIdsModification(eventUpdate)) {
      // 2. check that streams we add have contribute access
      const streamIdsToAdd = _.difference(eventUpdate.streamIds, event.streamIds);
      for (const streamIdToAdd of streamIdsToAdd) {
        if (!(await context.access.canUpdateEventsOnStreamAndWIthTags(streamIdToAdd, event.tags))) {
          return next(errors.forbidden());
        }
      }
      // 3. check that streams we remove have contribute access
      // streamsToRemove = event.streamIds - eventUpdate.streamIds
      const streamIdsToRemove = _.difference(event.streamIds, eventUpdate.streamIds);
      for (const streamIdToRemove of streamIdsToRemove) {
        if (!(await context.access.canUpdateEventsOnStreamAndWIthTags(streamIdToRemove, event.tags))) {
          return next(errors.forbidden());
        }
      }
    }
    const updatedEventType = eventUpdate.type;
    if (updatedEventType != null) {
      const currentEventType = event.type;
      const isCurrentEventTypeSeries = isSeriesType(currentEventType);
      const isUpdatedEventTypeSeries = isSeriesType(updatedEventType);
      if (!typeRepo.isKnown(updatedEventType) && isUpdatedEventTypeSeries) {
        return next(errors.invalidEventType(updatedEventType)); // We forbid the 'series' prefix for these free types.
      }
      if ((isCurrentEventTypeSeries && !isUpdatedEventTypeSeries) ||
                (!isCurrentEventTypeSeries && isUpdatedEventTypeSeries)) {
        return next(errors.invalidOperation('Normal events cannot be updated to HF-events and vice versa.'));
      }
    }
    context.oldEvent = structuredClone(event);
    context.newEvent = _.extend(event, eventUpdate);
    // clientData key-map handling
    if (eventUpdate.clientData != null) {
      context.newEvent.clientData = structuredClone(context.oldEvent.clientData || {});
      for (const [key, value] of Object.entries(eventUpdate.clientData)) {
        if (value == null) {
          // delete keys with null value
          delete context.newEvent.clientData[key];
        } else {
          // update or add keys
          context.newEvent.clientData[key] = value;
        }
      }
    }
    next();
    function hasStreamIdsModification (event) {
      return event.streamIds != null;
    }
  }
  /**
   * Do additional actions if event belongs to account stream
   */
  async function appendAccountStreamsDataForUpdate (context, params, result, next) {
    if (!context.doesEventBelongToAccountStream) {
      return next();
    }
    const editableAccountStreamsMap = SystemStreamsSerializer.getEditableAccountMap();
    context.accountStreamIdWithoutPrefix =
            SystemStreamsSerializer.removePrefixFromStreamId(context.accountStreamId);
    context.systemStream = editableAccountStreamsMap[context.accountStreamId];
    if (hasBecomeActive(context.oldEvent.streamIds, context.newEvent.streamIds)) {
      context.removeActiveEvents = true;
    } else {
      context.removeActiveEvents = false;
    }
    next();
  }
  async function updateEvent (context, params, result, next) {
    try {
      // deals with attachments if any
      const files = sanitizeRequestFiles(params.files);
      delete params.files;
      if (files != null && files.length > 0) {
        let eventWithUpdatedAttachments = null;
        for (const file of files) {
          const attachmentItem = {
            fileName: file.originalname,
            type: file.mimetype,
            size: file.size,
            integrity: file.integrity,
            attachmentData: fs.createReadStream(file.path) // simulate full pass-thru of attachement until implemented
          };
          eventWithUpdatedAttachments = await mall.events.addAttachment(context.user.id, context.newEvent.id, attachmentItem);
          // update attachments property of newEvent
          context.newEvent.attachments = eventWithUpdatedAttachments.attachments;
        }
      }
      // -- update the event (to save tacking properties and recalculate integrity)
      const updatedEvent = await mall.events.update(context.user.id, context.newEvent);

      updatedEvent.attachments = setFileReadToken(context.access, updatedEvent.attachments);
      updatedEvent.streamId = updatedEvent.streamIds[0];
      result.event = updatedEvent;
      next();
    } catch (e) {
      next(e);
    }
  }
  /**
   * For account streams - 'active' streamId defines the 'main' event
   * from of the stream. If there are many events (like many emails),
   * only one should be main/active
   */
  async function removeActiveFromSibling (context, params, result, next) {
    if (!context.removeActiveEvents) {
      return next();
    }
    const query = {
      streams: [
        { any: [context.accountStreamId], and: [{ any: [STREAM_ID_ACTIVE] }] }
      ]
    };
    const filter = function (eventData) {
      return eventData.id !== result.event.id;
    };
    await mall.events.updateMany(context.user.id, query, {
      filter,
      removeStreams: [STREAM_ID_ACTIVE]
    });
    next();
  }
  function notify (context, params, result, next) {
    pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_EVENTS_CHANGED);
    // notify is called by create, update and delete
    // depending on the case the event properties will be found in context or event
    if (isSeriesEvent(context.event || result.event) &&
            !openSourceSettings.isActive) {
      const isDelete = !!result.eventDeletion;
      // if event is a deletion 'id' is given by result.eventDeletion
      const updatedEventId = isDelete
        ? _.pick(result.eventDeletion, ['id'])
        : _.pick(result.event, ['id']);
      const subject = isDelete
        ? pubsub.SERIES_DELETE_EVENTID_USERNAME
        : pubsub.SERIES_UPDATE_EVENTID_USERNAME;
      const payload = {
        username: context.user.username,
        event: updatedEventId
      };
      pubsub.series.emit(subject, payload);
    }
    function isSeriesEvent (event) {
      return event.type.startsWith('series:');
    }
    next();
  }
  /**
   * Fixes req.files structure for when attachments were sent without a filename, in which case
   * Express lists files as an array in a `file` property (instead of directly as properties).
   *
   * @param {Object} files
   * @returns {Object}
   */
  function sanitizeRequestFiles (files) {
    if (!files || !files.file || !Array.isArray(files.file)) {
      // assume files is an object, nothing to do
      return files;
    }
    const result = {};
    files.file.forEach(function (item, i) {
      if (!item.filename) {
        item.filename = item.name;
      }
      result[i] = item;
    });
    return result;
  }
  async function normalizeStreamIdAndStreamIds (context, params, result, next) {
    const event = isEventsUpdateMethod() ? params.update : params;
    // forbid providing both streamId and streamIds
    if (event.streamId != null && event.streamIds != null) {
      return next(errors.invalidOperation(BOTH_STREAMID_STREAMIDS_ERROR, {
        streamId: event.streamId,
        event: params.streamIds
      }));
    }
    // convert streamId to streamIds #streamIds
    if (event.streamId != null) {
      event.streamIds = [event.streamId];
    }
    // remove double entries from streamIds
    if (event.streamIds != null && event.streamIds.length > 1) {
      event.streamIds = [...new Set(event.streamIds)];
    }
    delete event.streamId;
    // using context.newEvent now - not params
    context.newEvent = event;
    // used only in the events creation and update
    if (event.streamIds != null && event.streamIds.length > 0) {
      if (isStreamIdPrefixBackwardCompatibilityActive &&
                !context.disableBackwardCompatibility) {
        event.streamIds = changeMultipleStreamIdsPrefix(event.streamIds, false);
      }
      const streamIdsNotFoundList = [];
      const streamIdsTrashed = [];
      for (const fullStreamId of event.streamIds) {
        const [storeId, streamId] = storeDataUtils.parseStoreIdAndStoreItemId(fullStreamId);
        const stream = await context.streamForStreamId(streamId, storeId);
        if (!stream) {
          streamIdsNotFoundList.push(streamId);
        } else if (stream.trashed) {
          streamIdsTrashed.push(streamId);
        }
      }
      if (streamIdsNotFoundList.length > 0) {
        return next(errors.unknownReferencedResource('stream', 'streamIds', streamIdsNotFoundList));
      }
      if (streamIdsTrashed.length > 0) {
        return next(errors.invalidOperation('The referenced streams "' + streamIdsTrashed + '" are trashed.', { trashedReference: 'streamIds' }));
      }
    }
    next();
    function isEventsUpdateMethod () {
      return params.update != null;
    }
  }
  /**
   * Validates the event's content against its type (if known).
   * Will try casting string content to number if appropriate.
   *
   * @param {Object} context.newEvent contains the event data
   * @param {Object} params
   * @param {Object} result
   * @param {Function} next
   */
  async function validateEventContentAndCoerce (context, params, result, next) {
    const type = context.newEvent.type;
    if (isTagsBackwardCompatibilityActive) { context.newEvent = replaceTagsWithStreamIds(context.newEvent); }
    // Unknown types can just be created as normal events.
    if (!typeRepo.isKnown(type)) {
      // We forbid the 'series' prefix for these free types.
      if (isSeriesType(type)) { return next(errors.invalidEventType(type)); }
      // No further checks, let the user do what he wants.
      return next();
    }
    // assert: `type` is known
    if (isSeriesType(type)) {
      // Series cannot have content on update, not here at least.
      if (isCreateSeriesAndHasContent(params) ||
                isUpdateSeriesAndHasContent(params)) {
        return next(errors.invalidParametersFormat("The event content's format is invalid.", 'Events of type High-frequency have a read-only content'));
      }
      return next();
    }
    try {
      await typeRepo.validate(context.newEvent);
      next();
    } catch (err) {
      next(errors.invalidParametersFormat("The event content's format is invalid.", err));
    }
    function isCreateSeriesAndHasContent (params) {
      return params.content != null;
    }
    function isUpdateSeriesAndHasContent (params) {
      return params.update != null && params.update.content != null;
    }
  }
  function validateSystemStreamsContent (context, params, result, next) {
    if (!context.doesEventBelongToAccountStream) { return next(); }
    if (context.newEvent == null) { return next(); }
    const acceptedIndexedTypes = [
      'number',
      'string',
      'undefined'
    ];
    const contentType = typeof context.newEvent.content;
    if (!acceptedIndexedTypes.includes(contentType)) { return next(errors.invalidParametersFormat(ErrorMessages.IndexedParameterInvalidFormat, params)); }
    return next();
  }
  /**
   * If they don't exist, create the streams for the present tags
   */
  async function createStreamsForTagsIfNeeded (context, params, result, next) {
    if (!isTagsBackwardCompatibilityActive) { return next(); }
    const tags = context.newEvent.tags;
    if (tags == null || tags.length === 0) { return next(); }
    const streamsToTest = [
      { id: TAG_ROOT_STREAMID, name: 'Migrated tags', parentId: null }
    ];
    for (const tag of tags) {
      streamsToTest.push({
        id: TAG_PREFIX + tag,
        name: tag,
        parentId: TAG_ROOT_STREAMID
      });
    }
    const streamIdsCreated = [];
    for (const streamData of streamsToTest) {
      const stream = await context.streamForStreamId(streamData.id, 'local');
      if (stream == null) {
        await mall.streams.create(context.user.id, streamData);
        streamIdsCreated.push(streamData.id);
      }
    }
    if (streamIdsCreated.length > 0) { logger.info('backward compatibility: created streams for tags: ' + streamIdsCreated); }
    next();
  }
  function throwIfStreamIdIsNotEditable (accountStreamId) {
    const editableAccountMap = SystemStreamsSerializer.getEditableAccountMap();
    if (editableAccountMap[accountStreamId] == null) {
      throw errors.invalidOperation(ErrorMessages[ErrorIds.ForbiddenAccountEventModification], { streamId: accountStreamId });
    }
  }
  function throwIfUserTriesToAddMultipleAccountStreamIds (accountStreamIds) {
    if (accountStreamIds.length > 1) {
      throw errors.invalidOperation(ErrorMessages[ErrorIds.ForbiddenMultipleAccountStreams], { streamIds: accountStreamIds });
    }
  }
  /**
   * Check if event belongs to account stream,
   * if yes, validate and prepend context with the properties that will be
   * used later like:
   * a) doesEventBelongToAccountStream: boolean
   * b) oldEventStreamIds: array<string>
   * c) accountStreamId - string - account streamId
   *
   * @param {*} context
   * @param {*} params
   * @param {*} result
   * @param {*} next
   */
  function validateAccountStreamsForUpdate (context, params, result, next) {
    if (!context.doesEventBelongToAccountStream) { return next(); }
    throwIfUserTriesToAddMultipleAccountStreamIds(context.accountStreamIds); // assert context.accountStreamIds.length === 1
    context.accountStreamId = context.accountStreamIds[0];
    context.oldAccountStreamIds.forEach((streamId) => {
      throwIfStreamIdIsNotEditable(streamId);
    });
    throwIfRemoveAccountStreamId(context.oldAccountStreamIds, context.accountStreamIds);
    throwIfChangeAccountStreamId(context.oldAccountStreamIds, context.accountStreamId);
    next();
    function throwIfRemoveAccountStreamId (accountStreamIds, currentStreamIds) {
      if (_.difference(accountStreamIds, currentStreamIds).length > 0) {
        throw errors.invalidOperation(ErrorMessages[ErrorIds.ForbiddenToChangeAccountStreamId]);
      }
    }
    function throwIfChangeAccountStreamId (oldAccountStreamIds, accountStreamId) {
      if (!oldAccountStreamIds.includes(accountStreamId)) {
        throw errors.invalidOperation(ErrorMessages[ErrorIds.ForbiddenToChangeAccountStreamId]);
      }
    }
  }
  function cleanupEventTags (tags) {
    if (tags == null) { return []; }
    const limit = 500;
    tags = tags
      .map(function (tag) {
        if (tag.length > limit) {
          throw errors.invalidParametersFormat('The event contains a tag that exceeds the size limit of ' +
                    limit +
                    ' characters.', tag);
        }
        return tag.trim();
      })
      .filter(function (tag) {
        return tag.length > 0;
      });
    return tags;
  }

  // DELETION

  api.register(
    'events.delete',
    commonFns.getParamsValidation(methodsSchema.del.params),
    checkEventForDelete,
    doesEventBelongToAccountStream,
    validateAccountStreamsForDeletion,
    function (context, params, result, next) {
      if (!context.oldEvent.trashed) {
        // move to trash
        flagAsTrashed(context, params, result, next);
      } else {
        // actually delete
        deleteWithData(context, params, result, next);
      }
    },
    notify
  );

  /**
   * If event belongs to the account stream
   * send update to service-register if needed
   *
   * @param object user {id: '', username: ''}
   * @param object event
   * @param string accountStreamId - accountStreamId
   */
  async function updateDeletionOnPlatform (username, content, accountStreamId) {
    const editableAccountStreamsMap = SystemStreamsSerializer.getEditableAccountMap();
    const streamIdWithoutPrefix = SystemStreamsSerializer.removePrefixFromStreamId(accountStreamId);
    if (editableAccountStreamsMap[accountStreamId].isUnique) {
      // TODO should be isIndexed??
      const operations = [
        {
          action: 'delete',
          key: streamIdWithoutPrefix,
          value: content,
          isUnique: true
        }
      ];
      await platform.updateUserAndForward(username, operations);
    }
  }
  async function flagAsTrashed (context, params, result, next) {
    const newEvent = structuredClone(context.oldEvent);
    newEvent.trashed = true;
    context.updateTrackingProperties(newEvent);
    if (context.doesEventBelongToAccountStream) {
      await updateDeletionOnPlatform(context.user.username, context.oldEvent.content, context.accountStreamId);
    }
    const updatedEvent = await mall.events.update(context.user.id, newEvent);

    _applyBackwardCompatibilityOnEvent(updatedEvent, context);
    result.event = updatedEvent;
    result.event.attachments = setFileReadToken(context.access, result.event.attachments);
    next();
  }
  function deleteWithData (context, params, result, next) {
    async.series([
      async function deleteEvent () {
        await mall.events.delete(context.user.id, context.oldEvent);
        result.eventDeletion = { id: params.id };
      },
      async function updateStorage () {
        const storagedUsed = await usersRepository.getStorageUsedByUserId(context.user.id);
        // If needed, approximately update account storage size
        if (!storagedUsed || !storagedUsed.attachedFiles) {
          return;
        }
        storagedUsed.attachedFiles -= getTotalAttachmentsSize(context.event.attachments);
        await usersRepository.updateOne(context.user, storagedUsed, 'system');
      }
    ], next);
  }
  function getTotalAttachmentsSize (attachments) {
    if (attachments == null) {
      return 0;
    }
    return _.reduce(attachments, function (evtTotal, att) {
      return evtTotal + att.size;
    }, 0);
  }

  api.register(
    'events.deleteAttachment',
    commonFns.getParamsValidation(methodsSchema.deleteAttachment.params),
    checkEventForDelete,
    deleteAttachment,
    backwardCompatibilityOnResult
  );

  async function deleteAttachment (context, params, result, next) {
    const attIndex = getAttachmentIndex(context.event.attachments, params.fileId);
    if (attIndex === -1) {
      return next(errors.unknownResource('attachment', params.fileId));
    }
    const deletedAtt = context.event.attachments[attIndex];
    const eventDataWithDeletedAttach = await mall.events.deleteAttachment(context.user.id, context.event.id, params.fileId);

    // update tracking properties on event
    context.updateTrackingProperties(eventDataWithDeletedAttach);
    const newEvent = await mall.events.update(context.user.id, eventDataWithDeletedAttach);

    // To remove when streamId not necessary
    newEvent.streamId = newEvent.streamIds[0];
    result.event = newEvent;
    result.event.attachments = setFileReadToken(context.access, result.event.attachments);
    const storagedUsed = await usersRepository.getStorageUsedByUserId(context.user.id);
    // approximately update account storage size
    storagedUsed.attachedFiles -= deletedAtt.size;
    await usersRepository.updateOne(context.user, storagedUsed, 'system');
    pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_EVENTS_CHANGED);
    next();
  }
  async function checkEventForDelete (context, params, result, next) {
    const eventId = params.id;
    let event;
    try {
      event = await mall.events.getOne(context.user.id, eventId);
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    if (event == null) {
      return next(errors.unknownResource('event', eventId));
    }
    let canDeleteEvent = false;
    for (const streamId of event.streamIds) {
      if (await context.access.canUpdateEventsOnStreamAndWIthTags(streamId, event.tags)) {
        canDeleteEvent = true;
        break;
      }
    }
    if (!canDeleteEvent) { return next(errors.forbidden()); }
    // save event from the database as an oldEvent
    context.oldEvent = event;
    // create an event object that could be modified
    context.event = structuredClone(event);
    next();
  }
  /**
   * Check if event should not be allowed for deletion
   * a) is not editable
   * b) is active
   */
  function validateAccountStreamsForDeletion (context, params, result, next) {
    if (!context.doesEventBelongToAccountStream) {
      return next();
    }
    context.oldAccountStreamIds.forEach((streamId) => {
      throwIfStreamIdIsNotEditable(streamId);
    });
    if (context.oldEvent.streamIds.includes(STREAM_ID_ACTIVE)) { return next(errors.invalidOperation(ErrorMessages[ErrorIds.ForbiddenAccountEventModification])); }
    context.accountStreamId = context.oldAccountStreamIds[0];
    next();
  }
  /**
   * Returns the key of the attachment with the given file name.
   */
  function getAttachmentIndex (attachments, fileId) {
    return _.findIndex(attachments, function (att) {
      return att.id === fileId;
    });
  }
  /**
   * Sets the file read token for each of the given event's attachments (if any) for the given
   * access.
   *
   * @param access
   * @param attachments
   */
  function setFileReadToken (access, attachments) {
    if (attachments == null) {
      return;
    }
    attachments.forEach(function (att) {
      att.readToken = utils.encryption.fileReadToken(att.id, access.id, access.token, authSettings.filesReadTokenSecret);
    });
    return attachments;
  }
  function hasBecomeActive (oldStreamIds, newSreamIds) {
    return (!oldStreamIds.includes(STREAM_ID_ACTIVE) &&
            newSreamIds.includes(STREAM_ID_ACTIVE));
  }
};
