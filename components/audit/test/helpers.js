/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Audit component test helpers
 * Uses base helpers with audit-specific utilities
 */

const base = require('test-helpers/src/helpers-base');
const audit = require('../src/');
const { AuditAccessIds } = require('audit/src/MethodContextUtils');

// Audit-specific test utilities
function fakeAuditEvent (methodId) {
  const cuid = require('cuid');
  const charlatan = require('charlatan');
  return {
    createdBy: 'system',
    streamIds: [cuid()],
    type: 'log/test',
    content: {
      source: { name: 'http', ip: charlatan.Internet.IPv4() },
      action: methodId,
      query: {}
    }
  };
}

function addActionStreamIdPrefix (methodId) {
  return audit.CONSTANTS.STORE_PREFIX + audit.CONSTANTS.ACTION_STREAM_ID_PREFIX + methodId;
}

function addAccessStreamIdPrefix (accessId) {
  return audit.CONSTANTS.STORE_PREFIX + audit.CONSTANTS.ACCESS_STREAM_ID_PREFIX + accessId;
}

base.init({
  methods: ['events', 'streams', 'service', 'auth/login', 'auth/register', 'accesses'],
  beforeInitTests: async () => {
    // Barrel must be initialized before audit so that SQLite engine internals
    // (e.g. userLocalDirectory) are available when audit creates its storage.
    await require('storages').init();
    await audit.init();
    global.audit = audit;
  },
  afterInitCore: async () => {
    // Load audit-logs method
    require('audit/src/methods/audit-logs')(global.app.api);
  },
  globals: {
    apiMethods: require('audit/src/ApiMethods'),
    MethodContextUtils: require('audit/src/MethodContextUtils'),
    fakeAuditEvent,
    validation: require('audit/src/validation'),
    AuditFilter: require('audit/src/AuditFilter'),
    addActionStreamIdPrefix,
    addAccessStreamIdPrefix,
    CONSTANTS: audit.CONSTANTS,
    AuditAccessIds
  }
});

exports.mochaHooks = base.getMochaHooks(false);
