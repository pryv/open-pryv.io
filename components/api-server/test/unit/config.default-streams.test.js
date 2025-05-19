/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
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

const chai = require('chai');
const nconf = require('nconf');
const assert = chai.assert;
const systemStreamsConfig = require('api-server/config/components/systemStreams');
const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const treeUtils = require('utils/src/treeUtils');
const { defaults: dataStoreDefaults } = require('@pryv/datastore');
const PRIVATE_PREFIX = ':_system:';
const CUSTOMER_PREFIX = ':system:';

describe('[SSDC] SystemStreams config', () => {
  let store;
  const customRootStreamId = 'myNewStream';
  const DEFAULT_VALUES_FOR_FIELDS = {
    [systemStreamsConfig.features.IS_INDEXED]: false,
    [systemStreamsConfig.features.IS_UNIQUE]: false,
    [systemStreamsConfig.features.IS_SHOWN]: true,
    [systemStreamsConfig.features.IS_EDITABLE]: true,
    [systemStreamsConfig.features.IS_REQUIRED_IN_VALIDATION]: false,
    created: dataStoreDefaults.UnknownDate,
    modified: dataStoreDefaults.UnknownDate,
    createdBy: dataStoreDefaults.SystemAccessId,
    modifiedBy: dataStoreDefaults.SystemAccessId
  };
  after(async () => {
    await SystemStreamsSerializer.reloadSerializer();
  });
  describe('when valid custom systemStreams are provided', () => {
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
      await SystemStreamsSerializer.reloadSerializer(store);
      customStreamIds = treeUtils
        .flattenTree(customStreams.account)
        .concat(treeUtils.flattenTree(customStreams.other))
        .map((s) => SystemStreamsSerializer.addCustomerPrefixToStreamId(s.id));
    });
    it('[GB8G] must set default values and other fields', () => {
      const systemStreams = store.get('systemStreams');
      for (const streamId of customStreamIds) {
        const configStream = treeUtils.findById(customStreams.account, SystemStreamsSerializer.removePrefixFromStreamId(streamId)) ||
                    treeUtils.findById(customStreams.other, SystemStreamsSerializer.removePrefixFromStreamId(streamId));
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
        assert.exists(treeUtils.findById(PRIVATE_PREFIX + streamId));
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
        assert.exists(treeUtils.findById(CUSTOMER_PREFIX + streamId));
      });
    });
  });
  describe('When retro-compatibility is activated and a streamId unicity conflict exists between a custom system streamId and a default one', () => {
    it('[3Z9N] must throw a config error', () => {
      const streamId = 'language';
      const customStreams = {
        account: [
          {
            id: streamId,
            type: 'string/pryv'
          }
        ],
        other: []
      };
      store = new nconf.Provider();
      store.use('memory');
      store.set('custom:systemStreams', customStreams);
      store.set('backwardCompatibility:systemStreams:prefix:isActive', true);
      try {
        systemStreamsConfig.load(store);
        assert.fail('supposed to throw');
      } catch (err) {
        assert.include(err.message, `Config error: Custom system stream id unicity collision with default one. Deactivate retro-compatibility prefix or change streamId: "${streamId}".`);
      }
    });
  });
  describe('When custom system streams contain duplicate streamIds', () => {
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
        assert.include(err.message, `Config error: Custom system stream id duplicate. Remove duplicate custom system stream with streamId: "${streamId}".`);
      }
    });
  });
  describe('When providing a custom system stream that is unique but not indexed', () => {
    it('[42A1] must throw a config error', () => {
      const store = new nconf.Provider();
      store.use('memory');
      store.set('custom:systemStreams:account', [
        {
          id: 'faulty-params',
          type: 'string/pryv',
          [systemStreamsConfig.features.IS_INDEXED]: false,
          [systemStreamsConfig.features.IS_UNIQUE]: true
        }
      ]);
      try {
        systemStreamsConfig.load(store);
        assert.fail('supposed to throw.');
      } catch (err) {
        assert.include(err.message, 'Config error: custom system stream cannot be unique and not indexed. Stream: ');
      }
    });
  });
  describe('When providing a custom system stream that has an invalid type', () => {
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
        assert.include(err.message, 'Config error: custom system stream cannot be unique and not indexed. Stream: ');
      }
    });
  });
  describe('When providing an "other" custom stream that is unique', () => {
    it('[GZEK] must throw a config error', async () => {
      const store = new nconf.Provider();
      store.use('memory');
      store.set('custom:systemStreams:other', [
        {
          id: 'faulty-params',
          type: 'string/pryv',
          [systemStreamsConfig.features.IS_UNIQUE]: true
        }
      ]);
      try {
        systemStreamsConfig.load(store);
        assert.fail('supposed to throw.');
      } catch (err) {
        assert.include(err.message, 'Config error: custom "other" system stream cannot be unique. Only "account" streams can be unique. Stream: ');
      }
    });
  });
  describe('When providing an "other" custom stream that is indexed', () => {
    it('[2IBL] must throw a config error', async () => {
      const store = new nconf.Provider();
      store.use('memory');
      store.set('custom:systemStreams:other', [
        {
          id: 'faulty-params',
          type: 'string/pryv',
          [systemStreamsConfig.features.IS_INDEXED]: true
        }
      ]);
      try {
        systemStreamsConfig.load(store);
        assert.fail('supposed to throw.');
      } catch (err) {
        assert.include(err.message, 'Config error: custom "other" system stream cannot be indexed. Only "account" streams can be indexed. Stream: ');
      }
    });
  });
  describe('When providing an "other" custom stream that is non editable', () => {
    it('[655X] must throw a config error', async () => {
      const store = new nconf.Provider();
      store.use('memory');
      store.set('custom:systemStreams:other', [
        {
          id: 'faulty-params',
          type: 'string/pryv',
          [systemStreamsConfig.features.IS_EDITABLE]: false
        }
      ]);
      try {
        systemStreamsConfig.load(store);
        assert.fail('supposed to throw.');
      } catch (err) {
        assert.include(err.message, 'Config error: custom "other" system stream cannot be non-editable. Only "account" streams can be non-editable. Stream: ');
      }
    });
  });
  describe('When providing an "other" custom stream that is required at registration', () => {
    it('[OJJ0] must throw a config error', async () => {
      const store = new nconf.Provider();
      store.use('memory');
      store.set('custom:systemStreams:other', [
        {
          id: 'faulty-params',
          type: 'string/pryv',
          [systemStreamsConfig.features.IS_REQUIRED_IN_VALIDATION]: true
        }
      ]);
      try {
        systemStreamsConfig.load(store);
        assert.fail('supposed to throw.');
      } catch (err) {
        assert.include(err.message, 'Config error: custom "other" system stream cannot be required at registration. Only "account" streams can be required at registration. Stream: ');
      }
    });
  });
});
