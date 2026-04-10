/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const _ = require('lodash');
const { getConfig } = require('@pryv/boiler');
module.exports = function (api) {
  this.serviceInfo = null;
  api.register('service.info', getServiceInfo);
  async function getServiceInfo (context, params, result, next) {
    if (!this.serviceInfo) {
      this.serviceInfo = (await getConfig()).get('service');
    }
    result = _.merge(result, this.serviceInfo);
    return next();
  }
};
