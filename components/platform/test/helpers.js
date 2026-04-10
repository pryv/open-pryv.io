/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Platform component test helpers
 * Uses base helpers - platform tests are mostly unit tests
 */

const base = require('test-helpers/src/helpers-base');

base.init({
  methods: [] // Platform tests don't need API methods
});

exports.mochaHooks = base.getMochaHooks(false);
