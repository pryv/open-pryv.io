/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Per-user SQLite database holding high-frequency series points.
 *
 * Schema (mirrors the PG `series_data` table minus the `user_id` column,
 * since the file is per-user):
 *
 *   CREATE TABLE series_data (
 *     event_id    TEXT    NOT NULL,
 *     point_time  INTEGER NOT NULL,
 *     delta_time  INTEGER NOT NULL,
 *     fields      TEXT    NOT NULL,         -- JSON
 *     PRIMARY KEY (event_id, point_time)
 *   );
 *   CREATE INDEX idx_event_delta ON series_data(event_id, delta_time);
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const SQLite3 = require('better-sqlite3');
const concurrentSafeWrite = require('../concurrentSafeWrite.ts');

class SeriesDatabase {
  db: any;
  logger: any;

  constructor (logger: any, params: { dbPath: string }) {
    this.logger = logger;
    this.db = new SQLite3(params.dbPath, {});
  }

  async init (): Promise<void> {
    await concurrentSafeWrite.initWALAndConcurrentSafeWriteCapabilities(this.db);

    await concurrentSafeWrite.execute(() => {
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS series_data (
          event_id    TEXT    NOT NULL,
          point_time  INTEGER NOT NULL,
          delta_time  INTEGER NOT NULL,
          fields      TEXT    NOT NULL,
          PRIMARY KEY (event_id, point_time)
        )
      `).run();
    });

    await concurrentSafeWrite.execute(() => {
      this.db.prepare('CREATE INDEX IF NOT EXISTS idx_event_delta ON series_data(event_id, delta_time)').run();
    });

    this.insertStmt = this.db.prepare(`
      INSERT INTO series_data (event_id, point_time, delta_time, fields)
      VALUES (@event_id, @point_time, @delta_time, @fields)
      ON CONFLICT (event_id, point_time)
      DO UPDATE SET delta_time = excluded.delta_time, fields = excluded.fields
    `);
    this.deleteByEventStmt = this.db.prepare('DELETE FROM series_data WHERE event_id = ?');
    this.deleteAllStmt = this.db.prepare('DELETE FROM series_data');
    this.distinctEventsStmt = this.db.prepare('SELECT DISTINCT event_id FROM series_data');
    this.countStmt = this.db.prepare('SELECT COUNT(*) AS count FROM series_data');
  }

  insertStmt: any;
  deleteByEventStmt: any;
  deleteAllStmt: any;
  distinctEventsStmt: any;
  countStmt: any;

  async writePoints (rows: Array<{ event_id: string, point_time: number, delta_time: number, fields: string }>): Promise<void> {
    if (rows.length === 0) return;
    await concurrentSafeWrite.execute(() => {
      const insertMany = this.db.transaction((batch: any[]) => {
        for (const row of batch) this.insertStmt.run(row);
      });
      insertMany(rows);
    });
  }

  async dropEvent (eventId: string): Promise<void> {
    await concurrentSafeWrite.execute(() => {
      this.deleteByEventStmt.run(eventId);
    });
  }

  async dropAll (): Promise<void> {
    await concurrentSafeWrite.execute(() => {
      this.deleteAllStmt.run();
    });
  }

  listEventIds (): string[] {
    return this.distinctEventsStmt.all().map((r: any) => r.event_id);
  }

  /**
   * Run a parameterised SELECT and return raw rows.
   * Callers shape the SQL; we accept a single statement string + params array.
   */
  selectRows (sql: string, params: any[] = []): any[] {
    return this.db.prepare(sql).all(...params);
  }

  count (): number {
    return this.countStmt.get().count;
  }

  close (): void {
    this.db.close();
  }
}

export { SeriesDatabase };
