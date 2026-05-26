/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const express = require('express');
const EventEmitter = require('events');
// Plan 61: worker-relative port so api-server's `webhooks.test.js`
// (same `PORT = 6123`) running on a different mocha-parallel worker
// doesn't collide. Workers stride by 10 starting at the base; the
// non-parallel mode (or worker 0) keeps the historical 6123 default.
const WORKER_ID = parseInt(process.env.MOCHA_WORKER_ID || '0', 10);
const PORT = 6123 + WORKER_ID * 10;

class HttpServer extends EventEmitter {
  app;
  server;
  messages;
  metas;
  messageReceived;
  messageCount;
  responseStatus;
  responseDelay;

  constructor (path, statusCode, responseBody, delay) {
    super();
    const app = express();
    this.messages = [];
    this.metas = [];
    this.messageReceived = false;
    this.messageCount = 0;
    this.responseStatus = statusCode || 200;
    this.responseDelay = delay || null;
    const that = this;
    app.use(express.json());
    app.post(path, (req, res) => {
      this.emit('received');
      if (that.responseDelay == null) {
        processMessage.call(that, req, res);
      } else {
        setTimeout(() => {
          processMessage.call(that, req, res);
        }, that.responseDelay);
      }
    });

    function processMessage (req, res) {
      this.messages = this.messages.concat(req.body.messages);
      this.metas = this.metas.concat(req.body.meta);
      this.messageReceived = true;
      this.messageCount++;
      this.emit('responding');
      res.status(this.responseStatus).json(responseBody || { ok: '1' });
    }
    this.app = app;
  }

  /**
   * @param {number} port
   * @returns {Promise<void>}
   */
  async listen (port) {
    // express's app.listen() returns the http.Server SYNCHRONOUSLY — it
    // may not be actively listening yet. Wait for the 'listening' event
    // (or surface 'error' like EADDRINUSE immediately) so callers can
    // POST to the URL right after listen() resolves.
    await new Promise((resolve, reject) => {
      this.server = this.app.listen(port || PORT, (err) => {
        if (err) reject(err);
        else resolve();
      });
      this.server.once('error', reject);
    });
  }

  /**
   * @returns {string[]}
   */
  getMessages () {
    return this.messages;
  }

  /**
   * @returns {string[]}
   */
  getMetas () {
    return this.metas;
  }

  /**
   * @returns {boolean}
   */
  isMessageReceived () {
    return this.messageReceived;
  }

  /**
   * @returns {void}
   */
  resetMessageReceived () {
    this.messageReceived = false;
  }

  /**
   * @returns {number}
   */
  getMessageCount () {
    return this.messageCount;
  }

  /**
   * @param {number} newStatus
   * @returns {void}
   */
  setResponseStatus (newStatus) {
    this.responseStatus = newStatus;
  }

  /**
   * @param {number} delay
   * @returns {void}
   */
  setResponseDelay (delay) {
    this.responseDelay = delay;
  }

  /**
   * @returns {Promise<any>}
   */
  async close () {
    if (this.server == null) { return; }
    await this.server.close();
  }
}
export default HttpServer;
