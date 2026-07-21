/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { ConfigLike as BoilerConfig } from '@pryv/boiler';
import type { Logger } from '@pryv/boiler';
const require = createRequire(import.meta.url);
// Always require application first to be sure boiler is initialized
const { getApplication } = require('api-server/src/application.ts');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { testMessaging } = require('messages');
const { pubsub } = require('messages');
const { getUsersRepository } = require('business/src/users/index.ts');
const { getLogger, getConfig } = require('@pryv/boiler');
const { getAPIVersion } = require('middleware/src/project_version.ts');
const { WebhooksService } = require('webhooks/src/service.ts');
const { buildHfsIngress } = require('./hfsIngress.ts');
type ApiSurface = { register: (...args: unknown[]) => void; getMethodKeys?: () => string[] };
type AppInstance = {
  api: ApiSurface;
  systemAPI: ApiSurface;
  expressApp: unknown;
  webhooksService?: unknown;
  initiate (): Promise<unknown>;
  getCustomAuthFunction (from: string): unknown;
};
type HttpsLike = {
  setSecureContext (opts: HttpsOptions): void;
};
type HttpsOptions = { key: Buffer; cert: Buffer; ca?: Buffer[] };

let app: AppInstance;

/**
 * Server class for api-server process. To use this, you would:
 *
 *    const server = new Server();
 *    server.start();
 */
class Server {
  logger!: Logger;
  config!: BoilerConfig;
  httpsServer: HttpsLike | undefined;

  async start () {
    this.logger = getLogger('server');
    this.logger.debug('start initiated');
    const apiVersion = await getAPIVersion();
    app = getApplication();
    await app.initiate();
    const config = await getConfig();
    this.config = config;
    const defaultParam = this.findDefaultParam();
    if (defaultParam != null) {
      this.logger.error(`Config parameter "${defaultParam}" has a default value, please change it`);
      process.exit(1);
    }
    // setup test notification bus (IPC-based)
    await this.setupTestsNotificationBus();
    // register API methods
    await this.registerApiMethods();
    // Build the in-process HFS ingress dispatcher (no-op when no HFS
    // worker is configured; the regex still matches but the upstream
    // would 502 — the auto-derived `features.noHF: true` on
    // /service/info keeps SDKs from making the request in the first
    // place when hfsWorkers === 0).
    //
    // Quick / out-of-the-box path. For long-term high-throughput
    // installs, front master with nginx and let it do the routing —
    // see docs/nginx-ingress-sample.conf.
    const hfsDispatch = buildHfsIngress({
      hfsHost: (config.get('http:ip') as string) || '127.0.0.1',
      hfsPort: (config.get('http:hfsPort') as number) || 4000,
      logger: this.logger
    });
    const requestHandler = (req: unknown, res: unknown) => hfsDispatch(req, res, app.expressApp);
    // Setup HTTP and register server; setup Socket.IO.
    let server: { address: () => { address: string; port: number }; listen: (...args: unknown[]) => unknown; once: (event: string, handler: (err?: Error) => void) => unknown; key?: unknown } | null = null;
    const serverInfos: { hostname: string | null } = {
      hostname: null
    };
    if (config.get('http:ssl:backloop.dev')) { // SSL is used in openSource version
      // Lazy require: backloop.dev is a devDependency, not installed in
      // production images (Dockerfile does `npm install --omit=dev`).
      // Only load when actually wired into config.
      const recLaOptionsAsync = require('backloop.dev').httpsOptionsAsync;
      await new Promise<void>((resolve, reject) => {
        recLaOptionsAsync((err: Error | null, recLaOptions: HttpsOptions) => {
          if (err) return reject(err);
          server = https.createServer(recLaOptions, requestHandler);
          serverInfos.hostname = 'my-computer.backloop.dev';
          resolve();
        });
      });
      this.logger.info('SSL Mode using backloop.dev certificates');
    } else if (config.get('http:ssl:keyFile')) { // https with local files
      const httpsServer = https.createServer(buildHttpsOptions(config), requestHandler);
      server = httpsServer;
      serverInfos.hostname = 'custom-according-to-your-ssl-cert';
      this.logger.info('SSL Mode using custom certificates');
      // Keep a reference so reloadTls() can hot-swap the SecureContext
      // when the Let's Encrypt orchestrator rotates the cert.
      this.httpsServer = httpsServer;
    } else { // http
      server = http.createServer(requestHandler);
    }
    await this.setupSocketIO(server);
    await this.startListen(server!, serverInfos);
    this.logger.info('Server ready. API Version: ' + apiVersion);
    pubsub.status.emit(pubsub.SERVER_READY);
    // Start webhooks service in-process (unless explicitly disabled)
    if (config.get('webhooks:inProcess') !== false) {
      await this.startWebhooksService();
    }
    this.logger.debug('start completed');
  }

  findDefaultParam () {
    const DEFAULT_VALUES = ['REPLACE_ME'];
    if (DEFAULT_VALUES.includes(this.config.get('auth:adminAccessKey') as string)) { return 'auth:adminAccessKey'; }
    return null;
  }

  /**
   * Requires and registers all API methods.
   */
  async registerApiMethods () {
    await require('./methods/system.ts').default(app.systemAPI, app.api);
    await require('./methods/utility.ts').default(app.api);
    await require('./methods/auth/login.ts').default(app.api);
    await require('./methods/auth/register.ts').default(app.api);
    await require('./methods/auth/delete.ts').default(app.api);
    await require('./methods/mfa.ts').default(app.api);
    await require('./methods/accesses.ts').default(app.api);
    require('./methods/service.ts').default(app.api);
    await require('./methods/webhooks.ts').default(app.api);
    await require('./methods/shared-secrets.ts').default(app.api);
    await require('./methods/trackingFunctions.ts').default(app.api);
    await require('./methods/account.ts').default(app.api);
    await require('./methods/profile.ts').default(app.api);
    await require('./methods/streams.ts').default(app.api);
    await require('./methods/events.ts').default(app.api);
    this.logger.debug('api methods registered');
  }

