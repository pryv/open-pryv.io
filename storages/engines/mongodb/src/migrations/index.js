/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Each migration must be:
 *
 * - Idempotent: results in the same state whether run once or multiple times
 * - Interruption-resistant: if interrupted, is able to proceed when run again
 */
module.exports = {
  '1.9.0': require('./1.9.0'),
  '1.9.2': require('./1.9.2'),
  '1.9.3': require('./1.9.3'),
  '1.9.4': require('./1.9.4')
};
