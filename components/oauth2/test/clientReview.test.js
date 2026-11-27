/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [OCRV] OAuth2: the review acts shared by the operator CLI and the
 * administration routes (approve, withdraw, suspend, resume), and the
 * decisions about publishers: what each act writes in the row and its trail,
 * the digest rule, the held changes, the compare-and-set update, and that the
 * CLI and the shared functions write the same row (apart from `by`).
 * Run against an in-memory platform store.
 */

const assert = require('node:assert/strict');
const review = require('../src/clientReview.ts');
const cv = require('../src/clientValidation.ts');
const { persistClient, getClient } = require('../src/clientRegistry.ts');
const { setClient } = require('../src/storage.ts');
const cli = require('../../../bin/oauth-client.js');

const REDIRECT = 'https://app.example.com/redirect';
const AUD = 'https://resource.example.com/base';
const OWNER = 'u-owner';

function fakePlatform () {
  const kv = new Map();
  return {
    kv,
    // Set to a function to run once between the read and the write of the next compare-and-set.
    beforeReplace: null,
    async setPlatformKv (k, v) { kv.set(k, v); },
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvKeys (p) { return [...kv.keys()].filter((k) => k.startsWith(p)); },
    async listPlatformKvEntries (p) { return [...kv.entries()].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })); },
    async setPlatformKvIfAbsent (k, v) { if (kv.has(k)) return false; kv.set(k, v); return true; },
    async replacePlatformKvIfValue (k, expected, next) {
      if (this.beforeReplace != null) { const f = this.beforeReplace; this.beforeReplace = null; await f(); }
      if (kv.get(k) !== expected) return false;
      if (next == null) kv.delete(k); else kv.set(k, next);
      return true;
    },
  };
}

const BASE = {
  kind: 'registry',
  redirectUris: [REDIRECT],
  scope: ['read/a'],
  grantTypes: ['authorization_code'],
  tokenEndpointAuthMethod: 'none',
  allowedAudiences: [AUD],
  subjectType: 'public',
  clientName: 'Review app',
};
const developerClient = (extra = {}) => ({ ...BASE, clientId: 'dev-app', origin: 'developer', owner: { userId: OWNER }, ...extra });
const operatorClient = (extra = {}) => ({ ...BASE, clientId: 'op-app', ...extra });

async function quietly (fn) {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
}

/** The row without what differs between two acts made at other times by other actors. */
function comparable (row) {
  const { updatedAt: _u, ...rest } = row;
  return JSON.parse(JSON.stringify({
    ...rest,
    validation: rest.validation == null ? undefined : { app: { ...rest.validation.app, at: 0, by: '-' } },
    statusLog: (rest.statusLog ?? []).map((e) => ({ ...e, at: 0, by: '-' })),
  }));
}

