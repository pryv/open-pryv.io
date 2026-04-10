/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const { createConfig } = require('../../.mocharc.js');

module.exports = createConfig({
  timeout: 300000 // 5 minutes — lib-js tests take ~60s + server startup
});
