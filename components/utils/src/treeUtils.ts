/* eslint-disable no-prototype-builtins */
/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Helper methods for handling tree object structures.
 * Here 'tree' means a recursive array of objects with a 'children' property.
 */

// `children?: this[]` is polymorphic: for a `T extends TreeItem`,
// `item.children` is `T[]` — no per-call-site `as T[]` casts needed.
interface TreeItem {
  id: string;
  parentId?: string | null;
  children?: this[];
  deleted?: unknown;
  [k: string]: unknown;
}

type Predicate<T extends TreeItem> = (item: T) => boolean;
type AsyncPredicate<T extends TreeItem> = (item: T) => Promise<boolean>;
type Iter<T extends TreeItem, R> = (item: T) => R;

/**
 * Items whose parent id refer to an item absent from the array are filtered out.
 * Items with no parent id are just left as they are.
 * The result is made from copies of the original items (which are left untouched).
 *
 * @param stripParentIds Optional, default: false
 */
function buildTree<T extends TreeItem> (array: T[], stripParentIds?: boolean): T[] {
  if (!Array.isArray(array)) {
    throw new Error('Invalid argument: expected an array');
  }
  const map: Record<string, T> = {};
  array.forEach(function (item: T) {
    verifyFlatItem(item);
    const clone = structuredClone(item);
    if (clone.deleted == null) clone.children = [];
    map[item.id] = clone;
  });
  const result: T[] = [];
  array.forEach(function (item: T) {
    const clone = map[item.id];
    if (clone.hasOwnProperty('parentId') && clone.parentId) {
      // child
      if (!map[clone.parentId]) {
        // missing parent -> ignore
        return;
      }
      if (map[clone.parentId].children == null) { map[clone.parentId].children = []; }
      map[clone.parentId].children!.push(clone);
    } else {
      // root
      result.push(clone);
    }
    if (stripParentIds && clone.hasOwnProperty('parentId')) {
      delete clone.parentId;
    }
  });
  return result;
}

function verifyFlatItem (item: TreeItem): void {
  if (!item.hasOwnProperty('id')) {
    throw new Error('Invalid object structure: expected property "id"');
  }
}

/**
 * The result is made from copies of the original items (which are left untouched).
 */
function flattenTreeWithoutParents<T extends TreeItem> (array: T[]): T[] {
  if (!Array.isArray(array)) {
    throw new Error('Invalid argument: expected an array');
  }
  const result: T[] = [];
  flattenRecursiveWithoutParents(array, null, result);
  return result;
}

function flattenRecursiveWithoutParents<T extends TreeItem> (originalArray: T[], parentId: string | null, resultArray: T[]): void {
  originalArray.forEach(function (item: T) {
    const clone = structuredClone(item);
    clone.parentId = parentId; // WTF
    const children = clone.children;
    if (Array.isArray(children) && children.length > 0) {
      flattenRecursive(clone.children!, clone.id, resultArray);
      delete clone.children; // WTF #2
    } else {
      resultArray.push(clone);
    }
  });
}

/**
 * Takes object in structure like this:
 * {
 *  username: myusername,
 *  storageUsed: {
 *    dbDocuments: 1,
 *    attachedFiles: 3
 *  }
 * }
 *
 * and converts it to:
 *  username: myusername,
 *  dbDocuments: 1,
 *  attachedFiles: 3
 * }
 */
function flattenSimpleObject (object: Record<string, unknown>): Record<string, unknown> {
  if (!(object instanceof Object)) {
    throw new Error('Invalid argument: expected an object');
  }
  const result: Record<string, unknown> = {};
  flattenRecursiveSimpleObject(object, result);
  return result as Record<string, unknown>;
}

function flattenRecursiveSimpleObject (originalObject: Record<string, unknown>, resultArray: Record<string, unknown>): void {
  Object.keys(originalObject).forEach(function (key: string) {
    const value = structuredClone(originalObject[key]);
    if (typeof value === 'object') {
      flattenRecursiveSimpleObject(value as Record<string, unknown>, resultArray);
    } else {
      resultArray[key] = value;
    }
  });
}

/**
 * The result is made from copies of the original items (which are left untouched).
 */
