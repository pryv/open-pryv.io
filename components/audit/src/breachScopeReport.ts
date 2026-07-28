/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Breach-scope report builder — a PURE module (no storage / config / I/O).
 *
 * Given the audit rows recorded against a single access over a time window,
 * plus the authoritative access row and the reverse-index entry, it produces
 * the technical inputs an incident responder needs for a breach notification
 * (categories + approximate number of records/subjects affected), rendered as
 * a canonical JSON object and an auditor-facing Markdown document.
 *
 * The audit log carries method + query scope + record COUNT only — never event
 * bodies or event types. So this report classifies by stream and method and
 * quantifies by record count, and says so explicitly. Deriving event-type
 * categories would require re-querying CURRENT event storage (post-hoc state,
 * not call-time evidence) and is deliberately out of scope.
 *
 * Kept dependency-free so it unit-tests without booting: inputs are plain
 * objects (audit rows as read from storage), timestamps are Pryv seconds, and
 * the caller supplies pre-formatted metadata (generatedAt, core info, filter
 * config, ISO window bounds).
 */

export const REPORT_VERSION = 1;

/** An audit row as read from the per-user audit storage. */
export interface AuditRow {
  streamIds: string[];
  type: string; // 'audit-log/pryv-api' | 'audit-log/pryv-api-error'
  time: number; // pryv seconds
  content: {
    action?: string;
    query?: unknown;
    recordCount?: number;
    recordCountIncomplete?: boolean;
    scopedStreamIds?: string[];
    scopedStreamCount?: number;
    record?: { key?: string; integrity?: string } | Record<string, unknown>;
    id?: string; // error id, on error rows
  };
}

const ERROR_TYPE = 'audit-log/pryv-api-error';

/** action -> class. Unmapped actions fall into `other`; the raw byAction
 * histogram is always primary (lossless), the class map is a rendering aid. */
const ACTION_CLASS: Record<string, string> = {
  'events.get': 'read-data',
  'events.getOne': 'read-data',
  'events.getAttachment': 'read-attachment',
  'streams.get': 'read-metadata',
  'accesses.get': 'read-metadata',
  'account.get': 'read-metadata',
  getAccessInfo: 'read-metadata',
  'service.info': 'read-metadata',
  'webhooks.get': 'read-metadata',
  'followedSlices.get': 'read-metadata',
  'profile.get': 'read-metadata',
  'events.create': 'write',
  'events.update': 'write',
  'streams.create': 'write',
  'streams.update': 'write',
  'accesses.create': 'write',
  'accesses.update': 'write',
  'webhooks.create': 'write',
  'webhooks.update': 'write',
  'profile.update': 'write',
  'account.update': 'write',
  'followedSlices.create': 'write',
  'followedSlices.update': 'write',
  'events.delete': 'delete',
  'streams.delete': 'delete',
  'accesses.delete': 'delete',
  'webhooks.delete': 'delete',
  'followedSlices.delete': 'delete',
  'account.delete': 'delete',
  'auth.login': 'auth-session',
  'auth.logout': 'auth-session',
  'mfa.activate': 'auth-session',
  'mfa.confirm': 'auth-session',
  'mfa.challenge': 'auth-session',
  'mfa.verify': 'auth-session'
};

function classOf (action: string | undefined): string {
  if (action == null) return 'other';
  if (ACTION_CLASS[action] != null) return ACTION_CLASS[action];
  return 'other';
}

/** Static caveats — every entry emitted unconditionally (the report is a bug
 * without them). No socket.io caveat: that hole is fixed and audited now. */
export const CAVEATS: Array<{ code: string; text: string }> = [
  { code: 'G2', text: 'Methods excluded by the active audit storage filter leave no storage row; syslog-only methods appear audited but have no storage row. The active filter config is printed below as evidence.' },
  { code: 'G3', text: 'Stream ids that no longer resolve are valid call-time evidence (the stream was deleted or trashed since the call), not corruption.' },
  { code: 'G6', text: 'High-frequency / series data reads do not pass through this audit path; if the deployment runs an HF server, series exposure is not visible here.' },
  { code: 'getAttachment', text: 'Attachment-read rows carry neither a record count nor a stream scope; each is counted as one attachment read.' },
  { code: 'advisory-index', text: 'The access reverse-index is routing metadata only; the access facts in this report come from the home core\'s authoritative storage. A disagreement is flagged as indexDivergence.' },
  { code: 'recordCountIncomplete', text: 'A flagged read means the result drain aborted mid-stream; the partial count approximates what the caller received and is labeled, never summed as complete. Rows with no record count predate the enrichment and are listed as count-unknown.' },
  { code: 'G7', text: 'Calls made with the token AFTER it stopped resolving to an access (revocation or expiry) are audited under the invalid-access stream (access-invalid), not this access id. This report covers the window in which the token resolved to the access; post-revocation attempts live in the invalid-access audit stream and the HTTP logs.' },
  { code: 'scope-semantics', text: 'scopedStreamIds is the query\'s resolved scope, an upper bound on exposure per call, not the streams of the events actually returned. When a call combines a wildcard with concrete streams the row collapses to the [\'*\'] sentinel; the original query expression is preserved in content.query.' }
];

