/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
'use strict';
// Helper methods and setup for all unit tests.
const assert = require('node:assert');
const superagent = require('superagent');
const request = require('supertest');
require('test-helpers/src/api-server-tests-config');
module.exports = {
  assert,
  superagent,
  request
};
