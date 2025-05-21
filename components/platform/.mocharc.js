/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
 module.exports = {
  // as of 2022-03-28, extending another config doesn’t work (cf. https://github.com/mochajs/mocha/pull/4407),
  // so we have to duplicate settings in the root `.mocharc.js`
  // extends: '../../../.mocharc.js',
  exit: true,
  slow: 75,
  timeout: 2000,
  ui: 'bdd',
  diff: true,
  reporter: 'dot',
  require: 'test/helpers.js',
  spec: 'test/**/*.test.js'
};
