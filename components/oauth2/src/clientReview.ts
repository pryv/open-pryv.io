/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: the review acts on a client row, shared by the operator CLI
 * (`bin/oauth-client.js`) and the administration routes
 * (`/system/admin/oauth/clients/...`), so that the same act writes the same
 * row whoever does it (only `by`, and a reviewer's `note`, differ).
 *
 * - `approveClient`: validates a developer's client as it stands (its app
 *   review: the digest of its reviewed fields) and, when asked, approves the
 *   changes a registry client is held for (status `review`, or a suspended
 *   client's unapproved changes), as `update --approve` does. The caller
 *   gives the digest it reviewed: a row changed since is refused.
 * - `withdrawReview`: removes a developer's client app review.
 * - `setClientStatus`: suspends or resumes a client (a client under review,
 *   or holding unapproved changes, is not resumed: approve it first).
 *
 * Each act is a compare-and-set update of the row (`updatePlatformKv`): it
 * never writes over a change it did not read. Each change appends an entry to
 * the row's `statusLog` (`{ at, by, from, to, reason, note? }`, the last 50):
 * `reason` is the act (`validate`, `unvalidate`, `approve`, `suspend`,
 * `resume`), `note` the reviewer's own words when given. `by` is the acting
 * account id, `admin-key`, or `cli:<user>` for the CLI.
 */

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthClient, ClientStatus, ClientStatusLogEntry } from './storage.ts';
import { updatePlatformKv } from 'business/src/admin/store.ts';
import type { AdminStore } from 'business/src/admin/store.ts';
import { MAX_STATUS_LOG, checkedClientRow } from './clientRegistry.ts';
import { validationDigest, VALIDATION_DIGEST_VERSION } from './clientValidation.ts';

/** The platform store key family of client rows (as `storage.ts` writes them). */
const PREFIX_CLIENT = 'oauth-client/';

/** A status trail entry as the review acts write it. */
export type ReviewLogEntry = ClientStatusLogEntry & { note?: string };

export type ClientReviewErrorCode =
  | 'unknown-client'
  | 'not-applicable'
  | 'digest-required'
  | 'stale-digest'
  | 'needs-approval';

/** Why a review act was refused (nothing was written). */
export class ClientReviewError extends Error {
  code: ClientReviewErrorCode;
  data: Record<string, unknown>;
  constructor (code: ClientReviewErrorCode, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ClientReviewError';
    this.code = code;
    this.data = data;
  }
}

/** The row after the act, the row before, and whether anything was written. */
export type ReviewOutcome = { client: OAuthClient; before: OAuthClient; changed: boolean };

type ReviewOptions = {
  /** Who acts, as recorded in the trail and the review. */
  by: string;
  /** The reviewer's own words, kept in the trail entry. */
  note?: string | null;
  /** Whether the caller may act on this row (read inside the update): false answers `unknown-client`. */
  allow?: (row: OAuthClient) => boolean;
  now?: number;
};

export const METADATA_CLIENT_LEVEL = 'is a metadata-document client: its level follows oauth.clientMetadataDocuments.mode ' +
  '(allowList: publisherValidated, any: nonValidated)';
export const OPERATOR_CLIENT_LEVEL = 'was registered by the operator: it is appValidated by rule';

function parseRow (raw: string | null): OAuthClient | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw);
    return v != null && typeof v === 'object' && !Array.isArray(v) && typeof v.clientId === 'string' ? v as OAuthClient : null;
  } catch {
    return null;
  }
}

/** Why a level is not reviewed by hand for this row (its origin), for the refusal messages. */
function originMessage (row: OAuthClient): string {
  return row.origin === 'metadata-document' ? METADATA_CLIENT_LEVEL : OPERATOR_CLIENT_LEVEL;
}

/** The row with one more trail entry (bounded, oldest out). */
function withEntry (row: OAuthClient, entry: { from: ClientStatus; to: ClientStatus; reason: string }, opts: ReviewOptions, now: number): OAuthClient {
  const note = typeof opts.note === 'string' && opts.note.length > 0 ? { note: opts.note } : {};
  const log: ReviewLogEntry[] = [...(Array.isArray(row.statusLog) ? row.statusLog : []), { at: now, by: opts.by, ...entry, ...note }];
  return { ...row, statusLog: log.slice(-MAX_STATUS_LOG) };
}

/**
 * The vetted fields changed and not approved since (the `review` entries of
 * the trail after its last `approve`), or null when there are none.
 */
export function unapprovedChanges (row: OAuthClient): string[] | null {
  const log = Array.isArray(row.statusLog) ? row.statusLog : [];
  let lastApprove = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]?.reason === 'approve') { lastApprove = i; break; }
  }
  const pending = log.slice(lastApprove + 1).filter((e) => e?.reason === 'review');
  if (pending.length === 0) return null;
  return [...new Set(pending.flatMap((e) => (Array.isArray(e.fields) ? e.fields : [])))];
}

/** Whether approving this row approves held changes (`update --approve`): a registry client under review, or suspended with unapproved changes. */
export function holdsChanges (row: OAuthClient): boolean {
  if (row.kind !== 'registry') return false;
  const status = row.status ?? 'active';
  return status === 'review' || (status === 'suspended' && unapprovedChanges(row) != null);
}

/** Whether a row waits for a reviewer: a developer's client whose app review does not stand, or a client under review. */
export function inReviewQueue (row: OAuthClient, reviewStands: boolean): boolean {
  return (row.origin === 'developer' && !reviewStands) || (row.status ?? 'active') === 'review';
}

