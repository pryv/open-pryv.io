/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { randomUUID } from 'node:crypto';
import cluster from 'node:cluster';
import { snapshot } from 'audit/src/lossCounter.ts';
import { STATUS_REQUEST, STATUS_REPLY } from 'audit/src/lossAggregator.ts';
import type { LossSnapshot } from 'audit/src/lossCounter.ts';

/**
 * Worker side of `GET /system/audit-status`: asks the master for the lost
 * audit records of the whole core. Without a master (single process, tests),
 * or when it does not answer in time, the counts of this process are
 * returned, marked `scope: 'process'`. Never rejects.
 */

const DEFAULT_TIMEOUT_MS = 2000;

type LossStatus = LossSnapshot & { scope: 'core' | 'process' };
type ProcessLike = {
  send?: (message: unknown, cb?: (err: Error | null) => void) => unknown;
  on: (event: string, fn: (message: unknown) => void) => unknown;
  removeListener: (event: string, fn: (message: unknown) => void) => unknown;
};
type ReadOptions = { timeoutMs?: number; processHandle?: ProcessLike; isWorker?: boolean };

async function readLossStatus ({ timeoutMs = DEFAULT_TIMEOUT_MS, processHandle = process as unknown as ProcessLike, isWorker = cluster.isWorker }: ReadOptions = {}): Promise<LossStatus> {
  const local = (): LossStatus => ({ scope: 'process', ...snapshot() });
  if (!isWorker || typeof processHandle.send !== 'function') return local();
  const requestId = randomUUID();
  return await new Promise<LossStatus>((resolve) => {
    let settled = false;
    const settle = (status: LossStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      processHandle.removeListener('message', onMessage);
      resolve(status);
    };
    const onMessage = (message: unknown) => {
      const reply = message as ({ type?: string; requestId?: string } & LossSnapshot) | null;
      if (reply == null || reply.type !== STATUS_REPLY || reply.requestId !== requestId) return;
      settle({ scope: 'core', since: reply.since, lost: reply.lost });
    };
    const timer = setTimeout(() => settle(local()), timeoutMs);
    processHandle.on('message', onMessage);
    try {
      processHandle.send!({ type: STATUS_REQUEST, requestId }, (err) => { if (err != null) settle(local()); });
    } catch {
      settle(local());
    }
  });
}

export { readLossStatus };
export type { LossStatus };
