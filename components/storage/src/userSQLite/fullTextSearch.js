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

// add full text search capabilities
// https://kimsereylam.com/sqlite/2020/03/06/full-text-search-with-sqlite.html

// Important notes.
// We use the "unicode61" tokenizer to be able to prevent word splitting with the
// following characters _-:
// see: https://sqlite.org/fts5.html#tokenizers

module.exports = {
  setupForTable
};

/**
 * Add full text search capabilities on a specific table
 * @param {SQLite3} db
 * @param {string} tableName
 * @param {Object} tableData
 * @param {Array} columnsToInclude - names of table to add to FTS
 * @param {string} [id=rowid] - (optional id for the table) ! column must be of "Integer" type an be a primary KEY
 */
function setupForTable (db, tableName, tableData, columnsToInclude, id) {
  const itemId = id || 'rowid';
  const columnsTypes = [];
  const columnNames = Object.keys(tableData);

  // create virtual table
  columnNames.forEach((columnName) => {
    const unindexed = columnsToInclude.includes(columnName) ? '' : ' UNINDEXED';
    if (columnName !== itemId) { columnsTypes.push(columnName + unindexed); }
  });
  columnsTypes.push(`content='${tableName}'`);
  columnsTypes.push(`content_rowid='${itemId}'`);

  db.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName}_fts USING fts5(` +
      columnsTypes.join(', ') + ', tokenize = "unicode61 remove_diacritics 0 tokenchars \'-_:.\'"' +
    ');').run();

  // create an fts_v table to query list of available terms
  db.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName}_fts_v USING fts5vocab(${tableName}_fts, 'row');`).run();

  // Triggers to update FTS table
  db.prepare(`CREATE TRIGGER IF NOT EXISTS ${tableName}_ai AFTER INSERT ON ${tableName}
    BEGIN
      INSERT INTO ${tableName}_fts (rowid, ${columnsToInclude.join(', ')})
        VALUES (new.${itemId}, new.${columnsToInclude.join(', new.')});
    END;
    `).run();

  db.prepare(`CREATE TRIGGER IF NOT EXISTS ${tableName}_ad AFTER DELETE ON ${tableName}
    BEGIN
      INSERT INTO ${tableName}_fts (${tableName}_fts, rowid, ${columnsToInclude.join(', ')})
        VALUES ('delete', old.${itemId}, old.${columnsToInclude.join(', old.')});
    END;
  `).run();

  db.prepare(`CREATE TRIGGER IF NOT EXISTS ${tableName}_au AFTER UPDATE ON ${tableName}
    BEGIN
      INSERT INTO ${tableName}_fts (${tableName}_fts, rowid, ${columnsToInclude.join(', ')})
        VALUES ('delete', old.${itemId}, old.${columnsToInclude.join(', old.')});
      INSERT INTO ${tableName}_fts (rowid,  ${columnsToInclude.join(', ')})
        VALUES (new.${itemId}, new.${columnsToInclude.join(', new.')});
    END;
  `).run();
}
