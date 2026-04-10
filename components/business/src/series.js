/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const batchRequest = require('./series/batch_request');
module.exports = {
  Repository: require('./series/repository'),
  BatchRequest: batchRequest.BatchRequest,
  DataMatrix: require('./series/data_matrix'),
  ParseFailure: require('./series/errors').ParseFailure
};
