var errors = require('components/errors').factory,
  async = require('async'),
  commonFns = require('./helpers/commonFunctions'),
  errorHandling = require('components/errors').errorHandling,
  methodsSchema = require('../schema/streamsMethods'),
  streamSchema = require('../schema/stream'),
  slugify = require('slug'),
  string = require('./helpers/string'),
  utils = require('components/utils'),
  treeUtils = utils.treeUtils,
  _ = require('lodash');

/**
 * Event streams API methods implementation.
 *
 * @param api
 * @param userStreamsStorage
 * @param userEventsStorage
 * @param userEventFilesStorage
 * @param notifications
 * @param logging
 * @param auditSettings
 * @param updatesSettings
 */
module.exports = function (api, userStreamsStorage, userEventsStorage, userEventFilesStorage,
  notifications, logging, auditSettings, updatesSettings) {

  const logger = logging.getLogger('methods/streams');

  // RETRIEVAL

  api.register('streams.get',
    commonFns.getParamsValidation(methodsSchema.get.params),
    applyDefaultsForRetrieval,
    findAccessibleStreams,
    includeDeletionsIfRequested);

  function applyDefaultsForRetrieval(context, params, result, next) {
    _.defaults(params, {
      parentId: null,
      includeDeletionsSince: null
    });
    next();
  }

  function findAccessibleStreams(context, params, result, next) {
    // can't reuse context streams (they carry extra internal properties)
    userStreamsStorage.find(context.user, {}, null, function (err, streams) {
      if (err) { return next(errors.unexpectedError(err)); }

      if (params.parentId) {
        var parent = treeUtils.findById(streams, params.parentId);
        if (!parent) {
          return next(errors.unknownReferencedResource('parent stream',
            'parentId', params.parentId, err));
        }
        streams = parent.children;
      }

      if (params.state !== 'all') { // i.e. === 'default' (return non-trashed items)
        streams = treeUtils.filterTree(streams, false /*no orphans*/, function (item) {
          return !item.trashed;
        });
      }

      if (! context.access.isPersonal()) {
        streams = treeUtils.filterTree(streams, true /*keep orphans*/, function (stream) {
          return context.canListStream(stream.id);
        });
      }

      // hide inaccessible parent ids
      streams.forEach(function (stream) {
        if (! context.canListStream(stream.parentId)) {
          delete stream.parentId;
        }
      });

      result.streams = streams;
      next();
    });
  }

  function includeDeletionsIfRequested(context, params, result, next) {
    if (params.includeDeletionsSince == null) { return next(); }

    var options = {
      sort: { deleted: -1 }
    };

    userStreamsStorage.findDeletions(context.user, params.includeDeletionsSince, options,
      function (err, deletions) {
        if (err) { return next(errors.unexpectedError(err)); }

        result.streamDeletions = deletions;
        next();
      });
  }

  // CREATION

  api.register('streams.create',
    commonFns.getParamsValidation(methodsSchema.create.params),
    applyDefaultsForCreation,
    applyPrerequisitesForCreation,
    createStream);

  function applyDefaultsForCreation(context, params, result, next) {
    _.defaults(params, { parentId: null });
    next();
  }

  function applyPrerequisitesForCreation(context, params, result, next) {
    if (!context.canManageStream(params.parentId)) {
      return process.nextTick(next.bind(null, errors.forbidden()));
    }

    // strip ignored properties
    if (params.hasOwnProperty('children')) {
      delete params.children;
    }

    if (params.id) {
      if (string.isReservedId(params.id) ||
        string.isReservedId(params.id = slugify(params.id))) {
        return process.nextTick(next.bind(null, errors.invalidItemId(
          'The specified id "' + params.id + '" is not allowed.')));
      }
    }

    context.initTrackingProperties(params);

    next();
  }

  function createStream(context, params, result, next) {
    userStreamsStorage.insertOne(context.user, params, function (err, newStream) {
      if (err != null) {
        // Duplicate errors
        if (err.isDuplicate) {
          if (err.isDuplicateIndex('streamId')) {
            return next(errors.itemAlreadyExists(
              'stream', { id: params.id }, err));
          }
          if (err.isDuplicateIndex('name')) {
            return next(errors.itemAlreadyExists(
              'sibling stream', { name: params.name }, err));
          }
        }
        // Unknown parent stream error
        else if (params.parentId != null) {
          return next(errors.unknownReferencedResource(
            'parent stream', 'parentId', params.parentId, err
          ));
        }
        // Any other error
        return next(errors.unexpectedError(err));
      }

      result.stream = newStream;
      notifications.streamsChanged(context.user);
      next();
    });
  }

  // UPDATE

  api.register('streams.update',
    commonFns.getParamsValidation(methodsSchema.update.params),
    commonFns.catchForbiddenUpdate(streamSchema('update'), updatesSettings.ignoreProtectedFields, logger),
    applyPrerequisitesForUpdate,
    updateStream);

  function applyPrerequisitesForUpdate(context, params, result, next) {
    // check stream
    var stream = treeUtils.findById(context.streams, params.id);
    if (!stream) {
      return process.nextTick(next.bind(null,
        errors.unknownResource(
          'stream', params.id
        )
      ));
    }
    if (!context.canManageStream(stream.id)) {
      return process.nextTick(next.bind(null, errors.forbidden()));
    }

    // check target parent if needed
    if (params.update.parentId && !context.canManageStream(params.update.parentId)) {
      return process.nextTick(next.bind(null, errors.forbidden()));
    }

    context.updateTrackingProperties(params.update);

    next();
  }

  function updateStream(context, params, result, next) {
    userStreamsStorage.updateOne(context.user, { id: params.id }, params.update,
      function (err, updatedStream) {
        if (err != null) {
          // Duplicate error
          if (err.isDuplicate) {
            if (err.isDuplicateIndex('name')) {
              return next(errors.itemAlreadyExists(
                'sibling stream', { name: params.update.name }, err
              ));
            }
          }
          // Unknown parent stream error
          else if (params.update.parentId != null) {
            return next(errors.unknownReferencedResource(
              'parent stream', 'parentId', params.update.parentId, err
            ));
          }
          // Any other error
          return next(errors.unexpectedError(err));
        }

        result.stream = updatedStream;
        notifications.streamsChanged(context.user);
        next();
      });
  }

  // DELETION

  api.register('streams.delete',
    commonFns.getParamsValidation(methodsSchema.del.params),
    verifyStreamExistenceAndPermissions,
    deleteStream);

  function verifyStreamExistenceAndPermissions(context, params, result, next) {
    _.defaults(params, { mergeEventsWithParent: null });

    context.stream = treeUtils.findById(context.streams, params.id);
    if (context.stream == null) {
      return process.nextTick(next.bind(null,
        errors.unknownResource('stream', params.id)));
      }
    if (! context.canManageStream(context.stream.id)) {
      return process.nextTick(next.bind(null, errors.forbidden()));
    }

    next();
  }

  function deleteStream(context, params, result, next) {
    if (context.stream.trashed == null) {
      // move to trash
      flagAsTrashed(context, params, result, next);
    } else {
      // actually delete
      deleteWithData(context, params, result, next);
    }
  }

  function flagAsTrashed(context, params, result, next) {
    var updatedData = { trashed: true };
    context.updateTrackingProperties(updatedData);

    userStreamsStorage.updateOne(context.user, { id: params.id }, updatedData,
      function (err, updatedStream) {
        if (err) { return next(errors.unexpectedError(err)); }

        result.stream = updatedStream;
        notifications.streamsChanged(context.user);
        next();
      });
  }

  function deleteWithData(context, params, result, next) {
    let streamAndDescendantIds,
      parentId,
      hasLinkedEvents;
    async.series([
      function retrieveStreamIdsToDelete(stepDone) {
        userStreamsStorage.find(context.user, {}, null, function (err, streams) {
          if (err) {
            return stepDone(errors.unexpectedError(err));
          }
          // isnt this the same as context.stream
          var streamToDelete = treeUtils.findById(streams, params.id);
          //no need to check existence: done before already
          streamAndDescendantIds = treeUtils.collectPluckFromRootItem(streamToDelete, 'id');
          parentId = streamToDelete.parentId;

          stepDone();
        });
      },
      function checkIfRootStreamAndLinkedEventsExist(stepDone) {
        if (params.mergeEventsWithParent === true && parentId == null) {
          return stepDone(errors.invalidOperation(
            'Deleting a root stream with mergeEventsWithParent=true is rejected ' +
            'since there is no parent stream to merge linked events in.',
            { streamId: params.id }));
        }

        userEventsStorage.find(context.user, {streamIds: { $in: streamAndDescendantIds }},
          { limit: 1 }, function (err, events) {
            if (err) {
              return stepDone(errors.unexpectedError(err));
            }

            hasLinkedEvents = !!events.length;

            if (hasLinkedEvents && params.mergeEventsWithParent === null) {
              return stepDone(errors.invalidParametersFormat(
                'There are events referring to the deleted items ' +
                'and the `mergeEventsWithParent` parameter is missing.'));
            }

            stepDone();
          });
      },

      function handleLinkedEvents(stepDone) {
        if (!hasLinkedEvents) {
          return stepDone();
        }

        if (params.mergeEventsWithParent) {
          async.series([
            function generateLogIfNecessary(subStepDone) {
              if (!auditSettings.forceKeepHistory) {
                return subStepDone();
              }
              userEventsStorage.findStreamed(context.user,
                { streamIds: { $in: streamAndDescendantIds }}, null,
                function (err, eventsStream) {
                  if (err) {
                    return subStepDone(errors.unexpectedError(err));
                  }

                  let eventToVersion;
                  eventsStream.on('data', (event) => {
                    eventToVersion = _.extend(event, { headId: event.id });
                    delete eventToVersion.id;
                    userEventsStorage.insertOne(context.user, eventToVersion,
                      function (err) {
                        if (err) {
                          return subStepDone(errors.unexpectedError(err));
                        }
                      });
                  });

                  eventsStream.on('error', (err) => {
                    subStepDone(errors.unexpectedError(err));
                  });

                  eventsStream.on('end', () => {
                    subStepDone();
                  });

                });
            },
            function addParentStreamIdIfNeeded(subStepDone) {
              userEventsStorage.updateMany(context.user,
                { streamIds: { $ne: parentId, $in: streamAndDescendantIds }, headId: { $exists: false } }, // not already containing parentId 
                { 'streamIds.$': parentId }, // set first element only (not multi)
                function (err) {
                  if (err) {
                    return subStepDone(errors.unexpectedError(err));
                  }
                  notifications.eventsChanged(context.user);
                  subStepDone();
                });
            },
            function removeStreamdIds(subStepDone) {
              userEventsStorage.updateMany(context.user,
                { streamIds: { $in: streamAndDescendantIds }, headId: { $exists: false } },
                { $pull: { streamIds: { $in: streamAndDescendantIds } } },
                function (err) {
                  if (err) {
                    return subStepDone(errors.unexpectedError(err));
                  }
                  subStepDone();
                }
              );
            }
          ], stepDone);
        } else {
          // case mergeEventsWithParent = false

          async.series([
            function handleHistory(subStepDone) {
              if (auditSettings.deletionMode === 'keep-everything') {

                // history is untouched
                subStepDone();
              } else if (auditSettings.deletionMode === 'keep-authors') {

                userEventsStorage.findStreamed(context.user,
                  { streamIds: { $in: streamAndDescendantIds } }, { projection: { id: 1 } },
                  function (err, eventsStream) {
                    if (err) {
                      return subStepDone(errors.unexpectedError(err));
                    }
                    eventsStream.on('data', (head) => {
                      userEventsStorage.minimizeEventsHistory(context.user, head.id,
                        function (err) {
                          if (err) {
                            return subStepDone(errors.unexpectedError(err));
                          }
                        });
                    });

                    eventsStream.on('error', (err) => {
                      subStepDone(errors.unexpectedError(err));
                    });

                    eventsStream.on('end', () => {
                      subStepDone();
                    });

                  });
              } else {
                // default: deletionMode='keep-nothing'

                userEventsStorage.findStreamed(context.user,
                  { streamIds: { $in: streamAndDescendantIds } },
                  { projection: { id: 1, streamIds: 1 } },
                  function (err, eventsStream) {
                    if (err) {
                      return subStepDone(errors.unexpectedError(err));
                    }
                    eventsStream.on('data', (head) => {
                      // multiple StreamIds &&
                      // the streams to delete are NOT ALL in the streamAndDescendantIds list
                      if (head.streamIds.length > 1 && 
                        ! arrayAIsIncludedInB(head.streamIds, streamAndDescendantIds)) {
                          // event is still attached to existing streamId(s)
                          // we will remove the streamIds later on
                      } else {
                        // remove the events
                        userEventsStorage.removeMany(context.user, { headId: head.id },
                          function (err) {
                            if (err) {
                              return subStepDone(errors.unexpectedError(err));
                            }
                          });
                      }
                    });

                    eventsStream.on('error', (err) => {
                      subStepDone(errors.unexpectedError(err));
                    });

                    eventsStream.on('end', () => {
                      subStepDone();
                    });
                  });
              }
            },
            function deleteEventsWithAttachments(subStepDone) {
              userEventsStorage.findStreamed(context.user,
                { 
                  streamIds: { $in: streamAndDescendantIds }, 
                  attachments: { $exists: true }
                },
                { projection: { id: 1, streamIds: 1 } },
                function (err, eventsStream) {
                  if (err) {
                    return subStepDone(errors.unexpectedError(err));
                  }

                  eventsStream.on('data', (event) => {
                    // multiple StreamIds &&
                    // the streams to delete are NOT ALL in the streamAndDescendantIds list
                    if (event.streamIds.length > 1 &&
                      ! arrayAIsIncludedInB(event.streamIds, streamAndDescendantIds)) {
                      // event is still attached to existing streamId(s)
                      // we will remove the streamIds later on
                    } else {
                      userEventFilesStorage.removeAllForEvent(context.user, event.id, function (err) {
                        if (err) {
                          // async delete attached files (if any) – don't wait for
                          // this, just log possible errors
                          errorHandling.logError(err, null, logger);
                        }
                      });
                    }
                  });

                  eventsStream.on('error', (err) => {
                    subStepDone(errors.unexpectedError(err));
                  });
                  
                  eventsStream.on('end', () => {
                    subStepDone();
                  });    
                }
              );
            },
            function removeStreamdIdsFromAllEvents(subStepDone) {
              if (auditSettings.deletionMode === 'keep-everything') {
                // not removing anything
                return subStepDone();
              }
              userEventsStorage.updateMany(context.user,
                { streamIds: { $in: streamAndDescendantIds }, headId: { $exists: false } },
                { $pull: { streamIds: { $in: streamAndDescendantIds } } },
                function (err) {
                  if (err) {
                    return subStepDone(errors.unexpectedError(err));
                  }
                  subStepDone();
                }
              );
            },
            function deleteEvents(subStepDone) {
              const filter = {
                headId: { $exists: false },
              };
              if (auditSettings.deletionMode === 'keep-everything') {
                // they still have all their streamIds
                filter.streamIds = { $in: streamAndDescendantIds };
              } else {
                // their streamIds were removed by removeStreamdIdsFromAllEvents()
                filter.streamIds = [];
              }
              
              // we do a "raw" delete on all streamless events 
              // we do not want to change the "modifiedBy" and "modifiedDate"
              // to prevent running condition where another process would 
              // delete these data and mark the vent modified
              userEventsStorage.delete(context.user,
                filter,
                auditSettings.deletionMode, function (err) {
                  if (err) {
                    return subStepDone(errors.unexpectedError(err));
                  }
                  notifications.eventsChanged(context.user);
                  subStepDone();
                });
            }
          ], stepDone);
        }
      },
      function deleteStreams(stepDone) {
        userStreamsStorage.delete(
          context.user,
          { id: { $in: streamAndDescendantIds } },
          function (err) {
            if (err) {
              return stepDone(errors.unexpectedError(err));
            }
            result.streamDeletion = { id: params.id };
            notifications.streamsChanged(context.user);
            stepDone();
          });
      }
    ], next);
  }

};
module.exports.injectDependencies = true;

/**
 * Returns if an array has all elements contained in another.
 * 
 * @param {Array} a Contains element to check if they exists in b
 * @param {Array} b
 */
function arrayAIsIncludedInB (a, b) {
  return a.every(i => b.includes(i));
}
