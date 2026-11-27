/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { LossKind, LossReason } from './lossCounter.ts';
const require = createRequire(import.meta.url);

const { getSyslog } = require('./syslog/index.ts');
const { getConfig, getLogger } = require('@pryv/boiler');
const logger = getLogger('audit');
const CONSTANTS = require('./Constants.ts').default;
const validation = require('./validation.ts');
const { WITHOUT_USER_METHODS_MAP } = require('./ApiMethods.ts');
const AuditFilter = require('./AuditFilter.ts').default;
const { AuditAccessIds } = require('./MethodContextUtils.ts');
const lossCounter = require('./lossCounter.ts');
const { isErasedAccountRefusal } = require('./erasedAccountRefusal.ts') as typeof import('./erasedAccountRefusal.ts');
const { userLocalDirectory } = require('storage');
const util = require('util');
const { createId: cuid } = require('@paralleldrive/cuid2');
const timestamp = require('unix-timestamp');

/**
 * EventEmitter interface is just for tests syncing for now
 */
type Tracing = { startSpan (n: string): void; finishSpan (n: string): void; logForSpan (n: string, ctx: Record<string, unknown>): void };
type AccessRef = { id: string; serial?: string | null; clientData?: { delegation?: { kind?: string; delegate?: { username?: string; hostSlug?: string } } } | null };
type MethodContext = {
  methodId: string;
  user?: { id?: string };
  access: AccessRef;
  failedAccessId?: string | null;
  tracing: Tracing;
  source?: unknown;
  originalQuery?: unknown;
  auditIntegrityPayload?: unknown;
  callerId?: string;
  auditRecordCount?: number;
  auditRecordCountIncomplete?: boolean;
  auditScopedStreamIds?: string[];
  auditScopedStreamCount?: number;
  auditErrorRecorded?: boolean;
};
type AuditEventLike = {
  id?: string;
  createdBy?: string;
  modifiedBy?: string;
  streamIds?: string[];
  time?: number;
  endTime?: number;
  created?: number;
  modified?: number;
  trashed?: boolean;
  type?: string;
  content: { record?: unknown; source?: unknown; action?: string; query?: unknown; id?: string; message?: string; callerId?: string; recordCount?: number; recordCountIncomplete?: boolean; scopedStreamIds?: string[]; scopedStreamCount?: number; delegation?: { delegateUsername?: string; delegateHostSlug?: string } };
};
type Destinations = { syslog?: boolean; storage?: boolean; platformTrail?: boolean };
type AuditFilterLike = { isAudited (methodId: string): Destinations | boolean };
type SyslogLike = { eventForUser (userId: string | undefined, event: AuditEventLike): unknown };
type AuditStorage = {
  forUser (userId: string): Promise<{ createEvent (e: AuditEventLike): Promise<unknown> }>;
  refuseUnindexedUsers? (on: boolean): boolean;
  acceptsPlatformTrail? (): boolean;
};
const PLATFORM_TRAIL_USER_ID: string = CONSTANTS.PLATFORM_TRAIL_USER_ID;

/** Tracing must not replace the error of the write it traces. */
function endSpan (tracing: Tracing, name: string): void {
  try { tracing.finishSpan(name); } catch { /* the audit outcome stands */ }
}

/**
 * Runs the part of an API call record that comes before `eventForUser`: a
 * throw there loses the record, and is counted here because the write that
 * would count it is never reached.
 */
function buildCounted<T> (kind: LossKind, tracing: Tracing, spanName: string, build: () => T): T {
  try {
    return build();
  } catch (err) {
    lossCounter.record(kind, 'invalid-record');
    endSpan(tracing, spanName);
    throw err;
  }
}

