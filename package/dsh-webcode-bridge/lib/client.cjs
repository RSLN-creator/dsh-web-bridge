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
    // 每个站点一个独立源：<siteId>.localhost:<port>。
    // 站点在根路径上被镜像，pathname 与真实站点逐字一致——SPA router 基线、
    // 根相对资源、history 路由全部自然正确（详见 lib/index.js 的路由注释）。
    // 旧路径形态 /__webcode/site/<sid>/ 仍在服务端保留兼容，但 UI 一律用子域。
    // 少数站点**必须**挂在中继根上：DeepSeek 前端校验宿主名，
    // `deepseek.localhost` 会触发 `Unknown hostname` → #root 永远空白
    //（真机 2026-09-13）。它本来就是中继的默认站点，根挂载天然正确。
    // 站点侧声明见 providers.js 的 mountAtRelayRoot。
    const ROOT_MOUNTED = { deepseek: true };
    const siteBase = sid => (ROOT_MOUNTED[sid] ? relayBase + '/' : 'http://' + sid + '.localhost:' + RELAY_PORT + '/');
    const icon = size => h(IconCodeOutline16, { size });

    // ---- 控制面调用 ----------------------------------------------------------
    // 0.12.9 的 bug（真机 2026-09-13 取证）：这里在判断 res.ok **之前**就
    // `await response.json()`。后端因为漏挂载路由回了一个 405 + 空 body，
    // JSON.parse 于是抛 “unexpected end of JSON data at line 1 column 1”，
    // 把真实原因（405 / 路由不存在）整个吞掉，面板上每个「检测」都只显示这
    // 一句无意义的解析错误。
    //
    // 现在：先读文本，只有 content-type 是 JSON 才尝试解析；解析失败也不抛，
    // 而是把 HTTP 状态与 body 片段作为错误信息带出去。
    async function request(action, body, timeoutMs) {
      const response = await fetch('/__webcode/' + action, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text().catch(() => '');
      const ctype = response.headers.get('content-type') || '';
      let data = null;
      let parseError = '';
      if (text && ctype.includes('json')) {
        try { data = JSON.parse(text); } catch (e) { parseError = e.message; }
      }
      const reason = (data && (data.error || data.message)) || parseError
        || (text ? text.slice(0, 200) : '')
        || (response.ok ? '响应为空' : 'HTTP ' + response.status);
      const failure = response.ok && data && data.ok !== false
        ? null
        : 'HTTP ' + response.status + (response.statusText ? ' ' + response.statusText : '') + '：' + reason;
      return { response, data, text, failure, ctype };
    }

    /** 抛异常的调用：只关心「成功拿到结构化结果」或「为什么失败」。 */
    async function api(action, body, timeoutMs = 30000) {
      const r = await request(action, body, timeoutMs);
      if (r.failure) throw new Error(r.failure);
      if (r.data === null) throw new Error('HTTP ' + r.response.status + '：响应不是 JSON（' + r.ctype + '）');
      return r.data;
    }

    /** 不抛异常的调用：需要把失败原因显示在行内、而不是让整块 UI 报错时用。 */
    async function apiSoft(action, body, timeoutMs = 30000) {
      try {
        const r = await request(action, body, timeoutMs);
        if (r.failure) return { ok: false, error: r.failure, data: r.data };
        return { ok: true, data: r.data || {} };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    }

    const MODEL_NAMES = { deepseek: 'DeepSeek' };
    // 站点显示名 + 多站点模型目录（打开时从 /__webcode/models 拉取）
    const SITE_NAMES = { deepseek: 'DeepSeek', glm: '智谱清言', chatgpt: 'ChatGPT', kimi: 'Kimi', qwen: '通义千问', doubao: '豆包', grok: 'Grok', claude: 'Claude', gemini: 'Gemini', zai: 'Z.ai (GLM 海外版)' };
    const siteName = sid => SITE_NAMES[sid] || sid;

    // ---- 登录判定依据的人话翻译 ----------------------------------------------
    // 后端一直在 status 里给 loginBasis / loginCheckedAt，但 0.12.9 的 UI 把它
    // 丢了，于是「未登录」看起来像凭空断言。这里把它变成可判断的依据说明。
    const LOGIN_BASIS_TEXT = {
      'probe-bad': '命中站点未登录特征',
      'probe-ok': '命中站点登录特征',
      'probe-fallback': '站点登录特征未命中，回退输入框判定',
      'input-fallback': '按输入框存在与否推断（该站点未声明登录特征）',
      stale: '旧版本结论，已被忽略',
    };
    function basisText(s) {
      const basis = LOGIN_BASIS_TEXT[s?.loginBasis] || '尚未核验';
      const when = s?.loginCheckedAt ? new Date(s.loginCheckedAt).toLocaleString() : '';
      const cached = s?.loggedInCached ? '（来自重启前的核验缓存，登录态实际存在 profile 里）' : '';
      return '判定依据：' + basis + cached + (when ? ' · ' + when + ' 核验' : '');
    }

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

    /**
     * 「发送前等待」这条的注解文字（0.14.0）。
     *
     * 用户报「等待时间好像不是按我设置的来」，其中一半是**看不出发生了什么**：
     * 设置是 send-to-send 语义（两次*发送*之间的最小间隔），上一轮跑得久时本轮
     * 无需再等，旧界面在这种情况下干脆不显示这一条。这里把三个数字摊开：
     * 实际等待、目标值、距上次发送的实际间隔——「没等待」也有了明确原因。
     */
    function gapNote(m) {
      const parts = [];
      if (m.gapTargetMs > 0) parts.push('目标 ' + (m.gapTargetMs >= 1000 ? (m.gapTargetMs / 1000).toFixed(1) + ' s' : m.gapTargetMs + ' ms'));
      if (m.sincePrevSendMs != null) {
        const secs = (m.sincePrevSendMs / 1000).toFixed(1) + ' s';
        parts.push(m.sendWaitMs > 0 ? '距上次发送 ' + secs : '未等待（距上次发送 ' + secs + ' 已满足）');
      }
      if (m.rateLimitRetries) parts.push('限流重试 ' + m.rateLimitRetries + ' 次');
      return parts.length ? ' · ' + parts.join(' · ') : '';
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
        // 发送前等待：**恒可核对**（0.14.0）。
        // 旧实现只在「真的等待过」时才渲染这一条，于是用户设了 10 秒间隔、而
        // 上一轮本身就跑了 20 秒（无需再等）时，界面上什么都没有——这正是
        // 「好像不是按我设置的来」的观感来源之一。现在只要拿到了目标值或实测
        // 间隔就显示，并把「没等待」的原因写清楚。
        (metrics.gapTargetMs > 0 || metrics.sendWaitMs > 0 || metrics.rateLimitRetries > 0 || metrics.sincePrevSendMs != null) && h(Bar, {
          label: '发送前等待', value: metrics.sendWaitMs,
          text: ms(metrics.sendWaitMs) + gapNote(metrics),
          max: BAR_MAX_MS, tone: 'ok',
        }),
        h(Bar, { label: '首字延迟', value: metrics.firstTokenMs, text: ms(metrics.firstTokenMs), max: BAR_MAX_MS }),
        h(Bar, { label: '可观测思考', value: metrics.thinkingMs, text: metrics.thinkingMs == null ? '网页未提供' : ms(metrics.thinkingMs), max: BAR_MAX_MS }),
        h(Bar, { label: '正文输出', value: metrics.responseMs, text: ms(metrics.responseMs), max: BAR_MAX_MS }),
        h(Bar, { label: '正文速度', value: metrics.responseTps, text: tpsText, max: BAR_MAX_TPS, tone: 'ok' }),
        h(Bar, { label: '总耗时', value: metrics.durationMs, text: ms(metrics.durationMs), max: BAR_MAX_MS }));
    }

    /**
     * 输入框底下的「等待发送」速览（0.14.4）。
     *
     * 用户要求：输入界面框底下增加速度，含「本次会话的总等待发送消息时间」，
     * 与官方格式类似。官方在同一个槽位（`conversation.composer.dock`）放的是
     * 一行状态药丸（ui-chat 的 StatsPills、ui-goal 的 GoalDock），因此这里也走
     * 同一个规范入口，而不是自绘浮层——自绘会与宿主重排打架。
     *
     * 文案由**服务端**算好（/__webcode/wait-stats 的 `line` 字段）：本文件是单
     * 文件 bundle，import 不到 lib/wait-stats.js。若在这里再写一份时长格式化，
     * 这条与设置页的「累计」迟早会长得不一样，用户就无法信任任何一个数。
     *
     * 数据不足时服务端回 null，这里**整行不渲染**——新会话第一条消息之前不该
     * 看到一行 `0 ms`。
     *
     * @param {{sessionId?: string}} owner 由 inject 注入的会话 id
     */
    function WaitLine(owner) {
      const sessionId = owner?.sessionId || null;
      const [line, setLine] = React.useState('');
      React.useEffect(() => {
        if (!sessionId) { setLine(''); return () => {}; }
        let alive = true;
        const pull = () => api('wait-stats', { sessionId })
          .then(r => { if (alive) setLine(typeof r?.line === 'string' ? r.line : ''); })
          .catch(() => { /* 中继未起时静默：这条是附加信息，不该刷错误 */ });
        pull();
        // 10 秒一次足够：这个数只在本轮结束后才变，且是本地回环请求。
        const timer = setInterval(pull, 10000);
        return () => { alive = false; clearInterval(timer); };
      }, [sessionId]);
      if (!line) return null;
      return h('div', { className: 'hwb-waitline', role: 'status' }, line);
    }

    /**
     * 首轮提示词面板（0.14.0）。
     *
     * 用户原话：「设置界面提示词应该默认就显示，首轮提示词又不会变？有多的适配
     * 就可选择框选择列出」。两处旧实现都错了：
     *   • 折叠在 <details> 里，不点开什么也看不到；
     *   • 只显示「最近一次真实发送过的」那一份——全新会话永远是空的，
     *     且 glm 与其它站点是两套协议，页面上没有任何地方能看到这种差异。
     *
     * 现在：默认渲染。模板由 GET prompt-variants 现算（与真正发出去的那一份
     * 同一个 serializeFirstTurn），下拉切换适配分支（默认标签形状 / glm 代码块
     * 形状），并标出本会话实际走的是哪一支。模板本身**只读**——它由桥按会话的
     * 工具清单生成，可编辑的只有下方的「全局指令」。
     */
    function PromptPanel({ onSaved }) {
      const [variants, setVariants] = React.useState(null);
      const [activeId, setActiveId] = React.useState('');
      const [chosen, setChosen] = React.useState('');
      const [meta, setMeta] = React.useState(null);
      const [error, setError] = React.useState('');
      const load = React.useCallback(() => {
        api('prompt-variants').then(r => {
          setVariants(r.variants || []);
          setMeta({ toolsSource: r.toolsSource, active: r.active, extraPrompt: r.extraPrompt });
          // 默认展示「本会话真正会用的那一支」——那才是用户想核对的东西。
          const want = r.active?.variantId || (r.variants?.[0]?.id ?? '');
          setActiveId(want); setChosen(c => c || want);
          setError('');
        }).catch(e => setError(e.message));
      }, []);
      React.useEffect(() => { load(); }, [load]);
      if (error) return h('p', { role: 'alert', className: 'hwb-hint' }, '首轮提示词加载失败：' + error);
      if (variants === null) return h('p', { className: 'hwb-hint' }, '加载首轮提示词…');
      const hit = variants.find(v => v.id === chosen) || variants[0];
      const activeVariant = variants.find(v => v.id === activeId);
      return h('div', { className: 'hwb-import' },
        h('div', { className: 'hwb-row' },
          h('span', { className: 'hwb-row-label' }, '适配'),
          h('div', { className: 'hwb-row-main' },
            variants.length > 1
              ? h('select', { className: 'hwb-model-select', value: hit.id, onChange: e => setChosen(e.target.value) },
                variants.map(v => h('option', { key: v.id, value: v.id },
                  v.label + (v.id === activeId ? ' · 本会话正在用' : ''))))
              : h('span', { className: 'hwb-hint' }, hit.label))),
        h('p', { className: 'hwb-hint' }, hit.note),
        h('p', { className: 'hwb-hint' },
          '模板由桥按会话的工具清单自动生成，是**只读**的；可编辑的只有下方的「全局指令」。'
          + (meta?.toolsSource === 'placeholder'
            ? '当前工具清单是占位示例——发送第一条消息后会自动换成该会话的真实清单。'
            : '')
          + (activeVariant ? '本会话最近一次实际使用的是「' + activeVariant.label + '」。' : '')),
        h('pre', null, hit.text),
        meta?.active?.tools?.length
          ? h('p', { className: 'hwb-hint' }, '本会话工具：' + meta.active.tools.join(', '))
          : null,
        h('p', { className: 'hwb-hint' }, '增量轮再教学提示（每 5 个工具结果重贴一次，立场必须与首轮一致）：' + hit.trainNote));
    }

    function GlobalPrompt({ onSaved }) {
      const [value, setValue] = React.useState('');
      const [saved, setSaved] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [error, setError] = React.useState('');
      React.useEffect(() => {
        let alive = true;
        api('settings').then(s => { if (alive) { setValue(s.extraPrompt || ''); setSaved(s.extraPrompt || ''); } }).catch(e => { if (alive) setError(e.message); });
        return () => { alive = false; };
      }, []);
      async function save() {
        setBusy(true); setNotice(''); setError('');
        try {
          const r = await api('settings', { extraPrompt: value });
          setSaved(r.extraPrompt || ''); setValue(r.extraPrompt || '');
          setNotice('已保存，后续每个新网页会话的首轮提示词都会包含「全局指令」。');
          onSaved?.();
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }
      return h('div', { className: 'hwb-import' },
        h('p', { className: 'hwb-hint' }, '这是**唯一可编辑**的提示词部分：追加一段「[全局指令]」注入每个新网页会话的首条消息，'
          + '例如："始终用中文回答；执行任何操作前先说明依据"。保存后上方的模板会立刻反映它。'),
        h('textarea', {
          className: 'hwb-prompt-input', value, rows: 5, maxLength: 4000,
          placeholder: '例如：始终保持工具调用格式；回答简洁；先读文件再下结论。',
          onChange: e => setValue(e.target.value),
        }),
        h('div', { className: 'hwb-row' },
          h('button', { disabled: busy || value === saved, onClick: save }, busy ? '保存中…' : '保存全局指令'),
          notice && h('span', { className: 'hwb-hint' }, notice)),
        error && h('p', { role: 'alert', className: 'hwb-hint' }, error));
    }

    /** 首轮提示词整块（只读模板 + 变体下拉 + 可编辑全局指令），默认渲染。 */
    function PromptSection() {
      const [nonce, setNonce] = React.useState(0);
      return h('div', null,
        h(PromptPanel, { key: 'p' + nonce }),
        h(GlobalPrompt, { key: 'g' + nonce, onSaved: () => setNonce(n => n + 1) }));
    }

    // 按站点分组的模型下拉选项：从桥的 /__webcode/models 取全站点目录
    function ModelSelect({ models, value, onChange, disabled }) {
      if (!models) return h('select', { disabled: true }, h('option', null, '加载模型目录…'));
      const groups = new Map();
      // 过滤兼容别名（0.14.0）：`deepseek-web` 与 `deepseek:deepseek` 的显示名
      // 逐字相同（都是 `deepseek/deepseek`），照单渲染就是两行一模一样的选项。
      // 过滤只发生在**展示**层——别名仍然能被 resolveWebModel 解析，历史会话与
      // 旧设置的 `deepseek-web` 值照旧可用（后端 listAllModels 也照旧返回它）。
      // 这里是浏览器侧 bundle，无法 import 主机的 providers.js，因此字面量不得
      // 不重复一份；两处一致由 test/model-labels.test.mjs 钉住（它同时读
      // providers.MODEL_ALIAS_IDS 与本文件，不一致即失败）。
      const aliasIds = new Set(['deepseek-web']);
      for (const m of models) {
        if (aliasIds.has(m.id)) continue;
        if (!groups.has(m.siteId)) groups.set(m.siteId, []);
        groups.get(m.siteId).push(m);
      }
      // 当前值恰好是别名时（历史设置）：补一条选项，否则 select 会显示空。
      const aliasHit = models.find(m => aliasIds.has(m.id) && m.id === value);
      return h('select', { className: 'hwb-model-select', value: value || '', disabled, onChange: e => onChange(e.target.value) },
        aliasHit ? h('option', { key: aliasHit.id, value: aliasHit.id }, aliasHit.name + '（兼容别名）') : null,
        [...groups.entries()].map(([sid, list]) => h('optgroup', { key: sid, label: siteName(sid) },
          // 0.14.0 起 m.name 自带站点短键（`z.ai/glm-5.3`），这里不再重复拼
          // siteName——旧写法会渲染成「Z.ai (GLM 海外版) · z.ai/glm-5.3」。
          list.map(m => h('option', { key: m.id, value: m.id },
            m.name + (m.experimental ? '（实验）' : '') + (m.thinking ? ' · 深度思考' : '') + (m.vision ? ' · 识图' : ''))))));
    }

    /**
     * 网页与模型管理的「账户」卡片：每个内容服务一行——登录状态 + 登录/换账户
     * + 独立窗口。登录等待真实结果（最长 5 分钟），成功/失败/超时都回显在本行，
     * 不再 fire-and-forget；登录窗口是真实有头 Edge，与自动化共用同一 profile。
     * onlySiteId：只渲染该站点一行（子代理卡内联所选子代理站点的账户管理，
     * 与「账户与登录管理」卡片同一套状态与端点，不另起第二套真相）。
     */
    function SiteAccounts({ sites, onRefresh, onlySiteId, subHint }) {
      const [busySite, setBusySite] = React.useState(null);
      const [results, setResults] = React.useState({});
      const list = (sites && sites.length ? sites : [])
        // 保留判定依据字段：旧实现只挑 4 个字段进列表，把后端已经算好的
        // loginBasis/loginCheckedAt 丢掉了——「未登录」于是看起来像凭空断言。
        .map(s => ({
          siteId: s.siteId, loggedIn: s.loggedIn, initialized: s.initialized, busy: s.busy,
          loggedInCached: s.loggedInCached === true, loginBasis: s.loginBasis || null,
          loginCheckedAt: s.loginCheckedAt || null, window: s.window || null,
        }))
        .filter(s => !onlySiteId || s.siteId === onlySiteId)
        .sort((a, b) => (a.siteId === 'deepseek' ? -1 : b.siteId === 'deepseek' ? 1 : siteName(a.siteId).localeCompare(siteName(b.siteId))));
      const setResult = (sid, r) => setResults(prev => ({ ...prev, [sid]: r }));
      const [winSites, setWinSites] = React.useState({});
      const refreshWins = () => api('window').then(w => setWinSites(w?.windows || {})).catch(() => {});
      React.useEffect(() => { refreshWins(); }, []);
      // 四个动作全部走 apiSoft：失败原因落进本行状态，绝不让整块面板崩掉。
      // （0.12.9 的 verify-login 因路由漏挂载回 405 空 body，api() 抛的是
      // JSON 解析错误而不是「HTTP 405」——原因见 lib/web-control.js 注释。）
      async function doLogin(sid) {
        setBusySite(sid); setResult(sid, null);
        // 后端要打开有头 Edge 等人工登录，超时必须放宽（等待上限 300s）。
        const r = await apiSoft('login', { siteId: sid, wait: true, timeoutMs: 300000 }, 330000);
        if (!r.ok) setResult(sid, { ok: false, text: r.error });
        else {
          const d = r.data;
          setResult(sid, {
            ok: d.loggedIn === true,
            text: (d.alreadyLoggedIn ? '登录态仍有效，无需重复登录' : (d.message || '登录完成'))
              + (d.ms ? '（' + Math.round(d.ms / 1000) + 's）' : ''),
          });
        }
        setBusySite(null);
        await onRefresh?.();
      }
      async function checkLogin(sid) {
        // 在独立窗口里登录完后点这里立即确认结果（connect 幂等且轻量）。
        setBusySite(sid); setResult(sid, null);
        const r = await apiSoft('verify-login', { siteId: sid }, 90000);
        if (!r.ok) setResult(sid, { ok: false, text: '检测失败：' + r.error });
        else {
          const d = r.data;
          // 三态：true / false / null。null 表示「该站点尚未打开过」——那是一个
          // 状态，不是失败，不该画成红色错误。
          setResult(sid, {
            ok: d.loggedIn !== false,
            tone: d.loggedIn === null ? 'idle' : null,
            text: d.loggedIn === true ? '检测完成：已检测到登录态'
              : d.loggedIn === false ? '检测完成：仍未登录（请在独立窗口完成登录后再检测）'
                : '检测完成：待检查（该站点尚未打开过——点「独立窗口」打开一次后再检测）',
          });
        }
        setBusySite(null);
        await onRefresh?.();
      }
      async function importCookies(sid) {
        // 把本机真实 Edge 的登录态导入该站点：无需在桥里再手工登录一次。
        // 桥 profile 与用户的 Edge profile 是两个独立世界，这是两者之间唯一的
        // 桥（真机 2026-09-13：桥 profile 里除 deepseek 外没有任何站点 cookie）。
        setBusySite(sid); setResult(sid, null);
        const r = await apiSoft('session-import', { siteId: sid }, 180000);
        if (!r.ok) setResult(sid, { ok: false, text: '导入失败：' + r.error });
        else {
          const d = r.data;
          setResult(sid, {
            ok: d.loggedIn === true,
            text: (d.loggedIn === true ? '已导入本机登录态'
              : '已导入，但该站点仍未登录（本机 Edge 里可能也没登录；'
                + 'Edge 128+ 的 app-bound 加密 cookie 无法跨 profile 使用，这不是桥的 bug）')
              + '；来源 ' + (d.sourceProfileDir || ''),
          });
        }
        setBusySite(null);
        await onRefresh?.();
      }
      async function toggleWindow(sid) {
        setBusySite(sid); setResult(sid, null);
        const isOpen = !!winSites[sid]?.open;
        const r = await apiSoft('window', { siteId: sid, action: isOpen ? 'close' : 'open' }, 120000);
        if (!r.ok) setResult(sid, { ok: false, text: r.error });
        else if (r.data?.alreadyOpen) setResult(sid, { ok: true, text: '窗口已存在——已聚焦弹到最前' });
        else setResult(sid, { ok: true, text: isOpen ? '独立窗口已收起，回到无头运行' : '独立窗口已打开（与桥共用登录态）' });
        setBusySite(null);
        await refreshWins();
        await onRefresh?.();
      }
      if (!list.length) return h('p', { className: 'hwb-hint' }, '站点状态加载中…（中继未启动时不可用）');
      return h('div', { className: 'hwb-sites' },
        list.map(s => h('div', { key: s.siteId, className: 'hwb-site-block' },
          h('div', { className: 'hwb-site-row' + (busySite === s.siteId || s.busy ? ' busy' : '') },
            h('span', { className: 'hwb-site-identity' },
              h('span', {
                className: 'hwb-dot ' + (s.loggedIn === true ? 'ok' : s.loggedIn === false ? 'bad' : 'idle'),
                'aria-hidden': 'true',
              }),
              h('span', { className: 'hwb-site-name' }, siteName(s.siteId))),
            h('span', {
              className: 'hwb-site-state ' + (s.loggedIn === true ? 'ok' : s.loggedIn === false ? 'bad' : 'idle'),
              title: basisText(s),
            },
              s.loggedIn === true ? (s.loggedInCached ? '已登录(缓存)' : '已登录') : s.loggedIn === false ? '未登录' : '待检查'),
            h('span', { className: 'hwb-row-actions' },
              h('button', { disabled: busySite !== null, onClick: () => doLogin(s.siteId) },
                busySite === s.siteId ? '等待登录完成…' : s.loggedIn === true ? '更换账户' : '登录'),
              h('button', { disabled: busySite !== null, onClick: () => checkLogin(s.siteId) }, '检测'),
              h('button', {
                disabled: busySite !== null,
                title: '把本机真实 Edge 里该站点的登录态导入桥 profile（读取你的 Edge cookies；无需在桥里再登录一次）',
                onClick: () => importCookies(s.siteId),
              }, '导入本机登录态'),
              h('button', {
                disabled: busySite !== null,
                title: '在独立窗口中打开该站点真实网页（可登录、可聊天，与桥共用登录态）',
                onClick: () => toggleWindow(s.siteId),
              }, '独立窗口'))),
          results[s.siteId] && h('p', {
            className: 'hwb-hint indent ' + (results[s.siteId].ok ? 'ok' : results[s.siteId].tone === 'idle' ? '' : 'bad'),
            role: 'status',
          }, (results[s.siteId].ok ? '✓ ' : '✗ ') + siteName(s.siteId) + '：' + results[s.siteId].text))),
        h('p', { className: 'hwb-hint indent' },
          subHint
            ? '子代理所选站点的账户行：登录/更换账户与其它站点同一套逻辑（真实 Edge 窗口一次性登录），登录态按站点各自持久化；与主线同站点时两者天然共享登录。'
            : '登录会打开真实 Edge 窗口，请在窗口内完成一次性登录（扫码/验证码/密码均可），检测到成功后自动切回无头运行。'
            + '各站点登录态分开保存在各自 profile 里，互不串号；账户失效时在这里「更换账户」即可。'));
    }

    /**
     * 设置页的「累计等待发送」区块（0.14.4）。
     *
     * 用户要求：设置界面新增统计**所有累计**的等待时长，并且要「简洁直观、
     * 不要沉在底部」。因此这里做成网格化的键值对（而不是一段长句），放在
     * 速度卡片顶部——速度与等待本来就是同一件事的两面。
     *
     * 数值与文案都由服务端算（/__webcode/wait-stats 的 `rows`），与输入框底下
     * 那条同源：本文件 import 不到 lib/wait-stats.js。
     */
    function WaitStats() {
      const [rows, setRows] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        const pull = () => api('wait-stats').then(r => { if (alive) setRows(Array.isArray(r?.rows) ? r.rows : []); }).catch(() => {});
        pull();
        const timer = setInterval(pull, 8000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      if (!rows || !rows.length) return null;
      return h('dl', { className: 'hwb-waitgrid' },
        rows.map(r => h('div', { key: r.label },
          h('dt', null, r.label), h('dd', null, r.value))));
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
      const [subAgentSite, setSubAgentSite] = React.useState('follow');
      const [subAgentSiteSaved, setSubAgentSiteSaved] = React.useState('follow');
      const [sendGapMs, setSendGapMs] = React.useState(0);
      const [sendGapSaved, setSendGapSaved] = React.useState(0);
      const [sendGapNotice, setSendGapNotice] = React.useState('');
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
          const subSite = s.subAgentSite && String(s.subAgentSite) !== 'follow' ? String(s.subAgentSite) : 'follow';
          setSubAgentSite(subSite); setSubAgentSiteSaved(subSite);
          const gap = Math.min(600000, Math.max(0, Math.round(Number(s.sendGapMs) || 0)));
          setSendGapMs(gap); setSendGapSaved(gap);
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
      const build = status?.build;
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
        build?.hash && h('p', { className: 'hwb-build' }, '构建指纹：' + build.hash + (build.version ? ' · v' + build.version : '')),
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
          h('p', { className: 'hwb-hint indent' }, '当前网页模型：' + (driver?.selectedModel ? currentModelName(driver.selectedModel) : '未选择（按默认模型）')),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '发送间隔'),
            h('div', { className: 'hwb-row-main' },
              (() => {
                const presets = [0, 2000, 5000, 10000, 30000, 60000];
                const gap = Math.min(600000, Math.max(0, Math.round(Number(sendGapMs) || 0)));
                return [
                  h('select', { key: 'gap-preset', className: 'hwb-model-select', style: { maxWidth: '150px' }, value: presets.includes(gap) ? String(gap) : 'custom', disabled: pending,
                    onChange: e => { if (e.target.value !== 'custom') setSendGapMs(Number(e.target.value)); } },
                    presets.map(p => h('option', { key: p, value: String(p) }, p === 0 ? '0 秒（关闭）' : (p / 1000) + ' 秒')),
                    h('option', { value: 'custom' }, '自定义…')),
                  h('input', { key: 'gap-input', type: 'number', className: 'hwb-model-select', style: { maxWidth: '130px' }, min: 0, max: 600000, step: 500, value: gap, disabled: pending,
                    placeholder: '毫秒', title: '两次向同一网站发送之间的最小间隔（毫秒）',
                    onChange: e => setSendGapMs(Math.min(600000, Math.max(0, Math.round(Number(e.target.value) || 0)))) }),
                ];
              })(),
              h('button', { disabled: pending || Math.round(Number(sendGapMs) || 0) === Math.round(Number(sendGapSaved) || 0),
                onClick: () => saveSetting('sendGapMs', Math.min(600000, Math.max(0, Math.round(Number(sendGapMs) || 0))), r => {
                  const v = Math.min(600000, Math.max(0, Math.round(Number(r.sendGapMs) || 0)));
                  setSendGapMs(v); setSendGapSaved(v); setSendGapNotice('已保存。下一次发送起生效。');
                }) }, '保存'),
              sendGapNotice && h('span', { className: 'hwb-hint' }, sendGapNotice)),
            ),
          h('p', { className: 'hwb-hint indent' }, '两次向同一网站**发送**之间的最小间隔（send-to-send）：距上一次发出不足这个值就等满，已满足则不等待。网站有「消息发送过于频繁」的滑窗限流，长任务工具循环节奏密时容易触发，设为 2–10 秒可主动避开。被限流时桥按 max(发送间隔, 10 秒) 自动退避重试最多 2 次。实际等待、目标值与「距上次发送」都在下方统计的「发送前等待」里逐项显示；该设置会落盘，**重启后第一轮同样生效**。')),

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
          h('h3', { className: 'hwb-group first' }, '速度与等待'),
          h(WaitStats),
          h('div', { className: 'hwb-row' }, h('div', { className: 'hwb-row-main' }, h(Metrics, { metrics }))),
          // 「网页端回复了但 harness 这边卡住」（0.14.0）：驱动侧现在会在网页
          // 不发 FINISHED 时按稳态收束，并把次数/最后一次原因记在 status 里。
          // 这里把它显示出来——否则用户只能看到「有时候莫名久」，无从判断桥是
          // 已经自愈过还是真的卡住。endReason 非 finished 时一并说明本轮为何收尾。
          driver?.recoveredTurns > 0 && h('p', { className: 'hwb-hint' },
            '网页流未收尾但内容已保住 ' + driver.recoveredTurns + ' 次'
            + (driver.lastRecovered
              ? '（最近：' + driver.lastRecovered.reason
                + (driver.lastRecovered.status ? '/' + driver.lastRecovered.status : '')
                + '，' + driver.lastRecovered.chars + ' 字）'
              : '')
            + (driver.lastEndReason && driver.lastEndReason !== 'finished'
              ? '；本轮收束方式：' + driver.lastEndReason
              : '')),
          driver?.lastEndReason === 'timeout' && h('p', { className: 'hwb-hint' },
            '本轮网页侧超时'
            + (driver.lastTimeoutScene
              ? '（捕获链' + (driver.lastTimeoutScene.captureAlive ? '在' : '缺失')
                + '，页面回复 ' + (driver.lastTimeoutScene.replyChars || 0) + ' 字）'
              : ''))),
          // 会话丢失（0.14.1，C-3）：原先完全静默——用户只看到「同一个会话每轮
          // 都新开一个对话」，面板上没有任何线索。现在把次数、站点与原因摊开，
          // 并说明桥的处置（重放首轮整段），让「每轮重开」变成一个可解释的行为。
          driver?.sessionLostCount > 0 && h('p', { className: 'hwb-hint' },
            '网页会话已丢失 ' + driver.sessionLostCount + ' 次（桥已按「重放首轮整段」自愈）'
            + (driver.lastSessionLost
              ? '（最近：' + (driver.lastSessionLost.siteId || '?')
                + '，' + (driver.lastSessionLost.reason === 'no-stored-session'
                  ? '本地会话槽为空' : '站点没有可用的会话地址形状')
                + '）'
              : '')
            + (driver.lastSessionLost?.reason === 'site-has-no-conversation-url-shape'
              ? '；该站点的地址栏里没有会话 id，桥无法导航回既有对话，只能整段重开'
              : '')),

        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '会话与子代理'),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '子代理网页会话'),
            h('div', { className: 'hwb-row-main' },
              h('select', { className: 'hwb-model-select', value: subAgentMode, disabled: pending, onChange: e => setSubAgentMode(e.target.value) },
                h('option', { value: 'own' }, '独立（推荐）：每个子代理自己的新网页对话'),
                h('option', { value: 'share' }, '共用：所有子代理与主会话共用一个网页对话')),
              h('button', { disabled: pending || subAgentMode === subAgentSaved, onClick: () => saveSetting('subAgentMode', subAgentMode, r => { const v = r.subAgentMode === 'share' ? 'share' : 'own'; setSubAgentMode(v); setSubAgentSaved(v); setSubAgentNotice('已保存。对之后新开的子代理生效。'); }) }, '保存'),
              subAgentNotice && h('span', { className: 'hwb-hint' }, subAgentNotice))),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '子代理站点'),
            h('div', { className: 'hwb-row-main' },
              h('select', { className: 'hwb-model-select', value: subAgentSite, disabled: pending || !models,
                onChange: e => setSubAgentSite(e.target.value) },
                h('option', { value: 'follow' }, '跟随主线站点（默认）'),
                ...(models ? [...new Set(models.map(m => String(m.id).split(':')[0]))].filter(s => s && s !== 'follow')
                  .map(s => h('option', { value: s }, s)) : [])),
              h('button', { disabled: pending || subAgentSite === subAgentSiteSaved,
                onClick: () => saveSetting('subAgentSite', subAgentSite, r => { const v = r.subAgentSite && r.subAgentSite !== 'follow' ? String(r.subAgentSite) : 'follow'; setSubAgentSite(v); setSubAgentSiteSaved(v); setSubAgentNotice('已保存。对之后新开的子代理生效。'); }) }, '保存'),
              h('button', { disabled: pending || !models || !defaultModel, title: '把子代理站点设为主线默认模型的站点',
                onClick: () => { const site = String(defaultModel).split(':')[0]; if (site) { setSubAgentSite(site); setSubAgentNotice('已选 ' + site + '，请点「保存」生效。'); } } }, '主线→子代理'),
              h('button', { disabled: pending || subAgentSite === 'follow', title: '把主线默认模型设为子代理站点的模型',
                onClick: () => { const hit = models && models.find(m => String(m.id) === subAgentSite + ':auto'); if (hit) { saveSetting('defaultModel', hit.id, () => { setDefaultModel(hit.id); setModelSaved(hit.id); setSubAgentNotice('主线默认模型已设为 ' + hit.id + '。'); }); } } }, '子代理→主线'))),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '子代理账户'),
            h('div', { className: 'hwb-row-main' },
              subAgentSite !== 'follow'
                ? h(SiteAccounts, { sites, onRefresh: refresh, onlySiteId: subAgentSite, subHint: true })
                : h('span', { className: 'hwb-hint' }, '跟随主线站点：子代理与主线共用同一账户，登录状态在上方「账户与登录管理」维护，无需单独登录。'))),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '会话隔离'),
            h('div', { className: 'hwb-row-main' }, h('span', { className: 'hwb-hint' },
              (driver?.conversationCount ?? 0) + ' 个网页会话槽。子代理（如 explore/plan/通用 agent）按 agentId 自动分到'
              + '「同账号新对话」——同一账号下另开一个全新网页对话，互不污染主对话上下文；网页请求仍按队列逐个执行。'
              + '主线与子代理站点相互独立：同站点共享登录态（消息频率叠加，易触发站点限流，可给子代理选别的站点分流），跨站点登录互不影响；'
              + '「主线→子代理 / 子代理→主线」按钮只单向同步站点选择，不迁移登录态。')))),

        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '首轮提示词'),
          h('p', { className: 'hwb-hint' }, '下面就是发送首条消息时注入网页的完整内容（默认显示，无需展开）。'),
          h(PromptSection)),
        relay?.lastError ? h('p', { role: 'alert', className: 'hwb-hint' }, '最近错误: ' + relay.lastError) : null,
        error && h('p', { role: 'alert' }, error));
    }

    /**
     * 右栏面板对外的动作桥（0.14.0）。
     *
     * 背景：DSH 官方右侧栏的规范入口是「标签动作菜单」（slot
     * `sidebar.right.tab.menu.item`）——「刷新」「独立窗口」这类**作用于当前
     * 标签**的动作应当出现在那里，而不是只做成面板里自绘的按钮。
     *
     * 但菜单项与面板体是**两次独立注册**（menu.item 拿不到 pane 的组件状态），
     * 而站点切换、iframe 池、窗口轮询全是面板内部 state。因此这里做一个最小
     * 桥：面板挂载时把动作函数登记进来，菜单项调用它。面板没开着就报一句
     * 人话，而不是静默失败。
     *
     * 只登记当前存活面板的动作——重复注册（热重载/多 pane）时最后挂载的赢，
     * 与「菜单作用于当前标签」的语义一致。
     */
    const actions = {
      handlers: null,
      currentSite() { return this.handlers?.siteId() ?? null; },
      reload() { return this.handlers ? this.handlers.reload() : { ok: false, reason: '面板尚未打开' }; },
      toggleWindow() { return this.handlers ? this.handlers.toggleWindow() : { ok: false, reason: '面板尚未打开' }; },
      bind(h) { this.handlers = h; return () => { if (this.handlers === h) this.handlers = null; }; },
    };

    function Conversation({ browserSrc, onSplit, onFloat }) {
      const [siteId, setSiteId] = React.useState('deepseek');
      const [siteStatuses, setSiteStatuses] = React.useState({});
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
        const refreshSites = () => api('status').then(s => {
          const rows = s?.driver?.sites || [];
          if (alive) setSiteStatuses(Object.fromEntries(rows.map(row => [row.siteId, row])));
        }).catch(() => {});
        refreshSites();
        const statusTimer = setInterval(refreshSites, 5000);
        winState().then(w => { const open = Object.keys(w?.windows || {}); if (alive && open.length && !open.includes(siteId)) setSiteId(open[0]); });
        const poll = setInterval(() => winState(), 5000);
        return () => { alive = false; clearInterval(poll); clearInterval(statusTimer); };
      }, []);
      const siteStatus = siteStatuses[siteId] || null;
      const statusLabel = row => {
        if (!row || row.loggedIn == null) return '待检查';
        if (row.loggedIn === true) return row.loggedInCached ? '已登录(缓存)' : '已登录';
        return '未登录';
      };
      const statusClass = row => row?.loggedIn === true ? 'ok' : row?.loggedIn === false ? 'bad' : 'idle';
      // 判定依据存疑时给一句解释（0.12.9 起 status 带 loginBasis）：
      //   'input-fallback' → 站点没声明 loginProbe，只能按「有没有输入框」判，
      //                      游客页自带输入框的站点会有误报；
      //   'stale'          → 落盘值来自旧版本判定，已不再作为结论。
      const statusTitle = row => {
        if (!row) return '';
        if (row.loginBasis === 'input-fallback') return '该站点未声明未登录特征，按输入框存在与否判定——游客页自带输入框时可能误报，请以「检测」为准';
        if (row.loginBasis === 'stale') return '此结论来自旧版本判定，已被忽略；点「检测」按站点特征重新核验';
        return '';
      };
      const shouldGuide = row => row && row.initialized === false && row.loggedIn !== true;
      // 站点探活（不可达站点不挂 iframe）：会话内缓存，点「重试」强制重探。
      // probesRef 必须先于 probeSite 声明：probeSite 的闭包捕获它，虽然实际调用
      // 发生在 render 之后的 effect 里（那时已初始化），但把声明放在后面等于埋一个
      // TDZ 陷阱——后人把 probeSite 提前调用就会炸。
      const [probes, setProbes] = React.useState({});     // siteId → { reachable, status, reason, ms, at }
      const probesRef = React.useRef({});
      const probeSite = React.useCallback((sid, force) => {
        if (!force && probesRef.current[sid]) return Promise.resolve(probesRef.current[sid]);
        return api('site-probe', { siteId: sid }, 30000)
          .then(r => { probesRef.current = { ...probesRef.current, [sid]: r }; setProbes(probesRef.current); return r; })
          .catch(() => null);
      }, []);
      const unreachable = sid => { const p = probes[sid]; return p && p.reachable === false ? p : null; };
      const ensureFrame = React.useCallback((sid, force) => {
        setFrames(prev => {
          if (prev[sid] && !force) return prev;   // 已有存活 frame：直接复用，不重载
          // 子域形态：站点在根路径（pathname 与真实站点一致）。强制重载用一个
          // 站点不认识的查询参数绕开缓存——不动 pathname，SPA 路由不受影响。
          const src = siteBase(sid) + (force ? '?__wc_reload=' + Date.now() : '');
          return { ...prev, [sid]: { src, ready: false, status: null } };
        });
      }, [browserSrc]);
      React.useEffect(() => {
        let alive = true;
        setConnectError('');
        // Wait for the first status snapshot before deciding whether to mount a
        // site frame; otherwise an uninitialized site can race the status poll
        // and briefly boot a browser before its guide state arrives.
        if (!siteStatuses[siteId] || frames[siteId] || shouldGuide(siteStatuses[siteId])) return () => { alive = false; };
        (async () => {
          // 先探活再连：站点本机不可达时（chatgpt/claude 403、网络不通的 gemini）
          // 不启动浏览器、不挂 iframe，直接给可解释的引导页——旧实现会为每个
          // tab 挂一个注定失败的 iframe 并常驻保活，用户只看到裸错误页。
          const probe = await probeSite(siteId);
          if (!alive) return;
          if (probe && probe.reachable === false) return;
          try {
            await api('connect', { siteId }, 90000);
            if (alive) ensureFrame(siteId);
          } catch (e) { if (alive) setConnectError(e.message); }
        })();
        return () => { alive = false; };
      }, [siteId, frames, ensureFrame, siteStatuses[siteId]?.initialized, siteStatuses[siteId]?.loggedIn, probes[siteId]]);
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
        // 重载同时重探：站点可能刚从「网络不通」恢复（或反之），只换 src 会一直
        // 拿上一次的结论。
        probeSite(siteId, true).then(p => { if (!p || p.reachable !== false) ensureFrame(siteId, true); });
      }
      const active = frames[siteId];
      const frameBlocked = Number(active?.status) >= 400;
      // 渲染期永远按「对象」读：任何异步/旧值形态（字符串、null）都不得让整块
      // 右栏抛错变白屏——独立窗口按钮只是面板里的一个控件，它坏了也不该拖垮面板。
      const winOf = sid => (winOpen && typeof winOpen === 'object' ? winOpen[sid] : null);
      const winIsOpen = sid => winOf(sid)?.open === true;
      // 把当前站点的真实动作登记给标签动作菜单（sidebar.right.tab.menu.item）。
      // 依赖里有 siteId/reloadFrame/toggleWindow，站点一变菜单就作用到新站点。
      React.useEffect(() => actions.bind({
        siteId: () => siteId,
        siteName: () => siteName(siteId),
        reload: reloadFrame,
        toggleWindow,
      }), [siteId, frames]);
      // 键盘导航：tablist 规范要求左右方向键在标签间移动（Home/End 到两端）。
      // 只切 state，不自己 focus——焦点仍留在原来的按钮上，避免面板重排后
      // 焦点跳到 iframe 里（那会让用户以为右栏卡死）。
      // ---- 站点标签条：滚轮横向滚动（0.14.4） -------------------------------
      // 用户报「右滑只能拖右滑栏，而且还有一点遮挡」。鼠标停在标签条上滚轮就该
      // 能横向滚——标签溢出时这是最自然的操作。React 的 onWheel 挂在根容器上且
      // 是**被动监听**（preventDefault 无效），因此这里挂原生非被动监听。
      const tabsRef = React.useRef(null);
      React.useEffect(() => {
        const el = tabsRef.current;
        if (!el) return () => {};
        const onWheel = (e) => {
          // 横向滚轮 / 触控板横滑本来就能滚，不抢；只接管纵向滚轮。
          if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
          const before = el.scrollLeft;
          el.scrollLeft = before + e.deltaY;
          if (el.scrollLeft !== before) e.preventDefault();
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
      }, [frames]);
      /** 在新分屏里打开某个站点（多开不同网页）。宿主不支持时安静略过。 */
      const openSiteInPane = (sid) => {
        try {
          if (typeof onSplit !== 'function') { setSiteId(sid); return; }
          setSiteId(sid);
          onSplit(sid);
        } catch { setSiteId(sid); }
      };
      const siteIds = Object.keys(SITE_NAMES);
      const onTabKey = (e) => {
        const i = siteIds.indexOf(siteId);
        if (i < 0) return;
        let next = null;
        if (e.key === 'ArrowRight') next = siteIds[(i + 1) % siteIds.length];
        else if (e.key === 'ArrowLeft') next = siteIds[(i - 1 + siteIds.length) % siteIds.length];
        else if (e.key === 'Home') next = siteIds[0];
        else if (e.key === 'End') next = siteIds[siteIds.length - 1];
        if (next === null) return;
        e.preventDefault();
        setSiteId(next);
      };
      // 站点状态的「色点 + tooltip」表达（0.14.5）。
      //
      // 旧实现把「已登录(缓存)」「未登录」「待检查」这些文案直接写进标签条，
      // 十个站点各带一段文字 → 标签条被撑爆，用户报「状态有点简略，而且不统一
      // 风格」。正解不是把文案写得更好，而是**换一种表达**：状态用一颗 8px 色点，
      // 完整解释（含判定依据）留在 title/aria-label。这是 AI-IDE 浏览器里
      // 语言服务/连接状态的通行做法。
      const statusDot = (row) => h('span', {
        className: 'hwb-dot ' + statusClass(row),
        title: statusLabel(row) + (statusTitle(row) ? ' · ' + statusTitle(row) : ''),
        'aria-hidden': 'true',
      });
      return h('div', { className: 'hwb-conversation' },
        // ---- 顶层工具条：当前站点身份 + 图标动作（AI-IDE 浏览器常见形态）----
        // 旧实现把「站点标签」和「动作按钮」挤在同一行：标签会横向溢出，
        // 动作组又长短不一。现在分两层——工具条回答「我在哪个站点、它什么状态、
        // 我能对它做什么」，标签条只负责「切站点」。
        h('div', { className: 'hwb-toolbar' },
          h('div', { className: 'hwb-toolbar-id' },
            statusDot(siteStatus),
            h('span', { className: 'hwb-toolbar-name', title: siteName(siteId) }, siteName(siteId)),
            h('span', { className: 'hwb-toolbar-state' }, winBusy ? '切换中' : statusLabel(siteStatus))),
          h('div', { className: 'hwb-toolbar-actions' },
            h('button', {
              className: 'hwb-act-btn', title: '刷新当前站点网页（重新加载镜像页面）',
              'aria-label': '刷新右侧网页', onClick: reloadFrame,
            }, h('span', { className: 'hwb-act-ico', 'aria-hidden': 'true' }, '\u21bb')),
            h('button', {
              className: 'hwb-act-btn' + (winIsOpen(siteId) ? ' on' : ''), disabled: winBusy,
              title: winIsOpen(siteId) ? '收起独立窗口（回到无头运行）' : '在独立窗口中打开真实网页（已开的窗口会聚焦弹到最前，不会覆盖）',
              'aria-label': winIsOpen(siteId) ? '收起独立窗口' : '打开独立窗口',
              'aria-pressed': winIsOpen(siteId), onClick: toggleWindow,
            }, h('span', { className: 'hwb-act-ico', 'aria-hidden': 'true' }, winIsOpen(siteId) ? '\u25a3' : '\u29c9')),
            onSplit && h('button', {
              className: 'hwb-act-btn', title: '在新面板中打开（可同时看两个不同站点）',
              'aria-label': '在新面板中打开', onClick: onSplit,
            }, h('span', { className: 'hwb-act-ico', 'aria-hidden': 'true' }, '\u25eb')),
            onFloat && h('button', {
              className: 'hwb-act-btn', title: '打开为浮动面板（可拖拽、可同时开多个）',
              'aria-label': '打开为浮动面板', onClick: onFloat,
            }, h('span', { className: 'hwb-act-ico', 'aria-hidden': 'true' }, '\u2750')))),
        // ---- 站点标签条：次级导航（滚轮横向滚，不显示滚动条）----
        h('div', { className: 'hwb-sitebar', role: 'tablist', 'aria-label': '内容服务站点', onKeyDown: onTabKey },
          h('div', { className: 'hwb-sitebar-tabs', ref: tabsRef },
            Object.entries(SITE_NAMES).map(([sid, name]) => h('button', {
              key: sid, role: 'tab', 'aria-selected': sid === siteId,
              // 漫游 tabindex：只有当前标签可 Tab 进入，进入后用方向键移动。
              tabIndex: sid === siteId ? 0 : -1,
              // 基类必须始终在：0.12.9 只渲染 'active' 或 ''，于是没有基础样式
              //（字号/内边距/圆角全无），站点栏看起来是一排裸 <button>。
              className: 'hwb-site-tab' + (sid === siteId ? ' active' : ''),
              title: name + ' · ' + statusLabel(siteStatuses[sid]) + (statusTitle(siteStatuses[sid]) ? ' · ' + statusTitle(siteStatuses[sid]) : ''),
              onClick: () => setSiteId(sid),
              // Ctrl/⌘ + 点击 = 在**新分屏**里打开该站点：多开不同网页的直接入口
              //（另一块面板是独立的组件实例，站点选择互不影响）。
              onAuxClick: (e) => { if (e.button === 1) { e.preventDefault(); openSiteInPane(sid); } },
            }, statusDot(siteStatuses[sid]),
              h('span', { className: 'hwb-site-tab-name' }, name))))),
        // 站点栏之下的「网页区」：iframe 与各种遮罩（加载中 / 拦截 / 不可达 /
        // 未初始化）全部放在这里。遮罩的 position:absolute;inset:0 于是只覆盖
        // 网页区——0.12.9 的遮罩是面板根的兄弟节点，加载时会把整条站点栏也糊掉，
        // 用户连切站点都点不到。
        h('div', { className: 'hwb-frame-host' },
          // 两条错误只显示一条：镜像被站点拦截时，连接类错误没有信息量，不重复刷屏。
          connectError && !frameBlocked && h('div', { className: 'hwb-error', role: 'status' },
            '浏览器视图未能连接：' + connectError + ' ',
            h('button', { className: 'hwb-retry', onClick: reloadFrame }, '重试')),
          shouldGuide(siteStatus) && h('div', { className: 'hwb-guide', role: 'status' },
            h('strong', null, siteName(siteId) + ' 尚未初始化'),
            h('p', null, '请先在设置页点击“登录”或“检测”，完成一次真实网页核验后再打开右栏。网络不可达或地区受限时，请使用独立窗口确认。'),
            h('button', { className: 'hwb-retry', onClick: () => api('window', { siteId, action: 'open' }).then(winState).catch(e => setConnectError(e.message)) }, '打开独立窗口')),
          // 本机直连不通：**不挂 iframe**（挂上去只会是一张 502/403 裸错误页，还常驻
          // 保活占资源）。给出站点名、失败原因与两条真正可行的出路。
          !shouldGuide(siteStatus) && unreachable(siteId) && h('div', { className: 'hwb-guide', role: 'status' },
            h('strong', null, siteName(siteId) + ' 本机网络不可达'),
            h('p', null, '桥在中继里直连 ' + (unreachable(siteId).origin || '') + ' 失败（'
              + (unreachable(siteId).reason || ('HTTP ' + unreachable(siteId).status)) + '）。'
              + '这是本机网络/代理或站点地区策略的问题，镜像与独立窗口都会受影响。'),
            h('button', { className: 'hwb-retry', onClick: () => probeSite(siteId, true) }, '重新探活'),
            h('button', { className: 'hwb-retry', onClick: () => api('window', { siteId, action: 'open' }).then(winState).catch(e => setConnectError(e.message)) }, '仍要尝试独立窗口')),
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
              // 子域形态下 iframe 与面板**不同源**，读 contentWindow.location 必抛
              // 安全错误——旧实现在这里 sniff `location.status`，跨源后永远拿不到，
              // 于是 frameBlocked 恒为 false、拦截提示永不出现。改为只用 onLoad
              // 事实（页面已加载），拦截/不可达由 /__webcode/site-probe 判定。
              setFrames(prev => {
                const cur = prev[sid];
                if (!cur) return prev;
                return { ...prev, [sid]: { ...cur, ready: true, status: cur.status } };
              });
            },
            onError: () => setConnectError('网页代理加载失败，请确认中继服务已启动'),
          })),
          active && !active.ready && !connectError && h('div', { className: 'hwb-frame-status' }, '正在加载 ' + siteName(siteId) + ' 网页…（加载后可直接在右侧操作，生成任务由网页原生执行）')));
    }

    function apply(ctx) {
      const style = document.createElement('style');
      // 样式：DSH 设计 token（--dsw-alias-*）+ fallback。
      // 0.13.0 前这里是硬编码字面量（#8884 / #2e7d32 …），深色主题下与宿主
      // 格格不入；DSH 自家设置区用 token + 16px 圆角卡片。
      // 合并成一张 sheet —— 原本三段（设置/右栏/角落）本就是同一套界面。
      // 注：client 插件是单文件 bundle（__ModuleLoader__ 的 require 只认平台
      // 种子与已注册包，不支持相对路径），CSS 只能内联。
      style.textContent = [
        ".hwb-settings{max-width:760px;padding:20px;color:inherit;display:flex;flex-direction:column;gap:14px}",
        ".hwb-settings h2{font-size:20px;font-weight:500;line-height:28px;letter-spacing:0;margin:0 0 2px}",
        ".hwb-lead{font-size:13px;line-height:22px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin:0}",
        ".hwb-build{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#9aa0a6);margin:-6px 0 0;font-variant-numeric:tabular-nums}",
        ".hwb-card{border:.5px solid var(--dsw-alias-border-l4,#8884);border-radius:16px;background:var(--dsw-alias-bg-layer-1,transparent);padding:4px 16px 10px}",
        ".hwb-group{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary,inherit);margin:14px 0 4px}",
        ".hwb-group.first{margin-top:14px}",
        ".hwb-row{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l3,#8883)}",
        ".hwb-row:last-child{border-bottom:0}",
        ".hwb-row-label{flex:0 0 128px;min-width:96px;font-size:13px;line-height:20px;padding-top:6px;color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-row-main{flex:1;min-width:240px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
        ".hwb-row button,.hwb-settings button{height:32px;padding:0 14px;font:inherit;font-size:13px;line-height:30px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:.5px solid var(--dsw-alias-border-l3,#8885);border-radius:16px;cursor:pointer;transition:background .12s ease}",
        ".hwb-row button:hover:not(:disabled),.hwb-settings button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8882)}",
        ".hwb-row button:disabled,.hwb-settings button:disabled{opacity:.45;cursor:default}",
        ".hwb-model-select,.hwb-prompt-input{min-width:220px;max-width:340px;padding:6px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:.5px solid var(--dsw-alias-border-l3,#8885);border-radius:8px}",
        ".hwb-prompt-input{width:100%;max-width:none;min-height:96px;line-height:1.5;font-family:inherit;resize:vertical}",
        ".hwb-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin:4px 0 0}",
        ".hwb-hint.indent{margin:6px 0 8px}",
        ".hwb-hint.ok{color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-hint.bad{color:var(--dsw-alias-state-error-primary,#93443e)}",
        ".hwb-consent{display:flex;align-items:center;gap:8px;font-size:13px}",
        ".hwb-sites{display:flex;flex-direction:column}",
        ".hwb-site-block{padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l3,#8883)}",
        ".hwb-site-block:last-of-type{border-bottom:0}",
        ".hwb-site-row{display:flex;align-items:center;gap:12px;padding:4px 0;flex-wrap:wrap}",
        ".hwb-site-row.busy{opacity:.55}",
        ".hwb-site-identity{flex:1;display:inline-flex;align-items:center;gap:8px;min-width:140px;font-size:13px}",
        ".hwb-site-name{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit)}",
        ".hwb-row-actions{display:inline-flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}",
        ".hwb-row-actions button{height:28px;line-height:26px;padding:0 12px;font-size:12px;border-radius:14px}",
        ".hwb-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;background:var(--dsw-alias-label-tertiary,#9aa0a6)}",
        ".hwb-dot.ok{background:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-dot.bad{background:var(--dsw-alias-state-error-primary,#93443e)}",
        ".hwb-site-state{font-size:12px;line-height:18px;padding:1px 8px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3,#8885);color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-site-state.ok{color:var(--dsw-alias-state-success-primary,#2e7d32);border-color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-site-state.bad{color:var(--dsw-alias-state-error-primary,#93443e);border-color:var(--dsw-alias-state-error-primary,#93443e)}",
        ".hwb-metrics{display:flex;flex-direction:column;gap:6px;width:100%}",
        ".hwb-metrics-head{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-bottom:2px}",
        ".hwb-badge{display:inline-block;font-size:11px;line-height:16px;padding:0 8px;margin-right:6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,#8885);color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-badge.measured{color:var(--dsw-alias-state-success-primary,#2e7d32);border-color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-bar-row{display:flex;align-items:center;gap:12px}",
        // 输入框底下的等待速览（0.14.4）。官方在同一槽位放一行状态药丸，
        // 因此这里也只占一行、克制低饱和，不抢输入框的视觉重量。
        ".hwb-waitline{font-size:12px;line-height:18px;padding:2px 10px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}",
        ".hwb-waitgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px 16px;width:100%}",
        ".hwb-waitgrid div{display:flex;justify-content:space-between;gap:8px;font-size:12px;line-height:18px}",
        ".hwb-waitgrid dt{color:var(--dsw-alias-label-tertiary,#8a8f98)}",
        ".hwb-waitgrid dd{margin:0;color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:tabular-nums}",
        ".hwb-bar-label{flex:0 0 76px;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-bar-track{flex:1;height:8px;border-radius:4px;overflow:hidden;background:var(--dsw-alias-interactive-bg-hover,#8882)}",
        ".hwb-bar-fill{display:block;height:100%;border-radius:4px;background:var(--dsw-alias-label-tertiary,#8a8f98);transition:width .2s ease}",
        ".hwb-bar-fill.ok{background:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-bar-value{flex:0 0 148px;font-size:12px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,inherit)}",
        // 首轮提示词面板：0.14.0 起**默认渲染**（不再是 <details>），因此 pre
        // 的样式直接挂在容器上，不依赖 summary 展开态。
        ".hwb-preset{border-top:1px solid var(--dsw-alias-border-l3,#8883);padding:8px 0}",
        ".hwb-preset summary{cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-preset pre,.hwb-import pre{max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.55;background:var(--dsw-alias-interactive-bg-hover,#8881);border-radius:8px;padding:10px;margin:0}",
        // 全局指令编辑区 / 首轮提示词面板的容器
        ".hwb-import{display:flex;flex-direction:column;gap:8px;padding:8px 0}",
        ".hwb-conversation{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0}",
        // 站点栏：flex:none + z-index 保证**永不被网页区遮住**（用户报的「有一点
        // 遮挡」就是旧实现里网页区在层叠上压过了标签条）。
        // ---- 顶层工具条（0.14.5 重排）--------------------------------------
        // 尺寸依据来自官方包实测（@deepseek-ai/dsh-client-ui-sidebar-right）：
        //   expand 按钮 width/height:28px + border-radius:28px + padding:6px；
        //   guide 卡片 min-height:56px + border-radius:24px + .5px 边框；
        //   排版 15px（标题）/ 13px（描述，--dsw-alias-label-caption）。
        // 旧实现把标签和动作挤在一行，两者互相抢宽度；现在工具条回答「我在哪个
        // 站点、什么状态、能做什么」，标签条只负责切站点。
        ".hwb-toolbar{flex:none;position:relative;z-index:3;display:flex;align-items:center;gap:8px;height:36px;padding:0 8px;background:var(--dsw-alias-bg-base,transparent)}",
        ".hwb-toolbar-id{display:flex;align-items:center;gap:6px;min-width:0;flex:1}",
        ".hwb-toolbar-name{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".hwb-toolbar-state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap;flex:none}",
        ".hwb-toolbar-actions{flex:none;display:inline-flex;align-items:center;gap:2px}",
        // 标签条：可横向滚，但**不显示滚动条**；不再加两端 mask 渐隐——官方右栏
        // 不用这种表达（实测其 client.js 里 mask-image/scrollbar 命中 0），且渐变
        // 本身就是用户报的「有一点遮挡」的观感来源。
        ".hwb-sitebar{flex:none;position:relative;z-index:2;display:flex;align-items:center;gap:6px;padding:0 8px 6px;background:var(--dsw-alias-bg-base,transparent);border-bottom:.5px solid var(--dsw-alias-border-l4,#8884)}",
        ".hwb-sitebar-tabs{display:flex;gap:4px;overflow-x:auto;flex:1;min-width:0;scrollbar-width:none;-ms-overflow-style:none;scroll-behavior:smooth}",
        ".hwb-sitebar-tabs::-webkit-scrollbar{display:none}",
        // 标签是**紧凑胶囊**：状态改用 8px 色点（见 statusDot），不再把
        // 「已登录(缓存)」这类长文案塞进标签里。
        ".hwb-site-tab{flex:none;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;font:inherit;font-size:12px;line-height:24px;color:var(--dsw-alias-label-secondary,inherit);background:transparent;border:.5px solid transparent;border-radius:13px;cursor:pointer;transition:background .12s ease,color .12s ease,border-color .12s ease}",
        ".hwb-site-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-primary,inherit)}",
        ".hwb-site-tab.active{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border-color:var(--dsw-alias-border-l3,#8885)}",
        ".hwb-site-tab-name{white-space:nowrap}",
        // 动作组：四颗**同形图标按钮**（官方 expand 按钮的 28px/圆角/透明底）。
        // 旧实现里刷新是裸图标、独立窗口是一颗长药丸，两套视觉语言并存——用户报
        // 「刷新栏目/独立窗口状态有点简略，而且不统一风格」。文字全部进
        // title/aria-label，按钮本身只留图标。
        ".hwb-act-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;font:inherit;color:var(--dsw-alias-label-secondary,inherit);background:0 0;border:.5px solid transparent;border-radius:14px;cursor:pointer;transition:background .12s ease,color .12s ease,border-color .12s ease}",
        ".hwb-act-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-primary,inherit)}",
        ".hwb-act-btn:disabled{opacity:.45;cursor:default}",
        ".hwb-act-btn.on{color:var(--dsw-alias-state-success-primary,#2e7d32);border-color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-act-ico{font-size:14px;line-height:1}",
        ".hwb-frame-host{position:relative;flex:1;min-height:0;overflow:hidden;z-index:1}",
        ".hwb-browser-frame{display:block;width:100%;height:100%;min-height:0;border:0;background:#fff}",
        ".hwb-frame-status{position:absolute;inset:0;display:grid;place-items:center;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-tertiary,#7a8494);font-size:12px;pointer-events:none}",
        ".hwb-error,.hwb-guide{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#394150)}",
        ".hwb-error p,.hwb-guide p{font-size:12px;line-height:1.7;margin:0;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
        ".hwb-retry{height:30px;padding:0 14px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:.5px solid var(--dsw-alias-border-l3,#8885);border-radius:15px;cursor:pointer}",
        ".hwb-retry:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}",
        ".hwb-corner-btn{width:28px;height:28px;display:grid;place-items:center;color:var(--dsw-alias-label-secondary,inherit);background:transparent;border:.5px solid var(--dsw-alias-border-l4,#8884);border-radius:7px;cursor:pointer;padding:0}",
        ".hwb-corner-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}",
        // 标签动作菜单项（slot sidebar.right.tab.menu.item）。DSH 的菜单自带
        // 容器与关闭逻辑，这里只负责一行可点文本，样式与宿主菜单项对齐。
        ".hwb-menu-item{display:block;width:100%;padding:6px 10px;font:inherit;font-size:13px;line-height:20px;text-align:left;color:var(--dsw-alias-label-primary,inherit);background:transparent;border:0;border-radius:8px;cursor:pointer}",
        ".hwb-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8882)}",
        ".hwb-menu-item:disabled{color:var(--dsw-alias-label-dimmed,#aaa);cursor:default}",
      ].join('');
      document.head.appendChild(style);
      const disposers = [() => style.remove()];
      const warn = (what, e) => console.warn('[webcode-bridge] ' + what + ' failed:', e && e.message ? e.message : e);
      // ctx.effect 是 DSH 插件的规范生命周期：它把注销函数交给宿主统一回收
      //（重载/卸载都走同一条路）。下面的 disposers 数组保留作兜底——宿主没提供
      // effect 时（旧版本/单测桩）仍必须能干净卸载。
      const own = (fn) => {
        try { if (typeof ctx.effect === 'function') { ctx.effect(() => fn()); return; } } catch (e) { warn('ctx.effect', e); }
        const off = fn();
        if (typeof off === 'function') disposers.push(off);
      };

      // ---- 输入框底下的等待速览（0.14.4，官方 conversation.composer.dock） ----
      // 官方在同一个槽位放状态药丸（ui-chat 的 StatsPills / ui-goal 的 GoalDock），
      // 因此走同一个规范入口，而不是自绘浮层——自绘会与宿主重排打架。
      // inject 拿到的 sessionId 是**当前会话**，服务端据此回本会话的账本。
      own(() => {
        try {
          return ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock', id: 'webcode-wait', order: 20,
            inject: (sessionId) => ({ sessionId }),
          }, WaitLine));
        } catch (e) { warn('composer.dock wait line', e); }
      });

      // ---- 设置页（真实需求重构：登录管理前置、无历史导入） ------------
      own(() => {
        try {
          return ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section', id: 'webcode', order: 110,
            label: () => '网页桥接', inject: () => ({}),
          }, Settings));
        } catch (e) { warn('settings section', e); }
      });

      // ---- 官方右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right）--------
      const TAB_ID = 'dsh-webcode-bridge';
      const TAB_KIND = 'webcode-bridge';
      /**
       * 多开不同网页（0.14.4）。
       *
       * DSH 官方右侧栏自带「分屏 / 浮动」两种多面板形态（`ctx.sidebarRight.split`
       * 与 `.float`），因此**不自己发明浮层**——自绘浮层正是旧实现「遮挡」的来源。
       * 分屏后在新 pane 里打开同一个 kind：pane 之间是独立的组件实例，各自的
       * 站点选择与 iframe 池互不影响，于是「同时看两个不同网页」自然成立。
       *
       * 宿主没提供该能力时（旧版本）按钮不渲染，而不是点了报错。
       */
      const splitPanel = (typeof ctx.sidebarRight?.split === 'function')
        ? (sid) => {
          try {
            const paneId = ctx.sidebarRight.split();
            if (paneId) ctx.sidebarRight.openTab(TAB_KIND, { paneId });
          } catch (e) { warn('sidebarRight.split', e); }
        }
        : null;
      const floatPanel = (typeof ctx.sidebarRight?.float === 'function')
        ? () => {
          try {
            const rec = ctx.sidebarRight.active?.();
            if (rec?.id) ctx.sidebarRight.float(rec.id);
          } catch (e) { warn('sidebarRight.float', e); }
        }
        : null;
      const WebcodeBody = () => h(Conversation, { browserSrc: relayBase + '/', onSplit: splitPanel, onFloat: floatPanel });

      own(() => {
        try {
          return ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            title: () => 'Web Bridge',
            guide: [{
              order: 55,
              title: () => 'Web Bridge',
              description: () => '打开内容服务的真实网页（可多开：Ctrl+点击站点，或用面板上的「分屏 / 浮动」）',
            }],
          });
        } catch (e) { warn('sidebarRightTabs.register', e); }
      });

      own(() => {
        try {
          return ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab', key: TAB_ID,
          }, WebcodeBody));
        } catch (e) { warn('pane.tab body', e); }
      });

      // ---- 标签动作菜单项：刷新 / 独立窗口（DSH 规范入口） --------------
      // 规范要求菜单项作用于「当前标签」并在动作后关闭菜单（dismiss 必须调，
      // 否则菜单会浮在被换掉的内容上）。动作本身由面板登记（actions 桥）。
      const menuItem = (key, label, run) => function TabMenuItem(owner) {
        const sid = actions.currentSite();
        return h('button', {
          type: 'button', className: 'hwb-menu-item',
          onClick: () => { try { run(sid); } finally { owner?.dismiss?.(); } },
        }, label + (sid ? '（' + sid + '）' : ''));
      };
      own(() => {
        try {
          return ctx.slots.inject('sidebar.right.tab.menu.item', () => ctx.slots.register(
            { name: 'sidebar.right.tab.menu.item' },
            menuItem('reload', '刷新网页', () => actions.reload()),
          ));
        } catch (e) { warn('tab menu item (reload)', e); }
      });
      own(() => {
        try {
          return ctx.slots.inject('sidebar.right.tab.menu.item', () => ctx.slots.register(
            { name: 'sidebar.right.tab.menu.item' },
            menuItem('window', '切换独立窗口', () => actions.toggleWindow()),
          ));
        } catch (e) { warn('tab menu item (window)', e); }
      });

      // ---- 会话头角落按钮：展开/收起右侧栏 ------------------------------
      own(() => {
        try {
          const CornerButton = () => h('button', {
            className: 'hwb-corner-btn', type: 'button',
            title: '打开 Web Bridge 网页会话（右侧栏）',
            'aria-label': '打开 Web Bridge 网页会话',
            onClick: () => { try { ctx.sidebarRight.toggleExpanded(); } catch (_) {} },
          }, icon(16));
          return ctx.slots.inject('conversation.session.header.corner', () => ctx.slots.register({
            name: 'conversation.session.header.corner',
          }, CornerButton));
        } catch (e) { warn('header corner button', e); }
      });

      return () => disposers.reverse().forEach(d => { try { d(); } catch (_) {} });
    }
    const exports = { name: 'webcode-bridge-client', inject, apply };
    if (module) module.exports = exports;
    return exports;
  },
});
