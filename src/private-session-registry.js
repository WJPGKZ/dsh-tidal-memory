import { join } from 'node:path';
import { openDatabase } from './database.js';

export class PrivateSessionRegistry {
  constructor(root) {
    this.db = openDatabase(join(root, 'system', 'private-sessions.sqlite3'));
    this.closed = false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS private_sessions (
      session_id TEXT PRIMARY KEY, space TEXT NOT NULL, lineage_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('exposed','inherited')),
      provider TEXT, model TEXT, updated_at TEXT NOT NULL
    );`);
  }
  get(sessionId) {
    return this.db.prepare('SELECT * FROM private_sessions WHERE session_id=?').get(sessionId) ?? null;
  }
  markExposed({ sessionId, space, lineageId, provider, model, now }) {
    this.db.prepare(`INSERT INTO private_sessions
      (session_id,space,lineage_id,state,provider,model,updated_at)
      VALUES(?,?,?,'exposed',?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      space=excluded.space,lineage_id=excluded.lineage_id,state='exposed',
      provider=excluded.provider,model=excluded.model,updated_at=excluded.updated_at`)
      .run(sessionId, space, lineageId, provider, model, now);
  }
  markInherited({ sessionId, space, lineageId, now }) {
    this.db.prepare(`INSERT INTO private_sessions
      (session_id,space,lineage_id,state,provider,model,updated_at)
      VALUES(?,?,?,'inherited',NULL,NULL,?) ON CONFLICT(session_id) DO UPDATE SET
      space=excluded.space,lineage_id=excluded.lineage_id,state='inherited',
      provider=NULL,model=NULL,updated_at=excluded.updated_at`)
      .run(sessionId, space, lineageId, now);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
