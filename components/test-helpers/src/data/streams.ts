/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from "node:fs";

const timestamp = require('unix-timestamp');

module.exports = [
  {
    id: 's_0',
    name: 'Root Stream 0',
    parentId: null,
    created: timestamp.now(),
    createdBy: 'test',
    modified: timestamp.now(),
    modifiedBy: 'test',
    children: [
      {
        id: 's_0_0',
        name: 'Child Stream 0.0',
        parentId: 's_0',
        created: timestamp.now(),
        createdBy: 'test',
        modified: timestamp.now(),
        modifiedBy: 'test',
        children: []
      },
      {
        id: 's_0_1',
        name: 'Child Stream 0.1',
        parentId: 's_0',
        created: timestamp.now(),
        createdBy: 'test',
        modified: timestamp.now(),
        modifiedBy: 'test',
        children: []
      }
    ]
  },
  {
    id: 's_1',
    name: 'Root Stream 1',
    parentId: null,
    clientData: {
      stringProp: 'O Brother',
      numberProp: 1
    },
    created: timestamp.now(),
    createdBy: 'test',
    modified: timestamp.now(),
    modifiedBy: 'test',
    children: [
      {
        id: 's_1_0',
        name: 'Child Stream 1.0',
        parentId: 's_1',
        created: timestamp.now(),
        createdBy: 'test',
        modified: timestamp.now(),
        modifiedBy: 'test',
        children: []
      }
    ]
  },
  {
    id: 's_2',
    name: 'Root Stream 2',
    parentId: null,
    created: timestamp.now(),
    createdBy: 'test',
    modified: timestamp.now(),
    modifiedBy: 'test',
    children: [
      {
        id: 's_2_0',
        name: 'Child Stream 2.0 (trashed)',
        parentId: 's_2',
        trashed: true,
        created: timestamp.now(),
        createdBy: 'test',
        modified: timestamp.now(),
        modifiedBy: 'test',
        children: [
          {
            id: 's_2_0_0',
            name: 'Child Stream 2.0.0',
            parentId: 's_2_0',
            created: timestamp.now(),
            createdBy: 'test',
            modified: timestamp.now(),
            modifiedBy: 'test',
            children: []
          }
        ]
      },
      {
        id: 's_2_1',
        name: 'Child Stream 2.1',
        parentId: 's_2',
        created: timestamp.now(),
        createdBy: 'test',
        modified: timestamp.now(),
        modifiedBy: 'test',
        children: [
          {
            id: 's_2_1_0',
            name: 'Child Stream 2.1.0',
            parentId: 's_2_1',
            created: timestamp.now(),
            createdBy: 'test',
            modified: timestamp.now(),
            modifiedBy: 'test',
            children: []
          }
        ]
      }
    ]
  },
  {
    id: 's_3',
    name: 'Root Stream 3 (trashed)',
    parentId: null,
    trashed: true,
    created: timestamp.now(),
    createdBy: 'test',
    modified: timestamp.now(),
    modifiedBy: 'test',
    children: [
      {
        id: 's_3_0',
        name: 'Child Stream 3.0',
        parentId: 's_3',
        created: timestamp.now(),
        createdBy: 'test',
        modified: timestamp.now(),
        modifiedBy: 'test',
        children: []
      }
    ]
  },
  // deletions
  {
    id: 's_4',
    deleted: timestamp.now('-5m')
  },
  {
    id: 's_5',
    deleted: timestamp.now('-1d')
  },
  {
    id: 's_6',
    deleted: timestamp.now('-2y') // to be cleaned up by Mongo TTL
  },
  // auditing
  {
    id: 's_7',
    name: 'Root Stream 7 - for auditing',
    parentId: null,
    created: timestamp.now('-10h'),
    createdBy: 'test',
    modified: timestamp.now('-10h'),
    modifiedBy: 'test',
    children: [
      {
        id: 's_7_0',
        name: 'Child Stream 7.0, event is trashed, used for merge on delete',
        parentId: 's_7',
        trashed: true,
        created: timestamp.now(),
        createdBy: 'test',
        modified: timestamp.now(),
        modifiedBy: 'test',
        children: []
      }
    ]
  },
  {
    id: 's_8',
    name: 'Root Stream 8 - for auditing',
    parentId: null,
    created: timestamp.now('-10h'),
    createdBy: 'test',
    modified: timestamp.now('-10h'),
    modifiedBy: 'test',
    children: []
  }
];
