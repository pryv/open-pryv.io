/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { MethodContext as MethodContextClass } from 'business/src/MethodContext.ts';
import type { MethodContext } from 'business/src/MethodContext.ts';
import { factory as errors } from 'errors';
import { pubsub, WEBHOOKS_CREATE, WEBHOOKS_DELETE } from 'messages';
import { prepareScopeQuery, prepareAccessScopeQuery } from './scopeQueryUtils.ts';

type StoredScopes = Record<string, { kind: string; query: unknown; prepared: unknown }>;

// Validate + prepare a raw webhook scopes map { key -> { kind, query } } into
// the stored form { key -> { kind, query, prepared } }. Stream resolution
// (permission check + recursive expansion) is bound to the access of
// `context`. Throws on an invalid/unauthorized scope.
async function prepareWebhookScopes (context: MethodContext, rawScopes: unknown): Promise<StoredScopes | undefined> {
  if (rawScopes == null) return undefined;
  if (typeof rawScopes !== 'object') throw errors.invalidRequestStructure('"scopes" must be an object of named scopes.');
  const out: StoredScopes = {};
  for (const [key, raw] of Object.entries(rawScopes as Record<string, { kind?: string; query?: unknown }>)) {
    const kind = raw?.kind ?? 'events';
    const query = raw?.query ?? {};
    let prepared;
    if (kind === 'events' || kind === 'streams') {
      prepared = await prepareScopeQuery(context, query as Record<string, unknown>);
    } else if (kind === 'accesses') {
      prepared = await prepareAccessScopeQuery(context, query as Record<string, unknown>);
    } else {
      throw errors.invalidRequestStructure(`scope '${key}': kind '${kind}' is not yet supported`);
    }
    out[key] = { kind, query, prepared };
  }
  return out;
}

/**
 * Re-prepare stored scopes against the access of `context` (after the access
 * changed). A scope now out of reach is dropped; the others are resolved
 * again (a narrowed access matches fewer streams).
 */
async function reprepareWebhookScopes (context: MethodContext, stored: StoredScopes): Promise<StoredScopes> {
  const kept: StoredScopes = {};
  for (const [key, s] of Object.entries(stored)) {
    try {
      const one = await prepareWebhookScopes(context, { [key]: { kind: s.kind, query: s.query } });
      if (one != null) kept[key] = one[key];
    } catch (err) {
      // out of the access's reach now: dropped
    }
  }
  return kept;
}

/**
 * A method context authenticated with the access holding `token` (a webhook's
 * own access), for preparing its scopes whoever makes the call. Throws when
 * the access cannot be used any more.
 */
async function contextForAccess (source: MethodContext['source'], username: string, token: string, storageLayer: unknown): Promise<MethodContext> {
  const context = new MethodContextClass(source, username, token, null, {}, {}, null);
  context.bypassAccessCache = true;
  await context.init();
  await context.retrieveExpandedAccess(storageLayer as Parameters<MethodContext['retrieveExpandedAccess']>[0]);
  return context;
}

/** Have the webhooks service drop its running copy of a webhook and load the stored one. */
function reloadRunningWebhook (username: string, webhook: { id: string }): void {
  pubsub.webhooks.emit(WEBHOOKS_DELETE, { username, webhook: { id: webhook.id } });
  pubsub.webhooks.emit(WEBHOOKS_CREATE, { username, webhook });
}

export { prepareWebhookScopes, reprepareWebhookScopes, contextForAccess, reloadRunningWebhook };
export type { StoredScopes };
