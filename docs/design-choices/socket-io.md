# Socket.IO transport policy in cluster mode

## Context

`bin/master.js` runs api-server as a Node.js cluster (`cluster.apiWorkers`,
default 2). Each worker calls `https.createServer().listen(443)`; Node's
cluster module shares the listener across workers via `SCHED_RR`
(round-robin). Master is not in the request path — it owns ACME, cluster
fan-out, IPC, and the embedded TCP pub/sub broker, but workers terminate
TLS independently.

Socket.IO is mounted by `components/api-server/src/socket-io/index.js` on
the api-server's express app. Real-time change notifications
(`eventsChanged`, `streamsChanged`, `accessesChanged`) are delivered to
connected sockets via the in-master `tcp_pubsub` broker that fans changes
out to every worker (so any worker can push notifications to the sockets
it holds).

## Problem

Engine.IO (the transport layer under socket.io) opens with HTTP long-polling
by default and may upgrade to WebSocket. Polling sends multiple HTTP
round-trips that **must** land on the same worker for the engine.io
session to make progress — the `sid` returned in the OPEN packet is
worker-local. With `SCHED_RR`, the second polling request lands on a
different worker that doesn't recognise the `sid` and the handshake
fails. Result: the server returns
`HTTP 400 {"code":0,"message":"Transport unknown"}` on every polling
probe. Clients with default reconnect settings hammer the endpoint
indefinitely (up to one reconnect every 5 s, no give-up).

## Decision

In cluster mode, the socket.io server is configured with
`transports: ['websocket']`:

```js
// components/api-server/src/socket-io/index.js
new Server(httpServer, {
  allowEIO3: true,
  cors: { origin: true, credentials: true },
  ...(cluster.isWorker ? { transports: ['websocket'] } : {})
});
```

Outside cluster mode (single-process dev / tests) both transports are
allowed; inside cluster mode polling is rejected at the protocol level.

A WebSocket connection is one persistent TCP socket — once accepted by
worker N it stays on worker N for its lifetime. No session-affinity
problem.

### Client-side contract

Clients **must** connect with `transports: ['websocket']` to skip the
polling probe entirely. The reference client implementation is
`@pryv/socket.io` ≥ 3.0.2:

```js
io(socketEndpoint, { forceNew: true, transports: ['websocket'] });
```

Earlier versions (≤ 3.0.1) probe polling first, hit the 400 above, and
trigger a reconnect storm. Bumping to 3.0.2 (or any client that sets
`transports: ['websocket']`) is the fix.

## Tradeoff

- **Lost capability:** HTTP-polling fallback for clients on networks that
  block WebSockets (some corporate firewalls, very old proxies).
- **Practical impact today:** zero — polling has never worked in cluster
  mode. We are not removing capability that exists; we are stopping
  clients from probing something that can't work.
- **Performance gain:** clients skip the polling round-trip, so the time
  to first real-time event drops by ~one RTT.

## When to revisit (= switch to sticky-session polling)

Adopt sticky sessions and re-enable polling if **any** of these become true:

- Reports of corporate / firewall users unable to receive real-time
  updates (look for "Connection failed" issues against `app.datasafe.dev`
  or any other Pryv-backed UI; check WebSocket-specific symptoms).
- Plans to support a client that cannot do WebSockets (e.g. a particular
  embedded SDK, IoT firmware).
- Any deployment where the network path between client and server is
  known to break long-lived WebSocket connections.

The switch path (sticky sessions) is **not free**: it requires either

1. taking 443 ownership away from the per-worker `https.createServer` and
   moving it to master.js, terminating TLS in master, sniffing
   `engine.io` cookies / `sid` to route per-session — substantial
   refactor; or
2. introducing a shared adapter (`@socket.io/redis-adapter` + Redis) so
   workers share session state — adds a Redis dependency the deploy
   stack doesn't otherwise need.

Either is a properly-scoped project, not an emergency response. Track
under a dedicated plan in `_plans/` if/when the trigger conditions hit.

## Operational notes

- **Clients don't need a server change to upgrade.** Bumping
  `@pryv/socket.io` (or any wrapper that sets `transports: ['websocket']`)
  is sufficient. Server-side this file is the contract; the code at
  `components/api-server/src/socket-io/index.js` enforces it.
- **APM noise.** Old clients still in the wild (browser tabs that
  never refreshed) will continue to generate `HttpError 400`
  TransactionErrors on `WebTransaction/NormalizedUri/*` until they pick
  up the new bundle. If APM error-rate alerts trigger after a deploy,
  check `request.headers.userAgent` and `request.headers.host` — a
  single stuck tab can produce ~17 k errors/day at the default
  reconnect cadence.
- **No restart needed when toggling cluster size.** The `transports`
  config is set at boot per worker based on `cluster.isWorker`; restart
  the cluster as you would normally and the policy reapplies.

## References

- `components/api-server/src/socket-io/index.js` — server config.
- `components/api-server/src/socket-io/Manager.js` — namespace + pubsub
  bridge.
- `bin/master.js` — cluster fan-out.
- `components/messages/src/pubsub.js` + `tcp_pubsub.js` — cross-worker
  notification delivery.
- `@pryv/socket.io` v3.0.2 (npm) — reference client implementation.
