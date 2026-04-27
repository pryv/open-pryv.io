/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const bluebird = require('bluebird');
const { pubsub } = require('messages');
const Webhook = require('business/src/webhooks/Webhook');
const WebhooksRepository = require('business/src/webhooks/repository');
const { getUsersRepository } = require('business/src/users');
const { getAPIVersion } = require('middleware/src/project_version');
const BOOT_MESSAGE = require('./messages').BOOT_MESSAGE;

class WebhooksService {
  webhooks;

  repository;

  logger;

  apiVersion;

  serial;
  constructor (params) {
    this.logger = params.logger;
    this.repository = new WebhooksRepository(params.storage.webhooks);
    this.settings = params.settings;
  }

  /**
   * @returns {Promise<void>}
   */
  async start () {
    this.apiVersion = await getAPIVersion();
    this.serial = this.settings.get('service:serial');
    this.logger.info('Loading service with version ' +
            this.apiVersion +
            ' and serial ' +
            this.serial +
            '.');
    this.subscribeListeners();
    this.logger.info('Listeners for webhooks creation/deletion up.');
    await this.loadWebhooks();
    this.logger.info('Loaded webhooks for ' + this.webhooks.size + ' user(s).');
    const numWebhooks = await this.setMeta(this);
    await this.sendBootMessage();
    this.logger.info(BOOT_MESSAGE + ' sent.');
    await this.initSubscribers();
    this.logger.info(numWebhooks + ' webhook(s) listening to changes from core.');
  }

  /**
   * @returns {void}
   */
  subscribeListeners () {
    pubsub.webhooks.on(pubsub.WEBHOOKS_DELETE, this.onStop.bind(this));
    pubsub.webhooks.on(pubsub.WEBHOOKS_CREATE, this.onCreate.bind(this));
    pubsub.webhooks.on(pubsub.WEBHOOKS_ACTIVATE, this.onActivate.bind(this));
  }

  /**
   * @returns {number}
   */
  setMeta () {
    let numWebhooks = 0;
    for (const entry of this.webhooks) {
      const userWebhooks = entry[1];
      userWebhooks.forEach((w) => {
        w.setApiVersion(this.apiVersion);
        w.setSerial(this.serial);
        w.setLogger(this.logger);
        numWebhooks++;
      });
    }
    return numWebhooks;
  }

  /**
   * @returns {Promise<void>}
   */
  async sendBootMessage () {
    for (const entry of this.webhooks) {
      await bluebird.all(entry[1].map(async (webhook) => {
        await webhook.send(BOOT_MESSAGE);
      }));
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async initSubscribers () {
    for (const entry of this.webhooks) {
      const username = entry[0];
      const webhooks = entry[1];
      for (const webhook of webhooks) {
        webhook.startListenting(username);
      }
    }
  }

  /**
   * @param {UsernameWebhook} usernameWebhook
   * @returns {Promise<void>}
   */
  async onCreate (usernameWebhook) {
    const username = usernameWebhook.username;
    const usersRepository = await getUsersRepository();
    const userId = await usersRepository.getUserIdForUsername(username);
    this.addWebhook(username, new Webhook(Object.assign({}, usernameWebhook.webhook, {
      webhooksRepository: this.repository,
      user: { id: userId, username }
    })));
  }

  /**
   * @param {UsernameWebhook} usernameWebhook
   * @returns {void}
   */
  onActivate (usernameWebhook) {
    this.activateWebhook(usernameWebhook.username, usernameWebhook.webhook);
  }

  /**
   * @param {UsernameWebhook} usernameWebhook
   * @returns {void}
   */
  onStop (usernameWebhook) {
    this.stopWebhook(usernameWebhook.username, usernameWebhook.webhook.id);
  }

  /**
   * @param {string} username
   * @param {Webhook} webhook
   * @returns {Promise<void>}
   */
  async addWebhook (username, webhook) {
    let userWebhooks = this.webhooks.get(username);
    if (userWebhooks == null) {
      userWebhooks = [];
      this.webhooks.set(username, userWebhooks);
    }
    userWebhooks.push(webhook);
    webhook.startListenting(username);
    this.logger.info(`Loaded webhook ${webhook.id} for ${username}`);
  }

  /**
   * @param {string} username
   * @param {Webhook} webhook
   * @returns {void}
   */
  async activateWebhook (username, webhook) {
    const userWebhooks = this.webhooks.get(username);
    if (userWebhooks == null) {
      this.logger.warn(`Could not retrieve webhooks for ${username} to activate ${webhook.id}.`);
      return;
    }
    const stoppedWebhook = userWebhooks.filter((w) => w.id === webhook.id)[0];
    if (stoppedWebhook == null) {
      this.logger.warn(`Webhook ${webhook.id} not found for ${username}.`);
      return;
    }
    stoppedWebhook.state = 'active';
    this.logger.info(`Reactivated webhook ${stoppedWebhook.id} for ${username}`);
  }

  /**
   * @param {string} username
   * @param {string} webhookId
   * @returns {void}
   */
  stopWebhook (username, webhookId) {
    const [usersWebhooks, webhook, idx] = this.getWebhook(username, webhookId);
    if (webhook == null || usersWebhooks == null || idx == null) {
      this.logger.warn(`Could not retrieve webhook ${webhookId} for ${username} to stop it.`);
      return;
    }
    webhook.stop();
    usersWebhooks.splice(idx, 1);
    this.webhooks.set(username, usersWebhooks);
    this.logger.info(`Stopped webhook ${webhookId} for ${username}`);
  }

  /**
   * @param {string} username
   * @param {string} webhookId
   * @returns {[any[], any, number]}
   */
  getWebhook (username, webhookId) {
    const usersWebhooks = this.webhooks.get(username);
    if (usersWebhooks == null) {
      return [null, null, null];
    }
    const len = usersWebhooks.length;
    for (let i = 0; i < len; i++) {
      if (usersWebhooks[i].id === webhookId) {
        return [usersWebhooks, usersWebhooks[i], i];
      }
    }
    return [null, null, null];
  }

  /**
   * @returns {void}
   */
  stop () {
    this.logger.info('Stopping webhooks service');
    for (const usernameWebhooks of this.webhooks) {
      usernameWebhooks[1].forEach((w) => {
        w.stop();
      });
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async loadWebhooks () {
    this.webhooks = await this.repository.getAll();
  }
}
module.exports = WebhooksService;

/**
 * @typedef {{
 *   username: string;
 *   webhook: Webhook;
 * }} UsernameWebhook
 */