export interface ReportMeta {
  generatedAt: string; // ISO 8601, supplied by caller
  toolName: string;
  toolVersion: string;
  coreUrl: string;
  coreId: string;
  piiMode: 'cleartext' | 'hashed';
  username: string;
  userId: string;
  accessIdAsPasted: string;
  baseAccessId: string;
  since: string; // ISO
  until: string; // ISO
  sinceTs: number;
  untilTs: number;
  auditFilterConfig: { storage: unknown; syslog: unknown };
}

export interface AccessRowLike {
  id?: string;
  name?: string;
  type?: string;
  created?: number;
  expires?: number | null;
  deleted?: number | null;
  permissions?: unknown[];
}

export interface BreachScopeReport {
  reportVersion: number;
  generatedAt: string;
  tool: { name: string; version: string };
  instance: { coreUrl: string; coreId: string; piiMode: string };
  input: { accessId: string; baseAccessId: string; since: string; until: string; sinceTs: number; untilTs: number };
  subject: { count: number; username: string; userId: string };
  access: {
    id: string;
    name: string | null;
    type: string | null;
    created: number | null;
    expires: number | null;
    deleted: number | null;
    permissions: unknown[];
    serialsSeen: string[];
    indexRow: Record<string, unknown> | null;
    indexDivergence: boolean;
  };
  activity: {
    totalCalls: number;
    errorCalls: number;
    byAction: Record<string, { valid: number; error: number }>;
    firstCallTs: number | null;
    lastCallTs: number | null;
  };
  records: {
    read: { calls: number; recordsRead: number; callsWithUnknownCount: number; incompleteCountCalls: number };
    attachmentReads: number;
    metadataReadCalls: number;
    written: { calls: number; integrityEvidence: Array<{ action: string; key: string; integrity: string; time: number }> };
    deleted: { calls: number };
    authCalls: number;
    otherCalls: number;
  };
  dataCategories: {
    basis: string;
    streams: Array<{ id: string; name: string | null; resolvedAtReportTime: boolean; readCalls: number; recordsUpperBound: number }>;
    fullScopeReads: { calls: number; recordsRead: number };
    externalStoreStreams: Array<{ id: string; readCalls: number }>;
    streamsTruncated: boolean;
    maxScopedStreamCount: number;
  };
  caveats: Array<{ code: string; text: string }>;
  auditFilterConfig: { storage: unknown; syslog: unknown };
  operatorNarrative: { likelyConsequences: string; measuresTakenOrProposed: string; contactPoint: string };
}

/**
 * Build the canonical report object from audit rows + access metadata.
 *
 * @param auditRows rows read against `access-<base>` in the window (any serial)
 * @param accessRow authoritative home-core access row (may be null on divergence)
 * @param indexEntry the reverse-index row that resolved the access (evidence)
 * @param meta pre-formatted instance/input metadata
 */
