/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const { getSyslog } = require('./syslog');
const { getConfig, getLogger } = require('@pryv/boiler');
const logger = getLogger('audit');
const CONSTANTS = require('./Constants');
const validation = require('./validation');
const { WITHOUT_USER_METHODS_MAP } = require('./ApiMethods');
const AuditFilter = require('./AuditFilter');
const { AuditAccessIds } = require('./MethodContextUtils');
const util = require('util');
const { createId: cuid } = require('@paralleldrive/cuid2');
const timestamp = require('unix-timestamp');
/**
 * EventEmitter interface is just for tests syncing for now
 */
class Audit {
  _storage;

  _syslog;

  filter;

  tracer;
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

  /**
   * @returns {Promise<void>}
   */
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

  /**
   * @returns {Promise<void>}
   */
  async validApiCall (context, result) {
    const methodId = context.methodId;
    if (!this.filter.isAudited(methodId)) { return; }
    context.tracing.startSpan('audit.validApiCall');
    const userId = context?.user?.id;
    const event: any = buildDefaultEvent(context);
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

  /**
   * @returns {Promise<void>}
   */
  async errorApiCall (context, error) {
    const methodId = context.methodId;
    if (!this.filter.isAudited(methodId)) { return; }
    context.tracing.startSpan('audit.errorApiCall');
    const userId = context?.user?.id;
    if (context.access?.id == null) {
      context.access = { id: AuditAccessIds.INVALID };
    }
    const event: any = buildDefaultEvent(context);
    event.type = CONSTANTS.EVENT_TYPE_ERROR;
    event.content.id = error.id;
    event.content.message = error.message;
    await this.eventForUser(userId, event, methodId);
    context.tracing.finishSpan('audit.errorApiCall');
  }

  /**
   * @returns {Promise<void>}
   */
  async eventForUser (userId, event, _methodId?: any) {
    logger.debug('eventForUser: ' +
            userId +
            ' ' +
            util.inspect(event, { breakLength: Infinity, colors: true }));
    const methodId = event.content.action;
    // replace this with api-server's validation or remove completely as we are prpoducing it in house.
    let isValid = false;
    if (WITHOUT_USER_METHODS_MAP[methodId]) {
      isValid = validation.eventWithoutUser(userId, event);
    } else {
      isValid = validation.eventForUser(userId, event);
    }
    if (!isValid) {
      throw new Error('Invalid audit eventForUser call : ' + isValid, {
        userId,
        event
      } as any);
    }
    const isAudited = this.filter.isAudited(methodId);
    if (this.syslog && isAudited.syslog) {
      this.syslog.eventForUser(userId, event);
    }
    if (this.storage && isAudited.storage) {
      const userStorage = await this.storage.forUser(userId);
      await userStorage.createEvent(event);
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async reloadConfig () {
    await this.init();
  }

  /**
   * @returns {void}
   */
  close () {
    // auditStorage lifecycle is managed by the barrel (storages.reset())
  }
}
module.exports = Audit;
/**
 * @returns {{ id: any; createdBy: string; modifiedBy: string; streamIds: any[]; time: number; endTime: number; created: number; modified: number; trashed: boolean; content: { source: any; action: any; query: any; }; }}
 */
function buildDefaultEvent (context) {
  const time = timestamp.now();
  const event: any = {
    id: cuid(),
    createdBy: 'system',
    modifiedBy: 'system',
    streamIds: [
      CONSTANTS.ACCESS_STREAM_ID_PREFIX + context.access.id,
      CONSTANTS.ACTION_STREAM_ID_PREFIX + context.methodId
    ],
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
