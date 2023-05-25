/**
 * @license
 * Copyright (C) 2012-2022 Pryv S.A. https://pryv.com - All Rights Reserved
 * Unauthorized copying of this file, via any medium is strictly prohibited
 * Proprietary and confidential
 */
module.exports = {
  // as of 2022-03-28, extending another config doesn’t work (cf. https://github.com/mochajs/mocha/pull/4407),
  // so we have to duplicate settings in the root `.mocharc.js`
  // extends: '../../../.mocharc.js',
  exit: true,
  slow: 20,
  timeout: 10000,
  ui: 'bdd',
  diff: true,
  reporter: 'dot',
  spec: 'test/**/*.test.js'
};
