/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const yaml = require('js-yaml');

function stringify (obj: any, options: any) {
  return yaml.dump(obj, options);
}

function parse (obj: any, options: any) {
  return yaml.load(obj, options);
}

export { stringify, parse };
