# Local Docker containers

Tools to test Docker image builds.

Requires an AMD64 machine with Docker accessible at user level.

1. `docker build -t localhost/pryvio/open-pryv.io:test .` from the repository root to build the test image (the root `Dockerfile` is the one releases are built from)
2. `./build/test/start.sh`  to run containers

> **Stale:** this compose harness dates from v1 and has not been exercised since
> (it still references InfluxDB 1.7.8 and the separate register/mail services).
> Expect to fix it up before it runs.

To test with [lib-js](https://github.com/pryv/lib-js) 
use: `TEST_PRYVLIB_DNSLESS_URL="http://l.backloop.dev:3000/" just test all` from `lib-js` directory

# License

[BSD-3-Clause](LICENSE)
