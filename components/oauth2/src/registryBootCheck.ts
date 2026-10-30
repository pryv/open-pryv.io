/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: boot pass over the registry clients.
 *
 * Registry rows are written by the operator CLI, a process that does not load
 * the OAuth extension, so their maximum scope set (in the extension's grammar)
 * is first checked here, when the core starts: a row the grammar refuses is
 * reported with a warning naming the client (its /oauth2/authorize then
 * answers `invalid_scope`). A client registered for plain-http redirects on
 * a non-loopback host, or stored without a subject type, is reported too.
 * Never fails the boot: one bad client
 * must not take the core down.
 */

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthClient } from './storage.ts';
import * as storage from './storage.ts';
import { checkMaxSet } from './scopeGrammar.ts';
import { insecureRedirectUris } from './clientRegistry.ts';
import { logServerWarning } from './serverLog.ts';

/** Check every registry client of the platform. Resolves to the number of warnings. */
export async function checkRegistryClients (platform: PlatformDB): Promise<number> {
  let warnings = 0;
  if (typeof platform?.listPlatformKvKeys !== 'function') return 0; // a partial store (tests)
  const ids: string[] = await storage.listClientIds(platform);
  for (const id of ids) {
    let client: OAuthClient | null;
    try {
      client = await storage.getClient(platform, id);
    } catch {
      continue;
    }
    if (client == null || client.kind !== 'registry') continue;
    const max = checkMaxSet(client);
    if (!max.ok) {
      warnings++;
      logServerWarning(`oauth registry client ${id}: its registered scope ${max.description}; /oauth2/authorize will refuse it (invalid_scope)`);
    }
    if (client.subjectType == null) {
      warnings++;
      logServerWarning(`oauth registry client ${id}: no subject type registered, read as public (set it with the operator CLI update --subject-type)`);
    }
    const insecure = insecureRedirectUris(client.redirectUris);
    if (insecure.length > 0) {
      warnings++;
      logServerWarning(client.allowInsecureRedirect === true
        ? `oauth registry client ${id}: registered with plain-http redirect URIs on a non-loopback host (${insecure.join(', ')})`
        : `oauth registry client ${id}: plain-http redirect URIs on a non-loopback host (${insecure.join(', ')}) stored without the insecure-redirect registration (a row written before the rule; update it)`);
    }
  }
  return warnings;
}
