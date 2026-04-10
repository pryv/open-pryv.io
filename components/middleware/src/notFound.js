/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const errors = require('errors').factory;

/**
 * '404' handling to override Express' defaults. Must be set after the routes in the init sequence.
 */
module.exports = function (req, res, next) {
  return next(errors.unknownResource());
};
