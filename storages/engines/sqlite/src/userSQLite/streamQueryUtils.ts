/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { ALL_EVENTS_TAG } = require('./schema/events.ts');

export { toSQLiteQuery, toSQLiteStreamFilter, _setSetFrom };
export type { SqlPart };

/** A piece of SQL and the values of its `?` placeholders, in order. */
type SqlPart = { sql: string, params: unknown[] };

/**
 * The stream filter of an events query, for SQLite:
 * - `exact`: the condition itself, on the stored stream ids (space-separated
 *   in `events.streamIds`): an id matches only an equal stored id, letter
 *   case included (stream ids are case-sensitive: `abc` and `ABC` are two
 *   streams, and this is the authorization filter). Every id is a bound value.
 * - `fts`: a full-text expression (bound as the `MATCH` argument) selecting
 *   a superset of the rows `exact` keeps, so the full-text index can choose
 *   the candidates: the positive terms only. A full-text phrase is looser
 *   than id equality (case folded, split on punctuation), so it is never used
 *   as the condition itself. Null when the positive terms select every row,
 *   or when a positive id holds no token character (its phrase is empty and
 *   full text would match none of its rows): `exact` alone then.
 * Null when the query keeps every event.
 */
function toSQLiteStreamFilter (streamQuery: AndBlock[] | null): { fts: string | null, exact: SqlPart } | null {
  if (streamQuery == null) return null;
  const blocks = streamQuery;
  // An item holds a non-empty `any` or a non-empty `not`, not both: this is
  // the authorization filter, an item with no id is refused rather than read
  // as "no constraint".
  for (const andBlock of blocks) {
    if (typeof andBlock === 'string') continue;
    for (const andItem of andBlock) {
      const hasAny = andItem.any != null && andItem.any.length > 0;
      const hasNot = andItem.not != null && andItem.not.length > 0;
      if (hasAny === hasNot) throw new Error('Stream query item needs exactly one non-empty any or not');
    }
  }
  // A block with no id (`*`, or nothing) keeps every event, and so does an OR
  // holding one. Decided on the ids, not on the full-text text, where an id
  // `..` reads as the tag every event carries.
  const keepsAll = (andBlock: AndBlock): boolean => typeof andBlock !== 'string' &&
    positiveIds([andBlock]).length === 0 && notIds([andBlock]).length === 0;
  if (blocks.some(keepsAll)) return null;
  const params: unknown[] = [];
  const hasId = (id: string): string => {
    if (!isMatchable(id)) return '0';
    params.push(IDS_SEPARATOR + id + IDS_SEPARATOR);
    return `instr(${PADDED_IDS}, ?) > 0`;
  };
  const anyOf = (ids: string[]): string => {
    if (ids.length < setFrom) return ids.length === 1 ? hasId(ids[0]) : '(' + ids.map(hasId).join(' OR ') + ')';
    // Many ids (an expanded stream tree): one bound JSON list, so no limit on
    // the number of bound variables. A row whose stored ids hold only the
    // characters below (no quote, backslash or control character: the text
    // built from it is valid JSON) is split into its ids, each looked up in
    // the list (built once per statement: the cost per row does not grow
    // with the list); any other row is checked id by id. `GLOB` stops at a
    // NUL, hence the separate NUL test (a legacy row may hold one). A row
    // with no stored ids gives NULL, as the id-by-id form does.
    const list = [...new Set(ids.filter(isMatchable).map(String))];
    if (list.length === 0) return '0';
    const json = JSON.stringify(list);
    params.push(json, json);
    return 'CASE WHEN streamIds IS NULL THEN NULL ' +
      'WHEN instr(streamIds, char(0)) = 0 AND streamIds NOT GLOB \'*[^A-Za-z0-9 _:.-]*\' ' +
      `THEN EXISTS (SELECT 1 FROM json_each('["' || replace(streamIds, '${IDS_SEPARATOR}', '","') || '"]') WHERE value IN (SELECT value FROM json_each(?))) ` +
      `ELSE EXISTS (SELECT 1 FROM json_each(?) WHERE instr(${PADDED_IDS}, '${IDS_SEPARATOR}' || value || '${IDS_SEPARATOR}') > 0) END`;
  };
  const exactBlock = (andBlock: AndBlock): string => {
    if (typeof andBlock === 'string') return hasId(andBlock);
    const parts: string[] = [];
    for (const andItem of andBlock) {
      if (andItem.any != null && andItem.any.length > 0) {
        if (andItem.any.indexOf('*') > -1) continue;
        parts.push(anyOf(andItem.any));
      } else {
        parts.push('NOT ' + anyOf(andItem.not as string[]));
      }
    }
    return parts.length === 0 ? '1' : parts.join(' AND ');
  };
  const sql = blocks.length === 1 ? exactBlock(blocks[0]) : '((' + blocks.map(exactBlock).join(') OR (') + '))';
  const positive = blocks.map((andBlock) => typeof andBlock === 'string'
    ? andBlock
    : andBlock.filter((andItem) => andItem.any != null && andItem.any.length > 0 && andItem.any.indexOf('*') === -1));
  // No prefilter when a positive id holds NUL: full text refuses it.
  const fts = positiveIds(positive).every((id) => HAS_TOKEN_CHAR.test(id) && !String(id).includes('\u0000')) ? toSQLiteQuery(positive) : null;
  return { fts, exact: { sql, params } };
}

