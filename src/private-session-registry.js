import { join } from 'node:path';
import { openDatabase, transaction } from './database.js';
import { requireValue } from './model.js';

export class PrivateSessionRegistry {
  constructor(root) {
    this.db = openDatabase(join(root, 'system', 'private-sessions.sqlite3'));
    this.closed = false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS private_sessions (
      session_id TEXT PRIMARY KEY, space TEXT NOT NULL, lineage_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('exposed','inherited')),
      provider TEXT, model TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_session_metadata (key TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO private_session_metadata VALUES('revision',0);
    CREATE TRIGGER IF NOT EXISTS private_session_insert AFTER INSERT ON private_sessions BEGIN
      UPDATE private_session_metadata SET revision=revision+1 WHERE key='revision';
    END;
    CREATE TRIGGER IF NOT EXISTS private_session_update AFTER UPDATE ON private_sessions
    WHEN OLD.state IS NOT NEW.state OR OLD.space IS NOT NEW.space OR OLD.lineage_id IS NOT NEW.lineage_id
      OR OLD.provider IS NOT NEW.provider OR OLD.model IS NOT NEW.model BEGIN
      UPDATE private_session_metadata SET revision=revision+1 WHERE key='revision';
    END;
    CREATE TRIGGER IF NOT EXISTS private_session_delete AFTER DELETE ON private_sessions BEGIN
      UPDATE private_session_metadata SET revision=revision+1 WHERE key='revision';
    END;`);
  }
  get(sessionId) {
    return this.db.prepare('SELECT * FROM private_sessions WHERE session_id=?').get(sessionId) ?? null;
  }
  version() {
    return this.db.prepare("SELECT revision FROM private_session_metadata WHERE key='revision'").get().revision;
  }
  blockedSessions() {
    return new Set(this.db.prepare("SELECT session_id FROM private_sessions WHERE state IN ('exposed','inherited')")
      .all().map(row => row.session_id));
  }
  markExposed({ sessionId, space, lineageId, provider, model, now }) {
    transaction(this.db, () => {
      const previous = this.get(sessionId);
      requireValue(previous?.state !== 'inherited', 'PRIVATE_SESSION_UNAUTHORIZED',
        '继承私人历史的会话不能转为已授权主会话。', 403);
      this.db.prepare(`INSERT INTO private_sessions
        (session_id,space,lineage_id,state,provider,model,updated_at)
        VALUES(?,?,?,'exposed',?,?,?) ON CONFLICT(session_id) DO UPDATE SET
        space=excluded.space,lineage_id=excluded.lineage_id,state='exposed',
        provider=excluded.provider,model=excluded.model,updated_at=excluded.updated_at`)
        .run(sessionId, space, lineageId, provider, model, now);
    });
  }
  markInherited({ sessionId, space, lineageId, now }) {
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO private_sessions
        (session_id,space,lineage_id,state,provider,model,updated_at)
        VALUES(?,?,?,'inherited',NULL,NULL,?) ON CONFLICT(session_id) DO UPDATE SET
        space=excluded.space,lineage_id=excluded.lineage_id,state='inherited',
        provider=NULL,model=NULL,updated_at=excluded.updated_at`)
        .run(sessionId, space, lineageId, now);
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
