window.__ModuleLoader__.load({
  id: 'dsh-webcode-bridge',
  factory(require, module) {
    'use strict';
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { IconCodeOutline16 } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const inject = ['slots', 'settingsScope', 'sidebarRightTabs', 'sidebarRight'];
    const RELAY_PORT = 8931;
    const relayBase = 'http://127.0.0.1:' + RELAY_PORT;
    const icon = size => h(IconCodeOutline16, { size });

    async function api(action, body, timeoutMs = 30000) {
      const response = await fetch('/__webcode/' + action, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || '请求失败');
      return data;
    }

    const MODEL_NAMES = { deepseek: 'DeepSeek' };
    // 站点显示名 + 多站点模型目录（打开时从 /__webcode/models 拉取）
    const SITE_NAMES = { deepseek: 'DeepSeek', glm: '智谱清言', chatgpt: 'ChatGPT', kimi: 'Kimi', qwen: '通义千问', doubao: '豆包', grok: 'Grok', claude: 'Claude', gemini: 'Gemini', zai: 'Z.ai (GLM 海外版)' };
    const siteName = sid => SITE_NAMES[sid] || sid;

    // ---- 速度观测（HTML/CSS 条形图，克制低饱和） ------------------------
    // 数值表格不直观；条形长度按时间/速度归一化，一眼可比。
    const BAR_MAX_MS = 60_000;   // 时间条满格：60s（超长回复也会被 clamp 到满）
    const BAR_MAX_TPS = 60;      // 速度条满格：60 token/s

    function Bar({ label, value, text, max, tone }) {
      const pct = value == null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
      return h('div', { className: 'hwb-bar-row' },
        h('span', { className: 'hwb-bar-label' }, label),
        h('span', { className: 'hwb-bar-track' },
          h('span', { className: 'hwb-bar-fill' + (tone === 'ok' ? ' ok' : ''), style: { width: pct + '%' } })),
        h('output', { className: 'hwb-bar-value' }, text));
    }

    function Metrics({ metrics }) {
      if (!metrics) return h('span', { className: 'hwb-hint' }, '尚无调用记录（完成一次生成后此处显示实测速度）');
      const measured = metrics.timing === 'measured';
      const ms = v => v == null ? '--' : (v >= 1000 ? (v / 1000).toFixed(1) + ' s' : v + ' ms');
      const tpsText = metrics.responseTps == null ? '--'
        : metrics.responseTps.toFixed(1) + (metrics.tokensEstimated ? ' 约 token/s' : ' token/s');
      return h('div', { className: 'hwb-metrics' },
        h('div', { className: 'hwb-metrics-head' },
          h('span', { className: 'hwb-badge' + (measured ? ' measured' : '') }, measured ? '实测' : '估算'),
          measured ? (metrics.phaseSource ? '来自 ' + metrics.phaseSource + '；速度 token 数按 CJK/ASCII 估算' : null) : '首次网页调用完成后显示实测数据'),
        h(Bar, { label: '首字延迟', value: metrics.firstTokenMs, text: ms(metrics.firstTokenMs), max: BAR_MAX_MS }),
        h(Bar, { label: '可观测思考', value: metrics.thinkingMs, text: metrics.thinkingMs == null ? '网页未提供' : ms(metrics.thinkingMs), max: BAR_MAX_MS }),
        h(Bar, { label: '正文输出', value: metrics.responseMs, text: ms(metrics.responseMs), max: BAR_MAX_MS }),
        h(Bar, { label: '正文速度', value: metrics.responseTps, text: tpsText, max: BAR_MAX_TPS, tone: 'ok' }),
        h(Bar, { label: '总耗时', value: metrics.durationMs, text: ms(metrics.durationMs), max: BAR_MAX_MS }));
    }

    function PresetPreview() {
      const [preset, setPreset] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const load = () => api('preset').then(p => setPreset(p)).catch(() => {});
      React.useEffect(() => { if (open && preset === null) load(); }, [open]);
      return h('details', { className: 'hwb-preset', onToggle: e => setOpen(e.target.open) },
        h('summary', null, '查看固定首轮模板（发送首条消息时注入网页的完整内容）'),
        preset === null ? h('p', { className: 'hwb-hint' }, '加载中…')
          : preset.prompt
            ? h('pre', null, preset.prompt)
            : h('p', { className: 'hwb-hint' }, preset.note || '尚未发送过首轮请求。'),
        preset?.prompt && h('p', { className: 'hwb-hint' },
          '模型: ' + (MODEL_NAMES[preset.model] || preset.model) +
          (preset.tools?.length ? ' · 工具: ' + preset.tools.join(', ') : ' · 无工具')));
    }

    function GlobalPrompt() {
      const [value, setValue] = React.useState('');
      const [saved, setSaved] = React.useState('');
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [error, setError] = React.useState('');
      React.useEffect(() => {
        if (!open) return;
        let alive = true;
        api('settings').then(s => { if (alive) { setValue(s.extraPrompt || ''); setSaved(s.extraPrompt || ''); } }).catch(e => { if (alive) setError(e.message); });
        return () => { alive = false; };
      }, [open]);
      async function save() {
        setBusy(true); setNotice(''); setError('');
        try {
          const r = await api('settings', { extraPrompt: value });
          setSaved(r.extraPrompt || ''); setValue(r.extraPrompt || '');
          setNotice('已保存，后续每个新网页会话的首轮提示词都会包含「全局指令」。');
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }
      return h('details', { className: 'hwb-preset', onToggle: e => setOpen(e.target.open) },
        h('summary', null, '全局指令（唯一可编辑的提示词部分，追加到首轮模板末尾）'),
        !open ? null
          : h('div', { className: 'hwb-import' },
            h('p', { className: 'hwb-hint' }, '首轮模板由桥按当前会话的工具清单自动生成，是固定的；你只能在这里追加一段「[全局指令]」注入每个新网页会话的首条消息，例如："始终用中文回答；执行任何操作前先说明依据"。'),
            h('textarea', {
              className: 'hwb-prompt-input', value, rows: 5, maxLength: 4000,
              placeholder: '例如：始终保持工具调用格式；回答简洁；先读文件再下结论。',
              onChange: e => setValue(e.target.value),
            }),
            h('div', { className: 'hwb-row' },
              h('button', { disabled: busy || value === saved, onClick: save }, busy ? '保存中…' : '保存全局指令'),
              notice && h('span', { className: 'hwb-hint' }, notice)),
            error && h('p', { role: 'alert', className: 'hwb-hint' }, error)));
    }

    // 按站点分组的模型下拉选项：从桥的 /__webcode/models 取全站点目录
    function ModelSelect({ models, value, onChange, disabled }) {
      if (!models) return h('select', { disabled: true }, h('option', null, '加载模型目录…'));
      const groups = new Map();
      for (const m of models) {
        if (!groups.has(m.siteId)) groups.set(m.siteId, []);
        groups.get(m.siteId).push(m);
      }
      return h('select', { className: 'hwb-model-select', value: value || '', disabled, onChange: e => onChange(e.target.value) },
        [...groups.entries()].map(([sid, list]) => h('optgroup', { key: sid, label: siteName(sid) },
          list.map(m => h('option', { key: m.id, value: m.id },
            m.name + (m.experimental ? '（实验）' : '') + (m.thinking ? ' · 深度思考' : '') + (m.vision ? ' · 识图' : ''))))));
    }

    /**
     * 网页与模型管理的「账户」卡片：每个内容服务一行——登录状态 + 登录/换账户
     * + 独立窗口。登录等待真实结果（最长 5 分钟），成功/失败/超时都回显在本行，
     * 不再 fire-and-forget；登录窗口是真实有头 Edge，与自动化共用同一 profile。
     */
    function SiteAccounts({ sites, onRefresh }) {
      const [busySite, setBusySite] = React.useState(null);
      const [results, setResults] = React.useState({});
      const list = (sites && sites.length ? sites : [])
        .map(s => ({ siteId: s.siteId, loggedIn: s.loggedIn, initialized: s.initialized, busy: s.busy }))
        .sort((a, b) => (a.siteId === 'deepseek' ? -1 : b.siteId === 'deepseek' ? 1 : siteName(a.siteId).localeCompare(siteName(b.siteId))));
      const setResult = (sid, r) => setResults(prev => ({ ...prev, [sid]: r }));
      const [winSites, setWinSites] = React.useState({});
      const refreshWins = () => api('window').then(w => setWinSites(w?.windows || {})).catch(() => {});
      React.useEffect(() => { refreshWins(); }, []);
      async function doLogin(sid) {
        setBusySite(sid); setResult(sid, null);
        try {
          // 后端要打开有头 Edge 等人工登录，超时必须放宽（等待上限 300s）。
          const r = await api('login', { siteId: sid, wait: true, timeoutMs: 300000 }, 330000);
          setResult(sid, {
            ok: r.loggedIn === true,
            text: (r.alreadyLoggedIn ? '登录态仍有效，无需重复登录' : (r.message || '登录完成'))
              + (r.ms ? '（' + Math.round(r.ms / 1000) + 's）' : ''),
          });
          await onRefresh?.();
        } catch (e) { setResult(sid, { ok: false, text: e.message }); }
        finally { setBusySite(null); }
      }
      async function checkLogin(sid) {
        // 在独立窗口里登录完后点这里立即确认结果（connect 幂等且轻量）。
        setBusySite(sid); setResult(sid, null);
        try {
          const r = await api('verify-login', { siteId: sid }, 90000);
          setResult(sid, { ok: r.loggedIn === true, text: r.loggedIn === true ? '已检测到登录态' : r.loggedIn === false ? '仍未登录（请在独立窗口完成登录后再检测）' : '待检查（先打开一次站点）' });
          await onRefresh?.();
        } catch (e) { setResult(sid, { ok: false, text: e.message }); }
        finally { setBusySite(null); }
      }
      async function toggleWindow(sid) {
        setBusySite(sid); setResult(sid, null);
        try {
          const isOpen = !!winSites[sid]?.open;
          const r = await api('window', { siteId: sid, action: isOpen ? 'close' : 'open' }, 120000);
          if (r?.alreadyOpen) setResult(sid, { ok: true, text: '窗口已存在——已聚焦弹到最前' });
          else setResult(sid, { ok: true, text: isOpen ? '独立窗口已收起，回到无头运行' : '独立窗口已打开（与桥共用登录态）' });
          await refreshWins();
          await onRefresh?.();
        } catch (e) { setResult(sid, { ok: false, text: e.message }); }
        finally { setBusySite(null); }
      }
      if (!list.length) return h('p', { className: 'hwb-hint' }, '站点状态加载中…（中继未启动时不可用）');
      return h('div', { className: 'hwb-sites' },
        list.map(s => h('div', { key: s.siteId, className: 'hwb-site-block' },
          h('div', { className: 'hwb-site-row' + (busySite === s.siteId || s.busy ? ' busy' : '') },
            h('span', { className: 'hwb-site-name' }, siteName(s.siteId)),
            h('span', {
              className: 'hwb-site-state ' + (s.loggedIn === true ? 'ok' : s.loggedIn === false ? 'bad' : 'idle'),
              title: s.loggedInCached ? '来自重启前的核验缓存（登录态存在 profile 里）；点「登录」或「检测」即时核验' : undefined,
            },
              s.loggedIn === true ? (s.loggedInCached ? '已登录(缓存)' : '已登录') : s.loggedIn === false ? '未登录' : '待检查'),
            h('button', { disabled: busySite !== null, onClick: () => doLogin(s.siteId) },
              busySite === s.siteId ? '等待登录完成…' : s.loggedIn === true ? '更换账户' : '登录'),
            h('button', {
              disabled: busySite !== null,
              title: '在独立窗口中打开该站点真实网页（可登录、可聊天，与桥共用登录态）',
              onClick: () => toggleWindow(s.siteId),
            }, '独立窗口')),
          results[s.siteId] && h('p', { className: 'hwb-hint indent', role: 'status' },
            (results[s.siteId].ok ? '✓ ' : '✗ ') + siteName(s.siteId) + '：' + results[s.siteId].text))),
        h('p', { className: 'hwb-hint indent' },
          '登录会打开真实 Edge 窗口，请在窗口内完成一次性登录（扫码/验证码/密码均可），检测到成功后自动切回无头运行。'
          + '各站点登录态分开保存在各自 profile 里，互不串号；账户失效时在这里「更换账户」即可。'));
    }

    function Settings() {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState('');
      const [pending, setPending] = React.useState(false);
      const [models, setModels] = React.useState(null);
      const [defaultModel, setDefaultModel] = React.useState('');
      const [modelSaved, setModelSaved] = React.useState('');
      const [modelNotice, setModelNotice] = React.useState('');
      const [thinkMode, setThinkMode] = React.useState('auto');
      const [thinkSaved, setThinkSaved] = React.useState('auto');
      const [thinkNotice, setThinkNotice] = React.useState('');
      const [subAgentMode, setSubAgentMode] = React.useState('own');
      const [subAgentSaved, setSubAgentSaved] = React.useState('own');
      const [subAgentNotice, setSubAgentNotice] = React.useState('');
      const refresh = () => api('status').then(s => setStatus(s)).catch(() => {});
      React.useEffect(() => {
        let alive = true;
        const poll = () => api('status').then(s => { if (alive) setStatus(s); }).catch(e => { if (alive) setError(e.message); });
        poll();
        api('models').then(m => { if (alive) setModels(m.models || []); }).catch(() => {});
        api('settings').then(s => {
          if (!alive) return;
          setDefaultModel(s.defaultModel || ''); setModelSaved(s.defaultModel || '');
          setThinkMode(['on', 'off', 'auto'].includes(s.thinkMode) ? s.thinkMode : 'auto');
          setThinkSaved(['on', 'off', 'auto'].includes(s.thinkMode) ? s.thinkMode : 'auto');
          setSubAgentMode(s.subAgentMode === 'share' ? 'share' : 'own');
          setSubAgentSaved(s.subAgentMode === 'share' ? 'share' : 'own');
        }).catch(() => {});
        const timer = setInterval(poll, 4000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      async function action(name, body) {
        setPending(true); setError('');
        try { await api(name, body); await refresh(); }
        catch (e) { setError(e.message); }
        finally { setPending(false); }
      }
      async function saveSetting(key, value, onDone) {
        setPending(true); setError('');
        try {
          const r = await api('settings', { [key]: value });
          onDone(r);
        } catch (e) { setError(e.message); }
        finally { setPending(false); }
      }
      const relay = status?.relay;
      const driver = status?.driver;
      const sites = driver?.sites;
      const consent = relay?.consent === true;
      const metrics = relay?.metrics;
      const currentModelName = m => models?.find(x => x.id === m)?.name || MODEL_NAMES[m] || m;
      // 「深度思考」三态开关仅对 DeepSeek 站点有意义——只有默认模型落在
      // deepseek 站点时才展示（其余站点 pill 契约未真机校准，不硬造开关）
      const defaultSiteId = (defaultModel || '').split(':')[0];
      const showThink = defaultSiteId === 'deepseek';
      return h('section', { className: 'hwb-settings' },
        h('h2', null, 'Harness Web Bridge'),
        h('p', { className: 'hwb-lead' }, '用已登录的 Edge 网页驱动内容服务：右侧直接显示可操作的真实网页，模型生成与工具调用均以网页原生流程执行，与 API 调用同源。'),

        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '账户与登录管理'),
          h(SiteAccounts, { sites, onRefresh: refresh })),

        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '模型管理'),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '默认模型'),
            h('div', { className: 'hwb-row-main' },
              h(ModelSelect, { models, value: defaultModel, disabled: pending, onChange: setDefaultModel }),
              h('button', { disabled: pending || !defaultModel || defaultModel === modelSaved, onClick: () => saveSetting('defaultModel', defaultModel, r => { setDefaultModel(r.defaultModel || defaultModel); setModelSaved(r.defaultModel || defaultModel); setModelNotice('已保存：新建会话未显式选模型时将使用该模型。'); }) }, '保存'),
              modelNotice && h('span', { className: 'hwb-hint' }, modelNotice))),
          showThink && h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '深度思考'),
            h('div', { className: 'hwb-row-main' },
              h('select', { className: 'hwb-model-select', value: thinkMode, disabled: pending, onChange: e => setThinkMode(e.target.value) },
                h('option', { value: 'auto' }, '自动（按所选模型的默认思考行为）'),
                h('option', { value: 'on' }, '始终开启（强制打开网页「深度思考」开关）'),
                h('option', { value: 'off' }, '始终关闭（追求速度）')),
              h('button', { disabled: pending || thinkMode === thinkSaved, onClick: () => saveSetting('thinkMode', thinkMode, r => { const v = ['on', 'off', 'auto'].includes(r.thinkMode) ? r.thinkMode : thinkMode; setThinkMode(v); setThinkSaved(v); setThinkNotice('已保存。下次生成起生效。'); }) }, '保存'),
              thinkNotice && h('span', { className: 'hwb-hint' }, thinkNotice))),
          h('p', { className: 'hwb-hint indent' }, '当前网页模型：' + (driver?.selectedModel ? currentModelName(driver.selectedModel) : '未选择（按默认模型）'))),

        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '连接'),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '网页服务'),
            h('div', { className: 'hwb-row-main' }, h('span', null, relay?.running ? '中继已连接' : '未启动'))),
          h('div', { className: 'hwb-row' },
            h('label', { className: 'hwb-consent' },
              h('input', {
                type: 'checkbox', checked: consent, disabled: pending,
                onChange: e => action('consent', { accepted: e.target.checked }),
              }),
              h('span', null, '启用网页自动化')),
            h('span', { className: 'hwb-hint' },
              consent
                ? (relay?.consentPersistent ? '已永久保存到本机：首次授权一次即可长期使用' : '当前运行有效，配置目录不可写入')
                : '首次使用时请勾选授权一次；关闭后所有网页调用都会被拒绝。'))),

        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '速度观测（最近一次生成）'),
          h('div', { className: 'hwb-row' }, h('div', { className: 'hwb-row-main' }, h(Metrics, { metrics })))),

        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '会话与子代理'),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '子代理网页会话'),
            h('div', { className: 'hwb-row-main' },
              h('select', { className: 'hwb-model-select', value: subAgentMode, disabled: pending, onChange: e => setSubAgentMode(e.target.value) },
                h('option', { value: 'own' }, '独立（推荐）：每个子代理自己的新网页对话'),
                h('option', { value: 'share' }, '共用：所有子代理与主会话共用一个网页对话')),
              h('button', { disabled: pending || subAgentMode === subAgentSaved, onClick: () => saveSetting('subAgentMode', subAgentMode, r => { const v = r.subAgentMode === 'share' ? 'share' : 'own'; setSubAgentMode(v); setSubAgentSaved(v); setSubAgentNotice('已保存。对之后新开的子代理生效。'); }) }, '保存'),
              subAgentNotice && h('span', { className: 'hwb-hint' }, subAgentNotice))),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '会话隔离'),
            h('div', { className: 'hwb-row-main' }, h('span', { className: 'hwb-hint' },
              (driver?.conversationCount ?? 0) + ' 个网页会话槽。子代理（如 explore/plan/通用 agent）按 agentId 自动分到'
              + '「同账号新对话」——同一账号下另开一个全新网页对话，互不污染主对话上下文；网页请求仍按队列逐个执行。')))),

        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '首轮提示词'),
          h(PresetPreview),
          h(GlobalPrompt)),
        relay?.lastError ? h('p', { role: 'alert', className: 'hwb-hint' }, '最近错误: ' + relay.lastError) : null,
        error && h('p', { role: 'alert' }, error));
    }

    function Conversation({ browserSrc }) {
      const [siteId, setSiteId] = React.useState('deepseek');
      // iframe 保活：每个访问过的站点一个 frame，全部常驻 DOM，用 display 切换。
      // 旧实现每次挂载都重设 src（?ts= 时间戳）——侧栏每开合一次就整页重载，
      // 站点应用初始化要好几秒，用户看到的就是「退出视图回去都要加载很久」。
      const [frames, setFrames] = React.useState({});   // siteId → { src, ready, status }
      const [connectError, setConnectError] = React.useState('');
      const [winBusy, setWinBusy] = React.useState(false);
      const [winOpen, setWinOpen] = React.useState({}); // siteId → window 聚合
      // 0.9.9 的 winOpen 是「开着的站点的 siteId（字符串或 null）」，渲染读的是
      // `winOpen === siteId`。0.11.0 把渲染改成多站点聚合 `winOpen[siteId]?.open`
      // 并把初始值换成 {}，却漏改了这里——winState() 仍把 openSite（字符串/null）
      // 塞进同一个 state。于是「没有独立窗口」（null）时渲染执行 null['deepseek']
      // 直接抛 TypeError，整块右栏 React 树崩掉 → 面板全白。
      // 现在统一成 windows 聚合对象，state 里永远是对象，读取再加一层防御。
      const winState = () => api('window').then(w => {
        const windows = (w?.windows && typeof w.windows === 'object') ? w.windows : {};
        setWinOpen(windows);
        return { windows, siteId: w?.siteId ?? null };
      }).catch(() => null);
      React.useEffect(() => {
        let alive = true;
        winState().then(w => { const open = Object.keys(w?.windows || {}); if (alive && open.length && !open.includes(siteId)) setSiteId(open[0]); });
        const poll = setInterval(() => winState(), 5000);
        return () => { alive = false; clearInterval(poll); };
      }, []);
      const ensureFrame = React.useCallback((sid, force) => {
        setFrames(prev => {
          if (prev[sid] && !force) return prev;   // 已有存活 frame：直接复用，不重载
          return { ...prev, [sid]: { src: browserSrc + '__webcode/site/' + sid + '/?ts=' + Date.now(), ready: false, status: null } };
        });
      }, [browserSrc]);
      React.useEffect(() => {
        let alive = true;
        setConnectError('');
        if (!frames[siteId]) {
          api('connect', { siteId }, 90000).then(() => { if (alive) ensureFrame(siteId); })
            .catch(e => { if (alive) setConnectError(e.message); });
        }
        return () => { alive = false; };
      }, [siteId, frames, ensureFrame]);
      async function toggleWindow() {
        setWinBusy(true); setConnectError('');
        try {
          const target = winIsOpen(siteId) ? 'close' : 'open';
          await api('window', { siteId, action: target });
          await winState();
        } catch (e) { setConnectError(e.message); }
        finally { setWinBusy(false); }
      }
      // 官方右侧栏没有刷新入口；强制重载 = 换时间戳 src 重新挂该站点的 iframe。
      function reloadFrame() {
        setConnectError('');
        ensureFrame(siteId, true);
      }
      const active = frames[siteId];
      const frameBlocked = Number(active?.status) >= 400;
      // 渲染期永远按「对象」读：任何异步/旧值形态（字符串、null）都不得让整块
      // 右栏抛错变白屏——独立窗口按钮只是面板里的一个控件，它坏了也不该拖垮面板。
      const winOf = sid => (winOpen && typeof winOpen === 'object' ? winOpen[sid] : null);
      const winIsOpen = sid => winOf(sid)?.open === true;
      return h('div', { className: 'hwb-conversation' },
        h('div', { className: 'hwb-sitebar', role: 'tablist', 'aria-label': '内容服务站点' },
          h('div', { className: 'hwb-sitebar-tabs' },
            Object.entries(SITE_NAMES).map(([sid, name]) => h('button', {
              key: sid, role: 'tab', 'aria-selected': sid === siteId, className: sid === siteId ? 'active' : '',
              onClick: () => setSiteId(sid),
            }, name))),
          h('button', {
            className: 'hwb-icon-btn', title: '刷新右侧网页（重新加载镜像页面）',
            'aria-label': '刷新右侧网页', onClick: reloadFrame,
          }, '\u21bb'),
          h('button', {
            className: 'hwb-win-btn' + (winIsOpen(siteId) ? ' open' : ''), disabled: winBusy,
            title: winIsOpen(siteId) ? '收起该站点的独立窗口（回到无头运行）' : '在独立窗口中打开真实网页（已开的窗口会聚焦弹到最前，不会覆盖）',
            'aria-pressed': winIsOpen(siteId), onClick: toggleWindow,
          }, winBusy ? '窗口切换中…' : winIsOpen(siteId) ? '✓ 已开独立窗口 · 点击收回' : '⧉ 独立窗口打开')),
        // 两条错误只显示一条：镜像被站点拦截时，连接类错误没有信息量，不重复刷屏。
        connectError && !frameBlocked && h('div', { className: 'hwb-error', role: 'status' },
          '浏览器视图未能连接：' + connectError + ' ',
          h('button', { className: 'hwb-retry', onClick: reloadFrame }, '重试')),
        frameBlocked && h('div', { className: 'hwb-error', role: 'status' },
          siteName(siteId) + ' 拦截了内嵌镜像（HTTP ' + active.status + '），与登录态无关——请用「独立窗口」打开；若仍未登录，请先在上方完成登录。',
          h('button', { className: 'hwb-retry', onClick: toggleWindow }, '改用独立窗口打开'),
          h('button', { className: 'hwb-retry', onClick: reloadFrame }, '重试')),
        // 所有已访问站点的 frame 常驻 DOM（隐藏保活），只显示当前站点的。
        Object.entries(frames).map(([sid, f]) => h('iframe', {
          key: sid,
          className: 'hwb-browser-frame',
          style: sid === siteId ? null : { display: 'none' },
          src: f.src,
          title: siteName(sid) + ' 网页对话',
          referrerPolicy: 'no-referrer',
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads',
          onLoad: (e) => {
            let status = null;
            try { status = Number(e?.target?.contentWindow?.location?.status) || null; } catch { status = null; }
            setFrames(prev => {
              const cur = prev[sid];
              if (!cur) return prev;
              return { ...prev, [sid]: { ...cur, ready: true, status } };
            });
          },
          onError: () => setConnectError('网页代理加载失败，请确认中继服务已启动'),
        })),
        active && !active.ready && !connectError && h('div', { className: 'hwb-frame-status' }, '正在加载 ' + siteName(siteId) + ' 网页…（加载后可直接在右侧操作，生成任务由网页原生执行）'));
    }

    function apply(ctx) {
      const style = document.createElement('style');
      style.textContent = '.hwb-settings{max-width:760px;padding:20px;color:inherit;display:flex;flex-direction:column;gap:14px}.hwb-settings h2{font-size:20px;letter-spacing:0;margin:0 0 2px}.hwb-lead{font-size:12px;opacity:.72;margin:0;line-height:1.6}.hwb-card{border:1px solid #8884;border-radius:10px;padding:2px 16px 8px;background:transparent}.hwb-group{font-size:12px;font-weight:600;opacity:.72;margin:12px 0 0}.hwb-group.first{margin-top:12px}.hwb-row{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;padding:11px 0;border-bottom:1px solid #8883}.hwb-row:last-child{border-bottom:0}.hwb-row-label{flex:0 0 128px;min-width:96px;font-size:13px;padding-top:2px}.hwb-row-main{flex:1;min-width:240px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.hwb-row button{padding:5px 12px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.hwb-consent{display:flex;align-items:center;gap:8px}.hwb-hint{font-size:12px;opacity:.72;margin:4px 0 0;line-height:1.5}.hwb-hint.indent{margin:6px 0 8px 0}.hwb-model-select{min-width:220px;max-width:340px;padding:6px 8px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit}.hwb-sites{display:flex;flex-direction:column}.hwb-site-block{padding:6px 0;border-bottom:1px solid #8883}.hwb-site-block:last-of-type{border-bottom:0}.hwb-site-row{display:flex;align-items:center;gap:12px;padding:4px 0}.hwb-site-row.busy{opacity:.55}.hwb-site-name{flex:1;font-size:13px}.hwb-site-state{font-size:12px;padding:1px 8px;border-radius:10px;border:1px solid #8885}.hwb-site-state.ok{color:#2e7d32;border-color:#2e7d3280}.hwb-site-state.bad{color:#93443e;border-color:#93443e80}.hwb-site-row button{padding:4px 12px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.hwb-metrics{display:flex;flex-direction:column;gap:6px;width:100%}.hwb-metrics-head{font-size:12px;margin-bottom:2px}.hwb-bar-row{display:flex;align-items:center;gap:12px}.hwb-bar-label{flex:0 0 76px;font-size:12px;opacity:.85}.hwb-bar-track{flex:1;min-width:120px;height:8px;border-radius:4px;background:#8883;overflow:hidden}.hwb-bar-fill{display:block;height:100%;border-radius:4px;background:#8a94a6;transition:width .4s ease}.hwb-bar-fill.ok{background:#2e7d32}.hwb-bar-value{flex:0 0 92px;font-size:12px;text-align:right;font-variant-numeric:tabular-nums}.hwb-badge{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;border:1px solid #8885;margin-right:8px}.hwb-badge.measured{color:#2e7d32;border-color:#2e7d3280}.hwb-preset{padding:12px 0;border-bottom:1px solid #8883}.hwb-preset:last-child{border-bottom:0}.hwb-preset summary{cursor:pointer;font-size:13px}.hwb-import{display:flex;flex-direction:column;gap:8px}.hwb-import select{padding:6px 8px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit}.hwb-import-row{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #8883}.hwb-import-title{flex:1;font-size:13px}.hwb-prompt-input{width:100%;min-height:80px;padding:8px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit;font:inherit;line-height:1.5;resize:vertical}.hwb-preset pre{max-height:280px;overflow:auto;font-size:12px;line-height:1.5;padding:10px;border:1px solid #8883;border-radius:6px;white-space:pre-wrap;word-break:break-word}.hwb-conversation{height:100%;width:100%;min-height:0;overflow:hidden;background:#fff;position:relative;display:flex;flex-direction:column}.hwb-retry{padding:4px 10px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.hwb-error{padding:8px;font-size:12px;color:#93443e;background:#fff}.hwb-sitebar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #8883;background:var(--ds-bg,#fff)}.hwb-sitebar-tabs{display:flex;gap:6px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:thin;padding-bottom:1px}.hwb-sitebar button{padding:3px 10px;border:1px solid #8885;border-radius:999px;background:transparent;color:inherit;cursor:pointer;font-size:12px;white-space:nowrap;transition:background .15s,color .15s,border-color .15s}.hwb-sitebar button:hover{border-color:#8888;background:#8881}.hwb-sitebar button.active{background:#2563eb;color:#fff;border-color:#2563eb}.hwb-icon-btn{flex:0 0 auto;align-self:center;width:26px;height:26px;display:grid;place-items:center;padding:0;border:1px solid #8885;border-radius:7px;background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1}.hwb-icon-btn:hover{background:#8882}.hwb-win-btn{flex:0 0 auto;align-self:center;padding:4px 10px;border:1px solid #2563eb80;border-radius:8px;background:#2563eb0d;color:#2563eb;cursor:pointer;font-size:12px;white-space:nowrap;transition:background .15s}.hwb-win-btn:hover{background:#2563eb1a}.hwb-win-btn.open{background:#2563eb;color:#fff}.hwb-win-btn:disabled{opacity:.5;cursor:default}.hwb-sitebar-tabs::-webkit-scrollbar{height:4px}.hwb-sitebar-tabs::-webkit-scrollbar-thumb{background:#8884;border-radius:2px}';
      document.head.appendChild(style);
      const browserStyle = document.createElement('style');
      browserStyle.textContent = '.hwb-browser-frame{display:block;width:100%;height:100%;min-height:0;border:0;background:#fff}.hwb-frame-status{position:absolute;inset:0;display:grid;place-items:center;background:#fff;color:#7a8494;font-size:12px;pointer-events:none}';
      document.head.appendChild(browserStyle);
      const cornerStyle = document.createElement('style');
      cornerStyle.textContent = '.hwb-corner-btn{width:28px;height:28px;display:grid;place-items:center;border:1px solid #8884;border-radius:7px;background:transparent;color:inherit;cursor:pointer;padding:0}.hwb-corner-btn:hover{background:#8882}';
      document.head.appendChild(cornerStyle);
      const disposers = [() => style.remove(), () => browserStyle.remove(), () => cornerStyle.remove()];
      const warn = (what, e) => console.warn('[webcode-bridge] ' + what + ' failed:', e && e.message ? e.message : e);

      // ---- 设置页（真实需求重构：登录管理前置、无历史导入） ------------
      try {
        const off = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'webcode', order: 110,
          label: () => '网页桥接', inject: () => ({}),
        }, Settings));
        if (typeof off === 'function') disposers.push(off);
      } catch (e) { warn('settings section', e); }

      // ---- 官方右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right）--------
      const TAB_ID = 'dsh-webcode-bridge';
      const TAB_KIND = 'webcode-bridge';
      const WebcodeBody = () => h(Conversation, { browserSrc: relayBase + '/' });

      try {
        const offType = ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => 'Web Bridge',
          guide: [{
            order: 55,
            title: () => 'Web Bridge',
            description: () => '内容服务真实网页会话（已登录站点直接可用；生成与工具调用走网页原生流程）',
          }],
        });
        if (typeof offType === 'function') disposers.push(offType);
      } catch (e) { warn('sidebarRightTabs.register', e); }

      try {
        const offBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: TAB_ID,
        }, WebcodeBody));
        if (typeof offBody === 'function') disposers.push(offBody);
      } catch (e) { warn('pane.tab body', e); }

      // ---- 会话头角落按钮：展开/收起右侧栏 ------------------------------
      try {
        const CornerButton = () => h('button', {
          className: 'hwb-corner-btn', type: 'button',
          title: '打开 Web Bridge 网页会话（右侧栏）',
          'aria-label': '打开 Web Bridge 网页会话',
          onClick: () => { try { ctx.sidebarRight.toggleExpanded(); } catch (_) {} },
        }, icon(16));
        const offCorner = ctx.slots.inject('conversation.session.header.corner', () => ctx.slots.register({
          name: 'conversation.session.header.corner',
        }, CornerButton));
        if (typeof offCorner === 'function') disposers.push(offCorner);
      } catch (e) { warn('header corner button', e); }

      return () => disposers.reverse().forEach(d => { try { d(); } catch (_) {} });
    }
    const exports = { name: 'webcode-bridge-client', inject, apply };
    if (module) module.exports = exports;
    return exports;
  },
});
