/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import * as cmc from 'cmc';
import { getConfig, getLogger } from '@pryv/boiler';
import { getUsersRepository } from 'business/src/users/index.ts';
import { buildMallForCmc } from './cmcMall.ts';

import type { MemberSweep } from 'cmc/src/memberSweep.ts';

/**
 * The identity this core presents to a counterparty for an account:
 * `{ username, host }`. Shared by the dispatch wiring (events.ts) and the
 * member sweep (this file).
 *
 * host, in priority order: `dns:domain` (multi-core deploys serve from
 * `<id>.<domain>`; the bare domain is the counterparty-facing identity);
 * the host of `service:api` or `service:register` (a real URL); `localhost`
 * as the last-resort dev fallback. `service:name` is a human label, never a
 * host (the slug builder rejects spaces).
 */
async function cmcSelfIdentityFor (userId: string): Promise<{ username: string; host: string }> {
  const config = await getConfig();
  const usersRepository = await getUsersRepository();
  const user = await usersRepository.getUserById(userId);
  const username = user?.username || 'unknown';
  let host = config.get('dns:domain') as string | undefined;
  if (host == null || host === '') {
    const apiUrl = (config.get('service:api') || config.get('service:register')) as string | undefined;
    if (typeof apiUrl === 'string' && apiUrl.length > 0) {
      try {
        const u = new URL(apiUrl.replace('{username}', 'x'));
        host = u.host;
      } catch (_e) { /* fall through to localhost */ }
    }
  }
  if (host == null || host === '') host = 'localhost';
  return { username, host };
}

/**
 * The group-account sweep (cmc/src/memberSweep.ts), built once: it dispatches
 * the server-written offboarding records through the CMC dispatch with the
 * same deps as a trigger written by a client (minus the request-bound ones),
 * and reaches patient cores with the lazily resolved global fetch so an
 * in-process test shim installed after registration is honoured.
 */
let cached: MemberSweep | null = null;

async function buildMemberSweep (): Promise<MemberSweep> {
  if (cached != null) return cached;
  const mall = await buildMallForCmc();
  const logger = getLogger('cmc:member-sweep');
  const fetch = (url: string, init?: RequestInit) => globalThis.fetch(url, init);
  const dispatchDeps = {
    mall,
    fetch,
    timeoutMs: 15_000,
    logger: getLogger('cmc:dispatch'),
    selfIdentityFor: cmcSelfIdentityFor,
  };
  const built: MemberSweep = cmc.createMemberSweep({
    mall,
    fetch,
    timeoutMs: 15_000,
    logger,
    dispatch: cmc.dispatch.dispatch,
    dispatchDeps,
  });
  cached = built;
  return built;
}

export { buildMemberSweep, cmcSelfIdentityFor };
