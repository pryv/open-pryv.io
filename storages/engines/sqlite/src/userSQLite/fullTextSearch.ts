/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// add full text search capabilities
// https://kimsereylam.com/sqlite/2020/03/06/full-text-search-with-sqlite.html

// Important notes.
// We use the "unicode61" tokenizer to be able to prevent word splitting with the
// following characters _-:
// see: https://sqlite.org/fts5.html#tokenizers

import type {} from 'node:fs';

module.exports = {
  setupForTable
};

/**
 * Add full text search capabilities on a specific table.
 * id defaults to 'rowid'; if provided, it must be an Integer primary key.
 */
function setupForTable (db: any, tableName: string, tableData: Record<string, any>, columnsToInclude: string[], id?: string): void {
  const itemId = id || 'rowid';
  const columnsTypes: string[] = [];
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
