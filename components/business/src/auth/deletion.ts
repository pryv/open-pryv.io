/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { ConfigLike as Config, Logger } from '@pryv/boiler';
import type { DeletionObjection } from './deletionTeardown.ts';
import type { AccountErasureRow } from 'storages/interfaces/baseStorage/ErasuresLocalDB.ts';
const require = createRequire(import.meta.url);
const { fromCallback } = require('utils');
const fs = require('fs');
const path = require('path');
const { getUsersRepository } = require('business/src/users/index.ts');
const { accountSeriesNamespaces, seriesNamespace } = require('business/src/series/namespace.ts');
const { runDeletionTeardownSteps, runDeletionGuards } = require('business/src/auth/deletionTeardown.ts');
const { storedWebhookIds, signalWebhooksStopped } = require('business/src/webhooks/accountSignals.ts') as typeof import('../webhooks/accountSignals.ts');
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
  // Set by deleteHFData, read again by dropHFDataAgain (the alias index that
  // lists them is gone by then).
  seriesNamespaces?: string[];
  deletionByAdmin?: boolean;
  // What decided an erasure run outside auth.delete (eraseAccount).
  erasureTrigger?: string;
  // The record of the erasure in progress (openErasureRecord).
  erasure?: AccountErasureRow;
  // Names of the account that another account holds since an earlier attempt
  // freed them (a resumed erasure): their series and rows are not this one's.
  foreignNames?: Set<string>;
  erasureHeartbeat?: ReturnType<typeof setInterval>;
};
type StepFn = (context: MethodContext, params: unknown, result: ResultBag, next: Next) => unknown;
type StepName = 'runTeardownSteps' | 'deleteUserFiles' | 'deleteHFData' | 'deleteAttachments' | 'deleteAuditDataStorage' | 'deleteUser' | 'deleteAuditData' | 'dropHFDataAgain';

// The series namespaces of `namespaces` whose name is not held by another
// account (see MethodContext.foreignNames).
function ownNamespaces (context: MethodContext, namespaces: string[]): string[] {
  const foreign = context.foreignNames;
  if (foreign == null || foreign.size === 0) return namespaces;
  return namespaces.filter((ns) => !foreign.has(ns.startsWith(NAMESPACE_PREFIX) ? ns.slice(NAMESPACE_PREFIX.length) : ns));
}
const NAMESPACE_PREFIX = seriesNamespace('');

// Loaded on first use, like the other storages handles here.
function erasuresStore (): ReturnType<typeof import('./erasures.ts').getErasuresLocal> {
  return (require('./erasures.ts') as typeof import('./erasures.ts')).getErasuresLocal();
}

function errorText (err: unknown): string {
  const inner = (err as { innerError?: unknown } | null)?.innerError;
  const e = inner instanceof Error ? inner : err;
  return e instanceof Error ? e.message : String(e);
}

