/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fromCallback } = require('utils');
const fs = require('fs');
const path = require('path');
const { getUsersRepository } = require('business/src/users/index.ts');
const errors = require('errors').factory;
const { getLogger } = require('@pryv/boiler');
const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils.ts');
const setAdminAuditAccessId = setAuditAccessId(AuditAccessIds.ADMIN_TOKEN);

class Deletion {
  logger: any;

  storageLayer: any;

  config: any;
  constructor (logging: any, storageLayer: any, config: any) {
    this.logger = getLogger('business:deletion');
    this.storageLayer = storageLayer;
    this.config = config;
  }

  /**
   * Authorization check order:
   * 1- is a valid admin token
   * 2- is a valid personalToken
   */
  checkIfAuthorized (context: any, params: any, result: any, next: any) {
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

  async validateUserExists (context: any, params: any, result: any, next: any) {
    const usersRepository = await getUsersRepository();
    const user = await usersRepository.getUserByUsername(params.username);
    if (!user || !user.id) {
      return next(errors.unknownResource('user', params.username));
    }
    context.user = { id: user.id };
    context.user.username = user.username;
    next();
  }

  async validateUserFilepaths (context: any, params: any, result: any, next: any) {
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

  async deleteUserFiles (context: any, params: any, result: any, next: any) {
    const dirPaths = [
      this.config.get('storages:engines:filesystem:previewsDirPath')
    ];
    for (const dirPath of dirPaths) {
      await fs.promises.rm(path.join(dirPath, context.user.id), { recursive: true, force: true });
    }
    next();
  }

  async deleteHFData (context: any, params: any, result: any, next: any) {
    const conn = require('storages').seriesConnection;
    if (conn) {
      await conn.dropDatabase(`user.${params.username}`);
    }
    next();
  }

  async deleteAuditData (context: any, params: any, result: any, next: any) {
    const deleteUserDirectory = require('storage').userLocalDirectory.deleteUserDirectory;
    await deleteUserDirectory(context.user.id);
    next();
  }

  // Engine-agnostic audit erasure. The filesystem wipe in deleteAuditData
  // covers SQLite as a side-effect (per-user .sqlite file lives in the user
  // dir) but leaves PG audit_events rows behind. This step routes through
  // the AuditStorage interface so every engine converges on the same
  // end-state. Runs BEFORE deleteAuditData so the SQLite path closes the DB
  // file cleanly before the directory wipe.
  //
  // Behaviour gated by `audit:onUserDelete` operator setting.
  //   erase (default) — wipe via auditStorage.deleteUser.
  //   keep            — skip the wipe (HIPAA / MDR long-retention regimes).
  //   pseudonymise    — refused at boot by config-validation (depends on the
  //                     not-yet-shipped ALIASES primitive). If somehow seen here
  //                     (override during runtime), fall back to 'erase' + warn-log.
  async deleteAuditDataStorage (context: any, params: any, result: any, next: any) {
    try {
      const mode: string = this.config.get('audit:onUserDelete') || 'erase';
      if (mode === 'keep') {
        this.logger.info(
          `audit:onUserDelete=keep — skipping audit erasure for user ${context.user.id} (operator policy)`
        );
        return next();
      }
      if (mode === 'pseudonymise') {
        this.logger.warn(
          `audit:onUserDelete=pseudonymise requested for user ${context.user.id} but ALIASES primitive (open-pryv.io#38) is not yet available — falling back to 'erase'. config-validation should have blocked this at boot.`
        );
      }
      const auditStorage = require('storages').auditStorage;
      if (auditStorage != null) {
        await auditStorage.deleteUser(context.user.id);
      }
      next();
    } catch (err: any) {
      this.logger.error(err, err);
      return next(errors.unexpectedError(err));
    }
  }

  async deleteUser (context: any, params: any, result: any, next: any) {
    try {
      const dbCollections = [
        this.storageLayer.accesses,
        this.storageLayer.profile,
        this.storageLayer.webhooks
      ];
      const removals = dbCollections
        .map((coll) => fromCallback((cb: any) => coll.removeAll(context.user, cb)));
      const usersRepository = await getUsersRepository();
      await usersRepository.deleteOne(context.user.id, context.user.username);
      await Promise.all(removals);
      await fromCallback((cb: any) => this.storageLayer.sessions.remove({ username: context.user.username }, cb));
    } catch (error) {
      this.logger.error(error, error);
      return next(errors.unexpectedError(error));
    }
    result.userDeletion = { username: context.user.username };
    next();
  }
}

function findNotAccessibleDir (paths: any) {
  let notAccessibleDir = '';
  for (const path of paths) {
    let stat;
    try {
      stat = fs.statSync(path);
      if (!stat.isDirectory()) {
        throw new Error();
      }
      fs.accessSync(path, fs.constants.W_OK + fs.constants.X_OK);
    } catch (err: any) {
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
export default Deletion;
export { Deletion };