const IDS_SEPARATOR = ' ';
const PADDED_IDS = `'${IDS_SEPARATOR}' || streamIds || '${IDS_SEPARATOR}'`;
// The token characters of the full-text table (`fullTextSearch.ts`: unicode61,
// tokenchars '-_:.'), ASCII only.
const HAS_TOKEN_CHAR = /[A-Za-z0-9_:.-]/;
let setFrom = 8;

/**
 * An id that can equal a stored one: not empty, not the tag every event
 * carries, no separator (it would join two stored ids), no NUL (refused at
 * write; SQLite's text functions and `length()` disagree on such text).
 */
function isMatchable (id: string): boolean {
  const text = String(id);
  return text !== '' && text !== ALL_EVENTS_TAG && !text.includes(IDS_SEPARATOR) && !text.includes('\u0000');
}

function positiveIds (blocks: AndBlock[]): string[] {
  return blocks.flatMap((andBlock) => typeof andBlock === 'string'
    ? [andBlock]
    : andBlock.flatMap((andItem) => andItem.any != null && andItem.any.indexOf('*') === -1 ? andItem.any : []));
}

function notIds (blocks: AndBlock[]): string[] {
  return blocks.flatMap((andBlock) => typeof andBlock === 'string' ? [] : andBlock.flatMap((andItem) => andItem.not ?? []));
}

/** Test hook: the number of ids from which a group is one bound list; returns the previous one. */
function _setSetFrom (n: number): number {
  const previous = setFrom;
  setFrom = n;
  return previous;
}

/**
 * Get stream queries for SQLite.
 */
type StreamAndItem = { any?: string[]; not?: string[] };
type AndBlock = string | StreamAndItem[];
function toSQLiteQuery (streamQuery: AndBlock[] | null): string | null {
  if (streamQuery == null) return null;

  if (streamQuery.length === 1) {
    return processAndBlock(streamQuery[0]);
  } else { // pack in $or
    const blocks = streamQuery.map(processAndBlock);
    // one block matching every event makes the whole OR match every event
    if (blocks.includes(null)) return null;
    return '(' + blocks.join(') OR (') + ')';
  }

  function processAndBlock (andBlock: AndBlock): string | null {
    if (typeof andBlock === 'string') return addQuotes([andBlock])[0];

    const anys: string[] = [];
    const nots: string[] = [];
    for (const andItem of andBlock) {
      if (andItem.any != null && andItem.any.length > 0) {
        if (andItem.any.indexOf('*') > -1) continue; // skip and with '*';
        if (andItem.any.length === 1) {
          anys.push(addQuotes(andItem.any)[0]);
        } else {
          anys.push('(' + addQuotes(andItem.any).join(' OR ') + ')');
        }
      } else if (andItem.not != null && andItem.not.length > 0) {
        // One NOT over an OR group: FTS5 flattens a run of ORs into a single
        // node, while each NOT nests one level deeper. A chain of NOTs failed
        // past 255 excluded ids (an expanded subtree), "fts5 expression tree
        // is too large"; `a NOT (x OR y)` matches the same rows as
        // `a NOT x NOT y`.
        if (andItem.not.length === 1) {
          nots.push(' NOT ' + addQuotes(andItem.not)[0]);
        } else {
          nots.push(' NOT (' + addQuotes(andItem.not).join(' OR ') + ')');
        }
      } else {
        throw new Error('Go a query block with no any or not item ' + andBlock);
      }
    }

    if (anys.length === 0) {
      anys.push('"' + ALL_EVENTS_TAG + '"');
    }

    const res = anys.join(' AND ') + nots.join('');
    // Every event carries the tag: no filter. (This compared against the
    // unquoted tag and never matched, so `*` was a full-text match on every row.)
    if (res === '"' + ALL_EVENTS_TAG + '"') return null;
    return res;
  }
}

// A stream id is an FTS5 phrase: a double quote inside it is doubled.
function addQuotes (array: string[]): string[] {
  return array.map((x) => '"' + String(x).replace(/"/g, '""') + '"');
}
