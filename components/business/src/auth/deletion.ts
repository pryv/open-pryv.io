/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { ConfigLike as Config } from '@pryv/boiler';
import type { Logger } from '@pryv/boiler';
const require = createRequire(import.meta.url);
const { fromCallback } = require('utils');
const fs = require('fs');
const path = require('path');
const { getUsersRepository } = require('business/src/users/index.ts');
const { accountSeriesNamespaces } = require('business/src/series/namespace.ts');
const errors = require('errors').factory;
const isAdminKey = require('middleware/src/isAdminKey.ts').default;
const { getLogger } = require('@pryv/boiler');
const { setAuditAccessId, AuditAccessIds } = require('audit/src/MethodContextUtils.ts');
const setAdminAuditAccessId = setAuditAccessId(AuditAccessIds.ADMIN_TOKEN);

type MethodContext = {
  user: { id: string; username: string };
  access?: { id?: string; isPersonal? (): boolean };
  authorizationHeader?: string;
  source?: { ip?: string };
};
type ResultBag = Record<string, unknown>;
type Next = (err?: unknown) => void;
type StorageLayer = {
  accesses: { removeAll (user: { id: string }, cb: (err: Error | null) => void): void };
  profile: { removeAll (user: { id: string }, cb: (err: Error | null) => void): void };
  webhooks: { removeAll (user: { id: string }, cb: (err: Error | null) => void): void };
  sessions: { remove (query: Record<string, unknown>, cb: (err: Error | null) => void): void };
};

class Deletion {
  logger: Logger;
  storageLayer: StorageLayer;
  config: Config;
  constructor (_logging: unknown, storageLayer: StorageLayer, config: Config) {
    this.logger = getLogger('business:deletion');
    this.storageLayer = storageLayer;
    this.config = config;
  }

  /**
   * Authorization check order:
   * 1- is a valid admin token
   * 2- is a valid personalToken
   */
  async checkIfAuthorized (context: MethodContext, params: Record<string, unknown>, result: ResultBag, next: Next) {
    const canDelete = this.config.get('user-account:delete') as string[];
    if (canDelete.includes('adminToken')) {
      if (isAdminKey(context.authorizationHeader, this.config.get('auth:adminAccessKey'))) {
        return setAdminAuditAccessId(context, params, result, next);
      }
      // Neither the key nor the header: a near-miss key would land in the log.
      if (!context.access?.isPersonal?.()) {
        this.logger.warn('Unauthorized attempt to delete an account', {
          username: params.username,
          ip: context.source?.ip
        });
      }
    }
    if (canDelete.includes('personalToken')) {
      if (context.access &&
                context.access.isPersonal &&
                context.access.isPersonal()) {
        // A personal token only deletes its own account, whatever the
        // transport (a batch call or socket.io names the target in params).
        const usersRepository = await getUsersRepository();
        const targetId = typeof params.username === 'string'
          ? await usersRepository.getUserIdForUsername(params.username)
          : null;
        if (targetId == null || targetId !== context.user?.id) {
          return next(errors.forbidden('A personal token can only delete its own account.'));
        }
        return next();
      }
      // If personal Token is available, then error code is different
      return next(errors.invalidAccessToken('Cannot find access from token.', 403));
    }
    return next(errors.unknownResource());
  }

  async validateUserExists (context: MethodContext, params: { username: string }, _result: ResultBag, next: Next) {
    const usersRepository = await getUsersRepository();
    const user = await usersRepository.getUserByUsername(params.username);
    if (!user || !user.id) {
      return next(errors.unknownResource('user', params.username));
    }
    context.user = { id: user.id, username: user.username };
    next();
  }