describe('[OCRV] OAuth2 review acts and publisher decisions', () => {
  it('[OCRV1] approve: a developer\'s client gets its app review with the digest given; a changed row, a missing digest or another origin is refused and nothing is written', async () => {
    const platform = fakePlatform();
    await persistClient(platform, developerClient());
    await persistClient(platform, operatorClient());
    const row = await getClient(platform, 'dev-app');
    const digest = cv.validationDigest(row);
    await assert.rejects(review.approveClient(platform, 'dev-app', { digest: undefined, by: 'u1' }), (e) => e.code === 'digest-required');
    await assert.rejects(review.approveClient(platform, 'dev-app', { digest: 'x'.repeat(43), by: 'u1' }), (e) => e.code === 'stale-digest' && e.data.digest === digest);
    assert.deepEqual(await getClient(platform, 'dev-app'), row, 'nothing written');
    await assert.rejects(review.approveClient(platform, 'op-app', { digest: 'x', by: 'u1' }), (e) => e.code === 'not-applicable' && /appValidated by rule/.test(e.message));
    await assert.rejects(review.approveClient(platform, 'nope', { digest, by: 'u1' }), (e) => e.code === 'unknown-client');
    await assert.rejects(review.approveClient(platform, 'dev-app', { digest, by: 'u1', allow: () => false }), (e) => e.code === 'unknown-client', 'out of reach reads as missing');
    const out = await review.approveClient(platform, 'dev-app', { digest, by: 'u1', note: 'checked the policy page' });
    assert.equal(out.changed, true);
    assert.deepEqual([out.client.validation.app.by, out.client.validation.app.digest, out.client.validation.app.v], ['u1', digest, 1]);
    assert.deepEqual(out.client.statusLog.map((e) => [e.from, e.to, e.reason, e.by, e.note]), [['active', 'active', 'validate', 'u1', 'checked the policy page']]);
    assert.equal(cv.reviewStands(await getClient(platform, 'dev-app')), true);
    // Withdrawn, then unchanged when there is nothing to withdraw.
    const w = await review.withdrawReview(platform, 'dev-app', { by: 'u2' });
    assert.equal(w.changed, true);
    assert.equal(w.client.validation, undefined);
    assert.equal(w.client.statusLog.at(-1).reason, 'unvalidate');
    assert.equal((await review.withdrawReview(platform, 'dev-app', { by: 'u2' })).changed, false);
    await assert.rejects(review.withdrawReview(platform, 'op-app', { by: 'u2' }), (e) => e.code === 'not-applicable');
  });

  it('[OCRV2] approve applies the held changes too: a client under review goes active, a suspended one\'s changes are approved and it stays suspended; an operator\'s client under review is approved alone', async () => {
    const platform = fakePlatform();
    const reviewEntry = { at: 1, by: 'cli:op', from: 'active', to: 'review', reason: 'review', fields: ['redirectUris'] };
    await setClient(platform, developerClient({ status: 'review', statusLog: [reviewEntry] }));
    let row = await getClient(platform, 'dev-app');
    let out = await review.approveClient(platform, 'dev-app', { digest: cv.validationDigest(row), by: 'u1' });
    assert.equal(out.client.status, 'active');
    assert.deepEqual(out.client.statusLog.slice(1).map((e) => [e.from, e.to, e.reason]), [['review', 'active', 'approve'], ['active', 'active', 'validate']]);
    // The CLI's validate leaves the held changes to update --approve.
    await setClient(platform, developerClient({ status: 'review', statusLog: [reviewEntry] }));
    row = await getClient(platform, 'dev-app');
    out = await review.approveClient(platform, 'dev-app', { digest: cv.validationDigest(row), by: 'u1', approveChanges: false });
    assert.equal(out.client.status, 'review');
    // An operator's client: approve the changes only (no app review on it).
    await setClient(platform, operatorClient({ status: 'review', statusLog: [reviewEntry] }));
    row = await getClient(platform, 'op-app');
    out = await review.approveClient(platform, 'op-app', { digest: cv.validationDigest(row), by: 'admin-key' });
    assert.deepEqual([out.client.status, out.client.validation, out.client.statusLog.at(-1).reason], ['active', undefined, 'approve']);
    // Suspended with changes made meanwhile: resume refused until approved; the approval keeps it suspended.
    await setClient(platform, operatorClient({ status: 'suspended', statusLog: [{ ...reviewEntry, from: 'suspended', to: 'suspended' }] }));
    await assert.rejects(review.setClientStatus(platform, 'op-app', { status: 'active', by: 'u1' }),
      (e) => e.code === 'needs-approval' && e.data.status === 'suspended' && e.data.fields[0] === 'redirectUris');
    row = await getClient(platform, 'op-app');
    out = await review.approveClient(platform, 'op-app', { digest: cv.validationDigest(row), by: 'u1' });
    assert.deepEqual([out.client.status, out.client.statusLog.at(-1).reason], ['suspended', 'approve']);
    out = await review.setClientStatus(platform, 'op-app', { status: 'active', by: 'u1' });
    assert.deepEqual([out.client.status, out.client.statusLog.at(-1).reason], ['active', 'resume']);
  });

  it('[OCRV3] suspend and resume: one trail entry each with the note, unchanged when already so, a client under review is not resumed', async () => {
    const platform = fakePlatform();
    await persistClient(platform, operatorClient());
    const s = await review.setClientStatus(platform, 'op-app', { status: 'suspended', by: 'u1', note: 'abuse report 12' });
    assert.deepEqual(s.client.statusLog.map((e) => [e.from, e.to, e.reason, e.by, e.note]), [['active', 'suspended', 'suspend', 'u1', 'abuse report 12']]);
    assert.equal((await review.setClientStatus(platform, 'op-app', { status: 'suspended', by: 'u1' })).changed, false);
    assert.equal((await getClient(platform, 'op-app')).statusLog.length, 1);
    await setClient(platform, { ...(await getClient(platform, 'op-app')), status: 'review' });
    await assert.rejects(review.setClientStatus(platform, 'op-app', { status: 'active', by: 'u1' }), (e) => e.code === 'needs-approval' && e.data.status === 'review');
    assert.equal(review.inReviewQueue({ status: 'review' }, true), true);
    assert.equal(review.inReviewQueue({ origin: 'developer' }, false), true);
    assert.equal(review.inReviewQueue({ origin: 'developer' }, true), false);
    assert.equal(review.inReviewQueue({ origin: 'operator' }, false), false);
  });

  it('[OCRV4] compare-and-set: a change made between the read and the write is not overwritten (the act runs again on the new row)', async () => {
    const platform = fakePlatform();
    await persistClient(platform, operatorClient());
    platform.beforeReplace = async () => {
      const r = JSON.parse(platform.kv.get('oauth-client/op-app'));
      platform.kv.set('oauth-client/op-app', JSON.stringify({ ...r, clientName: 'Renamed meanwhile' }));
    };
    const out = await review.setClientStatus(platform, 'op-app', { status: 'suspended', by: 'u1' });
    const stored = await getClient(platform, 'op-app');
    assert.deepEqual([stored.clientName, stored.status], ['Renamed meanwhile', 'suspended']);
    assert.equal(out.client.clientName, 'Renamed meanwhile');
    // A digest checked on the row as written: approving a row changed under the act is refused.
    await persistClient(platform, developerClient());
    const digest = cv.validationDigest(await getClient(platform, 'dev-app'));
    platform.beforeReplace = async () => {
      const r = JSON.parse(platform.kv.get('oauth-client/dev-app'));
      platform.kv.set('oauth-client/dev-app', JSON.stringify({ ...r, redirectUris: [REDIRECT, 'https://evil.example/cb'] }));
    };
    await assert.rejects(review.approveClient(platform, 'dev-app', { digest, by: 'u1' }), (e) => e.code === 'stale-digest');
    assert.equal((await getClient(platform, 'dev-app')).validation, undefined);
  });

  it('[OCRV5] the CLI and the shared functions write the same row for the same act, apart from who and when', async () => {
    const viaCli = fakePlatform();
    const viaFn = fakePlatform();
    for (const p of [viaCli, viaFn]) await persistClient(p, developerClient());
    const digest = cv.validationDigest(await getClient(viaCli, 'dev-app'));
    await quietly(() => cli.runValidate(viaCli, cli.parseArgs(['validate', 'dev-app', '--digest', digest]), getClient, persistClient));
    await review.approveClient(viaFn, 'dev-app', { digest, by: 'u1', approveChanges: false });
    assert.deepEqual(comparable(await getClient(viaCli, 'dev-app')), comparable(await getClient(viaFn, 'dev-app')));
    assert.match((await getClient(viaCli, 'dev-app')).validation.app.by, /^cli:/);
    await quietly(() => cli.runSetStatus(viaCli, cli.parseArgs(['suspend', 'dev-app']), getClient, persistClient));
    await review.setClientStatus(viaFn, 'dev-app', { status: 'suspended', by: 'u1' });
    assert.deepEqual(comparable(await getClient(viaCli, 'dev-app')), comparable(await getClient(viaFn, 'dev-app')));
    await quietly(() => cli.runValidate(viaCli, cli.parseArgs(['unvalidate', 'dev-app']), getClient, persistClient));
    await review.withdrawReview(viaFn, 'dev-app', { by: 'u1' });
    assert.deepEqual(comparable(await getClient(viaCli, 'dev-app')), comparable(await getClient(viaFn, 'dev-app')));
  });

  it('[OCRV6] publisher decisions: a trail entry each, name and regions kept unless given (null removes), refused values, out of reach reads as missing; the badge follows', async () => {
    const platform = fakePlatform();
    await persistClient(platform, developerClient());
    // A row written before decisions had a trail is still read.
    await platform.setPlatformKv('dev-publisher/' + OWNER, JSON.stringify({ status: 'pending' }));
    assert.deepEqual(await cv.getPublisher(platform, OWNER), { status: 'pending' });
    let d = await cv.decidePublisher(platform, OWNER, { status: 'validated', displayName: 'Acme', regions: ['eu'], reason: 'KYC done', by: 'u1', now: 10 });
    assert.deepEqual(d.row, {
      status: 'validated',
      displayName: 'Acme',
      regions: ['eu'],
      updatedAt: 10,
      statusLog: [{ at: 10, by: 'u1', from: 'pending', to: 'validated', reason: 'KYC done' }],
    });
    assert.equal(d.before.status, 'pending');
    assert.deepEqual((await cv.resolveClientValidation(platform, null, await getClient(platform, 'dev-app'))).publisher, { name: 'Acme', validated: true });
    d = await cv.decidePublisher(platform, OWNER, { status: 'suspended', reason: 'complaints', by: 'u2', now: 20 });
    assert.deepEqual([d.row.displayName, d.row.regions, d.row.statusLog.length], ['Acme', ['eu'], 2]);
    assert.equal((await cv.resolveClientValidation(platform, null, await getClient(platform, 'dev-app'))).level, 'nonValidated');
    d = await cv.decidePublisher(platform, OWNER, { status: 'suspended', displayName: null, regions: null, reason: 'reset', by: 'u2' });
    assert.deepEqual([d.row.displayName, d.row.regions], [undefined, undefined]);
    for (const bad of [
      { status: 'god' }, { displayName: 'x'.repeat(129) }, { regions: [] }, { regions: ['eu', 'eu'] }, { regions: ['bad key'] }, { reason: '' }, { reason: 'a\u0007' },
    ]) {
      await assert.rejects(cv.decidePublisher(platform, OWNER, { status: 'validated', reason: 'ok', by: 'u1', ...bad }), (e) => e.code === 'invalid', JSON.stringify(bad));
    }
    await assert.rejects(cv.decidePublisher(platform, 'bad/id', { status: 'validated', reason: 'ok', by: 'u1' }), (e) => e.code === 'invalid');
    await assert.rejects(cv.decidePublisher(platform, OWNER, { status: 'validated', reason: 'ok', by: 'u1', allow: () => false }), (e) => e.code === 'unknown-publisher');
    assert.equal((await cv.readPublisher(platform, OWNER)).status, 'suspended', 'nothing written on a refusal');
    // Every row, by id; an unreadable row left out.
    await platform.setPlatformKv('dev-publisher/zz-broken', '{');
    assert.deepEqual((await cv.listPublishers(platform)).map((p) => p.userId), [OWNER]);
  });
});