/** Whether `write` settles within `ms` (it rejecting in time rejects this). */
async function settlesWithin (write: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => { timer = setTimeout(resolve, ms, false); });
  try {
    return await Promise.race([write.then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A record that cannot be written is counted HERE (`lossCounter`), once per
 * record, and the error re-thrown: callers log it and never count.
 */
class Audit {
  _storage: AuditStorage | undefined;

  _syslog: SyslogLike | undefined;

  filter!: AuditFilterLike;

  tracer: unknown;

  #storageAbsenceLogged = false;

  /** `audit.onUserDelete: keep`: the trail of an erased account stays open. */
  #keepsErasedTrails = false;
  /** The storage cannot tell an erased account itself (see `init`). */
  #checksErasedMark = false;
  /** The storage keeps the platform trail (records of calls without an account). */
  #keepsPlatformTrail = false;

  /**
   * Requires to call async init() to use
   */
  constructor () {
    logger.debug('Start');
  }

  get storage () {
    return this._storage;
  }

  get syslog () {
    return this._syslog;
  }

  async init () {
    logger.debug('Audit initiating...');
    const config = await getConfig();
    this._storage = require('storages').auditStorage;
    this.#keepsErasedTrails = config.get('audit:onUserDelete') === 'keep';
    // Read again at each `init`, as the erasure reads it at each erasure.
    const refuses = this._storage?.refuseUnindexedUsers?.(!this.#keepsErasedTrails);
    // Asked to refuse and unable to (PostgreSQL records, users index elsewhere):
    // the mark the erasure sets on every worker is checked here instead.
    this.#checksErasedMark = !this.#keepsErasedTrails && refuses === false;
    if (refuses != null) logger.info('Audit records of accounts that are erased: ' + (refuses ? 'refused' : this.#checksErasedMark ? 'refused once the account is marked erased' : 'accepted'));
    this.#keepsPlatformTrail = this._storage?.acceptsPlatformTrail?.() === true;
    if (this._storage != null && !this.#keepsPlatformTrail) logger.info('Audit records of calls without an account: syslog only (the audit storage does not keep the platform trail)');
    this._syslog = await getSyslog();
    this.filter = new AuditFilter({
      syslogFilter: config.get('audit:syslog:filter'),
      storageFilter: config.get('audit:storage:filter')
    });
    logger.info('Audit started');
  }

  async validApiCall (context: MethodContext, _result: unknown) {
    const methodId = context.methodId;
    const userId = context?.user?.id;
    const event = buildCounted('valid', context.tracing, 'audit.validApiCall', (): AuditEventLike | null => {
      if (!this.filter.isAudited(methodId)) { return null; }
      context.tracing.startSpan('audit.validApiCall');
      // Some audited methods legitimately run without an access — a credential
      // handed over by one-time key authenticates the request without one. Same
      // substitution errorApiCall already makes; without it buildDefaultEvent
      // dereferences null and the SUCCESS path throws while the failure path
      // audits fine.
      if (context.access?.id == null) {
        context.access = { id: AuditAccessIds.INVALID };
      }
      const built: AuditEventLike = buildDefaultEvent(context);
      if (context.auditIntegrityPayload != null) {
        built.content.record = context.auditIntegrityPayload;
      }
      built.type = CONSTANTS.EVENT_TYPE_VALID;
      return built;
    });
    if (event == null) { return; }
    try {
      await this.eventForUser(userId, event, methodId, 'valid');
      context.tracing.logForSpan('audit.validApiCall', {
        userId,
        event,
        methodId
      });
    } finally {
      endSpan(context.tracing, 'audit.validApiCall');
    }
  }

  async errorApiCall (context: MethodContext, error: { id?: string; message?: string }) {
    const methodId = context.methodId;
    const userId = context?.user?.id;
    // Tells a route that records its own outcome that this error is recorded.
    context.auditErrorRecorded = true;
    const event = buildCounted('error', context.tracing, 'audit.errorApiCall', (): AuditEventLike | null => {
      if (!this.filter.isAudited(methodId)) { return null; }
      context.tracing.startSpan('audit.errorApiCall');
      if (context.access?.id == null) {
        // an access loaded then refused by a later check is recorded by its id
        context.access = { id: context.failedAccessId ?? AuditAccessIds.INVALID };
      }
      const built: AuditEventLike = buildDefaultEvent(context);
      built.type = CONSTANTS.EVENT_TYPE_ERROR;
      built.content.id = error.id;
      built.content.message = error.message;
      // A refused administration act keeps who tried it and on what.
      const attribution = adminAttribution(context.auditIntegrityPayload);
      if (attribution != null) built.content.record = attribution;
      return built;
    });
    if (event == null) { return; }
    try {
      await this.eventForUser(userId, event, methodId, 'error');
    } finally {
      endSpan(context.tracing, 'audit.errorApiCall');
    }
  }

  /**
   * `waitMs`: how long the storage write is waited for. Past it the record
   * counts as lost (`storage-write-failed`) and the call throws, as a failed
   * write does; the late answer of the write, whatever it is, is neither
   * counted again nor thrown.
   */
  async eventForUser (userId: string | undefined, event: AuditEventLike, _methodId?: string, kind: LossKind = 'event', waitMs: number | null = null) {
    // What failed, should the write below throw; also the losses that do not.
    let reason: LossReason = 'invalid-record';
    let silentLoss: LossReason | null = null;
    try {
      const { syslog, storage, platformTrail } = this.#checked(userId, event);
      // Where the stored copy goes: the account's own trail, or for a call
      // without an account the platform trail, when the storage keeps it
      // (else syslog only, as before it existed).
      const storedUnder = storage ? userId : (platformTrail && this.#keepsPlatformTrail ? PLATFORM_TRAIL_USER_ID : null);
      if (this.syslog && syslog) {
        try {
          this.syslog.eventForUser(userId, event);
        } catch (err) {
          // The mirror must not cost the record kept in the audit storage.
          silentLoss = 'syslog-failed';
          logger.error('Failed to send an audit record to syslog', err);
        }
      }
      if (storedUnder != null) {
        if (this.storage == null) {
          silentLoss = 'storage-unavailable';
          if (!this.#storageAbsenceLogged) {
            this.#storageAbsenceLogged = true;
            logger.error('No audit storage: audit records are not stored');
          }
        } else {
          reason = 'storage-write-failed';
          const store = storedUnder === PLATFORM_TRAIL_USER_ID
            ? this.#storePlatformTrail(this.storage, event)
            : this.#store(this.storage, storedUnder, event);
          if (waitMs == null) {
            await store;
          } else if (!await settlesWithin(store, waitMs)) {
            store.catch((err: unknown) => logger.warn('An audit record write that had no answer in time failed later', err));
            throw new Error(`Audit record not written: the audit storage did not answer within ${waitMs} ms`);
          }
        }
      }
    } catch (err) {
      lossCounter.record(kind, reason);
      throw err;
    }
    if (silentLoss != null) lossCounter.record(kind, silentLoss);
  }

  /**
   * Writes the record. One refused because its account was erased meanwhile
   * (a call in flight) is not lost: the erasure exists to remove it.
   */
  async #store (storage: AuditStorage, userId: string, event: AuditEventLike): Promise<void> {
    try {
      if (this.#checksErasedMark && await userLocalDirectory.isErasedAndGone(userId)) throw new userLocalDirectory.ErasedUserError(userId);
      const userStorage = await storage.forUser(userId);
      await userStorage.createEvent(event);
    } catch (err) {
      if (this.#keepsErasedTrails || !isErasedAccountRefusal(err)) throw err;
      logger.warn('Audit record not written: account ' + userId + ' is erased, or not in the users index');
    }
  }

  /**
   * Writes a record of the platform trail. Not an account: no erased mark to
   * check, and a refusal is a lost record like any failed write (the storage
   * exempts this exact id from the refusal of unindexed ids).
   */
  async #storePlatformTrail (storage: AuditStorage, event: AuditEventLike): Promise<void> {
    const trail = await storage.forUser(PLATFORM_TRAIL_USER_ID);
    await trail.createEvent(event);
  }

  /** Validates the record, gives it an id, and tells where it has to go. */
  #checked (userId: string | undefined, event: AuditEventLike): Destinations {
    logger.debug('eventForUser: ' +
            userId +
            ' ' +
            util.inspect(event, { breakLength: Infinity, colors: true }));
    const methodId = event.content.action!;
    // Validate the event shape. WITHOUT_USER methods carry no userId, so they
    // use the user-agnostic check; the rest require a userId. Both return `true`
    // on success or a diagnostic string on failure — anything other than `true`
    // is invalid (a returned string is truthy, which is why the historical
    // `if (!isValid)` never fired).
    let isValid: string | boolean = false;
    if (WITHOUT_USER_METHODS_MAP[methodId]) {
      isValid = validation.eventWithoutUser(event);
    } else {
      isValid = validation.eventForUser(userId, event);
    }
    if (isValid !== true) {
      throw new Error('Invalid audit event (' + methodId + '): ' + isValid, {
        cause: { userId, event }
      });
    }
    // An audit record has to be identifiable: without an id it cannot be read
    // back by `getOneEvent`, updated, or chained into a history. The audited
    // API path already assigns one in buildDefaultEvent; a caller handing us an
    // event directly may not, and the engines then disagree — PostgreSQL
    // rejects the write with a NOT NULL violation while SQLite quietly stores a
    // null-id row, which is the worse of the two. Assign it here, above both.
    if (event.id == null) event.id = cuid();

    return this.filter.isAudited(methodId) as Destinations;
  }

  async reloadConfig () {
    await this.init();
  }

  close () {
    // auditStorage lifecycle is managed by the barrel (storages.reset())
  }
}
export default Audit;
export { Audit };
/** A call made in-process has no address: the key is left out (the published event type has it a string). */
function recordedSource (source: unknown): unknown {
  if (source == null || typeof source !== 'object' || (source as { ip?: unknown }).ip !== null) return source;
  const { ip: _ip, ...rest } = source as { ip: null };
  return rest;
}

/**
 * Of the record an administration route prepared (`{ subject, target?, ... }`,
 * api-server methods/helpers/adminAudit.ts), what an error record keeps: who
 * acted and on what. Null for any other payload.
 */
function adminAttribution (payload: unknown): { subject: unknown; target?: unknown } | null {
  if (payload == null || typeof payload !== 'object' || !('subject' in payload)) return null;
  const { subject, target } = payload as { subject: unknown; target?: unknown };
  return target === undefined ? { subject } : { subject, target };
}

function buildDefaultEvent (context: MethodContext): AuditEventLike {
  const time = timestamp.now();
  // When the caller's access has been versioned (serial non-null),
  // emit BOTH `access-<base>` and `access-<base>:<serial>` streamIds.
  // Old queries by bare access reference keep matching every historical
  // record; new queries can be version-specific. Costs ~30 bytes per
  // audit row on versioned-access activity, no schema change.
  const accessBaseId = context.access.id;
  const accessSerial = context.access != null && context.access.serial != null
    ? context.access.serial
    : null;
  const streamIds: string[] = [
    CONSTANTS.ACCESS_STREAM_ID_PREFIX + accessBaseId
  ];
  if (accessSerial != null) {
    streamIds.push(CONSTANTS.ACCESS_STREAM_ID_PREFIX + accessBaseId + ':' + accessSerial);
  }
  streamIds.push(CONSTANTS.ACTION_STREAM_ID_PREFIX + context.methodId);

  const event: AuditEventLike = {
    id: cuid(),
    createdBy: 'system',
    modifiedBy: 'system',
    streamIds,
    time,
    endTime: time,
    created: time,
    modified: time,
    trashed: false,
    content: {
      source: recordedSource(context.source),
      action: context.methodId,
      query: context.originalQuery
    }
  };
  if (context.callerId != null) {
    event.content.callerId = context.callerId;
  }
  // Delegation attribution — when the acting access is a delegate PAT, the
  // control access itself, or an access a delegate granted (delegated-child), stamp the delegate identity onto the audit event.
  // Per-delegate attribution is already automatic (each delegate has its own
  // access, so records land under `access-<its-id>`); this makes the acting
  // delegate legible on the record itself. Additive.
  const delMarker = context.access != null ? context.access.clientData?.delegation : undefined;
  if (delMarker != null && (delMarker.kind === 'delegate-pat' || delMarker.kind === 'control' || delMarker.kind === 'delegated-child')) {
    event.content.delegation = {
      delegateUsername: delMarker.delegate?.username,
      delegateHostSlug: delMarker.delegate?.hostSlug
    };
  }
  // Breach-scope read enrichment (present only on read methods that landed it).
  if (context.auditRecordCount != null) {
    event.content.recordCount = context.auditRecordCount;
    if (context.auditRecordCountIncomplete === true) {
      event.content.recordCountIncomplete = true;
    }
  }
  if (context.auditScopedStreamIds != null) {
    event.content.scopedStreamIds = context.auditScopedStreamIds;
    if (context.auditScopedStreamCount != null) {
      event.content.scopedStreamCount = context.auditScopedStreamCount;
    }
  }
  return event;
}
