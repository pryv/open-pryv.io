/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { ALL_EVENTS_TAG } = require('./schema/events.ts');

export { toSQLiteQuery, toSQLiteStreamFilter, _setShortcutMinIds };
export type { SqlPart };

/** A piece of SQL and the values of its `?` placeholders, in order. */
type SqlPart = { sql: string, params: unknown[] };

/**
 * The stream filter of an events query, for SQLite:
 * - `exact`: the condition itself, on the stored stream ids (space-separated
 *   in `events.streamIds`): an id matches only an equal stored id, ASCII
 *   letter case folded (SQLite `lower`, as the audit summary and the audit
 *   stream listing, whose `action-…` / `access-…` ids are lower-cased).
 *   Every id is a bound value.
 * - `fts`: a full-text expression (bound as the `MATCH` argument) selecting
 *   a superset of the rows `exact` keeps, so the full-text index can choose
 *   the candidates: the positive terms only. A full-text phrase is looser
 *   than id equality (case folded, split on punctuation), so a `NOT` there
 *   could drop rows the exact condition keeps. Null when the positive terms
 *   select every row, or when a positive id holds no token character (its
 *   phrase is empty and full text would match none of its rows): `exact`
 *   alone then.
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
    return `instr(lower('${IDS_SEPARATOR}' || streamIds || '${IDS_SEPARATOR}'), lower(?)) > 0`;
  };
  const anyOf = (ids: string[]): string => {
    if (ids.length === 1) return hasId(ids[0]);
    if (ids.length <= LIST_AS_JSON_FROM) return '(' + ids.map(hasId).join(' OR ') + ')';
    // A long list (an expanded stream tree) is one bound value: no limit on
    // the number of bound variables.
    const padded = ids.filter(isMatchable).map((id) => IDS_SEPARATOR + id + IDS_SEPARATOR);
    if (padded.length === 0) return '0';
    params.push(JSON.stringify(padded));
    return `EXISTS (SELECT 1 FROM json_each(?) WHERE instr(lower('${IDS_SEPARATOR}' || streamIds || '${IDS_SEPARATOR}'), lower(value)) > 0)`;
  };
  const exactBlock = (andBlock: AndBlock): string => {
    if (typeof andBlock === 'string') return hasId(andBlock);
    const parts: string[] = [];
    for (const andItem of andBlock) {
      if (andItem.any != null && andItem.any.length > 0) {
        if (andItem.any.indexOf('*') > -1) continue;
        parts.push(anyOf(andItem.any));
      } else if (andItem.not != null && andItem.not.length > 0) {
        parts.push('NOT ' + anyOf(andItem.not));
      }
    }
    return parts.length === 0 ? '1' : parts.join(' AND ');
  };
  const sql = blocks.length === 1 ? exactBlock(blocks[0]) : '((' + blocks.map(exactBlock).join(') OR (') + '))';
  const positive = blocks.map((andBlock) => typeof andBlock === 'string'
    ? andBlock
    : andBlock.filter((andItem) => andItem.any != null && andItem.any.length > 0 && andItem.any.indexOf('*') === -1));
  const fts = positiveIds(positive).every((id) => HAS_TOKEN_CHAR.test(id)) ? toSQLiteQuery(positive) : null;
  const exact = { sql, params };
  const ids = [...positiveIds(blocks), ...notIds(blocks)];
  if (ids.length < shortcutMinIds || !ids.every((id) => SINGLE_TOKEN.test(id) && isMatchable(id))) return { fts, exact };
  // Many ids, each one full-text token: on a row whose stored ids are made
  // of token characters only (ids from the API, system and audit ids), the
  // full-text expression, `NOT` included, is that exact condition (a token
  // is a whole stored id, ASCII case folded as `lower`). That row costs one
  // pattern check and one look-up in a full-text result instead of one
  // `instr` per id; any other row takes the exact condition.
  let viaFullText: SqlPart;
  const nots = notIds(blocks);
  if (blocks.length === 1) {
    // One block: its positive terms are the prefilter (or none), exact on
    // such a row, so only the rows to drop are looked up (a small set, not
    // the rows kept).
    viaFullText = nots.length === 0
      ? { sql: '1', params: [] }
      : { sql: 'rowid NOT IN (SELECT rowid FROM events_fts WHERE streamIds MATCH ?)', params: ['(' + addQuotes(nots).join(' OR ') + ')'] };
  } else if (fts !== null) {
    const full = toSQLiteQuery(blocks) as string;
    viaFullText = full === fts ? { sql: '1', params: [] } : { sql: 'rowid IN (SELECT rowid FROM events_fts WHERE streamIds MATCH ?)', params: [full] };
  } else {
    return { fts, exact };
  }
  return {
    fts,
    exact: {
      sql: `CASE WHEN streamIds NOT GLOB '*[^A-Za-z0-9 _:.-]*' THEN ${viaFullText.sql} ELSE ${sql} END`,
      params: [...viaFullText.params, ...params]
    }
  };
}

const IDS_SEPARATOR = ' ';
// The token characters of the full-text table (`fullTextSearch.ts`: unicode61,
// tokenchars '-_:.'), ASCII only.
const SINGLE_TOKEN = /^[A-Za-z0-9_:.-]+$/;
const HAS_TOKEN_CHAR = /[A-Za-z0-9_:.-]/;
let shortcutMinIds = 8;
const LIST_AS_JSON_FROM = 32;

/**
 * An id that can equal a stored one: not empty, not the tag every event
 * carries, no separator (it would join two stored ids).
 */
function isMatchable (id: string): boolean {
  const text = String(id);
  return text !== '' && text !== ALL_EVENTS_TAG && !text.includes(IDS_SEPARATOR);
}

function positiveIds (blocks: AndBlock[]): string[] {
  return blocks.flatMap((andBlock) => typeof andBlock === 'string'
    ? [andBlock]
    : andBlock.flatMap((andItem) => andItem.any != null && andItem.any.indexOf('*') === -1 ? andItem.any : []));
}

function notIds (blocks: AndBlock[]): string[] {
  return blocks.flatMap((andBlock) => typeof andBlock === 'string' ? [] : andBlock.flatMap((andItem) => andItem.not ?? []));
}

/** Test hook: the number of ids from which the full-text shortcut applies; returns the previous one. */
function _setShortcutMinIds (n: number): number {
  const previous = shortcutMinIds;
  shortcutMinIds = n;
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
