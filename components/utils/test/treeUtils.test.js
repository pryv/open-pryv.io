/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const treeUtils = require('../src/treeUtils');
const assert = require('node:assert');

describe('[TRUT] tree utils', function () {
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

  describe('[TU01] buildTree()', function () {
    it('[32CB] must build a correct tree for a given consistent array', function () {
      const res = treeUtils.buildTree(testArray, true /* strip parent ids */);
      assert.deepStrictEqual(res, testTree);
      assert.notStrictEqual(res[0], testArray[0], 'should not return the original objects but copies instead');
    });

    it('[VVVS] must throw an error if objects do not contain the necessary properties', function () {
      assert.throws(() => { treeUtils.buildTree(invalidArray); });
    });

    it('[CEUF] must throw an error if the object in argument is not an array', function () {
      assert.throws(() => { treeUtils.buildTree(testArray[0]); });
    });
  });

  describe('[TU02] flattenTree()', function () {
    it('[11JJ] must build a correct array for a given tree', function () {
      const res = treeUtils.flattenTree(testTree);
      assert.deepStrictEqual(res, testArray);
      assert.notStrictEqual(res[0], testTree[0], 'should not return the original objects but copies instead');
    });

    it('[OVJM] must throw an error if the object in argument is not an array', function () {
      assert.throws(() => { treeUtils.flattenTree(testTree[0]); });
    });
  });

  describe('[TU03] findInTree()', function () {
    it('[S1N0] must return the first item matching the given iterator function', function () {
      const foundItem = treeUtils.findInTree(testTree, function (item) {
        return item.someProperty === true;
      });
      assert.strictEqual(foundItem, testTree[0].children[1]);
    });

    it('[SI6L] must return null if no item matches the given iterator function', function () {
      const foundItem = treeUtils.findInTree(testTree, function (item) {
        return item.someProperty === 'missing value';
      });
      assert.strictEqual(foundItem, null);
    });
  });

  describe('[TU04] filterTree()', function () {
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
      assert.deepStrictEqual(filteredTree, expected);
      assert.notStrictEqual(filteredTree[0], testTree[0], 'should not return the original objects but copies instead');
    });
  });

  describe('[TU05] collect()', function () {
    it('[AU44] must return an array with values matching the iterator function for each item in the tree',
      function () {
        const ids = treeUtils.collect(testTree, function (item) {
          return item.id;
        });

        const expected = testArray.map(function (item) {
          return item.id;
        });
        assert.deepStrictEqual(ids, expected);
      });
  });

  describe('[TU06] expandIds()', function () {
    it('[PFJP] must return an array with the ids passed in argument plus those of all their descendants',
      function () {
        assert.deepStrictEqual(treeUtils.expandIds(testTree, ['root-1']), [
          'root-1', 'child-1.1', 'child-1.1.1', 'child-1.2'
        ]);
      });
  });
});
