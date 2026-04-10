/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');
const nconf = require('nconf');
const systemStreamsConfig = require('../../../../config/plugins/systemStreams');
const accountStreams = require('business/src/system-streams');
const { addCustomerPrefixToStreamId } = require('test-helpers/src/systemStreamFilters');
const treeUtils = require('utils/src/treeUtils');
const { defaults: dataStoreDefaults } = require('@pryv/datastore');
const PRIVATE_PREFIX = ':_system:';
const CUSTOMER_PREFIX = ':system:';

describe('[SSDC] SystemStreams config', () => {
  let store;
  const customRootStreamId = 'myNewStream';
  const DEFAULT_VALUES_FOR_FIELDS = {
    isIndexed: false,
    isUnique: false,
    isShown: true,
    isEditable: true,
    isRequiredInValidation: false,
    created: dataStoreDefaults.UnknownDate,
    modified: dataStoreDefaults.UnknownDate,
    createdBy: dataStoreDefaults.SystemAccessId,
    modifiedBy: dataStoreDefaults.SystemAccessId
  };
  after(async () => {
    await accountStreams.reloadForTests();
  });
  describe('[SD01] when valid custom systemStreams are provided', () => {
    let customStreams, customStreamIds;
    before(async () => {
      customStreams = {
        account: [
          {
            id: 'avs-number',
            isEditable: false,
            isShown: false,
            type: 'string/pryv'
          },
          {
            id: 'field-withchildren',
            name: 'field-withchildren',
            type: 'smth/string',
            children: [
              {
                id: 'child-one',
                type: 'string/pryv'
              },
              {
                id: 'child-two',
                type: 'string/pryv'
              }
            ]
          }
        ],
        other: [
          {
            id: customRootStreamId,
            type: 'identifier/string',
            children: [
              {
                id: 'field1',
                type: 'string/pryv'
              },
              {
                id: 'field2',
                type: 'string/pryv'
              }
            ]
          }
        ]
      };
      store = new nconf.Provider();
      store.use('memory');
      store.set('custom:systemStreams', customStreams);
      store.set('NODE_ENV', 'test');
      systemStreamsConfig.load(store);
      await accountStreams.reloadForTests(store);
      customStreamIds = treeUtils
        .flattenTree(customStreams.account)
        .concat(treeUtils.flattenTree(customStreams.other))
        .map((s) => addCustomerPrefixToStreamId(s.id));
    });
    it('[GB8G] must set default values and other fields', () => {
      const systemStreams = store.get('systemStreams');
      for (const streamId of customStreamIds) {
        const configStream = treeUtils.findById(customStreams.account, accountStreams.toFieldName(streamId)) ||
                    treeUtils.findById(customStreams.other, accountStreams.toFieldName(streamId));
        const systemStream = treeUtils.findById(systemStreams, streamId);
        for (const [key, value] of Object.entries(systemStream)) {
          if (configStream[key] == null && !isIgnoredKey(key)) {
            assert.equal(value, DEFAULT_VALUES_FOR_FIELDS[key], `${key} was supposed to be ${DEFAULT_VALUES_FOR_FIELDS[key]}, but is ${value} for stream "${systemStream.id}"`);
          } else if (key === 'name' && configStream.name == null) {
            assert.equal(systemStream.name, configStream.id);
          } else if (key === 'children') {
            if (configStream.children == null) {
              assert.deepEqual(value, []);
            }
          }
        }
      }
      function isIgnoredKey (key) {
        return ['name', 'parentId', 'children'].includes(key);
      }
    });
    it('[KMT3] must prefix default streams with the Pryv prefix', () => {
      [
        'account',
        'username',
        'language',
        'appId',
        'invitationToken',
        'referer',
        'storageUsed',
        'dbDocuments',
        'attachedFiles',
        'helpers',
        'active',
        'unique'
      ].forEach((streamId) => {
        assert.ok(treeUtils.findById(PRIVATE_PREFIX + streamId) != null);
      });
    });
    it('[PVDC] must prefix custom streams with the customer prefix', () => {
      [
        'field1',
        'username',
        'field-withchildren',
        'child-one',
        'child-two',
        customRootStreamId,
        'field2'
      ].forEach((streamId) => {
        assert.ok(treeUtils.findById(CUSTOMER_PREFIX + streamId) != null);
      });
    });
  });
  describe('[SD03] When custom system streams contain duplicate streamIds', () => {
    it('[CHEF] must throw a config error', () => {
      const streamId = 'field1';
      const customStreams = {
        account: [
          {
            id: streamId,
            type: 'string/pryv'
          }
        ],
        other: [
          {
            id: streamId,
            type: 'string/pryv'
          }
        ]
      };
      store = new nconf.Provider();
      store.use('memory');
      store.set('custom:systemStreams', customStreams);
      try {
        systemStreamsConfig.load(store);
        assert.fail('supposed to throw');
      } catch (err) {
        assert.ok(err.message.includes(`Config error: Custom system stream id duplicate. Remove duplicate custom system stream with streamId: "${streamId}".`));
      }
    });
  });
  describe('[SD04] When providing a custom system stream that is unique but not indexed', () => {
    it('[42A1] must throw a config error', () => {
      const store = new nconf.Provider();
      store.use('memory');
      store.set('custom:systemStreams:account', [
        {
          id: 'faulty-params',
          type: 'string/pryv',
          isIndexed: false,
          isUnique: true
        }
      ]);
      try {
        systemStreamsConfig.load(store);
        assert.fail('supposed to throw.');
      } catch (err) {
        assert.ok(err.message.includes('Config error: custom system stream cannot be unique and not indexed. Stream: '));
      }
    });
  });
  describe('[SD05] When providing a custom system stream that has an invalid type', () => {
    it.skip('[LU0A] must throw a config error', () => {
      const store = new nconf.Provider();
      store.use('memory');
      store.set('custom:systemStreams:account', [
        {
          id: 'faulty-type',
          type: 'hellow' // not supporting the (^[a-z0-9-]+/[a-z0-9-]+$) format
        }
      ]);
      try {
        systemStreamsConfig.load(store);
        assert.fail('supposed to throw.');
      } catch (err) {
        assert.ok(err.message.includes('Config error: custom system stream cannot be unique and not indexed. Stream: '));
      }
    });
  });
  describe('[SD06] When providing an "other" custom stream that is unique', () => {
    it('[GZEK] must throw a config error', async () => {
      const store = new nconf.Provider();
      store.use('memory');
      store.set('custom:systemStreams:other', [
        {
          id: 'faulty-params',
          type: 'string/pryv',
          isUnique: true
        }
      ]);
      try {
        systemStreamsConfig.load(store);
        assert.fail('supposed to throw.');
      } catch (err) {
        assert.ok(err.message.includes('Config error: custom "other" system stream cannot be unique. Only "account" streams can be unique. Stream: '));
      }
    });
  });
  describe('[SD07] When providing an "other" custom stream that is indexed', () => {
    it('[2IBL] must throw a config error', async () => {
      const store = new nconf.Provider();
      store.use('memory');
      store.set('custom:systemStreams:other', [
        {
          id: 'faulty-params',
          type: 'string/pryv',
          isIndexed: true
        }
      ]);
      try {
        systemStreamsConfig.load(store);
        assert.fail('supposed to throw.');
      } catch (err) {
        assert.ok(err.message.includes('Config error: custom "other" system stream cannot be indexed. Only "account" streams can be indexed. Stream: '));
      }
    });
  });
  describe('[SD08] When providing an "other" custom stream that is non editable', () => {
    it('[655X] must throw a config error', async () => {
      const store = new nconf.Provider();
      store.use('memory');
      store.set('custom:systemStreams:other', [
        {
          id: 'faulty-params',
          type: 'string/pryv',
          isEditable: false
        }
      ]);
      try {
        systemStreamsConfig.load(store);
        assert.fail('supposed to throw.');
      } catch (err) {
        assert.ok(err.message.includes('Config error: custom "other" system stream cannot be non-editable. Only "account" streams can be non-editable. Stream: '));
      }
    });
  });
  describe('[SD09] When providing an "other" custom stream that is required at registration', () => {
    it('[OJJ0] must throw a config error', async () => {
      const store = new nconf.Provider();
      store.use('memory');
      store.set('custom:systemStreams:other', [
        {
          id: 'faulty-params',
          type: 'string/pryv',
          isRequiredInValidation: true
        }
      ]);
      try {
        systemStreamsConfig.load(store);
        assert.fail('supposed to throw.');
      } catch (err) {
        assert.ok(err.message.includes('Config error: custom "other" system stream cannot be required at registration. Only "account" streams can be required at registration. Stream: '));
      }
    });
  });
});
