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

type NodeCallback<T = unknown> = (err: unknown, value?: T) => void;
type User = { id: string; username: string };
type AccessLike = { id: string; isApp: () => boolean };

/**
 * Repository of all Webhooks in this Pryv.io instance.
 */
type WebhooksStorageLike = Record<string, any>; // wide alias — concrete iface deferred
type AccessesStorageLike = Record<string, any>;

class Repository {
  storage: WebhooksStorageLike;
  accessesStorage: AccessesStorageLike | undefined;
  constructor (webhooksStorage: WebhooksStorageLike, eventsStorage?: unknown, accessesStorage?: AccessesStorageLike) {
    this.storage = webhooksStorage;
    this.accessesStorage = accessesStorage;
  }

  /**
   * Returns all webhooks in a map <username, Arrra<webhooks>>
   */
  async getAll () {
    const usersRepository = await getUsersRepository();
    const users = await usersRepository.getAllUsersIdAndName();
    const allWebhooks = new Map();
    await Promise.all(users.map((u: User) => retrieveWebhooks.call(this, u)));
    return allWebhooks;
    async function retrieveWebhooks (this: Repository, user: User) {
      const webhooksQuery = {};
      const webhooksOptions = {};
      const webhooks: unknown[] = await fromCallback((cb: NodeCallback<unknown[]>) => this.storage.find(user, webhooksQuery, webhooksOptions, cb));
      const userWebhooks: unknown[] = [];
      webhooks.forEach((w: unknown) => {
        userWebhooks.push(initWebhook(user, this, w as Record<string, unknown>));
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
  async get (user: User, access: AccessLike) {
    const query: Record<string, unknown> = {};
    const options: Record<string, unknown> = {};
    if (access.isApp()) {
      query.accessId = { $eq: access.id };
    }
    const webhooks: unknown[] = await fromCallback((cb: NodeCallback<unknown[]>) => this.storage.find(user, query, options, cb));
    const webhookObjects: unknown[] = [];
    webhooks.forEach((w: unknown) => {
      const webhook = initWebhook(user, this, w as Record<string, unknown>);
      webhookObjects.push(webhook);
    });
    return webhookObjects;
  }

  /**
   * Returns a webhook for a user, fetched by its id
   */
  async getById (user: User, webhookId: string) {
    const query = {
      id: { $eq: webhookId }
    };
    const options = {};
    const webhook = await fromCallback((cb: NodeCallback) => this.storage.findOne(user, query, options, cb));
    if (webhook == null) { return null; }
    return initWebhook(user, this, webhook);
  }

  /**
   * Inserts a webhook for a user
   */
  async insertOne (user: User, webhook: { forStorage: () => unknown }) {
    await fromCallback((cb: NodeCallback) => this.storage.insertOne(user, webhook.forStorage(), cb));
  }

  /**
   * Updates certain fields of a webhook for a user
   */
  async updateOne (user: User, update: Record<string, unknown>, webhookId: string) {
    const query = { id: webhookId };
    await fromCallback((cb: NodeCallback) => this.storage.updateOne(user, query, update, cb));
  }

  /**
   * Deletes a webhook for a user, given the webhook's id
   */
  async deleteOne (user: User, webhookId: string) {
    await fromCallback((cb: NodeCallback) => this.storage.delete(user, { id: webhookId }, cb));
  }

  /**
   * Deletes all webhooks for a user.
   */
  async deleteForUser (user: User) {
    await fromCallback((cb: NodeCallback) => this.storage.delete(user, {}, cb));
  }

  /**
   * Deletes all webhooks attached to a given access. Used by the
   * `accesses.delete` cascade.
   */
  async deleteByAccess (user: User, accessId: string) {
    await fromCallback((cb: NodeCallback) => this.storage.delete(user, { accessId }, cb));
  }

  /**
   * Returns true iff an active (non-tombstoned) access exists for the
   * given accessId. Defensive: returns true when no accessesStorage was
   * wired (older constructor callers) so we never falsely deactivate.
   */
  async accessExists (user: User, accessId: string): Promise<boolean> {
    if (this.accessesStorage == null) return true;
    const access: { deleted?: unknown } | null = await fromCallback((cb: NodeCallback) =>
      this.accessesStorage!.findOne(user, { id: accessId }, {}, cb));
    return access != null && access.deleted == null;
  }
}
export default Repository;
export { Repository };
function initWebhook (user: User, repository: Repository, webhook: Record<string, unknown>) {
  return new Webhook(deepMerge({
    webhooksRepository: repository,
    user
  }, webhook));
}
