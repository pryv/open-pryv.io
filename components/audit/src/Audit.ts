/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { getSyslog } = require('./syslog/index.ts');
const { getConfig, getLogger } = require('@pryv/boiler');
const logger = getLogger('audit');
const CONSTANTS = require('./Constants.ts').default;
const validation = require('./validation.ts');
const { WITHOUT_USER_METHODS_MAP } = require('./ApiMethods.ts');
const AuditFilter = require('./AuditFilter.ts').default;
const { AuditAccessIds } = require('./MethodContextUtils.ts');
const util = require('util');
const { createId: cuid } = require('@paralleldrive/cuid2');
const timestamp = require('unix-timestamp');
/**
 * EventEmitter interface is just for tests syncing for now
 */
type Tracing = { startSpan (n: string): void; finishSpan (n: string): void; logForSpan (n: string, ctx: Record<string, unknown>): void };
type Access = { id: string; serial?: string | null };
type MethodContext = {
  methodId: string;
  user?: { id?: string };
  access: Access;
  tracing: Tracing;
  source?: unknown;
  originalQuery?: unknown;
  auditIntegrityPayload?: unknown;
  callerId?: string;
};
type AuditEvent = {
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
  content: { record?: unknown; source?: unknown; action?: string; query?: unknown; id?: string; message?: string; callerId?: string };
};
type AuditFilterLike = { isAudited (methodId: string): { syslog?: boolean; storage?: boolean } | boolean };
type SyslogLike = { eventForUser (userId: string | undefined, event: AuditEvent): unknown };
type AuditStorage = { forUser (userId: string): Promise<{ createEvent (e: AuditEvent): Promise<unknown> }> };

class Audit {
  _storage: AuditStorage | undefined;

  _syslog: SyslogLike | undefined;

  filter!: AuditFilterLike;

  tracer: unknown;
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
    this._syslog = await getSyslog();
    this.filter = new AuditFilter({
      syslogFilter: config.get('audit:syslog:filter'),
      storageFilter: config.get('audit:storage:filter')
    });
    logger.info('Audit started');
  }

  async validApiCall (context: MethodContext, _result: unknown) {
    const methodId = context.methodId;
    if (!this.filter.isAudited(methodId)) { return; }
    context.tracing.startSpan('audit.validApiCall');
    const userId = context?.user?.id;
    const event: AuditEvent = buildDefaultEvent(context);
    if (context.auditIntegrityPayload != null) {
      event.content.record = context.auditIntegrityPayload;
    }
    event.type = CONSTANTS.EVENT_TYPE_VALID;
    await this.eventForUser(userId, event, methodId);
    context.tracing.logForSpan('audit.validApiCall', {
      userId,
      event,
      methodId
    });
    context.tracing.finishSpan('audit.validApiCall');
  }

  async errorApiCall (context: MethodContext, error: { id?: string; message?: string }) {
    const methodId = context.methodId;
    if (!this.filter.isAudited(methodId)) { return; }
    context.tracing.startSpan('audit.errorApiCall');
    const userId = context?.user?.id;
    if (context.access?.id == null) {
      context.access = { id: AuditAccessIds.INVALID };
    }
    const event: AuditEvent = buildDefaultEvent(context);
    event.type = CONSTANTS.EVENT_TYPE_ERROR;
    event.content.id = error.id;
    event.content.message = error.message;
    await this.eventForUser(userId, event, methodId);
    context.tracing.finishSpan('audit.errorApiCall');
  }

  async eventForUser (userId: string | undefined, event: AuditEvent, _methodId?: string) {
    logger.debug('eventForUser: ' +
            userId +
            ' ' +
            util.inspect(event, { breakLength: Infinity, colors: true }));
    const methodId = event.content.action!;
    // replace this with api-server's validation or remove completely as we are prpoducing it in house.
    let isValid = false;
    if (WITHOUT_USER_METHODS_MAP[methodId]) {
      isValid = validation.eventWithoutUser(userId, event);
    } else {
      isValid = validation.eventForUser(userId, event);
    }
    if (!isValid) {
      throw new Error('Invalid audit eventForUser call : ' + isValid, {
        cause: { userId, event }
      });
    }
    const isAudited = this.filter.isAudited(methodId) as { syslog?: boolean; storage?: boolean };
    if (this.syslog && isAudited.syslog) {
      this.syslog.eventForUser(userId, event);
    }
    if (this.storage && isAudited.storage) {
      const userStorage = await this.storage.forUser(userId!);
      await userStorage.createEvent(event);
    }
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
function buildDefaultEvent (context: MethodContext): AuditEvent {
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

  const event: AuditEvent = {
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
      source: context.source,
      action: context.methodId,
      query: context.originalQuery
    }
  };
  if (context.callerId != null) {
    event.content.callerId = context.callerId;
  }
  return event;
}
