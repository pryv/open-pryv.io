/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/* global assert */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildReport, renderMarkdown, CAVEATS, REPORT_VERSION } = require('audit/src/breachScopeReport.ts');

const BASE = 'cabc123';

function meta (over = {}) {
  return Object.assign({
    generatedAt: '2026-07-28T10:00:00.000Z',
    toolName: 'breach-scope',
    toolVersion: '1.0.0',
    coreUrl: 'https://core.example',
    coreId: 'single',
    piiMode: 'cleartext',
    username: 'alice',
    userId: 'u-alice',
    accessIdAsPasted: BASE + ':4',
    baseAccessId: BASE,
    since: '2026-07-01T00:00:00.000Z',
    until: '2026-07-28T00:00:00.000Z',
    sinceTs: 1000,
    untilTs: 2000,
    auditFilterConfig: { storage: { methods: { include: ['all'], exclude: [] } }, syslog: {} }
  }, over);
}

function readRow (over = {}) {
  return Object.assign({
    streamIds: ['access-' + BASE, 'access-' + BASE + ':4', 'action-events.get'],
    type: 'audit-log/pryv-api',
    time: 1500,
    content: { action: 'events.get', recordCount: 3, scopedStreamIds: ['s0'], scopedStreamCount: 1 }
  }, over);
}

