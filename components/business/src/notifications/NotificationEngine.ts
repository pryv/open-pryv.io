/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { EventMatchQuery } from 'utils';
const require = createRequire(import.meta.url);
const { pubsub } = require('messages');
const { eventMatchesQuery, matchesStreamQuery, accessMatchesQuery } = require('utils').eventMatchQuery;

/**
 * Worker-local notification engine.
 *
 * Owns a single per-username subscription to `pubsub.scopedNotifications` and a
 * registry of subscribers (socket connections, webhooks, …). On each structured
 * change signal it evaluates every subscriber's standing scopes and delivers the
 * set of matched scope keys — never ids or content — to the subscriber's
 * transport adapter.
 *
 * The matching predicate is the shared `eventMatchesQuery` (the same semantics
 * `events.get` uses), so a scope is a standing `events.get` query. Stream and
 * access kinds are dispatched here too; their matchers land with their signals.
 */

type ScopeKind = 'events' | 'streams' | 'accesses';

/** A single named scope a subscriber is watching. */
type Scope = { key: string; kind: ScopeKind; query: EventMatchQuery };

/**
 * A registered consumer of scoped notifications. `deliver` receives the set of
 * scope keys matched by one change; the adapter decides how to transmit them
 * (socket emit, webhook buffer, …).
 */
type Subscriber = {
  id: string;
  scopes: Scope[];
  deliver: (matchedKeys: string[]) => void;
};

/** Structured payload carried on `pubsub.scopedNotifications`. */
type ScopedSignal = {
  kind: ScopeKind;
  changeType?: string;
  event?: { id?: string; streamIds: string[]; type?: string; content?: unknown; clientData?: unknown };
  stream?: { id: string; parentId?: string | null };
  access?: { id: string; type?: string; streamIds?: string[] };
};

class NotificationEngine {
  private readonly byUser: Map<string, Set<Subscriber>> = new Map();
  private readonly removers: Map<string, () => void> = new Map();

  /** Register a subscriber for `username`; opens the pubsub subscription lazily. */
  register (username: string, subscriber: Subscriber): void {
    let set = this.byUser.get(username);
    if (set == null) {
      set = new Set();
      this.byUser.set(username, set);
      const remover = pubsub.scopedNotifications.onAndGetRemovable(
        username,
        (payload: ScopedSignal) => this.onSignal(username, payload)
      );
      this.removers.set(username, remover);
    }
    set.add(subscriber);
  }

  /** Remove a subscriber; closes the pubsub subscription when none remain. */
  unregister (username: string, subscriber: Subscriber): void {
    const set = this.byUser.get(username);
    if (set == null) return;
    set.delete(subscriber);
    if (set.size === 0) {
      this.byUser.delete(username);
      const remover = this.removers.get(username);
      if (remover != null) {
        remover();
        this.removers.delete(username);
      }
    }
  }

  /** Number of subscribers currently registered for a username (test/introspection). */
  subscriberCount (username: string): number {
    return this.byUser.get(username)?.size ?? 0;
  }

  /** Handle one change signal: deliver matched keys to every interested subscriber. */
  onSignal (username: string, payload: ScopedSignal): void {
    const set = this.byUser.get(username);
    if (set == null || payload == null) return;
    for (const subscriber of set) {
      const matchedKeys = this.matchedKeys(subscriber, payload);
      if (matchedKeys.length > 0) subscriber.deliver(matchedKeys);
    }
  }

  private matchedKeys (subscriber: Subscriber, payload: ScopedSignal): string[] {
    const keys: string[] = [];
    for (const scope of subscriber.scopes) {
      if (scope.kind !== payload.kind) continue;
      if (this.scopeMatches(scope, payload)) keys.push(scope.key);
    }
    return keys;
  }

  private scopeMatches (scope: Scope, payload: ScopedSignal): boolean {
    switch (scope.kind) {
      case 'events':
        return payload.event != null && eventMatchesQuery(payload.event, scope.query);
      case 'streams': {
        // A changed stream matches if it — or its parent — falls within the
        // scope's (already access-bound, recursively-expanded) stream set. Using
        // the parent too lets a newly-created child match a watched parent scope.
        if (payload.stream == null) return false;
        const ids = [payload.stream.id];
        if (payload.stream.parentId != null) ids.push(payload.stream.parentId);
        return matchesStreamQuery(ids, scope.query.streams ?? []);
      }
      case 'accesses':
        return payload.access != null && accessMatchesQuery(payload.access, scope.query);
      default:
        return false;
    }
  }
}

// One engine per worker process.
const notificationEngine = new NotificationEngine();

export default notificationEngine;
export { NotificationEngine };
export type { Subscriber, Scope, ScopeKind, ScopedSignal };
