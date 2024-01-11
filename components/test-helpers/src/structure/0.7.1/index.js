/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
// File built manually by copying indexes (that will change during migration)
// from different collections specifications in storage/src/user
module.exports = {
  indexes: {
    events: [
      {
        index: { time: 1 },
        options: {}
      },
      {
        index: { streamId: 1 },
        options: {}
      },
      {
        index: { tags: 1 },
        options: {}
      },
      // no index by content until we have more actual usage feedback
      {
        index: { trashed: 1 },
        options: {}
      },
      {
        index: { modified: 1 },
        options: {}
      },
      {
        index: { deleted: 1 },
        options: {
          // cleanup deletions after a year
          expireAfterSeconds: 3600 * 24 * 365
        }
      }
    ],
    streams: [
      {
        index: { name: 1 },
        options: {}
      },
      {
        index: { name: 1, parentId: 1 },
        options: { unique: true, sparse: true }
      },
      {
        index: { trashed: 1 },
        options: {}
      },
      {
        index: { deleted: 1 },
        options: {
          // cleanup deletions after a year
          expireAfterSeconds: 3600 * 24 * 365
        }
      }
    ],
    accesses: [
      {
        index: { token: 1 },
        options: { unique: true, sparse: true }
      },
      {
        index: { name: 1, type: 1, deviceName: 1 },
        options: { unique: true, sparse: true }
      },
      {
        index: { deleted: 1 },
        options: {
          // cleanup deletions after 3 years (cf. HIPAA rules)
          expireAfterSeconds: 3600 * 24 * 365 * 3
        }
      }
    ]
  }
};
