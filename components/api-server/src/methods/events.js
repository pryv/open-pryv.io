/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
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
const accountStreams = require('business/src/system-streams');
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

  // RETRIEVAL

  api.register(
    'events.get',
    eventsGetUtils.coerceStreamsParam,
    commonFns.getParamsValidation(methodsSchema.get.params),
    eventsGetUtils.applyDefaultsForRetrieval,
    eventsGetUtils.transformArrayOfStringsToStreamsQuery,
    eventsGetUtils.validateStreamsQueriesAndSetStore,
    eventsGetUtils.streamQueryCheckPermissionsAndReplaceStars,
    eventsGetUtils.streamQueryAddForcedAndForbiddenStreams,
    eventsGetUtils.streamQueryExpandStreams,
    eventsGetUtils.streamQueryAddHiddenStreams,
    eventsGetUtils.findEventsFromStore.bind(
      null,
      authSettings.filesReadTokenSecret
    ),
    includeLocalStorageDeletionsIfRequested
  );

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
    const systemStreamIdsForbiddenForReading = accountStreams.hiddenStreamIds;
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
      if (await context.access.canGetEventsOnStream(streamId, 'local')) {
        canReadEvent = true;
      }
    }
    // might return 404 to avoid discovery of existing forbidden events
    if (!canReadEvent) { return next(errors.forbidden()); }
    event.attachments = setFileReadToken(context.access, event.attachments);
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
    validateEventContentAndCoerce,
    verifyCanCreateEventsOnStream,
    detectAccountStream,
    validateAccountStreamForCreate,
    validateAccountStreamContent,
    notifyPlatformForCreate,
    handleSeries,
    createEvent,
    addIntegrityToContext,
    notify
  );

  function applyPrerequisitesForCreation (context, params, result, next) {
    const event = context.newEvent;
    // default time is now
    event.time ??= timestamp.now();
    context.initTrackingProperties(event);
    context.newEvent = event;
    next();
  }
  async function verifyCanCreateEventsOnStream (context, params, result, next) {
    for (const streamId of context.newEvent.streamIds) {
      // refuse if any context is not accessible
      if (!(await context.access.canCreateEventsOnStream(streamId))) {
        return next(errors.forbidden());
      }
    }
    next();
  }

  // ---- Account stream middleware (simplified: no active/unique markers) ----

  /**
   * Detect if event belongs to an account stream. Sets context flags
   * used by subsequent account middleware (shared by create and update).
   */
  function detectAccountStream (context, params, result, next) {
    const allAccountStreamIds = Object.keys(accountStreams.accountMap);
    const streamIds = context.newEvent.streamIds || [];
    const oldStreamIds = context.oldEvent ? context.oldEvent.streamIds : [];
    context.accountStreamIds = _.intersection(allAccountStreamIds, streamIds);
    context.oldAccountStreamIds = _.intersection(allAccountStreamIds, oldStreamIds);
    context.doesEventBelongToAccountStream =
      context.accountStreamIds.length > 0 || context.oldAccountStreamIds.length > 0;
    next();
  }

  /**
   * Validate account stream constraints for event creation:
   * - Only one account stream ID per event
   * - Stream must be editable
   */
  function validateAccountStreamForCreate (context, params, result, next) {
    if (!context.doesEventBelongToAccountStream) return next();
    if (context.accountStreamIds.length > 1) {
      return next(errors.invalidOperation(
        ErrorMessages[ErrorIds.ForbiddenMultipleAccountStreams],
        { streamIds: context.accountStreamIds }
      ));
    }
    context.accountStreamId = context.accountStreamIds[0];
    const streamConfig = accountStreams.accountMap[context.accountStreamId];
    if (!streamConfig?.isEditable) {
      return next(errors.invalidOperation(
        ErrorMessages[ErrorIds.ForbiddenAccountEventModification],
        { streamId: context.accountStreamId }
      ));
    }
    context.systemStream = streamConfig;
    context.accountStreamIdWithoutPrefix =
      accountStreams.toFieldName(context.accountStreamId);
    next();
  }

  /**
   * Validate account stream constraints for event update:
   * - Cannot add multiple account stream IDs
   * - Cannot change from one account stream to another
   * - Stream must be editable
   */
  function validateAccountStreamForUpdate (context, params, result, next) {
    if (!context.doesEventBelongToAccountStream) return next();
    const activeStreamIds = context.accountStreamIds.length > 0
      ? context.accountStreamIds
      : context.oldAccountStreamIds;
    if (activeStreamIds.length > 1) {
      return next(errors.invalidOperation(
        ErrorMessages[ErrorIds.ForbiddenMultipleAccountStreams],
        { streamIds: activeStreamIds }
      ));
    }
    // Cannot change the account stream of an event
    if (context.oldAccountStreamIds.length > 0 && context.accountStreamIds.length > 0) {
      if (context.oldAccountStreamIds[0] !== context.accountStreamIds[0]) {
        return next(errors.invalidOperation(
          ErrorMessages[ErrorIds.ForbiddenToChangeAccountStreamId]
        ));
      }
    }
    context.accountStreamId = activeStreamIds[0];
    const streamConfig = accountStreams.accountMap[context.accountStreamId];
    if (!streamConfig?.isEditable) {
      return next(errors.invalidOperation(
        ErrorMessages[ErrorIds.ForbiddenAccountEventModification],
        { streamId: context.accountStreamId }
      ));
    }
    context.systemStream = streamConfig;
    context.accountStreamIdWithoutPrefix =
      accountStreams.toFieldName(context.accountStreamId);
    next();
  }

  /**
   * Validate content format for indexed account fields (must be string or number).
   */
  function validateAccountStreamContent (context, params, result, next) {
    if (!context.doesEventBelongToAccountStream) return next();
    if (context.newEvent == null || context.newEvent.content == null) return next();
    const contentType = typeof context.newEvent.content;
    const accepted = ['number', 'string', 'undefined'];
    if (!accepted.includes(contentType)) {
      return next(errors.invalidParametersFormat(
        ErrorMessages.IndexedParameterInvalidFormat || "The event content's format is invalid.",
        params
      ));
    }
    next();
  }

  /**
   * Notify platform of a new or changed indexed account field value.
   * Uses 'update' action when the field already has a value (to clean up old unique entries).
   */
  async function notifyPlatformForCreate (context, params, result, next) {
    if (!context.doesEventBelongToAccountStream) return next();
    if (!context.systemStream.isIndexed) return next();
    try {
      const fieldName = context.accountStreamIdWithoutPrefix;
      const previousValue = context.user[fieldName];
      const action = previousValue != null ? 'update' : 'create';
      const operations = [{
        action,
        key: fieldName,
        value: context.newEvent.content,
        previousValue,
        isUnique: context.systemStream.isUnique,
        isActive: true
      }];
      await platform.updateUser(context.user.username, operations);
    } catch (err) {
      return next(err);
    }
    next();
  }

  /**
   * Notify platform of an updated indexed account field value.
   */
  async function notifyPlatformForUpdate (context, params, result, next) {
    if (!context.doesEventBelongToAccountStream) return next();
    if (!context.systemStream.isIndexed) return next();
    try {
      const operations = [{
        action: 'update',
        key: context.accountStreamIdWithoutPrefix,
        value: context.newEvent.content,
        previousValue: context.oldEvent ? context.oldEvent.content : undefined,
        isUnique: context.systemStream.isUnique,
        isActive: true
      }];
      await platform.updateUser(context.user.username, operations);
    } catch (err) {
      return next(err);
    }
    next();
  }

  function handleSeries (context, params, result, next) {
    if (isSeriesType(context.newEvent.type)) {
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
    result.event = newEvent;
    return next();
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
    validateEventContentAndCoerce,
    detectAccountStream,
    validateAccountStreamForUpdate,
    validateAccountStreamContent,
    notifyPlatformForUpdate,
    updateEvent,
    addIntegrityToContext,
    notify
  );

  async function applyPrerequisitesForUpdate (context, params, result, next) {
    const eventUpdate = context.newEvent;
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
      if (await context.access.canUpdateEventsOnStream(event.streamIds[i])) {
        canUpdateEvent = true;
        break;
      }
    }
    if (!canUpdateEvent) { return next(errors.forbidden()); }
    if (hasStreamIdsModification(eventUpdate)) {
      // 2. check that streams we add have contribute access
      const streamIdsToAdd = _.difference(eventUpdate.streamIds, event.streamIds);
      for (const streamIdToAdd of streamIdsToAdd) {
        if (!(await context.access.canUpdateEventsOnStream(streamIdToAdd))) {
          return next(errors.forbidden());
        }
      }
      // 3. check that streams we remove have contribute access
      // streamsToRemove = event.streamIds - eventUpdate.streamIds
      const streamIdsToRemove = _.difference(event.streamIds, eventUpdate.streamIds);
      for (const streamIdToRemove of streamIdsToRemove) {
        if (!(await context.access.canUpdateEventsOnStream(streamIdToRemove))) {
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
    context.newEvent = Object.assign(event, eventUpdate);
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
      result.event = updatedEvent;
      next();
    } catch (e) {
      next(e);
    }
  }
  function notify (context, params, result, next) {
    pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_EVENTS_CHANGED);
    // notify is called by create, update and delete
    // depending on the case the event properties will be found in context or event
    if (isSeriesEvent(context.event || result.event)) {
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
    // remove double entries from streamIds
    if (event.streamIds != null && event.streamIds.length > 1) {
      event.streamIds = [...new Set(event.streamIds)];
    }
    // using context.newEvent now - not params
    context.newEvent = event;
    // used only in the events creation and update
    if (event.streamIds != null && event.streamIds.length > 0) {
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
  // DELETION

  api.register(
    'events.delete',
    commonFns.getParamsValidation(methodsSchema.del.params),
    checkEventForDelete,
    blockAccountEventDeletion,
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
   * Block deletion of account events (system stream events).
   * Account events represent current field values and cannot be deleted through the API.
   */
  function blockAccountEventDeletion (context, params, result, next) {
    const event = context.oldEvent;
    for (const streamId of event.streamIds) {
      if (streamId.startsWith(':_system:') || streamId.startsWith(':system:')) {
        return next(errors.invalidOperation('Account events cannot be deleted.'));
      }
    }
    next();
  }
  async function flagAsTrashed (context, params, result, next) {
    const newEvent = structuredClone(context.oldEvent);
    newEvent.trashed = true;
    context.updateTrackingProperties(newEvent);
    const updatedEvent = await mall.events.update(context.user.id, newEvent);
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
    deleteAttachment
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
      if (await context.access.canUpdateEventsOnStream(streamId)) {
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
};
