/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { deepMerge } = require('utils');

function pick (obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}
const { createId: cuid } = require('@paralleldrive/cuid2');
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

  startListenting (username) {
    if (this.pubsubTurnOffListener != null) {
      throw new Error('Cannot listen twice');
    }
    this.pubsubTurnOffListener = pubsub.notifications.onAndGetRemovable(username, (payload) => {
      this.send(payload.eventName);
    });
  }

  /**
   * Send the message with the throttling and retry mechanics - to use in webhooks service
   */
  async send (message, isRescheduled?) {
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
    } catch (e: any) {
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
    function handleRetry (this: any, message) {
      if (this.state === 'inactive') {
        return;
      }
      reschedule.call(this, message);
    }
    function reschedule (this: any, message) {
      if (this.timeout != null) { return; }
      const delay = this.minIntervalMs * (this.currentRetries || 1);
      this.timeout = setTimeout(() => {
        return this.send(message, true);
      }, delay);
    }
    function tooSoon (this: any) {
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
   */
  async makeCall (messages) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        meta: {
          apiVersion: this.apiVersion,
          serverTime: timestamp.now(),
          serial: this.serial
        }
      })
    });
    if (!res.ok) {
      const err: any = new Error(`HTTP ${res.status}`);
      err.response = { status: res.status };
      throw err;
    }
    return { status: res.status };
  }

  stop () {
    if (this.timeout != null) {
      clearTimeout(this.timeout);
    }
    if (this.pubsubTurnOffListener != null) {
      this.pubsubTurnOffListener();
      this.pubsubTurnOffListener = null;
    }
  }

  addRun (run) {
    if (this.runCount > this.runsSize) {
      this.runs.splice(-1, 1);
    }
    this.runs.unshift(run);
  }

  async save () {
    if (this.repository == null) {
      throw new Error('repository not set for Webhook object.');
    }
    await this.repository.insertOne(this.user, this);
  }

  async update (fieldsToUpdate) {
    const fields = Object.keys(fieldsToUpdate);
    deepMerge(this, fieldsToUpdate);
    await makeUpdate(fields, this);
  }

  async delete () {
    if (this.repository == null) {
      throw new Error('repository not set for Webhook object.');
    }
    await this.repository.deleteOne(this.user, this.id);
  }

  getMessageBuffer () {
    return Array.from(this.messageBuffer);
  }

  forStorage () {
    return pick(this, [
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

  forApi () {
    return pick(this, [
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

  setApiVersion (version) {
    this.apiVersion = version;
  }

  setSerial (serial) {
    this.serial = serial;
  }

  setLogger (logger) {
    this.logger = logger;
  }
}
export default Webhook;
export { Webhook };
function log (webhook, msg) {
  if (webhook.logger == null) { return; }
  webhook.logger.info(msg);
}
async function makeUpdate (fields, webhook) {
  if (webhook.repository == null) {
    throw new Error('repository not set for Webhook object.');
  }
  let update;
  if (fields == null) {
    update = webhook.forStorage();
  } else {
    update = pick(webhook.forStorage(), fields);
  }
  await webhook.repository.updateOne(webhook.user, update, webhook.id);
}

type Run = {
  status: number;
  timestamp: number;
};
type WebhookState = 'active' | 'inactive';
type WebhookUpdate = {
  state: WebhookState;
  currentRetries: number;
};
