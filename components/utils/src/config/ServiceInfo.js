
const request = require('superagent');
const fs = require('fs');
const url = require('url');
const path = require('path');

const regPath = require('components/api-server/src/routes/Paths').Register;
const wwwPath = require('components/api-server/src/routes/Paths').WWW;

let serviceInfo = {};

const FILE_PROTOCOL = 'file://';
const FILE_PROTOCOL_LENGTH = FILE_PROTOCOL.length;
const SERVICE_INFO_PATH = '/service/info';
const REGISTER_URL_CONFIG = 'services.register.url';
const SERVICE_INFO_URL_CONFIG = 'serviceInfoUrl';
const DNS_LESS_VERSION_CONFIG = 'dnsLess.isActive'; 
const DNS_LESS_PUBLIC_URL_CONFIG = 'dnsLess.publicUrl';

class ServiceInfo {

  static async loadFromUrl(serviceInfoUrl) {
    if (serviceInfo[serviceInfoUrl]) return serviceInfo[serviceInfoUrl];

    if (isFileUrl(serviceInfoUrl)) {
      const filePath = stripFileProtocol(serviceInfoUrl);
      
      if (isRelativePath(filePath)) {
        const serviceCorePath = path.resolve(__dirname, '../../../../../');
        serviceInfoUrl = path.resolve(serviceCorePath, filePath);
        serviceInfoUrl = 'file://' + serviceInfoUrl;
      } else {
        // absolute path, do nothing.
      }
    }
    if (process.env.NODE_ENV !== 'test')
      console.info('Fetching serviceInfo from: ' + serviceInfoUrl);
    if (serviceInfoUrl == null) {
      console.error('Parameter "serviceInfoUrl" is undefined, set it in the configuration to allow core to provide service info');
      process.exit(2);
      return null;
    }
    let result = null;
    try {
      if (isFileUrl(serviceInfoUrl)) {
        result = JSON.parse(fs.readFileSync(stripFileProtocol(serviceInfoUrl), 'utf8'));
      } else {
        const res = await request.get(serviceInfoUrl);
        result = res.body;
      }
    } catch (error) {
      console.error('Failed fetching "serviceInfoUrl" ' + serviceInfoUrl + ' with error' + error.message);
      process.exit(2);
      return null;
    }
    serviceInfo[serviceInfoUrl] = result;
    return serviceInfo[serviceInfoUrl];
  }

  static async addToConvict(convictInstance) {

    let isDnsLess = convictInstance.get(DNS_LESS_VERSION_CONFIG);
    if (isDnsLess) {
      const dnsLessPublicUrl = convictInstance.get(DNS_LESS_PUBLIC_URL_CONFIG);
      if (dnsLessPublicUrl.slice(-1) === '/') dnsLessPublicUrl = dnsLessPublicUrl.slice(0, -1);
      convictInstance.set('service.serial', 't' + Math.round(Date.now() / 1000));
      convictInstance.set('service.api', dnsLessPublicUrl + '/{username}/');
      convictInstance.set('service.register', dnsLessPublicUrl + regPath + '/');
      convictInstance.set('service.access', dnsLessPublicUrl + regPath + '/access/');
      convictInstance.set('service.assets', {
        definitions: dnsLessPublicUrl + wwwPath + '/assets/index.json',
      });
      return;
    }

    // -- from url
    let serviceInfoUrl;
    try {
      serviceInfoUrl = convictInstance.get(SERVICE_INFO_URL_CONFIG);
      // HACK: in tests, convictInstance is convict(), with bin/server it is hfs/src/config
      serviceInfoUrl = serviceInfoUrl.value || serviceInfoUrl;
    } catch (e) {
      console.info(SERVICE_INFO_URL_CONFIG + ' not provided. Falling back to ' + REGISTER_URL_CONFIG);
    }
    if (serviceInfoUrl == null) {
      try {
        serviceInfoUrl = convictInstance.get(REGISTER_URL_CONFIG);
        // HACK: in tests, convictInstance is convict(), with bin/server it is hfs/src/config
        serviceInfoUrl = serviceInfoUrl.value || serviceInfoUrl;
        serviceInfoUrl = url.resolve(serviceInfoUrl, SERVICE_INFO_PATH);
      } catch (e) {
        console.error('Configuration error: ' + REGISTER_URL_CONFIG + 
        ' not provided. Please provide either ' + REGISTER_URL_CONFIG + 
        ' or ' + SERVICE_INFO_URL_CONFIG + ' to boot service.');
      }
    }
    const serviceInfo = await ServiceInfo.loadFromUrl(serviceInfoUrl);
    convictInstance.set('service', serviceInfo);
    return;
  }
}

module.exports = ServiceInfo;

function isFileUrl(serviceInfoUrl) {
  return serviceInfoUrl.startsWith(FILE_PROTOCOL);
}

function isRelativePath(filePath) {
  return ! path.isAbsolute(filePath);
}

function stripFileProtocol(filePath) {
  return filePath.substring(FILE_PROTOCOL_LENGTH);
}