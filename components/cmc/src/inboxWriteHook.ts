/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — events.create middleware that validates writes to
 * `:_cmc:inbox` (the one-shot lifecycle delivery stream).
 *
 * Behaviour:
 *   - Passthrough for events whose streamIds don't include :_cmc:inbox.
 *   - For inbox writes, the actor's access (context.access) MUST carry
 *     `clientData.cmc.role === 'counterparty'`. Without it: reject with
 *     `cmc-not-counterparty`. (App tokens and personal tokens cannot
 *     write directly into :_cmc:inbox — only counterparty-tagged shared
 *     accesses can.)
 *   - The event type MUST be one of the lifecycle family
 *     (cmc/request-v1, cmc/accept-v1, cmc/refuse-v1, cmc/revoke-v1).
 *     Other types: reject with `cmc-event-type-not-allowed`.
 *   - On success, stamp `content.from` server-side from the access's
 *     stored counterparty identity (`clientData.cmc.counterparty`), so
 *     senders can't forge the from-field.
 *
 * The plugin's outbound HTTPS deliveries call this server-internally
 * via the counterparty access token — that's how chat / system / revoke
 * events get into the recipient's :_cmc:inbox. App code never writes
 * to :_cmc:inbox directly.
 */

const C = require('./constants.ts');

type ErrorFactory = {
  invalidOperation: (message: string, details?: any) => any;
  forbidden?: (message?: string, details?: any) => any;
};

type Deps = { errors: ErrorFactory };

type Middleware = (context: any, params: any, result: any, next: any) => any | Promise<any>;

/**
 * Returns the middleware. Inserts at the same point in the events.create
 * chain as the other CMC hooks (after verifyCanCreateEventsOnStream,
 * before the account-stream and persist middleware).
 */
function createInboxWriteHook (deps: Deps): Middleware {
  return function cmcInboxWriteHook (context, _params, _result, next) {
    const event = context?.newEvent;
    if (event == null) return next();
    const streamIds: string[] = Array.isArray(event.streamIds) ? event.streamIds : [];
    if (!streamIds.includes(C.NS_INBOX)) return next();

    // The access must be a counterparty-marked shared access.
    const accessCmc = context?.access?.clientData?.cmc;
    if (accessCmc?.role !== 'counterparty') {
      return next(deps.errors.invalidOperation(
        'Writes to ' + C.NS_INBOX + ' require a counterparty-marked shared access',
        { id: 'cmc-not-counterparty', streamId: C.NS_INBOX }
      ));
    }

    // The event type must be in the lifecycle family.
    if (typeof event.type !== 'string' || !C.EVENT_TYPES_LIFECYCLE.includes(event.type)) {
      return next(deps.errors.invalidOperation(
        'Event type "' + event.type + '" is not allowed in ' + C.NS_INBOX,
        { id: 'cmc-event-type-not-allowed', eventType: event.type, allowed: C.EVENT_TYPES_LIFECYCLE }
      ));
    }

    // Stamp content.from from the access's stored counterparty identity.
    // Senders cannot forge this — even if they include a from-field in
    // the body, the server overwrites with the access's identity.
    const counterparty = accessCmc.counterparty;
    if (counterparty?.username == null || counterparty?.host == null) {
      return next(deps.errors.invalidOperation(
        'Counterparty access is missing identity (clientData.cmc.counterparty.{username,host})',
        { id: 'cmc-counterparty-identity-missing' }
      ));
    }

    event.content = {
      ...(event.content || {}),
      from: { username: counterparty.username, host: counterparty.host },
    };
    context.newEvent = event;
    context.cmc = context.cmc || {};
    context.cmc.inboxWrite = {
      counterparty: { username: counterparty.username, host: counterparty.host },
    };

    next();
  };
}

export { createInboxWriteHook };
