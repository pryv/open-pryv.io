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
module.exports = [
  {
    id: 'c_0',
    name: 'Channel Zero (no overlap)',
    parentId: null,
    singleActivity: true,
    children: [
      {
        id: 'c_0_f_0',
        name: 'Root Folder 0',
        parentId: 'c_0',
        children: [
          {
            id: 'c_0_f_0_0',
            name: 'Child Folder 0.0',
            parentId: 'c_0_f_0',
            children: []
          },
          {
            id: 'c_0_f_0_1',
            name: 'Child Folder 0.1',
            parentId: 'c_0_f_0',
            children: []
          }
        ]
      },
      {
        id: 'c_0_f_1',
        name: 'Root Folder 1',
        parentId: 'c_0',
        clientData: {
          stringProp: 'O Brother',
          numberProp: 1
        },
        children: []
      },
      {
        id: 'c_0_f_2',
        name: 'Root Folder 2',
        parentId: 'c_0',
        children: [
          {
            id: 'c_0_f_2_0',
            name: 'Child Folder 2.0',
            parentId: 'c_0_f_2',
            children: []
          },
          {
            id: 'c_0_f_2_1',
            name: 'Child Folder 2.1',
            parentId: 'c_0_f_2',
            children: [
              {
                id: 'c_0_f_2_1_0',
                name: 'Child Folder 2.1.0',
                parentId: 'c_0_f_2_1',
                children: []
              }
            ]
          }
        ]
      },
      {
        id: 'c_0_f_3',
        name: 'Root Folder 3 (trashed)',
        parentId: 'c_0',
        trashed: true,
        children: [
          {
            id: 'c_0_f_3_0',
            name: 'Child Folder 3.0',
            parentId: 'c_0_f_3',
            children: []
          }
        ]
      }
    ]
  },
  {
    id: 'c_1',
    name: 'Channel One',
    parentId: null,
    clientData: {
      stringProp: 'O Brother',
      numberProp: 1
    },
    children: [
      {
        id: 'c_1_f_4',
        name: 'Test Folder (channel 1)',
        parentId: 'c_1',
        children: []
      }
    ]
  },
  {
    id: 'c_2',
    name: 'Channel Two (trashed)',
    parentId: null,
    trashed: true,
    children: [
      {
        id: 'c_2_f_5',
        name: 'Test Folder (channel 2)',
        parentId: 'c_2',
        children: []
      }
    ]
  },
  {
    id: 'c_3',
    name: 'Channel Three',
    parentId: null,
    children: [
      {
        id: 'c_3_f_6',
        name: 'Test Folder (channel 3)',
        parentId: 'c_3',
        children: []
      }
    ]
  }
];
