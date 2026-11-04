window.__ModuleLoader__.load({
  id: 'dsh-tidal-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const labels = { L0: '感知缓冲', L1: '工作记忆', L2: '情景记忆', L3: '长期知识' };
    const statuses = {
      pending: '待处理', candidate: '历史候选', active: '可召回', review: '需处理',
      completed: '已完成', cancelled: '已取消', superseded: '已替代', archived: '归档', processed: '已处理',
    };
    const kinds = { user_statement: '用户明确陈述', observation: '观测', inference: '推断',
      reflection: '主观反思', historical: '历史资料' };
    const horizons = { unspecified: '待归类', task: '任务期间', event: '历史事件', long_term: '长期有效' };
    const horizonsByLayer = { L0: 'unspecified', L1: 'task', L2: 'event', L3: 'long_term' };
    const css = `
      .tidal{--tidal-accent:var(--dsw-alias-state-business-primary,#197b85);--tidal-muted:var(--dsw-alias-label-secondary,#617381);--tidal-border:var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,#d4dfe3));--tidal-surface:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,transparent));font-family:inherit;color:var(--dsw-alias-label-primary,#182c3a);max-width:1120px;margin:auto;padding:4px 0 20px;box-sizing:border-box}
      .tidal *{box-sizing:border-box}.tidal h2,.tidal h3{margin:0 0 10px}.tidal small,.tidal .muted{color:var(--tidal-muted)}
      .tidal .hero{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:18px}
      .tidal .brand{font-size:24px;font-weight:700}.tidal .version{font-size:13px;font-weight:400;margin-left:10px;color:var(--tidal-accent)}.tidal .eyebrow{font-size:11px;letter-spacing:2px;color:var(--tidal-accent)}
      .tidal button,.tidal input,.tidal select,.tidal textarea{font:inherit;color:inherit}
      .tidal button{border:1px solid var(--tidal-border);border-radius:8px;background:transparent;padding:7px 12px;cursor:pointer}
      .tidal button:hover{border-color:var(--tidal-accent);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}.tidal button:disabled{opacity:.5;cursor:wait}
      .tidal button.primary{background:var(--dsw-alias-button-primary-fill,#167d76);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}.tidal button.danger{color:var(--dsw-alias-state-error-primary,#b43e46)}
      .tidal :focus-visible{outline:2px solid var(--tidal-accent);outline-offset:2px}
      .tidal .tabs{display:flex;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--tidal-border);margin-bottom:18px}
      .tidal .tabs button{border:0;border-bottom:3px solid transparent;border-radius:0;background:transparent;padding:12px 2px}.tidal .tabs button[aria-selected=true]{border-bottom-color:var(--tidal-accent);font-weight:650}
      .tidal .status-strip{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:12px 16px;margin-bottom:16px;border:1px solid var(--tidal-border);border-radius:10px;background:var(--tidal-surface)}
      .tidal .status-strip strong{font-size:13px;color:var(--tidal-accent)}.tidal .status-strip .ok{color:var(--dsw-alias-state-success-primary,#237a49)}
      .tidal .cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:12px 0 20px}
      .tidal .card,.tidal .panel{border:1px solid var(--tidal-border);border-radius:12px;padding:16px;background:var(--tidal-surface)}
      .tidal .card .count{font-size:30px;font-weight:650;margin:10px 0;color:var(--tidal-accent)}
      .tidal .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.tidal .stack>*+*{margin-top:12px}
      .tidal .split{display:grid;grid-template-columns:minmax(210px,1fr) minmax(280px,1.25fr);gap:14px}
      .tidal .list{max-height:550px;overflow:auto}.tidal .item{display:block;text-align:left;width:100%;padding:12px;margin-bottom:7px}
      .tidal .item[aria-selected=true]{border-color:var(--tidal-accent);box-shadow:inset 3px 0 var(--tidal-accent)}
      .tidal .item p{margin:5px 0;white-space:pre-wrap;word-break:break-word}.tidal .item small{font-size:11px}
      .tidal label{display:block;font-size:13px;color:var(--tidal-muted)}.tidal label span{display:block;margin-bottom:5px}
      .tidal input:not([type=checkbox]),.tidal select,.tidal textarea{width:100%;border:1px solid var(--tidal-border);background:var(--tidal-surface);border-radius:7px;padding:8px}
      .tidal textarea{min-height:150px;resize:vertical}.tidal .fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      .tidal .message{padding:11px 14px;border-radius:8px;background:var(--dsw-alias-state-success-fill,rgba(50,150,100,.1));color:var(--dsw-alias-state-success-primary,#226849);margin:10px 0;white-space:pre-wrap}
      .tidal .error{background:var(--dsw-alias-state-error-fill,rgba(200,60,60,.1));color:var(--dsw-alias-state-error-primary,#a5323f)}.tidal .empty{padding:32px 14px;text-align:center;color:var(--tidal-muted)}
      .tidal .badge{display:inline-block;font-size:12px;padding:3px 7px;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));color:var(--tidal-muted)}
      .tidal pre{white-space:pre-wrap;word-break:break-word;font:12px/1.65 ui-monospace,monospace;margin:8px 0;max-height:320px;overflow:auto}
      .tidal details{margin-top:14px}.tidal summary{cursor:pointer;font-size:13px}.tidal .path{font-size:11px;overflow-wrap:anywhere}
      .tidal .check{display:flex;gap:8px;align-items:center;padding:8px 0}.tidal .check span{margin:0}
      .tidal .private-card{padding:26px;border:1px dashed var(--tidal-accent);border-radius:12px;background:var(--tidal-surface)}
      .tidal .import-list{max-height:280px;overflow:auto}.tidal .import-list label{display:flex;gap:8px;margin-bottom:8px}
      @media(max-width:760px){.tidal .cards{grid-template-columns:repeat(2,1fr)}.tidal .split,.tidal .fields{grid-template-columns:1fr}.tidal{padding:10px}}
    `;
    async function request(space, path, body) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await fetch(`/tidal-memory${path}${separator}space=${encodeURIComponent(space)}`, {
        credentials: 'same-origin',
        ...(body === undefined ? {} : { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-tidal-request': '1' }, body: JSON.stringify(body) }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error?.message || `请求失败（${response.status}）`);
      return result.data;
    }
    function download(file) {
      const url = URL.createObjectURL(new Blob([file.text], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url; link.download = file.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function field(label, value, set, type = 'text', extra = {}) {
      return h('label', null, h('span', null, label), h('input', {
        type, value, onChange: event => set(type === 'number' ? Number(event.target.value) : event.target.value), ...extra,
      }));
    }
    function check(label, value, set) {
      return h('label', { className: 'check' }, h('input', {
        type: 'checkbox', checked: Boolean(value), onChange: event => set(event.target.checked),
      }), h('span', null, label));
    }
    function Page() {
      const [space, setSpace] = React.useState('default');
      const [tab, setTab] = React.useState('overview');
      const [status, setStatus] = React.useState(null);
      const [config, setConfig] = React.useState(null);
      const [layer, setLayer] = React.useState('L3');
      const [items, setItems] = React.useState({ total: 0, items: [] });
      const [query, setQuery] = React.useState('');
      const [offset, setOffset] = React.useState(0);
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const [extra, setExtra] = React.useState(null);
      const [recall, setRecall] = React.useState(null);
      const [traces, setTraces] = React.useState([]);
      const [password, setPassword] = React.useState('');
      const [restoreName, setRestoreName] = React.useState('');
      const [restoreText, setRestoreText] = React.useState('');
      const [privateImport, setPrivateImport] = React.useState(false);
      const [plan, setPlan] = React.useState(null);
      const [selected, setSelected] = React.useState([]);
      const [newCwd, setNewCwd] = React.useState('');
      const [newSpace, setNewSpace] = React.useState('');
      const generation = React.useRef(0);
      const initialSpace = React.useRef(true);

      async function refresh() {
        const version = ++generation.current;
        const data = await request(space, '/status');
        if (version !== generation.current) return;
        if (initialSpace.current) {
          initialSpace.current = false;
          if (data.config.bindings.length === 1 && data.config.bindings[0].space !== space) {
            setSpace(data.config.bindings[0].space);
            return;
          }
        }
        setStatus(data); setConfig(data.config);
      }
      React.useEffect(() => {
        setDraft(null); setPlan(null); setExtra(null); setRecall(null);
        refresh().catch(error => setNotice({ error: true, text: error.message }));
        return () => { generation.current++; };
      }, [space]);
      React.useEffect(() => {
        if (status?.unavailable) return;
        let live = true;
        if (tab === 'memories') request(space, `/memories?layer=${layer}&q=${encodeURIComponent(query)}&offset=${offset}`)
          .then(value => { if (live) setItems(value); })
          .catch(error => { if (live) setNotice({ error: true, text: error.message }); });
        if (tab === 'recall') request(space, '/traces').then(value => { if (live) setTraces(value); })
          .catch(error => { if (live) setNotice({ error: true, text: error.message }); });
        return () => { live = false; };
      }, [space, tab, layer, query, offset, status]);
      async function run(action, message) {
        setBusy(true); setNotice(null);
        try {
          const value = await action();
          if (message) setNotice({ text: typeof message === 'function' ? message(value) : message });
          await refresh();
          return value;
        } catch (error) {
          setNotice({ error: true, text: error.message });
        } finally { setBusy(false); }
      }
      const button = (label, action, style = '') => h('button', { type: 'button', disabled: busy, className: style, onClick: action }, label);
      const patchConfig = (key, value) => setConfig(current => ({ ...current, [key]: value }));
      const patchDraft = (key, value) => setDraft(current => ({ ...current, [key]: value }));
      const promotionText = () => draft.layer === 'L0'
        ? draft.text.replace(/^\s*(?:请)?(?:记住|记一下|remember)\s*[:：,，]\s*/i, '').trim()
        : draft.text;
      const saveConfig = () => run(() => request(space, '/config', {
        revision: status.settingsRevision, patch: config,
      }), '设置已保存。');
      const saveDraft = () => run(async () => {
        const patch = {
          text: draft.text, category: draft.category, status: draft.status, kind: draft.kind,
          factKey: draft.factKey || '', pinned: Boolean(draft.pinned),
          importance: Number(draft.importance ?? 0.5), tags: draft.tags || [],
          occurredAt: draft.occurredAt || null, validUntil: draft.validUntil || null,
          horizon: draft.horizon || 'unspecified', taskKey: draft.taskKey || '',
        };
        const saved = draft.id ? await request(space, '/update', { id: draft.id, revision: draft.revision, patch }) :
          await request(space, '/memories', { ...patch, layer, scope: 'space', sessionId: '', source: { kind: 'manual' } });
        setDraft(saved);
        return saved;
      }, value => `已保存 · ${statuses[value.status]}`);
      const choose = (label, key, values, labels = {}) => h('label', null, h('span', null, label),
        h('select', { 'aria-label': label, value: draft[key], onChange: e => patchDraft(key, e.target.value) },
          values.map(value => h('option', { key: value, value }, labels[value] || value))));

      let content;
      if (!status || !config) content = h('div', { className: 'empty' }, '正在读取记忆系统…');
      else if (status.unavailable) content = h('div', { className: 'panel stack', role: 'alert' },
        h('h3', null, '当前空间不可用，未保存或召回记忆'),
        h('p', null, `${status.spaceError.code} · ${status.spaceError.message}`),
        h('p', null, '不会抢锁或启动第二个写入者；占用解除后点击刷新。暂停期间的消息不会伪装成已保存，也不会自动回放。'),
        button('重试打开空间', () => run(() => Promise.resolve())));
      else if (tab === 'overview') content = h('div', { className: 'stack' },
        h('div', { className: 'cards' }, status.layers.map(info => h('div', { className: 'card', key: info.id },
          h('small', null, `${info.id} / ${info.name}`), h('div', { className: 'count' }, info.count),
          h('div', { className: 'row' }, h('span', { className: 'badge' }, `${info.pending} 项待处理`),
            button('打开', () => { setLayer(info.id); setOffset(0); setTab('memories'); })),
          h('p', { className: 'path muted' }, info.directory)))),
        h('div', { className: 'panel stack' },
          h('h3', null, '同工作区共享，不按会话分库'),
          h('p', { className: 'muted' }, '四层分别落盘。新记忆自动保存并参与召回，无需逐条审核；可召回不等于已核实。人工确认和纠错是可选操作，冲突不会自动覆盖。'),
          h('p', null, `整理和检索均在本地完成，不发起整理模型调用 · 每轮预算 ${config.tokenBudget}（UTF-8 字节保守估算）`),
          h('p', { className: 'muted' }, config.injectContext
            ? '已开启普通记忆上下文：选中的记忆会随当前聊天请求发送给你配置的模型。'
            : '自动记忆上下文已关闭；聊天模型主动调用记忆工具时，工具结果仍会进入聊天请求。'),
          status.legacyModelExtractionIgnored ? h('div', { className: 'message' },
            '已忽略旧版后台模型提炼配置；此版本不会为整理调用模型。') : null,
          config.bindings.length === 0 ? h('div', { className: 'message' }, '尚未绑定工作区。请在“设置与迁移”中绑定；未绑定前不会读取或捕获聊天。') : null,
          h('div', { className: 'row' }, button('立即整理', () => run(() => request(space, '/maintenance', {}), value =>
            value.waitingForConversation ? '对话正在运行，整理已等待。' : JSON.stringify(value)), 'primary'),
          button('管理工作区绑定', () => setTab('settings'))),
          h('small', null, '当前没有人格配置。本插件不会建立身份、情绪或主动聊天。')),
        status.maintenance ? h('div', { className: 'panel' }, h('h3', null, '最近维护'), h('pre', null, JSON.stringify(status.maintenance, null, 2))) : null);
      else if (tab === 'memories') content = h('div', { className: 'stack' },
        h('div', { className: 'row' },
          ...Object.keys(labels).map(id => button(`${id} ${labels[id]}`, () => { setLayer(id); setOffset(0); setDraft(null); }, layer === id ? 'primary' : '')),
          button('新建', () => setDraft({ text: '', layer, category: layer === 'L1' ? 'task' : 'event',
            status: layer === 'L0' ? 'pending' : 'active', kind: 'user_statement', horizon: horizonsByLayer[layer],
            taskKey: '', pinned: false, importance: 0.5 }))),
        field('搜索当前层', query, value => { setQuery(value); setOffset(0); }),
        h('div', { className: 'split' },
          h('div', { className: 'panel list' },
            h('small', null, `共 ${items.total} 条 · 工作区所有会话共享`),
            ...items.items.map(item => h('button', { className: 'item', key: item.id, 'aria-selected': draft?.id === item.id,
              onClick: () => { setDraft(item); setExtra(null); } },
              h('small', null, `${statuses[item.status]} · ${horizons[item.horizon || horizonsByLayer[item.layer]]} · ${kinds[item.kind]} · ${(item.sources || [item.source]).length} 个出处`),
              h('p', null, [...item.text].slice(0, 110).join('')),
              h('small', null, item.occurredAt || '事件时间未知'))),
            items.total === 0 ? h('div', { className: 'empty' }, '这一层还没有记忆。') : null,
            h('div', { className: 'row' }, button('上一页', () => setOffset(Math.max(0, offset - 50))),
              h('small', null, `${offset + 1}–${Math.min(offset + 50, items.total)}`),
              button('下一页', () => { if (offset + 50 < items.total) setOffset(offset + 50); }))),
          draft ? h('div', { className: 'panel stack' },
            h('h3', null, draft.id ? '编辑记忆' : '新建记忆'),
            h('textarea', { 'aria-label': '记忆正文', value: draft.text, onChange: e => patchDraft('text', e.target.value) }),
            h('div', { className: 'fields' },
              choose('状态', 'status', Object.keys(statuses), statuses),
              choose('性质', 'kind', Object.keys(kinds), kinds),
              choose('有效范围', 'horizon', Object.keys(horizons), horizons),
              choose('分类', 'category', ['event', 'task', 'preference', 'agreement', 'knowledge', 'identity', 'self', 'observation']),
              field('重要度（0–1）', draft.importance ?? 0.5, v => patchDraft('importance', v), 'number', { min: 0, max: 1, step: 0.1 })),
            field('事实 / 任务键（用于识别冲突或独立事件）', draft.factKey || '', v => patchDraft('factKey', v)),
            field('关联任务键（可选）', draft.taskKey || '', v => patchDraft('taskKey', v)),
            field('事件时间（ISO，未知留空）', draft.occurredAt || '', v => patchDraft('occurredAt', v)),
            field('失效时间（ISO，可选）', draft.validUntil || '', v => patchDraft('validUntil', v)),
            check('保护：不自动淡忘，不代表永远正确', draft.pinned, v => patchDraft('pinned', v)),
            h('div', { className: 'row' }, button('保存', saveDraft, 'primary'),
              draft.id ? button('来源与版本', () => run(async () => {
                const history = await request(space, `/history?id=${draft.id}`);
                setExtra({ sources: draft.sources || [draft.source], history }); return history;
              })) : null,
              draft.id ? button('人工确认 / 强化（可选）', () => run(async () => {
                const saved = await request(space, '/confirm', { id: draft.id }); setDraft(saved); return saved;
              }, '已记录一次人工确认；实际召回的轻量强化另行计数，不冒充人工确认。')) : null),
            draft.id ? h('div', { className: 'row' },
              ...['L1', 'L2', 'L3'].filter(id => id !== draft.layer).map(id => button(`归类到 ${id}`, () => run(() =>
                request(space, '/promote', { id: draft.id, target: { layer: id, text: promotionText(),
                  status: 'active', horizon: draft.horizon, taskKey: draft.taskKey || '' } }),
              '已创建或合并目标候选，原记忆保留。'))),
              button('删除', () => {
                if (window.prompt('删除此记忆及派生记录。备份不受影响。输入 DELETE 确认：') === 'DELETE')
                  run(async () => { const value = await request(space, '/forget', { id: draft.id, confirmation: 'DELETE' }); setDraft(null); return value; }, value => value.notice);
              }, 'danger')) : null,
            extra ? h('details', { open: true }, h('summary', null, '来源 / 历史版本'), h('pre', null, JSON.stringify(extra, null, 2))) : null
          ) : h('div', { className: 'panel empty' }, '选择一条记忆，查看出处或进行修订。')));
      else if (tab === 'recall') content = h('div', { className: 'stack' },
        h('div', { className: 'panel stack' }, h('h3', null, '试着回忆'),
          field('检索内容', query, setQuery),
          h('div', { className: 'row' },
            button('普通召回', () => run(async () => { setRecall(await request(space, '/recall', { query })); }), 'primary'),
            button('包含归档', () => run(async () => { setRecall(await request(space, '/recall', { query, includeArchived: true })); }))),
          recall ? h('pre', null, JSON.stringify(recall, null, 2)) : null),
        h('div', { className: 'panel' }, h('h3', null, '最近召回记录'),
          h('small', null, '只记录普通记忆的选择原因和预算，不包含私人日记。'),
          ...traces.map((trace, i) => h('details', { key: i }, h('summary', null, `${trace.at} · ${trace.picked.length} 条`),
            h('pre', null, JSON.stringify(trace, null, 2))))));
      else if (tab === 'private') content = h('div', { className: 'stack' },
        h('div', { className: 'private-card stack' }, h('div', { className: 'eyebrow' }, 'PRIVATE JOURNAL'),
          h('h2', null, '私人记录，不展示正文'),
          h('p', null, `${status.private.count} 篇 · ${(status.private.bytes / 1024).toFixed(1)} KiB`),
          h('p', { className: 'muted' }, `最近写入：${status.private.lastWritten || '尚无记录'}`),
          h('p', null, status.private.generation),
          h('p', { className: 'path' }, status.private.directory),
          h('small', null, '不出现在普通搜索、模型召回和明文备份中。此隔离不是对本机管理员或其他任意文件工具的绝对保密。')),
        h('div', { className: 'panel stack' },
          field('允许的作者插件名称（逗号分隔）', config.privateWriters.join(','),
            value => patchConfig('privateWriters', value.split(',').map(x => x.trim()).filter(Boolean))),
          button('保存作者权限', saveConfig, 'primary'),
          button('清空私人记录', () => {
            if (window.prompt('这不会清除旧备份。输入 DELETE PRIVATE JOURNAL 确认：') === 'DELETE PRIVATE JOURNAL')
              run(() => request(space, '/private/clear', { confirmation: 'DELETE PRIVATE JOURNAL' }), '当前私人记录已清空，旧备份未删除。');
          }, 'danger')));
      else content = h('div', { className: 'stack' },
        h('div', { className: 'panel stack' }, h('h3', null, '工作区绑定'),
          h('small', null, '一个工作区对应一个空间。同工作区的全部原生会话共享记忆；子代理第一版默认不参与。'),
          ...config.bindings.map((binding, i) => h('div', { className: 'row', key: binding.cwd },
            h('code', { className: 'path' }, `${binding.cwd} → ${binding.space}`),
            button('解除', () => patchConfig('bindings', config.bindings.filter((_, index) => index !== i))))),
          h('div', { className: 'fields' }, field('工作区绝对路径', newCwd, setNewCwd), field('空间名（小写字母、数字或短横线）', newSpace, setNewSpace)),
          h('div', { className: 'row' },
            button('添加绑定', () => { patchConfig('bindings', [...config.bindings, { cwd: newCwd, space: newSpace }]); setNewCwd(''); setNewSpace(''); }),
            ...[...new Set(status.sessions.map(s => s.cwd).filter(Boolean))].slice(0, 4).map(cwd =>
              button(`使用 ${cwd}`, () => setNewCwd(cwd)))),
          h('p', { className: 'path muted' }, `数据根：${status.root}。更换根目录须停止插件、备份迁移并重启。`)),
        h('div', { className: 'panel stack' }, h('h3', null, '记忆策略'),
          check('启用记忆捕获与召回', config.enabled, value => patchConfig('enabled', value)),
          check('自动记录并召回用户陈述（本地规则，无需审核）', config.autoCandidates, value => patchConfig('autoCandidates', value)),
          check('额外保存助手全文到短期 L0（默认关闭）', config.captureAssistant, value => patchConfig('captureAssistant', value)),
          check('将本地召回的普通记忆附加到当前聊天请求', config.injectContext, value => patchConfig('injectContext', value)),
          h('p', { className: 'muted' }, '关闭后不自动注入记忆，但模型主动调用记忆工具仍可读取普通记忆。整理不发起额外模型请求。'),
          h('div', { className: 'fields' },
            field('最低相关性分数', config.minScore, value => patchConfig('minScore', value), 'number', { min: 0, max: 1, step: 0.05 }),
            field('相对最高分门槛', config.relativeFloor, value => patchConfig('relativeFloor', value), 'number', { min: 0, max: 1, step: 0.05 })),
          h('div', { className: 'fields' },
            ...[
              ['tokenBudget', '总预算（UTF-8 字节估算）', 256, 192000],
              ['maxRecall', '相关记忆条数（常驻、来源关联另计）', 1, 100],
              ['residentBudget', 'L3 常驻额度（包含在总预算内）', 0, 192000],
              ['contextMessages', '近期用户消息窗口', 1, 10],
              ['workingHours', 'L1 工作记忆有效时长（小时，0 不自动到期）', 0, 8760],
              ['halfLifeDays', '情景记忆半衰期（天）', 1, 3650],
              ['idleMinutes', '空闲后整理（分钟）', 1, 1440],
              ['bufferHours', '已处理缓冲保留（小时）', 1, 720],
              ['backupKeep', '自动恢复点保留数量', 1, 90],
            ].map(([key, label, min, max]) => h(React.Fragment, { key },
              field(label, config[key], value => patchConfig(key, value), 'number', { min, max })))),
          h('label', null, 'L3 常驻范围', h('select', { value: config.residentMode,
            onChange: event => patchConfig('residentMode', event.target.value) },
            ...[['all', '全部有效 L3（默认）'], ['core', '身份、偏好、约定及固定项'], ['pinned', '仅固定项']]
              .map(([value, label]) => h('option', { key: value, value }, label)))),
          h('p', { className: 'muted' }, '常驻不等于已核实；过期、待审核和已被替代的条目不注入。常驻先使用独立额度，但总预算仍是硬上限。近期消息逐条匹配，不用无关内容凑数。'),
          check('空闲时执行小整理（纯本地规则）', config.autoConsolidate, value => patchConfig('autoConsolidate', value)),
          check('低重要且未使用的旧 L2 自动归档（保存满八个半衰期，不删除）', config.autoArchive, value => patchConfig('autoArchive', value)),
          h('div', { className: 'fields' },
            field('每日深度整理时间（本机时间，留空关闭）', config.dailyConsolidateAt,
              value => patchConfig('dailyConsolidateAt', value), 'time'),
            h('div', { className: 'stack' },
              h('small', null, `上次深度整理：${status.deepConsolidation ?
                `${new Date(status.deepConsolidation.at).toLocaleString()} · ${status.deepConsolidation.manual ? '手动' : '定时'} · 提炼 ${status.deepConsolidation.promoted} 条` : '尚未运行'}`),
              h('small', null, `下次预计：${status.nextDailyConsolidationAt ?
                new Date(status.nextDailyConsolidationAt).toLocaleString() : '已关闭'}`))),
          h('p', { className: 'muted' }, '深度整理只运行本地确定性规则，不调用模型。宿主运行时每分钟检查；关机或退出期间不运行，下次启动并达到空闲时长后补跑最近一次。待补跑时预计时间会显示已过去的应执行时间。每次整理前另存普通记忆恢复点，不含 L0 和私人日记。L1 时长仅影响此后自动捕获的任务，已有有效期不变。'),
          button('立即深度整理一次', () => run(() => request(space, '/consolidate', {}),
            value => `深度整理完成：检查 ${value.inspected} 条，提炼 ${value.promoted} 条，冲突待复核 ${value.conflicts} 条，跳过 ${value.skipped} 组${value.skipped ? '（请查看错误诊断）' : ''}。`)),
          check('自动备份 L1-L3，不含 L0、来源摘录和私人日记', config.autoBackup, value => patchConfig('autoBackup', value)),
          h('div', { className: 'row' }, button('保存设置', saveConfig, 'primary'),
            button('重建搜索索引', () => run(() => request(space, '/rebuild/search', {}), '搜索索引已重建。')),
            button('重建可读文件', () => run(() => request(space, '/rebuild/views', {}), 'L1-L3 可读视图已重建，旧 L0 生成副本已清理。'))),
          h('p', { className: 'muted' }, 'L0 仍是明文短期缓冲，不生成新 Markdown 副本。重建可读文件只清理带原生成标记的旧 L0 副本，不删除手写文件。旧备份可能含完整会话原文，不受 72 小时清理约束，需另行检查和删除。')),
        h('div', { className: 'panel stack' }, h('h3', null, '旧记忆导入'),
          h('p', { className: 'muted' }, '选择 Markdown、文本或 fish-memory JSON。先预览，后导入；旧资料不会自动成为当前人格。'),
          check('本批文件全部作为私人记录（预览不显示正文）', privateImport, setPrivateImport),
          h('input', { type: 'file', multiple: true, accept: '.md,.markdown,.txt,.json', 'aria-label': '选择旧记忆文件',
            onChange: event => {
              const files = [...event.target.files];
              run(async () => {
                const result = await request(space, '/import/preview', { files: await Promise.all(files.map(async file =>
                  ({ name: file.name, text: await file.text(), private: privateImport }))) });
                setPlan(result); setSelected(result.candidates.map(c => c.importId));
              });
            } }),
          plan ? h('div', { className: 'stack' },
            h('small', null, `${plan.candidates.length} 条普通候选，${plan.privateCount} 个私人文件；预览 20 分钟后过期。`),
            h('div', { className: 'import-list' }, ...plan.candidates.map(candidate => h('label', { key: candidate.importId },
              h('input', { type: 'checkbox', checked: selected.includes(candidate.importId), onChange: event =>
                setSelected(current => event.target.checked ? [...current, candidate.importId] : current.filter(id => id !== candidate.importId)) }),
              h('span', null, `${candidate.layer} · ${[...candidate.text].slice(0, 120).join('')}`)))),
            button('确认导入选中内容', () => run(async () => {
              const result = await request(space, '/import/apply', { id: plan.id, selected }); setPlan(null); return result;
            }, value => value.status), 'primary')) : null),
        h('div', { className: 'panel stack' }, h('h3', null, '备份与恢复'),
          h('p', { className: 'muted' }, '新备份只含 L1-L3 正文及历史，不含 L0 和来源摘录；主动保存的记忆仍可能含敏感片段。旧备份不会自动改写或删除。'),
          field('加密口令（至少 12 字符；填写后备份包含私人记录）', password, setPassword, 'password', { autoComplete: 'new-password' }),
          button('下载备份', () => run(async () => {
            const result = await request(space, '/backup', { password }); download(result); setPassword('');
          }, '备份已交给浏览器下载；请妥善保存。')),
          h('hr'),
          field('恢复到新空间（不得与现有空间重名）', restoreName, setRestoreName),
          h('input', { type: 'file', accept: '.json,.encrypted', 'aria-label': '选择备份文件', onChange: event => {
            const file = event.target.files[0];
            if (file) run(async () => setRestoreText(await file.text()));
          } }),
          button('恢复到新空间', () => run(async () => {
            const result = await request(space, '/restore', { name: restoreName, text: restoreText, password });
            setRestoreText(''); setPassword(''); return result;
          }, value => `已恢复到 ${value.space}，请绑定对应工作区后使用。`))));

      return h('main', { className: 'tidal', 'data-plugin': 'tidal-memory' },
        h('div', { className: 'hero' }, h('div', null, h('div', { className: 'eyebrow' }, 'TIDAL MEMORY'),
          h('div', { className: 'brand' }, '潮汐记忆', h('span', { className: 'version' }, 'v0.3.0')), h('small', null, '跨会话连续 · 按工作区隔离 · 四层独立存储')),
          h('div', { className: 'row' }, h('select', { 'aria-label': '记忆空间', disabled: busy, value: space, onChange: e => setSpace(e.target.value) },
            (status?.spaces || ['default']).map(name => h('option', { key: name, value: name }, name))),
            button('刷新', () => run(() => Promise.resolve())))),
        status ? h('div', { className: 'status-strip', 'aria-label': '记忆服务状态' },
          h('strong', null, '状态'), h('span', { className: status.unavailable ? 'badge' : 'badge ok' },
            status.unavailable ? '记忆服务：当前空间已暂停' : '记忆服务：已挂载'),
          h('span', { className: 'badge' }, `空间：${space}`),
          h('span', { className: 'badge' }, status.config.bindings.some(b => b.space === space) ? '工作区：已绑定' : '工作区：未绑定'),
          h('span', { className: 'badge' }, status.unavailable ? '整理与检索：不可用' : '整理与检索：本地运行'),
          h('span', { className: 'badge' }, `上下文注入：${status.config.injectContext ? '已开启' : '已关闭'}`)) : null,
        h('nav', { className: 'tabs', 'aria-label': '记忆管理' },
          ...[['overview', '总览'], ['memories', '分层记忆'], ['recall', '回忆与整理'], ['private', '私人日记'], ['settings', '设置与迁移']]
            .map(([id, label]) => h('button', { key: id, type: 'button', role: 'tab', 'aria-selected': tab === id, onClick: () => { setTab(id); setNotice(null); } }, label))),
        notice ? h('div', { className: `message ${notice.error ? 'error' : ''}`, role: notice.error ? 'alert' : 'status' }, notice.text) : null,
        status?.error ? h('div', { className: 'message error' }, `${status.error.code} · ${status.error.message}`) : null,
        status?.searchIndex?.some(index => !index.current) ? h('div', { className: 'message error', role: 'alert' },
          '分词索引需要升级，旧索引不会参与召回。请在设置中重建搜索索引。') : null,
        ...(status?.errors || []).map((error, i) => h('div', { className: 'message error', key: i }, `${error.code} · ${error.message}`)),
        content);
    }
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error: error.message }; }
      render() {
        return this.state.error ? h('div', { role: 'alert' }, `潮汐记忆界面加载失败：${this.state.error}`) : h(Page);
      }
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent = css; document.head.appendChild(style);
          return () => style.remove();
        });
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'tidal-memory', order: 32,
          label: () => '潮汐记忆', inject: () => ({}),
        }, Boundary));
      },
    };
  },
});
