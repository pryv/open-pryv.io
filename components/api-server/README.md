# api-server

Express server implementing the main Pryv.io API.

**Make sure to read the project's main README first.**


## Details specific to this component

### API

See the [Pryv.io API reference documentation](https://pryv.github.io/reference/).

### Nightly

The _[bin](https://github.com/pryv/service-core/tree/release-1.3/components/api-server/bin)_ folder contains a binary called _[nightly](https://github.com/pryv/service-core/blob/release-1.3/components/api-server/bin/nightly)_, which performs maintenance tasks such as computing and updating the storage usage for each existing users.

This binary can be manually executed with the following command (or be setup as cronjob):
> node components/api-server/bin/nightly --config config.json

The same command for a dockerized api-server would look like this:
> docker exec -ti pryv_core_1 app/bin/components/api-server/bin/nightly --config app/conf/core.yml

Note that these tasks can induce a heavy load on MongoDB, especially if the computation has to iterate through a lot of users.

### A note about tests

Acceptance tests covering the API methods use the HTTP API (that was implemented first); acceptance tests using Socket.IO only cover socket-specific functionality, not API commands.


# License

[BSD-3-Clause](LICENSE)