function flattenTree<T extends TreeItem> (array: T[]): T[] {
  if (!Array.isArray(array)) {
    throw new Error('Invalid argument: expected an array');
  }
  const result: T[] = [];
  flattenRecursive(array, null, result);
  return result;
}

function flattenRecursive<T extends TreeItem> (originalArray: T[], parentId: string | null, resultArray: T[]): void {
  originalArray.forEach(function (item: T) {
    const clone = structuredClone(item);
    // When recursing into a parent's `children` array, the tree position
    // is authoritative — overwrite parentId with the parent's id.
    // At the root call (parentId === null), preserve any pre-existing
    // parentId on the item, defaulting to null when neither is set.
    // This makes flattenTree() idempotent on already-flat input
    // (e.g. backup-restore pushes flat streams with parentId already set;
    // without this, every parentId was silently nuked).
    if (parentId !== null) {
      clone.parentId = parentId;
    } else if (clone.parentId === undefined) {
      clone.parentId = null;
    }
    resultArray.push(clone);
    if (clone.hasOwnProperty('children')) {
      flattenRecursive(clone.children!, clone.id, resultArray);
      delete clone.children;
    }
  });
}

function findById<T extends TreeItem> (array: T[], id: string): T | null {
  return findInTree(array, function (item: T) {
    return item.id === id;
  });
}

/**
 * @param iterator Arguments: ({Object}), return value: {Boolean}
 */
function findInTree<T extends TreeItem> (array: T[], iterator: Predicate<T>): T | null {
  for (let i = 0, n = array.length; i < n; i++) {
    const item = array[i];
    // check if item matches
    if (iterator(item)) {
      return item;
    }
    // if not check its children if any
    if (item.hasOwnProperty('children')) {
      const childrenFind = findInTree(item.children!, iterator);
      if (childrenFind) {
        return childrenFind;
      }
    }
  }
  // not found
  return null;
}

/**
 * Iterate on Tree, if iterator returns false, do not inspect children
 * @param iterator Arguments: ({Object}), return value: {Boolean}
 */
async function iterateOnPromise<T extends TreeItem> (array: T[] | null | undefined, iterator: AsyncPredicate<T>): Promise<void> {
  if (!array) { return; }
  for (const stream of array) {
    if ((await iterator(stream)) && stream.children) { await iterateOnPromise(stream.children, iterator); }
  }
}

/**
 * @async
 * @param keepOrphans Whether to take into account the children of filtered-out items
 *                              (if yes, the tree structure may be modified)
 */
async function filterTreeOnPromise<T extends TreeItem> (array: T[], keepOrphans: boolean, iterator: AsyncPredicate<T>): Promise<T[]> {
  const filteredArray: T[] = [];
  for (let i = 0, n = array.length; i < n; i++) {
    const item = array[i];
    if (await iterator(item)) {
      const clone = structuredClone(item);
      filteredArray.push(clone);
      if (clone.hasOwnProperty('children')) {
        clone.children = await filterTreeOnPromise(clone.children!, keepOrphans, iterator);
      }
    } else if (item.hasOwnProperty('children') && keepOrphans) {
      const res = await filterTreeOnPromise(item.children!, keepOrphans, iterator);
      filteredArray.push(...res);
    }
  }
  return filteredArray;
}

/**
 * The result is made from copies of the original items (which are left untouched).
 * @param keepOrphans Whether to take into account the children of filtered-out items
 *                              (if yes, the tree structure may be modified)
 * @param iterator Arguments: ({Object}), return value: {Boolean}
 */
function filterTree<T extends TreeItem> (array: T[], keepOrphans: boolean, iterator: Predicate<T>): T[] {
  const filteredArray: T[] = [];
  for (let i = 0, n = array.length; i < n; i++) {
    const item = array[i];
    if (iterator(item)) {
      const clone = structuredClone(item);
      filteredArray.push(clone);
      if (clone.hasOwnProperty('children')) {
        clone.children = filterTree(clone.children!, keepOrphans, iterator);
      }
    } else if (item.hasOwnProperty('children') && keepOrphans) {
      filteredArray.push.apply(filteredArray, filterTree(item.children!, keepOrphans, iterator));
    }
  }
  return filteredArray;
}

