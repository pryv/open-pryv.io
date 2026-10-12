/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { MethodContext } from 'business/src/MethodContext.ts';
import type { CustomAuthFunction } from 'business/src/MethodContext.ts';
import { getUsersRepository } from 'business/src/users/index.ts';
import { getConfigSync } from '@pryv/boiler';

type Api = { call: (context: MethodContext, params: unknown, callback: (err: unknown, result: unknown) => void) => void };
type NetworkFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The account a URL built from `service:api` addresses, and the rest of its
 * path: `https://alice.example.com/events` or `https://core.example.com/alice/events`
 * -> `{ username: 'alice', path: 'events' }`. Null for any other URL.
 */
function accountUrlParts (url: string, apiFormat: string): { username: string; path: string } | null {
  const marker = '{username}';
  const at = apiFormat.indexOf(marker);
  if (at < 0) return null;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('^' + escape(apiFormat.slice(0, at)) + '([a-z0-9][a-z0-9-]*)' + escape(apiFormat.slice(at + marker.length)) + '(.*)$', 'i');
  const m = pattern.exec(url);
  return m == null ? null : { username: m[1].toLowerCase(), path: m[2] };
}

/**
 * A `fetch` for deliveries to accounts: an `events` POST to an account hosted
 * on this core runs in-process (`events.create`, authenticated with the same
 * token, through the whole method chain) instead of going out to the core's
 * own public URL and back; anything else goes to the network.
 */
function localFirstFetch (api: Api, storageLayer: unknown, networkFetch: NetworkFetch = (url, init) => globalThis.fetch(url, init)): NetworkFetch {
  return async function (url: string, init?: RequestInit): Promise<Response> {
    const apiFormat = getConfigSync().get('service:api') as string | undefined;
    const parts = typeof apiFormat === 'string' ? accountUrlParts(url, apiFormat) : null;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (parts == null || parts.path !== 'events' || method !== 'POST') return await networkFetch(url, init);
    const usersRepository = await getUsersRepository();
    if ((await usersRepository.getUserIdForUsername(parts.username)) == null) return await networkFetch(url, init);

    const headers = new Headers(init?.headers);
    // The custom auth step the HTTP path would run (resolved per call: the
    // application registers it at boot).
    const { getApplication } = await import('api-server/src/application.ts');
    const customAuthStepFn = getApplication().getCustomAuthFunction('server.js') as CustomAuthFunction | null;
    const context = new MethodContext({ name: 'http' }, parts.username, headers.get('authorization'), customAuthStepFn, {}, {}, null);
    try {
      await context.init();
      await context.retrieveExpandedAccess(storageLayer as Parameters<MethodContext['retrieveExpandedAccess']>[0]);
      context.methodId = 'events.create';
      const params = JSON.parse(String(init?.body ?? '{}'));
      const result = await new Promise((resolve, reject) => {
        api.call(context, params, (err, res) => err != null ? reject(err) : resolve(res));
      });
      return Response.json(toPlain(result), { status: 201 });
    } catch (err) {
      const e = err as { httpStatus?: number; id?: string; message?: string };
      return Response.json({ error: { id: e?.id ?? 'unexpected-error', message: e?.message ?? String(err) } }, { status: e?.httpStatus ?? 500 });
    }
  };
}

// An API result may hold streams to pipe; a delivery reads only the JSON fields.
function toPlain (result: unknown): unknown {
  if (result == null || typeof result !== 'object') return result;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (typeof v !== 'function' && !(v != null && typeof (v as { pipe?: unknown }).pipe === 'function')) out[k] = v;
  }
  return out;
}

export { localFirstFetch, accountUrlParts };
