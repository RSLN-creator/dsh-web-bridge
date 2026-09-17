// client.cjs — DSH Web 客户端面（浏览器侧 bundle，**不是** ESM 模块）。
//
// 为什么是这个形状：DSH 的客户端插件用 `window.__ModuleLoader__.load({ id, factory })`
// 注册，factory 内部用 CommonJS 的 `require` 取宿主依赖（react / react-dom /
// @deepseek-ai/dsh-client-ui-primitives）。因此本文件**不能**写成 ESM，也**不能**
// import `lib/` 下的任何模块——它是单文件 bundle，服务端那半边的一切（格式化、
// 取值、判定）都必须通过 `/__webcode/*` 端点或由服务端算好后经 /status 透出。
// 这条约束解释了很多看着「绕」的地方：例如等待时长的文案在服务端算（wait-stats.js），
// 而不是在这里再写一份 formatDuration——两份实现迟早会长得不一样。
//
// 本文件承载四块界面：
//   1. 官方右侧栏的网页镜像面板（sidebar.right.pane.tab）与标签动作菜单；
//   2. 原生设置页「网页桥接」分区（settings.section）：账户/登录、花名册、模型、提示词；
//   3. 输入框底下的等待速览（conversation.composer.dock）与会话头右上角开关；
//   4. 左栏全局面板入口（sidebar.panellist）与同名中央列页面（main）：任务板。
//
// 纪律：**只读、不造假状态**。任何拿不到的真实值都如实显示「未知 / 读不到」，
// 绝不回落成一个看起来正常的默认值（详见各组件上方注释）。
window.__ModuleLoader__.load({
  id: 'dsh-webcode-bridge',
  factory(require, module) {
    'use strict';
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    // portal 用：把等待药丸挂进官方统计那一行（见 WaitLine / useOfficialStatsHost）。
    const { createPortal } = require('react-dom');
    const { IconCodeOutline16, IconQueueOutline14 } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    // 等待统计用的图标：官方 primitives 没有 gauge/clock 图标，队列图标是同一
    // 语义域里最近的一个（「还没轮到发送」）。与官方一样只取 14px 线框图标。
    const IconWait = ({ size }) => h(IconQueueOutline14, { size });
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

    /**
     * 把若干个「读不到的原因」合并成一句可读文本，**去掉重复**。
     *
     * 为什么需要去重：Team 成员与任务板同源（都走官方 `listTasks`/`listMembers`），
     * 同一个失败会在两处各报一次。旧实现把两句一模一样的话用 ` / ` 拼起来，
     * 读起来像两个独立的问题——**同一句话重复一遍不是「更多信息」**。
     *
     * @param {Array<string|null|undefined>} list 候选原因
     * @returns {string|null} 去重后的合并原因，全空时返回 null
     */
    function uniqReasons(list) {
      const seen = [];
      for (const v of list || []) {
        const s = v ? String(v) : '';
        if (s && !seen.includes(s)) seen.push(s);
      }
      return seen.length ? seen.join(' / ') : null;
    }

    /**
     * 数据来源标注的人话翻译（0.16.1）。
     *
     * 0.16.1 起 Team 与任务板各有**两个**来源：官方 `agentTeams` 服务，以及磁盘上的
     * `.agent-teams/<teamId>/team.json`。卸载 AgentTeams 之后用户看到的应当是「磁盘」，
     * 而这句话必须出现在界面上——否则用户无法判断「面板空了」是因为真的没有团队，
     * 还是因为数据源没接上。这是本文件一贯的「不造假状态」：来源本身也是一条状态。
     *
     * `null` 时不渲染（两个来源都没读到的情况已经由 `*Error` 那条说明覆盖了，
     * 再叠一句来源标注只会让同一件事说两遍）。
     *
     * @param {string|null|undefined} src 服务端给的 teamSource / tasksSource
     * @returns {string|null} 要显示的文案，或 null（不渲染）
     */
    function sourceText(src) {
      if (src === 'service') return '来源：AgentTeams 服务';
      if (src === 'disk') return '来源：磁盘状态（AgentTeams 未提供实时数据）';
      return null;
    }

    /**
     * 花名册行的状态词与颜色档。
     *
     * **词必须与颜色同时出现**（doc/research/agent-ui-design-references.md §1
     * 点名：颜色不得是唯一载体），因此返回的是 `{k, t}` 一对，调用方两个都要画。
     *
     * `inactive` 的官方语义是「成员存在但未加载，唤醒时仍会收到排队消息」
     *（agent-team README.md:63）。旧实现把它显示成「已停止」，用户会以为成员
     * 没了、要去重新创建——而正确动作只是发消息唤醒它。真正终态（done/completed）
     * 与停用（stopped）另算，不与该词混用。
     *
     * 提到模块作用域是因为 Team 面板与设置页花名册读**同一份**状态语义：
     * 两处各写一份迟早会出现「设置页说空闲、面板说工作中」。
     */
    function rosterStateOf(x) {
      const s = String(x?.status || x?.state || '').toLowerCase();
      if (['running', 'working', 'busy'].includes(s)) return { k: 'ok', t: '工作中' };
      if (['idle'].includes(s)) return { k: 'idle', t: '空闲' };
      if (['provisioning', 'starting', 'pending'].includes(s)) return { k: 'idle', t: '启动中' };
      if (['failed', 'error'].includes(s)) return { k: 'bad', t: '失败' };
      if (['inactive'].includes(s)) return { k: '', t: '未加载（可唤醒）' };
      if (['stopped', 'done', 'completed'].includes(s)) return { k: '', t: '已结束' };
      return { k: '', t: s || '未知' };
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
    /**
     * 官方统计行的挂载点（0.15.11）。
     *
     * ui-chat 的 StatsPills 把根节点标成 `data-composer-stats`，它那条 CSS 是
     * `display:flex; justify-content:center; gap:12px`——**它本身就是一行**。而
     * `conversation.composer.dock` 的每个条目都落在 composerStack（列向 flex）里，
     * 所以另起一个条目必然换行。把本组件 portal 进那个行容器，它就成为该行里
     * 紧跟官方药丸之后的 flex 子项：居中、间距、换行全部由官方 CSS 决定，
     * 没有任何写死的偏移量。
     *
     * 官方行不存在时（会话尚无任何统计：StatsPills 在 steps===0 && !hasTokens
     * 时返回 null）返回 null，调用方回落到自建的一行。
     *
     * 为什么要观察：dock 条目与官方药丸的挂载时机不同（后者要等第一个统计投影
     * 到达），首次渲染常常还找不到行。这里用 MutationObserver 盯着 body，行一
     * 出现就重算并断开观察，避免「必须刷新才同栏」。
     *
     * @param {boolean} wanted 本组件是否有内容要显示（false 时不必扫）
     * @returns {HTMLElement|null} 官方统计行容器
     */
    function useOfficialStatsHost(wanted) {
      const [host, setHost] = React.useState(null);
      React.useEffect(() => {
        if (!wanted) { setHost(null); return () => {}; }
        let observer = null;
        const find = () => {
          let found = null;
          try { found = document.querySelector('[data-composer-stats]'); } catch { found = null; }
          setHost(prev => (prev === found ? prev : found));
          return found;
        };
        if (find() !== null) return () => {};
        try {
          observer = new MutationObserver(() => {
            if (find() !== null && observer !== null) { observer.disconnect(); observer = null; }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        } catch { observer = null; }
        return () => { if (observer !== null) observer.disconnect(); };
      }, [wanted]);
      return host;
    }

    function WaitLine(owner) {
      const sessionId = owner?.sessionId || null;
      const [data, setData] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);
      React.useEffect(() => {
        if (!sessionId) { setData(null); return () => {}; }
        let alive = true;
        const pull = () => api('wait-stats', { sessionId })
          .then(r => { if (alive) setData(r || null); })
          .catch(() => { /* 中继未起时静默：这条是附加信息，不该刷错误 */ });
        pull();
        // 10 秒一次足够：这个数只在本轮结束后才变，且是本地回环请求。
        const timer = setInterval(pull, 10000);
        return () => { alive = false; clearInterval(timer); };
      }, [sessionId]);
      // 官方 StatsPills 的关闭语义（0.15.11）。
      //
      // 官方那两枚药丸由同一个 useState 驱动（openPill 独占：点另一枚就换过去），
      // 并由 primitives 的 useDismissOnOutsidePointer 负责「点空白处收起」。本组件
      // 是独立注册的 dock 条目、拿不到那个 state，因此按同一套语义等价实现：
      //   • Esc 收起；
      //   • pointerdown 落在自己 wrap 之外就收起——于是点官方任何一枚药丸（在本 wrap
      //     之外）时本面板随之关闭，与官方「同时只有一枚开着」的观感一致。
      // 用 rootRef 而不是整行做边界：点自己面板内部（含滚动条）不会误关。
      React.useEffect(() => {
        if (!open) return;
        const onKey = e => { if (e.key === 'Escape') setOpen(false); };
        const closeOutside = event => {
          const root = rootRef.current;
          if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', closeOutside);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('pointerdown', closeOutside);
        };
      }, [open]);
      const label = typeof data?.label === 'string' ? data.label : '';
      const officialHost = useOfficialStatsHost(label !== '');
      if (!label) return null;
      const rows = Array.isArray(data?.detailRows) ? data.detailRows : [];
      // 与官方 stat-dialog 的排布逐项对齐：标题行（图标+标题 / 右侧值）→
      // 细分隔线 → dl 网格（dt 左、dd 右、tabular-nums）。
      const content = h('div', {
        className: 'hwb-waitwrap',
        ref: rootRef,
        // 自建一行时用官方同款行的类名（CSS 逐字抄 StatsPills.root）。
        'data-webcode-wait': officialHost === null ? '' : null,
      },
        // 不给按钮挂 role="status"：那会把一个可聚焦控件声明成活区，屏幕阅读器
        // 会把它当播报文本而非按钮（官方药丸也只给 aria-haspopup/aria-expanded）。
        h('button', {
          type: 'button', className: 'hwb-waitpill',
          'aria-haspopup': 'dialog', 'aria-expanded': open,
          'aria-label': '等待发送统计：' + label,
          title: '等待发送统计',
          onClick: () => setOpen(v => !v),
        },
          h(IconWait, { size: 14 }),
          h('span', { className: 'hwb-waitpill-label' }, label)),
        open && h('div', { className: 'hwb-waitpanel', role: 'dialog', 'aria-label': '等待发送统计' },
          h('div', { className: 'hwb-waitpanel-head' },
            h('span', { className: 'hwb-waitpanel-title' },
              h(IconWait, { size: 14 }), '等待发送统计'),
            data?.sessionValue
              ? h('span', { className: 'hwb-waitpanel-value' }, data.sessionValue)
              : null),
          h('div', { className: 'hwb-waitpanel-rule', 'aria-hidden': true }),
          rows.length
            ? h('dl', { className: 'hwb-waitpanel-grid' },
              rows.map(r => h('div', { key: r.label, className: 'hwb-waitpanel-row' },
                h('dt', null, r.label), h('dd', null, r.value))))
            : h('p', { className: 'hwb-hint' }, '本会话尚无等待记录。')));
      // 官方统计行在 → portal 进去（成为该行的第三个 flex 子项，居中/间距/换行
      // 全由官方那条 CSS 决定）；不在 → 原样返回，dock 自成一行的行为与 0.15.10
      // 之前一致，但样式抄的是官方同款行。
      return officialHost === null ? content : createPortal(content, officialHost);
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
    /**
     * 「谁在跑」只读花名册：把**子代理**与 **Team 成员**分开展示（0.14.9）。
     *
     * 用户原话：「子代理和team效果需要单独区分」。为什么必须分开，而不是合成
     * 一个列表——依据是两者的**结构性差异**（doc/research/agent-ui-design-references.md
     * §4.5，引官方文档对比表）：
     *   - 子代理：结果**回报给调用方** → 在 UI 上**从属于**发起它的会话（缩进层级）。
     *   - Team：成员**互相发消息**、共享任务板 → 在 UI 上**平级**（同一层级）。
     * 混在一起会出现两种误导：把「父会话的一个子任务」看成与 Team 成员同等，
     * 或把平级的 teammate 画成某个会话的下属。
     *
     * 数据来源纪律（与账户头像同一条）：**只读、不造假状态**。
     * 这里只消费 /__webcode/status 的四段：`subAgents`（子代理）、`team`/`members`
     * （Team 成员，两个名字同值，官方 TeamView 用 members）、`tasks`（团队任务板）。
     * 0.15.0 起由服务端 lib/roster.js 从官方 agentTeams / subagents 服务与本会话
     * 的 subagentCatalog 投影**真实读出**，不再是空数组占位。
     *
     * 四个分区各自可能「读不到」而不是「为空」，两者在界面上必须分开说：
     *   • 确实没有成员 → 「当前没有正在运行的子代理或 Team 成员。」
     *   • 读不到       → 「读不到花名册：<原因>」
     * 旧实现把两者都画成同一句话，用户无法判断是 Team 没在用还是桥坏了。
     * 空列表是**状态**（确实没有），不是错误；`*Error` 才是错误。
     *
     * sessionId 必须一起带上：subagentCatalog 是**父会话自己的**持久化投影，
     * 不带会话身份的话服务端只能猜，多会话并行时会显示别人的子代理。
     * 0.15.4 起服务端还会用它当 Team 的**唯一权威凭据**——旧实现挨个试
     * `agents.list()`，而官方 `tryMembership` 对任何顶层会话都返回 lead 且不抛错，
     * 于是面板读到的是「进程里第一个别的会话的 lead」。
     */
    function AgentRoster({ sessionId }) {
      const [rows, setRows] = React.useState(null);
      React.useEffect(() => {
        if (!sessionId) { setRows({ sub: [], team: [], tasks: [], err: null, taskErr: null }); return () => {}; }
        let alive = true;
        const pull = () => api('status', { sessionId })
          .then(r => {
            if (!alive) return;
            setRows({
              sub: Array.isArray(r?.subAgents) ? r.subAgents : [],
              // 两个名字取同一个值：官方 TeamView 叫 members，0.15.0 起本项目
              // 叫 team。哪一端改名都不会让这行读到 undefined。
              team: Array.isArray(r?.team) ? r.team : (Array.isArray(r?.members) ? r.members : []),
              tasks: Array.isArray(r?.tasks) ? r.tasks : [],
              // 原因合并成一个可读句子；**同类原因只报一次**（Team 侧与任务板
              // 同源失败时会把同一句话重复两遍，读起来像两个问题）。
              err: uniqReasons([r?.teamError || r?.membersError, r?.subAgentsError]),
              taskErr: uniqReasons([r?.tasksError]),
            });
          })
          .catch(e => { if (alive) setRows({ sub: [], team: [], tasks: [], err: String(e?.message || e), taskErr: null }); });
        pull();
        const t = setInterval(pull, 5000);
        return () => { alive = false; clearInterval(t); };
      }, [sessionId]);
      if (rows === null) return h('p', { className: 'hwb-hint' }, '花名册加载中…');
      // 状态词必须与颜色**同时**出现（调研 §5 点名：颜色不得是唯一载体）。
      // 语义本体在模块作用域的 rosterStateOf——Team 面板与这里读同一份。
      const stateOf = rosterStateOf;
      const row = (x, key, nested) => {
        const st = stateOf(x);
        return h('div', { key, className: 'hwb-roster-row' + (nested ? ' nested' : '') },
          h('span', { className: 'hwb-dot ' + st.k, 'aria-hidden': 'true' }),
          h('span', { className: 'hwb-roster-name' },
            // 平级/从属的差别在**缩进**里表达（nested 走 CSS padding-left），
            // 不靠颜色，也不靠文案重复解释。
            String(x?.name || x?.id || x?.agentId || '（未命名）')),
          // 模型（Team 成员行才有）：谁跑在哪个模型上是 Team 与子代理最直观的
          // 差别之一，只读展示，不做解释。
          x?.model && h('span', { className: 'hwb-roster-model' }, String(x.model)),
          h('span', { className: 'hwb-roster-state' }, st.t),
          // 任务归属：**只统计归到这个成员名下的**任务（服务端按官方 ownerName 算）。
          // 旧实现给的是团队任务总数，对每个成员都一样——那是假事实。
          x?.taskCount != null && h('span', { className: 'hwb-roster-task' }, '任务 ' + x.taskCount));
      };
      /**
       * 任务板：**团队级**事实（官方 TeamView.tasks），不是某个成员的属性。
       *
       * 为什么值得单独一块 UI：「Team 成员平级」如果只显示名字，用户看不出他们
       * 在协作什么。这里如实显示状态、归属、被谁卡住、写哪些文件、是否就绪
       * ——全部原样来自官方 `listTasks`，桥不重新解释。
       */
      const taskBoard = (tasks) => h('div', { className: 'hwb-roster-group' },
        h('p', { className: 'hwb-roster-head' }, 'Team 任务板'),
        tasks.map((t, i) => {
          const s = String(t?.status || '');
          const label = s === 'in_progress' ? '进行中' : s === 'completed' ? '已完成' : s === 'pending' ? '待办' : (s || '未知');
          const k = s === 'in_progress' ? 'ok' : s === 'completed' ? '' : 'idle';
          return h('div', { key: 'k' + i, className: 'hwb-roster-row' },
            h('span', { className: 'hwb-dot ' + k, 'aria-hidden': 'true' }),
            h('span', { className: 'hwb-roster-name' }, String(t?.subject || t?.id || '（无标题）')),
            t?.ownerName && h('span', { className: 'hwb-roster-model' }, String(t.ownerName)),
            h('span', { className: 'hwb-roster-state' }, label),
            // 被阻塞的任务必须能看出「被什么卡住」，否则「ready=false」只是一句黑话。
            Array.isArray(t?.blockedBy) && t.blockedBy.length > 0
              && h('span', { className: 'hwb-roster-task' }, '阻塞于 ' + t.blockedBy.length + ' 项'),
            // 写范围重叠是 advisory 而不是锁（官方 writeScopeWarnings）——
            // 官方已经算好了，原样透出，不在桥里重算。
            Array.isArray(t?.writeScopeWarnings) && t.writeScopeWarnings.length > 0
              && h('span', { className: 'hwb-roster-task' }, '写范围告警'));
        }),
        h('p', { className: 'hwb-hint' }, '任务板是团队级的：成员平级、写范围只是提醒而不是锁。'));
      const sub = rows.sub, team = rows.team, tasks = rows.tasks;
      if (!sub.length && !team.length && !tasks.length) {
        // 「确实没有」与「读不到」是两件事，界面必须分开说：
        // 前者是正常状态，后者是桥/官方包的问题，用户要能据此去排查。
        if (rows.err) {
          return h('div', { className: 'hwb-roster' },
            h('p', { className: 'hwb-hint' }, '读不到花名册（' + rows.err + '）：这不代表没有成员在跑，而是数据源不可用。'));
        }
        // 0.15.5（P3-4）：空 Team + 无错误时，必须明说「本会话不是 Team 成员」。
        //
        // 官方语义（agent-team README.md:128）：**每个普通顶层会话都是隐式 Team 的
        // Lead**；而 Team 工具只对成员安装（tool-agent-team/lib/index.js:533）。
        // 所以「自己是 lead」不等于「存在一个团队」——旧实现只画一行 lead，
        // 让用户以为有团队在协作，实际上 `spawn_teammate` 根本没挂载。
        // 这里如实说明状态，并给出可执行的下一条动作。
        return h('div', { className: 'hwb-roster' },
          h('p', { className: 'hwb-hint' }, '本会话不是 Team 成员（Team 工具未挂载）。'),
          h('p', { className: 'hwb-hint' }, '也没有正在运行的子代理。子代理与 Team 是两件事：子代理从属于发起它的会话，Team 成员是同一 Lead 下的平级协作域。'));
      }
      return h('div', { className: 'hwb-roster' },
        // 部分可用时同样要说清楚：有 Team 行但子代理读不到，不能装作子代理为空。
        rows.err && h('p', { className: 'hwb-hint' }, '部分分区读不到（' + rows.err + '）。'),
        // 子代理区：缩进——它们是**本会话**派生出来的，不是平级的同事。
        sub.length > 0 && h('div', { className: 'hwb-roster-group' },
          h('p', { className: 'hwb-roster-head' }, '子代理（属于本会话）'),
          sub.map((x, i) => row(x, 's' + i, true))),
        // Team 区：平级。并如实说明「并行的是会话与呈现，不是文件系统」
        // ——官方明文没有 worktree、没有文件锁，假装隔离会误导。
        team.length > 0 && h('div', { className: 'hwb-roster-group' },
          h('p', { className: 'hwb-roster-head' }, 'Team 成员（平级）'),
          team.map((x, i) => row(x, 't' + i, false)),
          h('p', { className: 'hwb-hint' }, 'Team 成员共享同一个 checkout：并行的是会话与呈现，不是文件系统。')),
        tasks.length > 0 && taskBoard(tasks));
    }

    /**
     * 花名册数据的**唯一**拉取点（0.15.12）。
     *
     * Team 面板、任务板面板与设置页花名册读的是同一份 `/__webcode/status`。
     * 三处各写一遍 fetch 会有两个立刻可见的代价：轮询相位不同（同屏出现
     * 「3 个成员」与「2 个成员」），以及错误处理各不相同（一处说「读不到」、
     * 另一处静默空列表）。所以只留一个 hook，三处都从这里取。
     *
     * 返回 `data === null` 表示**还没拿到第一份**（渲染加载态），与
     * `data.{team,tasks}` 为空数组（确实没有）是两件不同的事——这与本文件
     * 一贯的「空列表是状态、*Error 才是错误」一致。
     *
     * @param {string|null} sessionId 当前会话 id（服务端据此定位 Team 凭据）
     * @param {number} intervalMs 轮询间隔；0 表示只拉一次
     * @returns {{data: object|null, err: string|null}} 花名册快照与请求级错误
     */
    function useRoster(sessionId, intervalMs) {
      const [state, setState] = React.useState({ data: null, err: null });
      React.useEffect(() => {
        if (!sessionId) {
          // 没有会话身份是**正常情况**（新会话尚未建立），但花名册确实读不到，
          // 因此给一份空快照 + 原因，而不是一直停在「加载中…」。
          setState({ data: { subAgents: [], team: [], tasks: [], graph: null }, err: 'no-session-id' });
          return () => {};
        }
        let alive = true;
        const pull = () => api('status', { sessionId })
          .then(r => { if (alive) setState({ data: r || null, err: null }); })
          .catch(e => { if (alive) setState({ data: null, err: String(e?.message || e) }); });
        pull();
        if (!intervalMs) return () => { alive = false; };
        const t = setInterval(pull, intervalMs);
        return () => { alive = false; clearInterval(t); };
      }, [sessionId, intervalMs]);
      return state;
    }

    /** 官方任务状态 → 中文标签与色档。任务板与 Team 面板共用，避免两处措辞漂移。 */
    function taskStatusOf(s) {
      const v = String(s || '');
      if (v === 'in_progress') return { k: 'ok', t: '进行中' };
      if (v === 'completed') return { k: '', t: '已完成' };
      if (v === 'pending') return { k: 'idle', t: '待办' };
      if (v === 'deleted') return { k: '', t: '已删除' };
      return { k: '', t: v || '未知' };
    }

    /**
     * **Team 面板**（0.15.12）：一张「谁在这个团队里、各自在忙什么」的只读视图。
     *
     * ## 与设置页花名册的分工（不是重复）
     *
     * 设置页那栏回答的是**配置期**的问题（有哪些账户、模型怎么选、提示词是什么），
     * 花名册只是顺带一行。而右栏是**运行期**的常驻视图：用户在做任务时想知道
     * 「谁在跑、谁空闲、能不能再派活」。因此这里的呈现比设置页更细：
     * 角色、模型、上下文模式、名下任务数各自成列，并给出可执行的下一步提示。
     *
     * ## 数据来源与纪律
     *
     * 全部来自 `/__webcode/status`（服务端 lib/roster.js 从官方 `agentTeams`
     * 的 `listMembers` 真实读出）。**只读、不造假**：读不到时把原因摊开，
     * 而不是画一行看起来正常的空列表。
     *
     * `inactive` 必须显示成「未加载（可唤醒）」——官方 README 明说这种成员仍会
     * 收到排队消息，显示成「已停止」会让人以为要重新创建（见 rosterStateOf）。
     *
     * @param {{sessionId?: string, useSessions?: Function}} props 槽注入的会话身份
     */
    function TeamPanel(props) {
      const sessionId = useCurrentSessionId(props);
      const { data, err } = useRoster(sessionId, 5000);
      if (data === null) {
        return h('div', { className: 'hwb-panel' },
          h('p', { className: 'hwb-hint' }, err ? '读不到 Team：' + err : 'Team 加载中…'));
      }
      const team = Array.isArray(data.team) ? data.team : (Array.isArray(data.members) ? data.members : []);
      const teamErr = uniqReasons([data.teamError, data.membersError]);
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      // 只在「有非 lead 成员」时才算作一个真实的团队。官方对任何顶层会话都返回
      // 一行 lead（agent-team README.md:128），只画那一行会让用户以为有团队在跑。
      const teammates = team.filter(m => String(m?.role || '') !== 'lead');
      const counts = team.reduce((acc, m) => {
        const k = rosterStateOf(m).k;
        acc[k === 'ok' ? 'working' : k === 'bad' ? 'failed' : 'idle'] += 1;
        return acc;
      }, { working: 0, idle: 0, failed: 0 });
      const memberRow = (m, i) => {
        const st = rosterStateOf(m);
        const name = String(m?.name || m?.id || '（未命名）');
        return h('div', { key: 'm' + i, className: 'hwb-panel-row' },
          h('span', { className: 'hwb-dot ' + st.k, 'aria-hidden': 'true' }),
          h('span', { className: 'hwb-panel-title' }, name),
          m?.role && h('span', { className: 'hwb-chip' }, String(m.role)),
          m?.model && h('span', { className: 'hwb-panel-meta' }, String(m.model)),
          // 上下文模式（fresh/fork）是 Team 成员的既有字段，官方给了就透出。
          m?.context && h('span', { className: 'hwb-panel-meta' }, String(m.context)),
          h('span', { className: 'hwb-panel-state' }, st.t),
          m?.taskCount != null && h('span', { className: 'hwb-chip' }, '任务 ' + m.taskCount));
      };
      return h('div', { className: 'hwb-panel' },
        h('div', { className: 'hwb-panel-summary' },
          h('span', { className: 'hwb-panel-stat' }, '成员 ' + team.length),
          counts.working > 0 && h('span', { className: 'hwb-panel-stat ok' }, '工作中 ' + counts.working),
          counts.idle > 0 && h('span', { className: 'hwb-panel-stat' }, '空闲/未加载 ' + counts.idle),
          counts.failed > 0 && h('span', { className: 'hwb-panel-stat bad' }, '失败 ' + counts.failed),
          h('span', { className: 'hwb-panel-stat' }, '任务 ' + tasks.length)),
        teamErr && h('p', { className: 'hwb-hint bad' }, 'Team 分区读不到（' + teamErr + '）——这不代表没有成员，而是数据源不可用。'),
        team.length === 0 && !teamErr
          ? h('p', { className: 'hwb-hint' }, '本会话没有任何 Team 成员。官方语义：每个普通顶层会话都是隐式 Team 的 Lead，但只有真正 spawn 过 teammate 才存在一个团队。')
          : null,
        // 只有 lead 一行时如实说明——否则用户会以为「团队就我一个人在跑」。
        team.length > 0 && teammates.length === 0
          ? h('p', { className: 'hwb-hint' }, '当前只有本会话自己（lead），没有派生出的 teammate。')
          : null,
        team.length > 0 && h('div', { className: 'hwb-panel-group' }, team.map(memberRow)),
        // 来源标注：磁盘回落时成员**没有实时 activity**，用户必须知道
        //（否则「空闲」会被读成「真的空闲」，而不是「这里没有实时数据」）。
        sourceText(data.teamSource) && h('p', { className: 'hwb-hint' }, sourceText(data.teamSource)),
        teammates.length > 0 && h('p', { className: 'hwb-hint' },
          '成员状态为「未加载（可唤醒）」时不必重建：给它发一条消息就会唤醒并继续原来的上下文。'),
        h('p', { className: 'hwb-hint' },
          'Team 成员共享同一个 checkout：并行的是会话与呈现，不是文件系统。任务归属与依赖关系见「任务板」标签页。'));
    }

    /**
     * **任务板面板**（0.15.12）：官方逐行事实 + 桥自算的**图级**视角。
     *
     * ## 为什么不能只把 `listTasks` 画成列表
     *
     * 官方每一行都给 `status` / `blockedBy` / `ready` / `writeScopes`，回答的是
     * 「这一条现在能不能开工」。但用户在任务板上真正要问的是另外三个问题，
     * 官方数据里一个都没有（对照研究 §3⑧「图的状态必须能一眼看出在等谁」）：
     *
     *   1. **为什么整块板没动？** → 「当前阻塞点」：谁在卡住几个下游。
     *   2. **还要多久？** → **关键路径**（最长依赖链），它是整批任务的下界。
     *   3. **图本身坏了吗？** → 环 / 自环 / 悬空边。带环的图在界面上表现为
     *      「一堆永远不 ready 的待办」，看起来像卡死，其实是结构错误。
     *
     * 这三条由服务端 `lib/task-graph.js` 纯计算得出（`/status` 的 `graph` 字段），
     * 本组件只负责呈现，不在浏览器侧重算——两份图论实现迟早会不一致。
     *
     * ## 刻意保留的诚实
     *
     * `ready` 取**官方算好的布尔**（`readySource: 'official'`）；只有官方没给
     * 该键时才现算一次并标为 `computed`。桥不重算官方判据，因为重算必然漂移。
     *
     * @param {{sessionId?: string, useSessions?: Function}} props 槽注入的会话身份
     */
    function TaskBoardPanel(props) {
      const sessionId = useCurrentSessionId(props);
      const { data, err } = useRoster(sessionId, 5000);
      if (data === null) {
        return h('div', { className: 'hwb-panel' },
          h('p', { className: 'hwb-hint' }, err ? '读不到任务板：' + err : '任务板加载中…'));
      }
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const taskErr = uniqReasons([data.tasksError]);
      const g = data.graph && typeof data.graph === 'object' ? data.graph : null;
      // 执行语义（0.16.2）：与 graph 同一性质——是 tasks 的**补充视角**，
      // 算不出来时为 null 并带 planError，不连坐 tasks 与 graph。
      const plan = data.plan && typeof data.plan === 'object' ? data.plan : null;
      const planErr = data.planError || null;
      const byId = new Map(tasks.map(t => [String(t.id), t]));
      // 判定表：id → admission。面板按它分组，而不是自己重算 ready——
      // 「能不能开工」的两个轴（依赖 / 资源）判据只在服务端一份。
      const admissionById = new Map(
        (Array.isArray(plan?.admissions) ? plan.admissions : []).map(a => [String(a.id), a]));
      /** 一条任务行：状态点 + 标题 + 归属 + 状态 + 阻塞明细。 */
      const taskRow = (t, i, extra) => {
        const st = taskStatusOf(t?.status);
        const blocked = Array.isArray(t?.blockedBy) ? t.blockedBy : [];
        // 未完成的阻塞者要逐个点名并带**它自己的状态**：否则「被 3 项卡住」看不出
        // 是「还在跑」（正常等待）还是「已经失败」（需要人处理）。
        const unresolved = blocked
          .map(id => byId.get(String(id)))
          .filter(Boolean)
          .filter(b => String(b.status) !== 'completed');
        return h('div', { key: 't' + i, className: 'hwb-panel-row' },
          h('span', { className: 'hwb-dot ' + st.k, 'aria-hidden': 'true' }),
          h('span', { className: 'hwb-panel-title', title: String(t?.id || '') }, String(t?.subject || t?.id || '（无标题）')),
          t?.ownerName && h('span', { className: 'hwb-chip' }, String(t.ownerName)),
          h('span', { className: 'hwb-panel-state' }, st.t),
          extra,
          unresolved.length > 0 && h('span', { className: 'hwb-panel-meta' },
            '等在 ' + unresolved.map(b => String(b.subject || b.id) + '（' + taskStatusOf(b.status).t + '）').join('、')),
          Array.isArray(t?.writeScopeWarnings) && t.writeScopeWarnings.length > 0
            && h('span', { className: 'hwb-chip warn' }, '写范围告警'));
      };
      const ready = tasks.filter(t => String(t.status) === 'pending' && t.ready === true);
      const blockedRows = tasks.filter(t => String(t.status) === 'pending' && t.ready !== true);
      const running = tasks.filter(t => String(t.status) === 'in_progress');
      const done = tasks.filter(t => String(t.status) === 'completed');
      const group = (head, rows, emptyHint) => h('div', { className: 'hwb-panel-group' },
        h('p', { className: 'hwb-panel-head' }, head + '（' + rows.length + '）'),
        rows.length ? rows.map((t, i) => taskRow(t, head + i)) : (emptyHint ? h('p', { className: 'hwb-hint' }, emptyHint) : null));
      return h('div', { className: 'hwb-panel' },
        h('div', { className: 'hwb-panel-summary' },
          h('span', { className: 'hwb-panel-stat' }, '共 ' + tasks.length),
          ready.length > 0 && h('span', { className: 'hwb-panel-stat ok' }, '可开工 ' + ready.length),
          running.length > 0 && h('span', { className: 'hwb-panel-stat ok' }, '进行中 ' + running.length),
          blockedRows.length > 0 && h('span', { className: 'hwb-panel-stat bad' }, '被阻塞 ' + blockedRows.length),
          done.length > 0 && h('span', { className: 'hwb-panel-stat' }, '已完成 ' + done.length)),
        taskErr && h('p', { className: 'hwb-hint bad' }, '任务板读不到（' + taskErr + '）——这不代表没有任务，而是数据源不可用。'),
        !taskErr && tasks.length === 0
          ? h('p', { className: 'hwb-hint' }, '本团队任务板为空。用 Team 工具 create_task 建任务后这里会实时出现（5 秒轮询）。')
          : null,
        // ---- 图诊断：官方数据里没有的那一层 ----
        g && (g.cycles?.length || g.selfLoops?.length || g.missingEdges?.length)
          ? h('div', { className: 'hwb-panel-group' },
            h('p', { className: 'hwb-panel-head bad' }, '图结构问题'),
            g.selfLoops?.length ? h('p', { className: 'hwb-hint bad' },
              '自环（任务依赖自己）：' + g.selfLoops.join('、') + '。自环是单点错误，改掉那一条依赖即可。') : null,
            g.cycles?.length ? h('p', { className: 'hwb-hint bad' },
              '依赖成环（' + g.cycles.length + ' 组）：' + g.cycles.map(c => c.join(' → ')).join('；')
              + '。环内任务永远不会就绪，必须先断开其中一条边。') : null,
            g.missingEdges?.length ? h('p', { className: 'hwb-hint bad' },
              '悬空依赖（指向不存在或已删除的任务）：'
              + g.missingEdges.slice(0, 8).map(e => e.from + ' → ' + e.to).join('、')
              + (g.missingEdges.length > 8 ? ' 等 ' + g.missingEdges.length + ' 条' : '')) : null)
          : null,
        // ---- 关键路径：整批任务的下界，也是「并行度够不够」的唯一可核对判据 ----
        g && g.acyclic && g.criticalPathLength > 0
          ? h('div', { className: 'hwb-panel-group' },
            h('p', { className: 'hwb-panel-head' }, '关键路径（' + g.criticalPathLength + ' 个任务）'),
            h('p', { className: 'hwb-hint' },
              g.criticalPath.map(id => String(byId.get(String(id))?.subject || id)).join(' → ')),
            h('p', { className: 'hwb-hint' }, '这是最长依赖链：它决定整批任务的最短完成步数，也说明哪些任务值得优先处理。'))
          : null,
        g && g.acyclic === false
          ? h('p', { className: 'hwb-hint bad' }, '图里有环，无法计算关键路径与深度——先修上面的结构问题。')
          : null,
        // ---- 当前阻塞点：第一行就是最该处理的那个 ----
        g && Array.isArray(g.blockedOn) && g.blockedOn.length > 0
          ? h('div', { className: 'hwb-panel-group' },
            h('p', { className: 'hwb-panel-head' }, '当前阻塞点（按卡住的下游数排序）'),
            g.blockedOn.slice(0, 6).map((b, i) => h('div', { key: 'b' + i, className: 'hwb-panel-row' },
              h('span', { className: 'hwb-dot ' + taskStatusOf(b.status).k, 'aria-hidden': 'true' }),
              h('span', { className: 'hwb-panel-title' }, String(b.subject || b.id)),
              b.ownerName && h('span', { className: 'hwb-chip' }, String(b.ownerName)),
              h('span', { className: 'hwb-panel-state' }, taskStatusOf(b.status).t),
              h('span', { className: 'hwb-chip' }, '卡住 ' + b.waitingCount + ' 项'))),
            h('p', { className: 'hwb-hint' }, '「为什么整块板没动」的答案在这里：处理第一行即可解锁最多的下游。'))
          : null,
        group('可开工', ready, '当前没有就绪且未开工的任务。'),
        group('被阻塞', blockedRows, '没有被阻塞的任务。'),
        group('进行中', running),
        group('已完成', done),
        // ---- 执行语义（0.16.2）：graph 回答「结构长什么样」，这一层回答「现在允许开工吗」----
        //
        // 为什么必须**分开列出**「等依赖」与「等资源」：它们是两种完全不同的卡法，
        // 动作也不同（前者去催上游，后者去腾一个成员）。旧实现把两者合成一个
        // 「能不能开工」，于是「依赖全满足但没人空闲」看起来像卡死——而它其实
        // 只要派个人；「有人空闲但依赖没满足」则是最难查的一类提前开工。
        plan && plan.waitingDeps?.length
          ? h('div', { className: 'hwb-panel-group' },
            h('p', { className: 'hwb-panel-head' }, '等依赖（' + plan.waitingDeps.length + '）'),
            plan.waitingDeps.slice(0, 8).map((w, i) => h('div', { key: 'wd' + i, className: 'hwb-panel-row' },
              h('span', { className: 'hwb-dot', 'aria-hidden': 'true' }),
              h('span', { className: 'hwb-panel-title' }, String(byId.get(String(w.id))?.subject || w.id)),
              h('span', { className: 'hwb-panel-meta' },
                '等在 ' + (w.edges || []).map(e => String(byId.get(String(e.id))?.subject || e.id)
                  + '（' + taskStatusOf(e.status).t + '·' + e.kind + '）').join('、')))),
            h('p', { className: 'hwb-hint' }, '这些在等上游。上游若是 failed 且边语义是 after-success，它**永远不会**就绪——要人去改边或重开上游。'))
          : null,
        plan && plan.waitingResource?.length
          ? h('div', { className: 'hwb-panel-group' },
            h('p', { className: 'hwb-panel-head' }, '等资源（' + plan.waitingResource.length + '）'),
            plan.waitingResource.slice(0, 8).map((w, i) => h('div', { key: 'wr' + i, className: 'hwb-panel-row' },
              h('span', { className: 'hwb-dot idle', 'aria-hidden': 'true' }),
              h('span', { className: 'hwb-panel-title' }, String(byId.get(String(w.id))?.subject || w.id)),
              w.ownerName && h('span', { className: 'hwb-chip' }, String(w.ownerName)),
              h('span', { className: 'hwb-panel-state' }, '成员忙')))        ,
            h('p', { className: 'hwb-hint' }, '依赖已满足，但归属的成员正在跑别的活。给它发消息或把任务移回共享池即可开工——这不是卡死。'))
          : null,
        plan && plan.retryable?.length
          ? h('div', { className: 'hwb-panel-group' },
            h('p', { className: 'hwb-panel-head' }, '可重试（' + plan.retryable.length + '）'),
            plan.retryable.slice(0, 6).map((r, i) => h('div', { key: 'rt' + i, className: 'hwb-panel-row' },
              h('span', { className: 'hwb-dot bad', 'aria-hidden': 'true' }),
              h('span', { className: 'hwb-panel-title' }, String(byId.get(String(r.id))?.subject || r.id)),
              h('span', { className: 'hwb-chip' }, '已试 ' + r.retry.used + '/' + r.retry.max))),
            h('p', { className: 'hwb-hint' }, '这些失败过但还有额度。超时/取消/环境不可用**不占**重试次数——它们不是这个节点做错了。'))
          : null,
        plan?.validation && plan.validation.errors?.length
          ? h('div', { className: 'hwb-panel-group' },
            h('p', { className: 'hwb-panel-head bad' }, '计划结构错误（' + plan.validation.errors.length + '）'),
            h('p', { className: 'hwb-hint bad' },
              plan.validation.errors.slice(0, 6).map(e => e.code === 'cycle'
                ? '环：' + (e.ring || []).join(' → ')
                : (e.code === 'self-loop' ? '自环：' + e.taskId
                  : e.code + '：' + (e.taskId || '') + ' → ' + (e.edge || ''))).join('；')),
            h('p', { className: 'hwb-hint' }, '自环与环都会让环内任务**永远不会就绪**。自环改一行即可；真环要先看清成员再断一条边。'))
          : null,
        plan?.validation && plan.validation.warnings?.length
          ? h('p', { className: 'hwb-hint' },
            '计划警告：' + plan.validation.warnings.map(w => w.code === 'quorum-clamped'
              ? '任务 ' + w.taskId + ' 的 quorum n=' + w.requested + ' 超出边数 ' + w.edges + '，已夹到上限'
              : w.code).join('；'))
          : null,
        plan?.writeScopeConflicts?.length
          ? h('div', { className: 'hwb-panel-group' },
            h('p', { className: 'hwb-panel-head' }, '写范围冲突（' + plan.writeScopeConflicts.length + ' 对）'),
            h('p', { className: 'hwb-hint' },
              plan.writeScopeConflicts.slice(0, 5).map(c => c.a + ' × ' + c.b + '（' + c.paths.join('、') + '）').join('；')),
            h('p', { className: 'hwb-hint' }, '两个都还没结束的任务会写同一批文件。这不是锁，只是提醒：官方明文没有 worktree，成员共享同一个 checkout。'))
          : null,
        plan?.termination
          ? h('p', { className: 'hwb-hint' },
            '终止性：还剩 ' + plan.termination.remaining + ' / ' + plan.termination.total + ' 个未终态'
            + (plan.termination.deleted > 0 ? '（另有 ' + plan.termination.deleted + ' 条已删除，不计入图）' : '')
            + '。' + (plan.termination.allSettled
              ? (plan.termination.hasTerminalFailure ? '整批已结束，但**有终态失败**——那是另一种结局，不是成功。' : '整批已结束。')
              : '整批还没跑完。'))
          : null,
        planErr && h('p', { className: 'hwb-hint bad' }, '执行语义读不到（' + planErr + '）——任务与图诊断不受影响。'),
        // 来源标注 + 就绪判据的来源必须分开说：磁盘路径上**官方没给 ready**，
        // 由 task-graph.js 按官方判据现算（readySource: 'computed'）。把这两件事
        // 混成一句会让「就绪是谁算的」重新变成需要读代码才知道的事。
        sourceText(data.tasksSource) && h('p', { className: 'hwb-hint' }, sourceText(data.tasksSource)),
        h('p', { className: 'hwb-hint' },
          '就绪（ready）取官方算好的判据，桥不重算；阻塞明细、关键路径与结构检查由桥补算。'
          + '写范围重叠只是提醒而不是锁：官方明文没有 worktree，成员共享同一个 checkout。'));
    }

    /**
     * **左栏全局面板图标：任务板**（0.16.0）。
     *
     * 官方 `sidebar.panellist` 的契约是「每个 list id 对应一个同名 main 面板；
     * **侧栏自己画按钮**，并从 list 元数据解析标签」。所以这个组件**只画图标**：
     * 不画标签、不加点击处理——按钮、可访问名、折叠态与选中高亮全归 shell。
     *
     * 为什么用内联 SVG 而不是官方 primitives：primitives 里没有任务板/依赖图
     * 语义的图标（现有的是代码、队列、新对话、面板）。队列图标表达的是「排队等待」，
     * 与「依赖图 + 就绪/阻塞」是两回事，用它会让入口读起来像「发送队列」。
     * 这里按官方同款几何画（16 viewBox、stroke-width 1.3、currentColor、
     * round linecap），于是明暗主题与选中态都由 shell 的颜色继承自动成立——
     * 这正是**不写死颜色**的收益，也是与 dsh-task-board 的 DOM 注入路线的分界：
     * 那条路线必须自己复刻外壳样式，这条路线的样式来自外壳本身。
     *
     * @param {{size?: number, active?: boolean}} props 官方 panel 行给的图标呈现
     */
    function TaskBoardPanelIcon(props) {
      const size = Number(props?.size) || 16;
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
      },
        h('rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 1.5 }),
        h('path', { d: 'M2 6.5h12M6.5 6.5v7' }));
    }

    /**
     * **任务板主列页面**（0.16.0）：左栏 `sidebar.panellist` 入口切过来的那一列。
     *
     * ## 与右栏那个任务板标签页的分工
     *
     * 差别不在**内容**而在**容器契约**。右栏那个是窄条常驻视图：它旁边永远还有
     * 对话，宽度只有几百像素，所以它按「一行一件事 + 省略号」排版。这里是**整列
     * 页面**：用户专门切过来看依赖图，宽度是整个中央列。因此本组件提供页面级的
     * 滚动容器与标题，内部仍然复用 `TaskBoardPanel` 的**同一套**呈现——
     * 同一个语义只画一次，否则「右栏说被阻塞 2、主列说被阻塞 3」这类漂移迟早发生。
     *
     * ## 为什么标题是写死的 h1
     *
     * 官方没有给 main 座位任何「页面标题」契约（它只给 key），而左栏行已经写了
     * 「任务板」。这里再写一次是**页面内的标题**，与侧栏按钮的可访问名各司其职：
     * 侧栏那个由 `label()` 提供，折叠成轨道时只留图标，此时页内标题是唯一的文字说明。
     *
     * @param {{useSessions?: Function, sessionId?: string}} props main 座位的标准 props
     */
    function TaskBoardMain(props) {
      return h('section', { className: 'hwb-main' },
        h('h1', { className: 'hwb-main-head' }, '任务板'),
        h(TaskBoardPanel, props));
    }

    function SiteAccounts({ sites, onRefresh, onlySiteId, subHint }) {
      const [busySite, setBusySite] = React.useState(null);
      const [results, setResults] = React.useState({});
      const list = (sites && sites.length ? sites : [])
        // 保留判定依据字段：旧实现只挑 4 个字段进列表，把后端已经算好的
        // loginBasis/loginCheckedAt 丢掉了——「未登录」于是看起来像凭空断言。
        .map(s => ({
          // accountKey（0.14.7）：`glm` 或 `glm#2`。**同一站点两个账户是两行**，
          // 所有状态与动作都必须按 accountKey 索引——用 siteId 做键会让第二行
          // 把第一行的忙碌状态、登录结果、窗口状态全部覆盖掉，界面看起来
          // 「点了账户2 却在动账户1」。旧后端无该字段时回落 siteId，可跨版本共存。
          accountKey: s.accountKey || s.siteId,
          siteId: s.siteId, slot: s.slot || null,
          // displayName 由服务端给（`智谱清言 (GLM) (账户2)`）；缺失时回落站点名。
          displayName: s.displayName || siteName(s.siteId),
          loggedIn: s.loggedIn, initialized: s.initialized, busy: s.busy,
          loggedInCached: s.loggedInCached === true, loginBasis: s.loginBasis || null,
          loginCheckedAt: s.loginCheckedAt || null, window: s.window || null,
          // 0.14.8 账户头像的状态环依据：**必须一起挑进来**。
          // 这正是上面那句注释（「旧实现只挑 4 个字段，把后端算好的字段丢掉」）
          // 警告过的同一个坑——只挑「登录三件套」会让 sessionLostCount 恒为
          // undefined，于是「会话没了」的浅红状态**永远不可能出现**：
          // ringOf 里 `undefined > 0` 是 false，账户只会显示绿/灰。
          // 缺省 0/null 而不是 undefined，便于下游直接比较。
          needLogin: s.needLogin === true,
          sessionLostCount: Number.isFinite(s.sessionLostCount) ? s.sessionLostCount : 0,
          lastSessionLost: s.lastSessionLost || null,
        }))
        .filter(s => !onlySiteId || s.siteId === onlySiteId)
        .sort((a, b) => {
          if (a.siteId === 'deepseek' && b.siteId !== 'deepseek') return -1;
          if (b.siteId === 'deepseek' && a.siteId !== 'deepseek') return 1;
          const bySite = siteName(a.siteId).localeCompare(siteName(b.siteId));
          if (bySite !== 0) return bySite;
          // 同站点内默认槽排前（与后端「默认槽总在第一位」的口径一致）
          return (a.slot ? 1 : 0) - (b.slot ? 1 : 0);
        });
      /** accountKey → { siteId, slot }：`glm#2` → { siteId:'glm', slot:'2' }。 */
      const siteSlot = (key) => {
        const i = String(key).indexOf('#');
        return i === -1 ? { siteId: key, slot: '' } : { siteId: key.slice(0, i), slot: key.slice(i + 1) };
      };
      const setResult = (sid, r) => setResults(prev => ({ ...prev, [sid]: r }));
      const [winSites, setWinSites] = React.useState({});
      /**
       * 已选中账户（0.14.8）：点心选账户即把「本会话要用的账户」切过去。
       *
       * ⚠️ **这个 useState 必须在下面那句提前 `return` 之前**（0.15.3 真机修复）。
       *
       * 它原先写在 `if (!list.length) return …` 之后，于是：
       *   • 首屏（`sites` 未到达 ⇒ `list` 为空）只执行到第 4 个 hook 就 return；
       *   • `sites` 到达后走到这一行，**本次渲染比上次多一个 hook**。
       * 真实 React 对「hooks 数量变多」是硬错误（"Rendered more hooks than during
       * the previous render"），错误冒泡到 `settings.section` 的
       * SlotErrorBoundary，**整块设置栏目被替换成空占位**——用户看到的就是
       * 「网页桥接栏目一片空白」。0.14.7 里还没有 picked，所以旧版没这个跳变。
       *
       * 为什么离线全绿：`client-render.test.mjs` 的 useState 桩是**按名字取值**的
       * 映射（不是有序链表），结构上就无法察觉 hook 顺序/数量违规；而它在切换
       * payload 时还会清空状态（第 216 行），于是「同一次挂载内 4 → 5 个 hook」
       * 这个跳变从来没有被复现过。护栏的建模失真，把整类 bug 盖住了。
       *
       * 新护栏见 `test/hooks-order.test.mjs`：它用**强制 hook 顺序规则**的桩，
       * 在同一次挂载内驱动 sites 从空到有，把这个跳变钉死。
       */
      const [picked, setPicked] = React.useState(null);
      // windows 由服务端按 accountKey 索引（0.14.7）；旧后端按 siteId，
      // 而默认槽的 accountKey 就是 siteId，因此两种形态在默认槽上等价。
      const refreshWins = () => api('window').then(w => setWinSites(w?.windows || {})).catch(() => {});
      React.useEffect(() => { refreshWins(); }, []);
      // 四个动作全部走 apiSoft：失败原因落进本行状态，绝不让整块面板崩掉。
      // （0.12.9 的 verify-login 因路由漏挂载回 405 空 body，api() 抛的是
      // JSON 解析错误而不是「HTTP 405」——原因见 lib/web-control.js 注释。）
      async function doLogin(sid) {
        setBusySite(sid); setResult(sid, null);
        // 后端要打开有头 Edge 等人工登录，超时必须放宽（等待上限 300s）。
        const r = await apiSoft('login', { ...siteSlot(sid), wait: true, timeoutMs: 300000 }, 330000);
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
        const r = await apiSoft('verify-login', { ...siteSlot(sid) }, 90000);
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
        const r = await apiSoft('session-import', { ...siteSlot(sid) }, 180000);
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
        const isOpen = !!winSites[sid]?.open;   // sid 是 accountKey，与服务端 windows 键一致
        const r = await apiSoft('window', { ...siteSlot(sid), action: isOpen ? 'close' : 'open' }, 120000);
        if (!r.ok) setResult(sid, { ok: false, text: r.error });
        else if (r.data?.alreadyOpen) setResult(sid, { ok: true, text: '窗口已存在——已聚焦弹到最前' });
        else setResult(sid, { ok: true, text: isOpen ? '独立窗口已收起，回到无头运行' : '独立窗口已打开（与桥共用登录态）' });
        setBusySite(null);
        await refreshWins();
        await onRefresh?.();
      }
      if (!list.length) return h('p', { className: 'hwb-hint' }, '站点状态加载中…（中继未启动时不可用）');
      /**
       * 状态环：三态，颜色只是**加强**而非唯一载体（`aria-label` + `title` +
       * 可见文本三者都要能读出状态）。
       *
       * 来源必须是真实读数（用户明确要求，不得造假状态）：
       *   ok     ← loggedIn === true                      （已登录）
       *   dead   ← sessionLostCount > 0 或 needLogin      （会话没了/登录失效）
       *   idle   ← 其余（待检查/未初始化）
       *
       * 「会话没了」为什么取 sessionLostCount：见 lib/index.js 的 driverStatus，
       * 该字段由驱动在 WEB_SESSION_LOST 时自增（0.14.8 起逐槽透出）。用 loggedIn
       * 冒充「会话没了」是错的——登录态还在、失效的是网页会话，两者会同时为真。
       */
      const ringOf = (s) => {
        if (s.sessionLostCount > 0 || s.needLogin === true) return 'dead';
        if (s.loggedIn === true) return 'ok';
        return 'idle';
      };
      const ringText = (s) => {
        const r = ringOf(s);
        return r === 'ok' ? '正常' : r === 'dead'
          ? (s.sessionLostCount > 0 ? '会话已失效 ' + s.sessionLostCount + ' 次' : '登录已失效')
          : '待检查';
      };
      /**
       * 点心选账户：把该账户**接上**（选中态 + 真实连接）。
       *
       * 为什么必须带 `accountKey`：`site@slot`（0.14.7）下 glm 与 glm#2 是两个
       * 独立 profile，只传 siteId 会连到默认槽——用户点「账户2」却在动账户1，
       * 正是 0.14.7 修掉的那个 bug。`siteSlot()` 负责拆 `glm#2`。
       *
       * 为什么用 apiSoft 而不是 api：连接失败（站点不可达/未登录）只该落进
       * 本行提示，不该让整块设置面板崩掉（与 doLogin/checkLogin 同一纪律）。
       */
      async function pickAccount(s) {
        setPicked(p => (p === s.accountKey ? null : s.accountKey));
        setBusySite(s.accountKey); setResult(s.accountKey, null);
        const r = await apiSoft('connect', { ...siteSlot(s.accountKey) }, 90000);
        if (!r.ok) setResult(s.accountKey, { ok: false, text: '连接失败：' + r.error });
        else setResult(s.accountKey, { ok: true, text: '已选中该账户，后续会话将使用它' });
        setBusySite(null);
      }
      return h('div', { className: 'hwb-sites' },
        list.map(s => h('div', { key: s.accountKey, className: 'hwb-site-block' },
          h('div', { className: 'hwb-site-row' + (busySite === s.accountKey || s.busy ? ' busy' : '') },
            h('span', { className: 'hwb-site-identity' },
              // 账户头像：28×28 圆框（与图标按钮同尺寸，视觉对齐——
              // doc/research/agent-ui-design-references.md §4.4「账户头像 28×28 圆」）。
              // 点击即选中该账户；已选中的加 `picked` 描边。
              h('button', {
                type: 'button',
                className: 'hwb-avatar ' + ringOf(s) + (picked === s.accountKey ? ' picked' : ''),
                // 颜色不是唯一载体：这里同时给出可读文本与 tooltip。
                'aria-label': s.displayName + '：' + ringText(s) + (picked === s.accountKey ? '（当前账户）' : ''),
                'aria-pressed': picked === s.accountKey ? 'true' : 'false',
                title: s.displayName + '：' + ringText(s) + (s.lastSessionLost ? '（最近一次：' + (s.lastSessionLost.reason || '未知原因') + '）' : ''),
                onClick: () => pickAccount(s),
              },
                // 头像内容取站点短键首字符（无图片资源，也不引入网络依赖）；
                // 真正表达状态的是外圈那一道环。
                h('span', { className: 'hwb-avatar-glyph', 'aria-hidden': 'true' },
                  (siteName(s.siteId) || s.siteId).slice(0, 1))),
              h('span', { className: 'hwb-site-name' }, s.displayName)),
            h('span', {
              className: 'hwb-site-state ' + (s.loggedIn === true ? 'ok' : s.loggedIn === false ? 'bad' : 'idle'),
              title: basisText(s),
            },
              s.loggedIn === true ? (s.loggedInCached ? '已登录(缓存)' : '已登录') : s.loggedIn === false ? '未登录' : '待检查'),
            h('span', { className: 'hwb-row-actions' },
              h('button', { disabled: busySite !== null, onClick: () => doLogin(s.accountKey) },
                busySite === s.accountKey ? '等待登录完成…' : s.loggedIn === true ? '更换账户' : '登录'),
              h('button', { disabled: busySite !== null, onClick: () => checkLogin(s.accountKey) }, '检测'),
              h('button', {
                disabled: busySite !== null,
                title: '把本机真实 Edge 里该站点的登录态导入桥 profile（读取你的 Edge cookies；无需在桥里再登录一次）',
                onClick: () => importCookies(s.accountKey),
              }, '导入本机登录态'),
              h('button', {
                disabled: busySite !== null,
                title: '在独立窗口中打开该站点真实网页（可登录、可聊天，与桥共用登录态）',
                onClick: () => toggleWindow(s.accountKey),
              }, '独立窗口'))),
          results[s.accountKey] && h('p', {
            className: 'hwb-hint indent ' + (results[s.accountKey].ok ? 'ok' : results[s.accountKey].tone === 'idle' ? '' : 'bad'),
            role: 'status',
          }, (results[s.accountKey].ok ? '✓ ' : '✗ ') + s.displayName + '：' + results[s.accountKey].text))),
        h('p', { className: 'hwb-hint indent' },
          subHint
            ? '子代理所选站点的账户行：登录/更换账户与其它站点同一套逻辑（真实 Edge 窗口一次性登录），登录态按站点各自持久化；与主线同站点时两者天然共享登录。'
            : '登录会打开真实 Edge 窗口，请在窗口内完成一次性登录（扫码/验证码/密码均可），检测到成功后自动切回无头运行。'
            + '各站点登录态分开保存在各自 profile 里，互不串号；账户失效时在这里「更换账户」即可。'));
    }

    // 0.15.10：设置页的「累计等待发送」区块（WaitStats）已删除。
    //
    // 它与输入框底下的药丸读同一份账本（/__webcode/wait-stats），同一个数字
    // 在两处各渲染一遍——用户原话是「设置界面请你删除重复的」。累计明细现在
    // 只在药丸的点击面板里出现一次（detailRows：本会话 + 累计同屏），与官方
    // 「默认只给一个数、点开才有明细」的统计药丸契约一致。

    /**
     * 设置页外壳：把「当前会话 id」接进来，再交给 `Settings` 渲染。
     *
     * ## 为什么不直接用槽的 `inject`
     *
     * 0.15.0 起本面板需要当前会话 id（花名册里的 subagentCatalog 是**会话级**
     * 投影），当时的写法是给 `settings.section` 加
     * `inject: (sessionId) => ({ sessionId })`。**那是错的**，真机 0.15.3 暴露：
     *
     *   • `settings.section` 在官方契约里是 `scope: "root"`（见
     *     dsh-cordis-client-runner 的槽目录），而 renderer 的 `runInject` 只对
     *     **带 binding 的会话级槽**传 `binding.key`；root 槽只拿到 `actions`。
     *   • 于是 `inject(sessionId)` 里的 `sessionId` 实际是那个 actions 对象——
     *     一个真值垃圾，被当成会话 id 一路传到服务端，花名册恒回
     *     `subAgentsError: "no-session-id"`，面板永远读不到成员。
     *
     * 官方给这个槽的正规入口是 standard prop **`useSessions`**（renderer 会把它
     * 作为 React hook 注进 props；官方 ui-settings-general 自己就是这么读会话的）。
     * 所以会话身份必须经它取，而不是指望 root 槽的 inject。
     *
     * ## 为什么要包一层组件
     *
     * hook 必须在组件体内无条件调用。`Settings` 是纯展示组件（它自己的 useState
     * 序列不能因为我们偶尔多调一次 hook 而变化），把会话读取放在这一层，`Settings`
     * 就继续只吃一个普通的 `sessionId` 值——这也是 `client-render.test.mjs` 直接
     * 调 `Settings(props)` 的既有契约。
     */
    function SettingsSection(props) {
      const sessionId = useCurrentSessionId(props);
      return h(Settings, { ...props, sessionId });
    }

    /** `useSessions` 缺席时的等价空实现，保证调用形态恒定（绝不条件调用 hook）。 */
    const noSessions = () => null;

    /**
     * 读当前会话 id：优先官方 `useSessions`，回落到 props 上已有的 `sessionId`。
     *
     * 回落分支是给**测试桩**与「会话尚未建立」这两种正常情况用的：此时拿不到
     * 会话身份，花名册会如实显示「读不到：no-session-id」，而不是整块面板崩掉。
     */
    function useCurrentSessionId(props) {
      const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : noSessions;
      // 无条件调用——条件调用正是本文件上方 SiteAccounts 刚踩过的那条 hooks 规则。
      const current = useSessions(s => (s && s.current) || null);
      return current || props?.sessionId || null;
    }
     /**
     * 设置页本体（纯展示）。
     *
     * `sessionId` 由 `SettingsSection` 经官方 `useSessions` 取好后作为普通 prop 传进来。
     * 这里刻意写成 `props?.sessionId` 而不是解构，因为渲染入口不止一个：
     * 宿主槽调用、以及测试里直接调 `Settings()` 都会走到这里，而
     * 「拿不到会话身份」是一个**必须能优雅降级**的正常情况（降级后花名册给
     * 「读不到：no-session-id」，而不是整块面板崩掉）。
     * 用解构会让缺 props 直接抛 TypeError，把整页设置打成白屏。
     */
    function Settings(props) {
      const sessionId = props?.sessionId || null;
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
      // 提示词投递形态（0.16.3）：'attach'（默认）| 'inline'。与 sendGapMs 同一套
      // 「草稿 / 已保存 / 提示」三件套——交互形态相同（改一下、点保存）。
      const [promptTransport, setPromptTransport] = React.useState('attach');
      const [promptTransportSaved, setPromptTransportSaved] = React.useState('attach');
      const [promptTransportNotice, setPromptTransportNotice] = React.useState('');
      // 服务端算好的投递读数（当前生效值 / 最近一次实际投递 / 探针），见
      // web-control 的 GET attach-status：文案只在服务端算一份，bundle 里不写第二份
      // （本文件是单文件 bundle，import 不到 lib/，两份格式化必然漂移）。
      const [attachStatus, setAttachStatus] = React.useState(null);
      const [probeBusy, setProbeBusy] = React.useState(false);
      const [probeResult, setProbeResult] = React.useState('');
      const refresh = () => api('status').then(s => setStatus(s)).catch(() => {});
      React.useEffect(() => {
        let alive = true;
        const poll = () => {
          api('status').then(s => { if (alive) setStatus(s); }).catch(e => { if (alive) setError(e.message); });
          // 投递读数与状态同频刷新（4s）：真机出问题时用户往往就停在这一页，
          // 读数必须自己更新——旧版本这一页对附件投递完全沉默。
          api('attach-status').then(s => { if (alive) setAttachStatus(s); }).catch(() => {});
        };
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
          // 投递形态：只有逐字 'inline' 算纯文本（与 browser-driver 的
          // promptTransportNow、web-control 的 POST settings 同一判据）。
          const pt = s.promptTransport === 'inline' ? 'inline' : 'attach';
          setPromptTransport(pt); setPromptTransportSaved(pt);
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
      /**
       * 附件探针：只上传、**绝不发送**（0.16.3）。
       *
       * 为什么需要一个按钮：「附件到底行不行」此前只能靠发一条真消息（看模型有没有
       * 读到附件）来回答——那是拿一次真实会话与一次站点风控换一个读数。真机失败读数
       * `attachTransport = {fallback:true, code:'ATTACH_NOT_CONFIRMED', total:417276}`
       * 正是卡在这上面：入口在（GET attach-entry: available:true、accept 含 .md），
       * 上传后却拿不到任何可见证据，于是 41.7 万字符整段回落纯文本。
       *
       * `apiSoft` 而不是 `api`：探针「未确认附件」时服务端回 `{ ok:false, code, … }`
       * 但 HTTP 是 200，`api` 会把 ok:false 当异常抛——那个失败现场（候选选择器 ×
       * 命中数 × DOM 片段）恰恰是最要紧的读数，不能被显示层吞掉。
       */
      async function runAttachProbe() {
        setProbeBusy(true); setError('');
        try {
          const r = await apiSoft('attach-probe', { text: '# webcode attach probe\n' + new Date().toISOString() + '\n' }, 45000);
          const d = r.data || {};
          const clean = '；清理 ' + (d.cleaned ? '成功（' + (d.cleanedBy || '') + '）'
            : '未完成（' + (d.cleanupNote || d.cleanedBy || '') + '）');
          setProbeResult(d.code
            ? '探针未确认：' + d.code + '（' + (d.chars || 0) + ' 字符' + clean + '）'
              + (d.domSnippet ? ' 现场 ' + d.domSnippet : '')
            : '探针已确认：证据 ' + (d.evidence || '(无)') + '（' + (d.chars || 0) + ' 字符' + clean + '）');
          if (!r.data) setProbeResult('探针失败：' + (r.error || '无响应'));
          const s2 = await apiSoft('attach-status');
          if (s2.ok) setAttachStatus(s2.data);
        } catch (e) { setError(String(e?.message || e)); }
        finally { setProbeBusy(false); }
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

        // 谁在跑：子代理与 Team 成员**分开两区**（0.14.9）。放在账户之后，
        // 因为「有哪些账户」是更常动的事（Apple「按重要性排序」）。
        // sessionId 一路传到花名册：subagentCatalog 是会话级投影（0.15.0）。
        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '正在运行（子代理 / Team）'),
          h(AgentRoster, { sessionId })),

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

        // 提示词投递形态（0.16.3）。用户原话：「没有做到能够把提示词放入文本
        //（设置界面也改为打开文本）导致输出对话一开头就很长 token 窗口」——
        // 附件投递此前既没有开关、也没有读数，用户改不了也看不见。
        h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '提示词投递'),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '投递形态'),
            h('div', { className: 'hwb-row-main' },
              h('label', { className: 'hwb-consent', key: 'pt-attach' },
                h('input', {
                  type: 'radio', name: 'hwb-prompt-transport', checked: promptTransport === 'attach', disabled: pending,
                  onChange: () => setPromptTransport('attach'),
                }),
                h('span', null, '附件投递（默认）')),
              h('label', { className: 'hwb-consent', key: 'pt-inline' },
                h('input', {
                  type: 'radio', name: 'hwb-prompt-transport', checked: promptTransport === 'inline', disabled: pending,
                  onChange: () => setPromptTransport('inline'),
                }),
                h('span', null, '纯文本（永远写进输入框）')),
              h('button', {
                disabled: pending || promptTransport === promptTransportSaved,
                onClick: () => saveSetting('promptTransport', promptTransport, r => {
                  const v = r.promptTransport === 'inline' ? 'inline' : 'attach';
                  setPromptTransport(v); setPromptTransportSaved(v);
                  setPromptTransportNotice('已保存。下一轮起生效（当前生效值见下方读数）。');
                }),
              }, '保存'),
              promptTransportNotice && h('span', { className: 'hwb-hint' }, promptTransportNotice))),
          h('p', { className: 'hwb-hint indent' }, '「附件投递」把超过阈值的正文改为附件上传，绕开网页输入框的写入卡死与截断（真机事故：41.7 万字符纯文本灌进输入框，整轮 112 秒零事件）；任何一步失败都会自动回落纯文本，消息不会发不出去。「纯文本」= 逐字回到旧行为。'),
          h('p', { className: 'hwb-hint indent' }, '当前生效：' + (attachStatus?.transportLine || '读数加载中…')),
          h('p', { className: 'hwb-hint indent' }, '最近一次实际投递：' + (attachStatus?.lastLine || '读数加载中…')),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '附件探针'),
            h('div', { className: 'hwb-row-main' },
              h('button', { disabled: pending || probeBusy, onClick: runAttachProbe },
                probeBusy ? '探针运行中…（只上传·不发送）' : '只上传·不发送'),
              h('span', { className: 'hwb-hint' }, probeResult || ('探针 ' + (attachStatus?.probeLine || '尚未运行。'))))),
          h('p', { className: 'hwb-hint indent' }, '探针会向当前网页会话上传一个 webcode-probe.md，上传后立即尝试清理，并如实报回证据节点、命中数与清理结果——这是「附件到底行不行」唯一不消耗真实会话的读数。')),

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
          // 0.15.10：设置页不再重复统计等待时长。累计明细已并入输入框底下那枚
          // 药丸的点击面板（同源同口径），此处只保留「速度」实测指标——用户报
          // 的「设置界面请你删除重复的」就是指这块与药丸重复的网格。
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
        // ---- 0.14.9 去臃肿：按调研出来的 token 表收紧 --------------------
        // 用户原话：「做到简洁高效美观，而不是现在的臃肿」。数值不是拍脑袋，
        // 逐条来自 doc/research/agent-ui-design-references.md §4.4 的 token 表
        //（该表由 Apple HIG 可执行约束 + Fluent 2 的 4px 阶梯 + 官方包实测值得出）：
        //   卡片圆角 16 → 12px   （Apple「简洁」取向，§4.4 明列「从现 16px 收紧」）
        //   行内边距 12 → 8px    （Fluent 基础单位 4 的倍数，§4.4「从现 12px 收紧」）
        //   标签列宽 128 → 96px  （Apple「omit unnecessary words」，§4.4 明列）
        //   行分隔线 → 删除       （Fluent 原文「spacing creates logical sections
        //                         without having to use lines」= 删线，用间距）
        // 删线而不是改成更浅的线：目标就是让分组靠**间距**表达，留着线等于没改。
        ".hwb-card{border:.5px solid var(--dsw-alias-border-l4,#8884);border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent);padding:4px 16px 10px}",
        ".hwb-group{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary,inherit);margin:16px 0 4px}",
        ".hwb-group.first{margin-top:16px}",
        // 分隔靠间距：行间距 8px（§4.4）取代原来的 1px 底线。
        // gap 同时承担「分组内行距」，因此这里用 row-gap 让相邻两行分开。
        ".hwb-row{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;padding:8px 0}",
        ".hwb-row-label{flex:0 0 96px;min-width:96px;font-size:13px;line-height:20px;padding-top:6px;color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-row-main{flex:1;min-width:240px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
        ".hwb-row button,.hwb-settings button{height:32px;padding:0 14px;font:inherit;font-size:13px;line-height:30px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:.5px solid var(--dsw-alias-border-l3,#8885);border-radius:12px;cursor:pointer;transition:background .12s ease}",
        ".hwb-row button:hover:not(:disabled),.hwb-settings button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8882)}",
        ".hwb-row button:disabled,.hwb-settings button:disabled{opacity:.45;cursor:default}",
        ".hwb-model-select,.hwb-prompt-input{min-width:220px;max-width:340px;padding:6px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:.5px solid var(--dsw-alias-border-l3,#8885);border-radius:8px}",
        ".hwb-prompt-input{width:100%;max-width:none;min-height:96px;line-height:1.5;font-family:inherit;resize:vertical}",
        ".hwb-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin:4px 0 0}",
        ".hwb-hint.indent{margin:6px 0 8px}",
        ".hwb-hint.ok{color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-hint.bad{color:var(--dsw-alias-state-error-primary,#93443e)}",
        ".hwb-consent{display:flex;align-items:center;gap:8px;font-size:13px}",
        ".hwb-sites{display:flex;flex-direction:column;gap:8px}",
        // 同一条「删线，用间距」：账户块之间靠 8px 间距（由 .hwb-sites 的 gap 提供）
        // 分开，不再画 1px 底线。
        ".hwb-site-block{padding:0}",
        ".hwb-site-row{display:flex;align-items:center;gap:12px;padding:4px 0;flex-wrap:wrap}",
        ".hwb-site-row.busy{opacity:.55}",
        ".hwb-site-identity{flex:1;display:inline-flex;align-items:center;gap:8px;min-width:140px;font-size:13px}",
        ".hwb-site-name{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit)}",
        ".hwb-row-actions{display:inline-flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}",
        ".hwb-row-actions button{height:28px;line-height:26px;padding:0 12px;font-size:12px;border-radius:14px}",
        ".hwb-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;background:var(--dsw-alias-label-tertiary,#9aa0a6)}",
        ".hwb-dot.ok{background:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-dot.bad{background:var(--dsw-alias-state-error-primary,#93443e)}",
        // 账户头像（0.14.8）：28×28 圆框 + 外圈状态环。
        // 尺寸取自 doc/research/agent-ui-design-references.md §4.4「账户头像 28×28 圆」
        // （与图标按钮同尺寸，视觉对齐）。圆角用 50% 而非固定 px——等比圆框。
        // 状态环用 `border` 实现（而不是 outline/box-shadow）：border 参与布局，
        // 三种状态的框大小恒定，切换时不会让整行跳动。
        // 颜色**不是唯一载体**：aria-label/title/可见文本都带状态，见 SiteAccounts.
        ".hwb-avatar{width:28px;height:28px;padding:0;flex:none;border-radius:50%;cursor:pointer;background:transparent;display:inline-flex;align-items:center;justify-content:center;border:2px solid var(--dsw-alias-label-tertiary,#9aa0a6)}",
        ".hwb-avatar.ok{border-color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-avatar.dead{border-color:var(--dsw-alias-state-error-primary,#93443e)}",
        ".hwb-avatar.picked{box-shadow:0 0 0 2px var(--dsw-alias-label-primary,#1f2328)}",
        ".hwb-avatar:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px}",
        ".hwb-avatar-glyph{font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary,inherit);pointer-events:none}",
        // 花名册（0.14.9）：子代理缩进、Team 平级。
        // 缩进用 padding-left（24px = Fluent size240）而不是符号/颜色——层级是
        // 空间关系，用空间表达最直接；颜色已经被「状态」占用，复用会语义冲突。
        ".hwb-roster{display:flex;flex-direction:column;gap:12px;padding:4px 0}",
        ".hwb-roster-group{display:flex;flex-direction:column;gap:4px}",
        ".hwb-roster-head{font-size:12px;line-height:18px;margin:0;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
        ".hwb-roster-row{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;min-height:24px}",
        ".hwb-roster-row.nested{padding-left:24px}",
        ".hwb-roster-name{color:var(--dsw-alias-label-primary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".hwb-roster-state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);flex:none}",
        ".hwb-roster-task{font-size:12px;line-height:18px;padding:0 8px;border-radius:9px;flex:none;color:var(--dsw-alias-label-secondary,inherit);border:.5px solid var(--dsw-alias-border-l3,#8885)}",
        // 成员跑在哪个模型上：与「任务 N」同族的只读小标签，但不是计数，
        // 所以不给边框（边框在本面板里一直表示「一条可读的状态/计数」）。
        ".hwb-roster-model{font-size:12px;line-height:18px;flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98);max-width:40%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".hwb-site-state{font-size:12px;line-height:18px;padding:1px 8px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3,#8885);color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-site-state.ok{color:var(--dsw-alias-state-success-primary,#2e7d32);border-color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-site-state.bad{color:var(--dsw-alias-state-error-primary,#93443e);border-color:var(--dsw-alias-state-error-primary,#93443e)}",
        ".hwb-metrics{display:flex;flex-direction:column;gap:6px;width:100%}",
        ".hwb-metrics-head{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-bottom:2px}",
        ".hwb-badge{display:inline-block;font-size:11px;line-height:16px;padding:0 8px;margin-right:6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,#8885);color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-badge.measured{color:var(--dsw-alias-state-success-primary,#2e7d32);border-color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-bar-row{display:flex;align-items:center;gap:12px}",
        // 输入框底下的等待药丸（0.15.11）。
        //
        // 取值与尺寸逐项抄自官方 ui-chat 的 StatsPills.module.css：药丸
        // 28px 高、border-radius 24px、padding 1px 8px、gap 6px、14px 线框图标，
        // 悬停/展开用 interactive-bg-hover + label-secondary。
        //
        // 「同栏」由结构决定、不靠边距（0.15.11 重做）：找到官方统计行
        //（[data-composer-stats]）后由 React portal 把本节点挂进去，它就成了
        // 该行的兄弟 flex 子项，居中/间距/换行全归官方那条 CSS 管。只有官方行
        // 缺席时才自建一行，样式逐字抄 StatsPills.root（见下条规则）——两处
        // 视觉因此一致，也没有任何写死的偏移量会在侧栏挤窄时错位重叠。
        ".hwb-waitwrap{position:relative;display:inline-flex;min-width:0}",
        // 官方行缺席时的自建行：逐字抄 StatsPills.root
        //（width/max-width/padding/justify-content/gap/margin/font-size）。
        ".hwb-waitwrap[data-webcode-wait]{display:flex;box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width);margin:0 auto;padding:4px calc(var(--dsh-composer-side-clearance,16px) + 16px) 0;justify-content:center;gap:12px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}",
        ".hwb-waitpill{box-sizing:border-box;max-width:100%;height:28px;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;font:inherit;font-size:13px;line-height:24px;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a8f98);background:0 0;border:none;border-radius:24px;cursor:pointer;transition:background .12s ease,color .12s ease}",
        ".hwb-waitpill:hover,.hwb-waitpill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-waitpill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px}",
        ".hwb-waitpill svg{flex:none;width:14px;height:14px}",
        ".hwb-waitpill-label{min-width:0;overflow:hidden;text-overflow:ellipsis}",
        // 点击面板：尺寸/圆角/阴影/网格逐项对齐官方 stat-dialog.module.css。
        // 向上展开（bottom:calc(100% + 8px)）而不是向下，因为药丸本身就在输入框
        // 底下，向下会盖住输入框——官方那两枚药丸同样朝上开。
        ".hwb-waitpanel{position:absolute;bottom:calc(100% + 8px);right:0;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);padding:16px;border-radius:12px;border:0;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#fff));box-shadow:var(--dsw-elevation-prominent,0 8px 24px #0003);color:var(--dsw-alias-label-secondary,inherit);font-size:12px;line-height:18px;cursor:default;text-align:left}",
        ".hwb-waitpanel-head{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:8px;color:var(--dsw-alias-label-primary,inherit);font-weight:500}",
        ".hwb-waitpanel-title{display:inline-flex;align-items:center;gap:6px;min-width:0}",
        ".hwb-waitpanel-title svg{flex:none;width:14px;height:14px}",
        ".hwb-waitpanel-value{font-variant-numeric:tabular-nums}",
        ".hwb-waitpanel-rule{border-top:.5px solid var(--dsw-alias-border-l2,#8883);margin-bottom:10px}",
        ".hwb-waitpanel-grid{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0}",
        ".hwb-waitpanel-row{display:contents}",
        ".hwb-waitpanel-grid dt,.hwb-waitpanel-grid dd{min-width:0;margin:0}",
        ".hwb-waitpanel-grid dt{color:var(--dsw-alias-label-tertiary,#8a8f98)}",
        ".hwb-waitpanel-grid dd{color:var(--dsw-alias-label-secondary,inherit);font-variant-numeric:tabular-nums;text-align:right}",
        ".hwb-waitpanel p{margin:0}",
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
        // ---- Team 面板 / 任务板面板（0.15.12）--------------------------------
        //
        // 尺寸与间距逐条来自 doc/research/agent-ui-design-references.md 的既有约束，
        // 不新造数值：
        //   • 基础间距 4px 的倍数（Fluent 基础单位）；分组间距 16px（§4「分区间距」）。
        //   • 行高 20px / 字号 13px 与官方行一致（§4「控件高度 28px、状态点 8px」同族）。
        //   • 状态点复用已有的 .hwb-dot（8px），不新写一套——同一个语义只有一个载体。
        //   • 颜色全部走 token + fallback（§3.2 硬约束 1），不新增硬编码色值。
        //   • 删线用间距（§2「spacing creates logical sections without lines」）：
        //     分组之间只有 16px 间距，没有分隔线。
        //
        // 两个面板共用一套类名，因为它们的信息结构相同（摘要行 + 若干分组 + 若干行），
        // 差别只在数据来源。两套类名会让「任务板的行高比 Team 面板大一像素」这类
        // 漂移永远没人发现。
        ".hwb-panel{display:flex;flex-direction:column;gap:16px;padding:12px 12px 16px;color:inherit;font-size:13px;line-height:20px}",
        ".hwb-panel-summary{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
        ".hwb-panel-stat{font-size:12px;line-height:18px;padding:1px 8px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l3,#8885);color:var(--dsw-alias-label-secondary,inherit);font-variant-numeric:tabular-nums;white-space:nowrap}",
        ".hwb-panel-stat.ok{color:var(--dsw-alias-state-success-primary,#2e7d32);border-color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-panel-stat.bad{color:var(--dsw-alias-state-error-primary,#93443e);border-color:var(--dsw-alias-state-error-primary,#93443e)}",
        ".hwb-panel-group{display:flex;flex-direction:column;gap:4px}",
        ".hwb-panel-head{font-size:12px;line-height:18px;margin:0 0 4px;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
        ".hwb-panel-head.bad{color:var(--dsw-alias-state-error-primary,#93443e)}",
        // 行：状态点 + 标题 + 若干小标签 + 状态词。
        // 标题 flex:1 且允许省略号——任务标题可能很长，而右侧的状态/归属必须
        // 永远可见（那些才是「能不能开工」的判据，不能因为标题长就被挤掉）。
        ".hwb-panel-row{display:flex;align-items:center;gap:8px;min-height:24px}",
        ".hwb-panel-title{flex:1;min-width:0;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".hwb-panel-meta{font-size:12px;line-height:18px;flex:none;max-width:40%;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".hwb-panel-state{font-size:12px;line-height:18px;flex:none;color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-panel .hwb-hint.bad{color:var(--dsw-alias-state-error-primary,#93443e)}",
        // 小标签（角色 / 归属 / 任务数 / 写范围告警）：与 .hwb-roster-task 同形，
        // 但独立命名——那个类挂在设置页花名册下，跨面板复用会让两处样式耦合。
        ".hwb-chip{font-size:12px;line-height:18px;padding:0 8px;border-radius:9px;flex:none;white-space:nowrap;color:var(--dsw-alias-label-secondary,inherit);border:.5px solid var(--dsw-alias-border-l3,#8885)}",
        ".hwb-chip.warn{color:var(--dsw-alias-state-error-primary,#93443e);border-color:var(--dsw-alias-state-error-primary,#93443e)}",
        // 空态/加载态：与官方 guide 卡片同一套措辞位置（顶部对齐、不要垂直居中——
        // 面板常常是窄条，垂直居中的空态会飘在中间显得像加载失败）。
        ".hwb-panel>p.hwb-hint{margin:0}",
        // 左栏入口切过来的主列页面（0.16.0）。滚动与页面内边距归**容器**，
        // 面板内部继续用 .hwb-panel 那一套——同一个语义只有一份排版。
        // box-sizing 必须显式写：中央列的高度由 frame 的 grid 给定，
        // 少这一句 padding 会把容器撑出可视区，底部一行永远滚不到。
        ".hwb-main{height:100%;box-sizing:border-box;overflow:auto;padding:16px 20px}",
        ".hwb-main-head{margin:0 0 12px;font-size:15px;line-height:24px;color:var(--dsw-alias-label-primary,inherit)}",
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
          // 0.15.3：**不再给这个槽写 `inject: (sessionId) => …`**。
          //
          // `settings.section` 是 `scope: "root"`，renderer 只对带 binding 的会话级槽
          // 传 `binding.key`；root 槽的 inject 拿到的是 actions 对象。旧写法因此把那个
          // 对象当成会话 id 送到服务端，花名册恒回 `no-session-id`（真机 0.15.3 实测）。
          // 会话身份改由 `SettingsSection` 经官方 standard prop `useSessions` 取——
          // 官方 ui-settings-general 自己就是这么读会话的。
          return ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section', id: 'webcode', order: 110,
            label: () => '网页桥接',
          }, SettingsSection));
        } catch (e) { warn('settings section', e); }
      });

      // ---- 官方右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right）--------
      //
      // 三个标签页，各自一个独立的 kind：
      //   • webcode-bridge —— 网页镜像（可多开、可浮动）；
      //   • webcode-team   —— Team 面板：谁在团队里、各自在忙什么；
      //   • webcode-tasks  —— 任务板：依赖图、就绪/阻塞、关键路径。
      //
      // 为什么是**三个 kind** 而不是一个 kind 内部再分栏：官方契约（tab-registry.d.ts）
      // 里 kind 就是「这是什么类型的标签页」，每个 kind 有自己的标题、地址识别与
      // guide 入口；合成一个的话，标签条上会出现三个同名标签，浮动/分屏也无法按
      // 类型定位。而 pane.tab 座位是 keyed 的（按定义 id 派发），三个 kind 各注册
      // 自己的 body 即自然成立。
      const TAB_ID = 'dsh-webcode-bridge';
      const TAB_KIND = 'webcode-bridge';
      const TEAM_ID = 'dsh-webcode-bridge/team';
      const TEAM_KIND = 'webcode-team';
      const TASKS_ID = 'dsh-webcode-bridge/tasks';
      const TASKS_KIND = 'webcode-tasks';
      // 左栏全局面板（`sidebar.panellist` + `main`）的 id。与上面两个是**不同域**：
      // 那两个是右侧栏的标签页类型/实例 id，这个既是侧栏行的 list id、也是中央列
      // main 座位的 key——官方契约要求这两者**逐字相同**（「Each list id addresses
      // the matching main panel」）。因此只注册侧栏那一半是不成立的，见下方注册处。
      const TASKS_PANEL_ID = 'webcode-tasks-panel';
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

      // ---- Team 面板标签页（0.15.12）------------------------------------
      //
      // 两个新面板都**不接 address**（patterns 省略）：它们是 page type——
      // 官方契约说得很清楚，省略 patterns 的类型「is opened by kind」，
      // 不做地址识别。团队与任务板本来就没有「打开某个资源」的语义。
      own(() => {
        try {
          return ctx.sidebarRightTabs.register({
            id: TEAM_ID,
            kind: TEAM_KIND,
            priority: 'extension',
            title: () => 'Team',
            guide: [{
              order: 56,
              title: () => 'Team 面板',
              description: () => '谁在这个团队里、各自在忙什么：角色、模型、任务归属与可唤醒状态（只读）',
            }],
          });
        } catch (e) { warn('sidebarRightTabs.register (team)', e); }
      });
      own(() => {
        try {
          return ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab', key: TEAM_ID,
          }, TeamPanel));
        } catch (e) { warn('pane.tab body (team)', e); }
      });

      // ---- 任务板标签页（0.15.12）---------------------------------------
      own(() => {
        try {
          return ctx.sidebarRightTabs.register({
            id: TASKS_ID,
            kind: TASKS_KIND,
            priority: 'extension',
            title: () => '任务板',
            guide: [{
              order: 57,
              title: () => '任务板',
              description: () => '依赖图视角：可开工 / 被阻塞 / 进行中 / 已完成，含当前阻塞点与关键路径（只读）',
            }],
          });
        } catch (e) { warn('sidebarRightTabs.register (tasks)', e); }
      });
      own(() => {
        try {
          return ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab', key: TASKS_ID,
          }, TaskBoardPanel));
        } catch (e) { warn('pane.tab body (tasks)', e); }
      });

      // ---- 左栏全局面板入口：任务板（0.16.0）-----------------------------
      //
      // ## 为什么走官方槽而不是注入 DOM
      //
      // 参考实现（reference/dsh-task-board 的 sidebar-entry-core.ts）走的是
      // **DOM 注入**：它自己 new 一个 button、插在 New Session 按钮后面，再用
      // MutationObserver 自愈。那份代码的注释把原因写得很直白——「dsh 的侧栏
      // shell 没有暴露任何外部插件可注册的槽」。
      //
      // **那个前提在官方这一版已经不成立**。实测 slots 目录里存在
      // `sidebar.panellist`（list、scope root），它的契约原文是：
      //
      //   > Global panel icons. Each list id addresses the matching main panel;
      //   > the sidebar owns the button and resolves its label from list metadata.
      //
      // 也就是说：**按钮由 shell 自己画**（`PanelRow`，含 Tooltip、aria-current、
      // 折叠成 56px 轨道时的 18px 图标、选中高亮），我们只提供图标 + 标签。
      // 位置也天然正确：shell 的渲染顺序就是 logoRow → New Session → panelList →
      // workspace 浏览器，所以「新开对话下方」是**结构保证**，不是靠 insertBefore
      // 抢位置。相比之下 DOM 注入要自己复刻外壳样式、自己盯重渲染，
      // 且一旦官方换 class 名（`[class*="newSession"]` 这种模糊匹配）就会静默插错位置。
      //
      // 因此本轮**不引入那条路线**。这不违背「取代 agent-team 的设计理念」：
      // 要保留的是「左栏固定入口 + 中央列面板」这个**交互结构**，而它现在能用
      // 官方一等公民的槽实现——比 DOM 注入更强，因为它连键盘导航与折叠态都自动正确。
      //
      // ## 两半必须成对
      //
      // 契约后半句是关键：「Each list id **addresses the matching main panel**」。
      // 侧栏行只是一个指向 main 座位的按钮——点它走的是 shell 的 `selectPanel(id)`，
      // 而那个动作会**校验 main 座位是否已注册**（layout service：
      // `layout.selectPanel: main panel "X" is not registered` 会抛）。
      // 所以只注册侧栏那一半 = 用户点一下就报错。两半的 key/id 必须逐字相同。
      own(() => {
        try {
          return ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: TASKS_PANEL_ID,
            // order 40：排在官方既有的全局面板行之后（它们用默认 0），
            // 不与任何内置行抢位置；同 order 时按注册顺序，桥是最后挂载的。
            order: 40,
            label: () => '任务板',
          }, TaskBoardPanelIcon));
        } catch (e) { warn('sidebar.panellist entry', e); }
      });

      // 中央列页面本体：key 与上面的 id 逐字相同。
      // `main` 是 **keyed** 座位（scope root），官方默认已占用 key `conversation`；
      // 我们用自有 key，因此不会遮蔽对话——两者由 shell 按 activePanelId 二选一渲染。
      own(() => {
        try {
          return ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main', key: TASKS_PANEL_ID,
          }, TaskBoardMain));
        } catch (e) { warn('main panel body (tasks)', e); }
      });

      // ---- 标签动作菜单项：刷新 / 独立窗口（DSH 规范入口） --------------
      // 规范要求菜单项作用于「当前标签」并在动作后关闭菜单（dismiss 必须调，
      // 否则菜单会浮在被换掉的内容上）。动作本身由面板登记（actions 桥）。
      //
      // 0.15.12：菜单项现在**只对网页标签页显示**。官方契约原文是「Entries
      // decide their own visibility from the tab they are given」（slots.d.ts 的
      // `sidebar.right.tab.menu.item`），因此 owner.tab 必须被用起来。
      //
      // 为什么必须加这道判断：本轮之前只有一个 kind，菜单项出现在每个标签上是
      // 「碰巧正确」；新增 Team / 任务板两个 kind 后，那两项会照样出现在它们
      // 的菜单里，而 `actions.currentSite()` 返回的是「最后挂载的网页面板」的
      // 站点——在团队标签页上点「刷新网页」，刷的是另一个面板，用户完全看不出
      // 发生了什么。这类「点错了地方、但界面有反应」的错最贵。
      //
      // 返回 null（而不是空按钮）是官方允许的：菜单渲染时跳过空条目。
      const menuItem = (key, label, run) => function TabMenuItem(owner) {
        if (String(owner?.tab?.kind || '') !== TAB_KIND) return null;
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
