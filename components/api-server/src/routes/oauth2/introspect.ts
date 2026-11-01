/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 glue for token introspection (`POST /oauth2/introspect`, RFC 7662):
 *
 *   - `introspectAccess`: the session as the home core sees it, re-read from
 *     this core's storage: live, unexpired, and its consent grant still live;
 *     null otherwise.
 *   - `coreUrlFor`: the public URL of a core, for the wrong-core answer.
 */

import type { DataGrant, GlueEnv } from './types.ts';
import { ApiEndpoint } from 'utils';
import { getPlatform } from 'platform';

/** The session glue introspection reads through (see sessions.ts). */
type SessionReads = {
  resolveUsername: (userId: string) => Promise<string | null>;
  findOAuthSessionAccess: (userId: string, username: string, accessId: string, clientId: string) => Promise<DataGrant | null>;
  readDataGrantHead: (userId: string, username: string, dataGrantAccessId: string) => Promise<DataGrant>;
  grantSubject: (grant: DataGrant, userId: string) => { subject: string; aliased: boolean };
  storedSessionPermissions: (permissions: Array<Record<string, unknown>> | null | undefined) => Array<Record<string, unknown>>;
};

export function createIntrospect (_env: GlueEnv, sessions: SessionReads) {
  async function introspectAccess ({ userId, accessId, clientId, dataGrantAccessId }: {
    userId: string; accessId: string; clientId: string; dataGrantAccessId?: string;
  }): Promise<{
    permissions: Array<Record<string, unknown>>;
    created: number;
    expires: number;
    subject: string | null;
    apiBase: string;
    dpopJkt?: string;
  } | null> {
    const username = await sessions.resolveUsername(userId);
    if (username == null) return null;
    const access = await sessions.findOAuthSessionAccess(userId, username, accessId, clientId);
    const now = Date.now() / 1000;
    if (access == null || access.deleted != null || typeof access.expires !== 'number' || access.expires <= now) return null;
    let subject: string | null = null;
    // The account's API base URL, without any credential: built on the
    // grant's alias when it has one, so an aliased grant never names the user.
    let apiBaseName = username;
    const grantId = dataGrantAccessId ?? access.clientData?.oauth?.dataGrantId;
    if (grantId != null) {
      try {
        const s = sessions.grantSubject(await sessions.readDataGrantHead(userId, username, grantId), userId);
        subject = s.subject;
        if (s.aliased) apiBaseName = s.subject;
      } catch (err: unknown) {
        if ((err as { code?: string } | null)?.code === 'data-grant-revoked') return null;
        throw err;
      }
    }
    return {
      // The same echo input as at the code exchange and at refresh: the
      // stored row, canonical, without the session's selfRevoke override.
      permissions: sessions.storedSessionPermissions(access.permissions),
      created: typeof access.created === 'number' ? access.created : 0,
      expires: access.expires,
      subject,
      apiBase: ApiEndpoint.build(apiBaseName, undefined),
      ...(typeof access.clientData?.dpop?.jkt === 'string' ? { dpopJkt: access.clientData.dpop.jkt } : {}),
    };
  }

  async function coreUrlFor (coreId: string): Promise<string> {
    const platform = await getPlatform();
    return platform.coreIdToUrl(coreId);
  }

  return { introspectAccess, coreUrlFor };
}