export function buildReport (
  auditRows: AuditRow[],
  accessRow: AccessRowLike | null,
  indexEntry: Record<string, unknown> | null,
  meta: ReportMeta
): BreachScopeReport {
  const base = meta.baseAccessId;
  const serialPrefix = 'access-' + base + ':';

  const byAction: Record<string, { valid: number; error: number }> = {};
  const serialsSeen = new Set<string>();
  let firstCallTs: number | null = null;
  let lastCallTs: number | null = null;

  const read = { calls: 0, recordsRead: 0, callsWithUnknownCount: 0, incompleteCountCalls: 0 };
  let attachmentReads = 0;
  let metadataReadCalls = 0;
  const written = { calls: 0, integrityEvidence: [] as Array<{ action: string; key: string; integrity: string; time: number }> };
  const deleted = { calls: 0 };
  let authCalls = 0;
  let otherCalls = 0;
  let totalCalls = 0;
  let errorCalls = 0;

  // stream aggregation (from read-data VALID rows)
  const localStreams = new Map<string, { readCalls: number; recordsUpperBound: number }>();
  const externalStreams = new Map<string, { readCalls: number }>();
  const fullScopeReads = { calls: 0, recordsRead: 0 };
  let streamsTruncated = false;
  let maxScopedStreamCount = 0;

  for (const row of auditRows) {
    totalCalls++;
    const action = row.content?.action;
    const isError = row.type === ERROR_TYPE;
    if (isError) errorCalls++;

    // histogram
    const key = action ?? 'unknown';
    if (byAction[key] == null) byAction[key] = { valid: 0, error: 0 };
    if (isError) byAction[key].error++; else byAction[key].valid++;

    // time window bounds
    if (typeof row.time === 'number') {
      if (firstCallTs == null || row.time < firstCallTs) firstCallTs = row.time;
      if (lastCallTs == null || row.time > lastCallTs) lastCallTs = row.time;
    }

    // serials live during the window
    for (const sid of row.streamIds || []) {
      if (sid.startsWith(serialPrefix)) serialsSeen.add(sid.slice(serialPrefix.length));
    }

    // ERROR rows are attempted-call evidence only; never counted as records.
    if (isError) continue;

    const klass = classOf(action);
    const rc = row.content?.recordCount;
    switch (klass) {
      case 'read-data': {
        read.calls++;
        if (typeof rc === 'number') read.recordsRead += rc;
        else read.callsWithUnknownCount++;
        if (row.content?.recordCountIncomplete === true) read.incompleteCountCalls++;
        aggregateStreams(row, localStreams, externalStreams, fullScopeReads, typeof rc === 'number' ? rc : 0);
        const ssc = row.content?.scopedStreamCount;
        const ssi = row.content?.scopedStreamIds;
        // The wildcard sentinel carries scopedStreamCount = the full expansion
        // size (e.g. 37) while scopedStreamIds is ['*'] (length 1). That is NOT
        // truncation of an id list — a full-account read is a distinct breach
        // narrative (fullScopeReads), never conflated with a capped explicit
        // read. Exclude the sentinel from both the truncation flag and the
        // capped-read category-count survivor.
        const isSentinel = Array.isArray(ssi) && ssi.length === 1 && ssi[0] === '*';
        if (typeof ssc === 'number' && !isSentinel) {
          if (ssc > maxScopedStreamCount) maxScopedStreamCount = ssc;
          if (Array.isArray(ssi) && ssc > ssi.length) streamsTruncated = true;
        }
        break;
      }
      case 'read-attachment': attachmentReads++; break;
      case 'read-metadata': metadataReadCalls++; break;
      case 'write': {
        written.calls++;
        const rec = row.content?.record as { key?: string; integrity?: string } | undefined;
        if (rec != null && (rec.key != null || rec.integrity != null)) {
          written.integrityEvidence.push({
            action: action ?? 'unknown',
            key: rec.key ?? '',
            integrity: rec.integrity ?? '',
            time: row.time
          });
        }
        break;
      }
      case 'delete': deleted.calls++; break;
      case 'auth-session': authCalls++; break;
      default: otherCalls++; break;
    }
  }

  const streams = [...localStreams.entries()].map(([id, v]) => ({
    id,
    name: null as string | null, // filled by the caller's best-effort resolver
    resolvedAtReportTime: false,
    readCalls: v.readCalls,
    recordsUpperBound: v.recordsUpperBound
  }));
  const externalStoreStreams = [...externalStreams.entries()].map(([id, v]) => ({ id, readCalls: v.readCalls }));

  // Divergence = no authoritative row at all, OR one whose routing fields
  // disagree with the index (the index is advisory; the home-core row wins).
  let indexDivergence = accessRow == null;
  if (accessRow != null && indexEntry != null) {
    const differs = (a: unknown, b: unknown): boolean => a != null && b != null && a !== b;
    if (
      differs(accessRow.type, indexEntry.type) ||
      differs(accessRow.created, indexEntry.created) ||
      differs(accessRow.deleted, indexEntry.deleted) ||
      differs(accessRow.expires, indexEntry.expires)
    ) indexDivergence = true;
  }

  return {
    reportVersion: REPORT_VERSION,
    generatedAt: meta.generatedAt,
    tool: { name: meta.toolName, version: meta.toolVersion },
    instance: { coreUrl: meta.coreUrl, coreId: meta.coreId, piiMode: meta.piiMode },
    input: {
      accessId: meta.accessIdAsPasted,
      baseAccessId: base,
      since: meta.since,
      until: meta.until,
      sinceTs: meta.sinceTs,
      untilTs: meta.untilTs
    },
    subject: { count: 1, username: meta.username, userId: meta.userId },
    access: {
      id: accessRow?.id ?? base,
      name: accessRow?.name ?? null,
      type: accessRow?.type ?? (indexEntry?.type as string | undefined) ?? null,
      created: accessRow?.created ?? (indexEntry?.created as number | undefined) ?? null,
      expires: accessRow?.expires ?? null,
      deleted: accessRow?.deleted ?? (indexEntry?.deleted as number | null | undefined) ?? null,
      permissions: accessRow?.permissions ?? [],
      serialsSeen: [...serialsSeen].sort(),
      indexRow: indexEntry,
      indexDivergence
    },
    activity: {
      totalCalls,
      errorCalls,
      byAction,
      firstCallTs,
      lastCallTs
    },
    records: {
      read,
      attachmentReads,
      metadataReadCalls,
      written,
      deleted,
      authCalls,
      otherCalls
    },
    dataCategories: {
      basis: 'audit query scope (streams + counts); event bodies/types are never in the audit log',
      streams,
      fullScopeReads,
      externalStoreStreams,
      streamsTruncated,
      maxScopedStreamCount
    },
    caveats: CAVEATS,
    auditFilterConfig: meta.auditFilterConfig,
    operatorNarrative: {
      likelyConsequences: '',
      measuresTakenOrProposed: '',
      contactPoint: ''
    }
  };
}

