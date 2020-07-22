# Pryv storage component

Handles storage of user data on MongoDB.


## Contribute

Make sure to check the root README first.

## DB migration

1. Checkout tag that doesn't have your update's changes.
2. Generate dump
  1. Go to [components/test-helpers](../test-helpers) and run `yarn dump-test-data {old-version}`, providing the latest released version.
  2. If needed, add old indexes to [components/test-helpers/src/data/structure/{old-version}](../test-helpers/src/structure/).
  3. Stash your changes
  4. Checkout where you were on your feature branch
  5. unstash your dump
2. If migrating indexes, add current ones to [components/test-helpers/src/data/structure/{new-version}](../test-helpers/src/structure/).
3. Add your test to [test/Versions.test.js](test/Versions.test.js)
4. Implement your migration procedure in [src/migration/{newVersion}](src/migration/)

### Tests

- `yarn run test` (or `yarn test`) for quiet output
- `yarn run test-detailed` for detailed test specs and debug log output
- `yarn run test-profile` for profiling the tested server instance and opening the processed output with `tick-processor`
- `yarn run test-debug` is similar as `yarn run test-detailed` but in debug mode; it will wait for a debugger to be attached on port 5858