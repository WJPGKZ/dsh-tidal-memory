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
    const archiveReasons = { manual: '人工归档', expired: '有效期结束', inactivity: '长期低使用自动归档',
      unknown: '旧记录未保存原因' };
    const activationAnchors = { recall: '最近召回', confirmation: '人工确认', event: '事件时间', creation: '创建时间' };
    const taskStates = { queued: '排队中', running: '运行中', completed: '已完成', cancelled: '已让出', failed: '失败' };
    const horizonsByLayer = { L0: 'unspecified', L1: 'task', L2: 'event', L3: 'long_term' };
    const css = `
      .tidal{--tidal-accent:var(--dsw-alias-state-business-primary,#197b85);--tidal-muted:var(--dsw-alias-label-secondary,#617381);--tidal-border:var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,#d4dfe3));--tidal-surface:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,transparent));font-family:inherit;color:var(--dsw-alias-label-primary,#182c3a);max-width:1120px;margin:auto;padding:4px 0 20px;box-sizing:border-box}
      .tidal *{box-sizing:border-box}.tidal h2,.tidal h3{margin:0 0 10px}.tidal small,.tidal .muted{color:var(--tidal-muted)}
      .tidal fieldset{min-width:0;border:0;margin:0;padding:0}.tidal summary,.tidal .row strong{overflow-wrap:anywhere}
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
      .tidal .graph-canvas{display:block;width:100%;height:460px;border:1px solid var(--tidal-border);border-radius:10px;touch-action:none;cursor:grab}
      .tidal .graph-canvas:active{cursor:grabbing}.tidal .graph-node{cursor:pointer}.tidal .graph-node rect{fill:var(--dsw-alias-settings-card-fill,#fff);stroke:var(--tidal-accent);stroke-width:1.5}
      .tidal .graph-node text{fill:var(--dsw-alias-label-primary,#182c3a);font-size:13px;pointer-events:none}.tidal .graph-node.selected rect{stroke-width:3}
      .tidal .graph-edge{stroke:var(--tidal-accent);stroke-width:1.5;opacity:.7}.tidal .graph-edge.suggested{stroke-dasharray:6 5}
      .tidal .graph-edge.excluded{stroke:var(--dsw-alias-state-error-primary,#b43e46);stroke-dasharray:3 5}
      .tidal .graph-list{max-height:520px;overflow:auto}.tidal .graph-list h4{margin:14px 0 6px}
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
    const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const workspaceName = row => row?.title === 'default-workspace' ? '默认工作区' : row?.title;
    const pathKey = value => /^[a-z]:[\\/]|^\\\\/i.test(value) ? value.replaceAll('/', '\\').toLowerCase() : value;
    const hostRow = (binding, rows) => binding && rows.find(row => binding.workspaceId ?
      row.id === binding.workspaceId && pathKey(row.cwd) === pathKey(binding.cwd) : pathKey(row.cwd) === pathKey(binding.cwd));
    const spaceLabel = (binding, rows) => binding?.displayName || workspaceName(hostRow(binding, rows)) || binding?.space;
    function pathSuffix(cwd, peers) {
      const parts = cwd.split(/[\\/]+/).filter(Boolean);
      for (let n = 1; n <= parts.length; n++) {
        const tail = parts.slice(-n).join('/');
        if (!peers.some(other => other !== cwd && pathKey(other).split(/[\\/]+/).filter(Boolean).slice(-n)
          .join('/') === pathKey(cwd).split(/[\\/]+/).filter(Boolean).slice(-n).join('/'))) return tail;
      }
      return cwd;
    }
    const semanticKeys = ['embeddingMode', 'embeddingModelPath', 'embeddingDevice', 'embeddingTimeoutSeconds', 'embeddingMinScore', 'embeddingRelativeFloor'];
    const policyKeys = ['enabled', 'autoCandidates', 'injectContext', 'autoArchive', 'graphRecall', 'minScore', 'relativeFloor',
      'tokenBudget', 'maxRecall', 'residentBudget', 'contextMessages', 'workingHours', 'halfLifeDays', 'idleMinutes',
      'bufferHours', 'backupKeep', 'residentMode', 'autoConsolidate', 'dailyConsolidateAt', 'autoBackup'];
    const fold = (label, ...children) => h('details', { className: 'panel stack' }, h('summary', null, label), ...children);

    function SessionPicker({ label, choices, selected, onSelect, load, loading, error, ready, disabled, childrenAllowed }) {
      const [filter, setFilter] = React.useState('');
      const [children, setChildren] = React.useState(false);
      const [limit, setLimit] = React.useState(30);
      const details = React.useRef(null), search = React.useRef(null);
      const visible = choices.filter(item => !item.child || (childrenAllowed && children));
      const title = item => item.title || '名称暂不可用';
      const duplicates = new Map();
      for (const item of visible) duplicates.set(title(item), (duplicates.get(title(item)) || 0) + 1);
      const matches = visible.filter(item => title(item).toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
      const current = choices.find(item => item.id === selected);
      const close = () => { details.current.open = false; details.current.querySelector('summary').focus(); };
      const select = id => { onSelect(id); close(); };
      return h('details', { ref: details, onToggle: e => {
        if (e.currentTarget.open) { setFilter(''); setLimit(30); load(); search.current?.focus(); }
      }, onKeyDown: e => { if (e.key === 'Escape' && details.current.open) { e.preventDefault(); close(); } } },
      h('summary', { 'aria-label': `选择${label}` }, `${label}：${current ? title(current) : selected ? '已选择（名称暂不可用）' : '未选择'}`),
      h('div', { className: 'stack' },
        field(`搜索${label}`, filter, v => { setFilter(v); setLimit(30); }, 'search', { ref: search, disabled }),
        childrenAllowed && check('显示子会话', children, setChildren),
        loading && h('small', { role: 'status' }, '正在读取此工作区的会话…'),
        error && h('p', { role: 'alert' }, error),
        h('select', { size: Math.min(7, Math.max(2, matches.length + 1)), value: selected || '', 'aria-label': label,
          disabled: disabled || loading || Boolean(error), onChange: e => select(e.target.value) },
          h('option', { value: '' }, '不选择'),
          ...(selected && !matches.slice(0, limit).some(item => item.id === selected) ?
            [h('option', { key: selected, value: selected, hidden: true }, '已选择')] : []),
          ...matches.slice(0, limit).map(item => h('option', { key: item.id, value: item.id, title: title(item) },
            title(item) + (duplicates.get(title(item)) > 1 ? ` · ${item.createdAt ? new Date(item.createdAt).toLocaleDateString() + ' · ' : ''}${item.id.replace(/^session-/, '').slice(0, 8)}` : '') +
            (item.child ? ' · 子会话' : '')))),
        !loading && !error && ready && !matches.length && h('small', null, filter ? '没有匹配的会话名称。' : '没有符合此用途的会话。'),
        matches.length > limit && h('button', { type: 'button', onClick: () => setLimit(limit + 30) }, '显示更多匹配'),
        h('button', { type: 'button', disabled: disabled || loading, onClick: load }, '刷新会话列表')));
    }

    function WorkspacePanel({ row, binding, space, busy, change, oldSpaces, openOld }) {
      const [name, setName] = React.useState(null);
      const [old, setOld] = React.useState('');
      const act = (text, onClick, off = false) => h('button', { type: 'button', disabled: busy || off, onClick }, text);
      return h('section', { className: 'panel stack' }, h('h3', null, '当前工作区的记忆'),
        row ? h('div', { className: 'stack' }, h('strong', null, workspaceName(row) || row.cwd),
          h('p', { className: 'path' }, row.memoryDirectory),
          h('small', null, '这个目录包含本工作区的四层记忆、日记与索引。选择工作区不会授予会话权限。'),
          row.error && h('p', { role: 'alert' }, row.error.message),
          binding ? h('div', { className: 'stack' },
            h('div', { className: 'row' }, h('span', null, '记忆别名：' + (binding.displayName || '未设置')),
              act('编辑中文别名', () => setName(binding.displayName || ''))),
            name !== null && h('div', { className: 'row' }, field('记忆别名（仅设置页显示）', name, setName, 'text', { maxLength: 128 }),
              act('保存别名', async () => { if (await change(space, { action: 'rename', displayName: name })) setName(null); }), act('取消', () => setName(null))),
            act('解除工作区绑定', () => { if (window.confirm('停止此工作区的会话绑定和授权？本地记忆文件不会删除。'))
              void change(space, { action: 'unbind' }); })) :
            act('绑定此工作区', () => change(space, { action: 'bind', workspaceId: row.id, cwd: row.cwd }), Boolean(row.error))) :
          h('small', null, '正在查看未绑定的旧空间；它不是 DSH 工作区。'),
        oldSpaces.length > 0 && fold('高级：只查看未绑定的旧空间', h('label', null, '旧空间',
          h('select', { 'aria-label': '旧空间', value: old, onChange: e => setOld(e.target.value) }, h('option', { value: '' }, '选择旧空间'),
            ...oldSpaces.map(key => h('option', { key, value: key }, key)))), act('查看旧空间', () => openOld(old), !old)));
    }
    function GraphView({ space, busy, run, openEditor }) {
      const [layer, setLayer] = React.useState('L3');
      const [statusFilter, setStatusFilter] = React.useState('active');
      const [search, setSearch] = React.useState('');
      const [topic, setTopic] = React.useState('');
      const [relation, setRelation] = React.useState('all');
      const [cursor, setCursor] = React.useState('');
      const [history, setHistory] = React.useState([]);
      const [page, setPage] = React.useState({ items: [], nextCursor: null });
      const [index, setIndex] = React.useState({ state: 'unprepared' });
      const [selected, setSelected] = React.useState(null);
      const [neighbors, setNeighbors] = React.useState(null);
      const [suggestions, setSuggestions] = React.useState(null);
      const [evidence, setEvidence] = React.useState(null);
      const [target, setTarget] = React.useState('');
      const [error, setError] = React.useState(null);
      const [revision, setRevision] = React.useState(0);
      const [zoom, setZoom] = React.useState(1);
      const [pan, setPan] = React.useState({ x: 0, y: 0 });
      const drag = React.useRef(null);
      const selectedRequest = React.useRef(0);
      const previousIndexState = React.useRef(null);
      const mode = statusFilter === 'active' ? 'current' : 'history';
      const act = (label, action, style = '') =>
        h('button', { type: 'button', disabled: busy, className: style, onClick: action }, label);
      const reset = setter => value => {
        setter(value); setCursor(''); setHistory([]); setSelected(null); setNeighbors(null); setSuggestions(null); setEvidence(null);
      };
      React.useEffect(() => {
        let live = true;
        const update = value => {
          if (!live) return;
          setIndex(value);
          if (value.state === 'ready' && previousIndexState.current !== 'ready')
            setRevision(current => current + 1);
          previousIndexState.current = value.state;
        };
        request(space, '/graph/prepare', {}).then(update)
          .catch(reason => { if (live) setError(reason.message); });
        const timer = setInterval(() => request(space, '/graph/status').then(update)
          .catch(reason => { if (live) setError(reason.message); }), 2000);
        return () => { live = false; clearInterval(timer); selectedRequest.current++; };
      }, [space]);
      React.useEffect(() => {
        let live = true;
        const timer = setTimeout(() => {
          request(space, '/graph/list', { layer, status: statusFilter, query: search, topic, relation, cursor })
            .then(value => { if (live) { setPage(value); setIndex(value.index); setError(null); } })
            .catch(reason => { if (live) setError(reason.message); });
        }, 150);
        return () => { live = false; clearTimeout(timer); };
      }, [space, layer, statusFilter, search, topic, relation, cursor, revision]);
      async function select(item, nextCursor = '') {
        const requestId = ++selectedRequest.current;
        if (!nextCursor) { setSelected(item); setNeighbors(null); setSuggestions(null); setEvidence(null); }
        try {
          const value = await request(space, '/graph/neighbors', { id: item.id, mode, cursor: nextCursor });
          if (requestId === selectedRequest.current) { setNeighbors(value); setError(null); }
        } catch (reason) { if (requestId === selectedRequest.current) setError(reason.message); }
      }
      const revise = (otherId, decision, otherRevision) => run(async () => {
        await request(space, '/graph/decision', { id: selected.id, otherId, decision,
          revision: neighbors?.center?.revision ?? selected.revision, ...(otherRevision ? { otherRevision } : {}) });
        await select(selected);
        setRevision(current => current + 1);
        setTarget('');
      }, decision === 'reset' ? '已撤销图谱修正。' :
        decision === 'excluded' ? '已排除该关联，不再沿此关联扩散。' : '已确认关联；这不代表两条事实相同。');
      const findSuggestions = (nextCursor = '') => run(async () => {
        const requestId = ++selectedRequest.current;
        const value = await request(space, '/graph/suggestions', { id: selected.id, mode, cursor: nextCursor });
        if (requestId === selectedRequest.current) setSuggestions(value);
      });
      const groups = new Map();
      for (const item of page.items) {
        const group = item.topics[0] || item.tags.find(value => value.trim()) || '待归类';
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(item);
      }
      const shownNeighbors = (neighbors?.items ?? []).filter(item =>
        relation === 'all' || relation === item.relation.kind);
      const shownSuggestions = relation === 'all' ? suggestions?.items ?? [] : [];
      const points = selected && neighbors ? [
        { item: neighbors.center, x: 450, y: 350, center: true },
        ...[...shownNeighbors, ...shownSuggestions].map((item, index, all) => {
          const ring = Math.floor(index / 18), count = Math.min(18, all.length - ring * 18);
          const angle = 2 * Math.PI * (index % 18) / Math.max(1, count) - Math.PI / 2;
          const radius = 145 + ring * 90;
          return { item, x: 450 + Math.cos(angle) * radius, y: 350 + Math.sin(angle) * radius };
        }),
      ] : page.items.map((item, index) => ({
        item, x: 105 + (index % 5) * 172, y: 45 + Math.floor(index / 5) * 67,
      }));
      const stateText = {
        unprepared: '尚未建立', building: '正在分批建立', ready: '已就绪',
        partial: '已让出，空闲后可继续', error: '索引不可用',
      }[index.state] || index.state;
      return h('div', { className: 'stack' },
        h('div', { className: 'panel stack' },
          h('h3', null, '记忆图谱'),
          h('p', { className: 'muted' }, '以普通 L3 为中心，查看来源、主题和人工关联。连线只是导航依据，不表示事实相同或已核实；L0 与私人日记不进入图谱。'),
          h('div', { className: 'row' },
            h('span', { className: 'badge' }, `索引：${stateText} · ${index.indexed ?? 0} 条`),
            index.progress?.scanned ? h('small', null, `本轮检查 ${index.progress.scanned} 条`) : null,
            act('继续建立', () => run(async () => {
              const value = await request(space, '/graph/prepare', {}); setIndex(value);
            }, '图谱索引已开始或已就绪。')),
            act('重建图谱索引', () => {
              if (window.confirm('只重建派生索引，不删除记忆或人工修正。继续吗？'))
                run(async () => { const value = await request(space, '/graph/rebuild', {}); setIndex(value); },
                  '派生图谱已重新建立任务。');
            })),
          index.error ? h('p', { className: 'message error', role: 'alert' }, `${index.error.code} · ${index.error.message}`) : null,
          error ? h('p', { className: 'message error', role: 'alert' }, error) : null,
          index.state !== 'ready' ? h('small', null, '索引未完成时关联可能不完整；普通记忆与原有召回仍可使用。') : null,
          h('div', { className: 'fields' },
            field('搜索图谱记忆', search, reset(setSearch)),
            field('筛选主题或标签（精确名称）', topic, reset(setTopic)),
            h('label', null, h('span', null, '图谱层级'),
              h('select', { 'aria-label': '图谱层级', value: layer, onChange: event => reset(setLayer)(event.target.value) },
                ...[['L3', 'L3 长期知识（默认）'], ['L2', 'L2 情景记忆'], ['L1', 'L1 工作记忆']]
                  .map(([value, label]) => h('option', { key: value, value }, label)))),
            h('label', null, h('span', null, '图谱状态'),
              h('select', { 'aria-label': '图谱状态', value: statusFilter, onChange: event => reset(setStatusFilter)(event.target.value) },
                ...[['active', '当前有效'], ['archived', '已归档'], ['superseded', '已替代'],
                  ['completed', '已完成'], ['cancelled', '已取消']]
                  .map(([value, label]) => h('option', { key: value, value }, label)))),
            h('label', null, h('span', null, '图谱关系'),
              h('select', { 'aria-label': '图谱关系', value: relation, onChange: event => reset(setRelation)(event.target.value) },
                ...[['all', '全部'], ['isolated', '仅孤立项'], ['source', '来源关联'], ['topic', '同一主题'],
                  ['tag', '同一标签'], ['fact', '同一事实键'], ['task', '同一任务键'], ['alias', '同一别名'],
                  ['scene', '同一情景'], ['confirmed', '人工确认'], ['excluded', '人工排除'], ['stale', '确认已过期']]
                  .map(([value, label]) => h('option', { key: value, value }, label))))),
          page.incomplete ? h('p', { className: 'message' }, '部分密集关系超过本页检查上限，筛选结果可能不完整；请打开节点分页查看。') : null),
        h('div', { className: 'split' },
          h('div', { className: 'panel stack' },
            h('div', { className: 'row' }, h('h3', null, '关系图'),
              act('放大图谱', () => setZoom(value => Math.min(2.5, value * 1.2))),
              act('缩小图谱', () => setZoom(value => Math.max(0.5, value / 1.2))),
              act('重置图谱视图', () => { setZoom(1); setPan({ x: 0, y: 0 }); })),
            h('small', null, '拖动画布、缩放并点击节点展开；虚线表示共享线索，红色虚线表示已排除或需重新确认。'),
            h('svg', { className: 'graph-canvas', viewBox: '0 0 900 700', role: 'group', 'aria-label': '普通记忆关系图',
              onPointerDown: event => {
                if (event.target.closest?.('[data-graph-node]')) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = { x: event.clientX, y: event.clientY, pan };
              },
              onPointerMove: event => {
                if (!drag.current) return;
                const bounds = event.currentTarget.getBoundingClientRect();
                setPan({ x: drag.current.pan.x + (event.clientX - drag.current.x) * 900 / bounds.width,
                  y: drag.current.pan.y + (event.clientY - drag.current.y) * 700 / bounds.height });
              },
              onPointerUp: () => { drag.current = null; },
              onPointerCancel: () => { drag.current = null; } },
            h('g', { transform: `translate(${pan.x} ${pan.y}) translate(450 350) scale(${zoom}) translate(-450 -350)` },
              ...(selected && neighbors ? points.slice(1).map(point => h('line', { key: `edge-${point.item.id}`,
                className: `graph-edge ${['excluded', 'stale'].includes(point.item.relation.kind) ? 'excluded' :
                  ['source', 'confirmed'].includes(point.item.relation.kind) ? '' : 'suggested'}`,
                x1: 450, y1: 350, x2: point.x, y2: point.y })) : []),
              ...points.map(point => h('g', { key: point.item.id, 'data-graph-node': '1',
                className: `graph-node ${point.center ? 'selected' : ''}`,
                role: 'button', tabIndex: 0, 'aria-label': `图谱节点 ${point.item.layer} ${point.item.text}`,
                transform: `translate(${point.x} ${point.y})`,
                onClick: () => select(point.item),
                onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(point.item); } } },
              h('rect', { x: -72, y: -18, width: 144, height: 36, rx: 9 }),
              h('text', { x: 0, y: 5, textAnchor: 'middle' },
                `${point.item.layer} · ${[...point.item.text].slice(0, 10).join('')}`))))),
            !points.length ? h('div', { className: 'empty' }, '没有符合条件的普通记忆。') : null),
          h('div', { className: 'panel stack' },
            h('h3', null, '分类列表'),
            h('small', null, '按首个主题或标签分组；可用键盘选择。未填写主题或标签的条目列在待归类；孤立项按明确和人工关联判断。'),
            h('div', { className: 'graph-list' },
              ...[...groups.entries()].map(([group, entries]) => h('section', { key: group },
                h('h4', null, group),
                ...entries.map(item => h('button', { key: item.id, type: 'button', className: 'item',
                  'aria-selected': selected?.id === item.id, onClick: () => select(item) },
                h('small', null, `${item.layer} · ${statuses[item.status] || item.status}`),
                h('p', null, `${item.text}${item.truncated ? '…' : ''}`),
                h('small', null, [...item.topics, ...item.tags].join(' · ') || '待归类')))))),
            !page.items.length ? h('div', { className: 'empty' }, '此页没有符合条件的条目。') : null,
            h('div', { className: 'row' },
              history.length ? act('上一页', () => { setCursor(history.at(-1)); setHistory(history.slice(0, -1)); }) : null,
              page.nextCursor ? act('下一页', () => { setHistory([...history, cursor]); setCursor(page.nextCursor); }) : null))),
        selected ? h('div', { className: 'panel stack' },
          h('h3', null, '节点与关联依据'),
          h('p', null, `${selected.layer} · ${statuses[selected.status] || selected.status} · ${selected.text}${selected.truncated ? '…' : ''}`),
          h('small', null, `ID ${selected.id} · ${kinds[selected.kind] || selected.kind} · ${selected.occurredAt || '事件时间未知'}`),
          h('div', { className: 'row' },
            act('查看正文和出处', () => run(async () => {
              setEvidence(await request(space, '/topics/read', { id: selected.id, mode }));
            })),
            act('编辑这条记忆', () => run(async () => {
              const record = await request(space, `/graph/record?id=${encodeURIComponent(selected.id)}`);
              openEditor(record);
            }))),
          evidence ? h('details', { open: true }, h('summary', null, '正文与出处'),
            h('pre', null, JSON.stringify(evidence, null, 2))) : null,
          field('手动关联的另一条记忆 ID', target, setTarget),
          h('div', { className: 'row' },
            act('确认手动关联', () => revise(target, 'confirmed'), 'primary'),
            act('排除手动关联', () => revise(target, 'excluded'))),
          !neighbors ? h('p', { className: 'muted' }, '正在读取关联…') :
            h('div', { className: 'stack' },
              ...shownNeighbors.map(item => h('div', { className: 'panel', key: item.id },
                h('p', null, `${item.layer} · ${item.text}${item.truncated ? '…' : ''}`),
                h('small', null, `${item.relation.label}${item.relation.evidence ? `：${item.relation.evidence}` : ''}`),
                h('div', { className: 'row' },
                  act('打开关联节点', () => select(item)),
                  act('确认关联', () => revise(item.id, 'confirmed', item.revision)),
                  act('排除关联', () => revise(item.id, 'excluded', item.revision)),
                  item.relation.decision ? act('撤销修正', () => revise(item.id, 'reset', item.revision)) : null))),
              !shownNeighbors.length ? h('p', { className: 'muted' }, '没有符合筛选条件的关联；孤立节点不会被强行连线。') : null,
              neighbors.nextCursor ? act('展开下一页关联', () => select(selected, neighbors.nextCursor)) : null),
          h('div', { className: 'panel stack' },
            h('h3', null, '本地语义候选'),
            h('small', null, '按节点查询已准备的本地向量，仅供导航，不自动参与召回，也不表示事实相同；标准组合无需模型，可直接使用明确关联。'),
            act('查找可能相关', () => findSuggestions()),
            suggestions ? h('div', { className: 'stack' },
              h('small', null, `${suggestions.model} · 本批检查 ${suggestions.scanned} 条 · ${suggestions.note}`),
              ...suggestions.items.map(item => h('div', { className: 'panel', key: item.id },
                h('p', null, `${item.layer} · ${item.text}${item.truncated ? '…' : ''}`),
                h('small', null, `${item.relation.label} · 相似度 ${item.relation.score}`),
                h('div', { className: 'row' },
                  act('打开语义节点', () => select(item)),
                  act('确认语义关联', () => revise(item.id, 'confirmed', item.revision)),
                  act('排除语义关联', () => revise(item.id, 'excluded', item.revision))))),
              !suggestions.items.length ? h('p', { className: 'muted' }, '本批没有达到门槛的语义候选。') : null,
              suggestions.nextCursor ? act('检查下一批语义候选', () => findSuggestions(suggestions.nextCursor)) : null) : null)) : null);
    }
    function Page({ sessionList }) {
      const [space, setSpace] = React.useState('');
      const oldView = React.useRef(false);
      const [tab, setTab] = React.useState('overview');
      const [status, setStatus] = React.useState(null);
      const [edits, setEdits] = React.useState({});
      const config = status?.space === space ? { ...status.config,
        ...Object.fromEntries(Object.entries(edits).map(([key, edit]) => [key, edit.value])) } : null;
      const [layer, setLayer] = React.useState('L3');
      const [items, setItems] = React.useState({ total: 0, items: [] });
      const [query, setQuery] = React.useState('');
      const [offset, setOffset] = React.useState(0);
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const [extra, setExtra] = React.useState(null);
      const [lifecycle, setLifecycle] = React.useState(null);
      const [recall, setRecall] = React.useState(null);
      const [topicDetail, setTopicDetail] = React.useState(null);
      const [asOf, setAsOf] = React.useState('');
      const [traces, setTraces] = React.useState([]);
      const [password, setPassword] = React.useState('');
      const [automaticPassword, setAutomaticPassword] = React.useState('');
      const [privateWritersInput, setPrivateWritersInput] = React.useState('');
      const [modelApiKeyInput, setModelApiKeyInput] = React.useState('');
      const [privateSummaryDay, setPrivateSummaryDay] = React.useState('');
      const [restoreName, setRestoreName] = React.useState('');
      const [restoreText, setRestoreText] = React.useState('');
      const [privateImport, setPrivateImport] = React.useState(false);
      const [plan, setPlan] = React.useState(null);
      const [selected, setSelected] = React.useState([]);
      const [historyImportPlan, setHistoryImportPlan] = React.useState(null);
      const [historyImportSelected, setHistoryImportSelected] = React.useState([]);
      const [historyImportSession, setHistoryImportSession] = React.useState('');
      const [historyImportQuery, setHistoryImportQuery] = React.useState('');
      const [historyImportDate, setHistoryImportDate] = React.useState('');
      const [directory, setDirectory] = React.useState({ items: [], error: '' });
      const directoryRequest = React.useRef(0);
      const [sessionCatalog, setSessionCatalog] = React.useState(null);
      const [sessionsLoading, setSessionsLoading] = React.useState(false);
      const [catalogError, setCatalogError] = React.useState('');
      const sidebar = React.useSyncExternalStore(
        React.useCallback(listener => sessionList?.subscribe(listener) ?? (() => {}), [sessionList]),
        React.useCallback(() => sessionList?.getSnapshot() ?? null, [sessionList]));
      const sessionRequest = React.useRef(0);
      const generation = React.useRef(0);


      async function refresh() {
        if (!space) return;
        const version = ++generation.current;
        const data = await request(space, '/status');
        if (version !== generation.current) return;
        setStatus(data);
      }
      async function readDirectory() {
        const ticket = ++directoryRequest.current;
        try {
          const data = await request(space, '/workspaces');
          if (ticket === directoryRequest.current) {
            setDirectory({ items: data.items, error: '' });
            setSpace(current => current && (oldView.current || data.items.some(row => row.space === current)) ? current :
              data.items.find(row => row.bound)?.space || data.items[0]?.space || '');
          }
        } catch (error) {
          if (ticket === directoryRequest.current) setDirectory({ items: [], error: error.message });
        }
      }
      React.useEffect(() => { readDirectory(); return () => { directoryRequest.current++; }; }, [space]);
      React.useEffect(() => {
        if (status?.space === space && !edits.privateWriters) setPrivateWritersInput(status.config.privateWriters.join(','));
      }, [status, space, edits.privateWriters]);
      React.useEffect(() => {
        setDraft(null); setPlan(null); setHistoryImportPlan(null); setHistoryImportSelected([]);
        setHistoryImportSession(''); setHistoryImportQuery(''); setHistoryImportDate('');
        setExtra(null); setLifecycle(null); setRecall(null); setTopicDetail(null);
        setSessionCatalog(null); setSessionsLoading(false); setCatalogError(''); setPrivateSummaryDay('');
        refresh().catch(error => setNotice({ error: true, text: error.message }));
        return () => { generation.current++; sessionRequest.current++; };
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
      const patchConfig = (key, value) => setEdits(current => {
        const next = { ...current };
        if (sameValue(value, status.config[key])) delete next[key];
        else next[key] = { base: current[key]?.base ?? status.config[key], value };
        return next;
      });
      const switchSpace = (next, archived = false) => {
        if (next === space || (Object.keys(edits).length && !window.confirm('放弃未保存的设置并切换空间？取消可留在此处保存。'))) return;
        oldView.current = archived;
        sessionRequest.current++; generation.current++;
        setEdits({}); setNotice(null); setSpace(next);
      };
      const patchDraft = (key, value) => setDraft(current => ({ ...current, [key]: value }));
      const promotionText = () => draft.layer === 'L0'
        ? draft.text.replace(/^\s*(?:请)?(?:记住|记一下|remember)\s*[:：,，]\s*/i, '').trim()
        : draft.text;
      const saveSection = (keys, selectionKey) => run(async () => {
        const changed = keys.filter(key => edits[key]);
        for (const key of changed) if (!sameValue(status.config[key], edits[key].base))
          throw new Error('此区块已在别处修改。请放弃草稿，核对最新设置后再编辑。');
        if (selectionKey) {
          const selection = config[selectionKey].find(item => item.space === space) ?? null;
          await request(space, '/workspace-selection', { setting: selectionKey, selection, revision: status.settingsRevision });
        } else {
          await request(space, '/config', { revision: status.settingsRevision, patch: Object.fromEntries(changed.map(key => [key, config[key]])) });
        }
        setEdits(current => Object.fromEntries(Object.entries(current).filter(([key]) => !changed.includes(key))));
      }, '设置已保存。');
      const changeBinding = async (target, action) => {
        const result = await run(async () => {
          const saved = await request(target, '/workspace-binding', { ...action, revision: status.settingsRevision });
          if (action.action === 'unbind' && target === space)
            setEdits(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.endsWith('Sessions'))));
          return saved;
        }, saved => saved.alreadyBound ? '该工作区已经绑定，未创建新空间。' : '工作区设置已保存。');
        if (result && ['bind', 'manual'].includes(action.action) && !Object.keys(edits).length) {
          setSpace(result.space); setTab('settings');
        }
        return result;
      };
      const sessionChoices = (sessionCatalog?.space === space ? sessionCatalog.items : []).map(item => {
        const summary = sidebar?.byId?.[item.id];
        const title = summary?.blank ? '新会话' : summary?.displayTitle;
        return { ...item, title: title && title !== item.id ? title : item.title };
      }).sort((a, b) =>
        a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id));
      const currentWorkspace = directory.items.find(row => row.space === space);
      const binding = status?.config.bindings.find(item => item.space === space);
      const boundWorkspace = status?.space === space && binding && (!binding.workspaceId || hostRow(binding, directory.items));
      async function readWorkspaceSessions() {
        if (!boundWorkspace) return;
        const ticket = ++sessionRequest.current;
        setSessionsLoading(true); setCatalogError('');
        try {
          const data = await request(space, '/workspace-sessions?view=picker');
          if (ticket !== sessionRequest.current || data.space !== space) return;
          setSessionCatalog(data);
        } catch (error) {
          if (ticket === sessionRequest.current) { setSessionCatalog(null); setCatalogError(error.message); }
        } finally {
          if (ticket === sessionRequest.current) setSessionsLoading(false);
        }
      }
      const savedRoute = ['privateMainSessions', 'historyMainSessions', 'deepOrganizationSessions'].some(key =>
        status?.config[key]?.some(item => item.space === space));
      React.useEffect(() => {
        if (tab === 'settings' && boundWorkspace && savedRoute) readWorkspaceSessions();
      }, [tab, space, Boolean(boundWorkspace), savedRoute]);
      const picker = (label, selected, onSelect, childrenAllowed = false) => h(SessionPicker, {
        key: `${space}:${label}`, label, selected, onSelect, childrenAllowed, choices: sessionChoices, load: readWorkspaceSessions,
        loading: sessionsLoading, error: catalogError, ready: sessionCatalog?.space === space, disabled: busy || !boundWorkspace,
      });
      const routeCard = (label, setting) => {
        const selected = config[setting].find(item => item.space === space);
        const found = sessionChoices.find(item => item.id === selected?.sessionId);
        const choose = id => {
          const items = config[setting].filter(item => item.space !== space);
          const session = sessionChoices.find(item => item.id === id);
          if (session) items.push({ space, sessionId: id, provider: session.provider, model: session.model });
          patchConfig(setting, items);
        };
        const verified = found?.provider && found.model && found.provider === selected?.provider && found.model === selected.model;
        return h('section', { className: 'panel stack', 'aria-label': label },
          picker(label, selected?.sessionId, choose, setting === 'deepOrganizationSessions'),
          selected && h('small', null, `模型：${selected.provider && selected.model ? `${selected.provider} / ${selected.model}` : '请先在 DSH 中为会话选择模型'}`),
          selected && sessionCatalog && !verified && h('p', { role: 'alert' },
            found?.provider && found.model ? `路由已变化：${found.provider} / ${found.model}，不会自动切换。` : '当前无法核实会话或模型；请在 DSH 中选择模型后刷新。'),
          selected && found?.provider && found.model && !verified && button('使用当前模型路由', () => choose(found.id)),
          h('button', { type: 'button', disabled: busy || !edits[setting] || Boolean(selected && !verified),
            onClick: () => saveSection([setting], setting) }, `保存${label}`));
      };
      const previewSelectedHistory = () => run(async () => {
        const result = await request(space, '/history/import-preview', {
          sessionIds: [historyImportSession], query: historyImportQuery, date: historyImportDate,
        });
        setHistoryImportPlan(result);
        setHistoryImportSelected([]);
        return { candidates: result.candidateCount, skipped: result.skippedUnclassified + result.skippedTooLong,
          truncated: result.truncated };
      }, value => `历史预览完成：${value.candidates} 条待选候选；未分类或过长跳过 ${value.skipped} 条${value.truncated ? '；超过本批 200 条上限，请缩小范围' : ''}。尚未写入记忆。`);
      const applySelectedHistory = () => run(async () => {
        const result = await request(space, '/history/import-apply', {
          id: historyImportPlan.id, selected: historyImportSelected,
        });
        setHistoryImportPlan(null);
        setHistoryImportSelected([]);
        return result;
      }, value => value.status);
      const saveDraft = () => run(async () => {
        const patch = {
          text: draft.text, category: draft.category, status: draft.status, kind: draft.kind,
          aliases: (draft.aliasesInput ?? (draft.aliases || []).join(',')).split(',').map(value => value.trim()).filter(Boolean),
          topics: (draft.topicsInput ?? (draft.topics || []).join(',')).split(',').map(value => value.trim()).filter(Boolean),
          factKey: draft.factKey || '', pinned: Boolean(draft.pinned),
          importance: Number(draft.importance ?? 0.5),
          tags: (draft.tagsInput ?? (draft.tags || []).join(',')).split(',').map(value => value.trim()).filter(Boolean),
          occurredAt: draft.occurredAt || null, validUntil: draft.validUntil || null,
          horizon: draft.horizon || 'unspecified', taskKey: draft.taskKey || '',
        };
        const saved = draft.id ? await request(space, '/update', { id: draft.id, revision: draft.revision, patch }) :
          await request(space, '/memories', { ...patch, layer, scope: 'space', sessionId: '', source: { kind: 'manual' } });
        setDraft(saved); setLifecycle(null);
        return saved;
      }, value => `已保存 · ${statuses[value.status]}`);
      const choose = (label, key, values, labels = {}) => h('label', null, h('span', null, label),
        h('select', { 'aria-label': label, value: draft[key], onChange: e => patchDraft(key, e.target.value) },
          values.map(value => h('option', { key: value, value }, labels[value] || value))));

      let content;
      if (!space) content = h('div', { className: 'empty' }, '请先在 DSH 中添加工作区，然后刷新此页。');
      else if (!status || !config) content = h('div', { className: 'empty' }, '正在读取记忆系统…');
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
          h('p', { className: 'path muted' }, info.file ?? info.directory)))),
        h('div', { className: 'panel stack' },
          h('h3', null, '同工作区共享，不按会话分库'),
          h('p', { className: 'muted' }, '四层分别落盘。新记忆自动保存并参与召回，无需逐条审核；可召回不等于已核实。人工确认和纠错是可选操作，冲突不会自动覆盖。'),
          h('p', null, `普通记忆默认本地整理；已显式配置模型时，深度整理按工作区设置发送普通 L1/L2 · 每轮注入预算 ${config.tokenBudget}（UTF-8 字节保守估算）`),
          h('p', { className: 'muted' }, config.injectContext
            ? '已开启普通记忆上下文：选中的记忆会随当前聊天请求发送给你配置的模型。'
            : '自动记忆上下文已关闭；聊天模型主动调用记忆工具时，工具结果仍会进入聊天请求。'),
          status.legacyModelExtractionIgnored ? h('div', { className: 'message' },
            '已忽略旧版后台模型提炼配置；只有显式选择工作区模型或 API 并保存后才会发送整理材料。') : null,
          config.bindings.length === 0 ? h('div', { className: 'message' }, '尚未绑定工作区。请在“设置与迁移”中绑定；未绑定前不会读取或捕获聊天。') : null,
          h('div', { className: 'row' }, button('立即整理', () => run(() => request(space, '/maintenance', {}), value =>
            value.waitingForConversation ? '对话正在运行，整理已等待。' : JSON.stringify(value)), 'primary'),
          button('管理工作区绑定', () => setTab('settings'))),
          h('small', null, '当前没有人格配置。本插件不会建立身份、情绪或主动聊天。')),
        status.encoding ? h('div', { className: 'panel' }, h('h3', null, '本地编码诊断'),
          h('p', null, `规则 ${status.encoding.version} · 已检查 ${status.encoding.inspected} 条缓冲 · 保存 ${status.encoding.saved} 项`),
          h('p', { className: 'muted' }, status.encoding.sleep ?
            `二次编码 ${status.encoding.sleep.from} 至 ${status.encoding.sleep.until} · 检查 ${status.encoding.sleep.inspected} 条 · 新增 ${status.encoding.sleep.candidates} 条待确认候选 · 到期前未二次检查 ${status.encoding.expiredBeforeSleep ?? 0} 条` :
            `尚未进行二次编码 · 到期前未二次检查 ${status.encoding.expiredBeforeSleep ?? 0} 条`),
          h('pre', null, JSON.stringify(status.encoding.reasons, null, 2))) : null,
        status.capture ? h('div', { className: 'panel stack' }, h('h3', null, '事件捕获诊断'),
          h('p', null, `有结果 ${status.capture.counts.saved} · 无产出 ${status.capture.counts.empty} · 待核 ${status.capture.counts.review} · 等待配对 ${status.capture.counts.waiting} · 失败 ${status.capture.counts.failed} · 处理中 ${status.capture.counts.pending}`),
          h('p', { className: 'muted' }, `${status.capture.coverage} 有缺口的会话 ${status.capture.sessionsWithGaps} 个。`),
          h('small', null, '只重试已登记且当前仍可访问的干净会话；无法访问的事件不会自动读取旧历史。'),
          button('重试已登记事件', () => run(() => request(space, '/capture/retry', {}), value =>
            `已重试 ${value.retried} 项；当前不可访问 ${value.unavailable} 项；失败 ${value.failed} 项。`)),
          h('details', null, h('summary', null, '查看脱敏原因'), h('pre', null, JSON.stringify(status.capture.reasons, null, 2)))) : null,
        h('div', { className: 'panel' }, h('h3', null, '本地语义联想'),
          h('p', null, status.semantic?.mode === 'off' ? '标准组合：词面、别名、时间及来源关系检索，不加载 embedding。' :
            `${status.semantic?.ready ? '模型已加载' : '模型未就绪'} · ${status.semantic?.model ?? '等待首次准备'} · 索引 ${status.semantic?.index?.indexed ?? 0} / ${status.semantic?.index?.total ?? '?'} 条`),
          h('p', { className: 'muted' }, '四层和工作区边界保持不变。向量只联想候选，不替代来源、不判断真伪，也不读取私人日记。'),
          status.semantic?.error ? h('p', { role: 'alert' }, `${status.semantic.error.code} · ${status.semantic.error.message}`) : null,
          button('选择语义组合', () => setTab('settings'))),
        status.maintenance ? h('div', { className: 'panel' }, h('h3', null, '最近维护'), h('pre', null, JSON.stringify(status.maintenance, null, 2))) : null);
      else if (tab === 'graph') content = h(GraphView, { key: space, space, busy, run,
        openEditor: record => { setLayer(record.layer); setOffset(0); setDraft(record); setTab('memories'); } });
      else if (tab === 'memories') content = h('div', { className: 'stack' },
        h('div', { className: 'row' },
          ...Object.keys(labels).map(id => button(`${id} ${labels[id]}`, () => { setLayer(id); setOffset(0); setDraft(null); setLifecycle(null); }, layer === id ? 'primary' : '')),
          button('新建', () => { setLifecycle(null); setDraft({ text: '', layer, category: layer === 'L1' ? 'task' : 'event',
            status: layer === 'L0' ? 'pending' : 'active', kind: 'user_statement', horizon: horizonsByLayer[layer],
            taskKey: '', pinned: false, importance: 0.5 }); })),
        field('搜索当前层', query, value => { setQuery(value); setOffset(0); }),
        h('div', { className: 'split' },
          h('div', { className: 'panel list' },
            h('small', null, `共 ${items.total} 条 · 工作区所有会话共享`),
            ...items.items.map(item => h('button', { className: 'item', key: item.id, 'aria-selected': draft?.id === item.id,
              onClick: () => { setDraft(item); setExtra(null); setLifecycle(null); } },
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
            field('实体别名（逗号分隔，仅当前工作区）', draft.aliasesInput ?? (draft.aliases || []).join(','),
              v => patchDraft('aliasesInput', v)),
            field('主题（逗号分隔，用于关联和检索，不改变层级）', draft.topicsInput ?? (draft.topics || []).join(','),
              v => patchDraft('topicsInput', v)),
            field('标签（逗号分隔）', draft.tagsInput ?? (draft.tags || []).join(','),
              v => patchDraft('tagsInput', v)),
            field('事件时间（ISO，未知留空）', draft.occurredAt || '', v => patchDraft('occurredAt', v)),
            field('失效时间（ISO，可选）', draft.validUntil || '', v => patchDraft('validUntil', v)),
            check('保护：不自动淡忘，不代表永远正确', draft.pinned, v => patchDraft('pinned', v)),
            h('div', { className: 'row' }, button('保存', saveDraft, 'primary'),
              draft.id ? button('来源与版本', () => run(async () => {
                const history = await request(space, `/history?id=${draft.id}`);
                setExtra({ sources: draft.sources || [draft.source], history }); return history;
              })) : null,
              draft.id ? button('激活与生命周期', () => run(async () => {
                const value = await request(space, `/lifecycle?id=${draft.id}`);
                setLifecycle(value); return value;
              })) : null,
              draft.id ? button('人工确认 / 强化（可选）', () => run(async () => {
                const saved = await request(space, '/confirm', { id: draft.id }); setDraft(saved); setLifecycle(null); return saved;
              }, '已记录一次人工确认；实际召回的轻量强化另行计数，不冒充人工确认。')) : null),
            draft.id ? h('div', { className: 'row' },
              draft.status === 'archived' ? button('撤销归档', () => run(async () => {
                const saved = await request(space, '/update', { id: draft.id, revision: draft.revision,
                  patch: { status: 'active' } });
                setDraft(saved); setLifecycle(null); return saved;
              }, '已撤销归档并保留原有效期；若已到期，请按需修改失效时间。')) : null,
              ...['L1', 'L2', 'L3'].filter(id => id !== draft.layer).map(id => button(`归类到 ${id}`, () => run(() =>
                request(space, '/promote', { id: draft.id, target: { layer: id, text: promotionText(),
                  status: 'active', horizon: draft.horizon, taskKey: draft.taskKey || '' } }),
              '已创建或合并目标候选，原记忆保留。'))),
              button('删除', () => {
                if (window.prompt('永久遗忘此记忆及派生记录。同数据根的同谱系恢复将遵守标记；旧离线备份不会被改写。输入 DELETE 确认：') === 'DELETE')
                  run(async () => { const value = await request(space, '/forget', { id: draft.id, confirmation: 'DELETE' }); setDraft(null); return value; }, value => value.notice);
              }, 'danger')) : null,
            lifecycle && lifecycle.id === draft.id ? h('div', { className: 'panel stack' },
              h('strong', null, '激活与生命周期（已保存状态）'),
              h('p', null, lifecycle.statusMessage),
              lifecycle.archiveReason ? h('p', null, `归档原因：${archiveReasons[lifecycle.archiveReason]}${lifecycle.archivedAt ? ` · ${lifecycle.archivedAt}` : ''}`) : null,
              h('p', null, `衰减系数 ${lifecycle.activation.freshness.toFixed(3)} · 依据${activationAnchors[lifecycle.activation.anchorKind]} ${lifecycle.activation.anchor} · 距今 ${lifecycle.activation.ageDays.toFixed(1)} 天`),
              h('small', null, lifecycle.activation.pinned || draft.layer === 'L3'
                ? '已保护或属于 L3，当前排序不因时间衰减。'
                : `有效半衰期 ${lifecycle.activation.effectiveHalfLifeDays.toFixed(1)} 天；召回 ${lifecycle.activation.recallCount} 次。`),
              h('p', { className: 'muted' }, lifecycle.activation.confidence),
              h('p', null, `巩固：${lifecycle.consolidation.message}`),
              h('p', null, lifecycle.archive.expiryDue ? '有效期已结束，下次维护会归档；人工保护不延长有效期。' :
                `低使用自动归档${lifecycle.archive.autoArchiveEnabled ? '已开启' : '已关闭'}；${lifecycle.archive.inactivityEligible ? '已满足条件。' : lifecycle.archive.reasons.join(' ')}`)) : null,
            extra ? h('details', { open: true }, h('summary', null, '来源 / 历史版本'), h('pre', null, JSON.stringify(extra, null, 2))) : null
          ) : h('div', { className: 'panel empty' }, '选择一条记忆，查看出处或进行修订。')));
      else if (tab === 'recall') content = h('div', { className: 'stack' },
        h('div', { className: 'panel stack' }, h('h3', null, '试着回忆'),
          field('检索内容', query, setQuery),
          field('历史有效时间（ISO，按时点查询时填写）', asOf, setAsOf),
          h('div', { className: 'row' },
            button('普通召回', () => run(async () => { setTopicDetail(null); setRecall(await request(space, '/recall', { query })); }), 'primary'),
            button('包含归档', () => run(async () => { setTopicDetail(null); setRecall(await request(space, '/recall', { query, includeArchived: true })); })),
            button('历史版本', () => run(async () => { setTopicDetail(null); setRecall(await request(space, '/recall', { query, mode: 'history' })); })),
            button('按时点查询', () => run(async () => { setTopicDetail(null); setRecall(await request(space, '/recall', { query, mode: 'as-of', asOf })); })),
            button('已存情景时间线', () => run(async () => { setTopicDetail(null); setRecall(await request(space, '/timeline', { query })); }))),
          recall?.topicCards?.length ? h('div', { className: 'stack' },
            h('h3', null, '按需查看关联主题'),
            h('small', null, '主题、事实键、任务键、别名和同一情景只是入口，不合并事实；详情再次检查当前空间和时间。'),
            h('div', { className: 'row' }, ...recall.topicCards.map(card => h('span', { key: card.id }, button(
              `${card.label} · ${card.count} 条`, () => run(async () => {
                const page = await request(space, '/topics/read', { topic: card.id, mode: recall.mode,
                  asOf: recall.asOf, includeArchived: recall.includeArchived });
                setTopicDetail({ ...page, label: card.label });
              }))))),
            topicDetail ? h('div', { className: 'panel' }, h('strong', null, `${topicDetail.label} · ${topicDetail.total} 条`),
              ...topicDetail.items.map(item => h('div', { key: item.id },
                h('p', null, `${item.layer} · ${statuses[item.status]} · ${item.text}`),
                h('small', null, `ID ${item.id} · ${item.sourcesTotal ?? item.sources.length} 个出处${
                  item.sourcesComplete === false ? '（本页仅显示数量）' : ''}`),
                item.sourcesComplete === false ? button('读取完整出处', () => run(async () => {
                  const full = await request(space, '/topics/read', { id: item.id, mode: recall.mode,
                    asOf: recall.asOf, includeArchived: recall.includeArchived });
                  setTopicDetail(current => current?.topic === topicDetail.topic ? { ...current,
                    items: current.items.map(value => value.id === item.id
                      ? { ...value, sources: full.sources, sourcesComplete: true } : value) } : current);
                })) : h('details', null, h('summary', null, '查看出处'),
                  h('pre', null, JSON.stringify(item.sources, null, 2))))),
              topicDetail.nextCursor ? button('读取下一页', () => run(async () => {
                const page = await request(space, '/topics/read', { topic: topicDetail.topic,
                  cursor: topicDetail.nextCursor, mode: recall.mode, asOf: recall.asOf,
                  includeArchived: recall.includeArchived });
                setTopicDetail({ ...page, label: topicDetail.label });
              })) : null) : null) : null,
          recall?.topicStatus?.state === 'unavailable' ? h('p', { className: 'message error' }, recall.topicStatus.message) : null,
          recall ? h('pre', null, JSON.stringify(recall, null, 2)) : null),
        h('div', { className: 'panel' }, h('h3', null, '最近召回记录'),
          h('small', null, '只记录普通记忆的选择原因和预算，不包含私人日记或查询正文。'),
          ...traces.map((trace, i) => {
            const reasons = new Set((trace.excluded ?? []).map(item => item.reason));
            const semantic = trace.semanticStatus;
            const matches = (trace.picked ?? []).filter(item => item.matched);
            const supporting = (trace.picked ?? []).filter(item => !item.matched);
            const explanation = matches.length ? `查询匹配 ${matches.length} 条，最高分 ${trace.bestScore ?? '未知'}。` :
              supporting.length ? `没有查询匹配；仍附带 ${supporting.length} 条常驻背景或来源关联记忆。` :
              semantic?.mode !== 'off' && semantic?.state !== 'ready' ?
                `本轮未选记忆；语义状态为 ${semantic?.state ?? '未知'}${semantic?.code ? `（${semantic.code}）` : ''}，可先检查本地模型与索引。` :
                reasons.has('预算或条数上限') || reasons.has('相关记忆条数上限') ?
                  '已找到候选，但受上下文预算或条数上限限制。' :
                  reasons.has('低于相关性门槛') ?
                    `有候选低于相关性门槛（${trace.threshold ?? '未知'}）；可检查查询表述及记录别名。` :
                    '没有形成可评分的词面候选；检查是否保存了对应记忆，或为同义名称补充工作区别名。';
            return h('details', { key: trace.requestId || i }, h('summary', null, `${trace.at} · ${trace.picked.length} 条`),
              h('p', { className: 'muted' }, explanation),
              trace.diagnostics ? h('small', null, `请求 ${trace.requestId} · 当前词面 ${trace.diagnostics.lexicalQueryCandidates} · 情境词面 ${trace.diagnostics.lexicalContextCandidates} · 语义 ${trace.diagnostics.semanticCandidates} · 范围/时间过滤 ${trace.diagnostics.scopeOrTimeFiltered} · 预算/条数排除 ${trace.diagnostics.budgetOrLimitExcluded}`) : null,
              h('pre', null, JSON.stringify(trace, null, 2)));
          })));
      else if (tab === 'private') content = h('div', { className: 'stack' },
        h('div', { className: 'private-card stack' }, h('div', { className: 'eyebrow' }, 'PRIVATE JOURNAL'),
          h('h2', null, '私人记录，不展示正文'),
          h('p', null, `${status.private.count} 条 · ${(status.private.bytes / 1024).toFixed(1)} KiB`),
          h('p', { className: 'muted' }, `每日 Markdown 文件 ${status.private.dailyCount ?? 0} 份 · 旧记录 ${status.private.legacyCount ?? 0} 条 · 日期范围 ${status.private.firstDay || '暂无'} 至 ${status.private.lastDay || '暂无'}`),
          h('p', { className: 'muted' }, `最近入库（含历史导入）：${status.private.lastWritten || '尚无记录'} · 历史导入 ${status.private.importedCount ?? 0} 条`),
          h('p', { className: 'muted' }, `最近会话／作者新写入：${status.private.lastContributionAt || '尚无新写入'}；历史导入时间不是日记日期。`),
          h('p', null, status.private.generation),
          h('p', { className: 'path' }, status.private.directory),
          h('p', { className: 'muted' }, '正文目录只保留 YYYY-MM-DD.md；同一天的贡献合并写入。索引和写入暂存保存在 system/private，不在正文目录。'),
          status.private.indexFile && h('p', { className: 'path' }, `内部索引：${status.private.indexFile}`),
          h('small', null, '不出现在普通搜索、图谱和明文备份中。主会话回顾时，日记片段会进入该会话历史；此隔离不是对本机管理员或其他任意文件工具的绝对保密。')),
        h('div', { className: 'panel stack' },
          h('h3', null, '日记设置与维护'),
          h('p', { className: 'muted' }, '仅指定会话可收到昨日及更早的私人日记片段；模型路由必须与设置一致。自动日记汇总默认关闭；开启后也只读取绑定工作区会话，并且不在管理页显示正文。'),
          button('管理此工作区的会话授权', () => setTab('settings')),
          field('主会话日记上下文预算（字节）', config.privateContextBudget,
            value => patchConfig('privateContextBudget', value), 'number', { min: 1024, max: 32000, step: 512 }),
          check('允许同工作区其他会话提交私人日记贡献（默认关闭）', config.privateContributionsEnabled,
            value => patchConfig('privateContributionsEnabled', value)),
          h('small', null, '此开关仅允许写入，不会自动写日记。启用后需会话实际调用 tidal_private_contribute，或由获准作者插件提交；仅选择主会话只会开启回顾，不会补写空缺日期。'),
          h('small', null, `待主会话回顾 ${status.private.reviewPendingDays ?? 0} 天 · 已完整观察 ${status.private.observedDays ?? 0} 天 · 近期日记按上下文预算分段提供。`),
          h('small', null, '启用后只读取此绑定工作区内目标日期的用户与助手文本；由上方已授权主会话的模型生成，正文仅写入 YYYY-MM-DD.md，不进入普通记忆或界面状态。'),
          h('small', null, status.private.automaticSummary ?
            `最近自动汇总：${status.private.automaticSummary.day || '日期未知'} · ${
              ({ completed: '已写入', 'no-content': '当天无可用文本', failed: '失败' })[status.private.automaticSummary.state] || '状态未知'} · ${
              status.private.automaticSummary.messageCount} 条消息 · ${
              status.private.automaticSummary.provider || '无路由'} / ${status.private.automaticSummary.model || '无模型'}` :
            '尚无自动汇总记录；仅选择主会话不会自动生成日记。'),
          h('div', { className: 'fields' },
            field('单日回溯日期', privateSummaryDay, setPrivateSummaryDay, 'date'),
            h('div', { className: 'stack' },
              h('small', null, '只处理一个日期；若该日已有自动日记，不会重复追加。'),
              h('button', { type: 'button', disabled: busy || !privateSummaryDay || !config.privateAutoJournalEnabled ||
                !status.config.privateAutoJournalEnabled,
                onClick: () => run(() => request(space, '/private/daily-summary', { day: privateSummaryDay }),
                  value => value.state === 'completed'
                    ? `已写入 ${value.day} 私人 Markdown 日记（${value.messageCount} 条会话消息）；正文未在界面展示。`
                    : value.state === 'no-content' ? `${value.day} 没有可用会话文本，未写入日记。`
                      : `该日期已处理：${value.day}。`) }, '生成该日私人日记'))),
          button('保存日记全局设置', () => saveSection(['privateContextBudget', 'privateContributionsEnabled']), 'primary'),
          h('small', null, '主会话历史会保留已注入的私人片段。若会话被 fork、路由不符或继承了私人历史，插件会拒绝其继续运行；清空日记不会自动解除已污染会话的限制。'),
          status.private.failure ? h('p', { className: 'message error' },
            `私人日记文件整理在 ${status.private.failure.at} 未完成，已完成条目保留；可单独重试。`) : null,
          h('small', null, status.private.organization ?
            `上次覆盖 ${status.private.organization.from} 至 ${status.private.organization.until} · ${status.private.organization.state === 'completed' ? '已完成' : '部分完成，可重试'} · 检查 ${status.private.organization.inspected} 篇` :
            '尚未整理；首次仅处理最近睡眠窗口内可确认日期的记录，不批量改写历史导入。'),
          button('规范日记文件格式', () => run(() => request(space, '/private/organize', {}),
            value => value.state === 'completed' ? '日记文件格式整理完成，未展示正文。' : '日记文件格式整理部分完成，请稍后重试。')),
          field('允许的作者插件名称（逗号分隔）', privateWritersInput, value => {
            setPrivateWritersInput(value);
            patchConfig('privateWriters', value.split(',').map(x => x.trim()).filter(Boolean));
          }),
          button('保存作者权限', () => saveSection(['privateWriters']), 'primary'),
          fold('危险操作 · 清空私人记录', button('清空私人记录', () => {
            if (window.prompt('清空当前私人记录，同数据根同谱系恢复将遵守标记；旧离线备份不会被改写。输入 DELETE PRIVATE JOURNAL 确认：') === 'DELETE PRIVATE JOURNAL')
              run(() => request(space, '/private/clear', { confirmation: 'DELETE PRIVATE JOURNAL' }), '当前私人记录已清空；旧备份未删除。');
          }, 'danger'))));
      else content = h('div', { className: 'stack' },
        h(WorkspacePanel, { key: space, row: currentWorkspace, binding, space, busy, change: changeBinding,
          oldSpaces: status.spaces.filter(key => !directory.items.some(row => row.space === key)), openOld: key => switchSpace(key, true) }),
        boundWorkspace ? h('div', { className: 'panel stack' }, h('h3', null, '此工作区的会话与权限'),
          h('small', null, '按 DSH 侧栏名称选择。只对当前工作区生效；三项分别保存，选择不等于授权。'),
          routeCard('历史查证主会话', 'historyMainSessions'), routeCard('私人日记主会话', 'privateMainSessions'),
          config.deepOrganizationMode === 'session' && routeCard('整理模型会话', 'deepOrganizationSessions')) :
          h('small', null, '请先绑定工作区，再选择会话。'),
        h('div', { className: 'panel stack' }, h('h3', null, '全局 · 功能开关与模型来源'),
          check('允许指定主会话查找同工作区会话记录（默认关闭）', config.historyReadEnabled, v => patchConfig('historyReadEnabled', v)),
          check('按日自动生成私人日记（默认关闭）', config.privateAutoJournalEnabled, v => patchConfig('privateAutoJournalEnabled', v)),
          h('small', null, '开启后仍需在各工作区单独授权会话及准确模型。私人日记片段会进入获准主会话的历史。'),
          h('label', null, h('span', null, '普通深度整理方式'),
            h('select', { 'aria-label': '普通深度整理方式', value: config.deepOrganizationMode,
              onChange: event => patchConfig('deepOrganizationMode', event.target.value) },
            h('option', { value: 'local' }, '本地规则（默认，不调用生成模型）'),
            h('option', { value: 'session' }, '使用所选工作区会话模型'),
            h('option', { value: 'api' }, '使用 OpenAI-compatible API'))),
          config.deepOrganizationMode === 'api' ? h('div', { className: 'stack' },
            field('完整 API 地址', config.deepOrganizationApiEndpoint,
              value => patchConfig('deepOrganizationApiEndpoint', value)),
            field('API 模型名', config.deepOrganizationApiModel,
              value => patchConfig('deepOrganizationApiModel', value)),
            field('API 密钥（只写入，不回显）', modelApiKeyInput, setModelApiKeyInput,
              'password', { autoComplete: 'new-password' }),
            h('div', { className: 'row' },
              button('保存 API 密钥', () => run(async () => {
                await request(space, '/model-api-key', { apiKey: modelApiKeyInput });
                setModelApiKeyInput('');
              }, 'API 密钥已受 Windows 当前账户保护并保存。')),
              button('清除 API 密钥', () => run(() => request(space, '/model-api-key/clear', {}),
                '本地整理 API 密钥已清除。'), 'danger')),
            h('small', null, `API 密钥${status.modelApiKey?.configured ? '已保存' : '未保存'}；仅在启动整理请求时解封到内存，不进入配置或备份。`)) : null,
          button('保存全局功能设置', () => saveSection(['historyReadEnabled', 'privateAutoJournalEnabled', 'deepOrganizationMode', 'deepOrganizationApiEndpoint', 'deepOrganizationApiModel']), 'primary')),
        fold('高级设置 · 全局策略、索引和文件位置',
        h('div', { className: 'panel stack' }, h('h3', null, '文件位置'),
          ...[['plugin', '插件代码'], ['models', '共享模型目录'], ['semanticIndex', '当前空间的派生语义索引'],
            ['topicIndex', '当前空间的派生主题索引'], ['graphIndex', '当前空间的派生图谱索引'],
            ['backups', '当前空间的恢复点'], ['backupKey', '自动备份受保护口令'],
            ['privateSessionRegistry', '私人历史会话隔离登记（不含正文）'],
            ['forgetLedger', '同谱系恢复的遗忘标记（无正文）']]
            .map(([key, label]) => h('div', { key }, h('strong', null, label),
              h('p', { className: 'path' }, status.paths?.[key]))),
          h('small', null, '普通记忆数据库的位置见总览四层卡片；私人日记位置只在私人页展示，不提供正文。模型与备份不放在插件代码目录，更新插件不会替换记忆或重新下载模型。')),
        h('div', { className: 'panel stack' }, h('h3', null, '本地语义组合'),
          h('label', null, '本地语义组合', h('select', { 'aria-label': '本地语义组合', value: config.embeddingMode,
            onChange: event => patchConfig('embeddingMode', event.target.value) },
            ...[['off', '标准 · 不加载模型'], ['cpu', '本地语义 · BGE-small / CPU'], ['enhanced', '本地增强 · Qwen3 / Vulkan 或 CPU']]
              .map(([value, label]) => h('option', { key: value, value }, label)))),
          h('p', { className: 'muted' }, '三个组合共用同一记忆库。首次模型下载须手动执行随包安装脚本，之后只读本地模型，不向 embedding 服务上传正文。先保存选择，再准备索引；关闭语义仍保留完整四层记忆。增强指模型规模，不保证在每种记忆上都优于 CPU 组合。'),
          h('p', null, `当前：${status.semantic?.ready ? '模型就绪' : '未加载 / 未就绪'} · 覆盖 ${status.semantic?.index?.indexed ?? 0} / ${status.semantic?.index?.total ?? '?'} 条`),
          (status.semantic?.tasks?.[0] || status.semantic?.lastTask) ? h('small', null, (() => {
            const task = status.semantic.tasks?.[0] || status.semantic.lastTask;
            return `${task.kind === 'prewarm' ? '空闲索引准备' : '前台语义请求'}：${taskStates[task.state] || task.state}${task.code ? `（${task.code}）` : ''}`;
          })()) : null,
          status.semantic?.directory ? h('code', { className: 'path' }, status.semantic.directory) : null,
          status.semantic?.error ? h('div', { className: 'message error', role: 'alert' },
            `${status.semantic.error.code} · ${status.semantic.error.message}`) : null,
          h('details', null, h('summary', null, '模型高级选项'),
            h('div', { className: 'stack' },
              field('模型包绝对路径（留空使用默认组合）', config.embeddingModelPath, value => patchConfig('embeddingModelPath', value)),
              h('label', null, '本地推理设备', h('select', { value: config.embeddingDevice,
                onChange: event => patchConfig('embeddingDevice', event.target.value) },
                h('option', { value: 'auto' }, '自动：增强版 Vulkan，语义版 CPU'),
                h('option', { value: 'cpu' }, '强制 CPU'))),
              field('语义准备等待上限（秒）', config.embeddingTimeoutSeconds,
                value => patchConfig('embeddingTimeoutSeconds', value), 'number', { min: 5, max: 3600 }),
              field('语义最低相似度（-1 使用模型默认）', config.embeddingMinScore,
                value => patchConfig('embeddingMinScore', value), 'number', { min: -1, max: 1, step: 0.05 }),
              field('语义相对门槛（-1 使用模型默认）', config.embeddingRelativeFloor,
                value => patchConfig('embeddingRelativeFloor', value), 'number', { min: -1, max: 1, step: 0.05 }),
              h('p', { className: 'muted' }, '冷启动先校验文件，再加载模型和增量索引。超时或失败明确标记降级，不会停止保存普通记忆。显卡初始化失败可改用 CPU，不连接已有的未知模型服务。'))),
          h('div', { className: 'row' }, button('保存语义设置', () => saveSection(semanticKeys), 'primary'),
            button('准备本地语义索引', () => run(() => request(space, '/semantic/prepare', {}), '本地模型与语义索引已就绪。')),
            button('重新校验模型并重建语义索引', () => run(() => request(space, '/semantic/rebuild', {}), '模型已重新校验，派生语义索引已重建。'))),
          h('small', null, '空间空闲时只为已启用的本地语义组合准备普通索引，前台请求优先。私人日记和 L0 不进入向量索引。模型、向量与缓存不进入记忆备份；删除普通记忆同时清理其向量。')),
        h('div', { className: 'panel stack' }, h('h3', null, '模型文件与下载'),
          ...(status.modelPacks ?? []).map(pack => h('div', { className: 'stack', key: pack.edition },
            h('strong', null, `${pack.modelId} · ${pack.dimension} 维 · 权重 ${(pack.weightBytes / 1024 / 1024).toFixed(1)} MiB`),
            h('span', { className: 'badge' }, pack.installed ?
              (status.semantic?.ready && status.semantic.fingerprint === pack.fingerprint ? '本轮已完成校验并加载' : '模型文件齐备，加载时校验') :
              '尚未安装完整'),
            h('code', { className: 'path' }, pack.directory),
            h('details', null, h('summary', null, '模型文件详情'),
              h('p', null, '模型权重'), h('code', { className: 'path' }, pack.weightFile),
              h('p', null, '版本与校验清单'), h('code', { className: 'path' }, pack.manifestFile),
              h('p', null, '本地运行时'), h('code', { className: 'path' }, pack.runtimeDirectory)),
            h('small', null, `${pack.license} · 另需本地运行时空间。下载只访问模型来源和依赖仓库，不包含记忆正文。`),
            h('a', { href: pack.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, '查看固定版本的模型下载来源'),
            h('details', null, h('summary', null, '下载 / 安装命令'),
              h('p', null, '复制后在本机终端执行；命令已包含 Node、插件脚本和下载目标的完整路径。自定义模型目录不会被此命令覆盖。'),
              h('pre', null, pack.installCommand),
              button('复制安装命令', () => run(async () => {
                if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持剪贴板，请手动复制上方命令。');
                await navigator.clipboard.writeText(pack.installCommand);
              }, '安装命令已复制。'))),
            pack.error ? h('p', { role: 'alert' }, `${pack.error.code} · ${pack.error.message}`) : null))),
        h('div', { className: 'panel stack' }, h('h3', null, '记忆策略'),
          check('启用记忆捕获与召回', config.enabled, value => patchConfig('enabled', value)),
          check('自动记录用户陈述及受支持的工具回执', config.autoCandidates, value => patchConfig('autoCandidates', value)),
          h('small', null, '助手全文不再自动捕获；明确的完成自述只作为待核线索。旧版助手全文设置保留但不再生效。'),
          check('将本地召回的普通记忆附加到当前聊天请求', config.injectContext, value => patchConfig('injectContext', value)),
          check('已确认图谱关联辅助召回（默认关闭）', config.graphRecall, value => patchConfig('graphRecall', value)),
          h('p', { className: 'muted' }, '仅从通过本轮词面证据门槛的已选记忆扩展人工确认且仍有效的关联，最多补充 3 条，使用剩余预算；纯语义命中和主题相同不自动扩展。'),
          h('p', { className: 'muted' }, '人工关联不保证与当前问题相关，可能带入不同主体、时期或冲突内容；大空间下也可能增加延迟。启用前可先在“回忆与整理”中检查结果。'),
          h('p', { className: 'muted' }, '关闭后不自动注入记忆，但模型主动调用记忆工具仍可读取普通记忆。纯本地整理模式不会发起生成模型请求。'),
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
              ['backupKeep', '每种明文 / 加密恢复点保留数量', 1, 90],
            ].map(([key, label, min, max]) => h(React.Fragment, { key },
              field(label, config[key], value => patchConfig(key, value), 'number', { min, max })))),
          h('label', null, 'L3 常驻范围', h('select', { value: config.residentMode,
            onChange: event => patchConfig('residentMode', event.target.value) },
            ...[['all', '全部有效 L3（默认）'], ['core', '身份、偏好、约定及固定项'], ['pinned', '仅固定项']]
              .map(([value, label]) => h('option', { key: value, value }, label)))),
          h('p', { className: 'muted' }, '常驻不等于已核实；过期、待审核和已被替代的条目不注入。常驻先使用独立额度，但总预算仍是硬上限。近期消息逐条匹配，不用无关内容凑数。'),
          check('空闲时执行小整理（纯本地规则）', config.autoConsolidate, value => patchConfig('autoConsolidate', value)),
          check('低重要且未使用的旧 L2 自动归档（保存满八个半衰期，不删除）', config.autoArchive, value => patchConfig('autoArchive', value)),
          h('small', null, status.organizationModels?.ordinary?.message),
          h('small', null, '深度整理材料仅包括当前工作区的有效普通 L1/L2；严格排除 L0 与私人日记。原始记录保留，模型输出作为 L3 待核候选，确认前不会自动召回。L3 存储不设总条数上限，常驻额度和单次召回条数只限制注入上下文，不限制保存。'),
          h('div', { className: 'fields' },
            field('每日深度整理时间（本机时间，留空关闭）', config.dailyConsolidateAt,
              value => patchConfig('dailyConsolidateAt', value), 'time'),
            h('div', { className: 'stack' },
              h('small', null, `上次深度整理：${status.deepConsolidation ?
                `${new Date(status.deepConsolidation.at).toLocaleString()} · ${status.deepConsolidation.manual ? '手动' : '定时'} · 提炼 ${status.deepConsolidation.promoted} 条` : '尚未运行'}`),
              h('small', null, `下次预计：${status.nextDailyConsolidationAt ?
                new Date(status.nextDailyConsolidationAt).toLocaleString() : '已关闭'}`))),
          h('p', { className: 'muted' }, '普通深度整理按上方模式运行；私人日记轻整理与普通记忆分开。整理前先创建恢复点，不含 L0，是否包含私人日记由备份范围决定。宿主每分钟检查，停机后空闲时补跑最近一次。L1 时长仅影响此后自动捕获的任务。'),
          button('立即深度整理一次', () => run(() => request(space, '/consolidate', {}),
            value => `深度整理完成：检查 ${value.inspected} 条，规则提炼 ${value.promoted} 条，模型待核 ${value.modelOrganization?.pendingEvidence ?? 0} 条，二次编码新增 ${value.reencoding?.candidates ?? 0} 条待确认候选，冲突待复核 ${value.conflicts} 条。${
              value.privateOrganization?.state === 'completed' ? '' : '私人整理未全部完成，请查看私人日记状态。'}${
              value.modelOrganization?.state === 'failed' ? '模型整理失败，原始 L1/L2 保留；查看错误状态后重试。' : ''}`)),
          status.deepConsolidation?.eligibility ? h('details', null, h('summary', null, '查看上次整理未产出的原因'),
            h('pre', null, JSON.stringify(status.deepConsolidation, null, 2))) : null,
          check('空闲维护自动备份（范围在“备份与恢复”中选择）', config.autoBackup, value => patchConfig('autoBackup', value)),
          h('div', { className: 'row' }, button('保存设置', () => saveSection(policyKeys), 'primary'),
            button('重建搜索索引', () => run(() => request(space, '/rebuild/search', {}), '搜索索引已重建。')),
            button('重建主题索引', () => run(() => request(space, '/rebuild/topics', {}), '主题索引已重建。')),
            button('重建可读文件', () => run(() => request(space, '/rebuild/views', {}), 'L1-L3 可读视图已重建，旧 L0 生成副本已清理。'))),
          h('p', { className: 'muted' }, 'L0 仍是明文短期缓冲，不生成新 Markdown 副本。重建可读文件只清理带原生成标记的旧 L0 副本，不删除手写文件。旧备份可能含完整会话原文，不受 72 小时清理约束，需另行检查和删除。')),
        ),
        fold('迁移与维护 · 补录、导入和恢复',
            h('div', { className: 'panel stack' }, h('h4', null, '历史补录（管理操作）'),
              h('p', { className: 'muted' }, '只预览所选普通用户消息中可由本地规则识别的原句；助手消息、工具结果、私人/继承会话和已遗忘事件不参与。候选按 L1/L2 待核保存，不会自动成为长期事实。'),
              picker('历史补录来源会话', historyImportSession, id => { setHistoryImportSession(id); setHistoryImportPlan(null); }, true),
              field('历史补录查询词（或选择日期）', historyImportQuery, value => {
                setHistoryImportQuery(value); setHistoryImportPlan(null);
              }, 'text', { disabled: busy }),
              field('历史补录日期（YYYY-MM-DD，可选）', historyImportDate, value => {
                setHistoryImportDate(value); setHistoryImportPlan(null);
              }, 'date', { disabled: busy }),
              h('div', { className: 'row' },
                button('预览所选会话历史', previewSelectedHistory),
                historyImportPlan ? h('small', null,
                  `${historyImportPlan.sessionsChecked} 个会话 · ${historyImportPlan.candidateCount} 条候选${historyImportPlan.id ? ' · 20 分钟后过期' : ''} · ${historyImportPlan.coverage}`) : null),
              historyImportPlan ? h('div', { className: 'stack' },
                historyImportPlan.truncated ? h('p', { className: 'message' }, '候选超过每批上限，请缩小查询范围后重新预览。') : null,
                ...historyImportPlan.candidates.map(candidate => h('label', { className: 'import-candidate', key: candidate.importId },
                  h('input', { type: 'checkbox', disabled: busy || !historyImportPlan.id || candidate.status === 'already-exists',
                    checked: historyImportSelected.includes(candidate.importId),
                    onChange: event => setHistoryImportSelected(current => event.target.checked ?
                      [...current, candidate.importId] : current.filter(id => id !== candidate.importId)) }),
                  h('span', null, `${candidate.status === 'already-exists' ? '已存在' : '待核'} · ${candidate.layer} · ${candidate.at} · ${candidate.rule} · ${candidate.text} · 来源 ${candidate.sessionId}:${candidate.eventSeq}`))),
                historyImportPlan.candidates.length ?
                  h('button', { type: 'button', className: 'primary',
                    disabled: busy || !historyImportPlan.id || historyImportSelected.length === 0,
                    onClick: applySelectedHistory }, `确认补录所选 ${historyImportSelected.length} 条`) :
                  h('p', { className: 'muted' }, '没有可补录候选；这不代表所选范围内没有其他相关内容。')) : null),
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
          h('label', null, h('span', null, '自动恢复点方式'),
            h('select', { 'aria-label': '自动恢复点方式', value: config.autoBackupMode,
              onChange: event => patchConfig('autoBackupMode', event.target.value) },
            h('option', { value: 'plain' }, '普通明文（默认，不含私人日记）'),
            h('option', { value: 'encrypted', disabled: !status.backupProtection.supported }, '加密普通记忆（不含私人日记）'),
            h('option', { value: 'encrypted-private', disabled: !status.backupProtection.supported }, '加密普通记忆和私人日记'))),
          h('small', null, status.backupProtection.supported
            ? `Windows 当前账户保护：${status.backupProtection.configured ? '已发现口令文件，使用时验证' : '尚未设置口令'}。深度整理前的恢复点也使用此方式。`
            : '本机不支持 Windows 账户 DPAPI 自动加密；仍可手动下载口令加密备份。'),
          h('p', { className: 'muted' }, '先设置并自行离线保管口令，再选择加密方式并保存。DPAPI 保护的口令不能跨 Windows 账户或设备解开；离机恢复必须同时携带备份文件与原口令。更换口令后，旧备份仍需要旧口令。密钥不可用时备份会明确失败，不会改写为明文；旧明文恢复点保持不变。'),
          field('设置自动备份口令（至少 12 字符）', automaticPassword, setAutomaticPassword, 'password', { autoComplete: 'new-password' }),
          h('div', { className: 'row' },
            button('保存受保护的自动备份口令', () => run(async () => {
              const value = await request(space, '/backup/key', { password: automaticPassword });
              setAutomaticPassword('');
              return value;
            }, '口令已由 Windows 当前账户保护；请离线保存原口令，再选择并保存自动恢复点方式。')),
            button('保存自动备份方式', () => saveSection(['autoBackupMode']), 'primary')),
          h('hr'),
          field('手动备份 / 恢复口令（至少 12 字符；手动加密备份包含私人记录）', password, setPassword, 'password', { autoComplete: 'new-password' }),
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
          }, value => `已恢复到 ${value.space}，跳过 ${value.skippedForgotten} 条已知遗忘记录及 ${value.skippedPrivate} 条已清空的私人记录。${
            value.forgetCoverage === 'backup-only' ? '此设备没有更新的同谱系标记，只能依据备份当时的标记；旧离线备份可能带回之后遗忘的内容。' :
              value.forgetCoverage === 'legacy-name-match' ? '旧备份按来源空间名匹配本机标记，无法证明名称未被复用。' : '已应用本机同谱系遗忘标记。'}请绑定对应工作区后使用。`)))));

      return h('main', { className: 'tidal', 'data-plugin': 'tidal-memory' },
        h('div', { className: 'hero' }, h('div', null, h('div', { className: 'eyebrow' }, 'TIDAL MEMORY'),
          h('div', { className: 'brand' }, '潮汐记忆', h('span', { className: 'version' }, status?.version ? `v${status.version}` : '版本未知')), h('small', null, '跨会话连续 · 按工作区隔离 · 四层独立存储')),
          h('div', { className: 'row' }, h('label', null, '当前 DSH 工作区', h('select', { 'aria-label': '当前 DSH 工作区', disabled: busy,
            value: currentWorkspace?.id || '', onChange: e => { const row = directory.items.find(item => item.id === e.target.value); if (row) switchSpace(row.space); } },
            !currentWorkspace && h('option', { value: '' }, oldView.current ? '正在查看旧空间' : '请选择工作区'),
            ...directory.items.map(row => h('option', { key: row.id, value: row.id, title: row.cwd },
              (workspaceName(row) || row.cwd) + (directory.items.some(other => other.id !== row.id && other.title === row.title) ?
                ' · ' + pathSuffix(row.cwd, directory.items.map(item => item.cwd)) : ''))))),
            button('刷新', () => run(readDirectory)))),
        directory.error && h('p', { role: 'alert', className: 'message error' }, directory.error),
        status ? h('div', { className: 'status-strip', 'aria-label': '记忆服务状态' },
          h('strong', null, '状态'), h('span', { className: status.unavailable ? 'badge' : 'badge ok' },
            status.unavailable ? '记忆服务：当前空间已暂停' : '记忆服务：已挂载'),
          h('span', { className: 'badge' }, currentWorkspace ? `当前工作区：${workspaceName(currentWorkspace) || currentWorkspace.cwd}` : `旧空间：${space}`),
          h('span', { className: 'badge' }, boundWorkspace ? '工作区：已绑定' : binding ? '工作区：绑定待核对' : '工作区：未绑定'),
          h('span', { className: 'badge' }, status.unavailable ? '整理与检索：不可用' : '整理与检索：本地运行'),
          h('span', { className: 'badge' }, `上下文注入：${status.config.injectContext ? '已开启' : '已关闭'}`)) : null,
        h('nav', { className: 'tabs', 'aria-label': '记忆管理' },
          ...[['overview', '总览'], ['memories', '分层记忆'], ['graph', '记忆图谱'], ['recall', '回忆与整理'], ['private', '私人日记'], ['settings', '设置与迁移']]
            .map(([id, label]) => h('button', { key: id, type: 'button', role: 'tab', 'aria-selected': tab === id, onClick: () => { setTab(id); setNotice(null); } }, label))),
        Object.keys(edits).length > 0 && h('div', { className: 'row' }, h('small', null, '有未保存的设置；请在相应区块保存。'), button('放弃设置草稿', () => setEdits({}))),
        notice ? h('div', { className: `message ${notice.error ? 'error' : ''}`, role: notice.error ? 'alert' : 'status' }, notice.text) : null,
        status?.error ? h('div', { className: 'message error' }, `${status.error.code} · ${status.error.message}`) : null,
        status?.searchIndex?.some(index => !index.current) ? h('div', { className: 'message error', role: 'alert' },
          '分词索引需要升级，旧索引不会参与召回。请在设置中重建搜索索引。') : null,
        ...(status?.errors || []).map((error, i) => h('div', { className: 'message error', key: i }, `${error.code} · ${error.message}`)),
        h('fieldset', { disabled: busy }, content));
    }
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error: error.message }; }
      render() {
        return this.state.error ? h('div', { role: 'alert' }, `潮汐记忆界面加载失败：${this.state.error}`) : h(Page, this.props);
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
        }, () => h(Boundary, { sessionList: ctx.get?.('sessions')?.list })));
      },
    };
  },
});
