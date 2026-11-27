/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';

/**
 * Time sorts with a tie-breaker: `idx_event_time_id` on events(user_id, time,
 * id) and `idx_audit_time_id` on audit_events(user_id, time, eventid), built
 * CONCURRENTLY (writes go on during the build), then `idx_event_time` and
 * `idx_audit_time`, which they replace, dropped CONCURRENTLY. Fresh databases
 * get the new indexes from the schema DDL (this is then a no-op). See
 * src/timeIdIndexes.ts.
 *
 * Idempotent: a valid index is kept, an invalid one (a build that failed) is
 * built again.
 */
module.exports = {
  async up (context) {
    const { ensureTimeIdIndexes } = require('../src/timeIdIndexes.ts');
    const res = await ensureTimeIdIndexes(context.db);
    for (const r of res) {
      context.logger?.info?.('time sort index ' + r.name + ': ' + (r.built ? 'built' : 'present') +
        (r.droppedPrevious ? ', previous index dropped' : '') + ' (' + r.durationMs + ' ms)');
    }
    return res;
  }
};
