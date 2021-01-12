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

var cuid = require('cuid'),
  utils = require('components/utils'),
  errors = require('components/errors').factory,
  async = require('async'),
  bluebird = require('bluebird'),
  commonFns = require('./helpers/commonFunctions'),
  methodsSchema = require('../schema/eventsMethods'),
  eventSchema = require('../schema/event'),
  querying = require('./helpers/querying'),
  timestamp = require('unix-timestamp'),
  treeUtils = utils.treeUtils,
  streamsQueryUtils = require('./helpers/streamsQueryUtils'),
  _ = require('lodash'),
  SetFileReadTokenStream = require('./streams/SetFileReadTokenStream');

const SystemStreamsSerializer = require('components/business/src/system-streams/serializer');
const ServiceRegister = require('components/business/src/auth/service_register');
const Registration = require('components/business/src/auth/registration');
const UsersRepository = require('components/business/src/users/repository');
const ErrorIds = require('components/errors/src/ErrorIds');
const ErrorMessages = require('components/errors/src/ErrorMessages');
const { getConfig } = require('components/api-server/config/Config');

const assert = require('assert');

const { ProjectVersion } = require('components/middleware/src/project_version');

const {TypeRepository, isSeriesType} = require('components/business').types;


const NATS_CONNECTION_URI = require('components/utils').messaging.NATS_CONNECTION_URI;
const NATS_UPDATE_EVENT = require('components/utils').messaging
  .NATS_UPDATE_EVENT;
const NATS_DELETE_EVENT = require('components/utils').messaging
  .NATS_DELETE_EVENT;

const BOTH_STREAMID_STREAMIDS_ERROR = 'It is forbidden to provide both "streamId" and "streamIds", please opt for "streamIds" only.';

// Type repository that will contain information about what is allowed/known
// for events. 
const typeRepo = new TypeRepository(); 

/**
 * Events API methods implementations.
 * @param auditSettings
 */
