import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 3) throw new Error(`Unsupported database version: ${version}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function createLayer(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, scope TEXT NOT NULL, session_id TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, fact_key TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0, valid_until TEXT
    );
    CREATE INDEX IF NOT EXISTS by_scope ON memories(scope, session_id, status);
    CREATE INDEX IF NOT EXISTS by_fact ON memories(fact_key, scope, session_id);
    CREATE TABLE IF NOT EXISTS revisions (
      id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(id, revision)
    );
    CREATE TABLE IF NOT EXISTS retrieval_events (
      id TEXT NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY(id, evidence)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, words, tokenize='unicode61');
    CREATE TABLE IF NOT EXISTS index_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  transaction(db, () => {
    const columns = db.prepare('PRAGMA table_info(memories)').all();
    if (!columns.some(column => column.name === 'pinned')) {
      db.exec(`ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
        UPDATE memories SET pinned=CASE WHEN json_extract(data, '$.pinned')=1 THEN 1 ELSE 0 END;`);
    }
    if (!columns.some(column => column.name === 'valid_until')) {
      db.exec(`ALTER TABLE memories ADD COLUMN valid_until TEXT;
        UPDATE memories SET valid_until=json_extract(data, '$.validUntil');`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS by_status_pinned ON memories(status,pinned);
      CREATE INDEX IF NOT EXISTS by_status_updated ON memories(status,updated_at);
      CREATE INDEX IF NOT EXISTS by_status_created ON memories(status,created_at);
      CREATE INDEX IF NOT EXISTS by_exact_text ON memories(json_extract(data,'$.text'));
      CREATE INDEX IF NOT EXISTS by_has_parents ON memories(id) WHERE json_array_length(data,'$.parents')>0;
      CREATE INDEX IF NOT EXISTS by_status_expiry ON memories(status,valid_until);
      CREATE INDEX IF NOT EXISTS by_status_valid_from ON memories(status,json_extract(data,'$.validFrom'));
      PRAGMA user_version=3;`);
  });
}
export function atomicFile(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}
