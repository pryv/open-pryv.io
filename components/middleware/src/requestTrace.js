'use strict'; 
// @flow

const morgan = require('morgan');

interface LoggerFactory {
  getLogger(name: string): Logger; 
}
interface Logger {
  info(msg: string): void; 
}

module.exports = function (express: any, logging: LoggerFactory) {
  const logger = logging.getLogger('routes');
  const morganLoggerStreamWrite = (msg: string) => logger.info(msg);
  
  return morgan('combined', {stream: {
    write: morganLoggerStreamWrite
  }});
};
module.exports.injectDependencies = true; // make it DI-friendly
