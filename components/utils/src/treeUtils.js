/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
 * 
 */
/**
 * Helper methods for handling tree object structures.
 * Here 'tree' means a recursive array of objects with a 'children' property.
 */

var _ = require('lodash');

/**
 * Items whose parent id refer to an item absent from the array are filtered out.
 * Items with no parent id are just left as they are.
 *
 * @param {Boolean} stripParentIds Optional, default: false
 */
exports.buildTree = function (array, stripParentIds) {
  if (! _.isArray(array)) {
    throw new Error('Invalid argument: expected an array');
  }

  var map = {};
  array.forEach(function (item) {
    verifyFlatItem(item);

    var clone = _.clone(item);
    if (item.hasOwnProperty('parentId')) {
      clone.children = [];
    }
    map[item.id] = clone;
  });

  var result = [];
  array.forEach(function (item) {
    var clone = map[item.id];

    if (clone.hasOwnProperty('parentId') && clone.parentId) {
      // child
      if (! map[clone.parentId]) {
        // missing parent -> ignore
        return;
      }
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

function verifyFlatItem(item) {
  if (! item.hasOwnProperty('id')) {
    throw new Error('Invalid object structure: expected property "id"');
  }
}

exports.flattenTreeWithoutParents = function (array) {
  if (!_.isArray(array)) {
    throw new Error('Invalid argument: expected an array');
  }

  var result = [];
  flattenRecursiveWithoutParents(array, null, result);
  return result;
};

function flattenRecursiveWithoutParents (originalArray, parentId, resultArray) {
  originalArray.forEach(function (item) {
    var clone = _.clone(item);

    clone.parentId = parentId;
    if (clone.hasOwnProperty('children')) {
      flattenRecursive(clone.children, clone.id, resultArray);
      delete clone.children;
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
  if (!_.isObject(object)) {
    throw new Error('Invalid argument: expected an object');
  }

  var result = [];
  flattenRecursiveSimpleObject(object, result);
  return result;
};

function flattenRecursiveSimpleObject (originalObject, resultArray: []): void {
  Object.keys(originalObject).forEach(function (key) {
    var value = _.clone(originalObject[key]);
    if (typeof value == 'object') {
      flattenRecursiveSimpleObject(value, resultArray);
    } else {
      resultArray[key] = value;
    }
  });
}

exports.flattenTree = function (array) {
  if (! _.isArray(array)) {
    throw new Error('Invalid argument: expected an array');
  }

  var result = [];
  flattenRecursive(array, null, result);
  return result;
};

function flattenRecursive(originalArray, parentId, resultArray) {
  originalArray.forEach(function (item) {
    var clone = _.clone(item);

    clone.parentId = parentId;
    resultArray.push(clone);
    if (clone.hasOwnProperty('children')) {
      flattenRecursive(clone.children, clone.id, resultArray);
      delete clone.children;
    }
  });
}

var findById = exports.findById = function (array, id) {
  return findInTree(array, function (item) {
    return item.id === id;
  });
};

/**
 * @param {Function} iterator Arguments: ({Object}), return value: {Boolean}
 */
var findInTree = exports.findInTree = function (array, iterator) {
  for (var i = 0, n = array.length; i < n; i++) {
    var item = array[i];
    // check if item matches
    if (iterator(item)) {
      return item;
    }
    // if not check its children if any
    if (item.hasOwnProperty('children')) {
      var childrenFind = findInTree(item.children, iterator);
      if (childrenFind) {
        return childrenFind;
      }
    }
  }
  // not found
  return null;
};

/**
 * @param {Boolean} keepOrphans Whether to take into account the children of filtered-out items
 *                              (if yes, the tree structure may be modified)
 * @param {Function} iterator Arguments: ({Object}), return value: {Boolean}
 */
var filterTree = exports.filterTree = function (array, keepOrphans, iterator) {
  var filteredArray = [];

  for (var i = 0, n = array.length; i < n; i++) {
    var item = array[i];
    if (iterator(item)) {
      var clone = _.clone(item);
      filteredArray.push(clone);
      if (clone.hasOwnProperty('children')) {
        clone.children = filterTree(clone.children, keepOrphans, iterator);
      }
    } else if (item.hasOwnProperty('children') && keepOrphans) {
      filteredArray.push.apply(filteredArray, filterTree(item.children, keepOrphans, iterator));
    }
  }

  return filteredArray;
};

var collect = exports.collect = function (array, iterator) {
  if (! _.isArray(array)) {
    throw new Error('Invalid argument: expected an array');
  }

  var result = [];
  collectRecursive(array, result, iterator);
  return result;
};

var collectFromRootItem = exports.collectFromRootItem = function (item, iterator) {
  if (_.isArray(item)) {
    throw new Error('Invalid argument: expected a single item');
  }

  var result = [ iterator(item) ];
  collectRecursive(item.children, result, iterator);
  return result;
};

function collectRecursive(originalArray, resultArray, iterator) {
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

var collectPluckFromRootItem = exports.collectPluckFromRootItem = function (item, propertyName) {
  return collectFromRootItem(item, function (item) {
    return item[propertyName];
  });
};

/**
 * Returns an array with the given ids plus those of their descendants, excluding unknown ids but
 * including `null` if present.
 *
 * @param {Array} ids
 */
exports.expandIds = function (array, ids) {
  var expandedIds = [];
  ids.forEach(function (id) {
    var currentExpIds;
    if (id === null) {
      // just keep it
      currentExpIds = [null];
    } else {
      var item = findById(array, id);
      if (! item) {
        return;
      }
      currentExpIds = collectPluckFromRootItem(item, 'id');
    }
    expandedIds.push.apply(expandedIds, currentExpIds);
  });
  return expandedIds;
};
