/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Stored domain shapes — what flows through the storage interfaces and the
 * mall (post wire-normalization, pre engine-row conversion).
 *
 * These deliberately differ from the API wire types in
 * `components/business/src/types/public.ts` (`Event`, `Access`, `Stream`):
 * stored shapes carry storage-only fields (`headId`, `deleted`, `endTime`,
 * versioning serials, integrity batch codes) and keep most fields optional
 * because partial records are first-class here — deletion records carry only
 * `{ id, deleted }`, and update paths flow `Partial<StoredXxx>`.
 *
 * Engine row shapes (`XxxRow`, snake_case columns / data-JSON packing) stay
 * per-engine; `toDB`/`fromDB` converters translate row ↔ stored.
 */

// ───────────────────────────── Events ─────────────────────────────

export type StoredAttachment = {
  id?: string;
  fileName?: string;
  type?: string;
  size?: number;
  readToken?: string;
  integrity?: string;
};

export type StoredEvent = {
  id: string;
  streamIds?: string[];
  type?: string;
  time?: number;
  duration?: number | null;
  /** Materialized `time + duration` (storage-side only; wire exposes `duration`). */
  endTime?: number | null;
  content?: unknown;
  description?: string | null;
  clientData?: Record<string, unknown> | null;
  trashed?: boolean;
  deleted?: number | null;
  /** Versioning: set on history snapshots, null/absent on head rows. */
  headId?: string | null;
  attachments?: StoredAttachment[];
  integrity?: string | null;
  created?: number;
  createdBy?: string;
  modified?: number;
  modifiedBy?: string;
};

// ───────────────────────────── Streams ─────────────────────────────

export type StoredStream = {
  id: string;
  name?: string;
  parentId?: string | null;
  clientData?: Record<string, unknown> | null;
  children?: StoredStream[];
  childrenHidden?: boolean;
  trashed?: boolean;
  deleted?: number | null;
  created?: number;
  createdBy?: string;
  modified?: number;
  modifiedBy?: string;
};

// ───────────────────────────── Accesses ─────────────────────────────

/** Storage-side permission entry. The wire union (`StreamPermission |
 *  FeaturePermission`) lives in business types; storage keeps the fields
 *  flat and optional since both variants land in the same column. */
export type StoredPermission = {
  streamId?: string;
  level?: string;
  defaultName?: string;
  name?: string;
  feature?: string;
  setting?: string;
};

export type StoredAccess = {
  id: string;
  token?: string;
  type?: string;
  name?: string;
  deviceName?: string | null;
  permissions?: StoredPermission[];
  lastUsed?: number | null;
  expireAfter?: number | null;
  expires?: number | null;
  deleted?: number | null;
  clientData?: Record<string, unknown> | null;
  apiEndpoint?: string;
  /** Versioning: set on history snapshots, null/absent on head rows. */
  headId?: string | null;
  integrity?: string | null;
  /** Transient marker used while batch-recomputing integrity. */
  integrityBatchCode?: number;
  calls?: Record<string, number>;
  /** Versioning: monotonically increasing version number on the head row. */
  serial?: number;
  created?: number;
  createdBy?: string;
  createdBySerial?: number | null;
  modified?: number;
  modifiedBy?: string;
  modifiedBySerial?: number | null;
};

// ───────────────────────────── Sessions ─────────────────────────────

/** Session payload as written by login (`{ username, appId }`); kept open
 *  because the Sessions contract is content-agnostic. */
export type SessionData = { username?: string; appId?: string } & Record<string, unknown>;

export type Session = {
  id: string;
  data: SessionData;
  /** Expiry timestamp (ms since epoch at the interface level; engines may
   *  store Date or integer internally). */
  expires: number;
};

// ───────────────────────── Password reset ─────────────────────────

export type PasswordResetRequest = {
  id: string;
  username: string;
  /** Expiry timestamp (ms since epoch at the interface level). */
  expires: number;
};
