// @flow

import type { MethodContext } from 'components/model';
import type API from '../API';
import type { ApiCallback } from '../API';
import type Result from '../Result';
import type { Logger } from 'components/utils';
import type { ConfigAccess } from '../settings';

const _ = require('lodash');

module.exports = function (api: API, logger: Logger, settings: ConfigAccess) {
  this.serviceInfo = null;

  api.register('service.info',
    getServiceInfo
  );

  async function getServiceInfo(context: MethodContext, params: mixed, result: Result, next: ApiCallback) {  
    if (! this.serviceInfo) {
      this.serviceInfo = await settings.get('service').obj();
    }   
    result = _.merge(result, this.serviceInfo);
    return next();

  }
};
