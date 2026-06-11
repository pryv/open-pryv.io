/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const utils = require('utils');
const errors = require('errors').factory;
const cmc = require('cmc');
const fs = require('fs');
const commonFns = require('./helpers/commonFunctions.ts');
const methodsSchema = require('../schema/eventsMethods.ts');
const eventSchema = require('../schema/event.ts').default;
const timestamp = require('unix-timestamp');

const { getMall, storeDataUtils } = require('mall');
const accountStreams = require('business/src/system-streams/index.ts');
const { getUsersRepository } = require('business/src/users/index.ts');
const { ErrorIds } = require('errors/src/ErrorIds.ts');
const { ErrorMessages } = require('errors/src/ErrorMessages.ts');
const { APIError } = require('errors/src/APIError.ts');
const assert = require('assert');

const eventsGetUtils = require('./helpers/eventsGetUtils.ts');

const { getAPIVersion } = require('middleware/src/project_version.ts');

const { TypeRepository, isSeriesType } = require('business').types;

const { getLogger, ready } = require('@pryv/boiler');
const { getPlatform } = require('platform');
const { getStorageLayer } = require('storage');
const { ApiEndpoint } = require('utils');

const { pubsub } = require('messages');

const CleanDeletedEventsStream = require('./streams/CleanDeletedEventsStream.ts').default;

const { integrity } = require('business');

