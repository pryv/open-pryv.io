/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const timestamp = require('unix-timestamp');

const errors = require('errors').factory;

const commonFns = require('./helpers/commonFunctions.ts');
const webhookSchema = require('../schema/webhook.ts').default;
const methodsSchema = require('../schema/webhooksMethods.ts');

const Webhook = require('business').webhooks.Webhook;
const WebhooksRepository = require('business').webhooks.Repository;

const { pubsub } = require('messages');
const { getLogger, ready } = require('@pryv/boiler');
const { getStorageLayer } = require('storage');

type WebhooksSettingsHolder = {
  minIntervalMs: number;
  maxRetries: number;
  runsSize: number;
};
type Access = {
  id: string;
  isApp(): Boolean;
};
export default async function produceWebhooksApiMethods (api: any) {
  const config = await ready();
  const wehbooksSettings = config.get('webhooks');
  const storageLayer = await getStorageLayer();
  const logger = getLogger('methods:webhooks');

  const webhooksRepository = new WebhooksRepository(storageLayer.webhooks, storageLayer.events);

  // RETRIEVAL

  api.register(
    'webhooks.get',
    commonFns.getParamsValidation(methodsSchema.get.params),
    findAccessibleWebhooks
  );

  async function findAccessibleWebhooks (context: any, params: any, result: any, next: any) {
    const currentAccess = context.access;
    try {
      const webhooks = await webhooksRepository.get(context.user, currentAccess);
      result.webhooks = webhooks.map(forApi);
    } catch (error) {
      return next(errors.unexpectedError(error));
    }
    next();

    function forApi (webhook: any) {
      return webhook.forApi();
    }
  }

  api.register(
    'webhooks.getOne',
    commonFns.getParamsValidation(methodsSchema.get.params),
    findWebhook
  );

  async function findWebhook (context: any, params: any, result: any, next: any) {
    const user = context.user;
    const currentAccess = context.access;
    const webhookId = params.id;
    try {
      const webhook = await webhooksRepository.getById(user, webhookId);
      if (webhook == null) {
        return next(errors.unknownResource('webhook', params.id));
      }
      if (!isWebhookInScope(webhook, currentAccess)) {
        return next(errors.forbidden('The webhook was not created by this access.'));
      }
      result.webhook = webhook.forApi();
    } catch (error) {
      return next(errors.unexpectedError(error));
    }
    next();
  }

  // CREATION

  api.register(
    'webhooks.create',
    commonFns.basicAccessAuthorizationCheck,
    commonFns.getParamsValidation(methodsSchema.create.params),
    createWebhook,
    bootWebhook
  );

  async function createWebhook (context: any, params: any, result: any, next: any) {
    context.initTrackingProperties(params);
    const webhook = new Webhook(Object.assign({
      user: context.user,
      accessId: context.access.id,
      webhooksRepository,
      runsSize: wehbooksSettings.runsSize,
      minIntervalMs: wehbooksSettings.minIntervalMs
    }, params));

    try {
      await webhook.save();
      result.webhook = webhook.forApi();
    } catch (error: any) {
      // Expecting a duplicate error
      if (error.isDuplicateIndex('url')) {
        return next(errors.itemAlreadyExists('webhook', { url: params.url }));
      }
      return next(errors.unexpectedError(error));
    }

    return next();
  }

  async function bootWebhook (context: any, params: any, result: any, next: any) {
    pubsub.webhooks.emit(pubsub.WEBHOOKS_CREATE, Object.assign({ username: context.user.username }, { webhook: result.webhook }));
    return next();
  }

  // UPDATE

  api.register(
    'webhooks.update',
    commonFns.getParamsValidation(methodsSchema.update.params),
    commonFns.catchForbiddenUpdate(webhookSchema('update'), false, logger),
    applyPrerequisitesForUpdate,
    updateWebhook,
    reactivateWebhook
  );

  function applyPrerequisitesForUpdate (context: any, params: any, result: any, next: any) {
    context.updateTrackingProperties(params.update);
    next();
  }

  async function updateWebhook (context: any, params: any, result: any, next: any) {
    const user = context.user;
    const currentAccess = context.access;
    const update = params.update;
    const webhookId = params.id;
    if (update.state === 'active') {
      update.currentRetries = 0;
    }
    try {
      const webhook = await webhooksRepository.getById(user, webhookId);
      if (webhook == null) {
        return next(errors.unknownResource('webhook', params.id));
      }
      if (!isWebhookInScope(webhook, currentAccess)) {
        return next(errors.forbidden('The webhook was not created by this app access.'));
      }
      await webhook.update(update);
      result.webhook = webhook.forApi();
    } catch (e) {
      return next(errors.unexpectedError(e));
    }
    next();
  }

  async function reactivateWebhook (context: any, params: any, result: any, next: any) {
    pubsub.webhooks.emit(pubsub.WEBHOOKS_ACTIVATE, Object.assign({ username: context.user.username }, { webhook: result.webhook }));
    return next();
  }

  // DELETION

  api.register(
    'webhooks.delete',
    commonFns.getParamsValidation(methodsSchema.del.params),
    deleteAccess,
    turnOffWebhook
  );

  async function deleteAccess (context: any, params: any, result: any, next: any) {
    const user = context.user;
    const currentAccess = context.access;
    const webhookId = params.id;
    try {
      const webhook = await webhooksRepository.getById(user, webhookId);
      if (webhook == null) {
        return next(errors.unknownResource('webhook', params.id));
      }
      if (!isWebhookInScope(webhook, currentAccess)) {
        return next(errors.forbidden('The webhook was not created by this app access.'));
      }
      await webhook.delete();
      result.webhookDeletion = {
        id: webhook.id,
        deleted: timestamp.now()
      };
    } catch (e) {
      return next(errors.unexpectedError(e));
    }
    next();
  }

  async function turnOffWebhook (context: any, params: any, result: any, next: any) {
    const username = context.user.username;
    const webhookId = params.id;
    pubsub.webhooks.emit(pubsub.WEBHOOKS_DELETE, {
      username,
      webhook: {
        id: webhookId
      }
    });
    return next();
  }

  // TEST

  api.register(
    'webhooks.test',
    commonFns.getParamsValidation(methodsSchema.test.params),
    testWebhook
  );

  async function testWebhook (context: any, params: any, result: any, next: any) {
    const TEST_MESSAGE = 'test';
    const user = context.user;
    const currentAccess = context.access;
    const webhookId = params.id;
    let webhook: any;
    try {
      webhook = await webhooksRepository.getById(user, webhookId);
      if (webhook == null) {
        return next(errors.unknownResource('webhook', params.id));
      }
      if (!isWebhookInScope(webhook, currentAccess)) {
        return next(errors.forbidden('The webhook was not created by this app access.'));
      }
    } catch (error) {
      return next(errors.unexpectedError(error));
    }
    try {
      await webhook.makeCall([TEST_MESSAGE]);
    } catch (e) {
      return next(errors.unknownReferencedResource('webhook', 'url', webhook.url, e));
    }
    result.webhook = webhook.forApi();
    next();
  }

  /**
   * checks if the webhook is allowed to be handled by the access
   * If Personnal: yes
   * If App: only if it was used to create the webhook
   */
  function isWebhookInScope (webhook: any, access: any) {
    if (access.isPersonal()) { return true; }
    return access.id === webhook.accessId;
  }
};
