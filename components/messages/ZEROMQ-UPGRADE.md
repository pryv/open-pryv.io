# ZeroMQ Upgrade Path

## Why consider ZeroMQ?

If cross-machine pub/sub or high-throughput messaging becomes a requirement,
ZeroMQ (`zeromq` npm v6.x) is a battle-tested option (20+ years, ~36K weekly npm downloads).

## Current architecture (unchanged)

```
Consumers (api-server, cache, webhooks, hfs-server)
    │  pubsub.emit() / pubsub.on()
    ▼
pubsub.js  ──  PubSub class (EventEmitter)
    │  delegates cross-process delivery to:
    ▼
tcp_pubsub.js  ──  Transport backend
    exports: init(), deliver(), subscribe(), setTestDeliverHook()
```

Consumers never touch the transport. Only `pubsub.js` line 99 picks the backend.

## How to add ZeroMQ without impacting the interface

1. Create `components/messages/src/zmq_pubsub.js` implementing the same 4 exports:
   - `init()` — bind XSUB+XPUB proxy (broker role) or connect pub+sub sockets (client role)
   - `deliver(scopeName, eventName, payload)` — `pub.send([scopeName, JSON.stringify({eventName, payload})])`
   - `subscribe(scopeName, pubsub)` — `sub.subscribe(scopeName)`, forward to `pubsub._emit()`
   - `setTestDeliverHook(hook)` — same test hook pattern

2. Change one line in `pubsub.js`:
   ```js
   // transport = require('./tcp_pubsub');
   transport = require('./zmq_pubsub');
   ```
   Or add a config switch: `messaging:transport: 'tcp' | 'zmq'`

3. No other file changes. All consumers, tests, constants stay identical.

## ZeroMQ specifics

- **npm**: `zeromq` (v6.5.0) — NOT `zmq` (legacy/deprecated)
- **Pattern**: XPUB/XSUB proxy — needs **2 ports** (e.g., 4222 for pub, 4223 for sub)
- **noEcho**: natural — Publisher sockets are write-only, Subscriber sockets are read-only
- **Topics**: prefix-based filtering at C level (e.g., subscribe to `"cache"` matches `"cache.userId"`)
- **Transports**: `tcp://`, `ipc://` (Unix socket), `inproc://` (threads)
- **Native addon**: prebuilt binaries for Linux x64/ARM64, macOS, Windows; falls back to C++ compilation

## Gotchas

- Alpine Docker: known segfault issues with musl libc — use Ubuntu-based images or force source build
- Two ports instead of one (XPUB + XSUB)
- Each process needs 2 sockets (pub + sub) vs 1 TCP connection with current broker
- Binary protocol (ZMTP) — harder to debug than JSON-over-TCP
- Last release: July 2024, 85 open issues — actively maintained but not hyper-active

## Skeleton implementation (~40 lines)

```js
const zmq = require('zeromq');
const { getConfig, getLogger } = require('@pryv/boiler');
const logger = getLogger('messages:pubsub:zmq');

let pub, sub, proxy;
let testDeliverHook = null;
const localSubs = new Map(); // scope → pubsub

async function init () {
  if (pub != null) return;
  const config = await getConfig();
  const pubPort = config.get('zmqBroker:pubPort') || 4222;
  const subPort = config.get('zmqBroker:subPort') || 4223;

  // Try broker role (XPUB/XSUB proxy)
  try {
    proxy = new zmq.Proxy(new zmq.XSubscriber(), new zmq.XPublisher());
    await proxy.frontEnd.bind(`tcp://127.0.0.1:${pubPort}`);
    await proxy.backEnd.bind(`tcp://127.0.0.1:${subPort}`);
    proxy.run(); // non-blocking, runs in worker thread
  } catch (err) {
    proxy = null; // another process is broker
  }

  pub = new zmq.Publisher();
  pub.connect(`tcp://127.0.0.1:${pubPort}`);

  sub = new zmq.Subscriber();
  sub.connect(`tcp://127.0.0.1:${subPort}`);

  // Receive loop
  (async () => {
    for await (const [topic, msg] of sub) {
      const scope = topic.toString();
      const { eventName, payload } = JSON.parse(msg.toString());
      const ps = localSubs.get(scope);
      if (ps) ps._emit(eventName, payload);
    }
  })();
}

async function deliver (scopeName, eventName, payload) {
  await init();
  if (testDeliverHook) testDeliverHook(scopeName, eventName, payload);
  if (payload == null) payload = '';
  await pub.send([scopeName, JSON.stringify({ eventName, payload })]);
}

async function subscribe (scopeName, pubsub) {
  await init();
  localSubs.set(scopeName, pubsub);
  sub.subscribe(scopeName);
  return { unsubscribe () { localSubs.delete(scopeName); sub.unsubscribe(scopeName); } };
}

function setTestDeliverHook (hook) { testDeliverHook = hook; }

module.exports = { init, deliver, subscribe, setTestDeliverHook };
```