/** The refusal of per-user file storage to reopen an erased account's files, possibly wrapped. */
function isErasedUserError (err: unknown): boolean {
  for (let e = err, depth = 0; e != null && depth < 5; depth++) {
    const x = e as { name?: unknown; message?: unknown; innerError?: unknown; cause?: unknown };
    if (x.name === 'ErasedUserError' || (typeof x.message === 'string' && x.message.startsWith('user directory erased'))) return true;
    e = x.innerError ?? x.cause;
  }
  return false;
}
type ResultBag = Record<string, unknown>;
type Next = (err?: unknown) => void;
type StorageLayer = {
  accesses: { removeAll (user: { id: string }, cb: (err: Error | null) => void): void };
  profile: { removeAll (user: { id: string }, cb: (err: Error | null) => void): void };
  webhooks: {
    removeAll (user: { id: string }, cb: (err: Error | null) => void): void;
    find? (user: { id: string }, query: Record<string, unknown>, options: Record<string, unknown>, cb: (err: unknown, items?: Array<{ id: string }>) => void): void;
  };
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
        context.deletionByAdmin = true;
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
    // The user's paths (the directory deleteUserFiles removes), built once.
    const dirPaths = [
      path.join(this.config.get('storages:engines:filesystem:previewsDirPath') as string, context.user.id)
    ];
    // NOTE Since user specific paths are created lazily, we should not expect
    //  them to be there. But _if_ they are, they need be accessible.
    // Let's check if we can change into and write into the user's paths:
    const inaccessibleDirectory = findNotAccessibleDir(dirPaths);
    if (inaccessibleDirectory) {
      const error = new Error(`Directory '${inaccessibleDirectory}' is inaccessible or missing.`);
      this.logger.error(error, error);
      return next(errors.unexpectedError(error));
    }
    next();
  }

  // Objections of the plugins (an account that would be left without any way
  // in): the owner's deletion is refused; an admin-key deletion goes through,
  // logged, so the operator can act.
  async checkDeletionGuards (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    const objections: DeletionObjection[] = await runDeletionGuards({ id: context.user.id, username: context.user.username }, this.logger);
    if (objections.length === 0) return next();
    if (context.deletionByAdmin === true) {
      for (const o of objections) this.logger.warn('account deletion by the admin key despite: ' + o.message, { userId: context.user.id, ...o.data });
      return next();
    }
    const [first] = objections;
    return next(errors.invalidOperation(first.message, Object.assign({}, ...objections.map((o) => o.data))));
  }

  // Relationships that live on other accounts (delegations, consent grants):
  // the plugins owning them tear them down while this account's records still
  // name the counterparties. Best-effort, never fails the deletion.
  async runTeardownSteps (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    await runDeletionTeardownSteps({ id: context.user.id, username: context.user.username }, this.logger);
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
      const namespaces = ownNamespaces(context, await accountSeriesNamespaces(usersRepository.usersIndex, context.user.id, context.user.username));
      context.seriesNamespaces = namespaces;
      for (const namespace of namespaces) {
        await conn.dropDatabase(namespace);
      }
    }
    next();
  }

  // The high-frequency workers cache series credentials for a while and take
  // no deletion signal: a point written between deleteHFData and the removal
  // of the account recreates its namespace. Drops the same namespaces again,
  // as the last step, once the account no longer resolves.
  async dropHFDataAgain (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    const conn = require('storages').seriesConnection;
    if (conn != null && context.seriesNamespaces != null) {
      for (const namespace of ownNamespaces(context, context.seriesNamespaces)) {
        try {
          await conn.dropDatabase(namespace);
        } catch (err: unknown) {
          // The account is already gone: report, do not fail the deletion.
          this.logger.error('Dropping the series of a deleted account again failed for ' + namespace, err);
        }
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
      // Let go of this process's account-file handle before the file goes.
      require('storages').userAccountStorage?.closeUser?.(context.user.id);
      await userLocalDirectory.deleteUserDirectory(context.user.id, keep, { erased: true });
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
  //   pseudonymise    — not implemented: refused at boot by config-validation.
  //                     If somehow seen here (override during runtime), fall
  //                     back to 'erase' + warn-log.
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
          `audit:onUserDelete=pseudonymise requested for user ${context.user.id} but pseudonymisation of the audit is not implemented — falling back to 'erase'. config-validation should have blocked this at boot.`
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

  /**
   * The erasure steps, in their (load-bearing) order: auth.delete registers
   * them after its checks, eraseAccount runs them for the other paths that
   * remove a whole account. `teardown: false` skips the relationship teardown
   * (an account that never had relationships).
   */
  erasureSteps ({ teardown = true } = {}): Array<(context: MethodContext, params: unknown, result: ResultBag, next: Next) => unknown> {
    const steps: StepName[] = [
      // Before anything is erased: the plugins read this account's records to
      // reach the accounts it has relationships with.
      ...(teardown ? ['runTeardownSteps' as const] : []),
      'deleteUserFiles',
      'deleteHFData',
      'deleteAttachments',
      'deleteAuditDataStorage',
      // deleteUser opens the user's per-user SQLite files to remove its rows:
      // after the directory wipe it would create them again, empty. Wipe last.
      'deleteUser',
      'deleteAuditData',
      // Last: points written while the steps above ran, through a series
      // credential still cached by a high-frequency worker.
      'dropHFDataAgain'
    ];
    return [
      this.openErasureRecord.bind(this),
      ...steps.map((name) => this.#recordedStep(name, (this[name] as StepFn).bind(this))),
      this.closeErasureRecord.bind(this)
    ];
  }

  /**
   * Erase a whole account outside auth.delete, with the same steps. Throws on
   * the first failing step. An erasure of the account left unfinished (its
   * record is still there) is completed instead: the steps it recorded as done
   * are skipped. `trigger` names what decided the erasure (e.g. an
   * auto-deletion's `date` or `inactivity`), kept in its record.
   */
  async eraseAccount (account: { id: string; username: string }, options: { teardown?: boolean; trigger?: string } = {}): Promise<void> {
    const context: MethodContext = { user: { id: account.id, username: account.username } };
    context.erasureTrigger = options.trigger ?? 'system';
    const result: ResultBag = {};
    for (const step of this.erasureSteps(options)) {
      await new Promise<void>((resolve, reject) => {
        step(context, {}, result, (err?: unknown) => err != null ? reject(err) : resolve());
      });
    }
  }

  // The record of this erasure, in the core's storage the erasure does not
  // wipe: written before the first step, kept up to date after each one,
  // removed after the last. An unfinished record of the same account is
  // taken up again (its done steps are skipped).
  // Only one erasure of an account runs at a time: a fresh record is taken
  // with an insert that fails when one exists, an unfinished one with a
  // compare-and-set on its last update, and only once it stopped moving
  // (STALE_ERASURE_MS; a running erasure refreshes it, see #startHeartbeat).
  async openErasureRecord (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    const inProgress = () => errors.invalidOperation('An erasure of this account is already in progress.', { userId: context.user.id });
    try {
      const store = await erasuresStore();
      const { STALE_ERASURE_MS } = require('./erasures.ts') as typeof import('./erasures.ts');
      const now = Date.now();
      const existing = await store.get(context.user.id);
      let record: AccountErasureRow;
      if (existing != null && existing.username === context.user.username) {
        if (now - existing.updatedAt < STALE_ERASURE_MS || !(await store.claim(context.user.id, existing.updatedAt, now))) {
          return next(inProgress());
        }
        record = { ...existing, attempts: existing.attempts + 1, updatedAt: now };
        await store.put(record);
        if (existing.seriesNamespaces != null) context.seriesNamespaces = existing.seriesNamespaces;
        context.foreignNames = await this.#foreignNames(context.user.id, [context.user.username, ...(existing.seriesNamespaces ?? []).map((ns) => ns.startsWith(NAMESPACE_PREFIX) ? ns.slice(NAMESPACE_PREFIX.length) : ns)]);
        this.logger.warn(`completing the erasure of account "${context.user.username}" (${context.user.id}) started at ${new Date(existing.startedAt).toISOString()}, attempt ${record.attempts}; steps done: ${existing.doneSteps.join(', ') || 'none'}` +
          (context.foreignNames.size > 0 ? `; now held by another account, left alone: ${[...context.foreignNames].join(', ')}` : ''));
      } else {
        const trigger = context.erasureTrigger ?? (context.deletionByAdmin === true ? 'admin' : 'holder');
        record = { userId: context.user.id, username: context.user.username, trigger, startedAt: now, updatedAt: now, doneSteps: [], seriesNamespaces: null, attempts: 1, lastError: null };
        if (existing != null) {
          // A record of the same id under another name: not this erasure.
          await store.put(record);
        } else if (!(await store.insertIfAbsent(record))) {
          return next(inProgress());
        }
      }
      context.erasure = record;
      this.#startHeartbeat(context);
    } catch (err: unknown) {
      // Nothing is erased without its record: an erasure that fails half-way
      // must be found again.
      this.logger.error(err, err);
      return next(errors.unexpectedError(err));
    }
    next();
  }

  /** Names among `names` that another account holds now (a resumed erasure freed them earlier). */
  async #foreignNames (userId: string, names: string[]): Promise<Set<string>> {
    const usersRepository = await getUsersRepository();
    const foreign = new Set<string>();
    for (const name of new Set(names)) {
      const holder = await usersRepository.getUserIdForUsername(name);
      if (holder != null && holder !== userId) foreign.add(name);
    }
    return foreign;
  }

  // Keeps the record's `updatedAt` fresh while the erasure runs, a long step
  // included, so no one takes it over meanwhile.
  #startHeartbeat (context: MethodContext): void {
    const { ERASURE_HEARTBEAT_MS } = require('./erasures.ts') as typeof import('./erasures.ts');
    const timer = setInterval(() => {
      const record = context.erasure;
      if (record == null) return;
      const expected = record.updatedAt;
      const at = Date.now();
      // A compare-and-set, never a write: it cannot bring back a record the
      // erasure removed meanwhile, nor undo a step's own update.
      erasuresStore().then((store) => store.claim(record.userId, expected, at))
        .then((refreshed) => { if (refreshed && record.updatedAt === expected) record.updatedAt = at; })
        .catch((e: unknown) => this.logger.warn('erasure record not refreshed: ' + errorText(e)));
    }, ERASURE_HEARTBEAT_MS);
    timer.unref();
    context.erasureHeartbeat = timer;
  }

  #stopHeartbeat (context: MethodContext): void {
    if (context.erasureHeartbeat != null) clearInterval(context.erasureHeartbeat);
    context.erasureHeartbeat = undefined;
  }

  async closeErasureRecord (context: MethodContext, _params: unknown, _result: ResultBag, next: Next) {
    this.#stopHeartbeat(context);
    try {
      await (await erasuresStore()).delete(context.user.id);
    } catch (err: unknown) {
      // The account is erased; a record left behind only runs the (done)
      // steps again later.
      this.logger.error('the erasure record of a fully erased account could not be removed', err);
    }
    next();
  }

  /** `step`, skipped when the record says it is done, recorded as done once it completed. */
  #recordedStep (name: StepName, step: StepFn): StepFn {
    return (context, params, result, next) => {
      const record = context.erasure;
      if (record != null && record.doneSteps.includes(name)) return next();
      let answered = false;
      const done = (err?: unknown): void => {
        if (answered) return;
        answered = true;
        const resuming = record != null && record.attempts > 1;
        // Per-user files of an account whose directory is already gone refuse
        // to open again (by design): on a resumed erasure that means done.
        if (err != null && !(resuming && isErasedUserError(err))) {
          this.#stopHeartbeat(context);
          if (record == null) return next(err);
          record.lastError = `${name}: ${errorText(err)}`;
          record.updatedAt = Date.now();
          erasuresStore().then((store) => store.put(record)).catch((e: unknown) => this.logger.warn('erasure record not updated: ' + errorText(e)))
            .finally(() => next(err));
          return;
        }
        if (record == null) return next();
        record.doneSteps.push(name);
        if (name === 'deleteHFData' && context.seriesNamespaces != null) record.seriesNamespaces = context.seriesNamespaces;
        record.updatedAt = Date.now();
        erasuresStore().then((store) => store.put(record))
          // A step not recorded as done is run again on a resume, on data
          // already gone: every step accepts that.
          .catch((e: unknown) => this.logger.warn('erasure record not updated: ' + errorText(e)))
          .finally(() => next());
      };
      // A step that rejects without answering fails like one that answers an error.
      Promise.resolve(step(context, params, result, done)).catch(done);
    };
  }

  async deleteUser (context: MethodContext, _params: unknown, result: ResultBag, next: Next) {
    let webhookIds: string[] = [];
    try {
      webhookIds = await this.#webhookIds(context.user.id);
      const dbCollections = [
        this.storageLayer.accesses,
        this.storageLayer.profile,
        this.storageLayer.webhooks
      ];
      const removals = dbCollections
        .map((coll) => fromCallback((cb: (err: Error | null) => void) => coll.removeAll(context.user, cb)));
      // Every removal is awaited whatever fails: a rejection left pending
      // would surface as an unhandled rejection, which ends the worker.
      // A name another account took since an earlier attempt freed it is not
      // this account's any more: nothing keyed by it is touched.
      const nameIsOurs = !context.foreignNames?.has(context.user.username);
      const settled = await Promise.allSettled([
        (async () => {
          const usersRepository = await getUsersRepository();
          await usersRepository.deleteOne(context.user.id, nameIsOurs ? context.user.username : null);
        })(),
        ...removals,
        // With the rest: a removal that fails (a resumed erasure meeting files
        // already gone) does not leave the sessions behind.
        ...(nameIsOurs ? [fromCallback((cb: (err: Error | null) => void) => this.storageLayer.sessions.remove({ username: context.user.username }, cb))] : []),
        fromCallback((cb: (err: Error | null) => void) => this.storageLayer.sessions.remove({ userId: context.user.id }, cb))
      ]);
      const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (failed != null) throw failed.reason;
    } catch (error) {
      this.logger.error(error, error);
      return next(errors.unexpectedError(error));
    }
    signalWebhooksStopped(context.user.username, webhookIds);
    result.userDeletion = { username: context.user.username };
    next();
  }

  async #webhookIds (userId: string): Promise<string[]> {
    if (typeof this.storageLayer.webhooks.find !== 'function') return [];
    try {
      return await storedWebhookIds(this.storageLayer.webhooks as Parameters<typeof storedWebhookIds>[0], userId);
    } catch (err: unknown) {
      // The service then stops them when it next restarts.
      this.logger.warn('Could not list the webhooks of the account being deleted', err);
      return [];
    }
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