/**
 * One compare-and-set act on a client row: `decide` answers the next row, or
 * null to change nothing (it may throw a ClientReviewError: nothing written).
 */
async function reviewRow (platform: PlatformDB, clientId: string, opts: ReviewOptions,
  decide: (row: OAuthClient, now: number) => OAuthClient | null): Promise<ReviewOutcome> {
  const unknown = () => new ClientReviewError('unknown-client', 'no client "' + clientId + '"', { clientId });
  if (typeof clientId !== 'string' || clientId.length === 0) throw unknown();
  if (typeof opts.by !== 'string' || opts.by.length === 0 || opts.by.length > 128) throw new Error('review act: by must be 1 to 128 characters');
  const now = opts.now ?? Date.now();
  let before: OAuthClient | null = null;
  const done = await updatePlatformKv(platform as unknown as AdminStore, PREFIX_CLIENT + clientId, (raw) => {
    const row = parseRow(raw);
    if (row == null || (opts.allow != null && !opts.allow(row))) throw unknown();
    before = row;
    const next = decide(row, now);
    if (next == null) return { next: raw, result: row };
    return { next: JSON.stringify(next), result: next };
  });
  if (done == null || before == null) throw unknown();
  return { client: done.result, before, changed: done.after !== done.before };
}

/**
 * Approve a client as the caller reviewed it (`digest`: the review digest it
 * was shown, `validationDigest`). A developer's client gets its app review
 * (`validation.app`, entry `validate`); with `approveChanges` (the routes; the
 * CLI's `validate` leaves it to `update --approve`) a registry client under
 * review goes back to active, and a suspended one's unapproved changes are
 * approved (it stays suspended), entry `approve`. Refused when neither
 * applies, without a digest, or when the row's digest is no longer the one
 * given. The registration rules apply to the row written.
 */
export async function approveClient (platform: PlatformDB, clientId: string,
  opts: ReviewOptions & { digest: string | null | undefined; approveChanges?: boolean }): Promise<ReviewOutcome> {
  return reviewRow(platform, clientId, opts, (row, now) => {
    const approves = opts.approveChanges !== false && holdsChanges(row);
    if (row.origin !== 'developer' && !approves) throw new ClientReviewError('not-applicable', originMessage(row), { clientId });
    if (typeof opts.digest !== 'string' || opts.digest.length === 0) {
      throw new ClientReviewError('digest-required', 'the review digest of the client is required', { clientId });
    }
    const current = validationDigest(row);
    if (opts.digest !== current) {
      throw new ClientReviewError('stale-digest', 'the client changed since the review digest given', { clientId, digest: current });
    }
    let next: OAuthClient = { ...row };
    if (approves) {
      const from = row.status ?? 'active';
      const to: ClientStatus = from === 'suspended' ? 'suspended' : 'active';
      next = withEntry({ ...next, status: to }, { from, to, reason: 'approve' }, opts, now);
    }
    if (row.origin === 'developer') {
      const status = next.status ?? 'active';
      next = withEntry({ ...next, validation: { app: { v: VALIDATION_DIGEST_VERSION, at: now, by: opts.by, digest: current as string } } },
        { from: status, to: status, reason: 'validate' }, opts, now);
    }
    return checkedClientRow(next, now);
  });
}

/** Withdraw a developer's client app review (entry `unvalidate`); unchanged when it has none. */
export async function withdrawReview (platform: PlatformDB, clientId: string, opts: ReviewOptions): Promise<ReviewOutcome> {
  return reviewRow(platform, clientId, opts, (row, now) => {
    if (row.origin !== 'developer') throw new ClientReviewError('not-applicable', originMessage(row), { clientId });
    if (row.validation?.app == null) return null;
    const status = row.status ?? 'active';
    const next: OAuthClient = { ...row };
    delete next.validation;
    return checkedClientRow(withEntry(next, { from: status, to: status, reason: 'unvalidate' }, opts, now), now);
  });
}

/**
 * Suspend (`suspended`) or resume (`active`) a client (entry `suspend` /
 * `resume`); unchanged when already so. Only the status changes: the row is
 * written as is, without the registration rules (a row registered before a
 * newer rule stays suspendable). Resuming a client under review, or one whose
 * changes made while suspended are not approved, is refused (`needs-approval`).
 */
export async function setClientStatus (platform: PlatformDB, clientId: string,
  opts: ReviewOptions & { status: 'suspended' | 'active' }): Promise<ReviewOutcome> {
  if (opts.status !== 'suspended' && opts.status !== 'active') throw new Error('setClientStatus: status must be suspended or active');
  return reviewRow(platform, clientId, opts, (row, now) => {
    const from = row.status ?? 'active';
    if (opts.status === 'active' && from === 'review') {
      throw new ClientReviewError('needs-approval', 'the client is under review: approve it first', { clientId, status: 'review' });
    }
    if (opts.status === 'active' && from === 'suspended' && row.kind === 'registry') {
      const fields = unapprovedChanges(row);
      if (fields != null) {
        throw new ClientReviewError('needs-approval', 'changes made while the client was suspended are not approved: approve them first',
          { clientId, status: 'suspended', fields });
      }
    }
    if (from === opts.status) return null;
    return withEntry({ ...row, status: opts.status, updatedAt: now }, { from, to: opts.status, reason: opts.status === 'suspended' ? 'suspend' : 'resume' }, opts, now);
  });
}
