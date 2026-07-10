/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — `cmc:<offer-name>` scope resolution.
 *
 * A cmc scope token references a consent offer registered on the
 * client (`OAuthClient.cmcOffers[<name>].capabilityUrl` — an open-link
 * `consent/request-cmc` capability published by the app's account).
 * At /oauth2/authorize time this module reads the offer through the
 * capability connection and returns the granular grant material the
 * consent UI displays and the accept path mints.
 *
 * Reuses the cmc component's own capability-read + permission
 * normalization primitives — the offer wire contract lives in ONE
 * place (cmc/src/acceptOrchestration.ts + the permission-lexicon
 * single point it delegates to).
 *
 * Capability lifecycle nuance: an `invalidated` open-link capability
 * still answers reads (only its responses stream is write-blocked), so
 * a stale offer surfaces at accept time with a typed cmc error — same
 * behavior as the native CMC accept flow.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { readOfferViaCapability, permissionsFromOffer, allowsUserChoice } =
  require('cmc/src/acceptOrchestration.ts');

export type LocalizableText = Record<string, string>;

/** What the consent UI needs + what the accept path mints from. */
export type ResolvedOffer = {
  offerName: string;
  capabilityUrl: string;
  capabilityId: string | null;
  /** Offer event id — the stable key linking data-grant accesses back
   * to this offer (`clientData.cmc.offerEventId`), used to detect a
   * re-authorization by the same user. */
  offerEventId: string | null;
  /** Consent form: full lexicon (stream + feature entries), with the
   * per-entry `mandatory` annotation preserved for display + grant
   * validation. */
  permissions: Array<Record<string, unknown>>;
  /** Default FALSE — the consent is ALL OR NOTHING; true lets the user
   * cherry-pick entries (mandatory ones stay locked). */
  allowUserChoice: boolean;
  title?: LocalizableText;
  description?: LocalizableText;
  consent?: LocalizableText;
  requesterMeta?: Record<string, unknown>;
};

export class OfferResolveError extends Error {
  cmcErrorId?: string;
  constructor (message: string, cmcErrorId?: string) {
    super(message);
    this.name = 'OfferResolveError';
    this.cmcErrorId = cmcErrorId;
  }
}

type ResolveDeps = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Upper bounds on what an offer may embed into the HMAC-signed state
 * that travels as a redirect URL parameter. The signed state is a
 * mandatory hop of every authorization; an over-large offer would blow
 * the URL length budget (availability) and inflate every downstream
 * verify. Enforced at resolve time — an offer past either bound is
 * rejected as an invalid scope rather than propagated.
 */
const MAX_PERMISSION_ENTRIES = 100;
const MAX_EMBEDDED_TEXT_BYTES = 8 * 1024;

/**
 * Short-lived, per-offer resolution cache. The offer read is an
 * unauthenticated outbound fetch triggered by `GET /oauth2/authorize`
 * with any valid client_id; caching the resolved result for a few
 * seconds blunts amplification (a burst of authorize calls for the same
 * client collapses to one outbound read) without meaningfully staling
 * the offer. Keyed by offer name + capability URL.
 */
const OFFER_CACHE_TTL_MS = 10 * 1000;
const offerCache = new Map<string, { expiresAt: number; offer: ResolvedOffer }>();

/** Clear the offer-resolution cache (test seam / operator reset). */
export function clearOfferCache (): void {
  offerCache.clear();
}

/**
 * Resolve one registered offer reference. Throws `OfferResolveError`
 * (mapped to RFC `invalid_scope` at the route edge) when the offer is
 * unreachable, expired, or malformed.
 */
export async function resolveOffer (params: {
  offerName: string;
  capabilityUrl: string;
  deps?: ResolveDeps;
}): Promise<ResolvedOffer> {
  const { offerName, capabilityUrl } = params;
  const fetchFn = params.deps?.fetch ?? fetch;

  const cacheKey = offerName + '\n' + capabilityUrl;
  const cached = offerCache.get(cacheKey);
  if (cached != null) {
    if (cached.expiresAt > Date.now()) return cached.offer;
    offerCache.delete(cacheKey);
  }

  let offerEvent;
  try {
    offerEvent = await readOfferViaCapability({
      capabilityUrl,
      deps: { fetch: fetchFn, timeoutMs: params.deps?.timeoutMs },
    });
  } catch (e: unknown) {
    const err = e as Error & { id?: string };
    throw new OfferResolveError(
      `offer "${offerName}" cannot be resolved: ${err.message}`, err.id);
  }

  let permissions;
  try {
    permissions = permissionsFromOffer(offerEvent);
  } catch (e: unknown) {
    const err = e as Error & { id?: string };
    throw new OfferResolveError(
      `offer "${offerName}" carries no valid permissions: ${err.message}`, err.id);
  }

  const content = (offerEvent?.content ?? {}) as Record<string, unknown>;
  const request = (content.request ?? {}) as Record<string, unknown>;
  const resolved: ResolvedOffer = {
    offerName,
    capabilityUrl,
    capabilityId: typeof content.capabilityId === 'string' ? content.capabilityId : null,
    offerEventId: typeof offerEvent?.id === 'string' ? offerEvent.id : null,
    permissions,
    allowUserChoice: allowsUserChoice(offerEvent),
  };
  if (isTextMap(request.title)) resolved.title = request.title;
  if (isTextMap(request.description)) resolved.description = request.description;
  if (isTextMap(request.consent)) resolved.consent = request.consent;
  if (content.requesterMeta != null && typeof content.requesterMeta === 'object') {
    resolved.requesterMeta = content.requesterMeta as Record<string, unknown>;
  }

  enforceEmbedBounds(offerName, resolved);

  offerCache.set(cacheKey, { expiresAt: Date.now() + OFFER_CACHE_TTL_MS, offer: resolved });
  return resolved;
}

/**
 * Reject an offer that would embed more than the allowed number of
 * permission entries or more than the allowed volume of consent /
 * requester text into the signed state. Belt-and-suspenders with the
 * capability-read body cap: that bounds the wire response; this bounds
 * what actually travels onward in the signed URL parameter.
 */
function enforceEmbedBounds (offerName: string, resolved: ResolvedOffer): void {
  if (resolved.permissions.length > MAX_PERMISSION_ENTRIES) {
    throw new OfferResolveError(
      `offer "${offerName}" carries too many permission entries ` +
      `(${resolved.permissions.length} > ${MAX_PERMISSION_ENTRIES})`,
      'cmc-offer-too-large');
  }
  const textBytes = Buffer.byteLength(JSON.stringify({
    title: resolved.title ?? null,
    description: resolved.description ?? null,
    consent: resolved.consent ?? null,
    requesterMeta: resolved.requesterMeta ?? null,
  }), 'utf8');
  if (textBytes > MAX_EMBEDDED_TEXT_BYTES) {
    throw new OfferResolveError(
      `offer "${offerName}" embeds too much text ` +
      `(${textBytes} > ${MAX_EMBEDDED_TEXT_BYTES} bytes)`,
      'cmc-offer-too-large');
  }
}

function isTextMap (v: unknown): v is LocalizableText {
  return v != null && typeof v === 'object' && !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((s) => typeof s === 'string');
}