function collect<T extends TreeItem, R> (array: T[], iterator: Iter<T, R>): R[] {
  if (!Array.isArray(array)) {
    throw new Error('Invalid argument: expected an array');
  }
  const result: R[] = [];
  collectRecursive(array, result, iterator);
  return result;
}

function collectFromRootItem<T extends TreeItem, R> (item: T, iterator: Iter<T, R>): R[] {
  if (Array.isArray(item)) {
    throw new Error('Invalid argument: expected a single item');
  }
  const result: R[] = [iterator(item)];
  collectRecursive(item.children!, result, iterator);
  return result;
}

function collectRecursive<T extends TreeItem, R> (originalArray: T[], resultArray: R[], iterator: Iter<T, R>): void {
  originalArray.forEach(function (item: T) {
    resultArray.push(iterator(item));
    if (item.hasOwnProperty('children')) {
      collectRecursive(item.children!, resultArray, iterator);
    }
  });
}

function collectPluck<T extends TreeItem> (array: T[], propertyName: string): unknown[] {
  return collect(array, function (item: T) {
    return item[propertyName];
  });
}

function collectPluckFromRootItem<T extends TreeItem> (item: T, propertyName: string): unknown[] {
  return collectFromRootItem(item, function (item: T) {
    return item[propertyName];
  });
}

/**
 * Returns an array with the given ids plus those of their descendants, excluding unknown ids but
 * including `null` if present.
 *
 */
function expandIds<T extends TreeItem> (array: T[], ids: Array<string | null>): Array<string | null> {
  const expandedIds: Array<string | null> = [];
  ids.forEach(function (id: string | null) {
    let currentExpIds: Array<string | null>;
    if (id === null) {
      // just keep it
      currentExpIds = [null];
    } else {
      const item = findById(array, id);
      if (!item) {
        return;
      }
      currentExpIds = collectPluckFromRootItem(item, 'id') as Array<string | null>;
    }
    expandedIds.push.apply(expandedIds, currentExpIds);
  });
  return expandedIds;
}

/**
 * Applies "iterator" function to all elements of the array and its children.
 */
function cloneAndApply<T extends TreeItem> (array: T[], iterator: Iter<T, T>): T[] {
  const result: T[] = [];
  array.forEach((item: T) => {
    const clone = structuredClone(item);
    result.push(applyRecursive(iterator(clone), iterator));
  });
  return result;
}

/**
 * Mutates the given data.
 */
function applyRecursive<T extends TreeItem> (item: T, iterator: Iter<T, T>): T {
  if (!Array.isArray(item.children) || item.children.length === 0) { return item; }
  const result: T[] = [];
  item.children.forEach((child: T) => {
    result.push(applyRecursive(iterator(child), iterator));
  });
  item.children = result;
  return item;
}

/**
 * Display in the console
 * @param properties to display ['id', ..]
 * @param depth  - private
 */
function debug<T extends TreeItem> (streams: T[], properties?: string[], depth?: number): void {
  const myddepth = depth ? depth + 1 : 1;
  if (!properties) { properties = []; }
  const base = '-'.padStart(myddepth * 2, ' ');
  for (const stream of streams) {
    let line = base + stream.id;
    for (const p of properties) {
      line += ' | ' + p + ': ' + String(stream[p]);
    }
    console.log(line);
    if (stream.children) {
      debug(stream.children, properties, myddepth);
    }
  }
}

const treeUtils = {
  buildTree,
  flattenTreeWithoutParents,
  flattenSimpleObject,
  flattenTree,
  findById,
  findInTree,
  iterateOnPromise,
  filterTreeOnPromise,
  filterTree,
  collect,
  collectFromRootItem,
  collectPluck,
  collectPluckFromRootItem,
  expandIds,
  cloneAndApply,
  debug
};

export {
  treeUtils,
  buildTree,
  flattenTreeWithoutParents,
  flattenSimpleObject,
  flattenTree,
  findById,
  findInTree,
  iterateOnPromise,
  filterTreeOnPromise,
  filterTree,
  collect,
  collectFromRootItem,
  collectPluck,
  collectPluckFromRootItem,
  expandIds,
  cloneAndApply,
  debug
};
export type { TreeItem };
