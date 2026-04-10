# Local Docker containers

Tools to test Docker image builds.

Requires an AMD64 machine with Docker accessible at user level.

1. Build images from the [release-packaging project](https://github.com/pryv/dev-release-packaging) on the local machine
2. `./build/build test` to build test Docker images
3. `./build/test/start.sh`  to run containers

To test with [lib-js](https://github.com/pryv/lib-js) 
use: `TEST_PRYVLIB_DNSLESS_URL="http://l.backloop.dev:3000/" just test all` from `lib-js` directory

# License

[BSD-3-Clause](LICENSE)
