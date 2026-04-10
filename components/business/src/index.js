/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
module.exports = {
  accesses: require('./accesses'),
  series: require('./series'),
  types: require('./types'),
  integrity: require('./integrity'),
  webhooks: {
    Webhook: require('./webhooks/Webhook'),
    Repository: require('./webhooks/repository')
  },
  users: require('./users'),
  MethodContext: require('./MethodContext')
};
