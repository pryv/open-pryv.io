/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const bluebird = require('bluebird');
const _ = require('lodash');
const Webhook = require('./Webhook');
const { getUsersRepository } = require('business/src/users');
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
   * @returns {Promise<Map<string, any[]>>}
   */
  async getAll () {
    const usersRepository = await getUsersRepository();
    const users = await usersRepository.getAllUsersIdAndName();
    const allWebhooks = new Map();
    await bluebird.all(users.map(retrieveWebhooks, this));
    return allWebhooks;
    async function retrieveWebhooks (user) {
      const webhooksQuery = {};
      const webhooksOptions = {};
      const webhooks = await bluebird.fromCallback((cb) => this.storage.find(user, webhooksQuery, webhooksOptions, cb));
      const userWebhooks = [];
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
   * @param {any} user
   * @param {any} access
   * @returns {Promise<any[]>}
   */
  async get (user, access) {
    const query = {};
    const options = {};
    if (access.isApp()) {
      query.accessId = { $eq: access.id };
    }
    const webhooks = await bluebird.fromCallback((cb) => this.storage.find(user, query, options, cb));
    const webhookObjects = [];
    webhooks.forEach((w) => {
      const webhook = initWebhook(user, this, w);
      webhookObjects.push(webhook);
    });
    return webhookObjects;
  }

  /**
   * Returns a webhook for a user, fetched by its id
   * @param {any} user
   * @param {string} webhookId
   * @returns {Promise<any>}
   */
  async getById (user, webhookId) {
    const query = {
      id: { $eq: webhookId }
    };
    const options = {};
    const webhook = await bluebird.fromCallback((cb) => this.storage.findOne(user, query, options, cb));
    if (webhook == null) { return null; }
    return initWebhook(user, this, webhook);
  }

  /**
   * Inserts a webhook for a user
   * @param {{}} user
   * @param {Webhook} webhook
   * @returns {Promise<void>}
   */
  async insertOne (user, webhook) {
    await bluebird.fromCallback((cb) => this.storage.insertOne(user, webhook.forStorage(), cb));
  }

  /**
   * Updates certain fields of a webhook for a user
   * @param {{}} user
   * @param {{}} update
   * @param {string} webhookId
   * @returns {Promise<void>}
   */
  async updateOne (user, update, webhookId) {
    const query = { id: webhookId };
    await bluebird.fromCallback((cb) => this.storage.updateOne(user, query, update, cb));
  }

  /**
   * Deletes a webhook for a user, given the webhook's id
   * @param {{}} user
   * @param {string} webhookId
   * @returns {Promise<void>}
   */
  async deleteOne (user, webhookId) {
    await bluebird.fromCallback((cb) => this.storage.delete(user, { id: webhookId }, cb));
  }

  /**
   * Deletes all webhooks for a user.
   * @param {{}} user
   * @returns {Promise<void>}
   */
  async deleteForUser (user) {
    await bluebird.fromCallback((cb) => this.storage.delete(user, {}, cb));
  }
}
module.exports = Repository;
/**
 * @param {{}} user
 * @param {Repository} repository
 * @param {{}} webhook
 * @returns {any}
 */
function initWebhook (user, repository, webhook) {
  return new Webhook(_.merge({
    webhooksRepository: repository,
    user
  }, webhook));
}
