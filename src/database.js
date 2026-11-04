import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error(`Unsupported database version: ${version}`);
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
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, fact_key TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS by_scope ON memories(scope, session_id, status);
    CREATE INDEX IF NOT EXISTS by_fact ON memories(fact_key, scope, session_id);
    CREATE TABLE IF NOT EXISTS revisions (
      id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(id, revision)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, words, tokenize='unicode61');
    PRAGMA user_version=1;
  `);
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