  async setupSocketIO (server: unknown) {
    const api = app.api;
    const customAuthStepFn = app.getCustomAuthFunction('server.js');
    const socketIOsetup = require('./socket-io/index.ts').default;
    await socketIOsetup(server, api, customAuthStepFn);
    this.logger.debug('socket io setup done');
  }

  /**
   * Open http port and listen to incoming connections.
   */
  async startListen (server: { listen: (...args: unknown[]) => unknown; once: (event: string, handler: (err?: Error) => void) => unknown; address: () => { address: string; port: number }; key?: unknown }, info: { hostname?: string | null } = {}) {
    const config = this.config;
    const logger = this.logger;
    const port = config.get('http:port');
    const hostname = config.get('http:ip');
    // All listen() methods can take a backlog parameter to specify the maximum
    // length of the queue of pending connections. The actual length will be
    // determined by the OS through sysctl config such as tcp_max_syn_backlog
    // and somaxconn on Linux. The default value of this parameter is 511 (not
    // 512).
    const backlog = 511;
    // Start listening on the HTTP port.
    let startFinished = false;
    await new Promise<void>((resolve, reject) => {
      server.listen(port, hostname, backlog, () => {
        if (!startFinished) {
          startFinished = true;
          resolve();
        }
      });
      server.once('error', (err?: Error) => {
        if (!startFinished) {
          startFinished = true;
          console.log(
            'There was an error starting the server in the error listener:',
            err
          );
          reject(err);
        }
      });
    });
    const address = server.address();
    const protocol = server.key == null ? 'http' : 'https';
    const hostnameStr = info.hostname || address.address;
    const serverUrl = protocol + '://' + hostnameStr + ':' + address.port;
    logger.debug('listening on ' + serverUrl);
    logger.info(`Core Server (API module) listening on ${serverUrl}`);
    // Warning if ignoring forbidden updates
    if (config.get('updates:ignoreProtectedFields')) {
      logger.warn('Server configuration has "ignoreProtectedFieldUpdates" set to true: ' +
        'This means updates to protected fields will be ignored and operations will succeed. ' +
        'We recommend turning this off, but please be aware of the implications for your code.');
    }
    // TEST: execute test setup instructions if any
    const instanceTestSetup = config.get('instanceTestSetup') || null; // coerce to null
    if (process.env.NODE_ENV === 'test' && instanceTestSetup !== null) {
      logger.debug('specific test setup ');
      try {
        const testNotifier = await testMessaging.getTestNotifier();
        require('test-helpers').instanceTestSetup.execute(instanceTestSetup, testNotifier);
      } catch (err: unknown) {
        logger.error(err as Error);
        logger.warn('Error executing instance test setup instructions: ' + (err as Error).message);
      }
    }
  }

  /**
   * Sets up `Notifications` bus and registers it for everyone to consume.
   */
  async setupTestsNotificationBus () {
    const testNotifier = await testMessaging.getTestNotifier();
    pubsub.setTestNotifier(testNotifier);
  }

  /**
   * Starts the webhooks service in-process, eliminating the need for a
   * separate webhooks container/process.
   */
  async startWebhooksService () {
    const config = this.config;
    const storage = require('storage');
    const storageLayer = await storage.getStorageLayer();
    const webhooksService = new WebhooksService({
      storage: storageLayer,
      logger: getLogger('webhooks_service'),
      settings: config
    });
    app.webhooksService = webhooksService;
    await webhooksService.start();
    this.logger.info('Webhooks service started in-process');
  }

  async getUserCount () {
    let numUsers;
    try {
      const usersRepository = await getUsersRepository();
      numUsers = await usersRepository.count();
    } catch (error: unknown) {
      this.logger.error(error as Error, error);
      throw error;
    }
    return numUsers;
  }

  /**
   * Hot-swap the TLS context from the currently-configured cert/key
   * files. Triggered by a `acme:rotate` IPC message from master after
   * the Let's Encrypt orchestrator writes a freshly-renewed cert to
   * disk. No-op when this worker isn't serving HTTPS.
   *
   * Uses https.Server.setSecureContext which takes effect for new TLS
   * handshakes while leaving in-flight connections alone.
   */
  reloadTls () {
    if (this.httpsServer == null) {
      this.logger.debug('reloadTls: no https server in this worker — ignoring');
      return { reloaded: false, reason: 'not-https' };
    }
    try {
      const options = buildHttpsOptions(this.config);
      this.httpsServer.setSecureContext(options);
      this.logger.info('TLS context reloaded from disk');
      return { reloaded: true };
    } catch (err: unknown) {
      this.logger.error('reloadTls failed: ' + (err as Error).message);
      return { reloaded: false, reason: 'error', error: (err as Error).message };
    }
  }
}

/**
 * Read https options off the config's `http.ssl.*` file paths.
 * Reads fresh each call so reloadTls picks up rotated files.
 */
function buildHttpsOptions (config: BoilerConfig): HttpsOptions {
  const options: HttpsOptions = {
    key: fs.readFileSync(config.get('http:ssl:keyFile') as string),
    cert: fs.readFileSync(config.get('http:ssl:certFile') as string)
  };
  if (config.get('http:ssl:caFile')) {
    options.ca = [fs.readFileSync(config.get('http:ssl:caFile') as string)];
  }
  return options;
}

export default Server;
export { Server };