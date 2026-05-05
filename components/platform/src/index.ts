/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const platform = require('./Platform').default;

async function getPlatform () {
  return await platform.init();
}

export { platform, getPlatform };
