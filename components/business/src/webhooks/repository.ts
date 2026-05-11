/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fromCallback } = require('utils');
const { deepMerge } = require('utils');
const Webhook = require('./Webhook.ts').default;
const { getUsersRepository } = require('business/src/users/index.ts');
/**
 * Repository of all Webhooks in this Pryv.io instance.
 */
class Repository {
  storage;
  constructor (webhooksStorage) {
    this.storage = webhooksStorage;
  }

  /**
   * Returns all webhooks in a map <username, Arrra<webhooks>>
   */
  async getAll () {
    const usersRepository = await getUsersRepository();
    const users = await usersRepository.getAllUsersIdAndName();
    const allWebhooks = new Map();
    await Promise.all(users.map((u) => retrieveWebhooks.call(this, u)));
    return allWebhooks;
    async function retrieveWebhooks (this: any, user) {
      const webhooksQuery = {};
      const webhooksOptions = {};
      const webhooks = await fromCallback((cb) => this.storage.find(user, webhooksQuery, webhooksOptions, cb));
      const userWebhooks: any[] = [];
      webhooks.forEach((w) => {
        userWebhooks.push(initWebhook(user, this, w));
      });
      if (userWebhooks.length > 0) {
        allWebhooks.set(user.username, userWebhooks);
      }
    }
  }

  /**
   * Return webhooks for a given User and Access.
   * Personal access: returns all webhooks
   * App access: all those created by the access
   */
  async get (user, access) {
    const query: any = {};
    const options: any = {};
    if (access.isApp()) {
      query.accessId = { $eq: access.id };
    }
    const webhooks = await fromCallback((cb) => this.storage.find(user, query, options, cb));
    const webhookObjects: any[] = [];
    webhooks.forEach((w) => {
      const webhook = initWebhook(user, this, w);
      webhookObjects.push(webhook);
    });
    return webhookObjects;
  }

  /**
   * Returns a webhook for a user, fetched by its id
   */
  async getById (user, webhookId) {
    const query = {
      id: { $eq: webhookId }
    };
    const options = {};
    const webhook = await fromCallback((cb) => this.storage.findOne(user, query, options, cb));
    if (webhook == null) { return null; }
    return initWebhook(user, this, webhook);
  }

  /**
   * Inserts a webhook for a user
   */
  async insertOne (user, webhook) {
    await fromCallback((cb) => this.storage.insertOne(user, webhook.forStorage(), cb));
  }

  /**
   * Updates certain fields of a webhook for a user
   */
  async updateOne (user, update, webhookId) {
    const query = { id: webhookId };
    await fromCallback((cb) => this.storage.updateOne(user, query, update, cb));
  }

  /**
   * Deletes a webhook for a user, given the webhook's id
   */
  async deleteOne (user, webhookId) {
    await fromCallback((cb) => this.storage.delete(user, { id: webhookId }, cb));
  }

  /**
   * Deletes all webhooks for a user.
   */
  async deleteForUser (user) {
    await fromCallback((cb) => this.storage.delete(user, {}, cb));
  }
}
export default Repository;
export { Repository };
function initWebhook (user, repository, webhook) {
  return new Webhook(deepMerge({
    webhooksRepository: repository,
    user
  }, webhook));
}
