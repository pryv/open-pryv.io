/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: `POST /oauth2/clients/validation` handler.
 *
 * Who vouches for the apps an account granted, as of now: the account's
 * screens show it beside the level stamped at consent
 * (`clientData.oauth.client.validation.level`), and tell the user when an app
 * lost its validation or is no longer served since.
 *
 * Signed in with the account's PERSONAL token (`username` + `userToken` in
 * the body, or the token in the `Authorization` header), body
 * `{ clientIds: [...] }` (at most `MAX_CLIENT_IDS`, the stored client ids the
 * accesses are named after: `oauth-grant:<clientId>`, `oauth:<clientId>`).
 * Answers `{ clients: { <clientId>: { level, publisher?, validatedAt?, served } } }`
 * (the block of the consent offer, plus `served: false` when the client is
 * refused now: suspended, under review, not served on this core or by its
 * level's policy) for each id one of the account's accesses is named after;
 * any other id (unknown, removed or held by no access of the account) is left
 * out, with nothing telling these apart: the route lists no client the
 * account did not grant. Not audited (a read of review state by the account
 * that granted the app). An account served by another core answers 421
 * `wrong_core` with that core's URL (see wrongCore.ts).
 */

import type { Request, Response } from 'express';
import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { ClientValidation } from '../clientValidation.ts';
import { clientPolicy } from '../clientValidation.ts';
import { getClient, clientUnavailable } from '../clientRegistry.ts';
import type { WrongCoreSession } from '../wrongCore.ts';
import { isWrongCoreSession, wrongCoreBody } from '../wrongCore.ts';

/** Bound on the client ids of one request. */
export const MAX_CLIENT_IDS = 50;
/** Bound on one client id (a stored id is far shorter). */
const MAX_CLIENT_ID_LENGTH = 256;

/** A signed-in account, as the host app's resolver answers it. */
export type ValidationSession = {
  userId: string;
  username: string;
  /** The token is a personal one (only those may read the account's apps). */
  personal?: boolean;
  /** Host-app data piggybacked (e.g. the MethodContext). */
  _context?: unknown;
};

export type ClientsValidationDeps = {
  config: { get (key: string): unknown };
  platform: PlatformDB;
  resolveUser: (params: { username: string; userToken: string }) =>
  Promise<ValidationSession | { refused: true; description: string } | WrongCoreSession | null>;
  /** The stored ids of the clients the account's accesses are named after. */
  listHeldClientIds: (session: ValidationSession) => Promise<Iterable<string>>;
};

/** What the route answers for one client. */
export type CurrentClientValidation = ClientValidation & { served: boolean };

const PERSONAL_TOKEN_REQUIRED = 'a personal token of the account is required';

function tokenOf (req: Request, body: Record<string, unknown>): string | null {
  if (typeof body.userToken === 'string' && body.userToken.length > 0) return body.userToken;
  const header = req.headers?.authorization;
  return typeof header === 'string' && header.length > 0 ? header : null;
}

function clientIdsProblem (v: unknown): string | null {
  if (!Array.isArray(v)) return 'clientIds must be an array of client ids';
  if (v.length > MAX_CLIENT_IDS) return `clientIds may list at most ${MAX_CLIENT_IDS} client ids`;
  for (const id of v) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_CLIENT_ID_LENGTH) return 'clientIds must list non-empty client ids';
  }
  return null;
}

export function handleClientsValidation (deps: ClientsValidationDeps) {
  return async function clientsValidation (req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const problem = clientIdsProblem(body.clientIds);
    if (problem != null) return sendJson(res, 400, { error: 'invalid_request', error_description: problem });
    const userToken = tokenOf(req, body);
    if (typeof body.username !== 'string' || body.username.length === 0 || userToken == null) {
      return sendJson(res, 401, { error: 'invalid_request', error_description: 'username and a personal token of the account are required' });
    }
    let s: ValidationSession | { refused: true; description: string } | WrongCoreSession | null;
    try {
      s = await deps.resolveUser({ username: body.username, userToken });
    } catch {
      s = null;
    }
    if (s == null) {
      return sendJson(res, 401, { error: 'invalid_request', error_description: 'username + userToken did not resolve to a valid user session' });
    }
    if (isWrongCoreSession(s)) return sendJson(res, 421, wrongCoreBody(s));
    if ((s as { refused?: unknown }).refused === true || (s as ValidationSession).personal !== true) {
      return sendJson(res, 403, { error: 'access_denied', error_description: PERSONAL_TOKEN_REQUIRED });
    }
    const session = s as ValidationSession;
    const held = new Set(await deps.listHeldClientIds(session));
    const wanted = [...new Set(body.clientIds as string[])].filter((id) => held.has(id));
    const answers = await Promise.all(wanted.map(async (clientId): Promise<[string, CurrentClientValidation] | null> => {
      const client = await getClient(deps.platform, clientId);
      if (client == null) return null;
      const { validation, refused } = await clientPolicy(deps.platform, deps.config, client);
      return [clientId, { ...validation, served: refused == null && clientUnavailable(client, deps.config) == null }];
    }));
    const clients: Record<string, CurrentClientValidation> = {};
    for (const a of answers) if (a != null) clients[a[0]] = a[1];
    return sendJson(res, 200, { clients });
  };
}

function sendJson (res: Response, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
