/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Method classes: one rule set, shared with clients that chart an account's
 * activity (the account app carries the same rules and the same test fixture,
 * and the access data structure documents them). Keep the three in step.
 *
 * Rules, first match wins (`last` is the segment after the last dot; a method
 * id without a dot is its own `last`):
 * 1. `callBatch` is `batch` (never counted: its inner calls are);
 * 2. `auth.*`, `mfa.*`, `oauth.*`, `sso.*` are `session`;
 * 3. `read` when `last` starts with get / list / check / retrieve, or is one
 *    of info, usernameChanges, controlledStatus, extIdHolds;
 * 4. `write` when `last` starts with create / update / delete / set / replace /
 *    claim / release / change / accept / refuse / cancel / detach / dismiss /
 *    issue / notify / request / reset / verify / test / transfer / deactivate /
 *    erase, or is adminRelease or extIdRelease;
 * 5. else `other`.
 */

export type MethodClass = 'read' | 'write' | 'session' | 'other' | 'batch';

/** The classes a usage summary counts (`batch` never is). */
export const METHOD_CLASSES = ['read', 'write', 'session', 'other'] as const;

const SESSION_RE = /^(auth|mfa|oauth|sso)\./;
const READ_PREFIXES = ['get', 'list', 'check', 'retrieve'];
const READ_NAMES = new Set(['info', 'usernameChanges', 'controlledStatus', 'extIdHolds']);
const WRITE_PREFIXES = [
  'create', 'update', 'delete', 'set', 'replace', 'claim', 'release', 'change', 'accept', 'refuse',
  'cancel', 'detach', 'dismiss', 'issue', 'notify', 'request', 'reset', 'verify', 'test', 'transfer',
  'deactivate', 'erase'
];
const WRITE_NAMES = new Set(['adminRelease', 'extIdRelease']);

export function classifyMethod (methodId: string): MethodClass {
  if (methodId === 'callBatch') return 'batch';
  if (SESSION_RE.test(methodId)) return 'session';
  const last = methodId.slice(methodId.lastIndexOf('.') + 1);
  if (READ_NAMES.has(last) || READ_PREFIXES.some((p) => last.startsWith(p))) return 'read';
  if (WRITE_NAMES.has(last) || WRITE_PREFIXES.some((p) => last.startsWith(p))) return 'write';
  return 'other';
}

export type AccessUsage = {
  total: number;
  reads: number;
  writes: number;
  session: number;
  other: number;
  byMethod: Record<string, number>;
};

/**
 * The owner-facing usage summary of one access, from its stored `calls`
 * counters (keys are method ids with every dot stored as ':').
 */
export function usageFromCalls (calls: Record<string, unknown> | null | undefined): AccessUsage {
  const usage: AccessUsage = { total: 0, reads: 0, writes: 0, session: 0, other: 0, byMethod: {} };
  if (calls == null || typeof calls !== 'object') return usage;
  for (const [key, raw] of Object.entries(calls)) {
    const count = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    if (count <= 0) continue;
    const methodId = key.replaceAll(':', '.');
    const cls = classifyMethod(methodId);
    if (cls === 'batch') continue;
    usage.byMethod[methodId] = (usage.byMethod[methodId] ?? 0) + count;
    usage.total += count;
    if (cls === 'read') usage.reads += count;
    else if (cls === 'write') usage.writes += count;
    else if (cls === 'session') usage.session += count;
    else usage.other += count;
  }
  return usage;
}
