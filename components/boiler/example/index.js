/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" 
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE 
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE 
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE 
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL 
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR 
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER 
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, 
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE 
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 * 
 * SPDX-License-Identifier: BSD-3-Clause
 * 
 */
const path = require('path');
const boiler = require('../src');
const {getConfigUnsafe, getLogger, getConfig} = require('../src').init({
  appName: 'sample',
  baseConfigDir: path.resolve(__dirname, './configs'),
  extraConfigs: [{
    scope: 'airbrake',
    key: 'logs',
    data: {
      airbrake: {
        active: false,
        projectId: 319858,
        key: '44ca9a107f4546505c7e24c8c598b0c7',
      }
    }
  },{
    scope: 'extra1',
    file: path.resolve(__dirname, './configs/extra-config.yml')
  },{
    scope: 'extra2',
    file: path.resolve(__dirname, './configs/extra-config.json')
  },{
    scope: 'extra3',
    file: path.resolve(__dirname, './configs/extra-config.js')
  },{
    scope: 'extra4',
    data: {
      'extra-4-data': 'extra 4 object loaded'
    }
  },{
    scope: 'extra5',
    key: 'extra-5-data',
    data: 'extra 5 object loaded'
  },
  {
    scope: 'extra-js-async',
    fileAsync: path.resolve(__dirname, './configs/extra-js-async.js')
  },{
    scope: 'pryv.li',
    url: 'https://reg.pryv.li/service/info'
  },{
    scope: 'pryv.me',
    key: 'service',
    url: 'https://reg.pryv.me/service/info'
  },{
    scope: 'pryv.me-def',
    key: 'definitions',
    urlFromKey: 'service:assets:definitions'
  },{
    scope: 'ondisk-scope',
    key: 'ondisk',
    url: 'file://' + path.resolve(__dirname, './remotes/ondisk.json')
  },{
    plugin: require('./plugins/plugin-sync')
  },{
    pluginAsync: require('./plugins/plugin-async')
  }]
}, function() {
  console.log('Ready');
});

const config = getConfigUnsafe(true);


const rootLogger = getLogger();
rootLogger.debug('hello root');

const indexLogger = getLogger('index');
indexLogger.debug('hello index');
indexLogger.info('extra Yaml', config.get('extra-yaml'));
indexLogger.info('extra Json', config.get('extra-json'));
indexLogger.info('extra Js', config.get('extra-js'));
indexLogger.info('extra 4 data', config.get('extra-4-data'));
indexLogger.info('extra 5 data', config.get('extra-5-data'));
indexLogger.info('default yaml', config.get('default-yaml'));
indexLogger.info('Default Service Name', config.get('service:name'));

config.replaceScopeConfig('extra5', {'extra-5-data': 'new Extra 5 data'});
indexLogger.info('extra 5 data', config.get('extra-5-data'));

const subLogger = indexLogger.getLogger('sub');
subLogger.debug('hello sub');
indexLogger.info('plugin sync', config.get('plugin-sync'));
indexLogger.info('hide stuff auth=c08r0xs95xlb1xgssmp6tr7c0000gp', {password: 'toto'});

(async () => { 
  await getConfig();
  await boiler.notifyAirbrake('Hello');
  indexLogger.info('pryv.li serial: ', config.get('serial'));
  indexLogger.info('pryv.me name: ', config.get('service:name'));
  indexLogger.info('Favicon: ', config.get('definitions:favicon:default:url'));
  indexLogger.info('OnDisk: ', config.get('ondisk'));
  indexLogger.info('Plugin async: ', config.get('plugin-async'));
  indexLogger.info('Service Name', config.get('service:name'));
  
  indexLogger.info('Scope of foo', config.getScopeAndValue('foo'));

})();