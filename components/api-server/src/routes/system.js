/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const errors = require('errors').factory;
const Paths = require('./Paths');
const methodCallback = require('./methodCallback');
const contentType = require('middleware').contentType;
const _ = require('lodash');
const { getLogger } = require('@pryv/boiler');
const { setMinimalMethodContext, setMethodId } = require('middleware');
// System (e.g. registration server) calls route handling.
module.exports = function system (expressApp, app) {
  const systemAPI = app.systemAPI;
  const config = app.config;
  const adminAccessKey = config.get('auth:adminAccessKey');
  const logger = getLogger('routes:system');
  /**
   * Handle common parameters.
   *
   * Bootstrap ack uses a one-time join token instead of the admin key, so it
   * needs to be excluded from the admin-key gate. Everything else under
   * /system/* still requires `auth.adminAccessKey`.
   */
  expressApp.all(Paths.System + '/*', setMinimalMethodContext, checkAuth);
  expressApp.post(Paths.System + '/create-user', contentType.json, setMethodId('system.createUser'), createUser);
  function createUser (req, res, next) {
    const params = _.extend({}, req.body);
    systemAPI.call(req.context, params, methodCallback(res, next, 201));
  }
  expressApp.get(Paths.System + '/user-info/:username', setMethodId('system.getUserInfo'), function (req, res, next) {
    const params = {
      username: req.params.username
    };
    systemAPI.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.delete(Paths.System + '/users/:username/mfa', setMethodId('system.deactivateMfa'), function (req, res, next) {
    systemAPI.call(req.context, { username: req.params.username }, methodCallback(res, next, 204));
  });
  // --------------------- admin user listing ----------------- //
  expressApp.get(Paths.System + '/admin/users', setMethodId('system.listUsers'), function (req, res, next) {
    systemAPI.call(req.context, {}, methodCallback(res, next, 200));
  });
  // --------------------- admin cores listing ----------------- //
  expressApp.get(Paths.System + '/admin/cores', setMethodId('system.listCores'), function (req, res, next) {
    systemAPI.call(req.context, {}, methodCallback(res, next, 200));
  });
  // --------------------- bootstrap ack ----------------- //
  // POST /system/admin/cores/ack — called by a freshly bootstrapped core.
  // Auth is the one-time join token in the request body, NOT the admin key
  // (see bypass in checkAuth below). The handler verifies the token via
  // TokenStore, flips PlatformDB's `available:true`, returns a cluster snapshot.
  expressApp.post(Paths.System + '/admin/cores/ack', contentType.json, async (req, res, next) => {
    try {
      const TokenStore = require('business/src/bootstrap').TokenStore;
      const ackHandler = require('business/src/bootstrap').ackHandler;
      const tokensPath = config.get('cluster:tokens:path');
      if (!tokensPath) {
        throw new Error('cluster.tokens.path is not configured');
      }
      const tokenStore = new TokenStore({ path: tokensPath });
      const platformDB = require('storages').platformDB;
      const handle = ackHandler.makeHandler({ tokenStore, platformDB });
      const result = await handle({ body: req.body, ip: req.ip });
      res.status(result.statusCode).json(result.body);
    } catch (err) {
      logger.error('cores/ack handler failed: ' + err.message);
      next(err);
    }
  });
  // --------------------- user validation (pre-registration) ----------------- //
  expressApp.post(Paths.System + '/users/validate', contentType.json, async (req, res, next) => {
    try {
      const { username, invitationToken, uniqueFields = {} } = req.body;
      const { getPlatform } = require('platform');
      const platform = await getPlatform();
      const platformDB = require('storages').platformDB;

      // 1. Check invitation token via Platform (PlatformDB + config fallback)
      const isTokenValid = await platform.isInvitationTokenValid(invitationToken);
      if (!isTokenValid) {
        return res.status(400).json({ reservation: false, error: { id: 'invitationToken-invalid' } });
      }

      // 2. Check username uniqueness (username is in usersRepository, not PlatformDB)
      const { getUsersRepository } = require('business/src/users');
      const usersRepository = await getUsersRepository();
      if (await usersRepository.usernameExists(username)) {
        return res.status(400).json({ reservation: false, error: { id: 'item-already-exists', data: { username } } });
      }

      // 3. Check unique fields
      delete uniqueFields.username;
      const conflicts = {};
      for (const [field, value] of Object.entries(uniqueFields)) {
        const existing = await platformDB.getUsersUniqueField(field, value);
        if (existing) {
          conflicts[field] = value;
        }
      }
      if (Object.keys(conflicts).length > 0) {
        return res.status(400).json({ reservation: false, error: { id: 'item-already-exists', data: conflicts } });
      }

      // 4. Reserve unique fields
      uniqueFields.username = username;
      for (const [field, value] of Object.entries(uniqueFields)) {
        const reserved = await platformDB.setUserUniqueFieldIfNotExists(username, field, value);
        if (!reserved) {
          return res.status(400).json({ reservation: false, error: { id: 'item-already-exists', data: { [field]: value } } });
        }
      }

      // 5. Set user-to-core mapping if provided
      if (req.body.core && !platform.isSingleCore) {
        await platformDB.setUserCore(username, req.body.core);
      }

      res.status(200).json({ reservation: true });
    } catch (err) {
      next(err);
    }
  });
  // --------------------- user update (system) ----------------- //
  expressApp.put(Paths.System + '/users', contentType.json, async (req, res, next) => {
    try {
      const { username, user: fieldsForUpdate = {}, fieldsToDelete = {} } = req.body;
      if (!username) {
        return next(errors.invalidParametersFormat('Missing username'));
      }
      const platformDB = require('storages').platformDB;

      // Prevent username change
      delete fieldsForUpdate.username;
      delete fieldsToDelete.username;

      // Update indexed/unique fields
      const systemStreams = require('business/src/system-streams');
      for (const [field, value] of Object.entries(fieldsForUpdate)) {
        if (systemStreams.uniqueFieldNames.includes(field)) {
          await platformDB.setUserUniqueField(username, field, value);
        }
        if (systemStreams.indexedFieldNames.includes(field)) {
          await platformDB.setUserIndexedField(username, field, value);
        }
      }

      // Delete fields
      for (const field of Object.keys(fieldsToDelete)) {
        if (systemStreams.uniqueFieldNames.includes(field)) {
          const currentValue = await platformDB.getUsersUniqueField(field, fieldsToDelete[field]);
          if (currentValue === username) {
            await platformDB.deleteUserUniqueField(field, fieldsToDelete[field]);
          }
        }
        if (systemStreams.indexedFieldNames.includes(field)) {
          await platformDB.deleteUserIndexedField(username, field);
        }
      }

      res.status(200).json({ user: true });
    } catch (err) {
      next(err);
    }
  });
  // --------------------- user delete (system, with onlyReg/dryRun) ----------------- //
  expressApp.delete(Paths.System + '/users/:username', async (req, res, next) => {
    try {
      const username = req.params.username;
      const onlyReg = req.query.onlyReg === 'true';
      const dryRun = req.query.dryRun === 'true';

      if (!onlyReg) {
        return next(errors.invalidOperation('This method needs onlyReg=true for now (query).'));
      }

      const platformDB = require('storages').platformDB;

      // Check user exists via usersRepository (username is in MongoDB/PG, not PlatformDB)
      const { getUsersRepository } = require('business/src/users');
      const usersRepository = await getUsersRepository();
      if (!await usersRepository.usernameExists(username)) {
        return next(errors.unknownResource());
      }

      if (!dryRun) {
        // Delete all platform entries for this user
        const systemStreams = require('business/src/system-streams');
        for (const field of systemStreams.uniqueFieldNames) {
          const value = await platformDB.getUserIndexedField(username, field);
          if (value != null) {
            await platformDB.deleteUserUniqueField(field, value);
          }
        }
        for (const field of systemStreams.indexedFieldNames) {
          await platformDB.deleteUserIndexedField(username, field);
        }
      }

      res.status(200).json({ result: { dryRun: !!dryRun, deleted: !dryRun } });
    } catch (err) {
      next(err);
    }
  });
  // --------------------- health checks ----------------- //
  expressApp.get(Paths.System + '/check-platform-integrity', setMethodId('system.checkPlatformIntegrity'), function (req, res, next) {
    systemAPI.call(req.context, {}, methodCallback(res, next, 200));
  });
  // Checks if `req` contains valid authorization to access the system routes.
  //
  function checkAuth (req, res, next) {
    // Bootstrap ack uses one-time join token instead of adminAccessKey.
    // The handler itself verifies the token; admit the request unconditionally.
    if (req.method === 'POST' && req.path === Paths.System + '/admin/cores/ack') {
      return next();
    }
    const secret = req.headers.authorization;
    if (secret == null || secret !== adminAccessKey) {
      logger.warn('Unauthorized attempt to access system route', {
        url: req.url,
        ip: req.ip,
        headers: req.headers,
        body: req.body
      });
      // return "not found" to avoid encouraging retries
      return next(errors.unknownResource());
    }
    next();
  }
};
