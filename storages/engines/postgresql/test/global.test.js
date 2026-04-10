/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Skip PG engine tests when running in non-PG mode
const engine = process.env.STORAGE_ENGINE || '';
if (engine !== 'postgresql') {
  before(function () { this.skip(); });
} else {
  const helpers = require('../../../test/helpers');
  helpers.config = helpers.getEngineConfig('postgresql', require('../manifest.json'));

  before(async function () {
    await helpers.dependencies.init();
    // Set up getLogger on _internals so DatabasePG can create loggers
    const _internals = require('../src/_internals');
    if (!_internals.getLogger) {
      _internals.getLogger = helpers.getLogger;
    }
  });
}
