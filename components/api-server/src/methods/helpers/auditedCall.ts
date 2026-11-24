/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { getConfigSync, getLogger } from '@pryv/boiler';
import type { MethodContext } from 'business/src/MethodContext.ts';

/**
 * API methods run in-process, outside the transports (a delivery to an account
 * of this core, a one-time secret, the writes of an OAuth consent). The audit
 * hook of a call belongs to the HTTP answer (`Result.onEnd`, the error
 * middleware), so a bare `api.call` leaves no record.
 *
 * The rule: a call that changes the account, or is refused while trying to,
 * leaves the record the same call leaves over HTTP. A lookup the server makes
 * for its own processing, whose result goes to no caller, is not a record.
 */

type ApiLike = { call: (context: MethodContext, params: unknown, callback: (err: unknown, result: unknown) => void) => unknown };
type DrainableResult = { toObject: (callback: (err: unknown, obj: unknown) => void) => void };
type AuditModule = {
  validApiCall: (context: MethodContext, result: unknown) => Promise<void>;
  errorApiCall: (context: MethodContext, err: unknown) => Promise<void>;
};
type CallOptions = {
  /** Ids of refusals the caller takes for "nothing to do": no record. */
  expectedErrorIds?: string[];
};

/**
 * Forgets what an earlier call left on the context for its audit record. To
 * call before each call of a context that serves several.
 */
function resetAuditEnrichment (context: MethodContext): void {
  context.auditIntegrityPayload = undefined;
  context.auditRecordCount = undefined;
  context.auditRecordCountIncomplete = undefined;
  context.auditScopedStreamIds = undefined;
  context.auditScopedStreamCount = undefined;
}

/**
 * Runs an API method in-process and records it, success or refusal.
 * @returns the drained result
 */
async function callAudited (api: ApiLike, context: MethodContext, methodId: string, params: unknown, options: CallOptions = {}): Promise<Record<string, unknown>> {
  context.methodId = methodId;
  resetAuditEnrichment(context);
  let result: unknown;
  let obj: Record<string, unknown>;
  try {
    result = await new Promise<unknown>((resolve, reject) => {
      api.call(context, params, (err, res) => err != null ? reject(err) : resolve(res));
    });
    // Drained before the record: a streamed read has then finished counting. (A
    // write streams nothing: its drain does not fail after it took effect.)
    obj = await new Promise<Record<string, unknown>>((resolve, reject) => {
      (result as DrainableResult).toObject((err, res) => err != null ? reject(err) : resolve((res ?? {}) as Record<string, unknown>));
    });
  } catch (err) {
    const id = (err as { id?: string } | null)?.id;
    if (id == null || options.expectedErrorIds?.includes(id) !== true) await auditRefusedCall(context, methodId, err);
    throw err;
  }
  await record(context, 'success', (audit) => audit.validApiCall(context, result));
  return obj;
}

/** Records a refusal, also one met before the method could be called. */
async function auditRefusedCall (context: MethodContext, methodId: string, err: unknown): Promise<void> {
  context.methodId = methodId;
  await record(context, 'error', (audit) => audit.errorApiCall(context, err));
}

/** The call is decided: a record that cannot be written is logged (and counted by the audit), never answered. */
async function record (context: MethodContext, outcome: 'success' | 'error', write: (audit: AuditModule) => Promise<void>): Promise<void> {
  try {
    if (getConfigSync().get('audit:active') !== true) return;
    // Loaded on demand: the audit singleton must not be pulled in before the
    // storages have initialised it.
    await write((await import('audit')).default as unknown as AuditModule);
  } catch (auditErr) {
    getLogger('audited-call').error('Failed to audit an in-process call (' + outcome + '): ' + context.methodId +
      ' via ' + context.source?.name + ' for pryv://' + context.user?.username, auditErr);
  }
}

export { callAudited, auditRefusedCall, resetAuditEnrichment };
