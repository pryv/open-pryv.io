/* eslint-disable no-prototype-builtins */
/**
 * @license
 * Copyright (C) 2020–2023 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

/**
 * Helper methods for handling tree object structures.
 * Here 'tree' means a recursive array of objects with a 'children' property.
 */

/**
 * Items whose parent id refer to an item absent from the array are filtered out.
 * Items with no parent id are just left as they are.
 * The result is made from copies of the original items (which are left untouched).
 *
 * @param {Boolean} stripParentIds Optional, default: false
 */
exports.buildTree = function (array, stripParentIds) {
  if (!Array.isArray(array)) {
    throw new Error('Invalid argument: expected an array');
  }
  const map = {};
  array.forEach(function (item) {
    verifyFlatItem(item);
    const clone = structuredClone(item);
    if (clone.deleted == null) clone.children = [];
    map[item.id] = clone;
  });
  const result = [];
  array.forEach(function (item) {
    const clone = map[item.id];
    if (clone.hasOwnProperty('parentId') && clone.parentId) {
      // child
      if (!map[clone.parentId]) {
        // missing parent -> ignore
        return;
      }
      if (map[clone.parentId].children == null) { map[clone.parentId].children = []; }
      map[clone.parentId].children.push(clone);
    } else {
      // root
      result.push(clone);
    }
    if (stripParentIds && clone.hasOwnProperty('parentId')) {
      delete clone.parentId;
    }
  });
  return result;
};

/**
 * @returns {void}
 */
function verifyFlatItem (item) {
  if (!item.hasOwnProperty('id')) {
    throw new Error('Invalid object structure: expected property "id"');
  }
}

/**
 * The result is made from copies of the original items (which are left untouched).
 * @param {any[]} array
 * @returns {any[]}
 */
exports.flattenTreeWithoutParents = function (array) {
  if (!Array.isArray(array)) {
    throw new Error('Invalid argument: expected an array');
  }
  const result = [];
  flattenRecursiveWithoutParents(array, null, result);
  return result;
};

/**
 * @returns {void}
 */
