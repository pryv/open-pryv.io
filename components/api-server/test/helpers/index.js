/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Extends the common test support object with server-specific stuff.
 */

// Spread test-helpers namespace into a mutable object so we can extend it
// with api-server-local helpers (Node 24 require(esm) returns a frozen namespace
// that can't be assigned to directly).
exports = module.exports = { ...require('test-helpers') };

exports.commonTests = require('./commonTests');
// override
exports.dependencies = require('./dependencies');
exports.validation = require('./validation');
exports.SourceStream = require('./SourceStream');
exports.passwordRules = require('./passwordRules');
