/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
const { getStorage, closeStorage } = require('storage/src/userSQLite');
const { getSyslog } = require('./syslog');
const { getConfig, getLogger } = require('@pryv/boiler');
const logger = getLogger('audit');
const CONSTANTS = require('./Constants');
const validation = require('./validation');
const { WITHOUT_USER_METHODS_MAP } = require('./ApiMethods');
const AuditFilter = require('./AuditFilter');
const { AuditAccessIds } = require('./MethodContextUtils');
const util = require('util');
const cuid = require('cuid');
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
    this._storage = await getStorage('audit');
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
    const event = buildDefaultEvent(context);
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
    const event = buildDefaultEvent(context);
    event.type = CONSTANTS.EVENT_TYPE_ERROR;
    event.content.id = error.id;
    event.content.message = error.message;
    await this.eventForUser(userId, event, methodId);
    context.tracing.finishSpan('audit.errorApiCall');
  }

  /**
   * @returns {Promise<void>}
   */
  async eventForUser (userId, event) {
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
      });
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
    closeStorage();
  }
}
module.exports = Audit;
/**
 * @returns {{ id: any; createdBy: string; modifiedBy: string; streamIds: any[]; time: number; endTime: number; created: number; modified: number; trashed: boolean; content: { source: any; action: any; query: any; }; }}
 */
function buildDefaultEvent (context) {
  const time = timestamp.now();
  const event = {
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
/**
 * @returns {void}
 */
// function log (context, userId, validity, id) {
//  const methodId = context.methodId;
//  if (context.access?.id == null || methodId == null || userId == null) {
//    console.log('XXX E> ApiCall', methodId, ' UserId', userId, ' accesId:', context.access?.id, 'Audited?', AUDITED_METHODS_MAP[methodId], 'XX' + validity, id);
// const e = new Error();
// const stack = e.stack.split('\n').filter(l => l.indexOf('node_modules') <0 );
// console.log(stack);
// console.log('XXXX> Access:', context.access);
//  }
// }