function flattenRecursiveWithoutParents (originalArray, parentId, resultArray) {
  originalArray.forEach(function (item) {
    const clone = structuredClone(item);
    clone.parentId = parentId; // WTF
    const children = clone.children;
    if (Array.isArray(children) && children.length > 0) {
      flattenRecursive(clone.children, clone.id, resultArray);
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
 * @param {*} object
 */
exports.flattenSimpleObject = function (object) {
  if (!(object instanceof Object)) {
    throw new Error('Invalid argument: expected an object');
  }
  const result = [];
  flattenRecursiveSimpleObject(object, result);
  return result;
};

/**
 * @param {any[]} resultArray
 * @returns {void}
 */
function flattenRecursiveSimpleObject (originalObject, resultArray) {
  Object.keys(originalObject).forEach(function (key) {
    const value = structuredClone(originalObject[key]);
    if (typeof value === 'object') {
      flattenRecursiveSimpleObject(value, resultArray);
    } else {
      resultArray[key] = value;
    }
  });
}

/**
 * The result is made from copies of the original items (which are left untouched).
 * @param {any[]} array
 * @returns {any[]}
 */
exports.flattenTree = function (array) {
  if (!Array.isArray(array)) {
    throw new Error('Invalid argument: expected an array');
  }
  const result = [];
  flattenRecursive(array, null, result);
  return result;
};

/**
 * @returns {void}
 */
function flattenRecursive (originalArray, parentId, resultArray) {
  originalArray.forEach(function (item) {
    const clone = structuredClone(item);
    clone.parentId = parentId;
    resultArray.push(clone);
    if (clone.hasOwnProperty('children')) {
      flattenRecursive(clone.children, clone.id, resultArray);
      delete clone.children;
    }
  });
}

const findById = (exports.findById = function (array, id) {
  return findInTree(array, function (item) {
    return item.id === id;
  });
});

/**
 * @param {Function} iterator Arguments: ({Object}), return value: {Boolean}
 */
const findInTree = (exports.findInTree = function (array, iterator) {
  for (let i = 0, n = array.length; i < n; i++) {
    const item = array[i];
    // check if item matches
    if (iterator(item)) {
      return item;
    }
    // if not check its children if any
    if (item.hasOwnProperty('children')) {
      const childrenFind = findInTree(item.children, iterator);
      if (childrenFind) {
        return childrenFind;
      }
    }
  }
  // not found
  return null;
});

/**
 * Iterate on Tree, if iterator returns false, do not inspect children
 * @param {Function} iterator Arguments: ({Object}), return value: {Boolean}
 */
const iterateOnPromise = (exports.iterateOnPromise = async function (array, iterator) {
  if (!array) { return; }
  for (const stream of array) {
    if ((await iterator(stream)) && stream.children) { await iterateOnPromise(stream.children, iterator); }
  }
});

/**
 * @async
 * @param {Boolean} keepOrphans Whether to take into account the children of filtered-out items
 *                              (if yes, the tree structure may be modified)
 * @callback {Promise<boolean>} iterator Arguments: ({Object}), return value: {Boolean}
 */
const filterTreeOnPromise = (exports.filterTreeOnPromise = async function (array, keepOrphans, iterator) {
  const filteredArray = [];
  for (let i = 0, n = array.length; i < n; i++) {
    const item = array[i];
    if (await iterator(item)) {
      const clone = structuredClone(item);
      filteredArray.push(clone);
      if (clone.hasOwnProperty('children')) {
        clone.children = await filterTreeOnPromise(clone.children, keepOrphans, iterator);
      }
    } else if (item.hasOwnProperty('children') && keepOrphans) {
      const res = await filterTreeOnPromise(item.children, keepOrphans, iterator);
      filteredArray.push(...res);
    }
  }
  return filteredArray;
});

/**
 * The result is made from copies of the original items (which are left untouched).
 * @param {Boolean} keepOrphans Whether to take into account the children of filtered-out items
 *                              (if yes, the tree structure may be modified)
 * @param {Function} iterator Arguments: ({Object}), return value: {Boolean}
 */
const filterTree = (exports.filterTree = function (array, keepOrphans, iterator) {
  const filteredArray = [];
  for (let i = 0, n = array.length; i < n; i++) {
    const item = array[i];
    if (iterator(item)) {
      const clone = structuredClone(item);
      filteredArray.push(clone);
      if (clone.hasOwnProperty('children')) {
        clone.children = filterTree(clone.children, keepOrphans, iterator);
      }
    } else if (item.hasOwnProperty('children') && keepOrphans) {
      filteredArray.push.apply(filteredArray, filterTree(item.children, keepOrphans, iterator));
    }
  }
  return filteredArray;
});

const collect = (exports.collect = function (array, iterator) {
  if (!Array.isArray(array)) {
    throw new Error('Invalid argument: expected an array');
  }
  const result = [];
  collectRecursive(array, result, iterator);
  return result;
});

const collectFromRootItem = (exports.collectFromRootItem = function (item, iterator) {
  if (Array.isArray(item)) {
    throw new Error('Invalid argument: expected a single item');
  }
  const result = [iterator(item)];
  collectRecursive(item.children, result, iterator);
  return result;
});

/**
 * @returns {void}
 */
function collectRecursive (originalArray, resultArray, iterator) {
  originalArray.forEach(function (item) {
    resultArray.push(iterator(item));
    if (item.hasOwnProperty('children')) {
      collectRecursive(item.children, resultArray, iterator);
    }
  });
}

exports.collectPluck = function (array, propertyName) {
  return collect(array, function (item) {
    return item[propertyName];
  });
};

const collectPluckFromRootItem = (exports.collectPluckFromRootItem = function (item, propertyName) {
  return collectFromRootItem(item, function (item) {
    return item[propertyName];
  });
});

/**
 * Returns an array with the given ids plus those of their descendants, excluding unknown ids but
 * including `null` if present.
 *
 * @param {Array} ids
 */
exports.expandIds = function (array, ids) {
  const expandedIds = [];
  ids.forEach(function (id) {
    let currentExpIds;
    if (id === null) {
      // just keep it
      currentExpIds = [null];
    } else {
      const item = findById(array, id);
      if (!item) {
        return;
      }
      currentExpIds = collectPluckFromRootItem(item, 'id');
    }
    expandedIds.push.apply(expandedIds, currentExpIds);
  });
  return expandedIds;
};

/**
 * Applies "iterator" function to all elements of the array and its children.
 */
exports.cloneAndApply = function (array, iterator) {
  const result = [];
  array.forEach((item) => {
    const clone = structuredClone(item);
    result.push(applyRecursive(iterator(clone), iterator));
  });
  return result;
};

/**
 * Mutates the given data.
 */
function applyRecursive (item, iterator) {
  if (!Array.isArray(item.children) || item.children.length === 0) { return item; }
  const result = [];
  item.children.forEach((child) => {
    result.push(applyRecursive(iterator(child), iterator));
  });
  item.children = result;
  return item;
}

/**
 * Display in the console
 * @param {<Streams>} array
 * @param {Array} properties to display ['id', ..]
 * @param {*} depth  - private
 */
exports.debug = function debug (streams, properties, depth) {
  const myddepth = depth ? depth + 1 : 1;
  if (!properties) { properties = []; }
  const base = '-'.padStart(myddepth * 2, ' ');
  for (const stream of streams) {
    let line = base + stream.id;
    for (const p of properties) {
      line += ' | ' + p + ': ' + stream[p];
    }
    console.log(line);
    if (stream.children) {
      debug(stream.children, properties, myddepth);
    }
  }
};
