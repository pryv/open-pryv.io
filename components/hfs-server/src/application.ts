/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = require('path').dirname(__filename);

const path = require('path');
const { getConfig, getLogger } = require('@pryv/boiler').init({
  appName: 'hfs-server',
  baseFilesDir: path.resolve(__dirname, '../../../'),
  baseConfigDir: path.resolve(__dirname, '../../../config/'),
  extraConfigs: [
    {
      scope: 'serviceInfo',
      key: 'service',
      urlFromKey: 'serviceInfoUrl'
    },
    {
      scope: 'defaults-paths',
      file: path.resolve(__dirname, '../../../config/plugins/paths-config.js')
    },
    {
      pluginAsync: require('../../../config/plugins/systemStreams')
    }
  ]
});
// Load configuration file, set up execution context and start the server.
const Context = require('./context').default;
const Server = require('./server').default;
const setCommonMeta = require('api-server/src/methods/helpers/setCommonMeta');
const accountStreams = require('business/src/system-streams');

// Tracing shim. See components/tracing/src/Tracing.js for the rationale —
// New Relic APM (Plan 38) is the active observability path; this layer
// preserves the architectural slot.
class NoopSpan {
  operationName;
  constructor (name) { this.operationName = name; }
  setTag () {}
  log () {}
  finish () {}
}
class NoopTracer {
  startSpan (name) { return new NoopSpan(name); }
  inject () {}
}

async function createContext (config) {
  const storages = require('storages');
  await storages.init(config);
  const influx = storages.seriesConnection;
  if (!influx) {
    throw new Error('Series storage not available.');
  }

  const tracer = new NoopTracer();
  const typeRepoUpdateUrl = config.get('service:eventTypes');
  const context = new Context(influx, tracer, typeRepoUpdateUrl, config);
  await context.init();
  context.startMetadataUpdater();
  return context;
}
// The HF application holds references to all subsystems and ties everything
// together.
//

class Application {
  logger;

  context;

  server;

  config;
  async init () {
    this.logger = getLogger('application');
    this.config = await getConfig();
    await accountStreams.init();
    await setCommonMeta.loadSettings();
    this.context = await createContext(this.config);
    this.server = new Server(this.config, this.context);
  }

  async start () {
    await this.server.start();
    return this;
  }

  async run () {
    await this.init();
    await this.start();
  }
}
export default Application;
export { Application };
