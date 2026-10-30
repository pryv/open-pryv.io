/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 glue: shapes and small pure helpers shared by the glue modules
 * (`grants.ts`, `sessions.ts`, `revoke.ts`) and the mount (`../oauth2.ts`).
 */

import type { Permission } from 'business/src/types/public.ts';
import { permissionKey } from 'business/src/accesses/permissionSet.ts';

/**
 * Structural view of the members this module touches on a business
 * MethodContext (the runtime value comes from `require('business')`, which
 * is untyped through the createRequire shim). Modelling the used surface
 * keeps the wiring off `any` without importing the full class type.
 */
export type Ctx = {
  methodId: string | null;
  user: { id: string; username: string };
  access: unknown;
  init: () => Promise<void>;
  retrieveExpandedAccess: (storage: unknown) => Promise<void>;
};

/** The API-method result shape this module reads (method-dependent, partial). */
export type OAuthMethodResult = {
  access?: DataGrant & { token?: unknown; apiEndpoint?: unknown };
  accesses?: DataGrant[];
  event?: { id?: unknown; content?: Record<string, unknown> };
};

/** Run an API method on an already-authenticated context. */
export type ApiCall = (context: Ctx, methodId: string, params: Record<string, unknown>) => Promise<OAuthMethodResult>;

/** The signed CMC offer material an /accept carries (see the oauth2 component). */
export type CmcOffer = {
  offerName: string;
  capabilityUrl: string;
  capabilityId: string | null;
  offerEventId: string | null;
  permissions: Array<Record<string, unknown>>;
};

/** A data-grant (or session) access row, as read back from accesses.get / findOne. */
export type DataGrant = {
  id: string;
  type?: string;
  name?: string;
  deviceName?: string | null;
  alias?: string | null;
  created?: number;
  createdBy?: unknown;
  token?: unknown;
  permissions?: Array<Record<string, unknown>>;
  deleted?: unknown;
  expires?: number | null;
  // Widened vs the narrow role/offer view: reuse-detection reads the CMC
  // counterparty back-channel address off the data-grant to notify the app.
  clientData?: {
    oauth?: { grantOf?: string; dataGrantId?: string };
    dpop?: { jkt?: string };
    cmc?: {
      role?: string;
      offerEventId?: string;
      acceptEventId?: string;
      counterparty?: { apiEndpoint?: string };
      backChannelApiEndpoint?: string;
    }
  };
};

/** The storage-layer accesses repository surface the glue calls directly. */
export type AccessesRepo = {
  findOne: (user: { id: string; username: string }, query: Record<string, unknown>, opts: unknown, cb: (err: unknown, found: DataGrant | null) => void) => void;
  find: (user: { id: string; username: string }, query: Record<string, unknown>, opts: unknown, cb: (err: unknown, found: DataGrant[] | null) => void) => void;
  delete: (user: { id: string; username: string }, query: Record<string, unknown>, cb: (err: unknown) => void) => void;
  insertOne: (user: { id: string; username: string }, row: Record<string, unknown>, cb: (err: unknown, created: { id?: unknown; token?: unknown } | null) => void) => void;
  updateOne: (user: { id: string; username: string }, query: Record<string, unknown>, update: Record<string, unknown>, cb: (err: unknown) => void) => void;
  generateToken: () => string;
};

/** What every glue module receives from the mount. */
export type GlueEnv = {
  config: { get (key: string): unknown };
  storageLayer: unknown;
  logger: { warn: (...a: unknown[]) => void; debug: (...a: unknown[]) => void; info: (...a: unknown[]) => void };
  apiCall: ApiCall;
};

/**
 * Session-credential selfRevoke override, applied at every session-access
 * mint (accept-time pre-mint + refresh-rotation re-mint). The offer's
 * `selfRevoke` feature binds the DURABLE consent capability (the data-grant),
 * not the ephemeral session credential: a client may always revoke its own
 * token, and the server itself relies on that to delete a pre-minted access
 * whose authorization code dies unexchanged. Any inherited `selfRevoke` entry
 * is replaced with an explicit allow; all other permissions pass through
 * verbatim. The data-grant keeps the offer's feature permissions untouched.
 * Other feature entries (e.g. `webhooks: forbidden`) bind the session
 * credential too, on purpose: only `selfRevoke` is overridden here.
 */
export function withSessionSelfRevoke (permissions: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return permissions
    .filter((p) => p.feature !== 'selfRevoke')
    .concat([{ feature: 'selfRevoke', setting: 'allowed' }]);
}

/**
 * Whether two permission sets hold the same entries (order and display names
 * ignored). A set whose duplicate entries a merge collapsed compares as
 * changed, so the merge result is written.
 */
export function samePermissionKeys (a: Array<Record<string, unknown>>, b: Array<Record<string, unknown>>): boolean {
  const key = (p: Record<string, unknown>): string => permissionKey(p as unknown as Permission);
  const ka: string[] = a.map(key);
  const kb = new Set<string>(b.map(key));
  return ka.length === kb.size && new Set(ka).size === kb.size && ka.every((k) => kb.has(k));
}

/** The storage-layer accesses repository, or a throw naming the caller. */
export function accessesRepo (storageLayer: unknown, caller: string): AccessesRepo {
  const repo = (storageLayer as { accesses?: AccessesRepo })?.accesses;
  if (repo == null) throw new Error(caller + ': storageLayer.accesses unavailable');
  return repo;
}
