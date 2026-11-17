/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * `storages.engines.postgresql.statementTimeoutMs` /
 * `idleInTransactionTimeoutMs`: time limits on the database work of API
 * request handling, in milliseconds, 0 meaning no limit. One shared reading
 * for the boot validation and `bin/check-config.js`, so the two can never
 * disagree.
 */

const TIME_LIMIT_KEYS = ['statementTimeoutMs', 'idleInTransactionTimeoutMs'] as const;

/** Below this, a non-zero value is most likely seconds typed for milliseconds. */
const SUSPICIOUSLY_LOW_MS = 1000;

type Problem = { path: string[]; message: string };

function describePgTimeLimits (pg: unknown): { problems: Problem[]; warnings: string[] } {
  const block = (pg != null && typeof pg === 'object') ? pg as Record<string, unknown> : {};
  const problems: Problem[] = [];
  const warnings: string[] = [];
  for (const key of TIME_LIMIT_KEYS) {
    const value = block[key];
    if (value == null) continue;
    const path = ['storages', 'engines', 'postgresql', key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      problems.push({ path, message: 'must be an integer number of milliseconds >= 0 (0: no limit)' });
    } else if (value > 0 && value < SUSPICIOUSLY_LOW_MS) {
      warnings.push(`${path.join('.')} is ${value} ms: a value in milliseconds is expected (30000 for 30 s).`);
    }
  }
  return { problems, warnings };
}

export { describePgTimeLimits };
