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
 * A method context holding the access whose token is `token` (a webhook's own
 * access) with its permissions, for preparing its scopes whoever makes the
 * call. Server-side: only the checks that do not belong to a request run
 * (validity and expiry, managing access, revoked DPoP key or OAuth client);
 * no proof of possession, session or custom auth step. Throws an API error
 * when the access cannot be used any more.
 */
async function contextForAccess (source: MethodContext['source'], username: string, token: string, storageLayer: unknown): Promise<MethodContext> {
  const context = new MethodContextClass(source, username, token, null, {}, {}, null);
  context.bypassAccessCache = true;
  await context.init();
  await context.retrieveAccessFromToken(storageLayer as Parameters<MethodContext['retrieveAccessFromToken']>[0]);
  await context.checkDpopKeyNotRevoked();
  await context.checkClientNotRevoked();
  if (!context.access!.isPersonal()) await context.access!.loadPermissions();
  return context;
}

type ScopedWebhook = { id: string; accessId: string; scopes?: StoredScopes | null; update: (u: Record<string, unknown>) => Promise<void>; forApi: () => { id: string } };
type WebhooksRepositoryLike = {
  get: (user: { id: string; username: string }, access: { id?: string; isPersonal: () => boolean }) => Promise<ScopedWebhook[]>;
  _findAccess: (user: { id: string; username: string }, accessId: string) => Promise<{ deleted?: unknown; token?: string } | null>;
};

// One pass at a time per user; changes during a pass cost one more pass.
const rescopeInFlight = new Map<string, { again: boolean; running: Promise<void> }>();

/**
 * Resolve the scopes of a user's webhooks again after its stream tree changed
 * (a stream created, moved, trashed or deleted): a scope on a stream covers
 * the children created since. Changed scopes are stored and the running
 * webhook reloaded. An access that can no longer be used is left alone (its
 * update or the fire-time check handles it).
 */
async function rescopeUserWebhooks (source: MethodContext['source'], user: { id: string; username: string }, repository: WebhooksRepositoryLike, storageLayer: unknown): Promise<void> {
  const inFlight = rescopeInFlight.get(user.id);
  if (inFlight != null) { inFlight.again = true; return await inFlight.running; }
  const entry = { again: false, running: Promise.resolve() };
  entry.running = (async () => {
    try {
      do {
        entry.again = false;
        await rescopeUserWebhooksOnce(source, user, repository, storageLayer);
      } while (entry.again);
    } finally {
      rescopeInFlight.delete(user.id);
    }
  })();
  rescopeInFlight.set(user.id, entry);
  return await entry.running;
}

async function rescopeUserWebhooksOnce (source: MethodContext['source'], user: { id: string; username: string }, repository: WebhooksRepositoryLike, storageLayer: unknown): Promise<void> {
  const hooks = (await repository.get(user, { isPersonal: () => true }))
    .filter((w) => w.scopes != null && Object.values(w.scopes).some((s) => s.kind === 'events' || s.kind === 'streams'));
  const contexts = new Map<string, MethodContext | null>();
  for (const hook of hooks) {
    if (!contexts.has(hook.accessId)) {
      const access = await repository._findAccess(user, hook.accessId);
      let ctx: MethodContext | null = null;
      if (access != null && access.deleted == null && typeof access.token === 'string') {
        try { ctx = await contextForAccess(source, user.username, access.token, storageLayer); } catch (err) { ctx = null; }
      }
      contexts.set(hook.accessId, ctx);
    }
    const ctx = contexts.get(hook.accessId);
    if (ctx == null) continue;
    const scopes = await reprepareWebhookScopes(ctx, hook.scopes!);
    if (JSON.stringify(scopes) === JSON.stringify(hook.scopes)) continue;
    const update: Record<string, unknown> = { scopes };
    if (Object.keys(scopes).length === 0) update.state = 'inactive';
    hook.scopes = scopes;
    await hook.update(update);
    reloadRunningWebhook(user.username, hook.forApi());
  }
}

/** Have the webhooks service drop its running copy of a webhook and load the stored one. */
function reloadRunningWebhook (username: string, webhook: { id: string }): void {
  pubsub.webhooks.emit(WEBHOOKS_DELETE, { username, webhook: { id: webhook.id } });
  pubsub.webhooks.emit(WEBHOOKS_CREATE, { username, webhook });
}

export { prepareWebhookScopes, reprepareWebhookScopes, contextForAccess, reloadRunningWebhook, rescopeUserWebhooks };
export type { StoredScopes };
