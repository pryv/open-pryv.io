/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const EventEmitter = require('events');
const express = require('express');
// Worker-relative port so business's Webhook.test.js (same PORT = 6123)
// running on a different mocha-parallel worker doesn't collide. See
// companion shift in business' httpServer.js.
const WORKER_ID = parseInt(process.env.MOCHA_WORKER_ID || '0', 10);
const PORT = 6123 + WORKER_ID * 10;

/*
 * Create a local HTTP server for the purpose of answering
 * query on localhost:PORT/service/info or localhost:PORT/reports
 * mocking https://reg.pryv.me/service/info
 *
 * No logger available here. Using console.debug
 */
class HttpServer extends EventEmitter {
  app;

  server;

  responseStatus;

  lastReport;
  constructor (path, statusCode, responseBody) {
    super();
    const app = express();
    this.responseStatus = statusCode || 200;
    app.use(express.json());
    app.all(path, (req, res) => {
      res.status(this.responseStatus).json(responseBody || { ok: '1' });
      if (req.method === 'POST') {
        this.lastReport = req.body;
        this.emit('report_received');
      }
    });
    this.app = app;
  }

  /**
   * @param {number} port
   * @returns {Promise<void>}
   */
  async listen (port) {
    // express's app.listen() returns the http.Server SYNCHRONOUSLY — it
    // may not be actively listening yet. Wait for 'listening' (or
    // surface 'error' like EADDRINUSE) before resolving so callers can
    // POST to the URL right after.
    await new Promise((resolve, reject) => {
      this.server = this.app.listen(port || PORT, (err) => {
        if (err) reject(err);
        else resolve();
      });
      this.server.once('error', reject);
    });
  }

  /**
   * @returns {Promise<void>}
   */
  async close () {
    await this.server.close();
  }

  /**
   * @returns {any}
   */
  getLastReport () {
    return this.lastReport;
  }
}
export default HttpServer;
