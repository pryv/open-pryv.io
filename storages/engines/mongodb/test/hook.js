/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

Object.assign(global, {
  assert: require('node:assert'),
  bluebird: require('bluebird'),
  _: require('lodash')
});
