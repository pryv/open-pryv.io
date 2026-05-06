/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const path = require('path');
const fs = require('fs');
require('test-helpers');

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

export { fixturePath, fixtureFile };
