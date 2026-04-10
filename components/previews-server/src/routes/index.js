/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
module.exports = function index (expressApp) {
  expressApp.options('*', function (req, res /*, next */) {
    // common headers (e.g. CORS) are handled in related middleware
    res.sendStatus(200);
  });
};
