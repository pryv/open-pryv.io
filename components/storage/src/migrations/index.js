/**
 * Each migration must be:
 *
 * - Idempotent: results in the same state whether run once or multiple times
 * - Interruption-resistant: if interrupted, is able to proceed when run again
 */
module.exports = {
  '0.2.0': require('./0.2.0.js'),
  '0.3.0': require('./0.3.0.js'),
  '0.4.0': require('./0.4.0.js'),
  '0.5.0': require('./0.5.0.js'),
  '0.7.0': require('./0.7.0.js'),
  '0.7.1': require('./0.7.1.js'),
  '1.2.0': require('./1.2.0.js'),
  '1.2.5': require('./1.2.5.js'),
  '1.3.40': require('./1.3.40.js'),
  '1.4.0': require('./1.4.0.js'),
  '1.5.0': require('./1.5.0.js')
};
