/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const Audit = require('./Audit');
const audit = new Audit();

audit.CONSTANTS = require('./Constants');

module.exports = audit;
