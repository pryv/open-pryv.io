/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
const require = createRequire(import.meta.url);
const { deepMerge } = require('utils');

function pick<T extends object> (obj: T, keys: string[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (k in obj) (out as Record<string, unknown>)[k] = (obj as Record<string, unknown>)[k];
  return out;
}
const { createId: cuid } = require('@paralleldrive/cuid2');
const timestamp = require('unix-timestamp');
const { pubsub } = require('messages');
const cache = require('cache').default;

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

  timeout: ReturnType<typeof setTimeout> | null;

  isSending;

  user: User;

  repository: WebhooksRepository | null;

  apiVersion!: string | null;

  serial!: string | null;

  logger!: Logger | null;

  pubsubTurnOffListener!: (() => void) | null;
  constructor (params: WebhookCtorParams) {
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

  startListenting (username: string) {
    if (this.pubsubTurnOffListener != null) {
      throw new Error('Cannot listen twice');
    }
    this.pubsubTurnOffListener = pubsub.notifications.onAndGetRemovable(username, (payload: { eventName: string; [k: string]: unknown }) => {
      this.send(payload.eventName);
    });
  }

  /**
   * Send the message with the throttling and retry mechanics - to use in webhooks service
   */
  async send (message: WebhookMessage, isRescheduled?: boolean) {
    if (this.state === 'inactive') { return; }
    // Fire-time access-validity check: self-heal orphan webhooks whose
    // access was revoked, including those created before the cascade
    // delete logic shipped.
    if (this.repository != null && typeof this.repository.accessExists === 'function') {
      const cacheHit = cache.getAccessLogicForId(this.user.id, this.accessId);
      if (cacheHit == null) {
        const stillValid = await this.repository.accessExists(this.user, this.accessId);
        if (!stillValid) {
          this.state = 'inactive';
          await makeUpdate(['state'], this);
          return;
        }
      }
    }
    if (isRescheduled != null && isRescheduled === true) {
      this.timeout = null;
    }
    this.messageBuffer.add(message);
    if (tooSoon.call(this) || this.isSending) { return reschedule.call(this, message); }
    this.isSending = true;
    let status: number = 0;
    const sentBuffer = Array.from(this.messageBuffer);
    this.messageBuffer.clear();
    try {
      const res = await this.makeCall(sentBuffer);
      status = res.status;
    } catch (e: unknown) {
      const err = e as { response?: { status?: number } };
      if (err.response != null) {
        status = err.response.status ?? 0;
      } else {
        status = 0;
      }
    }
    log(this, 'Webhook ' + this.id + ' run with status ' + status);
    this.isSending = false;
    if (hasError(status)) {
      this.failCount++;
      this.currentRetries++;
      sentBuffer.forEach((m: WebhookMessage) => {
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
    function hasError (status: number) {
      return status < 200 || status >= 300;
    }
    function handleRetry (this: Webhook, message: WebhookMessage) {
      if (this.state === 'inactive') {
        return;
      }
      reschedule.call(this, message);
    }
    function reschedule (this: Webhook, message: WebhookMessage) {
      if (this.timeout != null) { return; }
      const delay = this.minIntervalMs * (this.currentRetries || 1);
      this.timeout = setTimeout(() => {
        return this.send(message, true);
      }, delay);
    }
    function tooSoon (this: Webhook) {
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
  async makeCall (messages: WebhookMessage[]) {
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
      const err: Error & { response?: { status: number } } = new Error(`HTTP ${res.status}`);
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

  addRun (run: Run) {
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

  async update (fieldsToUpdate: Partial<Webhook>) {
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

  setApiVersion (version: string) {
    this.apiVersion = version;
  }

  setSerial (serial: string) {
    this.serial = serial;
  }

  setLogger (logger: Logger) {
    this.logger = logger;
  }
}
export default Webhook;
export { Webhook };
function log (webhook: Webhook, msg: string) {
  if (webhook.logger == null) { return; }
  webhook.logger.info(msg);
}
async function makeUpdate (fields: string[] | null, webhook: Webhook) {
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
type User = { id: string; username: string };
type WebhookMessage = string;
type WebhooksRepository = {
  accessExists?: (user: User, accessId: string) => Promise<boolean>;
  insertOne (user: User, webhook: Webhook): Promise<unknown>;
  updateOne (user: User, update: Partial<Webhook>, id: string): Promise<unknown>;
  deleteOne (user: User, id: string): Promise<unknown>;
};
type WebhookCtorParams = {
  id?: string;
  accessId: string;
  url: string;
  state?: WebhookState;
  runs?: Run[];
  lastRun?: Run;
  runsSize?: number;
  runCount?: number;
  failCount?: number;
  currentRetries?: number;
  maxRetries?: number;
  minIntervalMs?: number;
  created?: number;
  createdBy?: string;
  modified?: number;
  modifiedBy?: string;
  user: User;
  webhooksRepository: WebhooksRepository | null;
  messageBuffer?: Set<WebhookMessage>;
};
