/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const Audit = require('./Audit.ts').default;
const audit = new Audit();

audit.CONSTANTS = require('./Constants.ts').default;

const CONSTANTS = audit.CONSTANTS;

export default audit;
export { audit, CONSTANTS };
