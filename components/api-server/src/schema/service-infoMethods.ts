/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const serviceInfo = require('./service-info.ts').default;

const __ex_get = {
    params: null,
    result: serviceInfo()
  };
export { __ex_get as get };