describe('[BSRP] breachScopeReport (pure module)', () => {
  it('[BSR1] sums recordCount across read-data rows and attributes to streams', () => {
    const rows = [
      readRow({ content: { action: 'events.get', recordCount: 3, scopedStreamIds: ['s0'], scopedStreamCount: 1 } }),
      readRow({ content: { action: 'events.get', recordCount: 5, scopedStreamIds: ['s0', 's1'], scopedStreamCount: 2 } })
    ];
    const r = buildReport(rows, { id: BASE, name: 'app', type: 'app', permissions: [] }, { accessId: BASE, type: 'app' }, meta());
    assert.strictEqual(r.reportVersion, REPORT_VERSION);
    assert.strictEqual(r.subject.count, 1);
    assert.strictEqual(r.records.read.calls, 2);
    assert.strictEqual(r.records.read.recordsRead, 8);
    const s0 = r.dataCategories.streams.find((s) => s.id === 's0');
    const s1 = r.dataCategories.streams.find((s) => s.id === 's1');
    assert.strictEqual(s0.readCalls, 2);
    assert.strictEqual(s0.recordsUpperBound, 8); // 3 + 5, attributed (<=)
    assert.strictEqual(s1.readCalls, 1);
    assert.strictEqual(s1.recordsUpperBound, 5);
  });

  it('[BSR2] labels rows with no recordCount (pre-enrichment) as unknown-count', () => {
    const rows = [readRow({ content: { action: 'events.get', scopedStreamIds: ['s0'], scopedStreamCount: 1 } })];
    const r = buildReport(rows, null, null, meta());
    assert.strictEqual(r.records.read.recordsRead, 0);
    assert.strictEqual(r.records.read.callsWithUnknownCount, 1);
    assert.strictEqual(r.access.indexDivergence, true); // null access row
  });

  it('[BSR3] flags recordCountIncomplete', () => {
    const rows = [readRow({ content: { action: 'events.get', recordCount: 2, recordCountIncomplete: true, scopedStreamIds: ['s0'], scopedStreamCount: 1 } })];
    const r = buildReport(rows, null, null, meta());
    assert.strictEqual(r.records.read.incompleteCountCalls, 1);
    assert.strictEqual(r.records.read.recordsRead, 2);
  });

  it('[BSR4] separates the ["*"] wildcard sentinel from concrete streams and never flags truncation', () => {
    // The real producer sets scopedStreamCount = the full expansion size (here
    // 37) on a sentinel row; that must NOT be read as a truncated id list.
    const rows = [readRow({ content: { action: 'events.get', recordCount: 10, scopedStreamIds: ['*'], scopedStreamCount: 37 } })];
    const r = buildReport(rows, null, null, meta());
    assert.strictEqual(r.dataCategories.fullScopeReads.calls, 1);
    assert.strictEqual(r.dataCategories.fullScopeReads.recordsRead, 10);
    assert.strictEqual(r.dataCategories.streams.length, 0);
    assert.strictEqual(r.dataCategories.streamsTruncated, false, 'sentinel must not flag truncation');
    assert.strictEqual(r.dataCategories.maxScopedStreamCount, 0, 'sentinel expansion size must not pollute the capped-read survivor');
  });

  it('[BSR5] groups store-prefixed ids under external streams', () => {
    const rows = [readRow({ content: { action: 'events.get', recordCount: 1, scopedStreamIds: [':_audit:access-x', 's0'], scopedStreamCount: 2 } })];
    const r = buildReport(rows, null, null, meta());
    assert.strictEqual(r.dataCategories.externalStoreStreams.length, 1);
    assert.strictEqual(r.dataCategories.externalStoreStreams[0].id, ':_audit:access-x');
    assert.ok(r.dataCategories.streams.find((s) => s.id === 's0'));
  });

  it('[BSR6] sets streamsTruncated when scopedStreamCount exceeds the id list', () => {
    const ids = Array.from({ length: 100 }, (_v, i) => 's' + i);
    const rows = [readRow({ content: { action: 'events.get', recordCount: 1, scopedStreamIds: ids, scopedStreamCount: 250 } })];
    const r = buildReport(rows, null, null, meta());
    assert.strictEqual(r.dataCategories.streamsTruncated, true);
    assert.strictEqual(r.dataCategories.maxScopedStreamCount, 250);
  });

  it('[BSR7] collects serials seen across rows', () => {
    const rows = [
      readRow({ streamIds: ['access-' + BASE, 'access-' + BASE + ':3', 'action-events.get'] }),
      readRow({ streamIds: ['access-' + BASE, 'access-' + BASE + ':4', 'action-events.get'] })
    ];
    const r = buildReport(rows, null, null, meta());
    assert.deepStrictEqual(r.access.serialsSeen, ['3', '4']);
  });

  it('[BSR8] tallies ERROR rows separately and never as records', () => {
    const rows = [
      readRow(),
      readRow({ type: 'audit-log/pryv-api-error', content: { action: 'events.get', id: 'forbidden' } })
    ];
    const r = buildReport(rows, null, null, meta());
    assert.strictEqual(r.activity.totalCalls, 2);
    assert.strictEqual(r.activity.errorCalls, 1);
    assert.strictEqual(r.activity.byAction['events.get'].valid, 1);
    assert.strictEqual(r.activity.byAction['events.get'].error, 1);
    assert.strictEqual(r.records.read.calls, 1); // error row excluded from record counting
  });

  it('[BSR9] collects write integrity evidence and counts deletes/getOne', () => {
    const rows = [
      { streamIds: ['access-' + BASE, 'action-events.create'], type: 'audit-log/pryv-api', time: 1400, content: { action: 'events.create', record: { key: 'e1', integrity: 'sha:abc' } } },
      { streamIds: ['access-' + BASE, 'action-events.delete'], type: 'audit-log/pryv-api', time: 1450, content: { action: 'events.delete' } },
      { streamIds: ['access-' + BASE, 'action-events.getOne'], type: 'audit-log/pryv-api', time: 1460, content: { action: 'events.getOne', recordCount: 1 } }
    ];
    const r = buildReport(rows, null, null, meta());
    assert.strictEqual(r.records.written.calls, 1);
    assert.strictEqual(r.records.written.integrityEvidence.length, 1);
    assert.strictEqual(r.records.written.integrityEvidence[0].key, 'e1');
    assert.strictEqual(r.records.deleted.calls, 1);
    assert.strictEqual(r.records.read.calls, 1); // getOne is read-data
    assert.strictEqual(r.records.read.recordsRead, 1);
  });

  it('[BSRA] always emits the caveats preamble incl. G7 and NO socket.io caveat', () => {
    const r = buildReport([readRow()], null, null, meta());
    const codes = r.caveats.map((c) => c.code);
    assert.ok(codes.includes('G7'), 'G7 present');
    assert.ok(codes.includes('G2'), 'G2 present');
    assert.ok(codes.includes('G6'), 'G6 present');
    assert.strictEqual(r.caveats.length, CAVEATS.length);
    const joined = JSON.stringify(r.caveats).toLowerCase();
    assert.ok(!joined.includes('socket.io audit hole') && !codes.includes('G1'), 'no socket.io/G1 caveat');
  });

  it('[BSRB] renders Markdown containing the mandated scope wording', () => {
    const md = renderMarkdown(buildReport([readRow()], { id: BASE, name: 'app', type: 'app', permissions: [{ streamId: '*', level: 'read' }] }, null, meta()));
    assert.ok(md.includes('# Breach-scope report'));
    assert.ok(md.includes('actual exposure per call is <= scope'), 'scope semantics rendered');
    assert.ok(md.includes('Subjects affected: **1**'));
    assert.ok(md.includes('Evidence limits & caveats'));
    assert.ok(md.includes('G7'));
  });
});
