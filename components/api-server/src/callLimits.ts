/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Per-call ceilings applied where every API call passes (HTTP, batch and
 * socket.io alike), before the method runs:
 *
 * - `limits.requests.maxInflightPerUser` / `maxInflightPerAccess`: how many
 *   authenticated calls of one account, and of one access, this worker runs at
 *   once. A few slow reads from one token would otherwise hold every pooled
 *   database connection and stall every other account served by the worker;
 *   the smaller per-access budget keeps one shared token from taking the whole
 *   account's. Past either the call is refused with 429 too-many-requests.
 * - `limits.json.maxDepth` / `limits.json.maxObjectKeys`: the nesting depth of
 *   the call's parameters and the key count of any one object in them.
 *   Free-form fields (event content, clientData, queries) then go through
 *   recursive code (cloning, deep comparison, serialisation, the database's
 *   JSON input), which fails on deep enough input. Past it the call is refused
 *   with 400 invalid-parameters-format.
 *
 * 0 turns a ceiling off.
 */

import { getLogger } from '@pryv/boiler';
const logger = getLogger('api:call-limits');

const CALL_LIMIT_DEFAULTS = Object.freeze({
  maxInflightPerUser: 64,
  maxInflightPerAccess: 32,
  maxDepth: 64,
  maxObjectKeys: 10000
});

/**
 * A slot left unreleased (a streamed result nobody consumes) is given back
 * after this long, so a leak can cost an account capacity for a while, never
 * for good.
 */
const SLOT_MAX_HOLD_MS = 10 * 60 * 1000;

type CallLimits = { maxInflightPerUser: number; maxInflightPerAccess: number; maxDepth: number; maxObjectKeys: number };

function countOr (value: unknown, fallback: number): number {
  return (typeof value === 'number' && Number.isInteger(value) && value >= 0) ? value : fallback;
}

/** The limits to apply, from the `limits` config block (defaults when absent or invalid). */
function readCallLimits (get: (key: string) => unknown): CallLimits {
  return {
    maxInflightPerUser: countOr(get('limits:requests:maxInflightPerUser'), CALL_LIMIT_DEFAULTS.maxInflightPerUser),
    maxInflightPerAccess: countOr(get('limits:requests:maxInflightPerAccess'), CALL_LIMIT_DEFAULTS.maxInflightPerAccess),
    maxDepth: countOr(get('limits:json:maxDepth'), CALL_LIMIT_DEFAULTS.maxDepth),
    maxObjectKeys: countOr(get('limits:json:maxObjectKeys'), CALL_LIMIT_DEFAULTS.maxObjectKeys)
  };
}

/** Calls in progress per key (`user:<id>`, `access:<id>`), in this worker. */
const inflight: Map<string, number> = new Map();

/**
 * Take a slot for `key`. Returns the function that gives it back (safe to
 * call more than once), or null when `key` is at `max` already.
 */
function acquireCallSlot (key: string, max: number): (() => void) | null {
  if (max <= 0) return () => {};
  const current = inflight.get(key) ?? 0;
  if (current >= max) return null;
  inflight.set(key, current + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    const left = (inflight.get(key) ?? 1) - 1;
    if (left > 0) inflight.set(key, left);
    else inflight.delete(key);
  };
  const timer = setTimeout(() => {
    // A call whose result was never consumed: say so, it is a leak to find.
    logger.warn(`a call slot was still held after ${SLOT_MAX_HOLD_MS / 60000} minutes: released`);
    release();
  }, SLOT_MAX_HOLD_MS);
  timer.unref();
  return release;
}

/** Calls in progress for `key` in this worker (for tests and diagnostics). */
function inflightCount (key: string): number {
  return inflight.get(key) ?? 0;
}

function isPlainObject (value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The first way `value` exceeds the shape limits, or null. Walks plain objects
 * and arrays only (buffers and other objects are left alone), without
 * recursion, so the check itself cannot run out of stack.
 */
function jsonShapeProblem (value: unknown, limits: { maxDepth: number; maxObjectKeys: number }): string | null {
  const { maxDepth, maxObjectKeys } = limits;
  if (maxDepth <= 0 && maxObjectKeys <= 0) return null;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    let children: unknown[];
    if (Array.isArray(node)) {
      children = node;
    } else if (isPlainObject(node)) {
      const keys = Object.keys(node);
      if (maxObjectKeys > 0 && keys.length > maxObjectKeys) {
        return `an object in the parameters has more than ${maxObjectKeys} keys`;
      }
      children = keys.map((k) => node[k]);
    } else {
      continue;
    }
    if (maxDepth > 0 && depth > maxDepth) {
      return `the parameters are nested more than ${maxDepth} levels deep`;
    }
    for (const child of children) {
      if (child != null && typeof child === 'object') stack.push({ node: child, depth: depth + 1 });
    }
  }
  return null;
}

/**
 * `http.responseIdleTimeoutMs`: a connection with no traffic either way for
 * this long is closed. A client that stops reading a streamed response would
 * otherwise hold the response's database cursor (and its pooled connection)
 * and the call's slots for as long as it keeps the connection open. Upgraded
 * connections (socket.io) are not affected. 0 = no timeout.
 */
const RESPONSE_IDLE_TIMEOUT_DEFAULT_MS = 60000;

function readResponseIdleTimeoutMs (get: (key: string) => unknown): number {
  return countOr(get('http:responseIdleTimeoutMs'), RESPONSE_IDLE_TIMEOUT_DEFAULT_MS);
}

/**
 * `limits.audit.maxConcurrentReadsPerAccess`: streamed audit reads one access
 * runs at once on this worker. Each holds a client of the audit read pool
 * (a few connections, shared with the backup export) until it has been read.
 */
const AUDIT_READS_PER_ACCESS_DEFAULT = 1;

function readAuditReadLimit (get: (key: string) => unknown): number {
  return countOr(get('limits:audit:maxConcurrentReadsPerAccess'), AUDIT_READS_PER_ACCESS_DEFAULT);
}

/** Sets the idle timeout on a Node http(s) server; with no 'timeout' listener Node destroys the socket. */
function applyResponseIdleTimeout (server: { setTimeout: (ms: number) => unknown }, ms: number): void {
  if (ms > 0) server.setTimeout(ms);
}

export { CALL_LIMIT_DEFAULTS, readCallLimits, acquireCallSlot, inflightCount, jsonShapeProblem, RESPONSE_IDLE_TIMEOUT_DEFAULT_MS, readResponseIdleTimeoutMs, applyResponseIdleTimeout, AUDIT_READS_PER_ACCESS_DEFAULT, readAuditReadLimit };
export type { CallLimits };
