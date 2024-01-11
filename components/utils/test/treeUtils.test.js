/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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

const treeUtils = require('../src/treeUtils');
const should = require('should'); // explicit require to benefit from static functions

describe('tree utils', function () {
  const testArray = [
    {
      id: 'root-1',
      parentId: null,
      someProperty: false
    },
    {
      id: 'child-1.1',
      parentId: 'root-1',
      someProperty: false
    },
    {
      id: 'child-1.1.1',
      parentId: 'child-1.1',
      someProperty: false
    },
    {
      id: 'child-1.2',
      parentId: 'root-1',
      someProperty: true
    },
    {
      id: 'root-2',
      parentId: null,
      someProperty: true
    },
    {
      id: 'child-2.1',
      parentId: 'root-2',
      someProperty: false
    }
  ];

  const testTree = [
    {
      id: 'root-1',
      someProperty: false,
      children: [
        {
          id: 'child-1.1',
          someProperty: false,
          children: [
            {
              id: 'child-1.1.1',
              someProperty: false,
              children: []
            }
          ]
        },
        {
          id: 'child-1.2',
          someProperty: true,
          children: []
        }
      ]
    },
    {
      id: 'root-2',
      someProperty: true,
      children: [
        {
          id: 'child-2.1',
          someProperty: false,
          children: []
        }
      ]
    }
  ];

  const invalidArray = [
    {
      badId: 'x'
    }
  ];

  describe('buildTree()', function () {
    it('[32CB] must build a correct tree for a given consistent array', function () {
      const res = treeUtils.buildTree(testArray, true /* strip parent ids */);
      res.should.eql(testTree);
      should.notStrictEqual(res[0], testArray[0], 'should not return the original objects but copies instead');
    });

    it('[VVVS] must throw an error if objects do not contain the necessary properties', function () {
      (function () { treeUtils.buildTree(invalidArray); }).should.throw();
    });

    it('[CEUF] must throw an error if the object in argument is not an array', function () {
      (function () { treeUtils.buildTree(testArray[0]); }).should.throw();
    });
  });

  describe('flattenTree()', function () {
    it('[11JJ] must build a correct array for a given tree', function () {
      const res = treeUtils.flattenTree(testTree);
      res.should.eql(testArray);
      should.notStrictEqual(res[0], testTree[0], 'should not return the original objects but copies instead');
    });

    it('[OVJM] must throw an error if the object in argument is not an array', function () {
      (function () { treeUtils.flattenTree(testTree[0]); }).should.throw();
    });
  });

  describe('findInTree()', function () {
    it('[S1N0] must return the first item matching the given iterator function', function () {
      const foundItem = treeUtils.findInTree(testTree, function (item) {
        return item.someProperty === true;
      });
      should.strictEqual(foundItem, testTree[0].children[1]);
    });

    it('[SI6L] must return null if no item matches the given iterator function', function () {
      const foundItem = treeUtils.findInTree(testTree, function (item) {
        return item.someProperty === 'missing value';
      });
      should.not.exist(foundItem);
    });
  });

  describe('filterTree()', function () {
    it('[YIE6] must return only items matching the given iterator function', function () {
      const filteredTree = treeUtils.filterTree(testTree, true /* keep orphans */, function (item) {
        return item.someProperty === false;
      });
      const expected = [
        {
          id: 'root-1',
          someProperty: false,
          children: [
            {
              id: 'child-1.1',
              someProperty: false,
              children: [
                {
                  id: 'child-1.1.1',
                  someProperty: false,
                  children: []
                }
              ]
            }
          ]
        },
        {
          id: 'child-2.1',
          someProperty: false,
          children: []
        }
      ];
      filteredTree.should.eql(expected);
      should.notStrictEqual(filteredTree[0], testTree[0], 'should not return the original objects but copies instead');
    });
  });

  describe('collect()', function () {
    it('[AU44] must return an array with values matching the iterator function for each item in the tree',
      function () {
        const ids = treeUtils.collect(testTree, function (item) {
          return item.id;
        });

        const expected = testArray.map(function (item) {
          return item.id;
        });
        ids.should.eql(expected);
      });
  });

  describe('expandIds()', function () {
    it('[PFJP] must return an array with the ids passed in argument plus those of all their descendants',
      function () {
        treeUtils.expandIds(testTree, ['root-1']).should.eql([
          'root-1', 'child-1.1', 'child-1.1.1', 'child-1.2'
        ]);
      });
  });
});
