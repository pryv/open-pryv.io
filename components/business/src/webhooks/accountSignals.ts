/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The webhooks service holds every webhook in memory, keyed by the username
 * of its account, and listens for that account's changes under that name. It
 * learns of webhooks removed or renamed elsewhere only through the webhooks
 * signals: an account deletion stops each of its webhooks, a username change
 * stops them under the former name and loads them again under the new one.
 */

import { pubsub, WEBHOOKS_CREATE, WEBHOOKS_DELETE } from 'messages';

type WebhooksStorageLike = {
  find (user: { id: string }, query: Record<string, unknown>, options: Record<string, unknown>, cb: (err: unknown, items?: Array<{ id: string }>) => void): void;
};

/** Ids of the webhooks stored for the account. */
async function storedWebhookIds (webhooksStorage: WebhooksStorageLike, userId: string): Promise<string[]> {
  const items: Array<{ id: string }> = await new Promise((resolve, reject) => {
    webhooksStorage.find({ id: userId }, {}, {}, (err, res) => err != null ? reject(err) : resolve(res ?? []));
  });
  return items.map((w) => w.id);
}

/** The account's webhooks are gone: stop them in the webhooks service. */
function signalWebhooksStopped (username: string, webhookIds: string[]): void {
  for (const id of webhookIds) {
    pubsub.webhooks.emit(WEBHOOKS_DELETE, { username, webhook: { id } });
  }
}

/** The account was renamed: stop its webhooks under the former name, load them under the new one. */
function signalWebhooksRenamed (oldUsername: string, newUsername: string, webhookIds: string[]): void {
  signalWebhooksStopped(oldUsername, webhookIds);
  for (const id of webhookIds) {
    pubsub.webhooks.emit(WEBHOOKS_CREATE, { username: newUsername, webhook: { id } });
  }
}

export { storedWebhookIds, signalWebhooksStopped, signalWebhooksRenamed };
