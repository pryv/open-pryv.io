/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type {} from 'node:fs';

const yaml = require('js-yaml');

exports.stringify = function (obj, options) {
  return yaml.dump(obj, options);
};

exports.parse = function (obj, options) {
  return yaml.load(obj, options);
};
