/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';

import type { LossKind, LossReason, LossSnapshot } from './lossCounter.ts';
const require = createRequire(import.meta.url);

/**
 * Master side of the lost audit records count: adds up what the workers
 * report and answers the status request of any of them, so the status read
 * is the same whichever worker takes it. Totals survive a worker's restart
 * and start again with the master; they are not persisted and not shared
 * between cores.
 */

const { LOSS_MESSAGE, addTo, copyTotals, emptyTotals, nowSeconds } = require('./lossCounter.ts');

const STATUS_REQUEST = 'audit:loss-status';
const STATUS_REPLY = 'audit:loss-status:reply';

type WorkerLike = { send: (message: unknown, cb?: (err: Error | null) => void) => unknown };
type ClusterLike = { on: (event: 'message', fn: (worker: WorkerLike, message: unknown) => void) => unknown };
type IncomingMessage = { type?: string; kind?: LossKind; reason?: LossReason; requestId?: string } | null | undefined;

/** Attaches to the cluster; returns the totals reader (for the master and tests). */
function attach (clusterLike: ClusterLike): { snapshot: () => LossSnapshot } {
  const since = nowSeconds();
  const totals = emptyTotals();
  const snapshot = () => ({ since, lost: copyTotals(totals) });
  clusterLike.on('message', function (worker, message) {
    const msg = message as IncomingMessage;
    if (msg == null) return;
    if (msg.type === LOSS_MESSAGE) {
      addTo(totals, msg.kind, msg.reason, nowSeconds());
      return;
    }
    if (msg.type === STATUS_REQUEST) {
      try {
        worker.send({ type: STATUS_REPLY, requestId: msg.requestId, ...snapshot() }, () => { /* worker gone: nobody to answer */ });
      } catch { /* idem */ }
    }
  });
  return { snapshot };
}

export { attach, STATUS_REQUEST, STATUS_REPLY };
