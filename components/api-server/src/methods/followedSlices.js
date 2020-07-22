var async = require('async'),
    commonFns = require('./helpers/commonFunctions'),
    errors = require('components/errors').factory,
    methodsSchema = require('../schema/followedSlicesMethods');

/**
 * Followed slices methods implementations.
 * TODO: refactor methods as chains of functions
 *
 * @param api
 * @param userFollowedSlicesStorage
 * @param notifications
 */
module.exports = function (api, userFollowedSlicesStorage, notifications){

  // COMMON

  api.register('followedSlices.*',
    commonFns.requirePersonalAccess);

  // RETRIEVAL

  api.register('followedSlices.get',
    commonFns.getParamsValidation(methodsSchema.get.params),
    function (context, params, result, next) {
      if (! context.access.isPersonal()) {
        return process.nextTick(next.bind(null,
          errors.forbidden(
            'You cannot access this resource using the given access token.'
          )));
      }

      userFollowedSlicesStorage.find(context.user, {}, null, function (err, slices) {
        if (err) { return next(errors.unexpectedError(err)); }
        result.followedSlices = slices;
        next();
      });
    });

  // CREATION

  api.register('followedSlices.create',
    commonFns.getParamsValidation(methodsSchema.create.params),
    function (context, params, result, next) {


      if (! context.access.isPersonal()) {
        return process.nextTick(next.bind(null,
          errors.forbidden(
            'You cannot access this resource using the given access token.'
          )
        ));
      }
      userFollowedSlicesStorage.insertOne(context.user, params, function (err, newSlice) {
        if (err) {
          return next(getCreationOrUpdateError(err, params));
        }


        result.followedSlice = newSlice;
        notifications.followedSlicesChanged(context.user);
        next();
      });
    });

  // UPDATE

  api.register('followedSlices.update',
    commonFns.getParamsValidation(methodsSchema.update.params),
    function (context, params, result, next) {
      if (! context.access.isPersonal()) {
        return process.nextTick(next.bind(null,
          errors.forbidden(
            'You cannot access this resource using the given access token.'
          )
        ));
      }

      async.series([
        function checkSlice(stepDone) {
          userFollowedSlicesStorage.findOne(context.user, {id: params.id}, null,
            function (err, slice) {
              if (err) { return stepDone(errors.unexpectedError(err)); }

              if (! slice) {
                return stepDone(errors.unknownResource(
                  'followed slice', params.id
                ));
              }

              stepDone();
            });
        },
        function update(stepDone) {
          userFollowedSlicesStorage.updateOne(context.user, {id: params.id}, params.update,
            function (err, updatedSlice) {
              if (err) {
                return stepDone(getCreationOrUpdateError(err, params.update));
              }

              result.followedSlice = updatedSlice;
              notifications.followedSlicesChanged(context.user);
              stepDone();
            });
        }
      ], next);
    });

  /**
   * Returns the error to propagate given `dbError` and `params` as input. 
   */
  function getCreationOrUpdateError(dbError, params) {
    // Duplicate errors
    if (dbError.isDuplicateIndex('name')) {
      return errors.itemAlreadyExists('followed slice',
        {name: params.name}, dbError);
    } 
    if (dbError.isDuplicateIndex('username') && dbError.isDuplicateIndex('accessToken')) {
      return errors.itemAlreadyExists('followed slice',
        { url: params.url, accessToken: params.accessToken }, dbError);
    }
    // Any other error
    return errors.unexpectedError(dbError);
  }

  // DELETION

  api.register('followedSlices.delete',
    commonFns.getParamsValidation(methodsSchema.del.params),
    function (context, params, result, next) {
      if (! context.access.isPersonal()) {
        return process.nextTick(next.bind(null,
          errors.forbidden(
            'You cannot access this resource using the given access token.'
          )
        ));
      }

      userFollowedSlicesStorage.findOne(context.user, {id: params.id}, null, function (err, slice) {
        if (err) { return next(errors.unexpectedError(err)); }

        if (! slice) {
          return next(errors.unknownResource(
            'followed slice',
            params.id
          ));
        }

        userFollowedSlicesStorage.removeOne(context.user, {id: params.id}, function (err) {
          if (err) { return next(errors.unexpectedError(err)); }

          result.followedSliceDeletion = {id: params.id};
          notifications.followedSlicesChanged(context.user);
          next();
        });
      });
    });

};
module.exports.injectDependencies = true;
