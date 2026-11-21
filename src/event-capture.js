import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { transaction } from './database.js';
import { classifyRememberDirective, containsCredential, ENCODING_VERSION, hash, MemoryError,
  requireValue, splitCapture } from './model.js';

const DONE = new Set(['saved', 'empty', 'review']);
const MAX_ATTEMPTS = 5;
const textOf = message => (Array.isArray(message?.content) ? message.content : [])
  .filter(block => block?.type === 'text' && typeof block.text === 'string')
  .map(block => block.text).join('\n').toWellFormed();
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:@-]{1,256}$/.test(value);
const safeCount = value => Number.isSafeInteger(value) && value >= 0;
const sensitivePath = value => /(?:^|[\\/._-])(?:private|secrets?|credentials?|passwords?|tokens?|\.ssh|\.aws|\.gnupg|\.env)(?:$|[\\/._-])/i.test(value);

function within(path, directory) {
  const suffix = relative(resolve(directory), resolve(path));
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function allowedTarget(value, store, binding, bindings) {
  if (typeof value !== 'string' || value.length > 2048 || !isAbsolute(value) ||
      /[\u0000-\u001f\u007f]/.test(value) || sensitivePath(value)) return null;
  const path = resolve(value);
  if (path.split(/[\\/]/).some(part => /^\.tidal-memory(?:$|-init-)/i.test(part)) ||
    ['spaces', 'system', 'secrets', 'backups', 'recovery'].some(name => within(path, join(store.root, name)))) return null;
  const owner = bindings.filter(item => within(path, item.cwd))
    .sort((a, b) => b.cwd.length - a.cwd.length)[0];
  if (owner && owner.space !== binding.space) return null;
  return path;
}

export function assistantClaim(text) {
  if (containsCredential(text) || text.includes('```')) return '';
  return text.split(/[\r\n]+/).map(line => line.trim()).find(line => line.length <= 280 &&
    /^(?:(?:我|我们)(?:已经|已)|(?:已经|已))(?:完成|修改|创建|删除|更新|安装|发布|部署|修复|迁移|保存|写入|测试|验证)/.test(line)) ?? '';
}

function describe(event) {
  const type = ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(event.type) ?
    event.type : 'other';
  const data = event.data ?? {};
  const message = type === 'user/message' ? data : type === 'assistant/message' || type === 'tool/result' ? data.message : null;
  const user = type === 'user/message' && message?.role === 'user' && message.source?.kind === 'user';
  const assistant = type === 'assistant/message' && message?.role === 'assistant' && !data.interrupted;
  const text = user || assistant ? textOf(message) : '';
  const sensitive = containsCredential(text);
  const at = new Date(event.time);
  requireValue(Number.isFinite(at.getTime()), 'CAPTURE_INVALID_EVENT', '事件时间无效，未记录内容。');
  const fields = [type, event.seq, at.toISOString()];
  if (user || assistant) fields.push(sensitive ? 'sensitive' : hash(text));
  if (type === 'tool/call') fields.push(data.callId, data.name, data.turn, data.step);
  if (type === 'tool/result') fields.push(message?.toolCallId, message?.source?.kind, message?.source?.callId,
    message?.role, message?.isError, data.turn, data.step, event.sourceEventSeqs,
    typeof data.meta?.path === 'string' ? hash(data.meta.path) : null, data.meta?.operation);
  return { type, data, message, user, assistant, text, sensitive, at: at.toISOString(),
    fingerprint: hash(JSON.stringify(fields)) };
}

export class EventCapture {
  constructor(store) {
    this.store = store;
  }
  begin(sessionId, event, descriptor) {
    const store = this.store, db = store.system, now = store.now();
    requireValue(safeId(sessionId) && safeCount(event.seq), 'CAPTURE_INVALID_EVENT', '会话或事件标识无效，未记录内容。');
    let existing, waitingUnchanged = false;
    transaction(db, () => {
      existing = db.prepare('SELECT * FROM capture_receipts WHERE session_id=? AND event_seq=?').get(sessionId, event.seq);
      if (!existing) {
        db.prepare(`INSERT INTO capture_receipts
          (session_id,event_seq,event_type,fingerprint,state,reason,attempts,source_ids,record_ids,
            call_id,rule_version,forget_version,first_seen_at,updated_at)
          VALUES(?,?,?,?,'pending','',1,'[]','[]',?,?,?, ?,?)`)
          .run(sessionId, event.seq, descriptor.type, descriptor.fingerprint,
            safeId(descriptor.data.callId) ? descriptor.data.callId :
              safeId(descriptor.message?.toolCallId) ? descriptor.message.toolCallId : null,
            ENCODING_VERSION, store.forgetVersion(), now, now);
        db.prepare(`INSERT INTO capture_sessions(session_id,first_seq,contiguous_seq,last_seq,started_at,updated_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
          first_seq=min(first_seq,excluded.first_seq),
          contiguous_seq=CASE WHEN excluded.first_seq<first_seq THEN excluded.first_seq-1 ELSE contiguous_seq END,
          last_seq=max(last_seq,excluded.last_seq),updated_at=excluded.updated_at`)
          .run(sessionId, event.seq, event.seq - 1, event.seq, now, now);
      } else if (existing.fingerprint !== descriptor.fingerprint || existing.event_type !== descriptor.type) {
        db.prepare(`UPDATE capture_receipts SET state='failed',reason='SOURCE_CHANGED',updated_at=?
          WHERE session_id=? AND event_seq=?`).run(now, sessionId, event.seq);
        db.prepare(`UPDATE capture_sessions SET contiguous_seq=min(contiguous_seq,?),updated_at=?
          WHERE session_id=?`).run(event.seq - 1, now, sessionId);
      } else if (existing.state === 'waiting' && descriptor.type === 'tool/result' &&
          !db.prepare('SELECT 1 FROM capture_calls WHERE session_id=? AND call_id=?').get(sessionId, existing.call_id)) {
        waitingUnchanged = true;
      } else if (!DONE.has(existing.state) && existing.attempts < MAX_ATTEMPTS) {
        db.prepare(`UPDATE capture_receipts SET state='pending',attempts=attempts+1,updated_at=?
          WHERE session_id=? AND event_seq=?`).run(now, sessionId, event.seq);
      }
    });
    if (existing && (existing.fingerprint !== descriptor.fingerprint || existing.event_type !== descriptor.type))
      throw new MemoryError('CAPTURE_SOURCE_CHANGED', '已登记事件的内容或身份发生变化，未重新处理。', 409);
    if (existing && DONE.has(existing.state)) return { alreadyProcessed: true, state: existing.state };
    if (existing && existing.forget_version !== store.forgetVersion()) {
      this.finish(sessionId, event.seq, { state: 'review', reason: 'FORGET_CHANGED' });
      return { alreadyProcessed: true, state: 'review' };
    }
    if (waitingUnchanged) return { alreadyProcessed: true, state: 'waiting' };
    if (existing && existing.attempts >= MAX_ATTEMPTS) {
      db.prepare(`UPDATE capture_receipts SET state='failed',reason='RETRY_LIMIT',updated_at=?
        WHERE session_id=? AND event_seq=?`).run(now, sessionId, event.seq);
      return { alreadyProcessed: true, state: 'failed' };
    }
    return null;
  }
  finish(sessionId, seq, { state, reason, sourceIds = [], recordIds = [] }) {
    const db = this.store.system, now = this.store.now();
    requireValue(['saved', 'empty', 'review', 'waiting'].includes(state), 'CAPTURE_INVALID_STATE', '捕获状态无效。');
    transaction(db, () => {
      db.prepare(`UPDATE capture_receipts SET state=?,reason=?,source_ids=?,record_ids=?,updated_at=?
        WHERE session_id=? AND event_seq=?`)
        .run(state, reason, JSON.stringify(sourceIds), JSON.stringify(recordIds), now, sessionId, seq);
      let cursor = db.prepare('SELECT contiguous_seq AS seq FROM capture_sessions WHERE session_id=?').get(sessionId).seq;
      const read = db.prepare('SELECT state FROM capture_receipts WHERE session_id=? AND event_seq=?');
      while (DONE.has(read.get(sessionId, cursor + 1)?.state)) cursor++;
      db.prepare('UPDATE capture_sessions SET contiguous_seq=?,updated_at=? WHERE session_id=?').run(cursor, now, sessionId);
    });
    return { state, reason, sourceIds, recordIds };
  }
  fail(sessionId, seq, error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'CAPTURE_FAILED';
    const now = this.store.now();
    transaction(this.store.system, () => {
      this.store.system.prepare(`UPDATE capture_receipts SET state='failed',reason=?,updated_at=?
        WHERE session_id=? AND event_seq=?`).run(code, now, sessionId, seq);
      this.store.system.prepare(`UPDATE capture_sessions SET contiguous_seq=min(contiguous_seq,?),updated_at=?
        WHERE session_id=?`).run(seq - 1, now, sessionId);
    });
  }
  process(session, event, binding, config) {
    const descriptor = describe(event);
    const existing = this.begin(session.id, event, descriptor);
    if (existing) return existing;
    try {
      this.store.requireOrdinaryWriter({ sessionId: session.id });
      if (this.store.forgetLedger.hasEvent(this.store.lineageId, session.id, event.seq))
        return this.finish(session.id, event.seq, { state: 'empty', reason: 'forgotten-source' });
      let result;
      if (descriptor.user) result = this.user(session.id, event.seq, descriptor);
      else if (descriptor.assistant) result = this.assistant(session.id, event.seq, descriptor, config);
      else if (descriptor.type === 'tool/call') result = this.call(session.id, event.seq, descriptor, config);
      else if (descriptor.type === 'tool/result') result = this.result(session.id, event, descriptor, binding, config);
      else result = { state: 'empty', reason: descriptor.type === 'user/message' ? 'non-user-origin' : 'not-capturable' };
      if (result.state === 'saved' || result.state === 'review') this.store.failpoint('after-capture-write');
      return this.finish(session.id, event.seq, result);
    } catch (error) {
      if (error.code === 'FORGOTTEN') return this.finish(session.id, event.seq, { state: 'empty', reason: 'forgotten' });
      this.fail(session.id, event.seq, error);
      throw error;
    }
  }
  user(sessionId, seq, descriptor) {
    if (descriptor.sensitive) return { state: 'empty', reason: 'sensitive' };
    if (!descriptor.text.trim()) return { state: 'empty', reason: 'empty-message' };
    const chunks = splitCapture(descriptor.text), directive = classifyRememberDirective(descriptor.text);
    const sourceIds = [], recordIds = [], reasons = new Set();
    for (const [index, chunk] of chunks.entries()) {
      if (!chunk.text.trim()) continue;
      const source = this.store.capture({ sessionId, eventId: seq, text: chunk.text, role: 'user', at: descriptor.at,
        ...(chunks.length > 1 ? { chunk: { index, count: chunks.length, offset: chunk.offset, inCodeFence: chunk.inCodeFence,
          ...(index && directive ? { directive: { layer: directive.layer, category: directive.category,
            horizon: directive.horizon } } : {}) } } : {}) });
      sourceIds.push(source.id);
      this.store.organizePending(1, source.id);
      const row = this.store.system.prepare('SELECT result FROM encodings WHERE source_id=?').get(source.id);
      const encoded = row ? JSON.parse(row.result) : null;
      if (encoded) {
        reasons.add(encoded.reason);
        recordIds.push(...(encoded.recordIds ?? []));
      }
      if (!encoded || !Array.isArray(encoded.recordIds)) recordIds.push(...this.targetsFor(source.id));
    }
    const ids = [...new Set(recordIds)];
    return { state: ids.length ? 'saved' : 'empty', reason: ids.length ? 'encoded' :
      [...reasons].sort().join(',') || 'no-output', sourceIds, recordIds: ids };
  }
  targetsFor(sourceId) {
    return ['L1', 'L2', 'L3'].flatMap(layer => this.store.db(layer).prepare(`SELECT id FROM memories
      WHERE json_array_length(data,'$.parents')>0
      AND EXISTS (SELECT 1 FROM json_each(memories.data,'$.parents') WHERE value=?)`).all(sourceId).map(row => row.id));
  }
  assistant(sessionId, seq, descriptor, config) {
    if (!config.autoCandidates) return { state: 'empty', reason: 'disabled' };
    const claim = assistantClaim(descriptor.text);
    if (!claim) return { state: 'empty', reason: descriptor.sensitive ? 'sensitive' : 'no-claim' };
    const focus = this.store.sessionFocus({ sessionId });
    const record = this.store.create({ layer: 'L2', text: `助手自述（待核）：${claim}`, category: 'event',
      kind: 'inference', status: 'review', horizon: 'event', sessionId, occurredAt: descriptor.at,
      parents: focus.taskRef ? [focus.taskRef] : [],
      source: { kind: 'session', sessionId, eventId: String(seq), role: 'assistant', at: descriptor.at } }, { admin: true });
    return { state: 'review', reason: 'assistant-claim-unverified', recordIds: [record.id] };
  }
  call(sessionId, seq, descriptor, config) {
    const { data } = descriptor;
    if (!safeId(data.callId) || !safeCount(data.turn) || !safeCount(data.step))
      return { state: 'review', reason: 'invalid-tool-call' };
    const tool = config.autoCandidates && ['write', 'edit'].includes(data.name) ? data.name : 'ignored';
    const focus = tool === 'ignored' ? { taskRef: null, sceneRef: null } : this.store.sessionFocus({ sessionId });
    const previous = this.store.system.prepare('SELECT * FROM capture_calls WHERE session_id=? AND call_id=?')
      .get(sessionId, data.callId);
    if (previous) {
      requireValue(previous.event_seq === seq && previous.turn === data.turn && previous.step === data.step &&
        previous.tool === tool, 'CAPTURE_CALL_CONFLICT', '工具调用标识重复或发生变化，未配对结果。', 409);
    } else {
      this.store.system.prepare(`INSERT INTO capture_calls
        (session_id,call_id,event_seq,turn,step,tool,task_ref,scene_ref)
        VALUES(?,?,?,?,?,?,?,?)`).run(sessionId, data.callId, seq, data.turn, data.step, tool,
        focus.taskRef, focus.sceneRef);
    }
    return { state: 'empty', reason: tool === 'ignored' ? 'unsupported-tool' : 'tool-call-registered' };
  }
  result(sessionId, event, descriptor, binding, config) {
    const { data, message } = descriptor, callId = message?.toolCallId;
    if (!safeId(callId) || message?.role !== 'tool' || message?.source?.kind !== 'tool' ||
        message.source.callId !== callId || !safeCount(data.turn) || !safeCount(data.step))
      return { state: 'review', reason: 'invalid-tool-result' };
    const call = this.store.system.prepare('SELECT * FROM capture_calls WHERE session_id=? AND call_id=?').get(sessionId, callId);
    if (!call) return { state: 'waiting', reason: 'call-not-seen' };
    if (call.tool === 'ignored') return { state: 'empty', reason: 'unsupported-tool' };
    if (data.turn !== call.turn || data.step !== call.step || call.event_seq >= event.seq ||
        !Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length !== 1 ||
        event.sourceEventSeqs[0] !== call.event_seq || typeof message.isError !== 'boolean')
      return { state: 'review', reason: 'unpaired-tool-result' };
    let operation = 'error', target = null;
    if (!message.isError) {
      operation = call.tool === 'edit' ? 'update' : data.meta?.operation;
      target = allowedTarget(data.meta?.path, this.store, binding, config.bindings);
      if (!['create', 'update'].includes(operation) || !target)
        return { state: 'review', reason: 'unverified-or-excluded-target' };
    }
    const task = call.task_ref ? this.store.rawOrdinary(call.task_ref) : null;
    const taskRef = task && task.layer === 'L1' && this.store.visible(task, { sessionId }) ? task.id : null;
    const sceneRef = call.scene_ref && this.store.system.prepare(`SELECT 1 FROM scene_members
      WHERE scene_id=? AND session_id=?`).get(call.scene_ref, sessionId) &&
      !this.store.quarantinedSceneIds.has(call.scene_ref) ? call.scene_ref : null;
    const text = message.isError ? `工具 ${call.tool} 报告调用失败；目标文件是否变化以及任务结果均未确认。` :
      `工具 ${call.tool} 回执报告${operation === 'create' ? '创建' : '更新'}了文件 ${target}；未验证文件内容或任务目标。`;
    const record = this.store.create({ layer: 'L2', text, category: 'event', kind: 'observation',
      status: 'active', horizon: 'event', sessionId, occurredAt: descriptor.at,
      parents: taskRef ? [taskRef] : [],
      source: { kind: 'host-tool-receipt', sessionId, eventId: String(event.seq), role: 'tool', at: descriptor.at,
        callId, callSeq: call.event_seq, turn: call.turn, step: call.step, tool: call.tool, operation,
        ...(taskRef ? { taskRef } : {}), ...(sceneRef ? { sceneRef } : {}) } }, { admin: true });
    return { state: 'saved', reason: message.isError ? 'tool-reported-error' : 'tool-reported-write', recordIds: [record.id] };
  }
  pending(sessionId, callId) {
    return this.store.system.prepare(`SELECT event_seq AS seq FROM capture_receipts
      WHERE session_id=? AND call_id=? AND event_type='tool/result' AND state='waiting'
      ORDER BY event_seq LIMIT 20`).all(sessionId, callId).map(row => row.seq);
  }
  status() {
    this.store.reconcileForgetLedger();
    const blocked = this.store.blockedSessionIds;
    const rows = this.store.system.prepare(`SELECT session_id,event_type,state,reason FROM capture_receipts
      WHERE event_type IN ('user/message','assistant/message','tool/result')
      OR (event_type='tool/call' AND state<>'empty')`).all()
      .filter(row => !blocked.has(row.session_id));
    const sessions = this.store.system.prepare('SELECT * FROM capture_sessions').all()
      .filter(row => !blocked.has(row.session_id));
    const counts = { saved: 0, empty: 0, review: 0, waiting: 0, failed: 0, pending: 0 };
    const reasons = {};
    for (const row of rows) {
      if (Object.hasOwn(counts, row.state)) counts[row.state]++;
      if (row.reason) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
    }
    return { counts, reasons, sessions: sessions.length,
      startedAt: sessions.map(row => row.started_at).sort()[0] ?? null,
      sessionsWithGaps: sessions.filter(row => row.contiguous_seq < row.last_seq).length,
      coverage: '仅覆盖启用后实际收到的事件；停用期间、启用前和私人历史不在覆盖范围。' };
  }
}
