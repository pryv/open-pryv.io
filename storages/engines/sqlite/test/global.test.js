/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const helpers = require('../../../test/helpers');
helpers.config = helpers.getEngineConfig('sqlite', require('../manifest.json'));

before(async function () {
  await helpers.dependencies.init();
});
