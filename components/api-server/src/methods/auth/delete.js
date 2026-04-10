/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const Deletion = require('business/src/auth/deletion');
const { getStorageLayer } = require('storage');
const { getLogger, getConfig } = require('@pryv/boiler');
/**
 * Auth API methods implementations.
 *
 * @param api
 * @param userAccessesStorage
 * @param sessionsStorage
 * @param authSettings
 */
module.exports = async function (api) {
  const config = await getConfig();
  const logging = getLogger('delete');
  const storageLayer = await getStorageLayer();
  const deletion = new Deletion(logging, storageLayer, config);
  api.register(
    'auth.delete',
    deletion.checkIfAuthorized.bind(deletion),
    deletion.validateUserExists.bind(deletion),
    deletion.validateUserFilepaths.bind(deletion),
    deletion.deleteUserFiles.bind(deletion),
    deletion.deleteHFData.bind(deletion),
    deletion.deleteAuditData.bind(deletion),
    deletion.deleteUser.bind(deletion));
};
