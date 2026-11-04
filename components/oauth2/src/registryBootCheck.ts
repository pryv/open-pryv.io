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
 * a non-loopback host, or stored without a subject type, is reported too, and
 * so is any client whose inline key set no longer passes the key rules (for
 * instance several keys without a distinct `kid` each).
 * Never fails the boot: one bad client
 * must not take the core down.
 */

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthClient } from './storage.ts';
import * as storage from './storage.ts';
import { checkMaxSet } from './scopeGrammar.ts';
import { insecureRedirectUris } from './clientRegistry.ts';
import { validatePublicJwkSet } from './jwks.ts';
import { logServerWarning } from './serverLog.ts';

/**
 * Check every registry client of the platform. Resolves to the number of
 * warnings. With `config`: a client registered for token exchange while this
 * core still accepts at the data API the tokens issued for a resource server
 * (`oauth:audienceBoundSessions` not on) is reported once.
 */
export async function checkRegistryClients (platform: PlatformDB, config?: { get (key: string): unknown }): Promise<number> {
  let warnings = 0;
  if (typeof platform?.listPlatformKvKeys !== 'function') return 0; // a partial store (tests)
  const ids: string[] = await storage.listClientIds(platform);
  const exchanging: string[] = [];
  for (const id of ids) {
    let client: OAuthClient | null;
    try {
      client = await storage.getClient(platform, id);
    } catch {
      continue;
    }
    if (client == null) continue;
    // Any client kind: an inline key set written before the current rules
    // (several keys without a distinct kid each) refuses every assertion.
    if (client.jwks != null) {
      try {
        validatePublicJwkSet(client.jwks);
      } catch (err) {
        warnings++;
        logServerWarning(`oauth client ${id}: inline key set refused (${(err as Error).message}); its private_key_jwt assertions ` +
          'are refused until the set is registered again with a distinct kid on every key (operator CLI update --jwks-file)');
      }
    }
    if (client.kind !== 'registry') continue;
    if (client.canExchange === true) exchanging.push(id);
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
  if (config != null && exchanging.length > 0 && config.get('oauth:audienceBoundSessions') !== true) {
    warnings++;
    logServerWarning(`oauth registry client(s) ${exchanging.join(', ')} may exchange tokens, but this core still accepts at its data API ` +
      'the tokens issued for a resource server (oauth.audienceBoundSessions is not true): set it once those resource servers exchange');
  }
  return warnings;
}
