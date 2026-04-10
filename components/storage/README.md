# storage

Handles storage of user data on MongoDB.

**Make sure to read the project's main README first.**


## Details specific to this component

### DB migration

1. Checkout tag that doesn't have your update's changes.
2. Generate dump
  1. `just test-data dump ${old-version}`, providing the latest released version (`testData.resetUsers` might alter data with `buildCustomAccountProperties()`)
  2. If needed, add old indexes to [components/test-helpers/src/data/structure/${old-version}](../test-helpers/src/structure/).
  3. Stash your changes
  4. Checkout where you were on your feature branch
  5. Unstash your dump
3. If migrating indexes, add current ones to [components/test-helpers/src/data/structure/${new-version}](../test-helpers/src/structure/).
4. Add your test to [test/Versions.test.js](test/Versions.test.js)
5. Implement your migration procedure in [src/migration/${new-version}](src/migration/)


# License

[BSD-3-Clause](LICENSE)
