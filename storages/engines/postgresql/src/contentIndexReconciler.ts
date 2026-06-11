/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Declarative reconciliation of content-query acceleration indexes.
 *
 * Operators declare paths in `storages.contentIndexes` (platform-wide
 * config); this module makes the `events` table's `pryv_cq_*` indexes
 * match the declaration: missing ones are created (CONCURRENTLY — no
 * production lock), undeclared or invalid ones are dropped.
 *
 * Indexes are pure acceleration — content queries are correct without
 * them (sequential scan). Two partial indexes per declared path:
 * - `_jb`: B-tree on the jsonb value — serves eq / in / range conditions
 *   (they compare in the jsonb domain).
 * - `_tx`: B-tree (text_pattern_ops) on the text value — serves prefix.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const crypto = require('node:crypto');
const { parseJsonPath } = require('../../../shared/contentQueryConditions.ts');

type QueryResult = { rows: Array<Record<string, unknown>> };
type DbLike = { query: (sql: string, params?: unknown[]) => Promise<QueryResult> };
import type { Logger } from '@pryv/boiler';
type IndexDeclaration = { field?: 'content' | 'clientData'; path: string; types?: string[] };
type ReconcileSummary = { created: string[]; dropped: string[]; kept: string[] };

const INDEX_PREFIX = 'pryv_cq_';
const TYPE_REGEXP = /^[a-zA-Z0-9*/:_-]+$/;

export { reconcileContentIndexes, buildIndexStatements };
export type { IndexDeclaration, ReconcileSummary };

/**
 * Build the two CREATE INDEX statements (and their names) for one declaration.
 * Throws on invalid declarations — config errors should fail loudly at boot.
 */
function buildIndexStatements (declaration: IndexDeclaration): Array<{ name: string; sql: string }> {
  if (declaration == null || typeof declaration !== 'object') {
    throw new Error('Invalid storages.contentIndexes entry: expected an object with a "path".');
  }
  const field = declaration.field ?? 'content';
  if (field !== 'content' && field !== 'clientData') {
    throw new Error(`Invalid storages.contentIndexes entry: field must be 'content' or 'clientData' (got '${String(declaration.field)}').`);
  }
  if (typeof declaration.path !== 'string' || declaration.path.length === 0) {
    throw new Error('Invalid storages.contentIndexes entry: missing "path".');
  }
  const segments = parseJsonPath(declaration.path); // throws on bad grammar
  const types = declaration.types ?? [];
  if (!Array.isArray(types) || types.some((t) => typeof t !== 'string' || !TYPE_REGEXP.test(t))) {
    throw new Error(`Invalid storages.contentIndexes entry for path '${declaration.path}': "types" must be an array of event types.`);
  }

  const column = field === 'clientData' ? 'client_data' : 'content';
  const pathLiteral = segments === null
    ? null
    : `'{${segments.map((s: string) => `"${s}"`).join(',')}}'`;
  const jsonbExpr = pathLiteral === null ? column : `(${column} #> ${pathLiteral})`;
  const textExpr = pathLiteral === null ? `(${column} #>> '{}')` : `(${column} #>> ${pathLiteral})`;
  let predicate = `${jsonbExpr} IS NOT NULL`;
  if (types.length > 0) {
    predicate += ` AND type IN (${types.map((t) => `'${t}'`).join(', ')})`;
  }

  const hash: string = crypto.createHash('sha1')
    .update(`${field}\n${declaration.path}\n${[...types].sort().join(',')}`)
    .digest('hex').slice(0, 12);
  const baseName = `${INDEX_PREFIX}${hash}`;

  return [
    { name: `${baseName}_jb`, sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${baseName}_jb ON events ((${jsonbExpr})) WHERE ${predicate}` },
    { name: `${baseName}_tx`, sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${baseName}_tx ON events ((${textExpr}) text_pattern_ops) WHERE ${predicate}` }
  ];
}

/**
 * Make the events table's `pryv_cq_*` indexes match the declarations.
 */
async function reconcileContentIndexes (db: DbLike, declarations: unknown, logger: Logger): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { created: [], dropped: [], kept: [] };
  const declared = (declarations ?? []) as IndexDeclaration[];
  if (!Array.isArray(declared)) {
    throw new Error('Invalid storages.contentIndexes: expected an array.');
  }

  const desired = new Map<string, string>(); // name → CREATE statement
  for (const declaration of declared) {
    for (const { name, sql } of buildIndexStatements(declaration)) {
      desired.set(name, sql);
    }
  }

  // Existing pryv_cq_* indexes + validity (a failed CONCURRENTLY build
  // leaves an INVALID index behind that IF NOT EXISTS would keep).
  const existingRes = await db.query(`
    SELECT c.relname AS name, i.indisvalid AS valid
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE t.relname = 'events' AND c.relname LIKE '${INDEX_PREFIX}%'`);
  const existing = new Map<string, boolean>(
    existingRes.rows.map((r) => [r.name as string, r.valid === true])
  );

  // Drop: undeclared, or declared-but-invalid (will be recreated below)
  for (const [name, valid] of existing) {
    if (desired.has(name) && valid) continue;
    await db.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
    summary.dropped.push(name);
    existing.delete(name);
  }

  // Create missing
  for (const [name, sql] of desired) {
    if (existing.has(name)) {
      summary.kept.push(name);
      continue;
    }
    await db.query(sql);
    summary.created.push(name);
  }

  // Refresh planner statistics after index changes — without this the
  // planner can pick poor plans (e.g. for `= ANY(jsonb[])`) until the
  // next autovacuum ANALYZE.
  if (summary.created.length > 0 || summary.dropped.length > 0) {
    await db.query('ANALYZE events');
  }

  if (summary.created.length > 0 || summary.dropped.length > 0) {
    logger.info(`content-query indexes reconciled: created [${summary.created.join(', ')}], dropped [${summary.dropped.join(', ')}], kept ${summary.kept.length}`);
  } else {
    logger.debug(`content-query indexes in sync (${summary.kept.length} kept)`);
  }
  return summary;
}