import type { MethodNext } from './_types.ts';
import type { MethodContext as BaseMethodContext } from 'business/src/MethodContext.ts';
import type { ReadStream } from 'node:fs';
// Events middleware chains use the request context as a scratchpad
// (newEvent/oldEvent/event are populated by earlier steps and read by later
// ones). Widen MethodContext locally so the chain functions can carry
// these without per-step assertions or `as any` casts.
type MethodContext = BaseMethodContext & {
  // Scratchpad — the middleware chain populates fields like newEvent /
  // oldEvent / event / systemStream / accountStreamId(s) / auditIntegrityPayload
  // on the context as the steps run. Open-ended index keeps the typing
  // pragmatic; the BaseMethodContext fields stay strictly typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

// Per-method param + result shapes mirroring components/api-server/src/schema/eventsMethods.ts.
// Hand-authored. Keep in sync with that file when the wire schema changes.
type ItemDeletion = { id: string; deleted?: number };
type Event = {
  id?: string;
  type?: string;
  streamId?: string;
  streamIds?: string[];
  time?: number;
  duration?: number | null;
  endTime?: number | null;
  content?: unknown;
  description?: string;
  clientData?: Record<string, unknown> | null;
  trashed?: boolean;
  deleted?: number;
  headId?: string | null;
  attachments?: Array<{ id?: string; readToken?: string; size?: number; [k: string]: unknown }>;
  integrity?: string | null;
  [k: string]: unknown;
};
// `streams` wire forms before normalization: single id, array of ids,
// (possibly JSON-stringified) stream-query object, or array of queries.
type EventsGetParams = { streams?: string | Record<string, unknown> | Array<string | Record<string, unknown>>; types?: string[] | null; fromTime?: number; toTime?: number; sortAscending?: boolean; skip?: number; limit?: number; state?: 'default' | 'trashed' | 'all'; modifiedSince?: number; includeDeletions?: boolean; auth?: string; running?: boolean; [k: string]: unknown };
// events.get's result is the streaming Result wrapper (Result.ts), not a
// plain payload — typing it permissively here keeps `result.addStream(...)`
// callable without modeling the full Result class API in this file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventsGetResult = { addStream (name: string, stream: unknown): void; events?: Event[]; eventDeletions?: ItemDeletion[]; [k: string]: any };
type EventsGetOneParams = { id: string; includeHistory?: boolean };
type EventsGetOneResult = { event?: Event; history?: Event[] };
type EventsCreateParams = Partial<Event>;
type EventsCreateResult = { event?: Event };
// `files` is the multer upload bag attached by the route layer; consumed
// (and deleted) by updateEvent before the update reaches the mall.
type EventsUpdateParams = { id: string; update: Partial<Event>; files?: unknown };
type EventsUpdateResult = { event?: Event };
type EventsDeleteParams = { id: string };
type EventsDeleteResult = { event?: Event; eventDeletion?: ItemDeletion };
type EventsDeleteAttachmentParams = { id: string; fileId: string };
type EventsDeleteAttachmentResult = { event?: Event };
// Permissive shapes used by middleware that appears in multiple method
// chains. Per-method param/result schemas remain narrow at the
// method-specific middleware call sites; cross-chain shared functions
// just need an open-ended carrier that doesn't fight TS at the field
// reads they perform on a heterogeneous payload.
/* eslint-disable @typescript-eslint/no-explicit-any -- middleware scratchpad carriers (see above) */
type EventsCreateOrUpdateParams = { [k: string]: any };
type EventsCreateOrUpdateResult = { [k: string]: any };
type EventsAnyParams = { [k: string]: any };
type EventsAnyResult = { [k: string]: any };
/* eslint-enable @typescript-eslint/no-explicit-any */

// Type repository that will contain information about what is allowed/known
// for events.
const typeRepo = new TypeRepository();

/**
 * Events API methods implementations.
 */
export default async function (api: { register (...args: unknown[]): unknown }) {
  const config = await ready();
  // Lazy getters instead of slice captures. `filesReadTokenSecret`
  // drives the HMAC of every attachment file-read token; if the
  // captured slice were undefined at api-register time, every
  // attachment download would silently HMAC against undefined. The
  // REQUIRED_WHEN boot check guarantees the key is populated and the
  // getter pattern guarantees mid-process config changes (tests +
  // future dynamic-config sources) reach the per-request callsites.
  const getAuth = () => config.get('auth');
  const getUpdates = () => config.get('updates');
  const eventTypesUrl = config.get('service:eventTypes');
  const usersRepository = await getUsersRepository();
  const mall = await getMall();
  const platform = await getPlatform();
  const storageLayer = await getStorageLayer();

  // CMC: build a `mall.accesses` adapter backed by storageLayer.accesses.
  // The Mall doesn't expose accesses — they live in a separate storage —
  // but CMC handlers were written against a `mall.accesses.{create,get,
  // update,delete}` shape. The adapter bridges the two and sets
  // apiEndpoint on create-results so outbound delivery has its target URL.
  const cache = require('cache').default;
  const cmcMallAccessesAdapter = cmc.createMallAccessesAdapter({
    storageAccesses: storageLayer.accesses,
    apiEndpointBuild: ApiEndpoint.build.bind(ApiEndpoint),
    resolveUsername: async (userId: string) => {
      const u = await usersRepository.getUserById(userId);
      return u?.username;
    },
    invalidateAccessCache: (userId: string, accessId: string) => {
      const cached = cache.getAccessLogicForId(userId, accessId);
      if (cached != null) cache.unsetAccessLogic(userId, cached);
    },
    logger: getLogger('cmc:mall-accesses-adapter'),
  });
  // Compose a mall-with-accesses for the CMC modules' deps so they
  // see `mall.accesses.{create,get,update,delete}` alongside the real
  // `mall.streams` + `mall.events`. Mall uses class-instance getters
  // for streams/events so Object.assign would drop them — use a
  // forwarding object literal instead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mallForCmc: any = {
    get streams () { return mall.streams; },
    get events () { return mall.events; },
    accesses: cmcMallAccessesAdapter,
  };
  await eventsGetUtils.init();

  // Initialise the project version as soon as we can.
  const version = await getAPIVersion();

  // Update types and log error
  typeRepo
    .tryUpdate(eventTypesUrl, version)
    .catch((err: unknown) => getLogger('typeRepo').warn((err as Error).message ?? String(err)));

  const logger = getLogger('methods:events');

  // RETRIEVAL

  // Phase 4 H5: defense-in-depth — strip `:_cmc:_internal:*` ids from
  // query inputs / single-event lookups / streams.get tree before they
  // reach the store. Internal CMC streams (`offer/*`, `responses/*`,
  // `retries`) have no app-visible permissions today, but the explicit
  // filter guards against future regressions (mis-granted perms,
  // permission-system bugs) leaking plugin internals via read paths.
  const cmcEventsGetInternalGuard = cmc.createEventsGetInternalGuardHook();
  const cmcEventGetOneInternalGuard = cmc.createEventGetOneInternalGuardHook({ errors });

  api.register(
    'events.get',
    cmcEventsGetInternalGuard,
    eventsGetUtils.coerceStreamsParam,
    eventsGetUtils.coerceAndValidateContentQueryParams,
    commonFns.getParamsValidation(methodsSchema.get.params),
    eventsGetUtils.applyDefaultsForRetrieval,
    eventsGetUtils.transformArrayOfStringsToStreamsQuery,
    eventsGetUtils.validateStreamsQueriesAndSetStore,
    eventsGetUtils.validateContentQueryStores,
    eventsGetUtils.streamQueryCheckPermissionsAndReplaceStars,
    eventsGetUtils.streamQueryAddForcedAndForbiddenStreams,
    eventsGetUtils.streamQueryExpandStreams,
    eventsGetUtils.streamQueryAddHiddenStreams,
    eventsGetUtils.findEventsFromStore.bind(
      null,
      () => getAuth().filesReadTokenSecret
    ),
    includeLocalStorageDeletionsIfRequested
  );

  async function includeLocalStorageDeletionsIfRequested (context: MethodContext, params: EventsGetParams, result: EventsGetResult, next: MethodNext) {
    if (params.modifiedSince == null || !params.includeDeletions) {
      return next();
    }
    const deletedEvents = await mall.events.getDeletionsStreamed('local', context.user.id, { deletedSince: params.modifiedSince },
      { limit: params.limit, skip: params.skip, sortAscending: params.sortAscending });
    // remove properties of events that shouldn't be exposed
    result.addStream('eventDeletions', deletedEvents.pipe(new CleanDeletedEventsStream()));
    next();
  }

  api.register(
    'events.getOne',
    commonFns.getParamsValidation(methodsSchema.getOne.params),
    findEvent,
    cmcEventGetOneInternalGuard,
    checkIfAuthorized,
    includeHistoryIfRequested
  );

  async function findEvent (context: MethodContext, params: EventsGetOneParams, result: EventsGetOneResult, next: MethodNext) {
    try {
      const event = await mall.events.getOne(context.user.id, params.id);
      if (event == null) { return next(errors.unknownResource('event', params.id)); }
      context.event = event;
      next();
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
  }
  async function checkIfAuthorized (context: MethodContext, params: EventsGetOneParams, result: EventsGetOneResult, next: MethodNext) {
    if (!context.event) { return next(); }
    const event = context.event;
    delete context.event;
    const systemStreamIdsForbiddenForReading = accountStreams.hiddenStreamIds;
    let canReadEvent = false;
    // special case no streamIds on event && deleted
    if (event.streamIds == null) { // event might be deleted - limit result to deleted property
      result.event = { id: event.id, deleted: event.deleted };
      return next();
    }

    for (const streamId of event.streamIds) {
      // ok if at least one
      if (systemStreamIdsForbiddenForReading.includes(streamId)) {
        canReadEvent = false;
        break;
      }
      if (await context.access.canGetEventsOnStream(streamId, 'local')) {
        canReadEvent = true;
      }
    }
    // might return 404 to avoid discovery of existing forbidden events
    if (!canReadEvent) { return next(errors.forbidden()); }
    event.attachments = setFileReadToken(context.access, event.attachments);
    result.event = event;
    return next();
  }
  async function includeHistoryIfRequested (context: MethodContext, params: EventsGetOneParams, result: EventsGetOneResult, next: MethodNext) {
    if (!params.includeHistory) {
      return next();
    }
    // history is fetched in an extra step due to initial implementation,
    // now that mall.events.get return all in a single call, it coul be implement all at once
    try {
      const events = await mall.events.getHistory(context.user.id, params.id);
      result.history = [];
      events.forEach((e: Event) => {
        if (result.event!.streamIds == null) { // event might be deleted - limit result to modified property
          result.event = { id: e.id, modified: e.modified };
        } else {
          result.history!.push(e);
        }
      });
      next();
    } catch (err) {
      next(errors.unexpectedError(err));
    }
  }

  // -------------------------------------------------------------------- CREATE

  const cmcContentValidationHook = cmc.createCmcContentValidationHook({ errors });
  const cmcEnsureReservedParentsHook = cmc.createEnsureReservedParentsHook({
    mall,
    logger: getLogger('cmc:ensure-reserved-parents'),
  });
  const cmcInboxWriteHook = cmc.createInboxWriteHook({ errors });
  // Phase 4 H8: stamp content.from from access identity when a
  // counterparty-marked access writes a chat/system message into a
  // per-app stream. inboxWriteHook covers :_cmc:inbox; this hook covers
  // everything else. Local self-writes (personal/app token) pass
  // through unchanged — they aren't a cross-actor forge vector.
  const cmcCounterpartyFromStampingHook = cmc.createCounterpartyFromStampingHook({ errors });
  const cmcCapabilityResponseHook = cmc.createCapabilityResponseHook({ errors });
  const cmcDispatchLogger = getLogger('cmc:dispatch');
  const cmcSelfIdentityFor = async (userId: string) => {
    // username: pull from the users repository (cached behind the scenes).
    // host: the canonical hostname clients see when calling this api.
    // Priority:
    //   1. dns.domain (multi-core deploys serve from <id>.<domain>; the
    //      bare domain is the counterparty-facing identity).
    //   2. URL host extracted from service.api or service.register —
    //      a real URL with a hostname (and optional port).
    //   3. 'localhost' as last-resort dev fallback.
    // service.name is a HUMAN LABEL ("Local Dev", "Health Data Safe")
    // — NEVER use it as a host; the slug builder will reject anything
    // with spaces.
    const user = await usersRepository.getUserById(userId);
    const username = user?.username || 'unknown';
    let host = config.get('dns:domain');
    if (host == null || host === '') {
      const apiUrl = config.get('service:api') || config.get('service:register');
      if (typeof apiUrl === 'string' && apiUrl.length > 0) {
        try {
          const u = new URL(apiUrl.replace('{username}', 'x'));
          host = u.host;
        } catch (_e) { /* fall through to localhost */ }
      }
    }
    if (host == null || host === '') host = 'localhost';
    return { username, host };
  };
  // capabilityMintHook needs cmcSelfIdentityFor to stamp the canonical
  // requester host on the offer event (so accepter's inferCounterparty
  // doesn't fall back to the per-user URL hostname). Wired AFTER
  // cmcSelfIdentityFor is declared.
  const cmcCapabilityMintHook = cmc.createCapabilityMintHook({
    mall: mallForCmc,
    errors,
    idGen: () => require('crypto').randomBytes(16).toString('base64url'),
    logger: getLogger('cmc:capability-mint'),
    selfIdentityFor: cmcSelfIdentityFor,
  });
  // Phase 3.2: AFTER createEvent persists the consent/request-cmc
  // trigger and the mall assigns its real id, stamp that id onto the
  // capability access's `clientData.cmc.requestEventId`. The mint hook
  // can't do this — it runs pre-persist when event.id is null.
  // Without this post-stamp, Phase 1.1's inviteEventId-on-inbox-mirror
  // degrades silently on real-deploy because the source field is null.
  const cmcCapabilityPostCreateHook = cmc.createCapabilityPostCreateHook({
    mall: mallForCmc,
    errors,
    logger: getLogger('cmc:capability-post-create'),
  });
  const cmcDispatchMiddleware = cmc.createDispatchMiddleware({
    mall: mallForCmc,
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
    timeoutMs: 15_000,
    logger: cmcDispatchLogger,
    selfIdentityFor: cmcSelfIdentityFor,
  }, (context: MethodContext) => {
    // Per-request: bind a notifyEventChanged that fires pubsub for THIS
    // user. The dispatch loop's fire-and-forget events.update calls
    // bypass the request chain, so without this the app's socket.io
    // subscription wouldn't see status transitions.
    const username = context?.user?.username;
    return {
      notifyEventChanged: (_userId: string, _event: unknown) => {
        if (username != null) {
          pubsub.notifications.emit(username, pubsub.USERNAME_BASED_EVENTS_CHANGED);
        }
      },
    };
  });
  api.register(
    'events.create',
    commonFns.getParamsValidation(methodsSchema.create.params),
    normalizeStreamIdAndStreamIds,
    applyPrerequisitesForCreation,
    validateEventContentAndCoerce,
    // Auto-provision the five reserved :_cmc:* parents on first CMC op
    // for users who pre-date the CMC deploy. Idempotent. Must fire
    // BEFORE verifyCanCreateEventsOnStream so the stream check finds
    // the just-created reserved tree.
    cmcEnsureReservedParentsHook,
    verifyCanCreateEventsOnStream,
    cmcContentValidationHook,
    cmcCapabilityMintHook,
    cmcInboxWriteHook,
    cmcCounterpartyFromStampingHook,
    cmcCapabilityResponseHook,
    detectAccountStream,
    validateAccountStreamForCreate,
    validateAccountStreamContent,
    notifyPlatformForCreate,
    handleSeries,
    createEvent,
    // Phase 3.2 post-stamp: AFTER createEvent assigns event.id, copy it
    // onto the capability access's clientData.cmc.requestEventId. Must
    // run after createEvent (which generates id) and before
    // cmcDispatchMiddleware (which doesn't depend on this stamp).
    cmcCapabilityPostCreateHook,
    addIntegrityToContext,
    notify,
    cmcDispatchMiddleware
  );

  // CMC retry-loop bootstrap. No-op unless `cmc.retryLoop.enabled: true`
  // is set in config AND we're worker id 1 (or running standalone).
  // Operator-supplied userIdsProvider — defaults here to the platform's
  // full user list which is correct for single-shard deployments. Per-
  // shard / per-recent-activity scoping can be wired later.
  cmc.startRetryLoopIfEnabled({
    config,
    mall: mallForCmc,
    selfIdentityFor: cmcSelfIdentityFor,
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
    logger: getLogger('cmc:retry-loop'),
    userIdsProvider: async () => {
      const users = await usersRepository.getAllUsersIdAndName();
      return users.map((u: { id: string }) => u.id);
    },
  });

  function applyPrerequisitesForCreation (context: MethodContext, params: EventsCreateParams, result: EventsCreateResult, next: MethodNext) {
    const event = context.newEvent;
    // default time is now
    event.time ??= timestamp.now();
    context.initTrackingProperties(event);
    context.newEvent = event;
    next();
  }
  async function verifyCanCreateEventsOnStream (context: MethodContext, params: EventsCreateParams, result: EventsCreateResult, next: MethodNext) {
    for (const streamId of context.newEvent.streamIds) {
      // refuse if any context is not accessible
      if (!(await context.access.canCreateEventsOnStream(streamId))) {
        return next(errors.forbidden());
      }
    }
    next();
  }

  // ---- Account stream middleware (simplified: no active/unique markers) ----

  /**
   * Detect if event belongs to an account stream. Sets context flags
   * used by subsequent account middleware (shared by create and update).
   */
  function detectAccountStream (context: MethodContext, params: EventsCreateOrUpdateParams, result: EventsCreateOrUpdateResult, next: MethodNext) {
    const allAccountStreamIds = Object.keys(accountStreams.accountMap);
    const streamIds = context.newEvent.streamIds || [];
    const oldStreamIds = context.oldEvent ? context.oldEvent.streamIds : [];
    context.accountStreamIds = allAccountStreamIds.filter((id: string) => streamIds.includes(id));
    context.oldAccountStreamIds = allAccountStreamIds.filter((id: string) => oldStreamIds.includes(id));
    context.doesEventBelongToAccountStream =
      context.accountStreamIds.length > 0 || context.oldAccountStreamIds.length > 0;
    next();
  }

  /**
   * Validate account stream constraints for event creation:
   * - Only one account stream ID per event
   * - Stream must be editable
   */
  function validateAccountStreamForCreate (context: MethodContext, params: EventsCreateParams, result: EventsCreateResult, next: MethodNext) {
    if (!context.doesEventBelongToAccountStream) return next();
    if (context.accountStreamIds.length > 1) {
      return next(errors.invalidOperation(
        ErrorMessages[ErrorIds.ForbiddenMultipleAccountStreams],
        { streamIds: context.accountStreamIds }
      ));
    }
    context.accountStreamId = context.accountStreamIds[0];
    const streamConfig = accountStreams.accountMap[context.accountStreamId];
    if (!streamConfig?.isEditable) {
      return next(errors.invalidOperation(
        ErrorMessages[ErrorIds.ForbiddenAccountEventModification],
        { streamId: context.accountStreamId }
      ));
    }
    context.systemStream = streamConfig;
    context.accountStreamIdWithoutPrefix =
      accountStreams.toFieldName(context.accountStreamId);
    next();
  }

  /**
   * Validate account stream constraints for event update:
   * - Cannot add multiple account stream IDs
   * - Cannot change from one account stream to another
   * - Stream must be editable
   */
  function validateAccountStreamForUpdate (context: MethodContext, params: EventsUpdateParams, result: EventsUpdateResult, next: MethodNext) {
    if (!context.doesEventBelongToAccountStream) return next();
    const activeStreamIds = context.accountStreamIds.length > 0
      ? context.accountStreamIds
      : context.oldAccountStreamIds;
    if (activeStreamIds.length > 1) {
      return next(errors.invalidOperation(
        ErrorMessages[ErrorIds.ForbiddenMultipleAccountStreams],
        { streamIds: activeStreamIds }
      ));
    }
    // Cannot change the account stream of an event
    if (context.oldAccountStreamIds.length > 0 && context.accountStreamIds.length > 0) {
      if (context.oldAccountStreamIds[0] !== context.accountStreamIds[0]) {
        return next(errors.invalidOperation(
          ErrorMessages[ErrorIds.ForbiddenToChangeAccountStreamId]
        ));
      }
    }
    context.accountStreamId = activeStreamIds[0];
    const streamConfig = accountStreams.accountMap[context.accountStreamId];
    if (!streamConfig?.isEditable) {
      return next(errors.invalidOperation(
        ErrorMessages[ErrorIds.ForbiddenAccountEventModification],
        { streamId: context.accountStreamId }
      ));
    }
    context.systemStream = streamConfig;
    context.accountStreamIdWithoutPrefix =
      accountStreams.toFieldName(context.accountStreamId);
    next();
  }

  /**
   * Validate content format for indexed account fields (must be string or number).
   */
  function validateAccountStreamContent (context: MethodContext, params: EventsCreateOrUpdateParams, result: EventsCreateOrUpdateResult, next: MethodNext) {
    if (!context.doesEventBelongToAccountStream) return next();
    if (context.newEvent == null || context.newEvent.content == null) return next();
    const contentType = typeof context.newEvent.content;
    const accepted = ['number', 'string', 'undefined'];
    if (!accepted.includes(contentType)) {
      return next(errors.invalidParametersFormat(
        ErrorMessages.IndexedParameterInvalidFormat || "The event content's format is invalid.",
        params
      ));
    }
    next();
  }

  /**
   * Notify platform of a new or changed indexed account field value.
   * Uses 'update' action when the field already has a value (to clean up old unique entries).
   */
  async function notifyPlatformForCreate (context: MethodContext, params: EventsCreateParams, result: EventsCreateResult, next: MethodNext) {
    if (!context.doesEventBelongToAccountStream) return next();
    if (!context.systemStream.isIndexed) return next();
    try {
      const fieldName: string = context.accountStreamIdWithoutPrefix;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- system-stream-driven dynamic field access
      const previousValue = (context.user as any)[fieldName];
      const action = previousValue != null ? 'update' : 'create';
      const operations = [{
        action,
        key: fieldName,
        value: context.newEvent.content,
        previousValue,
        isUnique: context.systemStream.isUnique,
        isActive: true
      }];
      await platform.updateUser(context.user.username, operations);
    } catch (err) {
      return next(err);
    }
    next();
  }

  /**
   * Notify platform of an updated indexed account field value.
   */
  async function notifyPlatformForUpdate (context: MethodContext, params: EventsUpdateParams, result: EventsUpdateResult, next: MethodNext) {
    if (!context.doesEventBelongToAccountStream) return next();
    if (!context.systemStream.isIndexed) return next();
    try {
      const operations = [{
        action: 'update',
        key: context.accountStreamIdWithoutPrefix,
        value: context.newEvent.content,
        previousValue: context.oldEvent ? context.oldEvent.content : undefined,
        isUnique: context.systemStream.isUnique,
        isActive: true
      }];
      await platform.updateUser(context.user.username, operations);
    } catch (err) {
      return next(err);
    }
    next();
  }

  function handleSeries (context: MethodContext, params: EventsCreateParams, result: EventsCreateResult, next: MethodNext) {
    if (isSeriesType(context.newEvent.type)) {
      try {
        context.newEvent.content = createSeriesEventContent(context);
      } catch (err) {
        return next(err);
      }
      // As long as there is no data, event duration is considered to be 0.
      context.newEvent.duration = 0;
    }
    next();
  }
  async function createEvent (context: MethodContext, params: EventsCreateParams, result: EventsCreateResult, next: MethodNext) {
    let newEvent: Record<string, unknown> | null = null;
    // if event has attachments
    const files = sanitizeRequestFiles(params.files);
    delete params.files;
    if (files != null && files.length > 0) {
      // Pre-storage attachment descriptors consumed by mall.events.createWithAttachments.
      type AttachmentItem = { fileName: string; type: string; size: number; integrity?: string; attachmentData: ReadStream };
      const attachmentItems: AttachmentItem[] = [];
      for (const file of files) {
        attachmentItems.push({
          fileName: file.originalname,
          type: file.mimetype,
          size: file.size,
          integrity: file.integrity,
          attachmentData: fs.createReadStream(file.path) // simulate full pass-thru of attachement until implemented
        });
      }
      try {
        newEvent = await mall.events.createWithAttachments(context.user.id, context.newEvent, attachmentItems);
        newEvent!.attachments = setFileReadToken(context.access, (newEvent as { attachments?: Array<{ id: string; readToken?: string }> }).attachments);
      } catch (err) {
        if (err instanceof APIError) { return next(err); }
        return next(errors.unexpectedError(err));
      }
    } else {
      try {
        newEvent = await mall.events.create(context.user.id, context.newEvent);
      } catch (err) {
        if (err instanceof APIError) { return next(err); }
        return next(errors.unexpectedError(err));
      }
    }
    result.event = newEvent as Event;
    return next();
  }
  /**
   * Creates the event's body according to its type and context.
   */
  function createSeriesEventContent (context: MethodContext) {
    const seriesTypeName = context.newEvent.type;
    const eventType = typeRepo.lookup(seriesTypeName);
    // assert: Type is a series type, so this should be always true:
    assert.ok(eventType.isSeries());
    return {
      elementType: eventType.elementTypeName(),
      fields: eventType.fields(),
      required: eventType.requiredFields()
    };
  }
  function addIntegrityToContext (context: MethodContext, params: EventsCreateParams, result: EventsCreateResult, next: MethodNext) {
    if (result?.event?.integrity != null) {
      context.auditIntegrityPayload = {
        key: integrity.events.key(result.event),
        integrity: result.event.integrity
      };
      if (process.env.NODE_ENV === 'test' &&
                integrity.events.isActive) {
        // double check integrity when running tests only
        if (result.event.integrity !== integrity.events.hash(result.event)) {
          return next(new Error('integrity mismatch' + JSON.stringify(result.event)));
        }
      }
    }
    next();
  }

  // -------------------------------------------------------------------- UPDATE

  api.register(
    'events.update',
    commonFns.getParamsValidation(methodsSchema.update.params),
    commonFns.catchForbiddenUpdate(eventSchema('update'),
      () => getUpdates().ignoreProtectedFields, logger),
    normalizeStreamIdAndStreamIds,
    applyPrerequisitesForUpdate,
    validateEventContentAndCoerce,
    detectAccountStream,
    validateAccountStreamForUpdate,
    validateAccountStreamContent,
    notifyPlatformForUpdate,
    updateEvent,
    addIntegrityToContext,
    notify
  );

  async function applyPrerequisitesForUpdate (context: MethodContext, params: EventsUpdateParams, result: EventsUpdateResult, next: MethodNext) {
    const eventUpdate = context.newEvent;
    context.updateTrackingProperties(eventUpdate);
    let event;
    try {
      event = await mall.events.getOne(context.user.id, params.id);
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    if (!event) {
      return next(errors.unknownResource('event', params.id));
    }
    // 1. check that have contributeContext on at least 1 existing streamId
    let canUpdateEvent = false;
    for (let i = 0; i < event.streamIds.length; i++) {
      if (await context.access.canUpdateEventsOnStream(event.streamIds[i])) {
        canUpdateEvent = true;
        break;
      }
    }
    if (!canUpdateEvent) { return next(errors.forbidden()); }
    if (hasStreamIdsModification(eventUpdate)) {
      // 2. check that streams we add have contribute access
      const streamIdsToAdd = eventUpdate.streamIds.filter((id: string) => !event.streamIds.includes(id));
      for (const streamIdToAdd of streamIdsToAdd) {
        if (!(await context.access.canUpdateEventsOnStream(streamIdToAdd))) {
          return next(errors.forbidden());
        }
      }
      // 3. check that streams we remove have contribute access
      // streamsToRemove = event.streamIds - eventUpdate.streamIds
      const streamIdsToRemove = event.streamIds.filter((id: string) => !eventUpdate.streamIds.includes(id));
      for (const streamIdToRemove of streamIdsToRemove) {
        if (!(await context.access.canUpdateEventsOnStream(streamIdToRemove))) {
          return next(errors.forbidden());
        }
      }
    }
    const updatedEventType = eventUpdate.type;
    if (updatedEventType != null) {
      const currentEventType = event.type;
      const isCurrentEventTypeSeries = isSeriesType(currentEventType);
      const isUpdatedEventTypeSeries = isSeriesType(updatedEventType);
      if (!typeRepo.isKnown(updatedEventType) && isUpdatedEventTypeSeries) {
        return next(errors.invalidEventType(updatedEventType)); // We forbid the 'series' prefix for these free types.
      }
      if ((isCurrentEventTypeSeries && !isUpdatedEventTypeSeries) ||
                (!isCurrentEventTypeSeries && isUpdatedEventTypeSeries)) {
        return next(errors.invalidOperation('Normal events cannot be updated to HF-events and vice versa.'));
      }
    }
    context.oldEvent = structuredClone(event);
    context.newEvent = Object.assign(event, eventUpdate);
    // clientData key-map handling
    if (eventUpdate.clientData != null) {
      context.newEvent.clientData = structuredClone(context.oldEvent.clientData || {});
      for (const [key, value] of Object.entries(eventUpdate.clientData)) {
        if (value == null) {
          // delete keys with null value
          delete context.newEvent.clientData[key];
        } else {
          // update or add keys
          context.newEvent.clientData[key] = value;
        }
      }
    }
    next();
    function hasStreamIdsModification (event: { streamIds?: string[] }) {
      return event.streamIds != null;
    }
  }
  async function updateEvent (context: MethodContext, params: EventsUpdateParams, result: EventsUpdateResult, next: MethodNext) {
    try {
      // deals with attachments if any
      const files = sanitizeRequestFiles(params.files);
      delete params.files;
      if (files != null && files.length > 0) {
        let eventWithUpdatedAttachments: Record<string, unknown> | null = null;
        for (const file of files) {
          const attachmentItem = {
            fileName: file.originalname,
            type: file.mimetype,
            size: file.size,
            integrity: file.integrity,
            attachmentData: fs.createReadStream(file.path) // simulate full pass-thru of attachement until implemented
          };
          eventWithUpdatedAttachments = await mall.events.addAttachment(context.user.id, context.newEvent.id, attachmentItem);
          // update attachments property of newEvent
          context.newEvent.attachments = eventWithUpdatedAttachments!.attachments;
        }
      }
      // -- update the event (to save tacking properties and recalculate integrity)
      const updatedEvent = await mall.events.update(context.user.id, context.newEvent);

      updatedEvent.attachments = setFileReadToken(context.access, updatedEvent.attachments);
      result.event = updatedEvent;
      next();
    } catch (e) {
      next(e);
    }
  }
  function notify (context: MethodContext, params: EventsAnyParams, result: EventsAnyResult, next: MethodNext) {
    pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_EVENTS_CHANGED);
    // notify is called by create, update and delete
    // depending on the case the event properties will be found in context or event
    if (isSeriesEvent(context.event || result.event)) {
      const isDelete = !!result.eventDeletion;
      // if event is a deletion 'id' is given by result.eventDeletion
      const updatedEventId = { id: (isDelete ? result.eventDeletion : result.event).id };
      const subject = isDelete
        ? pubsub.SERIES_DELETE_EVENTID_USERNAME
        : pubsub.SERIES_UPDATE_EVENTID_USERNAME;
      const payload = {
        username: context.user.username,
        event: updatedEventId
      };
      pubsub.series.emit(subject, payload);
    }
    function isSeriesEvent (event: { type?: string }) {
      return event != null && typeof event.type === 'string' && event.type.startsWith('series:');
    }
    next();
  }
  /**
   * Fixes req.files structure for when attachments were sent without a filename, in which case
   * Express lists files as an array in a `file` property (instead of directly as properties).
   *
   */
  // Multer-style files-or-files-array — runtime shape is heterogeneous,
  // intentionally kept wide.
  /* eslint-disable @typescript-eslint/no-explicit-any -- heterogeneous multer bag (see above) */
  function sanitizeRequestFiles (files: any) {
    if (!files || !files.file || !Array.isArray(files.file)) {
      // assume files is an object, nothing to do
      return files;
    }
    const result: any = {};
    files.file.forEach(function (item: any, i: number) {
      if (!item.filename) {
        item.filename = item.name;
      }
      result[i] = item;
    });
    return result;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  async function normalizeStreamIdAndStreamIds (context: MethodContext, params: EventsCreateOrUpdateParams, result: EventsCreateOrUpdateResult, next: MethodNext) {
    const event = isEventsUpdateMethod() ? params.update : params;
    // remove double entries from streamIds
    if (event.streamIds != null && event.streamIds.length > 1) {
      event.streamIds = [...new Set(event.streamIds)];
    }
    // using context.newEvent now - not params
    context.newEvent = event;
    // used only in the events creation and update
    if (event.streamIds != null && event.streamIds.length > 0) {
      const streamIdsNotFoundList: string[] = [];
      const streamIdsTrashed: string[] = [];
      for (const fullStreamId of event.streamIds) {
        const [storeId, streamId] = storeDataUtils.parseStoreIdAndStoreItemId(fullStreamId);
        const stream = await context.streamForStreamId(streamId, storeId);
        if (!stream) {
          streamIdsNotFoundList.push(streamId);
        } else if (stream.trashed) {
          streamIdsTrashed.push(streamId);
        }
      }
      if (streamIdsNotFoundList.length > 0) {
        return next(errors.unknownReferencedResource('stream', 'streamIds', streamIdsNotFoundList));
      }
      if (streamIdsTrashed.length > 0) {
        return next(errors.invalidOperation('The referenced streams "' + streamIdsTrashed + '" are trashed.', { trashedReference: 'streamIds' }));
      }
    }
    next();
    function isEventsUpdateMethod () {
      return params.update != null;
    }
  }
  /**
   * Validates the event's content against its type (if known).
   * Will try casting string content to number if appropriate.
   *
   * @param context.newEvent contains the event data
   */
  async function validateEventContentAndCoerce (context: MethodContext, params: EventsCreateOrUpdateParams, result: EventsCreateOrUpdateResult, next: MethodNext) {
    const type = context.newEvent.type;
    // Unknown types can just be created as normal events.
    if (!typeRepo.isKnown(type)) {
      // We forbid the 'series' prefix for these free types.
      if (isSeriesType(type)) { return next(errors.invalidEventType(type)); }
      // No further checks, let the user do what he wants.
      return next();
    }
    // assert: `type` is known
    if (isSeriesType(type)) {
      // Series cannot have content on update, not here at least.
      if (isCreateSeriesAndHasContent(params) ||
                isUpdateSeriesAndHasContent(params)) {
        return next(errors.invalidParametersFormat("The event content's format is invalid.", 'Events of type High-frequency have a read-only content'));
      }
      return next();
    }
    try {
      await typeRepo.validate(context.newEvent);
      next();
    } catch (err) {
      next(errors.invalidParametersFormat("The event content's format is invalid.", err));
    }
    function isCreateSeriesAndHasContent (params: { type?: string; content?: unknown }) {
      return params.content != null;
    }
    function isUpdateSeriesAndHasContent (params: { update?: { content?: unknown } }) {
      return params.update != null && params.update.content != null;
    }
  }
  // DELETION

  api.register(
    'events.delete',
    commonFns.getParamsValidation(methodsSchema.del.params),
    checkEventForDelete,
    blockAccountEventDeletion,
    function (context: MethodContext, params: EventsDeleteParams, result: EventsDeleteResult, next: MethodNext) {
      if (!context.oldEvent.trashed) {
        // move to trash
        flagAsTrashed(context, params, result, next);
      } else {
        // actually delete
        deleteWithData(context, params, result, next);
      }
    },
    notify
  );

  /**
   * Block deletion of account events (system stream events).
   * Account events represent current field values and cannot be deleted through the API.
   */
  function blockAccountEventDeletion (context: MethodContext, params: EventsDeleteParams, result: EventsDeleteResult, next: MethodNext) {
    const event = context.oldEvent;
    if (!Array.isArray(event?.streamIds)) return next();
    for (const streamId of event.streamIds) {
      if (streamId.startsWith(':_system:') || streamId.startsWith(':system:')) {
        return next(errors.invalidOperation('Account events cannot be deleted.'));
      }
    }
    next();
  }
  async function flagAsTrashed (context: MethodContext, params: EventsDeleteParams, result: EventsDeleteResult, next: MethodNext) {
    const newEvent = structuredClone(context.oldEvent);
    newEvent.trashed = true;
    context.updateTrackingProperties(newEvent);
    const updatedEvent = await mall.events.update(context.user.id, newEvent);
    result.event = updatedEvent as Event;
    result.event!.attachments = setFileReadToken(context.access, result.event!.attachments as Array<{ id: string; readToken?: string }> | undefined);
    next();
  }
  async function deleteWithData (context: MethodContext, params: EventsDeleteParams, result: EventsDeleteResult, next: MethodNext) {
    try {
      await mall.events.delete(context.user.id, context.oldEvent);
      result.eventDeletion = { id: params.id };
      const storagedUsed = await usersRepository.getStorageUsedByUserId(context.user.id);
      // If needed, approximately update account storage size
      if (storagedUsed && storagedUsed.attachedFiles) {
        storagedUsed.attachedFiles -= getTotalAttachmentsSize(context.event.attachments);
        await usersRepository.updateOne(context.user, storagedUsed, 'system');
      }
      next();
    } catch (err) {
      next(err);
    }
  }
  function getTotalAttachmentsSize (attachments: Array<{ size?: number }> | undefined) {
    if (attachments == null) {
      return 0;
    }
    return attachments.reduce((evtTotal: number, att) => evtTotal + (att.size ?? 0), 0);
  }

  api.register(
    'events.deleteAttachment',
    commonFns.getParamsValidation(methodsSchema.deleteAttachment.params),
    checkEventForDelete,
    deleteAttachment
  );

  async function deleteAttachment (context: MethodContext, params: EventsDeleteAttachmentParams, result: EventsDeleteAttachmentResult, next: MethodNext) {
    const attIndex = getAttachmentIndex(context.event.attachments, params.fileId);
    if (attIndex === -1) {
      return next(errors.unknownResource('attachment', params.fileId));
    }
    const deletedAtt = context.event.attachments[attIndex];
    const eventDataWithDeletedAttach = await mall.events.deleteAttachment(context.user.id, context.event.id, params.fileId);

    // update tracking properties on event
    context.updateTrackingProperties(eventDataWithDeletedAttach);
    const newEvent = await mall.events.update(context.user.id, eventDataWithDeletedAttach);

    result.event = newEvent;
    result.event!.attachments = setFileReadToken(context.access, result.event!.attachments as Array<{ id: string; readToken?: string }> | undefined);
    const storagedUsed = await usersRepository.getStorageUsedByUserId(context.user.id);
    // approximately update account storage size
    storagedUsed.attachedFiles -= deletedAtt.size;
    await usersRepository.updateOne(context.user, storagedUsed, 'system');
    pubsub.notifications.emit(context.user.username, pubsub.USERNAME_BASED_EVENTS_CHANGED);
    next();
  }
  async function checkEventForDelete (context: MethodContext, params: EventsDeleteParams | EventsDeleteAttachmentParams, result: EventsDeleteResult | EventsDeleteAttachmentResult, next: MethodNext) {
    const eventId = params.id;
    let event;
    try {
      event = await mall.events.getOne(context.user.id, eventId);
    } catch (err) {
      return next(errors.unexpectedError(err));
    }
    if (event == null) {
      return next(errors.unknownResource('event', eventId));
    }
    let canDeleteEvent = false;
    for (const streamId of event.streamIds) {
      if (await context.access.canUpdateEventsOnStream(streamId)) {
        canDeleteEvent = true;
        break;
      }
    }
    if (!canDeleteEvent) { return next(errors.forbidden()); }
    // save event from the database as an oldEvent
    context.oldEvent = event;
    // create an event object that could be modified
    context.event = structuredClone(event);
    next();
  }
  /**
   * Returns the key of the attachment with the given file name.
   */
  function getAttachmentIndex (attachments: Array<{ id?: string }>, fileId: string) {
    return attachments.findIndex((att) => att.id === fileId);
  }
  /**
   * Sets the file read token for each of the given event's attachments (if any) for the given
   * access.
   *
   */
  function setFileReadToken (access: { id: string; token: string }, attachments: Array<{ id: string; readToken?: string }> | undefined) {
    if (attachments == null) {
      return;
    }
    attachments.forEach(function (att) {
      att.readToken = utils.encryption.fileReadToken(att.id, access.id, access.token, getAuth().filesReadTokenSecret);
    });
    return attachments;
  }
};
