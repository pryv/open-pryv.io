
const headPath = require('../../api-server/src/routes/Paths').Register;
const wwwPath = require('../../api-server/src/routes/Paths').WWW;

const config = {
  'auth:authorizedKeys': {},
  'dns:domain': 'open-pryv.io',
  'appList': []
}

module.exports = {
  get: function(key) {
    return config[key];
  },
  loadSettings: function(settings) {
    config.service = settings.get('service').obj();
    let publicUrl = settings.get('dnsLess.publicUrl').str();
    if (publicUrl.slice(-1) === '/') publicUrl = publicUrl.slice(0, -1);
    config.publicUrl = publicUrl;
    config['access:trustedAuthUrls'] = [publicUrl];
    config['access:defaultAuthUrl'] = [publicUrl + wwwPath +'/access/access.html'];

    // load admin keys
    config.adminKey = settings.get('auth.adminAccessKey').str();
    if (config.adminKey) {
      config['auth:authorizedKeys'][config.adminKey] = { roles: ['admin'] }
    }
  }
}