/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Application as ExpressApp, Request, Response } from 'express';
import type { Server as HttpServer } from 'node:http';
const require = createRequire(import.meta.url);

const http = require('http');
const express = require('express');
const util = require('util');
const middleware = require('middleware');
const errorsMiddleware = require('./middleware/errors.ts').default;
const controllerFactory = require('./web/controller.ts').default;
const getAuth = require('middleware/src/getAuth.ts').default;
const KEY_IP = 'http:ip';
const KEY_PORT = 'http:hfsPort';
const { getConfig, getLogger } = require('@pryv/boiler');

interface ConfigLike { get: (key: string) => unknown }
interface LoggerLike {
  info: (msg: string) => void;
  debug: (msg: string) => void;
  error: (msg: string) => void;
  getLogger: (name: string) => LoggerLike;
}

/**
 * HTTP server responsible for the REST api that the HFS server exposes.
 */
class Server {
  // Server settings.

  config: ConfigLike;
  // The express application.

  expressApp!: ExpressApp;
  // base url for any access to this server.

  baseUrl!: string;
  /**
   * http server object
   */
  server!: HttpServer;
  // Logger used here.

  logger: LoggerLike;

  errorLogger: LoggerLike;
  // Web request context

  context: unknown;
  constructor (config: ConfigLike, context: unknown) {
    this.logger = getLogger('server');
    this.errorLogger = this.logger.getLogger('errors');
    this.config = config;
    this.context = context;
    this.logger.info('constructed.');
  }

  /**
   * Starts the HTTP server.
   *
    started and accepts connections.
   */
  async start () {
    await getConfig(); // makes sure config is loaded
    const ip = this.config.get(KEY_IP);
    const port = this.config.get(KEY_PORT);
    this.baseUrl = `http://${ip}:${port}/`;
    this.logger.info('starting... on port: ' + port);
    this.logger.debug('starting on: ' + this.baseUrl);
    const app = await this.setupExpress();
    this.expressApp = app;
    const server = (this.server = http.createServer(app));
    const serverListen = util.promisify(server.listen).bind(server);
    return serverListen(port, ip).then(this.logStarted.bind(this));
  }

  /** Logs that the server has started.
   * @param {any} arg
   * @returns {Promise<any>}
   */
  logStarted<T> (arg: T): T {
    const addr = this.server.address() as { address: string; port: number };
    this.logger.info(`started. (http://${addr.address}:${addr.port})`);
    // passthrough of our single argument
    return arg;
  }

  /**
   * Stops a running server instance.
   *
    stopped.
   */
  async stop () {
    const server = this.server;
    this.logger.info('stopping...');
    const serverClose = util.promisify(server.close).bind(server);
    return serverClose();
  }

  /**
   * Sets up the express application, injecting middleware and configuring the
   * instance.
   *
   */
  async setupExpress () {
    const logger = this.logger;
    const config = this.config;
    const app = express();
    app.disable('x-powered-by');
    app.use(middleware.subdomainToPath([]));
    app.use(middleware.requestTrace(express, logger));
    app.use(express.json({ limit: config.get('uploads:maxSizeMb') + 'mb' }));
    app.use(middleware.override);
    app.use(await middleware.commonHeaders());
    app.all('/*', getAuth);
    this.defineApplication(app);
    app.use(middleware.notFound);
    app.use(errorsMiddleware(this.errorLogger));
    return app;
  }

  /** Defines all the routes that we serve from this server.
   * @param {express$Application} app
   * @returns {void}
   */
  defineApplication (app: ExpressApp) {
    const ctx = this.context;
    const c = controllerFactory(ctx);
    app.get('/system/status', systemStatus);
    app.post('/:user_name/events/:event_id/series', c.storeSeriesData);
    app.post('/:user_name/series/batch', c.storeSeriesBatch);
    app.get('/:user_name/events/:event_id/series', c.querySeriesData);
  }
}
/** GET /system/status - Answers the caller with a status of the application.
 * This call should eventually permit health checks for this subsystem.
 * @param {express$Request} req
 * @param {express$Response} res
 * @returns {void}
 */
function systemStatus (_req: Request, res: Response) {
  res.status(200).json({
    status: 'ok'
  });
}
export default Server;
export { Server };
