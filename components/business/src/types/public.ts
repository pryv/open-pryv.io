/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Public TypeScript types for Pryv.io API consumers.
 *
 * SDK consumers (lib-js, app-web-auth3, external integrators) can
 * `import type { Event, Stream, Access } from 'pryv-io'` instead of
 * duplicating shapes.
 */

// ───────────────────────────── Events ─────────────────────────────

export type StreamQuery = {
  any: Array<string>;
  all?: Array<string>;
  not?: Array<string>;
};

export type StreamQueryWithStoreId = StreamQuery & {
  storeId: string;
};

export type Attachment = {
  id: string;
  fileName: string;
  type: string;
  size: number;
  readToken: string;
  integrity: string;
};

export type Event = {
  id: string;
  streamIds: Array<string>;
  type: string;
  time: number;
  duration?: number | null;
  content: unknown;
  description?: string | null;
  attachments?: Array<Attachment>;
  clientData?: Record<string, unknown>;
  trashed?: boolean;
  integrity?: string;
  created: number;
  createdBy: string;
  modified: number;
  modifiedBy: string;
};

// ───────────────────────────── Streams ─────────────────────────────

export type Stream = {
  id: string;
  name: string;
  parentId?: string | null;
  clientData?: Record<string, unknown> | null;
  children?: Array<Stream> | null;
  trashed?: boolean | null;
  created: number;
  createdBy: string;
  modified: number;
  modifiedBy: string;
  childrenHidden?: boolean | null;
};

// ───────────────────────────── Accesses ─────────────────────────────

export type PermissionLevel = 'read' | 'contribute' | 'manage' | 'create-only' | 'none';

export type StreamPermission = {
  streamId: string;
  level: PermissionLevel;
  defaultName?: string;
  name?: string;
};

export type FeaturePermission = {
  feature: string;
  setting: string;
};

export type Permission = StreamPermission | FeaturePermission;

export type AccessType = 'personal' | 'app' | 'shared';

export type Access = {
  id: string;
  token: string;
  type: AccessType;
  name: string;
  permissions: Array<Permission>;
  expires?: number | null;
  clientData?: Record<string, unknown> | null;
  apiEndpoint?: string;
  created: number;
  createdBy: string;
  modified: number;
  modifiedBy: string;
};

// ───────────────────────────── Webhooks ─────────────────────────────

export type WebhookState = 'active' | 'inactive';

export type WebhookRun = {
  status: number;
  timestamp: number;
};

export type Webhook = {
  id: string;
  accessId: string;
  url: string;
  state: WebhookState;
  runCount: number;
  failCount: number;
  lastRun?: WebhookRun;
  runs: Array<WebhookRun>;
  currentRetries: number;
  maxRetries: number;
  minIntervalMs: number;
  created: number;
  createdBy: string;
  modified: number;
  modifiedBy: string;
};

// ───────────────────────────── Methods (call envelope) ─────────────────────────────

export type ApiResultMeta = {
  apiVersion: string;
  serverTime: number;
  serial: string;
};

export type ApiErrorPayload = {
  id: string;
  message: string;
  data?: unknown;
};

export type ApiResult = {
  meta?: ApiResultMeta;
  error?: ApiErrorPayload;
  // Method-specific result fields are spread alongside meta/error.
  [key: string]: unknown;
};
