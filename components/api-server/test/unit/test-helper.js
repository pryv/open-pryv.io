/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const path = require('path');
const fs = require('fs');
const lodash = require('lodash');
const toplevel = require('test-helpers');
module.exports = lodash.merge({}, toplevel, {
  fixturePath,
  fixtureFile
});
/**
 * @param {Array<string>} parts
 * @returns {string}
 */
function fixturePath (...parts) {
  return path.join(__dirname, '../fixtures', ...parts).normalize();
}
/**
 * @param {Array<string>} parts
 * @returns {Buffer}
 */
function fixtureFile (...parts) {
  return fs.readFileSync(fixturePath(...parts));
}
