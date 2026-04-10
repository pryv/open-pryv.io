/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const express = require('express');
const bodyParser = require('body-parser');
const EventEmitter = require('events');
const PORT = 6123;

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
    app.use(bodyParser.json());
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
    this.server = await this.app.listen(port || PORT);
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
module.exports = HttpServer;
