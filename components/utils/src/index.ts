/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ApiEndpoint = require('./api-endpoint.ts');
const debug = require('./debug.ts');
const { deepMerge } = require('./deepMerge.ts');
const encryption = require('./encryption.ts');
const eventMatchQuery = require('./eventMatchQuery.ts');
const extension = require('./extension.ts');
const { fromCallback } = require('./fromCallback.ts');
const jsonValidator = require('./jsonValidator.ts').default;
const { slug: slugify } = require('./slugify.ts');
const { toString } = require('./toString.ts');
const treeUtils = require('./treeUtils.ts');

export { ApiEndpoint, debug, deepMerge, encryption, eventMatchQuery, extension, fromCallback, jsonValidator, slugify, toString, treeUtils };
export type { NormalizedCondition, ScalarValue, ConditionOp, StreamCondition, StreamGroup, EventToMatch, EventMatchQuery } from './eventMatchQuery.ts';
