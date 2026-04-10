/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const request = require('superagent');
const _ = require('lodash');
const cuid = require('cuid');
const timestamp = require('unix-timestamp');
const { pubsub } = require('messages');

class Webhook {
  id;

  accessId;

  url;

  state;

  runs;

  lastRun;

  runsSize;

  runCount;

  failCount;

  currentRetries;

  maxRetries;

  minIntervalMs;

  created;

  createdBy;

  modified;

  modifiedBy;

  messageBuffer;

  timeout;

  isSending;

  user;

  repository;

  apiVersion;

  serial;

  logger;

  pubsubTurnOffListener;
  constructor (params) {
    this.id = params.id || cuid();
    this.accessId = params.accessId;
    this.url = params.url;
    this.runCount = params.runCount || 0;
    this.failCount = params.failCount || 0;
    this.runs = params.runs || [];
    this.lastRun = params.lastRun || { status: 0, timestamp: 0 };
    this.state = params.state || 'active';
    this.currentRetries = params.currentRetries || 0;
    this.maxRetries = params.maxRetries || 5;
    this.minIntervalMs = params.minIntervalMs || 5000;
    this.created = params.created;
    this.createdBy = params.createdBy;
    this.modified = params.modified;
    this.modifiedBy = params.modifiedBy;
    this.user = params.user;
    this.repository = params.webhooksRepository;
    this.messageBuffer = params.messageBuffer || new Set();
    this.timeout = null;
    this.isSending = false;
    this.runsSize = params.runsSize || 50;
  }

  /**
   * @param {string} username
   * @returns {void}
   */
  startListenting (username) {
    if (this.pubsubTurnOffListener != null) {
      throw new Error('Cannot listen twice');
    }
    this.pubsubTurnOffListener = pubsub.notifications.onAndGetRemovable(username, function named (payload) {
      this.send(payload.eventName);
    }.bind(this));
  }

  /**
   * Send the message with the throttling and retry mechanics - to use in webhooks service
   * @param {string} message
   * @param {boolean} isRescheduled
   * @returns {Promise<void>}
   */
  async send (message, isRescheduled) {
    if (this.state === 'inactive') { return; }
    if (isRescheduled != null && isRescheduled === true) {
      this.timeout = null;
    }
    this.messageBuffer.add(message);
    if (tooSoon.call(this) || this.isSending) { return reschedule.call(this, message); }
    this.isSending = true;
    let status;
    const sentBuffer = Array.from(this.messageBuffer);
    this.messageBuffer.clear();
    try {
      const res = await this.makeCall(sentBuffer);
      status = res.status;
    } catch (e) {
      if (e.response != null) {
        status = e.response.status;
      } else {
        status = 0;
      }
    }
    log(this, 'Webhook ' + this.id + ' run with status ' + status);
    this.isSending = false;
    if (hasError(status)) {
      this.failCount++;
      this.currentRetries++;
      sentBuffer.forEach((m) => {
        this.messageBuffer.add(m);
      });
      if (this.currentRetries > this.maxRetries) {
        this.state = 'inactive';
      }
    } else {
      this.currentRetries = 0;
    }
    this.runCount++;
    this.lastRun = { status, timestamp: timestamp.now() };
    this.addRun(this.lastRun);
    await makeUpdate(['lastRun', 'runs', 'runCount', 'failCount', 'currentRetries', 'state'], this);
    if (hasError(status)) {
      handleRetry.call(this, message);
    }
    function hasError (status) {
      return status < 200 || status >= 300;
    }
    function handleRetry (message) {
      if (this.state === 'inactive') {
        return;
      }
      reschedule.call(this, message);
    }
    function reschedule (message) {
      if (this.timeout != null) { return; }
      const delay = this.minIntervalMs * (this.currentRetries || 1);
      this.timeout = setTimeout(() => {
        return this.send(message, true);
      }, delay);
    }
    function tooSoon () {
      const now = timestamp.now();
      if ((now - this.lastRun.timestamp) * 1000 < this.minIntervalMs) {
        return true;
      } else {
        return false;
      }
    }
  }

