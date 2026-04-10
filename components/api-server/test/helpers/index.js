/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Extends the common test support object with server-specific stuff.
 */

exports = module.exports = require('test-helpers');

exports.commonTests = require('./commonTests');
// override
exports.dependencies = require('./dependencies');
exports.validation = require('./validation');
exports.SourceStream = require('./SourceStream');
exports.passwordRules = require('./passwordRules');
