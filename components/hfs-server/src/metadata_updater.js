/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
// In-process metadata updater — replaces the former TChannel RPC service.
// Batches series metadata updates and flushes them to the database periodically.

const { getLogger } = require('@pryv/boiler');
const { getUsersRepository } = require('business/src/users');
const { getMall } = require('mall');
const Heap = require('heap');

const STALE_LIMIT = 5 * 60; // max staleness (seconds)
const COOLDOWN_TIME = 10; // wait before flushing (seconds)
const FLUSH_INTERVAL_MS = 500; // flush check frequency

const logger = getLogger('metadata-updater');

// --- PendingUpdate ---

class PendingUpdate {
  static fromUpdateRequest (now, req) {
    return new PendingUpdate(now, req);
  }

  static key (id) {
    return `${id.userId}/${id.eventId}`;
  }

  constructor (now, req) {
    this.request = req;
    this.deadline = now + STALE_LIMIT;
    this.cooldown = now + COOLDOWN_TIME;
    const { from, to } = req.dataExtent;
    if (from > to) throw new Error('Invalid update, from > to.');
  }

  key () {
    const r = this.request;
    return `${r.userId}/${r.eventId}`;
  }

  merge (other) {
    if (this.key() !== other.key()) throw new Error('Key mismatch in merge.');
    const ts = (e) => e.request.timestamp;
    const later = ts(other) > ts(this) ? other : this;
    this.request.author = later.request.author;
    this.request.timestamp = ts(later);
    const ext = this.request.dataExtent;
    const oExt = other.request.dataExtent;
    ext.from = Math.min(ext.from, oExt.from);
    ext.to = Math.max(ext.to, oExt.to);
    this.deadline = Math.min(this.deadline, other.deadline);
    this.cooldown = this.request.timestamp + COOLDOWN_TIME;
  }

  flushAt () {
    return Math.min(this.deadline, this.cooldown);
  }
}

// --- PendingUpdatesMap ---

class PendingUpdatesMap {
  constructor () {
    this.map = new Map();
    this.heap = new Heap((a, b) => a.flushAt() - b.flushAt());
  }

  merge (update) {
    const key = update.key();
    if (this.map.has(key)) {
      this.map.get(key).merge(update);
      this.heap.updateItem(this.map.get(key));
    } else {
      this.map.set(key, update);
      this.heap.push(update);
    }
  }

  getElapsed (now) {
    const elapsed = [];
    while (this.heap.size() > 0) {
      const head = this.heap.peek();
      if (head.flushAt() > now) break;
      const item = this.heap.pop();
      this.map.delete(item.key());
      elapsed.push(item);
    }
    return elapsed;
  }
}

// --- Flush: writes a pending update to the database ---

async function flush (update) {
  const req = update.request;
  const usersRepository = await getUsersRepository();
  const userId = await usersRepository.getUserIdForUsername(req.userId);
  const mall = await getMall();
  const eventData = await mall.events.getOne(userId, req.eventId);
  if (eventData.duration == null || req.dataExtent.to > eventData.duration) {
    Object.assign(eventData, {
      duration: req.dataExtent.to,
      modifiedBy: req.author,
      modified: req.timestamp
    });
    await mall.events.update(userId, eventData);
  }
}

// --- MetadataUpdater: the in-process service ---

class MetadataUpdater {
  constructor () {
    this.pending = new PendingUpdatesMap();
    this.timer = null;
  }

  start () {
    logger.info(`Starting in-process metadata updater (flush every ${FLUSH_INTERVAL_MS}ms)`);
    this.timer = setInterval(() => this._flush(), FLUSH_INTERVAL_MS);
  }

  stop () {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async scheduleUpdate (req) {
    const now = Date.now() / 1e3;
    for (const entry of req.entries) {
      const update = PendingUpdate.fromUpdateRequest(now, entry);
      this.pending.merge(update);
    }
    return {};
  }

  async _flush () {
    const now = Date.now() / 1e3;
    const updates = this.pending.getElapsed(now);
    if (updates.length === 0) return;
    logger.info(`Flushing ${updates.length} metadata updates...`);
    for (const update of updates) {
      try {
        await flush(update);
      } catch (err) {
        logger.error(`Flush error for ${update.key()}: ${err.message}`);
      }
    }
  }
}

// --- MetadataForgetter: noop when metadata updater is not configured ---

class MetadataForgetter {
  constructor (log) {
    this.logger = log;
  }

  async scheduleUpdate () {
    this.logger.info('Metadata of events will NOT be updated; please configure the metadata update service.');
    return { deadline: Date.now() / 1e3 };
  }
}

module.exports = {
  MetadataUpdater,
  MetadataForgetter
};