  /**
   * Only make the HTTP call - used for webhook.test API method
   * @param {Array<string>} messages
   * @returns {Promise<any>}
   */
  async makeCall (messages) {
    const res = await request.post(this.url).send({
      messages,
      meta: {
        apiVersion: this.apiVersion,
        serverTime: timestamp.now(),
        serial: this.serial
      }
    });
    return res;
  }

  /**
   * @returns {void}
   */
  stop () {
    if (this.timeout != null) {
      clearTimeout(this.timeout);
    }
    if (this.pubsubTurnOffListener != null) {
      this.pubsubTurnOffListener();
      this.pubsubTurnOffListener = null;
    }
  }

  /**
   * @param {Run} run
   * @returns {void}
   */
  addRun (run) {
    if (this.runCount > this.runsSize) {
      this.runs.splice(-1, 1);
    }
    this.runs.unshift(run);
  }

  /**
   * @returns {Promise<void>}
   */
  async save () {
    if (this.repository == null) {
      throw new Error('repository not set for Webhook object.');
    }
    await this.repository.insertOne(this.user, this);
  }

  /**
   * @param {{}} fieldsToUpdate
   * @returns {Promise<void>}
   */
  async update (fieldsToUpdate) {
    const fields = Object.keys(fieldsToUpdate);
    _.merge(this, fieldsToUpdate);
    await makeUpdate(fields, this);
  }

  /**
   * @returns {Promise<void>}
   */
  async delete () {
    if (this.repository == null) {
      throw new Error('repository not set for Webhook object.');
    }
    await this.repository.deleteOne(this.user, this.id);
  }

  /**
   * @returns {string[]}
   */
  getMessageBuffer () {
    return Array.from(this.messageBuffer);
  }

  /**
   * @returns {{}}
   */
  forStorage () {
    return _.pick(this, [
      'id',
      'accessId',
      'url',
      'state',
      'runCount',
      'failCount',
      'lastRun',
      'runs',
      'currentRetries',
      'maxRetries',
      'minIntervalMs',
      'created',
      'createdBy',
      'modified',
      'modifiedBy'
    ]);
  }

  /**
   * @returns {{}}
   */
  forApi () {
    return _.pick(this, [
      'id',
      'accessId',
      'url',
      'state',
      'runCount',
      'failCount',
      'lastRun',
      'runs',
      'currentRetries',
      'maxRetries',
      'minIntervalMs',
      'created',
      'createdBy',
      'modified',
      'modifiedBy'
    ]);
  }

  /**
   * @param {string} version
   * @returns {void}
   */
  setApiVersion (version) {
    this.apiVersion = version;
  }

  /**
   * @param {string} serial
   * @returns {void}
   */
  setSerial (serial) {
    this.serial = serial;
  }

  /**
   * @returns {void}
   */
  setLogger (logger) {
    this.logger = logger;
  }
}
module.exports = Webhook;
/**
 * @param {Webhook} webhook
 * @param {string} msg
 * @returns {void}
 */
function log (webhook, msg) {
  if (webhook.logger == null) { return; }
  webhook.logger.info(msg);
}
/**
 * @param {Array<string> | undefined | null} fields
 * @param {Webhook} webhook
 * @returns {Promise<void>}
 */
async function makeUpdate (fields, webhook) {
  if (webhook.repository == null) {
    throw new Error('repository not set for Webhook object.');
  }
  let update;
  if (fields == null) {
    update = webhook.forStorage();
  } else {
    update = _.pick(webhook.forStorage(), fields);
  }
  await webhook.repository.updateOne(webhook.user, update, webhook.id);
}

/**
 * @typedef {{
 *   status: number;
 *   timestamp: number;
 * }} Run
 */

/** @typedef {'active' | 'inactive'} WebhookState */

/**
 * @typedef {{
 *   state: WebhookState;
 *   currentRetries: number;
 * }} WebhookUpdate
 */
