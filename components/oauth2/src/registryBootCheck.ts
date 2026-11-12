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
import { checkMaxSet, canonicalJson } from './scopeGrammar.ts';
import { insecureRedirectUris } from './clientRegistry.ts';
import { validatePublicJwkSet } from './jwks.ts';
import { logServerWarning } from './serverLog.ts';
import { audienceBoundSessions } from './audienceBinding.ts';
import { clientMetadataSettings } from './clientMetadataConfig.ts';

/**
 * Check every registry client of the platform. Resolves to the number of
 * warnings. With `config`, two platform-wide lines, each reported once:
 * - `oauth:audienceBoundSessions` is false while a client may exchange
 *   tokens: the tokens issued for a resource server also work directly at
 *   the data API;
 * - it is true (the default) while a client may obtain tokens for a resource
 *   server and no client may exchange: those tokens are refused at the data
 *   API and no resource server can exchange them. Coarse on purpose (any
 *   exchanger at all, not audience by audience): a heads-up, not a rule.
 */
export async function checkRegistryClients (platform: PlatformDB, config?: { get (key: string): unknown }): Promise<number> {
  let warnings = 0;
  if (typeof platform?.listPlatformKvKeys !== 'function') return 0; // a partial store (tests)
  const ids: string[] = await storage.listClientIds(platform);
  const exchanging: string[] = [];
  const withAudience: string[] = [];
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
    if (client.anyAudience === true || (Array.isArray(client.allowedAudiences) && client.allowedAudiences.length > 0)) withAudience.push(id);
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
  if (config != null) {
    const bound = audienceBoundSessions(config);
    if (!bound && exchanging.length > 0) {
      warnings++;
      logServerWarning(`oauth registry client(s) ${exchanging.join(', ')} may exchange tokens, but oauth.audienceBoundSessions is false ` +
        'on this core: the tokens issued for a resource server also work directly at the data API. Remove the setting (true is the ' +
        'default) once every resource server exchanges.');
    }
    if (bound && withAudience.length > 0 && exchanging.length === 0) {
      warnings++;
      logServerWarning(`oauth registry client(s) ${withAudience.join(', ')} may obtain tokens for a resource server, but no client is ` +
        'registered for token exchange: a token issued for a resource server is refused at the data API ' +
        '(oauth.audienceBoundSessions is true) and no resource server can exchange it. Tokens obtained without aud / resource, ' +
        'and resource servers that only introspect, are not affected. Register the resource server with --can-exchange if it ' +
        'reads this API, or set oauth.audienceBoundSessions: false on this core while it does not exchange yet.');
    }
  }
  return warnings;
}

/**
 * The template of metadata-document clients (`oauth.clientMetadataDocuments
 * .client`), checked like a registry row's maximum scope set against the
 * installed grammar. A template the grammar refuses is reported (every such
 * client's /oauth2/authorize then answers `invalid_scope`), never fatal.
 * Returns the number of warnings (0 or 1).
 */
export function checkClientMetadataTemplate (config: { get (key: string): unknown }): number {
  const settings = clientMetadataSettings(config);
  if (settings.mode === 'off') return 0;
  const t = settings.client;
  const probe = {
    // One id per template, so the grammar's memo never answers for another.
    clientId: 'metadata-document-template-' + canonicalJson(t).length + '-' + t.scope.join('+'),
    kind: 'registry',
    redirectUris: ['https://client.invalid/cb'],
    grantTypes: ['authorization_code'],
    scope: t.scope,
    allowedAudiences: t.allowedAudiences,
    launchTypes: t.launchTypes,
    subjectType: t.subjectType,
    updatedAt: 0,
  } as OAuthClient;
  let max: ReturnType<typeof checkMaxSet>;
  try {
    max = checkMaxSet(probe);
  } catch (err) {
    max = { ok: false, description: 'could not be checked: ' + (err as Error).message };
  }
  if (max.ok) return 0;
  logServerWarning(`oauth.clientMetadataDocuments.client: its scope ${max.description}; /oauth2/authorize will refuse every ` +
    'metadata-document client (invalid_scope) until the template is fixed');
  return 1;
}
