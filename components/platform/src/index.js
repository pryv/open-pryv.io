/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const platform = require('./Platform');

async function getPlatform () {
  return await platform.init();
}

module.exports = {
  platform,
  getPlatform
};
