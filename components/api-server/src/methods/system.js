const errors = require('components/errors').factory;
const commonFns = require('./helpers/commonFunctions');
const mailing = require('./helpers/mailing');
const errorHandling = require('components/errors').errorHandling;
const methodsSchema = require('../schema/systemMethods');
const string = require('./helpers/string');
const _ = require('lodash');
const async = require('async');
const cuid = require('cuid');

/**
 * @param systemAPI
 * @param usersStorage
 * @param userAccessesStorage
 * @param servicesSettings Must contain `email`
 * @param api The user-facing API, used to compute usage stats per method
 * @param logging
 * @param storageLayer
 */
module.exports = function (
  systemAPI, usersStorage, userAccessesStorage, servicesSettings, api, logging, storageLayer
) {

  var logger = logging.getLogger('methods/system');
  const POOL_USERNAME_PREFIX = 'pool@';
  const TEMP_USERNAME_PREFIX = 'temp@';
  const POOL_REGEX = new RegExp( '^'  + POOL_USERNAME_PREFIX);

  // ---------------------------------------------------------------- createUser
  systemAPI.register('system.createUser',
    commonFns.getParamsValidation(methodsSchema.createUser.params),
    applyDefaultsForCreation,
    createUser,
    sendWelcomeMail);

  function applyDefaultsForCreation(context, params, result, next) {
    params.storageUsed = {
      dbDocuments: 0,
      attachedFiles: 0
    };
    next();
  }

  function createUser(context, params, result, next) {
    if (params.username === 'recla') {
      result.id = 'dummy-test-user';
      context.user = _.defaults({id: result.id}, params);
      next();
    } else {
      // Consume a pool user if available or use default creation
      createUserOrConsumePool(params, (err, user) => {
        if (err != null) return next(handleCreationErrors(err, params));
        result.id = user.id;
        context.user = user;
        next();
      });
    }
  }

  function createUserOrConsumePool(userInfo, callback) {
    // Try to consume a user from pool
    usersStorage.findOneAndUpdate({username: {$regex : POOL_REGEX}}, userInfo,
      (err, updatedUser) => {
        // Fallback to default user creation in case of error or empty pool
        if (err != null || updatedUser == null) {
          // First create a temp user
          const tempUser = _.clone(userInfo);
          tempUser.username = TEMP_USERNAME_PREFIX + cuid();
          usersStorage.insertOne(tempUser, (err, newUser) => {
            if (err != null) return callback(err);
            // Convert temp to final user
            return initUser(newUser, userInfo.username, callback);
          });
        }
        else {        
          return callback(null, updatedUser);
        }
      }
    );
  }

  function initUser(tempUser, username, callback) {
    const repositories = [storageLayer.accesses, storageLayer.events,
      storageLayer.followedSlices, storageLayer.profile, storageLayer.streams];
    // Init user's repositories (create collections and indexes)
    async.eachSeries(repositories, (repository, stepDone) => {
      repository.initCollection(tempUser, stepDone);
    }, (err) => {
      if (err != null) return callback(err);
      // Rename temp username
      usersStorage.updateOne({username: tempUser.username}, {username: username},
        (err, finalUser) => {
          if (err != null) return callback(err);
          return callback(null, finalUser);
        });
    });
  }

  function handleCreationErrors (err, params) {
    // Duplicate errors
    if (err.isDuplicateIndex('email')) {
      return errors.itemAlreadyExists('user', { email: params.email }, err);
    }
    if (err.isDuplicateIndex('username')) {
      return errors.itemAlreadyExists('user', { username: params.username }, err);
    }
    // Any other error
    return errors.unexpectedError(err, 'Unexpected error while saving user.');
  }

  function sendWelcomeMail(context, params, result, next) {
    const emailSettings = servicesSettings.email;
    
    // Skip this step if welcome mail is deactivated
    const isMailActivated = emailSettings.enabled;
    if (isMailActivated === false || 
       (isMailActivated != null && isMailActivated.welcome === false)) {
      return next();
    }
    
    const recipient = {
      email: context.user.email,
      name: context.user.username,
      type: 'to'
    };
    
    const substitutions = {
      USERNAME: context.user.username,
      EMAIL: context.user.email
    };
    
    mailing.sendmail(emailSettings, emailSettings.welcomeTemplate, recipient, 
      substitutions, context.user.language, (err) => {
        // Don't fail creation process itself (mail isn't critical), just log error
        if (err) {
          errorHandling.logError(err, null, logger);
        }
        
        next();
      });
  }

  // ------------------------------------------------------------ createPoolUser
  systemAPI.register('system.createPoolUser',
    applyDefaultsForCreation,
    createPoolUser);
  
  function createPoolUser(context, params, result, next) {
    const uniqueId = cuid();
    const username = POOL_USERNAME_PREFIX + uniqueId;
    const tempUsername = TEMP_USERNAME_PREFIX + uniqueId;
    const poolUser = {
      username: tempUsername,
      passwordHash: 'changeMe',
      language: 'en',
      email: username+'@email'
    };
    usersStorage.insertOne(poolUser, (err, tempUser) => {
      if (err != null) return next(handleCreationErrors(err, params));

      return initUser(tempUser, username, (err, finalUser) => {
        if (err != null) return next(handleCreationErrors(err, params));
        result.id = finalUser.id;
        context.user = finalUser;
        return next();
      });
    });
  }

  // ---------------------------------------------------------- getUsersPoolSize
  systemAPI.register('system.getUsersPoolSize',
    countPoolUsers);

  function countPoolUsers(context, params, result, next) {
    usersStorage.count({username: { $regex : POOL_REGEX}},
      (err, size) => {
        if (err != null) return next(errors.unexpectedError(err));

        result.size = size ? size : 0;
        return next();
      });
  }

  // --------------------------------------------------------------- getUserInfo
  systemAPI.register('system.getUserInfo',
    commonFns.getParamsValidation(methodsSchema.getUserInfo.params),
    retrieveUser,
    getUserInfoInit,
    getUserInfoSetAccessStats);

  function retrieveUser(context, params, result, next) {
    usersStorage.findOne({username: params.username}, null, function (err, user) {
      if (err) { return next(errors.unexpectedError(err)); }
      if (! user) {
        return next(errors.unknownResource('user', this.username));
      }

      context.user = user;
      next();
    });
  }

  function getUserInfoInit(context, params, result, next) {
    result.userInfo = {
      username: context.user.username,
      storageUsed: context.user.storageUsed
    };
    next();
  }

  function getUserInfoSetAccessStats(context, params, result, next) {
    const info = _.defaults(result.userInfo, {
      lastAccess: 0,
      callsTotal: 0,
      callsDetail: {},
      callsPerAccess: {}
    });
    getAPIMethodKeys().forEach(function (methodKey) {
      info.callsDetail[methodKey] = 0;
    });

    userAccessesStorage.find(context.user, {}, null, function (err, accesses) {
      if (err) { return next(errors.unexpectedError(err)); }

      accesses.forEach(function (access) {
        if (access.lastUsed > info.lastAccess) {
          info.lastAccess = access.lastUsed;
        }

        var accessKey = getAccessStatsKey(access);
        if (! info.callsPerAccess[accessKey]) {
          info.callsPerAccess[accessKey] = 0;
        }
        if (access.calls) {
          _.forOwn(access.calls, function (total, methodKey) {
            info.callsTotal += total;
            info.callsDetail[methodKey] += total;
            info.callsPerAccess[accessKey] += total;
          });
        }
      });
      
      // Since we've merged new keys into _the old userInfo_ on result, we don't
      // need to return our result here, since we've modified the result in 
      // place. 

      next();
    });
  }

  function getAPIMethodKeys() {
    return api.getMethodKeys().map(string.toMongoKey); 
  }

  function getAccessStatsKey(access) {
    if (access.type === 'shared') {
      // don't leak user private data
      return 'shared';
    } else {
      return access.name;
    }
  }

};

module.exports.injectDependencies = true;
