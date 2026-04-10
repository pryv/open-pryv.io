/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
// Express middleware that makes sure we have a continuation local storage
// context for each express request.
const cls = require('../cls');
/**
 * @param {express$Request} req
 * @param {express$Response} res
 * @param {express$NextFunction} next
 * @returns {any}
 */
function clsWrap (req, res, next) {
  return cls.startExpressContext(req, res, next);
}
/**
 * @returns {any}
 */
function factory () {
  return clsWrap;
}
module.exports = factory;
