/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Cache component test helpers
 * Uses base helpers with cache module added to globals
 */

const base = require('test-helpers/src/helpers-base');
const cache = require('cache');

base.init({
  methods: ['events', 'streams', 'service', 'auth/login', 'auth/register', 'accesses'],
  globals: { cache }
});

exports.mochaHooks = base.getMochaHooks(false);
