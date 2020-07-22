const serviceInfo = require('./service-info');

module.exports = {
  get: {
    params: null,
    result: serviceInfo()
  }
};