/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Mall component test helpers
 * Uses base helpers with minimal API methods needed
 */

const base = require('test-helpers/src/helpers-base');

base.init({
  // Only load methods needed for mall tests
  methods: ['events', 'streams', 'accesses']
});

exports.mochaHooks = base.getMochaHooks(false);
