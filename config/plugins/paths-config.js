/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const path = require('path');

const varPryvFolder = path.join(__dirname, '../../var-pryv');

module.exports = {
  storages: {
    engines: {
      sqlite: {
        path: path.join(varPryvFolder, 'users')
      },
      filesystem: {
        attachmentsDirPath: path.join(varPryvFolder, 'attachments'),
        previewsDirPath: path.join(varPryvFolder, 'previews')
      },
      mongodb: {
        mongoFolder: path.join(varPryvFolder, 'mongodb-bin')
      }
    }
  },
  customExtensions: {
    defaultFolder: path.join(__dirname, '../../custom-extensions')
  }
};
