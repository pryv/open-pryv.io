/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
module.exports = {
  checkUserCore: require('./checkUserCore'),
  commonHeaders: require('./commonHeaders'),
  contentType: require('./contentType'),
  filesUploadSupport: require('./filesUploadSupport'),
  initContext: require('./initContext'),
  getAuth: require('./getAuth'),
  loadAccess: require('./loadAccess'),
  notFound: require('./notFound'),
  override: require('./override'),
  requestTrace: require('./requestTrace'),
  setMethodId: require('./setMethodId'),
  setMinimalMethodContext: require('./setMinimalMethodContext'),
  subdomainToPath: require('./subdomainToPath')
};
