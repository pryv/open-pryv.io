/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Audit records that should have been written and were not, counted in this
 * process, reported to the telemetry facade and to the master (which holds
 * the totals of the core, see `lossAggregator.ts`).
 *
 * The audit object counts, its callers never do: one record attempt is at
 * most one count. Counts, two closed vocabularies and timestamps only: no
 * account, method, message or stack ever enters this module.
 *
 * Counting never throws, never waits and never changes the answer of the call
 * whose record was lost.
 */

const cluster = require('node:cluster');
const observability = require('business/src/observability/index.ts');

/** `valid` / `error`: the record of an API call; `event`: any other record. */
const KINDS = Object.freeze(['valid', 'error', 'event'] as const);
/**
 * - `storage-write-failed`: the audit storage refused or failed the write;
 * - `storage-unavailable`: there is no audit storage to write to;
 * - `invalid-record`: the record could not be built or is not valid;
 * - `syslog-failed`: the record was not handed to syslog (it is in the audit
 *   storage when its method is stored too).
 */
const REASONS = Object.freeze(['storage-write-failed', 'storage-unavailable', 'invalid-record', 'syslog-failed'] as const);

type LossKind = typeof KINDS[number];
type LossReason = typeof REASONS[number];
type LossTotals = {
  total: number;
  byKind: Record<LossKind, number>;
  byReason: Record<LossReason, number>;
  /** Time of the last loss (seconds), null when there was none. */
  lastAt: number | null;
};
type LossSnapshot = { since: number; lost: LossTotals };
type LossMessage = { type: string; kind: LossKind; reason: LossReason };
type Transport = (message: LossMessage) => void;

/** Message a worker sends to the master for each loss. */
const LOSS_MESSAGE = 'audit:lost';

function nowSeconds (): number {
  return Date.now() / 1000;
}

function emptyTotals (): LossTotals {
  return {
    total: 0,
    byKind: { valid: 0, error: 0, event: 0 },
    byReason: { 'storage-write-failed': 0, 'storage-unavailable': 0, 'invalid-record': 0, 'syslog-failed': 0 },
    lastAt: null
  };
}

function isLoss (kind: unknown, reason: unknown): boolean {
  return (KINDS as readonly unknown[]).includes(kind) && (REASONS as readonly unknown[]).includes(reason);
}

/** Adds one loss to `totals`; ignores a pair outside the vocabularies. */
function addTo (totals: LossTotals, kind: LossKind, reason: LossReason, at: number): void {
  if (!isLoss(kind, reason)) return;
  totals.total += 1;
  totals.byKind[kind] += 1;
  totals.byReason[reason] += 1;
  totals.lastAt = at;
}

function copyTotals (totals: LossTotals): LossTotals {
  return {
    total: totals.total,
    byKind: { ...totals.byKind },
    byReason: { ...totals.byReason },
    lastAt: totals.lastAt
  };
}

/**
 * A cluster worker tells the master. The callback matters: without one, a
 * message that cannot be sent is emitted as an `error` event on the process.
 */
function sendToMaster (message: LossMessage): void {
  if (!cluster.isWorker || typeof process.send !== 'function' || process.connected !== true) return;
  process.send(message, undefined, undefined, () => { /* not delivered: the local count stands */ });
}

let since = nowSeconds();
let totals = emptyTotals();
let transport: Transport = sendToMaster;

function record (kind: LossKind, reason: LossReason): void {
  addTo(totals, kind, reason, nowSeconds());
  try { observability.recordAuditLoss(kind, reason); } catch { /* never let counting break a call */ }
  try { transport({ type: LOSS_MESSAGE, kind, reason }); } catch { /* idem */ }
}

/** The counts of this process since it started. */
function snapshot (): LossSnapshot {
  return { since, lost: copyTotals(totals) };
}

/** Test-only: replace the message channel to the master. */
function _setTransport (fn: Transport | null): void {
  transport = fn ?? sendToMaster;
}

/** Test-only. */
function _reset (): void {
  since = nowSeconds();
  totals = emptyTotals();
}

export { KINDS, REASONS, LOSS_MESSAGE, record, snapshot, isLoss, addTo, copyTotals, emptyTotals, nowSeconds, _setTransport, _reset };
export type { LossKind, LossReason, LossTotals, LossSnapshot };
