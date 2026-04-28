/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const { fromCallback } = require('utils');
const fs = require('fs');
const path = require('path');
const { getUsersRepository } = require('business/src/users');
const errors = require('errors').factory;
const { getLogger } = require('@pryv/boiler');
const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils');
const setAdminAuditAccessId = setAuditAccessId(AuditAccessIds.ADMIN_TOKEN);

/**
 * TODO: cleanup this class… it breaks encapsulation (e.g. with event files) and its scope is unclear
 */
class Deletion {
  logger;

  storageLayer;

  config;
  constructor (logging, storageLayer, config) {
    this.logger = getLogger('business:deletion');
    this.storageLayer = storageLayer;
    this.config = config;
  }

  /**
   * Authorization check order:
   * 1- is a valid admin token
   * 2- is a valid personalToken
   * @param {MethodContext} context
   * @param {unknown} params
   * @param {Result} result
   * @param {ApiCallback} next
   * @returns {any}
   */
  checkIfAuthorized (context, params, result, next) {
    const canDelete = this.config.get('user-account:delete');
    if (canDelete.includes('adminToken')) {
      if (this.config.get('auth:adminAccessKey') === context.authorizationHeader) {
        return setAdminAuditAccessId(context, params, result, next);
      }
    }
    if (canDelete.includes('personalToken')) {
      if (context.access &&
                context.access.isPersonal &&
                context.access.isPersonal()) {
        return next();
      }
      // If personal Token is available, then error code is different
      return next(errors.invalidAccessToken('Cannot find access from token.', 403));
    }
    return next(errors.unknownResource());
  }

  /**
   * @param {MethodContext} context
   * @param {unknown} params
   * @param {Result} result
   * @param {ApiCallback} next
   * @returns {Promise<any>}
   */
  async validateUserExists (context, params, result, next) {
    const usersRepository = await getUsersRepository();
    const user = await usersRepository.getUserByUsername(params.username);
    if (!user || !user.id) {
      return next(errors.unknownResource('user', params.username));
    }
    context.user = { id: user.id };
    context.user.username = user.username;
    next();
  }

  /**
   * @param {MethodContext} context
   * @param {unknown} params
   * @param {Result} result
   * @param {ApiCallback} next
   * @returns {Promise<any>}
   */
  async validateUserFilepaths (context, params, result, next) {
    const dirPaths = [
      path.join(this.config.get('storages:engines:filesystem:previewsDirPath'), context.user.id)
    ];
    // NOTE User specific paths are constructed by appending the user _id_ to the
    // `paths` constant above.
    // NOTE Since user specific paths are created lazily, we should not expect
    //  them to be there. But _if_ they are, they need be accessible.
    // Let's check if we can change into and write into the user's paths:
    const inaccessibleDirectory = findNotAccessibleDir(dirPaths.map((p) => path.join(p, context.user.id)));
    if (inaccessibleDirectory) {
      const error = new Error(`Directory '${inaccessibleDirectory}' is inaccessible or missing.`);
      this.logger.error(error, error);
      return next(errors.unexpectedError(error));
    }
    next();
  }

  /**
   * @param {MethodContext} context
   * @param {unknown} params
   * @param {Result} result
   * @param {ApiCallback} next
   * @returns {Promise<void>}
   */
  async deleteUserFiles (context, params, result, next) {
    const dirPaths = [
      this.config.get('storages:engines:filesystem:previewsDirPath')
    ];
    for (const dirPath of dirPaths) {
      await fs.promises.rm(path.join(dirPath, context.user.id), { recursive: true, force: true });
    }
    next();
  }

  /**
   * @param {MethodContext} context
   * @param {unknown} params
   * @param {Result} result
   * @param {ApiCallback} next
   * @returns {Promise<any>}
   */
  async deleteHFData (context, params, result, next) {
    const conn = require('storages').seriesConnection;
    if (conn) {
      await conn.dropDatabase(`user.${params.username}`);
    }
    next();
  }

  /**
   * @param {MethodContext} context
   * @param {unknown} params
   * @param {Result} result
   * @param {ApiCallback} next
   * @returns {Promise<any>}
   */
  async deleteAuditData (context, params, result, next) {
    const deleteUserDirectory = require('storage').userLocalDirectory.deleteUserDirectory;
    await deleteUserDirectory(context.user.id);
    next();
  }

  /**
   * @param {MethodContext} context
   * @param {unknown} params
   * @param {Result} result
   * @param {ApiCallback} next
   * @returns {Promise<any>}
   */
  async deleteUser (context, params, result, next) {
    try {
      const dbCollections = [
        this.storageLayer.accesses,
        this.storageLayer.profile,
        this.storageLayer.webhooks
      ];
      const removals = dbCollections
        .map((coll) => fromCallback((cb) => coll.removeAll(context.user, cb)));
      const usersRepository = await getUsersRepository();
      await usersRepository.deleteOne(context.user.id, context.user.username);
      await Promise.all(removals);
      await fromCallback((cb) => this.storageLayer.sessions.remove({ username: context.user.username }, cb));
    } catch (error) {
      this.logger.error(error, error);
      return next(errors.unexpectedError(error));
    }
    result.userDeletion = { username: context.user.username };
    next();
  }
}

/**
 * @param {Array<string>} paths
 * @returns {string}
 */
function findNotAccessibleDir (paths) {
  let notAccessibleDir = '';
  for (const path of paths) {
    let stat;
    try {
      stat = fs.statSync(path);
      if (!stat.isDirectory()) {
        throw new Error();
      }
      fs.accessSync(path, fs.constants.W_OK + fs.constants.X_OK);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // ignore if file does not exist
        continue;
      } else {
        notAccessibleDir = path;
        break;
      }
    }
  }
  return notAccessibleDir;
}
module.exports = Deletion;
