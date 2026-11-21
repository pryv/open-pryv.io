/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { Logger } from '@pryv/boiler';
const require = createRequire(import.meta.url);

const { pubsub } = require('messages');
const WebhooksRepository = require('business/src/webhooks/repository.ts').default;
const { getUsersRepository } = require('business/src/users/index.ts');
const { getAPIVersion } = require('middleware/src/project_version.ts');
const { BOOT_MESSAGE } = require('./messages.ts');

type WebhookInstance = {
  id: string;
  state?: string;
  setApiVersion (v: string): void;
  setSerial (s: string): void;
  setLogger (l: Logger): void;
  send (msg: string): Promise<unknown>;
  startListenting (username: string): void;
  stop (): void;
};
type Settings = { get (key: string): unknown };
type WebhooksMap = Map<string, WebhookInstance[]>;

class WebhooksService {
  webhooks: WebhooksMap = new Map();
  repository: InstanceType<typeof WebhooksRepository>;
  logger: Logger;
  apiVersion: string = '';
  serial: string = '';
  settings: Settings;
  constructor (params: { logger: Logger; storage: { webhooks: unknown; events: unknown; accesses: unknown }; settings: Settings }) {
    this.logger = params.logger;
    this.repository = new WebhooksRepository(params.storage.webhooks, params.storage.events, params.storage.accesses);
    this.settings = params.settings;
  }

  async start () {
    this.apiVersion = await getAPIVersion();
    this.serial = this.settings.get('service:serial') as string;
    this.logger.info('Loading service with version ' +
            this.apiVersion +
            ' and serial ' +
            this.serial +
            '.');
    this.subscribeListeners();
    this.logger.info('Listeners for webhooks creation/deletion up.');
    await this.loadWebhooks();
    this.logger.info('Loaded webhooks for ' + this.webhooks.size + ' user(s).');
    const numWebhooks = this.setMeta();
    await this.sendBootMessage();
    this.logger.info(BOOT_MESSAGE + ' sent.');
    await this.initSubscribers();
    this.logger.info(numWebhooks + ' webhook(s) listening to changes from core.');
  }

  subscribeListeners () {
    pubsub.webhooks.on(pubsub.WEBHOOKS_DELETE, this.onStop.bind(this));
    pubsub.webhooks.on(pubsub.WEBHOOKS_CREATE, this.onCreate.bind(this));
    pubsub.webhooks.on(pubsub.WEBHOOKS_ACTIVATE, this.onActivate.bind(this));
  }

  setMeta () {
    let numWebhooks = 0;
    for (const entry of this.webhooks) {
      const userWebhooks = entry[1];
      userWebhooks.forEach((w: WebhookInstance) => {
        w.setApiVersion(this.apiVersion);
        w.setSerial(this.serial);
        w.setLogger(this.logger);
        numWebhooks++;
      });
    }
    return numWebhooks;
  }

  async sendBootMessage () {
    for (const entry of this.webhooks) {
      await Promise.all(entry[1].map(async (webhook: WebhookInstance) => {
        await webhook.send(BOOT_MESSAGE);
      }));
    }
  }

  async initSubscribers () {
    for (const entry of this.webhooks) {
      const username = entry[0];
      const webhooks = entry[1];
      for (const webhook of webhooks) {
        webhook.startListenting(username);
      }
    }
  }

  async onCreate (usernameWebhook: UsernameWebhook) {
    const username = usernameWebhook.username;
    const usersRepository = await getUsersRepository();
    const userId = await usersRepository.getUserIdForUsername(username);
    const user = { id: userId, username };
    // Reload from storage rather than rebuilding from the (API-shaped) pubsub
    // payload, so the webhook carries the stored `scopes` incl. their prepared
    // (access-bound, expanded) query for engine matching.
    // The message carries the id only: the stored webhook holds the signing
    // secret, never put in a pubsub message. A webhook not in storage (deleted
    // since) is not run.
    const stored = await this.repository.getById(user, usernameWebhook.webhook.id);
    if (stored == null) {
      this.logger.warn(`Webhook ${usernameWebhook.webhook.id} for ${username} not found in storage, not loaded.`);
      return;
    }
    this.addWebhook(username, stored);
  }

  onActivate (usernameWebhook: UsernameWebhook) {
    this.activateWebhook(usernameWebhook.username, usernameWebhook.webhook);
  }

  onStop (usernameWebhook: UsernameWebhook) {
    this.stopWebhook(usernameWebhook.username, usernameWebhook.webhook.id);
  }

  async addWebhook (username: string, webhook: WebhookInstance) {
    let userWebhooks = this.webhooks.get(username);
    if (userWebhooks == null) {
      userWebhooks = [];
      this.webhooks.set(username, userWebhooks);
    }
    // One running copy per webhook: two reloads close together (two
    // rotations, a rotation and a rescope) may both load it.
    for (let i = userWebhooks.length - 1; i >= 0; i--) {
      if (userWebhooks[i].id === webhook.id && userWebhooks[i] !== webhook) {
        userWebhooks[i].stop();
        userWebhooks.splice(i, 1);
      }
    }
    // Loaded after boot: the meta setMeta() gives the webhooks loaded at start.
    webhook.setApiVersion(this.apiVersion);
    webhook.setSerial(this.serial);
    webhook.setLogger(this.logger);
    userWebhooks.push(webhook);
    webhook.startListenting(username);
    this.logger.info(`Loaded webhook ${webhook.id} for ${username}`);
  }

  async activateWebhook (username: string, webhook: { id: string }) {
    const userWebhooks = this.webhooks.get(username);
    if (userWebhooks == null) {
      this.logger.warn(`Could not retrieve webhooks for ${username} to activate ${webhook.id}.`);
      return;
    }
    const stoppedWebhook = userWebhooks.filter((w: WebhookInstance) => w.id === webhook.id)[0];
    if (stoppedWebhook == null) {
      this.logger.warn(`Webhook ${webhook.id} not found for ${username}.`);
      return;
    }
    stoppedWebhook.state = 'active';
    this.logger.info(`Reactivated webhook ${stoppedWebhook.id} for ${username}`);
  }

  stopWebhook (username: string, webhookId: string) {
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

  getWebhook (username: string, webhookId: string): [WebhookInstance[] | null, WebhookInstance | null, number | null] {
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

  stop () {
    this.logger.info('Stopping webhooks service');
    for (const usernameWebhooks of this.webhooks) {
      usernameWebhooks[1].forEach((w: WebhookInstance) => {
        w.stop();
      });
    }
  }

  async loadWebhooks () {
    this.webhooks = await this.repository.getAll();
  }
}
export { WebhooksService };

// The pubsub messages name the webhook by its id only.
type UsernameWebhook = {
  username: string;
  webhook: { id: string };
};