  async validateUserFilepaths (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    const dirPaths = [
      path.join(this.config.get('storages:engines:filesystem:previewsDirPath') as string, context.user.id)
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

  async deleteUserFiles (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    const dirPaths = [
      this.config.get('storages:engines:filesystem:previewsDirPath') as string
    ];
    for (const dirPath of dirPaths) {
      await fs.promises.rm(path.join(dirPath, context.user.id), { recursive: true, force: true });
    }
    next();
  }

  // Series are keyed by a name of the account, not by its id. Drops the
  // namespace of the canonical username (resolved by validateUserExists,
  // whatever name addressed the deletion) and of every alias, former usernames
  // included. Runs before deleteUser, while the alias index still lists them.
  async deleteHFData (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    const conn = require('storages').seriesConnection;
    if (conn) {
      const usersRepository = await getUsersRepository();
      const namespaces = await accountSeriesNamespaces(usersRepository.usersIndex, context.user.id, context.user.username);
      for (const namespace of namespaces) {
        await conn.dropDatabase(namespace);
      }
    }
    next();
  }

  // Engine-agnostic attachment erasure. The user-directory wipe in
  // deleteAuditData covers the filesystem engine as a side-effect
  // (attachments live under the per-user directory) but leaves objects
  // behind on remote stores (S3). This step routes through the
  // EventFiles interface so every fileStorage engine converges on the
  // same end-state; for the filesystem engine it is an idempotent
  // subset of the directory wipe.
  async deleteAttachments (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    try {
      const { getEventFiles } = require('storage/src/eventFiles/getEventFiles.ts');
      const eventFiles = await getEventFiles();
      await eventFiles.removeAllForUser(context.user.id);
      next();
    } catch (err: unknown) {
      this.logger.error(err, err);
      return next(errors.unexpectedError(err));
    }
  }

  // Wipes the user directory. Under `audit:onUserDelete: keep` with a
  // file-backed audit storage (SQLite), the per-user audit database lives in
  // that directory: its files (with the WAL companions) stay at their path,
  // still opened by user id, as PostgreSQL keeps the audit rows keyed by user
  // id. The file is never unlinked nor replaced, so the handles other
  // processes hold on it stay valid.
  async deleteAuditData (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    try {
      const userLocalDirectory = require('storage').userLocalDirectory;
      const keep: string[] = [];
      if (this.onUserDeleteMode() === 'keep') {
        const auditStorage = require('storages').auditStorage;
        if (typeof auditStorage?.existingPathForUser === 'function') {
          const auditPath: string = auditStorage.existingPathForUser(context.user.id);
          if (path.dirname(auditPath) === userLocalDirectory.getPathForUser(context.user.id)) {
            auditStorage.closeUser?.(context.user.id);
            const name = path.basename(auditPath);
            keep.push(name, name + '-wal', name + '-shm');
          }
        }
      }
      await userLocalDirectory.deleteUserDirectory(context.user.id, keep);
    } catch (err: unknown) {
      this.logger.error(err, err);
      return next(errors.unexpectedError(err));
    }
    next();
  }

  onUserDeleteMode (): string {
    return (this.config.get('audit:onUserDelete') as string) || 'erase';
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
  //   keep            — skip the wipe (HIPAA / MDR long-retention regimes);
  //                     deleteAuditData then keeps the SQLite audit files.
  //   pseudonymise    — refused at boot by config-validation (depends on the
  //                     not-yet-shipped ALIASES primitive). If somehow seen here
  //                     (override during runtime), fall back to 'erase' + warn-log.
  async deleteAuditDataStorage (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    try {
      const mode = this.onUserDeleteMode();
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
    } catch (err: unknown) {
      this.logger.error(err, err);
      return next(errors.unexpectedError(err));
    }
  }

  async deleteUser (context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
    try {
      const dbCollections = [
        this.storageLayer.accesses,
        this.storageLayer.profile,
        this.storageLayer.webhooks
      ];
      const removals = dbCollections
        .map((coll) => fromCallback((cb: (err: Error | null) => void) => coll.removeAll(context.user, cb)));
      const usersRepository = await getUsersRepository();
      await usersRepository.deleteOne(context.user.id, context.user.username);
      await Promise.all(removals);
      await fromCallback((cb: (err: Error | null) => void) => this.storageLayer.sessions.remove({ username: context.user.username }, cb));
      await fromCallback((cb: (err: Error | null) => void) => this.storageLayer.sessions.remove({ userId: context.user.id }, cb));
    } catch (error) {
      this.logger.error(error, error);
      return next(errors.unexpectedError(error));
    }
    result.userDeletion = { username: context.user.username };
    next();
  }
}

function findNotAccessibleDir (paths: string[]): string {
  let notAccessibleDir = '';
  for (const path of paths) {
    let stat;
    try {
      stat = fs.statSync(path);
      if (!stat.isDirectory()) {
        throw new Error();
      }
      fs.accessSync(path, fs.constants.W_OK + fs.constants.X_OK);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
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