/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin: the features of a relationship (`chat`, `systemMessaging`).
 *
 * The requester offers them (`content.request.features` on the
 * `consent/request-cmc`, each one defaulting to true when absent). The
 * accepter may only narrow them: a `false` on the accept turns a feature off,
 * a `true` never turns on one the offer turned off. The server resolves the
 * pair on each side from its own copy of the offer and stamps the resolved
 * value everywhere the relationship records it (both relationship accesses,
 * the accept trigger, the delivered accept, the inbox mirror), so every
 * reader sees the same two booleans.
 *
 * What the resolved value controls: `chat: false` provisions no per-peer chat
 * stream and no chat permission, and a counterparty's direct chat write is
 * refused; `systemMessaging: false` refuses user alerts / acks (the
 * collectors stream stays, scope requests ride it).
 */

type Features = { chat: boolean; systemMessaging: boolean };

type FeaturesLike = { chat?: unknown; systemMessaging?: unknown } | null | undefined;

function isPlainObject (value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The features an offer grants: each one true unless the offer's
 * `request.features` sets it to `false`. Takes the offer's `content` (or
 * anything without a usable `request.features`, which yields both true).
 */
function featuresFromOffer (offerContent: unknown): Features {
  const request = isPlainObject(offerContent) ? offerContent.request : null;
  const features = isPlainObject(request) && isPlainObject(request.features) ? request.features : {};
  return {
    chat: features.chat !== false,
    systemMessaging: features.systemMessaging !== false,
  };
}

/**
 * The relationship's features: the offered ones, narrowed by the accept.
 * A pure AND, so the accept can turn a feature off but never on. The result
 * always holds exactly the two booleans.
 */
function resolveFeatures (offered: Features, requested: FeaturesLike): Features {
  const req = isPlainObject(requested) ? requested : {};
  return {
    chat: offered.chat === true && req.chat !== false,
    systemMessaging: offered.systemMessaging === true && req.systemMessaging !== false,
  };
}

export { featuresFromOffer, resolveFeatures };
export type { Features };