module.exports = function (
  api, userEventsStorage, userEventFilesStorage,
  authSettings, eventTypesUrl, notifications, logging,
  auditSettings, updatesSettings, openSourceSettings
) {

  const usersRepository = new UsersRepository(userEventsStorage);
  const config = getConfig();

  // initialize service-register connection
  let serviceRegisterConn = {};
  if (!config.get('dnsLess:isActive')) {
    serviceRegisterConn = new ServiceRegister(
      config.get('services:register'),
      logging.getLogger('service-register')
    );
  }
  
  // Initialise the project version as soon as we can. 
  const pv = new ProjectVersion();
  let version = pv.version();
  
  // Update types and log error
  typeRepo.tryUpdate(eventTypesUrl, version)
    .catch((err) => logging.getLogger('typeRepo').warn(err));
    
  const logger = logging.getLogger('methods/events');
  
  let natsPublisher;
  if (!openSourceSettings.isActive) {
    const NatsPublisher = require('../socket-io/nats_publisher');
    natsPublisher = new NatsPublisher(NATS_CONNECTION_URI);
  }

  // RETRIEVAL

  api.register('events.get',
    coerceStreamsParam,
    commonFns.getParamsValidation(methodsSchema.get.params),
    transformArrayOfStringsToStreamsQuery,
    validateStreamsQuery,
    applyDefaultsForRetrieval,
    checkStreamsPermissionsAndApplyToScope,
    findAccessibleEvents,
    includeDeletionsIfRequested);

  function coerceStreamsParam (context, params, result, next) {
    if (! params.streams)  {
      params.streams = null;
      return next();
    }
    // Streams query can also be sent as a JSON string or string of Array
    if (! context.acceptStreamsQueryNonStringified ||
       (context.acceptStreamsQueryNonStringified && typeof params.streams === 'string')) { // batchCall and socket.io can use plain JSON objects
      try {
        params.streams = parseStreamsQueryParam(params.streams);
      } catch (e) {
        return next(errors.invalidRequestStructure(
          'Invalid "streams" parameter. It should be an array of streamIds or JSON logical query' + e, params.streams));
      }
    }

     // Transform object or string to Array
    if (! Array.isArray(params.streams)) {
      params.streams = [params.streams];
    }

    next();

    function parseStreamsQueryParam(streamsParam) {
      if (typeof streamsParam === 'string') {
        if (['[', '{'].includes(streamsParam.substr(0, 1))) { // we detect if it's JSON by looking at first char
          // Note: since RFC 7159 JSON can also starts with ", true, false or number - this does not apply in this case.
          try {
            streamsParam = JSON.parse(streamsParam);
          } catch (e) {
            throw ('Error while parsing JSON ' + e);
          }
        }
      }
      return streamsParam
    }
  }

  function transformArrayOfStringsToStreamsQuery (context, params, result, next) {
    if (params.streams === null) return next();
    try {
      params.streams = streamsQueryUtils.transformArrayOfStringsToStreamsQuery(params.streams);
    } catch (e) {
      return next(errors.invalidRequestStructure(e, params.streams));
    }
    next();
  }

  function validateStreamsQuery (context, params, result, next) {
    if (params.streams === null) return next();
    try {
      streamsQueryUtils.validateStreamsQuery(params.streams);
    } catch (e) {
      return next(errors.invalidRequestStructure('Initial filtering: ' + e, params.streams));
    }
    next();
  }

  async function applyDefaultsForRetrieval (context, params, result, next) {
    _.defaults(params, {
      streams: null,
      tags: null,
      types: null,
      fromTime: null,
      toTime: null,
      sortAscending: false,
      skip: null,
      limit: null,
      state: 'default',
      modifiedSince: null,
      includeDeletions: false
    }); 
    if (params.fromTime == null && params.toTime != null) {
      params.fromTime = timestamp.add(params.toTime, -24 * 60 * 60);
    }
    if (params.fromTime != null && params.toTime == null) {
      params.toTime = timestamp.now();
    }
    if (params.fromTime == null && params.toTime == null && params.limit == null) {
      // limit to 20 items by default
      params.limit = 20;
    }
    
  

    if (! context.access.canReadAllTags()) {
      var accessibleTags = Object.keys(context.access.tagPermissionsMap);
      params.tags = params.tags 
        ? _.intersection(params.tags, accessibleTags) 
        : accessibleTags;
    }
    next();
  }

  function checkStreamsPermissionsAndApplyToScope(context, params, result, next) {
    // Get all authorized streams (the ones that could be acessed) - Pass by all the tree including childrens
    const authorizedStreamsIds = treeUtils.collectPluck(treeUtils.filterTree(context.streams, true, isAuthorizedStream), 'id');
    function isAuthorizedStream(stream) {
      if (context.access.isPersonal()) return true;
      return context.access.canReadStream(stream.id);
    }

    // Accessible streams are the on that authorized && correspond to the "state" param request - ie: if state=default, trashed streams are omitted
    let accessibleStreamsIds = [];

    if (params.state === 'all' || params.state === 'trashed') { // all streams
      accessibleStreamsIds = authorizedStreamsIds;
    } else { // Get all streams compatible with state request - Stops when a stream is not matching to exclude childrens
      const notTrashedStreamIds = treeUtils.collectPluck(treeUtils.filterTree(context.streams, false, isRequestedStateStreams), 'id');
      function isRequestedStateStreams(stream) {
        return !stream.trashed;
      }
      accessibleStreamsIds = _.intersection(authorizedStreamsIds, notTrashedStreamIds);
    }

    if (params.streams === null) { // all streams
      if (accessibleStreamsIds.length > 0) params.streams = [{ any: accessibleStreamsIds }];

      return next();
    }

    /**
     * Function to be passed to streamQueryFiltering.validateQuery
     * Expand a streamId to [streamId, child1, ...]
     * @param {Streamid} streamId 
     */
    function expand (streamId) {
      return treeUtils.expandIds(context.streams, [streamId]);
    }

    const { streamQuery, nonAuthorizedStreams } =
      streamsQueryUtils.checkPermissionsAndApplyToScope(params.streams, expand, authorizedStreamsIds, accessibleStreamsIds);

    params.streams = streamQuery;

    if (nonAuthorizedStreams.length > 0) {
      // check if one is create-only and send forbidden
      for (let i = 0; i < nonAuthorizedStreams.length; i++) {
        if (context.access.isCreateOnlyStream(nonAuthorizedStreams[i])) {
          return next(errors.forbidden('stream [' + nonAuthorizedStreams[i] + '] has create-only permission and cannot be read'));
        }
      }

      return next(errors.unknownReferencedResource(
        'stream' + (nonAuthorizedStreams.length > 1 ? 's' : ''),
        'streams',
        nonAuthorizedStreams));
    }

    next();
  }

  async function findAccessibleEvents(context, params, result, next) {
    // build query
    const query = querying.noDeletions(querying.applyState({}, params.state));
  
    const forbiddenStreamIds = SystemStreamsSerializer.getAccountStreamsIdsForbiddenForReading();
    const streamsQuery = streamsQueryUtils.toMongoDBQuery(params.streams, forbiddenStreamIds);
    
    if (streamsQuery.$or) query.$or = streamsQuery.$or;
    if (streamsQuery.streamIds) query.streamIds = streamsQuery.streamIds;
    if (streamsQuery.$and) query.$and = streamsQuery.$and;
  
  
    if (params.tags && params.tags.length > 0) {
      query.tags = {$in: params.tags};
    }
    if (params.types && params.types.length > 0) {
      // unofficially accept wildcard for sub-type parts
      const types = params.types.map(getTypeQueryValue);
      query.type = {$in: types};
    }
    if (params.running) {
      query.duration = {'$type' : 10}; // matches when duration exists and is null
    }
    if (params.fromTime != null) {
      const timeQuery = [
        { // Event started before fromTime, but finished inside from->to.
          time: {$lt: params.fromTime},
          endTime: {$gte: params.fromTime}
        },
        { // Event has started inside the interval.
          time: { $gte: params.fromTime, $lte: params.toTime }
        },
      ];

      if (query.$or) { // mongo support only one $or .. so we nest them into a $and
        if (! query.$and) query.$and = [];
        query.$and.push({$or: query.$or});
        query.$and.push({$or: timeQuery});
        delete query.$or; // clean; 
      } else {
        query.$or = timeQuery;
      }

    }
    if (params.toTime != null) {
      _.defaults(query, {time: {}});
      query.time.$lte = params.toTime;
    }
    if (params.modifiedSince != null) {
      query.modified = {$gt: params.modifiedSince};
    }

    const options = {
      projection: params.returnOnlyIds ? {id: 1} : {},
      sort: { time: params.sortAscending ? 1 : -1 },
      skip: params.skip,
      limit: params.limit
    };
    try {
      let eventsStream = await bluebird.fromCallback(cb =>
        userEventsStorage.findStreamed(context.user, query, options, cb));

      result.addStream('events', eventsStream
        .pipe(new SetFileReadTokenStream(
          {
            access: context.access,
            filesReadTokenSecret: authSettings.filesReadTokenSecret
          }
        ))
      );
      next();
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
  }

  function includeDeletionsIfRequested(context, params, result, next) {

    if (params.modifiedSince == null || !params.includeDeletions) {
      return next();
    }

    const options = {
      sort: {deleted: params.sortAscending ? 1 : -1},
      skip: params.skip,
      limit: params.limit
    };

    userEventsStorage.findDeletionsStreamed(context.user, params.modifiedSince, options,
      function (err, deletionsStream) {
        if (err) {
          return next(errors.unexpectedError(err));
        }

        result.addStream('eventDeletions', deletionsStream);
        next();
      });
  }

  api.register('events.getOne',
    commonFns.getParamsValidation(methodsSchema.getOne.params),
    findEvent,
    includeHistoryIfRequested
  );

  function findEvent (context, params, result, next) {
    const query = { 
      streamIds: {
        // forbid account stream ids
        $nin: SystemStreamsSerializer.getAccountStreamsIdsForbiddenForReading()
      },
      id: params.id 
    };
    userEventsStorage.findOne(context.user, query, null, function (err, event) {
      if (err) {
        return next(errors.unexpectedError(err));
      }

      if (! event) {
        return next(errors.unknownResource('event', params.id));
      }

      let canReadEvent = false;
      for (let i = 0; i < event.streamIds.length; i++) { // ok if at least one
        if (context.canReadContext(event.streamIds[i], event.tags)) {
          canReadEvent = true;
          break;
        }
      }
      if (! canReadEvent) return next(errors.forbidden());

      setFileReadToken(context.access, event);

      // To remove when streamId not necessary
      event.streamId = event.streamIds[0];     
      result.event = event;
      return next();
    });
  }

  function includeHistoryIfRequested(context, params, result, next) {
    if (!params.includeHistory) {
      return next();
    }

    var options = {
      sort: {modified: 1}
    };

    userEventsStorage.findHistory(context.user, params.id, options,
      function (err, history) {
        if (err) {
          return next(errors.unexpectedError(err));
        }

        // To remove when streamId not necessary
        history.forEach(e => e.streamId = e.streamIds[0]);
        
        result.history = history;
        next();
      });
  }

  // -------------------------------------------------------------------- CREATE

  api.register('events.create',
    commonFns.getParamsValidation(methodsSchema.create.params),
    normalizeStreamIdAndStreamIds,
    applyPrerequisitesForCreation,
    validateEventContentAndCoerce,
    doesEventBelongToTheAccountStream,
    validateAccountStreamsEventCreation,
    verifycanContributeToContext,
    appendAccountStreamsEventDataForCreation,
    createEvent,
    handleEventsWithActiveStreamId,
    createAttachments,
    notify);

  function applyPrerequisitesForCreation(context, params, result, next) {
    const event = context.content;
    // default time is now
    _.defaults(event, { time: timestamp.now() });
    if (! event.tags) {
      event.tags = [];
    }
    
    cleanupEventTags(event);
    
    context.files = sanitizeRequestFiles(params.files);
    delete params.files;

    context.initTrackingProperties(event);
    
    context.content = event;
    next();
  }

  /**
   * Check if previous event(or "new event" for events creation) belongs to the account
   * streams
   * 
   * @param {*} context 
   * @param {*} params 
   * @param {*} result 
   * @param {*} next 
   */
  function doesEventBelongToTheAccountStream (context, params, result, next) {
    const allAccountStreamsIds = Object.keys(SystemStreamsSerializer.getAllAccountStreams());
    // check streamIds intersection with old event streamIds 
    // for new event it should be current context
    context.oldContentStreamIds = (context.oldContent != null) ? context.oldContent.streamIds : context.content.streamIds;
    
    // check if event belongs to account stream ids
    matchingAccountStreams = _.intersection(
      context.oldContentStreamIds,
      allAccountStreamsIds
    );
    context.doesEventBelongToAccountStream = matchingAccountStreams.length > 0;
    context.eventAccountStreams = matchingAccountStreams;
    if (context.eventAccountStreams.length > 0) {
      context.accountStreamId = matchingAccountStreams[0];
    }
    next();
  }

  /**
   * Validate account stream events
   * 
   * @param {*} context 
   * @param {*} params 
   * @param {*} result 
   * @param {*} next 
   */
  function validateAccountStreamsEventCreation (context, params, result, next) {
    let matchingAccountStreams = [];
    if (context.doesEventBelongToAccountStream) {
      checkIfStreamIdIsNotEditable(context.accountStreamId);
      checkIfUserTriesToAddMultipleAccountStreamIds(matchingAccountStreams);
    }
    next();
  }


  function verifycanContributeToContext (context, params, result, next) {
    for (let i = 0; i < context.content.streamIds.length; i++) { // refuse if any context is not accessible
      if (! context.canContributeToContext(context.content.streamIds[i], context.content.tags)) {
        return next(errors.forbidden());
      }
    }
    next();
  }

  /**
   * Do additional actions if event belongs to the account stream and is
   * 1) unique
   * 2) indexed
   * 3) active
   * Additional actions like
   * a) adding property to enforce uniqueness
   * b) sending data update to service-register
   * c) saving streamId 'active' has to be handled in a different way than
   * for all other events
   *
   * @param string username 
   * @param object contextContent 
   * @param boolean creation - if true - active streamId will be added by default
   */
  async function appendAccountStreamsEventDataForCreation (context, params, result, next) {
    // check if event belongs to account stream ids
    if (!context.doesEventBelongToAccountStream) {
      return next();
    }

    try{
      // when new account event is created, all other should be marked as nonactive
      context.content.streamIds.push(SystemStreamsSerializer.options.STREAM_ID_ACTIVE);
      context.removeActiveEvents = true;
      
      // get editable account streams
      const editableAccountStreams = SystemStreamsSerializer.getEditableAccountStreams();
      if (
        editableAccountStreams[context.accountStreamId].isUnique ||
        editableAccountStreams[context.accountStreamId].isIndexed
      ) {
        // if stream is unique append properties that enforce uniqueness
        context.content = enforceEventUniquenessIfNeeded(
          context.content,
          editableAccountStreams[context.accountStreamId]
        );

        await sendDataToServiceRegister(context, true, editableAccountStreams);
      }
    } catch (err) {
      return next(err);
    }
    next();
  }

  async function createEvent(
    context, params, result, next) 
  {
    if (isSeriesType(context.content.type)) {
      if (openSourceSettings.isActive) {
        return next(errors.unavailableMethod());
      }
      try {
        context.content.content = createSeriesEventContent(context);
      }
      catch (err) { return next(err); }
        
      // As long as there is no data, event duration is considered to be 0.
      context.content.duration = 0; 
    }
    userEventsStorage.insertOne(
      context.user, context.content, function (err, newEvent) {
        if (err != null) {
          // Expecting a duplicate error
          if (err.isDuplicateIndex('id')) {
            return next(errors.itemAlreadyExists('event', {id: params.id}, err));
          }
          // Expecting a duplicate error for unique fields
          if (err.isDuplicate) {
            return next(Registration.handleUniquenessErrors(
              err,
              ErrorMessages[ErrorIds.UnexpectedError],
              { [SystemStreamsSerializer.removeDotFromStreamId(context.accountStreamId)]: context.content.content }));
          }
          // Any other error
          return next(errors.unexpectedError(err));
        }

        // To remove when streamId not necessary
        newEvent.streamId = newEvent.streamIds[0];
        result.event = newEvent;
        next();
      });
  }

  /**
   * If event should be unique, add .unique streamId
   * @param object contextContent 
   * @param string fieldName 
   */
  function enforceEventUniquenessIfNeeded (
    contextContent: object,
    accountStreamSettings: object
  ) {
    if (! accountStreamSettings.isUnique) {
      return contextContent;
    }
    if (!contextContent.streamIds.includes(SystemStreamsSerializer.options.STREAM_ID_UNIQUE)) {
      contextContent.streamIds.push(SystemStreamsSerializer.options.STREAM_ID_UNIQUE);
    }
    return contextContent;
  }

  /**
   * Creates the event's body according to its type and context. 
   */
  function createSeriesEventContent(context) {
    const seriesTypeName = context.content.type; 
    const eventType = typeRepo.lookup(seriesTypeName); 
    
    // assert: Type is a series type, so this should be always true: 
    assert.ok(eventType.isSeries()); 

    return {
      elementType: eventType.elementTypeName(), 
      fields: eventType.fields(), 
      required: eventType.requiredFields(),
    };
  }

  async function createAttachments (context, params, result, next) {
    try {
      const attachments = await attachFiles(context, { id: result.event.id }, context.files);

      if (!attachments) {
        return next();
      }

      result.event.attachments = attachments;
      userEventsStorage.updateOne(context.user, { id: result.event.id }, { attachments: attachments },
        function (err) {
          if (err) {
            return next(errors.unexpectedError(err));
          }

          setFileReadToken(context.access, result.event);
          next();
        });
    } catch (err) {
      next(err);
    }
  }

  // -------------------------------------------------------------------- UPDATE

  api.register('events.update',
    commonFns.getParamsValidation(methodsSchema.update.params),
    commonFns.catchForbiddenUpdate(eventSchema('update'), updatesSettings.ignoreProtectedFields, logger),
    normalizeStreamIdAndStreamIds,
    applyPrerequisitesForUpdate,
    validateEventContentAndCoerce,
    doesEventBelongToTheAccountStream,
    validateAccountStreamsEventEdition,
    generateVersionIfNeeded,
    updateAttachments,
    appendAccountStreamsEventDataForUpdate,
    updateEvent,
    handleEventsWithActiveStreamId,
    notify);

  function applyPrerequisitesForUpdate(context, params, result, next) {

    const eventUpdate = context.content;
    
    cleanupEventTags(eventUpdate);

    context.updateTrackingProperties(eventUpdate);

    userEventsStorage.findOne(context.user, {id: params.id}, null, function (err, event) {
      if (err) {
        return next(errors.unexpectedError(err));
      }

      if (! event) {
        return next(errors.unknownResource('event', params.id));
      }

      // 1. check that have contributeContext on at least 1 existing streamId
      let canUpdateEvent = false;
      for (let i = 0; i < event.streamIds.length ; i++) {
        if (context.canUpdateContext(event.streamIds[i], event.tags)) {
          canUpdateEvent = true;
          break;
        }
      }
      if (! canUpdateEvent) return next(errors.forbidden());
      
      if (hasStreamIdsModification(eventUpdate)) {

        // 2. check that streams we add have contribute access
        const streamIdsToAdd = _.difference(eventUpdate.streamIds, event.streamIds);
        for (let i=0; i<streamIdsToAdd.length; i++) {
          if (! context.canUpdateContext(streamIdsToAdd[i], event.tags)) {
            return next(errors.forbidden());
          }
        }

        // 3. check that streams we remove have contribute access        
        // streamsToRemove = event.streamIds - eventUpdate.streamIds
        const streamIdsToRemove = _.difference(event.streamIds, eventUpdate.streamIds);

        for (let i = 0; i < streamIdsToRemove.length ; i++) {
          if (! context.canUpdateContext(streamIdsToRemove[i], event.tags)) {
            return next(errors.forbidden());
          }
        }
      }

      const updatedEventType = eventUpdate.type;
      if(updatedEventType != null) {
        const currentEventType = event.type;
        const isCurrentEventTypeSeries = isSeriesType(currentEventType);
        const isUpdatedEventTypeSeries = isSeriesType(updatedEventType);
        if (! typeRepo.isKnown(updatedEventType) && isUpdatedEventTypeSeries) {
          return next(errors.invalidEventType(updatedEventType)); // We forbid the 'series' prefix for these free types. 
        }

        if((isCurrentEventTypeSeries && ! isUpdatedEventTypeSeries) || 
          (! isCurrentEventTypeSeries && isUpdatedEventTypeSeries)) {
          return next(errors.invalidOperation('Normal events cannot be updated to HF-events and vice versa.'));
        }
      }

      context.oldContent = _.cloneDeep(event);
      context.content = _.extend(event, eventUpdate);
      next();

      function hasStreamIdsModification(event) {
        return event.streamIds != null;
      }
    });

  }

  /**
   * Depends on context.oldContent
   */
  function generateVersionIfNeeded(context, params, result, next) {
    if (!auditSettings.forceKeepHistory) {
      return next();
    }

    context.oldContent = _.extend(context.oldContent, {headId: context.oldContent.id});
    delete context.oldContent.id;

    userEventsStorage.insertOne(context.user, context.oldContent, function (err) {
      if (err) {
        return next(errors.unexpectedError(err));
      }
      next();
    });
  }

  async function updateAttachments(context, params, result, next) {
    var eventInfo = {
      id: context.content.id,
      attachments: context.content.attachments || []
    };
    try{
      const attachments = await attachFiles(context, eventInfo, sanitizeRequestFiles(params.files));
      if (attachments) {
        context.content.attachments = attachments;
      }
      return next();
    } catch (err) {
      return next(err);
    }
  }


  /**
   * Do additional actions if event belongs to the account stream and is
   * 1) unique
   * 2) indexed
   * 3) active
   * Additional actions like
   * a) adding property to enforce uniqueness
   * b) sending data update to service-register
   * c) saving streamId 'active' has to be handled in a different way than
   * for all other events
   *
   * @param string username 
   * @param object contextContent 
   * @param boolean creation - if true - active streamId will be added by default
   */
  async function appendAccountStreamsEventDataForUpdate (context, params, result, next) {
    // check if event belongs to account stream ids
    if (!context.doesEventBelongToAccountStream) {
      return next();
    }
    try{
     context.removeActiveEvents = false;

      // get editable account streams
      const editableAccountStreams = SystemStreamsSerializer.getEditableAccountStreams();
      // if .active stream id was added to the event
      if (
        !context.oldContentStreamIds.includes(SystemStreamsSerializer.options.STREAM_ID_ACTIVE)
        && context.content.streamIds.includes(SystemStreamsSerializer.options.STREAM_ID_ACTIVE)
      ) {
        // after event will be saved, active property will be removed from the other events
        context.removeActiveEvents = true;
      }

      if (
        editableAccountStreams[context.accountStreamId].isUnique ||
        editableAccountStreams[context.accountStreamId].isIndexed
      ) {
        // if stream is unique append properties that enforce uniqueness
        context.content = enforceEventUniquenessIfNeeded(
          context.content,
          editableAccountStreams[context.accountStreamId]
        );
        await sendDataToServiceRegister(context, false, editableAccountStreams);
      }
    } catch (err) {
      return next(err);
    }
    next();
  }

  async function updateEvent (context, params, result, next) {
    try {
      let updatedEvent = await bluebird.fromCallback(cb =>
        userEventsStorage.updateOne(context.user, { _id: context.content.id }, context.content, cb));

      // if update was not done and no errors were catched
      //, perhaps user is trying to edit account streams
      if (!updatedEvent) {
        return next(errors.invalidOperation(
          ErrorMessages[ErrorIds.ForbiddenNoneditableAccountStreamsEdit]));
      }

      // To remove when streamId not necessary
      updatedEvent.streamId = updatedEvent.streamIds[0];
      result.event = updatedEvent;
      setFileReadToken(context.access, result.event);

    } catch (err) {
      return next(Registration.handleUniquenessErrors(
        err,
        ErrorMessages[ErrorIds.UnexpectedError],
        { [SystemStreamsSerializer.removeDotFromStreamId(context.accountStreamId)]: context.content.content }));
    };
    next();
  }

 /**
  * For account streams - 'active' streamId defines the 'main' event
  * from of the stream. If there are many events (like many emails), 
  * only one should be main/active
  */
  async function handleEventsWithActiveStreamId (context, params, result, next) {
    // if it is needed update events from the same account stream
    if (!context.removeActiveEvents) {
      return next();
    }
    await bluebird.fromCallback(cb =>
      userEventsStorage.updateMany(context.user,
        {
          id: { $ne: result.event.id },
          streamIds: {
            $all: [
              // if we use active stream id not only for account streams
              // this should be made more general
              context.accountStreamId, 
              SystemStreamsSerializer.options.STREAM_ID_ACTIVE
            ]
          }
        },
        { $pull: { streamIds: SystemStreamsSerializer.options.STREAM_ID_ACTIVE } }, cb)
    );
    next();
  }

  function notify(context, params, result, next) {
    notifications.eventsChanged(context.user);

    // notify is called by create, update and delete
    // depending on the case the event properties will be found in context or event
    if (isSeriesEvent(context.event || result.event) && !openSourceSettings.isActive) {
      const isDelete = result.eventDeletion ? true : false;
      // if event is a deletion 'id' is given by result.eventDeletion
      const updatedEventId = isDelete ? _.pick(result.eventDeletion, ['id']) : _.pick(result.event, ['id']);
      const subject = isDelete ? NATS_DELETE_EVENT : NATS_UPDATE_EVENT;
      natsPublisher.deliver(subject, {
        username: context.user.username,
        event: updatedEventId,
      });
    }

    function isSeriesEvent(event) {
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
  function sanitizeRequestFiles(files) {
    if (! files || ! files.file || ! Array.isArray(files.file)) {
      // assume files is an object, nothing to do
      return files;
    }
    var result = {};
    files.file.forEach(function (item, i) {
      if (! item.filename) {
        item.filename = item.name;
      }
      result[i] = item;
    });
    return result;
  }

  function normalizeStreamIdAndStreamIds(context, params, result, next) {
    const event = isEventsUpdateMethod() ? params.update : params;

    // forbid providing both streamId and streamIds
    if (event.streamId != null && event.streamIds != null) {
      return next(errors.invalidOperation(BOTH_STREAMID_STREAMIDS_ERROR,
        { streamId: event.streamId, event: params.streamIds }));
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
    // using context.content now - not params
    context.content = event;

    // check that streamIds are known
    context.setStreamList(context.content.streamIds);

    if (event.streamIds != null && ! checkStreams(context, next)) return;
    
    next();

    function isEventsUpdateMethod() { return params.update != null; }
  }

  /**
   * Validates the event's content against its type (if known).
   * Will try casting string content to number if appropriate.
   *
   * @param {Object} context.content contains the event data
   * @param {Object} params
   * @param {Object} result
   * @param {Function} next
   */
  function validateEventContentAndCoerce(context, params, result, next) {
    const type = context.content.type;

    // Unknown types can just be created as normal events. 
    if (! typeRepo.isKnown(type)) {
      // We forbid the 'series' prefix for these free types. 
      if (isSeriesType(type)) return next(errors.invalidEventType(type));

      // No further checks, let the user do what he wants. 
      return next();
    }
        
    // assert: `type` is known
    
    const eventType = typeRepo.lookup(type);
    if (eventType.isSeries()) {
      // Series cannot have content on update, not here at least.
      if (isCreateSeriesAndHasContent() || isUpdateSeriesAndHasContent()) {
        return next(errors.invalidParametersFormat('The event content\'s format is invalid.', 'Events of type High-frequency have a read-only content'));
      }
      return next();
    }
    
    // assert: `type` is not a series but is known

    const content = context.content.hasOwnProperty('content') 
      ? context.content.content
      : null;

    const validator = typeRepo.validator();
    validator.validate(eventType, content)
      .then((newContent) => {
        // Store the coerced value. 
        context.content.content = newContent; 
        next();
      })
      .catch(
        (err) => next(errors.invalidParametersFormat(
          'The event content\'s format is invalid.', err))
      );

    function isCreateSeriesAndHasContent() {
      return params.content != null;
    }

    function isUpdateSeriesAndHasContent() {
      return params.update != null && params.update.content != null;
    }

  }

  /**
   * Forbid event editing if event has non editable core stream
   * @param string streamId
   */
  function checkIfStreamIdIsNotEditable (streamId: string): boolean {
    const nonEditableAccountStreamsIds = SystemStreamsSerializer.getAccountStreamsIdsForbiddenForEditing();
    if (nonEditableAccountStreamsIds.includes(streamId)) {
      // if user tries to add new streamId from non editable streamsIds
      throw errors.invalidOperation(
        ErrorMessages[ErrorIds.ForbiddenNoneditableAccountStreamsEdit],
        { streamId: streamId }
      );
    }
  }

  /**
   * Forbid event editing if user tries to add multiple account streams
   * to the same event
   */
  function checkIfUserTriesToAddMultipleAccountStreamIds (matchingAccountStreams): boolean {
    if (matchingAccountStreams.length > 1) {
      throw errors.invalidOperation(
        ErrorMessages[ErrorIds.ForbiddenMultipleAccountStreams],
        { streamId: matchingAccountStreams[0]}
      );
    }
  }

  /**
   * Check if event belongs to account stream,
   * if yes, validate and prepend context with the properties that will be
   * used later like:
   * a) doesEventBelongToAccountStream: boolean
   * b) oldContentStreamIds: array<string>
   * c) accountStreamId - string - account streamId
   * 
   * @param {*} context 
   * @param {*} params 
   * @param {*} result 
   * @param {*} next 
   */
  function validateAccountStreamsEventEdition (context, params, result, next) { 
    if (!context.doesEventBelongToAccountStream) {
      return next();
    }

    // previously we have validated with old config streamIds, now with new streamIds
    const allAccountStreamIds = Object.keys(SystemStreamsSerializer.getAllAccountStreams());
    const matchingAccountStreams = _.intersection(
      context.content.streamIds,
      allAccountStreamIds
    );

    checkIfUserTriesToRemoveAccountStreamId(matchingAccountStreams);
    // sequence is important, because checkIfUserTriesToRemoveAccountStreamId checks that 
    // matchingAccountStreams is not empty
    context.accountStreamId = matchingAccountStreams[0];
    checkIfStreamIdIsNotEditable(context.accountStreamId);
    checkIfUserTriesToAddMultipleAccountStreamIds(matchingAccountStreams)
    checkIfUserTriesToChangeAccountStreamId(context.oldContentStreamIds);
    
    next();

    function checkIfUserTriesToRemoveAccountStreamId (matchingAccountStreams) {
      if (matchingAccountStreams.length == 0) {
        throw errors.invalidOperation(
          ErrorMessages[ErrorIds.ForbiddenToChangeAccountStreamId]);
      }
    }
    /**
     * Forbid event editing if user tries to change the account srtreamId
     * @param {*} oldContentStreamIds 
     */
    function checkIfUserTriesToChangeAccountStreamId (oldContentStreamIds): boolean {
      if (matchingAccountStreams.length > 0 &&
        _.intersection(matchingAccountStreams, oldContentStreamIds).length === 0) {
        throw errors.invalidOperation(
          ErrorMessages[ErrorIds.ForbiddenToChangeAccountStreamId]);
      }
    }
  }

  function cleanupEventTags(eventData) {      
    if (! eventData.tags) return;

    const limit = 500;
    
    eventData.tags = eventData.tags.map(function (tag) {
      if(tag.length > limit) {
        throw errors.invalidParametersFormat(
          'The event contains a tag that exceeds the size limit of ' +
           limit + ' characters.', tag);
      } 
      return tag.trim();
    }).filter(function (tag) { return tag.length > 0; });
  }

  /**
   * Checks that the context's stream exists and isn't trashed.
   * `context.setStream` must be called beforehand.
   *
   * @param {Object} context
   * @param {Function} errorCallback Called with the appropriate error if any
   * @return `true` if OK, `false` if an error was found.
   */
  function checkStreams (context, errorCallback) {
    if (context.streamIdsNotFoundList.length > 0 ) {
      errorCallback(errors.unknownReferencedResource(
        'stream', 'streamIds', context.streamIdsNotFoundList
      ));
      return false;
    }
    
    for (let i = 0; i < context.streamList.length; i++) {
      if (context.streamList[i].trashed) {
        errorCallback(errors.invalidOperation(
          'The referenced stream "' + context.streamList[i].id + '" is trashed.',
          {trashedReference: 'streamIds'}
        ));
        return false;
      }
    }

    return true;
  }

  /**
   * Saves the uploaded files (if any) as attachments, returning the corresponding attachments info.
   *
   * @param {Object} context
   * @param {Object} eventInfo Expected properties: id, attachments
   * @param files Express-style uploaded files object (as in req.files)
   */
  async function attachFiles (context, eventInfo, files) {
    if (!files) { return; }

    var attachments = eventInfo.attachments ? eventInfo.attachments.slice() : [];
    let i;
    let fileInfo;
    const filesKeys = Object.keys(files);
    for (i = 0; i < filesKeys.length; i++) {
      //saveFile
      fileInfo = files[filesKeys[i]];
      const fileId = await bluebird.fromCallback(cb =>
        userEventFilesStorage.saveAttachedFile(fileInfo.path, context.user, eventInfo.id, cb));

      attachments.push({
        id: fileId,
        fileName: fileInfo.originalname,
        type: fileInfo.mimetype,
        size: fileInfo.size
      });
      // approximately update account storage size
      context.user.storageUsed.attachedFiles += fileInfo.size;
      
      await usersRepository.updateOne(
        context.user,
        { attachedFiles: context.user.storageUsed.attachedFiles },
        context.access.id,
      );
    }
    return attachments;
  }

  // DELETION

  api.register('events.delete',
    commonFns.getParamsValidation(methodsSchema.del.params),
    checkEventForDelete,
    doesEventBelongToTheAccountStream,
    validateAccountStreamsEventDeletion,
    generateVersionIfNeeded,
    function (context, params, result, next) {
      if (!context.oldContent.trashed) {
        // move to trash
        flagAsTrashed(context, params, result, next);
      } else {
        // actually delete
        deleteWithData(context, params, result, next);
      }
    }, notify);

  /**
   * If event belongs to the account stream 
   * send update to service-register if needed
   * 
   * @param object user {id: '', username: ''}
   * @param object event
   * @param string accountStreamId - accountStreamId
   */
  async function sendUpdateToServiceRegister (user, event, accountStreamId) {
    if (config.get('dnsLess:isActive')) {
      return;
    }
    const editableAccountStreams = SystemStreamsSerializer.getEditableAccountStreams();
    const streamIdWithoutDot = SystemStreamsSerializer.removeDotFromStreamId(accountStreamId);
    if (editableAccountStreams[accountStreamId].isUnique) {
      // send information update to service regsiter
      await serviceRegisterConn.updateUserInServiceRegister(
        user.username, {}, { [streamIdWithoutDot]: event.content});
    }
  }
  
  async function flagAsTrashed(context, params, result, next) {
    var updatedData = {
      trashed: true
    };
    context.updateTrackingProperties(updatedData);
    try {
      if (context.doesEventBelongToAccountStream){
        await sendUpdateToServiceRegister(
          context.user,
          context.oldContent,
          context.accountStreamId,
        );
      }
      let updatedEvent = await bluebird.fromCallback(cb =>
        userEventsStorage.updateOne(context.user, { _id: params.id }, updatedData, cb));

      // if update was not done and no errors were catched
      //, perhaps user is trying to edit account streams
      if (!updatedEvent) {
        return next(errors.invalidOperation(
          ErrorMessages[ErrorIds.ForbiddenNoneditableAccountStreamsEventsDeletion]));
      }

      // To remove when streamId not necessary
      updatedEvent.streamId = updatedEvent.streamIds[0];

      result.event = updatedEvent;
      setFileReadToken(context.access, result.event);

      next();
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
  }

  function deleteWithData(context, params, result, next) {
    async.series([
      function deleteHistoryCompletely(stepDone) {
        if (auditSettings.deletionMode !== 'keep-nothing') {
          return stepDone();
        }
        userEventsStorage.removeMany(context.user, {headId: params.id}, function (err) {
          if (err) {
            return stepDone(errors.unexpectedError(err));
          }
          stepDone();
        });
      },
      function minimizeHistory(stepDone) {
        if (auditSettings.deletionMode !== 'keep-authors') {
          return stepDone();
        }
        userEventsStorage.minimizeEventsHistory(context.user, params.id, function (err) {
          if (err) {
            return stepDone(errors.unexpectedError(err));
          }
          stepDone();
        });
      },
      function deleteEvent(stepDone) {
        userEventsStorage.delete(context.user, {id: params.id}, auditSettings.deletionMode,
          function (err) {
            if (err) {
              return stepDone(errors.unexpectedError(err));
            }
            result.eventDeletion = {id: params.id};
            stepDone();
          });
      },
      userEventFilesStorage.removeAllForEvent.bind(userEventFilesStorage, context.user, params.id),
      async function () {
        // If needed, approximately update account storage size
        if (! context.user.storageUsed || ! context.user.storageUsed.attachedFiles) {
          return;
        }
        context.user.storageUsed.attachedFiles -= getTotalAttachmentsSize(context.event);
        await usersRepository.updateOne(
          context.user,
          context.user.storageUsed,
          context.access.id,
        );
      }
    ], next);
  }

  function getTotalAttachmentsSize(event) {
    if (! event.attachments) {
      return 0;
    }
    return _.reduce(event.attachments, function (evtTotal, att) {
      return evtTotal + att.size;
    }, 0);
  }

  api.register('events.deleteAttachment',
    commonFns.getParamsValidation(methodsSchema.deleteAttachment.params),
    checkEventForDelete,
    async function (context, params, result, next) {
      try {
        var attIndex = getAttachmentIndex(context.event.attachments, params.fileId);
        if (attIndex === -1) {
          return next(errors.unknownResource(
            'attachment', params.fileId
          ));
        }
        let deletedAtt = context.event.attachments[attIndex];
        context.event.attachments.splice(attIndex, 1);

        var updatedData = { attachments: context.event.attachments };
        context.updateTrackingProperties(updatedData);

        let alreadyUpdatedEvent = await bluebird.fromCallback(cb =>
          userEventsStorage.updateOne(context.user, { _id: params.id }, updatedData, cb));

        // if update was not done and no errors were catched
        //, perhaps user is trying to edit account streams
        if (!alreadyUpdatedEvent) {
          return next(errors.invalidOperation(
            ErrorMessages[ErrorIds.ForbiddenNoneditableAccountStreamsEventsDeletion]));
        }

        // To remove when streamId not necessary
        alreadyUpdatedEvent.streamId = alreadyUpdatedEvent.streamIds[0];

        result.event = alreadyUpdatedEvent;
        setFileReadToken(context.access, result.event);

        await bluebird.fromCallback(cb => userEventFilesStorage.removeAttachedFile(context.user, params.id, params.fileId, cb));

        // approximately update account storage size
        context.user.storageUsed.attachedFiles -= deletedAtt.size;
        await usersRepository.updateOne(
          context.user,
          context.user.storageUsed,
          context.access.id,
        );
        notifications.eventsChanged(context.user);
        next();
      } catch (err) {
        next(err);
      }
    });

  /**
   * Returns the query value to use for the given type, handling possible wildcards.
   *
   * @param {String} requestedType
   */
  function getTypeQueryValue(requestedType) {
    var wildcardIndex = requestedType.indexOf('/*');
    return wildcardIndex > 0 ?
      new RegExp('^' + requestedType.substr(0, wildcardIndex + 1)) : 
      requestedType;
  }

  function checkEventForDelete (context, params, result, next) {
    const eventId = params.id;
    userEventsStorage.findOne(context.user, { id: eventId }, null, function (err, event) {
      if (err) {
        return next(errors.unexpectedError(err));
      }
      if (! event) {
        return next(errors.unknownResource(
          'event', eventId
        ));
      }
      
      let canDeleteEvent = false;

      for (let i = 0; i < event.streamIds.length; i++) {
        if (context.canUpdateContext(event.streamIds[i], event.tags)) {
          canDeleteEvent = true;
          break;
        }
      }
      if (!canDeleteEvent) return next(errors.forbidden());
      // save event from the database as an oldContent
      context.oldContent = event;

      // create an event object that could be modified
      context.event = Object.assign({}, event);
      next();
    });
  }

  /**
   * Check if event should not be allowed for deletion
   * a) is not editable
   * b) is active
   */
  function validateAccountStreamsEventDeletion (context, params, result, next) {
    if (!context.doesEventBelongToAccountStream) {
      return next(); 
    }

    const editableAccountStreamsIds = Object.keys(SystemStreamsSerializer.getEditableAccountStreams());
    const eventBelongsToEditableStream = _.intersection(
      context.oldContent.streamIds,
      editableAccountStreamsIds
    ).length > 0;

    if (
      !eventBelongsToEditableStream ||
      context.oldContent.streamIds.includes(SystemStreamsSerializer.options.STREAM_ID_ACTIVE)
    ) {
      return next(errors.invalidOperation(
        ErrorMessages[ErrorIds.ForbiddenAccountStreamsEventDeletion]));
    }
    next();
  }

  /**
   * Returns the key of the attachment with the given file name.
   */
  function getAttachmentIndex(attachments, fileId) {
    return _.findIndex(attachments, function (att) {
      return att.id === fileId;
    });
  }

  /**
   * Sets the file read token for each of the given event's attachments (if any) for the given
   * access.
   *
   * @param access
   * @param event
   */
  function setFileReadToken(access, event) {
    if (! event.attachments) { return; }
    event.attachments.forEach(function (att) {
      att.readToken = utils.encryption
        .fileReadToken(att.id, 
          access.id, access.token,
          authSettings.filesReadTokenSecret);
    });
  }

  /**
   * Build request and send data to service-register about unique or indexed fields update
   * @param {*} fieldName 
   * @param {*} contextContent 
   * @param {*} creation 
   */
  async function sendDataToServiceRegister (context, creation, editableAccountStreams) {
    // send update to service-register
    if (config.get('dnsLess:isActive')) {
      return;
    }
    let fieldsForUpdate = {};
    let streamIdWithoutDot = SystemStreamsSerializer.removeDotFromStreamId(context.accountStreamId);

    // for isActive "context.removeActiveEvents" is not enought because it would be set 
    // to false if old event was active and is still active (no change)
    fieldsForUpdate[streamIdWithoutDot] = [{
      value: context.content.content,
      isUnique: editableAccountStreams[context.accountStreamId].isUnique,
      isActive: (
        context.content.streamIds.includes(SystemStreamsSerializer.options.STREAM_ID_ACTIVE) ||
        context.oldContentStreamIds.includes(SystemStreamsSerializer.options.STREAM_ID_ACTIVE)),
      creation: creation
    }];

    // send information update to service regsiter
    await serviceRegisterConn.updateUserInServiceRegister(
      context.user.username,
      fieldsForUpdate,
      {}
    );
  }
};


