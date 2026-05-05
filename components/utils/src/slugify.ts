/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shallow wrapper around `slug` to ensure consistent usage.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const slug = require('slug');

slug.defaults.mode = 'rfc3986';
slug.defaults.modes.rfc3986.lower = false;
slug.extend({ _: '_' });

export { slug };
export default slug;