function aggregateStreams (
  row: AuditRow,
  local: Map<string, { readCalls: number; recordsUpperBound: number }>,
  external: Map<string, { readCalls: number }>,
  fullScope: { calls: number; recordsRead: number },
  rc: number
): void {
  const ids = row.content?.scopedStreamIds;
  if (!Array.isArray(ids) || ids.length === 0) return;
  if (ids.length === 1 && ids[0] === '*') {
    fullScope.calls++;
    fullScope.recordsRead += rc;
    return;
  }
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    if (id.startsWith(':')) {
      const e = external.get(id) ?? { readCalls: 0 };
      e.readCalls++;
      external.set(id, e);
    } else {
      const e = local.get(id) ?? { readCalls: 0, recordsUpperBound: 0 };
      e.readCalls++;
      e.recordsUpperBound += rc; // attributed to each scoped stream; labeled "<=" in rendering
      local.set(id, e);
    }
  }
}

/** Render the canonical report as auditor-facing Markdown. */
export function renderMarkdown (report: BreachScopeReport): string {
  const r = report;
  const L: string[] = [];
  // Timestamps are pryv seconds; render them as ISO dates for auditors (with the
  // raw value in parentheses so nothing is lost). 'n/a' when absent.
  const isoOrNull = (ts: number | null): string => {
    if (ts == null) return 'n/a';
    const iso = new Date(ts * 1000).toISOString();
    return `${iso} (${ts})`;
  };

  L.push('# Breach-scope report');
  L.push('');
  L.push('> Technical inputs for a breach notification. Approximate figures; see the evidence limits in section 7.');
  L.push('');

  // 1 header
  L.push('## 1. Report');
  L.push('');
  L.push('| field | value |');
  L.push('| --- | --- |');
  L.push(`| generated | ${r.generatedAt} |`);
  L.push(`| tool | ${r.tool.name} ${r.tool.version} |`);
  L.push(`| core | ${r.instance.coreUrl} (${r.instance.coreId}, piiMode=${r.instance.piiMode}) |`);
  L.push(`| access id | ${r.input.accessId} (base ${r.input.baseAccessId}) |`);
  L.push(`| window | ${r.input.since} .. ${r.input.until} |`);
  L.push('');

  // 2 subject
  L.push('## 2. Subject affected');
  L.push('');
  L.push(`Subjects affected: **${r.subject.count}** (single-owner access, by construction).`);
  L.push('');
  L.push(`- user: \`${r.subject.username}\` (${r.subject.userId})`);
  L.push('');

  // 3 access
  L.push('## 3. Compromised access');
  L.push('');
  L.push(`- name: ${r.access.name ?? '(unknown)'}`);
  L.push(`- type: ${r.access.type ?? '(unknown)'}`);
  L.push(`- created: ${isoOrNull(r.access.created)}  expires: ${r.access.expires ?? 'never'}  revoked: ${r.access.deleted ?? 'no'}`);
  L.push(`- versions (serials) active during the window: ${r.access.serialsSeen.length ? r.access.serialsSeen.join(', ') : '(none seen)'}`);
  if (r.access.indexDivergence) L.push('- ⚠ index divergence: no authoritative access row found; facts fall back to the index entry.');
  L.push('');
  L.push('Declared permissions (worst-case bound on what this access could touch):');
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(r.access.permissions, null, 2));
  L.push('```');
  L.push('');

  // 4 activity
  L.push('## 4. Activity summary');
  L.push('');
  L.push(`Total calls: **${r.activity.totalCalls}** (errors: ${r.activity.errorCalls}). First: ${isoOrNull(r.activity.firstCallTs)}, last: ${isoOrNull(r.activity.lastCallTs)}.`);
  L.push('');
  L.push('| method | valid | error |');
  L.push('| --- | --- | --- |');
  for (const [action, c] of Object.entries(r.activity.byAction as Record<string, { valid: number; error: number }>)) {
    L.push(`| ${action} | ${c.valid} | ${c.error} |`);
  }
  L.push('');

  // 5 records
  L.push('## 5. Records affected');
  L.push('');
  L.push(`- data reads: ${r.records.read.calls} calls, **${r.records.read.recordsRead}** records read` +
    (r.records.read.callsWithUnknownCount ? ` (+${r.records.read.callsWithUnknownCount} calls with unknown count, pre-enrichment)` : '') +
    (r.records.read.incompleteCountCalls ? ` (⚠ ${r.records.read.incompleteCountCalls} calls with an incomplete/partial count)` : ''));
  L.push(`- attachment reads: ${r.records.attachmentReads}`);
  L.push(`- metadata reads: ${r.records.metadataReadCalls} calls`);
  L.push(`- writes: ${r.records.written.calls} calls`);
  L.push(`- deletions: ${r.records.deleted.calls} calls`);
  L.push(`- auth/session: ${r.records.authCalls} calls; other: ${r.records.otherCalls} calls`);
  if (r.records.written.integrityEvidence.length) {
    L.push('');
    L.push('Write integrity evidence (non-repudiation):');
    L.push('');
    L.push('| action | key | integrity | time |');
    L.push('| --- | --- | --- | --- |');
    for (const e of r.records.written.integrityEvidence) {
      L.push(`| ${e.action} | ${e.key} | ${e.integrity} | ${e.time} |`);
    }
  }
  L.push('');

  // 6 data categories
  L.push('## 6. Categories of data (stream scope)');
  L.push('');
  L.push('_Basis: audit query scope. `scopedStreamIds` is the query scope; actual exposure per call is <= scope._');
  L.push('');
  if (r.dataCategories.streams.length) {
    L.push('| stream | name | resolves now | read calls | records (<=) |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const s of r.dataCategories.streams) {
      L.push(`| ${s.id} | ${s.name ?? '(id only)'} | ${s.resolvedAtReportTime ? 'yes' : 'no'} | ${s.readCalls} | ${s.recordsUpperBound} |`);
    }
  } else {
    L.push('No concrete stream-scoped reads recorded.');
  }
  L.push('');
  if (r.dataCategories.fullScopeReads.calls) {
    L.push(`Full-account-scope reads (\`*\`): **${r.dataCategories.fullScopeReads.calls}** calls, ${r.dataCategories.fullScopeReads.recordsRead} records.`);
    L.push('');
  }
  if (r.dataCategories.externalStoreStreams.length) {
    L.push('External / secondary-store streams:');
    for (const s of r.dataCategories.externalStoreStreams) L.push(`- \`${s.id}\`: ${s.readCalls} read calls`);
    L.push('');
  }
  if (r.dataCategories.streamsTruncated) {
    L.push(`⚠ Some reads scoped more than the per-row id cap; the true category count reaches **${r.dataCategories.maxScopedStreamCount}** streams (id lists truncated, counts preserved).`);
    L.push('');
  }

  // 7 caveats
  L.push('## 7. Evidence limits & caveats');
  L.push('');
  for (const c of r.caveats as Array<{ code: string; text: string }>) L.push(`- **${c.code}** — ${c.text}`);
  L.push('');
  L.push('Active audit filter config (evidence for the storage-filter caveat):');
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(r.auditFilterConfig, null, 2));
  L.push('```');
  L.push('');

  // 8 operator narrative
  L.push('## 8. Operator narrative (to complete)');
  L.push('');
  L.push('```');
  L.push('Likely consequences: <fill in>');
  L.push('Measures taken or proposed: <fill in>');
  L.push('Contact point: <fill in>');
  L.push('```');
  L.push('');

  // 9 non-repudiation
  L.push('## 9. Note');
  L.push('');
  L.push('No event content is ever stored in the audit log; write rows carry integrity payloads (section 5) for non-repudiation, not the data itself.');
  L.push('');

  return L.join('\n');
}
