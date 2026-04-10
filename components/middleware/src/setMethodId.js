/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const { initRootSpan } = require('tracing');
/**
 * Sets the methodId to the Request.context object of the Express stack
 */
module.exports = function (methodId) {
  return function setMethodId (req, res, next) {
    if (req.context == null) {
      const tracing = initRootSpan('express2');
      req.context = { tracing };
      res.on('finish', () => {
        tracing.finishSpan('express2', 'e2:' + methodId);
      });
    }
    req.context.methodId = methodId;
    next();
  };
};
