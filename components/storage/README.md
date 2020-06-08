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
# License
Copyright (c) 2020 Pryv S.A. https://pryv.com

This file is part of Open-Pryv.io and released under BSD-Clause-3 License

Redistribution and use in source and binary forms, with or without 
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, 
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, 
   this list of conditions and the following disclaimer in the documentation 
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors 
   may be used to endorse or promote products derived from this software 
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" 
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE 
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE 
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE 
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL 
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR 
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER 
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, 
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE 
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

SPDX-License-Identifier: BSD-3-Clause
