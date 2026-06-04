/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const yaml = require('js-yaml');

// js-yaml ships no type declarations in this install, so its DumpOptions /
// LoadOptions aren't importable — options is the structural pass-through bag.
function stringify (obj: unknown, options?: Record<string, unknown>): string {
  return yaml.dump(obj, options);
}

function parse (obj: string, options?: Record<string, unknown>): unknown {
  return yaml.load(obj, options);
}

export { stringify, parse };
