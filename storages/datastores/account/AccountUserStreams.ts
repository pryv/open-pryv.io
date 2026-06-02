/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ds = require('@pryv/datastore');

type Stream = {
  id: string;
  name?: string;
  parentId?: string | null;
  clientData?: Record<string, unknown>;
  children?: Stream[];
  childrenHidden?: boolean;
  trashed?: boolean;
  created?: number;
  createdBy?: string;
  modified?: number;
  modifiedBy?: string;
  isShown?: boolean;
  [k: string]: unknown;
};
type StreamQuery = {
  parentId?: string | null;
  excludedIds?: string[];
  childrenDepth?: number;
  [k: string]: unknown;
};

// Only keep standard stream properties (strip config-only fields like
// isEditable, isIndexed, isShown, isUnique, type, default, etc.)
const STREAM_PROPERTIES = new Set([
  'id', 'name', 'parentId', 'clientData', 'children',
  'trashed', 'created', 'createdBy', 'modified', 'modifiedBy'
]);

/**
 * Strip non-stream properties from a stream tree (mutates in place).
 */
function cleanStreamTree (streams: Stream[]): void {
  for (const s of streams) {
    for (const key of Object.keys(s)) {
      if (!STREAM_PROPERTIES.has(key)) delete s[key];
    }
    // Root streams from config have parentId: "*" — normalize to null
    if (s.parentId === '*') s.parentId = null;
    if (s.children && s.children.length > 0) cleanStreamTree(s.children);
  }
}

/**
 * Filter a stream tree to only include shown streams.
 * Non-shown streams and their subtrees are removed.
 * Must be called BEFORE cleanStreamTree (which strips isShown).
 */
function filterShown (streams: Stream[]): Stream[] {
  const result: Stream[] = [];
  for (const s of streams) {
    if (s.isShown === false) continue;
    const clone = Object.assign({}, s);
    if (clone.children && clone.children.length > 0) {
      clone.children = filterShown(clone.children);
    }
    result.push(clone);
  }
  return result;
}

/**
 * Account store UserStreams adapter.
 * Returns the system stream tree from config; rejects all CRUD
 * (streams are config-defined, not user-modifiable).
 *
 * @param streamTree - system stream tree (fully built, with prefixed IDs)
 */
function create (streamTree: Stream[]) {
  // Build a readable-only tree for get() responses (before stripping config props)
  const readableTree = filterShown(streamTree);
  cleanStreamTree(readableTree);
  ds.defaults.applyOnStreams(readableTree);

  // Strip config-only properties from full tree
  cleanStreamTree(streamTree);
  // Ensure default properties (created, modified, etc.) are set on all streams
  ds.defaults.applyOnStreams(streamTree);

  // Build a flat index from the full tree (for getOne lookups)
  const streamIndex: Map<string, Stream> = new Map();
  indexTree(streamTree);

  function indexTree (streams: Stream[]) {
    for (const s of streams) {
      streamIndex.set(s.id, s);
      if (s.children && s.children.length > 0) {
        indexTree(s.children);
      }
    }
  }

  return ds.createUserStreams({
    async get (_userId: string, query: StreamQuery) {
      let streams: Stream[];
      if (query.parentId === '*' || query.parentId == null) {
        streams = readableTree;
      } else {
        const parent = streamIndex.get(query.parentId);
        if (!parent || !parent.children) return [];
        streams = parent.children;
      }
      // Always return deep clones to prevent callers from mutating the static tree
      return applyQuery(structuredClone(streams), query);
    },

    async getOne (_userId: string, streamId: string, _query: StreamQuery) {
      const stream = streamIndex.get(streamId);
      return stream ? structuredClone(stream) : null;
    },

    async getDeletions (_userId: string, _deletionsSince: number) {
      return [];
    },

    async create (_userId: string, _streamData: Stream) {
      throw ds.errors.invalidOperation('It is forbidden to modify system streams.');
    },

    async createDeleted (_userId: string, _streamData: Stream) {
      throw ds.errors.invalidOperation('It is forbidden to modify system streams.');
    },

    async update (_userId: string, _updateData: Stream) {
      throw ds.errors.invalidOperation('It is forbidden to modify system streams.');
    },

    async delete (_userId: string, _streamId: string) {
      throw ds.errors.invalidOperation('It is forbidden to modify system streams.');
    }
  });
}

/**
 * Apply childrenDepth and excludedIds to a list of streams.
 */
function applyQuery (streams: Stream[], query: StreamQuery): Stream[] {
  let result = streams;
  if (query.excludedIds && query.excludedIds.length > 0) {
    const excluded = new Set(query.excludedIds);
    result = result.filter((s: Stream) => !excluded.has(s.id));
  }
  if (query.childrenDepth === 0) {
    result = result.map((s: Stream) => Object.assign({}, s, { children: [], childrenHidden: true }));
  }
  return result;
}

export { create };