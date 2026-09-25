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
//   2. 原生设置页「网页桥接」分区（settings.section）：账户/登录、站点模型、提示词；
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
    // 0.16.39：重新 require `createPortal`——**用途与 0.16.18 删掉的那次完全不同**。
    //
    // 那一次是拿 portal 去「塞进官方统计行」（补偿旧结构），新结构里那是 bug 源，
    // 所以删了。这一次是给**我们自己的**等待统计弹层用：官方自己的 stat-dialog
    // 也是 portal 到 body 的（`createPortal(panel, document.body)`），因为弹层必须
    // 逃出右栏面板的 `overflow:hidden` 与 `transform` 包含块，才能做到「左边缘与
    // 药丸左边缘对齐 + 视口夹紧」。不 portal 就只能像旧实现那样 `position:absolute;
    // right:0`——那正是用户要修掉的「右边缘对齐」。
    //
    // 降级：宿主没给 createPortal 时返回 null，WaitLine 回落到内联面板（降级不是崩溃）。
    const createPortal = (() => { try { return require('react-dom').createPortal || null; } catch { return null; } })();
    // 0.16.22：站点图标与选择框（见下方 SiteGlyph / SitePicker）。
    // FishLogo 是**官方**鲸鱼矢量（dsh-client-ui-primitives 自带，viewBox 23.16×17.04、
    // 单条填充路径、透明底、随 currentColor），官方自己的侧栏 logo 就用它——
    // 因此 DeepSeek 这一项零新增依赖、零新增资产文件。
    // useDismissOnOutsidePointer 是官方弹层关闭契约；选择框不自己写
    // document 级 pointerdown 监听，避免与官方菜单的重叠关闭互相打架。
    //
    // 0.16.23：解构必须留回退。本文件是单文件 bundle，四个面板（设置页 / 右栏 /
    // 等待药丸 / 任务板）都在同一个 factory 里，任何一个导出缺位后**在渲染期被当
    // 组件调用**，都会让整棵树抛错变白屏（真机教训：0.16.21 误打包的半成品里
    // 无回退解构 + 测试桩缺导出，6 条渲染测试全崩）。回退语义是「降级不是崩溃」：
    //   · 图标组件缺位 → 返回 null 的空组件（该枚图标画不出，面板照常）；
    //   · FISH_LOGO_VIEWBOX 缺位 → 官方注释里的真实值（23.16×17.04）；
    //   · useDismissOnOutsidePointer 缺位 → no-op（外点关闭退化为 Esc/再点触发器）。
    // 旧版本 primitives（< 0.1.6）没有 FishLogo/FISH_LOGO_* 导出时走的就是这套。
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    /**
     * 取一颗官方图标组件：**按「这一代 + 上一代」两套名字依次找**，都取不到才回退空组件。
     *
     * 为什么不能只写一个名字（0.19.2 的真机事故）：DSH 0.1.7-alpha.2 把 primitives 的
     * 图标导出整体改了名——`IconXxxOutline14` / `IconXxxOutline16` 变成
     * `IconXxxOutlineRegular`（同族还有 `…Medium`，1.3px 描边）。**同一颗图标、同一个
     * 尺寸**，只是名字不再带像素后缀；旧名在 0.1.7 里一个都不剩。
     *
     * 于是任何一处「无兜底解构 + 渲染期当组件调用」都会变成
     * `h(undefined)` → React 抛错 → 整棵注册树崩掉。真机症状正是用户报的
     * 「底部发送等待时间没了」：`IconQueueOutline14` 为 undefined，等待药丸那一块
     * 在渲染期抛错，而控制台里看不到本插件自己的告警。
     *
     * 这与 0.16.21 那次白屏是同一形状（无回退解构 + 桩缺导出 → 6 条渲染测试全崩），
     * 因此沿用同一判据：**取名字时就把两代名字都列出来**。多写一个字符串的成本，
     * 换的是「官方改一次名就静默少一块 UI」这类缺陷不再发生。
     *
     * @param {...string} names 候选导出名，按优先级排列
     * @returns {Function} 官方图标组件，或一个返回 null 的等价空组件
     */
    const iconOf = (...names) => {
      for (const n of names) { if (typeof primitives[n] === 'function') return primitives[n]; }
      return () => null;
    };
    const IconCodeOutline16 = iconOf('IconCodeOutline16', 'IconCodeOutlineRegular');
    const IconQueueOutline14 = iconOf('IconQueueOutline14', 'IconQueueOutlineRegular');
    // 0.16.39：官方统计弹层的定位钩子（与官方 stat-dialog 同一颗）。
    // 官方的等待/用量药丸就是这么摆的：`side:'top', gap:8, margin:12`，返回
    // `{left, top}` 固定坐标 —— **左边缘与药丸左边缘对齐**、贴近视口时夹紧在
    // 12px 内。旧实现自己写 `position:absolute;right:0`，于是面板永远贴右边缘，
    // 与药丸的左对齐视觉不成立；且 `absolute` 会被右栏面板的 `transform` 包含块
    // 劫持（「要考虑缩放关系」的实质）。
    // 缺位时回落 null，WaitLine 走内联分支（降级不是崩溃）。
    const useAnchoredPosition = primitives.useAnchoredPosition || (() => null);
    // 0.16.39：工具条图标换成官方 primitives 的线框图标（用户：「页面内顶部右侧
    // 那些功能的图标有点不符合整体审美，适配下官方 ui」）。
    //
    // 旧实现用的是字符字形 `↻ ▣ ⧉ ◫`——它们随字体变、光学大小与粗细不一致，
    // 与官方那排 15px 线框图标并排时一眼能看出不是一套。官方包里的对应关系：
    //   IconRefreshOutline14     刷新（官方 browser 工具条的 reload 就是它）
    //   IconRightUpOutline16     独立窗口（官方 browser 的外部打开就是它）
    //   IconFullscreenOutline16  新面板分屏（把网页放到另一块面板里）
    //   IconPanelLeftOutline16   浮动面板（官方右栏的分屏/面板图标族）
    // 0.19.2：五个名字都补上 0.1.7 的 `…Regular` 别名（改名事实见 iconOf 的注释）。
    const IconRefreshOutline14 = iconOf('IconRefreshOutline14', 'IconRefreshOutlineRegular');
    const IconRightUpOutline16 = iconOf('IconRightUpOutline16', 'IconRightUpOutlineRegular');
    const IconFullscreenOutline16 = iconOf('IconFullscreenOutline16', 'IconFullscreenOutlineRegular');
    const IconPanelLeftOutline16 = iconOf('IconPanelLeftOutline16', 'IconPanelLeftOutlineRegular');
    const IconGlobe = iconOf('IconGlobeOutline14', 'IconGlobeOutlineRegular',
      'IconBrowseOutline16', 'IconBrowseOutlineRegular');
    // 0.16.35：`Menu` 不再解构。它曾服务于工具条那颗站点下拉按钮（0.16.33 的二级菜单），
    // 而用户 0.16.35 明确不要那颗按钮，`SiteMenu` 随之删除——保留一个不再使用的解构，
    // 只会让旧版 primitives 的「缺位回退」注释看起来仍然重要。
    //
    // 若将来还要官方菜单：`primitives.Menu` 自带 `submenu`（右侧展开的子卡片），是
    // 「同站点多账户」的正规形态；但**必须**把 `useDismissOnOutsidePointer` 的 rootRef
    // 挂在同时包住触发按钮与列表的那层元素上（0.16.35 前那个「点了没反应」的根因）。
    const FishLogo = primitives.FishLogo || (() => null);
    const FISH_LOGO_PATH = primitives.FISH_LOGO_PATH || '';
    const FISH_LOGO_VIEWBOX = primitives.FISH_LOGO_VIEWBOX || { width: 23.16, height: 17.04 };
    const useDismissOnOutsidePointer = primitives.useDismissOnOutsidePointer || (() => {});
    const h = React.createElement;
    // 0.16.37：站点目录改成官方的**胶囊行**，因此要用官方三颗原语：
    //   · `Button`（variant:'ghost'）——官方 `TerminalGuide` 正是用它在胶囊里承载
    //     主区（图标+标题+说明）与右侧 44px 展开区。自己写 <button> 会丢掉官方
    //     的 ghost 配色与按下态，那正是「排版一样」最容易露馅的地方。
    //   · `Menu`——官方下拉（自带键盘走行 / 边界翻转 / portal / 外侧关闭）。
    //   · `IconChevronDownOutline14`——胶囊右端那颗 chevron，与官方同一颗图标。
    // 三者都按本文件既有的「降级不是崩溃」取（0.16.23 立下的规矩）：旧版 primitives
    // 缺位时回退成空组件，面板照常渲染，只是该处退化。
    const Button = primitives.Button || (({ children, ...rest }) => h('button', { type: 'button', ...rest }, children));
    const Menu = primitives.Menu || (() => null);
    const IconChevronDown = iconOf('IconChevronDownOutline14', 'IconChevronDownOutlineRegular');
    // 等待统计用的图标：官方 primitives 没有 gauge/clock 图标，队列图标是同一
    // 语义域里最近的一个（「还没轮到发送」）。与官方一样只取 14px 线框图标。
    const IconWait = ({ size }) => h(IconQueueOutline14, { size });
    const inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];
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
      // 0.19.0 对账 262（roster.js `projectTasks` 落库回落分支把 `source` 置成
      // `'ledger'`，此前这里没有该键的映射 → 路基任务板最常见的来源反而**不显示**
      // 出处标注，看起来像「数据来源不明」。补上：`ledger` = 桥自有任务台账。
      if (src === 'ledger') return '来源：桥自有任务台账（.webcode-tasks/ledger.json）';
      if (src === 'disk') return '来源：磁盘状态（AgentTeams 未提供实时数据）';
      return null;
    }

    const MODEL_NAMES = { deepseek: 'DeepSeek' };
    // 站点显示名 + 多站点模型目录（打开时从 /__webcode/models 拉取）
    const SITE_NAMES = { deepseek: 'DeepSeek', glm: '智谱清言', chatgpt: 'ChatGPT', kimi: 'Kimi', qwen: '通义千问', doubao: '豆包', grok: 'Grok', claude: 'Claude', gemini: 'Gemini', zai: 'Z.ai' };
    const siteName = sid => SITE_NAMES[sid] || sid;
    /**
     * 毫秒时间戳 → `<input type="datetime-local">` 要的**本地时间**字符串。
     *
     * 为什么不能用 `toISOString().slice(0,16)`：那是 **UTC**。用户在东八区会看到
     * 差 8 小时的时间；更要命的是「读出来 → 原样存回去」会把时间**每次打开漂一次**，
     * 而界面上完全看不出来（数字看着都合理）。因此按本地时区手工拼这个字符串。
     *
     * 空/非法值一律回 `''`（不是 `undefined`）：受控 input 的 value 为 undefined
     * 会让 React 把它变成非受控组件并打警告。
     *
     * @param {number|null|undefined} ms 毫秒时间戳
     * @returns {string} `YYYY-MM-DDTHH:mm`，或空串
     */
    function toLocalInputValue(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) return '';
      const d = new Date(n);
      const p = (x) => String(x).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    /**
     * 毫秒时间戳 → 可读的本地时间文本（面板上显示创建/更新时间用）。
     * 读不到就给一个**明确说读不到**的占位，而不是 `Invalid Date` 这种假值。
     *
     * @param {number|undefined} ms 毫秒时间戳
     * @returns {string}
     */
    function formatStamp(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) return '读不到';
      return new Date(n).toLocaleString();
    }
    const SITE_ORIGINS = {
      deepseek: 'https://chat.deepseek.com',
      glm: 'https://chatglm.cn',
      chatgpt: 'https://chatgpt.com',
      kimi: 'https://kimi.com',
      qwen: 'https://chat.qwen.ai',
      doubao: 'https://www.doubao.com',
      grok: 'https://grok.com',
      claude: 'https://claude.ai',
      gemini: 'https://gemini.google.com',
      zai: 'https://chat.z.ai',
    };
    const siteOrigin = sid => SITE_ORIGINS[sid] || '';

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
      // 0.16.31：先报**口径**再报数字。两个口径下「距上次…」是完全不同的量，
      // 不标出用的是哪把尺子，用户只能看到「等待不是按我设的来」而无法定位。
      const replyBasis = m.gapBasis === 'end-to-start';
      const sinceLabel = replyBasis ? '距上次回复完成 ' : '距上次发送 ';
      if (m.gapTargetMs > 0) parts.push('目标 ' + (m.gapTargetMs >= 1000 ? (m.gapTargetMs / 1000).toFixed(1) + ' s' : m.gapTargetMs + ' ms'));
      if (m.gapBasis) parts.push(replyBasis ? '基准 距上次回复完成' : '基准 距上次发出');
      if (m.sincePrevSendMs != null) {
        const secs = (m.sincePrevSendMs / 1000).toFixed(1) + ' s';
        parts.push(m.sendWaitMs > 0 ? sinceLabel + secs : '未等待（' + sinceLabel + secs + ' 已满足）');
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
     * 设置页「速度与等待」里的**等待总时长**统计块（0.16.39）。
     *
     * ## 为什么现在才把它加回来（0.15.10 曾以「重复」为由删掉）
     *
     * 0.15.10 删掉的是**与药丸逐字重复**的那块网格：同一个数字、同一个位置感、
     * 两处都叫「累计等待发送」，用户看哪个都行，于是「设置界面请你删除重复的」
     * 成立。现在这一块不同：它是**两本账并排**的只读总览（本会话 / 历史累计），
     * 外加平均每次与限流重试——这些数在药丸点开的那枚小面板里放不下，也不适合
     * 常驻在输入框底下。数据仍来自**同一个** `/__webcode/wait-stats` 端点、
     * 服务端用同一个 formatDuration 现算（新增的 `statBlocks` 字段就是为此），
     * 因此不会出现「药丸一个数、设置页另一个数」。
     *
     * ## 口径纪律
     *
     * 本组件**不自己算任何时长、也不判断哪些行该出现**：服务端给什么就渲染什么
     * （`statBlocks` 是 `[{title, rows:[{label,value}]}]`）。本文件是单文件 bundle，
     * import 不到 lib/wait-stats.js，在这里再写一份格式化就是两条口径的开始。
     *
     * 加载中 / 读不到都如实说，不用 0 冒充——「读不到」与「确实是 0」必须可区分。
     */
    function WaitTotals({ metrics }) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      React.useEffect(() => {
        let alive = true;
        const pull = () => api('wait-stats', {})
          .then(r => { if (alive) { setData(r || null); setError(''); } })
          .catch(e => { if (alive) setError(e.message); });
        pull();
        // 等待账本只在本轮结束时变；10 秒一次足够（本地回环请求）。
        const timer = setInterval(pull, 10000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      // 0.16.39：两块的行**全部由服务端给**（`statBlocks`，见 wait-stats.js 的
      // waitStatBlocks）。本组件不拼标签、不算时长、不判断「哪些行该出现」——
      // 那些判断只在服务端有一份，客户端再写一遍就是两条口径的开始。
      const blocks = Array.isArray(data?.statBlocks) ? data.statBlocks : [];
      const block = (title, rows, tone) => h('div', { className: 'hwb-stat' + (tone ? ' ' + tone : '') },
        h('div', { className: 'hwb-stat-head' }, title),
        rows.length
          ? h('dl', { className: 'hwb-stat-grid' },
            rows.map(r => h('div', { key: r.label, className: 'hwb-stat-row' },
              h('dt', null, r.label), h('dd', null, r.value))))
          : h('p', { className: 'hwb-stat-empty' }, '暂无记录'));
      if (error) {
        return h('div', { className: 'hwb-stats' },
          h('p', { className: 'hwb-hint bad' }, '等待统计读不到：' + error + '（这行不代表「没有等待」，只是读不到）'));
      }
      if (!data) return h('div', { className: 'hwb-stats' }, h('p', { className: 'hwb-hint' }, '等待统计加载中…'));
      return h('div', { className: 'hwb-stats' },
        h('div', { className: 'hwb-stat-cols' },
          blocks.map((b, i) => h(React.Fragment, { key: b.title || i },
            block(b.title, Array.isArray(b.rows) ? b.rows : [], i === 0 ? 'live' : '')))),
        h('p', { className: 'hwb-hint' }, '口径：只统计发送前的主动等待，不含模型思考与生成耗时（与输入框底下的药丸同源）。'));
    }

    // ---- 0.16.18：官方 dock 行的适配（**旧实现已失效，这里说清为什么**）---------
    //
    // 旧实现（0.15.11）找的是 `[data-composer-stats]`——ui-chat 的 StatsPills 当年
    // 给根节点打的标记。它把本组件 portal 进那一行，好让等待药丸与官方统计药丸
    // 同排居中。
    //
    // **那个标记在 DSH 0.1.6-alpha.2 里已经不存在。** 实测（本机装的
    // @deepseek-ai/dsh-client-ui-chat@0.1.6-alpha.2/lib/client.js:4115）新版
    // StatsPills 的根节点只渲染 `className: StatsPills_module_css_default.root`，
    // 整个包里 grep `data-composer-stats` 命中 0 处。
    //
    // 于是旧实现**必然**走「找不到官方行」那条回落分支：给自建节点打上
    // `data-webcode-wait`，而那条 CSS 是 `width:100%;max-width:...;margin:0 auto`。
    // 官方新版的 dock 行（ui-conversation 的 InputBar.module.css 里的
    // `uV2eYG_dock`）是
    //
    //     display:flex; justify-content:center; align-items:center; gap:12px
    //
    // —— 一个 `width:100%` 的子项会**独占整行**，把官方药丸挤到下一行。用户看到的
    // 「等待发送1分xx 没适配」就是这个：药丸自己撑满一行、与官方那排药丸分成两栏。
    //
    // ## 新版正确做法：什么都不用做，本来就在那一行里
    //
    // 新版 ui-conversation 的 InputBar 直接这样渲染 dock：
    //
    //     h('div', { className: InputBar_module_css_default.dock },
    //       renderSlot('conversation.composer.dock', {}),   // ← 我们注册的条目
    //       h(ContextMeter, {...}))
    //
    // 也就是说 `conversation.composer.dock` 的每个条目**本来就是那个 flex 行的直接
    // 子项**。0.15.11 的 portal 是在补偿「条目落在列向 composerStack 里」的旧结构；
    // 新结构里这个补偿不仅多余，还正好是 bug 的来源。
    //
    // 因此本版**删掉 portal 与 MutationObserver**，改为内联渲染一个
    // `display:inline-flex` 的药丸：居中、间距、换行全部由官方那条 `uV2eYG_dock`
    // 决定。跨度更小、依赖更少，也不再需要盯着 body 等官方行出现。

    /**
     * 会话身份的**容错归一**（0.19.2）。
     *
     * 为什么需要它：`conversation.composer.dock` 是 `scope: 'session'` 槽，宿主把
     * 作用域绑定的 `key` 作为第一个位置参数传给我们声明的 `inject`。0.1.7 的
     * `runInject`（ui-renderer/src/client/scoped-slots.tsx）与 0.1.6 逐字相同，仍是
     * `args.push(binding.key)`，而 ui-session 的会话绑定把 `key` 设为 `binding.sessionId`
     * ——按契约它应该是**字符串**。
     *
     * 但本项目已经在同一个槽位上踩过一次「形状漂移」：设置页那处 `inject: (sessionId) =>
     * …` 在 root 作用域下拿到的是 actions 对象，于是服务端收到一个对象、花名册恒回
     * `no-session-id`（见 `SettingsSection` 上方 0.15.3 的注释）。代价是**静默的**：
     * `wait-stats` 用非字符串的 sessionId 会回 `label: ''`，而本组件在 `label` 为空时
     * 整行不渲染——用户看到的就是「药丸没了」，控制台一句错误都没有。
     *
     * 真机实测（本机 0.1.7-alpha.2，POST /__webcode/wait-stats）：
     *   sessionId 为字符串        → label「29 分 39 秒 · 等待占比 67%」
     *   sessionId 为对象/缺省/null → label 为空 ⇒ 整行不渲染
     *
     * 因此这里把三种已知形态都接住，而不是赌宿主一定给字符串。多认一种形态的成本是
     * 三行代码，漏认的代价是一块 UI 无声消失。
     *
     * @param {unknown} value inject 传进来的会话身份
     * @returns {string|null} 可用的会话 id
     */
    function sessionIdOf(value) {
      if (typeof value === 'string') return value || null;
      if (value && typeof value === 'object') {
        if (typeof value.key === 'string' && value.key) return value.key;
        if (typeof value.sessionId === 'string' && value.sessionId) return value.sessionId;
      }
      return null;
    }

    function WaitLine(owner) {
      // 会话身份走与设置页**同一个**取值函数：官方 standard prop `useSessions` 优先，
      // 槽 inject 的绑定键回落。只认 inject 那一条，就是「药丸整行消失而控制台无声」
      // 那个缺陷的形状（见 sessionIdOf）。
      const sessionId = useCurrentSessionId(owner);
      const [data, setData] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      // 0.16.24：本轮是否**正在等待发送**。服务端在 live 期间每秒现算文案，
      // 因此这里也要跟着把轮询节奏从 10 秒提到 1 秒——否则那个数 10 秒才动
      // 一格，与用户要的「开始就计时增长」不是一回事。
      const [liveActive, setLiveActive] = React.useState(false);
      const rootRef = React.useRef(null);
      React.useEffect(() => {
        if (!sessionId) { setData(null); setLiveActive(false); return () => {}; }
        let alive = true;
        const pull = () => api('wait-stats', { sessionId })
          .then(r => {
            if (!alive) return;
            setData(r || null);
            // live 由服务端发布/清理（等待开始与结束两个时刻），客户端只跟随：
            // 不在本地推断「应该在等了」，避免两端各自算出一个不同的结论。
            setLiveActive(Boolean(r && r.live));
          })
          .catch(() => { /* 中继未起时静默：这条是附加信息，不该刷错误 */ });
        pull();
        // 静止时 10 秒一次足够（这个数只在本轮结束后才变，且是本地回环请求）；
        // 在途时 1 秒一次，让数字逐秒往上走。
        const timer = setInterval(pull, liveActive ? 1000 : 10000);
        return () => { alive = false; clearInterval(timer); };
      }, [sessionId, liveActive]);
      // 官方 StatsPills 的关闭语义（0.15.11）。
      //
      // 官方那两枚药丸由同一个 useState 驱动（openPill 独占：点另一枚就换过去），
      // 并由 primitives 的 useDismissOnOutsidePointer 负责「点空白处收起」。本组件
      // 是独立注册的 dock 条目、拿不到那个 state，因此按同一套语义等价实现：
      //   • Esc 收起；
      //   • pointerdown 落在自己 wrap 之外就收起——于是点官方任何一枚药丸（在本 wrap
      //     之外）时本面板随之关闭，与官方「同时只有一枚开着」的观感一致。
      // 用 rootRef 而不是整行做边界：点自己面板内部（含滚动条）不会误关。
      //
      // 0.16.39：portal 之后面板**不在** rootRef 的 DOM 子树里（它挂在 body 下），
      // 因此外点判据必须把 panelRef 也算作「内部」——否则点面板里的任何一行都会
      // 立刻把它关掉。这正是官方 useDismissOnOutsidePointer 的第四个参数（portal）
      // 存在的理由，这里按同一语义等价实现。
      React.useEffect(() => {
        if (!open) return;
        const onKey = e => { if (e.key === 'Escape') setOpen(false); };
        const closeOutside = event => {
          const root = rootRef.current;
          const panel = panelRef.current;
          const target = event.target;
          if (!(target instanceof Node)) return;
          if (root && root.contains(target)) return;
          if (panel && panel.contains(target)) return;
          setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', closeOutside);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('pointerdown', closeOutside);
        };
      }, [open]);
      // ---- 0.16.39：面板改成官方的「左边缘对齐 + 视口夹紧」（用户报的右对齐）----
      //
      // 官方 stat-dialog 的定位就是这一颗钩子：`side:'top'` 挂在药丸**上方**，
      // `gap:8` 是药丸顶边到面板底边的距离，`margin:12` 是视口夹紧的边距。它返回
      // `{left, top}`，left 由**药丸左边缘**算出——因此面板左边缘与药丸左边缘对齐。
      // 旧实现用 `right:0` 贴着 wrap 右缘，用户看到的就是「右边缘对齐」。
      //
      // 它同时把「缩放关系」解决了：坐标是视口坐标（面板在 portal 里是 fixed），
      // 而右栏面板自己有 transform + overflow:hidden——不 portal 出去，fixed 会被
      // 那个包含块劫持、并被裁掉。
      const panelRef = React.useRef(null);
      const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 });
      const label = typeof data?.label === 'string' ? data.label : '';
      if (!label) return null;
      const rows = Array.isArray(data?.detailRows) ? data.detailRows : [];
      // 与官方 stat-dialog 的排布逐项对齐：标题行（图标+标题 / 右侧值）→
      // 细分隔线 → dl 网格（dt 左、dd 右、tabular-nums）。
      //
      // 0.16.39：面板本身抽成 `panel`，再决定**挂在哪**：能 portal 就 portal 到
      // body（官方的做法，也是「左边缘对齐」成立的前提），不能就内联回落。
      const panel = h('div', {
        className: 'hwb-waitpanel', ref: panelRef,
        role: 'dialog', 'aria-label': '等待发送统计',
        // 首帧还没有测量结果时**先隐藏但参与布局**（官方 MEASURE_STYLE 的同一条
        // 思路）：直接给一个默认 left/top 会让面板先闪一下再跳到药丸左边。
        style: pos || { visibility: 'hidden', left: 0, top: 0 },
      },
        h('div', { className: 'hwb-waitpanel-head' },
          h('span', { className: 'hwb-waitpanel-title' },
            h(IconWait, { size: 14 }), '等待发送统计'),
          data?.sessionValue
            ? h('span', { className: 'hwb-waitpanel-value' }, data.sessionValue)
            : null),
        h('div', { className: 'hwb-waitpanel-rule', 'aria-hidden': true }),
        // 0.16.24：正在等待时，明细第一行就是这一段（与药丸同源同数）。
        // 它排在账本行之前，因为「此刻在等多久」比「历史累计」更贴近用户此刻
        // 的问题——面板展开时数字仍在逐秒更新。
        (data?.liveValue || rows.length)
          ? h('dl', { className: 'hwb-waitpanel-grid' },
            data?.liveValue
              ? h('div', { className: 'hwb-waitpanel-row live' },
                h('dt', null, '正在等待发送'), h('dd', null, data.liveValue))
              : null,
            rows.map(r => h('div', { key: r.label, className: 'hwb-waitpanel-row' },
              h('dt', null, r.label), h('dd', null, r.value))))
          : h('p', { className: 'hwb-hint' }, '本会话尚无等待记录。'));
      // portal 可用性：`createPortal` 与官方定位钩子**都**在，才走官方那条路。
      // 只有 createPortal 而拿不到坐标，面板会停在左上角；两个都没有时内联的面板
      // 至少还是贴着药丸的（旧行为，可解释）。降级不是崩溃。
      const canPortal = typeof createPortal === 'function' && Boolean(primitives.useAnchoredPosition);
      return h('div', {
        className: 'hwb-waitwrap' + (canPortal ? ' portaled' : ''),
        ref: rootRef,
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
        open && (canPortal ? createPortal(panel, document.body) : panel));
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
    /**
     * 拉 /prompt-variants 的共用 hook（0.16.38）。
     *
     * 现在有**两处**消费这份读数：全局页的只读总览（PromptPanel）与站点页的提示词卡
     *（SitePromptCard）。抽成 hook 是为了让「什么时候拉、字段怎么读、缺失怎么显示」
     * 只有一份实现——两处各写一份 fetch + 解析，迟早会在错误分支上分叉。
     *
     * 如实说明：两处**各自**发一次请求（不是共享同一次响应）。它们不会对不上，
     * 因为每个行数据的来源是服务端对同一个 siteId 的现算（`buildSitePromptRows`），
     * 内容与选路都由服务端决定，不依赖客户端的调用时机。
     */
    function usePromptVariants() {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      const load = React.useCallback(() => {
        api('prompt-variants')
          .then(r => { setData(r || null); setError(''); })
          .catch(e => setError(e.message));
      }, []);
      React.useEffect(() => { load(); }, [load]);
      return { data, error, reload: load };
    }

    /**
     * 站点页的提示词卡（0.16.38）。
     *
     * 用户要求：「首轮提示词，每个单独模型都只能改自己的！以及请你将全部都变为指向
     * 对应网站本地提示词文本的存储文件且可以点击链接打开文件而不是现在全部显示」。
     *
     * 于是这一卡只做三件事：
     *   · 显示该站点的提示词文件路径，并提供「用默认程序打开」——路径由**服务端**
     *     给（同一次 /prompt-variants），前端不拼路径；
     *   · 编辑**该站点自己的**那一段指令（extraPromptBySite[siteId]）；
     *   · 只读模板默认折叠，展开用于核对「此刻真的在教什么」。
     */
    function SitePromptCard({ siteId, value, notice, onSave, disabled }) {
      const [draft, setDraft] = React.useState(value);
      const [busy, setBusy] = React.useState(false);
      const [openNotice, setOpenNotice] = React.useState('');
      const { data, error } = usePromptVariants();
      // 外部值变化（切 tab / 保存后回读）时同步草稿——否则切走再切回来会看到旧文本。
      React.useEffect(() => { setDraft(value); }, [value, siteId]);
      const row = (data?.sites || []).find(r => r && r.siteId === siteId) || null;
      const variant = (data?.variants || []).find(v => v && v.id === (row?.variantId || '')) || null;
      async function openFile() {
        setOpenNotice('');
        try {
          const r = await api('prompt-file', { siteId });
          if (r && r.ok) { setOpenNotice('已用系统默认程序打开：' + r.file); return; }
          const codes = {
            PROMPT_FILE_MISSING: '该站点的提示词文件还没生成——发送第一条消息后自动落盘。',
            PROMPT_STORE_OFF: '提示词落盘已被显式关闭（WEBCODE_PROMPT_STORE_DIR=off）。',
            OPEN_UNAVAILABLE: '宿主没有提供「用默认程序打开」的能力。',
            OPEN_FAILED: '系统默认程序没有打开成功',
          };
          setOpenNotice((codes[r && r.code] || '打开失败') + (r && r.file ? ' 文件：' + r.file : ''));
        } catch (e) { setOpenNotice('打开失败：' + e.message); }
      }
      return h('div', { className: 'hwb-import' },
        h('div', { className: 'hwb-row' },
          h('span', { className: 'hwb-row-label' }, '提示词文件'),
          h('div', { className: 'hwb-row-main' },
            h('code', { className: 'hwb-filepath', title: row?.file || '' },
              row?.file || (data ? '（未提供路径）' : '加载中…')),
            h('button', { type: 'button', disabled: !row, onClick: openFile }, '用默认程序打开'),
            openNotice && h('span', { className: 'hwb-hint' }, openNotice))),
        h('p', { className: 'hwb-hint' }, '本网站指令：只对本站点生效。'),
        h('textarea', {
          className: 'hwb-prompt-input', value: draft, rows: 4, maxLength: 4000,
          placeholder: '例如：本网站回答保持中文，先给结论再给依据。',
          onChange: e => setDraft(e.target.value),
        }),
        h('div', { className: 'hwb-row' },
          h('button', {
            disabled: disabled || busy || draft.trim() === String(value || '').trim(),
            onClick: async () => { setBusy(true); try { await onSave(draft); } finally { setBusy(false); } },
          }, busy ? '保存中…' : '保存本网站指令'),
          h('button', {
            disabled: disabled || busy || !draft,
            title: '清空本网站的指令（该站点只剩全局指令）',
            onClick: async () => { setBusy(true); try { setDraft(''); await onSave(''); } finally { setBusy(false); } },
          }, '清空'),
          notice && h('span', { className: 'hwb-hint' }, notice)),
        h('details', { className: 'hwb-site-prompt-details' },
          h('summary', null, '查看该站点此刻的只读模板'),
          error ? h('p', { role: 'alert', className: 'hwb-hint' }, '模板加载失败：' + error)
            : (!row ? h('p', { className: 'hwb-hint' }, '加载中…')
              : h('div', null,
                h('p', { className: 'hwb-hint' }, '实际使用：' + ((variant && variant.label) || row.variantId)),
                h('pre', null, row.text),
                variant && h('p', { className: 'hwb-hint' }, '增量轮再教学：' + variant.trainNote)))));
    }

    /** 全站点只读总览（全局页）。默认折叠每站模板，避免十个站点把设置页淹掉。 */
    function PromptPanel({ onSaved } = {}) {
      const { data, error } = usePromptVariants();
      if (error) return h('p', { role: 'alert', className: 'hwb-hint' }, '首轮提示词加载失败：' + error);
      if (!data) return h('p', { className: 'hwb-hint' }, '加载首轮提示词…');
      const rows = data.sites || [];
      const variantById = new Map((data.variants || []).map(v => [v.id, v]));
      return h('div', { className: 'hwb-import' },
        data.toolsSource === 'placeholder'
          ? h('p', { className: 'hwb-hint' }, '当前工具清单是占位示例——发送第一条消息后换成该会话的真实清单。')
          : null,
        rows.map(row => h('div', { key: row.siteId, className: 'hwb-site-prompt' },
          h('div', { className: 'hwb-site-prompt-head' },
            h('span', { className: 'hwb-site-prompt-name' }, row.siteName),
            h('span', { className: 'hwb-site-prompt-variant' },
              '实际使用：' + ((variantById.get(row.variantId) || {}).label || row.variantId))),
          h('code', { className: 'hwb-filepath hwb-site-prompt-path', title: row.file || '' }, row.file || ''),
          h('details', { className: 'hwb-site-prompt-details' },
            h('summary', null, '查看完整模板'),
            h('pre', null, row.text)))),
        data.active?.tools?.length
          ? h('p', { className: 'hwb-hint' }, '本会话工具：' + data.active.tools.join(', '))
          : null);
    }

    function GlobalPrompt({ onSaved } = {}) {
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
          setNotice('已保存。');
          onSaved?.();
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }
      return h('div', { className: 'hwb-import' },
        // 说明只在卡头那一句（0.19.x：这里与卡头各写一遍，用户报「重复！」）。
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

    /**
     * 首轮提示词总览（0.16.38：**只剩只读对照表**）。
     *
     * 旧实现把「只读模板」与「全局指令编辑区」绑在同一块里，于是 0.16.38 拆成两张卡
     *（全局指令 / 首轮提示词只读）之后，`GlobalPrompt` 会被渲染**两次**——同一设置两个
     * 输入框，改一个另一个不知道，保存后还会互相覆盖。这里只留只读那半。
     */
    function PromptSection() {
      return h(PromptPanel, {});
    }

    // 按站点分组的模型下拉选项：从桥的 /__webcode/models 取全站点目录
    function ModelSelect({ models, value, onChange, disabled, placeholder }) {
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
      // 空值选项（0.16.38）：站点页的「本网站默认模型」需要一个能显示的空值项，
      // 否则 value='' 会落到不存在的选项上，浏览器把第一项**显示**成选中——界面
      // 看起来「配了 glm-5.3」，而设置里其实什么都没写。
      const emptyOption = placeholder ? h('option', { key: '__follow', value: '' }, placeholder) : null;
      return h('select', { className: 'hwb-model-select', value: value || '', disabled, onChange: e => onChange(e.target.value) },
        emptyOption,
        aliasHit ? h('option', { key: aliasHit.id, value: aliasHit.id }, aliasHit.name + ' · 兼容别名') : null,
        [...groups.entries()].map(([sid, list]) => h('optgroup', { key: sid, label: siteName(sid) },
          // 0.14.0 起 m.name 自带站点短键（`z.ai/glm-5.3`），这里不再重复拼
          // siteName——旧写法会渲染成「Z.ai (GLM 海外版) · z.ai/glm-5.3」。
          list.map(m => h('option', { key: m.id, value: m.id },
            m.name + (m.experimental ? ' · 实验' : '') + (m.thinking ? ' · 深度思考' : '') + (m.vision ? ' · 识图' : ''))))));
    }

    /**
     * 网页与模型管理的「账户」卡片：每个内容服务一行——登录状态 + 登录/换账户
     * + 独立窗口。登录等待真实结果（最长 5 分钟），成功/失败/超时都回显在本行，
     * 不再 fire-and-forget；登录窗口开的是**桥自己的浏览器**（`browser-runtime.js`
     * 解析出的自带 Chromium 优先、系统浏览器兜底），与自动化共用同一 profile ——
     * 所以在这里登录**就是**给桥登录。0.18.0 之前这里写的是「有头 Edge」，那是
     * 驱动改造前的措辞，会让用户以为要装 Edge。
     * onlySiteId：只渲染该站点一行（子代理卡内联所选子代理站点的账户管理，
     * 与「账户与登录管理」卡片同一套状态与端点，不另起第二套真相）。
     */

    /**
     * 花名册数据的**唯一**拉取点（0.15.12）。
     *
     * 任务板面板从它取 `/__webcode/status` 的花名册载荷（含 `teamSource` /
     * `tasksSource` 来源标注）。
     * （0.19.0：原先这里还写着「Team 面板」——那份右栏花名册面板已按用户要求删除，
     * 理由见下方「Team 面板标签页：已删除」处。0.19.x：设置页那张「正在运行
     * （子代理 / Team）」卡也按用户要求删除，于是消费者只剩任务板面板；本函数与
     * `roster.js` 的官方读取仍在用，保留。）
     * 旧实现三处各写一遍 fetch 会有两个立刻可见的代价：轮询相位不同（同屏出现
     * 「3 个成员」与「2 个成员」），以及错误处理各不相同（一处说「读不到」、
     * 另一处静默空列表）。所以只留一个 hook，需要的地方都从这里取。
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

    /** 官方任务状态 → 中文标签与色档（任务板面板在用；色点只是加强，词与色同时出现）。 */
    function taskStatusOf(s) {
      const v = String(s || '');
      if (v === 'in_progress') return { k: 'ok', t: '进行中' };
      if (v === 'completed') return { k: '', t: '已完成' };
      if (v === 'pending') return { k: 'idle', t: '待办' };
      if (v === 'deleted') return { k: '', t: '已删除' };
      return { k: '', t: v || '未知' };
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
      const [viewMode, setViewMode] = React.useState('kanban'); // 'kanban' | 'list'
      const [selectedTaskId, setSelectedTaskId] = React.useState(null);
      const [showNewModal, setShowNewModal] = React.useState(false);
      const [searchFilter, setSearchFilter] = React.useState('');
      const [projectFilter, setProjectFilter] = React.useState('');
      const [localTasks, setLocalTasks] = React.useState([]);
      const [ledgerErr, setLedgerErr] = React.useState('');
      /**
       * 任务板级操作反馈（0.19.0）。
       *
       * 为什么把 `alert()` 全部换掉：`alert`/`confirm` 是**阻塞式**浏览器模态——
       * 弹出期间 JS 主线程停住，5 秒轮询的下一拍、以及所有在途 fetch 的回调都被
       * 卡在队列里；用户看到的是「点一下保存，整个面板僵住」。而且它不属于官方
       * harness 的任何一种反馈形态：参考实现
       * （`reference/dsh-task-board/src/client/board/TaskForm.tsx` + `board.module.css`
       * 的 `.formError`）一律用**页面内联文案**报错。
       *
       * 因此这里收拢成一个横幅：`{ kind: 'ok' | 'bad', text }`。它同时承担
       * 「报错」与「回执」两种语义——用户点完「保存修改」需要看到「已保存」，
       * 否则分不清是没生效还是没反应。
       */
      const [boardNotice, setBoardNotice] = React.useState(null);
      const notify = React.useCallback((kind, text) => {
        setBoardNotice(text ? { kind, text: String(text) } : null);
      }, []);

      /**
       * 把一次台账写操作的返回值化成「说人话的结论」，**拒绝一切模棱两可的形态**。
       *
       * 为什么要单独抽出来：写路径的唯一正确判据是服务端**显式**回的 `ok === true`。
       * 此前各处写的是 `if (res && res.ok === false)` —— 它把 `ok` 缺失、`res` 为
       * `null`、字段名拼错等情形**全部当成成功**，于是界面报「已保存」而磁盘没动。
       * 这正是本项目反复记过的那一类缺陷（「说做了、其实没做」）。判据改成
       * **白名单式**：只有明确的 `ok === true` 才算成功，其余一律按失败报出，
       * 且把服务端给的真实原因带出来。
       *
       * @param {*} res 服务端返回值
       * @param {string} what 失败时显示的动作名（如「保存」）
       * @returns {{ok: boolean, error: string}} 结论
       */
      const verdictOf = (res, what) => {
        if (res && res.ok === true) return { ok: true, error: '' };
        if (res && res.ok === false) return { ok: false, error: String(res.error || '服务端未给原因') };
        return { ok: false, error: what + '的响应形状不认识（没有 ok 字段）——按未成功处理' };
      };

      // 从后端读取桥任务台账。
      //
      // 0.17.3（第三轮 GLM 子代理审查抓到）：这里原先只有 `clearInterval`，**没有**
      // 在卸载时取消在途请求的写回 —— 组件卸载瞬间发出的那次 `task-ledger` 回来时
      // 仍会 `setLocalTasks` / `setLedgerErr`。React 18 不再对此告警，于是它是一条
      // **静默**的泄漏路径（在这个每次切标签都会卸载面板的容器里必然发生）。
      // 判据用「本组件是否还挂着」的 ref，而不是 AbortController：请求本身没有副作用，
      // 要拦的是**写回**，不是请求。
      const aliveRef = React.useRef(true);
      const refreshLedger = React.useCallback(() => {
        api('task-ledger').then(res => {
          if (!aliveRef.current) return;
          if (res?.ok && Array.isArray(res.tasks)) {
            setLocalTasks(res.tasks);
            setLedgerErr('');
          }
        }).catch(e => { if (aliveRef.current) setLedgerErr(e?.message || '读取台账失败'); });
      }, []);

      React.useEffect(() => {
        aliveRef.current = true;
        refreshLedger();
        const timer = setInterval(refreshLedger, 5000);
        return () => { aliveRef.current = false; clearInterval(timer); };
      }, [refreshLedger]);

      if (data === null && localTasks.length === 0) {
        return h('div', { className: 'hwb-panel' },
          h('p', { className: 'hwb-hint' }, err ? '读不到任务板：' + err : '任务板加载中…'));
      }

      // 合并任务来源：自有台账优先（带完整评论与模型信息），辅以 roster 任务
      const rosterTasks = Array.isArray(data?.tasks) ? data.tasks : [];
      const taskMap = new Map();
      for (const t of rosterTasks) if (t?.id) taskMap.set(String(t.id), t);
      for (const t of localTasks) if (t?.id) taskMap.set(String(t.id), { ...taskMap.get(String(t.id)), ...t });
      const allTasks = Array.from(taskMap.values());

      const taskErr = uniqReasons([data?.tasksError, ledgerErr].filter(Boolean));
      const g = data?.graph && typeof data.graph === 'object' ? data.graph : null;
      const plan = data?.plan && typeof data.plan === 'object' ? data.plan : null;
      const planErr = data?.planError || null;
      const byId = taskMap;

      // 过滤任务
      const filteredTasks = allTasks.filter(t => {
        if (projectFilter && String(t.projectId || 'default') !== projectFilter) return false;
        if (searchFilter.trim()) {
          const q = searchFilter.trim().toLowerCase();
          const sub = String(t.subject || '').toLowerCase();
          const desc = String(t.description || '').toLowerCase();
          if (!sub.includes(q) && !desc.includes(q)) return false;
        }
        return true;
      });

      // 项目清单
      const projects = Array.from(new Set(allTasks.map(t => String(t.projectId || 'default')).filter(Boolean)));

      // ── Notion 式卡片展开详情页面 ──────────────────────────────────────────
      if (selectedTaskId) {
        const currentTask = byId.get(String(selectedTaskId));
        if (!currentTask) {
          return h('div', { className: 'hwb-panel' },
            h('button', { className: 'hwb-btn', onClick: () => setSelectedTaskId(null) }, '← 返回看板'),
            h('p', { className: 'hwb-hint bad' }, '任务未找到或已被删除'));
        }

        return h(TaskDetailNotionView, {
          task: currentTask,
          allTasks,
          // ★ 0.19.0 修：**必须把反馈状态传进详情页**。
          //
          // 第三轮对抗审查抓到的真回归，而且是**本轮我自己引入的**：把 `alert()`
          // 换成内联横幅时，横幅的渲染点留在了看板/列表那一支（本函数末尾），
          // 而这条 `return` 在它**之前**就返回了。于是「详情页里做的每一个写操作」
          // ——保存/删除/批注/解决/按批注派发，也就是 `notify()` 的**全部** 16 个
          // 调用点——**反馈一条都渲染不出来**：没有「已保存。」、没有「批注已写入。」、
          // 更看不到「保存被拒: revision-mismatch」与「派发失败」。
          // 而这恰恰是本项目反复记过的「说做了、其实没做」——写入确实到了服务端，
          // 但用户看不到任何结果，包括**被拒绝**的结果。
          // 旧实现用 `alert()` 时不会有这个问题（阻塞式弹窗与挂载分支无关），
          // 所以这是换成内联反馈时丢掉的那一半。
          notice: boardNotice,
          onDismissNotice: () => setBoardNotice(null),
          onBack: () => setSelectedTaskId(null),
          onUpdate: (patch) => {
            api('task-update', { taskId: currentTask.id, patch, expectedRevision: currentTask.revision })
              .then((res) => {
                // 服务端会用 `revision-mismatch` 拒掉过期写入（CAS）。**必须把拒绝
                // 如实报出来**：这正是「两人同时改同一条任务」时用户唯一的线索。
                const v = verdictOf(res, '保存');
                if (!v.ok) { notify('bad', '保存被拒：' + v.error); return; }
                notify('ok', '已保存。');
                refreshLedger();
              })
              .catch(e => notify('bad', '更新失败: ' + e.message));
          },
          onDelete: () => {
            // `confirm` 保留：删除是**不可逆**动作，官方对此类动作同样要一次确认
            // （参考实现有独立的 `ConfirmDialog`）。非阻塞的替代品是自绘对话框，
            // 那需要额外的焦点陷阱与 Esc 处理；在只此一处的前提下，原生 confirm
            // 是更小且更可靠的代价。
            if (confirm('确认删除任务 ' + currentTask.id + '？')) {
              api('task-delete', { taskId: currentTask.id })
                .then((res) => {
                  const v = verdictOf(res, '删除');
                  if (!v.ok) { notify('bad', '删除被拒：' + v.error); return; }
                  setSelectedTaskId(null); refreshLedger();
                })
                .catch(e => notify('bad', '删除失败: ' + e.message));
            }
          },
          onAddComment: (comment) => {
            // 0.19.0：**必须带 expectedRevision**。服务端 `POST task-comment` 的
            // 第五个参数就是 CAS（0.17.3 修的「批注 CAS 被静默吞掉」正是这条链路），
            // 不带就等于放弃并发保护：两人同时对同一条任务批注时，后到的会覆盖先到的，
            // 而双方都收到成功——这正是本项目记为「假成功」的那类缺陷。
            api('task-comment', {
              taskId: currentTask.id,
              ...comment,
              expectedRevision: currentTask.revision,
            })
              .then((res) => {
                const v = verdictOf(res, '批注');
                if (!v.ok) { notify('bad', '批注未写入：' + v.error); return; }
                notify('ok', '批注已写入。');
                refreshLedger();
              })
              .catch(e => notify('bad', '添加评论失败: ' + e.message));
          },
          onResolveComment: (commentId) => {
            // 同 `onAddComment`：解决/取消解决也是一次写，必须吃 CAS。
            api('task-comment-resolve', {
              taskId: currentTask.id,
              commentId,
              expectedRevision: currentTask.revision,
            })
              .then((res) => {
                const v = verdictOf(res, '批注状态变更');
                if (!v.ok) { notify('bad', '批注状态未变更：' + v.error); return; }
                refreshLedger();
              })
              .catch(e => notify('bad', '切换状态失败: ' + e.message));
          },
          onImplement: (commentId, quote, commentText) => {
            // 0.17.3（第三轮自审抓到）：这里原先**只说一句「已向 AI 发起实施指令」**，
            // 从不把服务端组装好的 prompt 投出去 —— 按钮是死的，而用户被告知已经发出。
            // 这正是本项目反复记过的那一类缺陷（「说做了、其实没做」）。
            // 现在：真派发，并把**真实回复或真实错误**显示出来，不再编一句话。
            //
            // 「正在派发…」用 `bad` 之外的**中性**措辞：它既不是成功也不是失败，
            // 而 `boardNotice` 只有 ok/bad 两态。这里刻意**不**先报成功——先报成功
            // 再失败，用户会先看到绿字再看到红字，与「先给承诺再反悔」同形。
            notify('ok', '正在按批注派发，请稍候…');
            api('task-implement', { taskId: currentTask.id, commentId, quote, commentText })
              .then(res => {
                const v = verdictOf(res, '组装实施指令');
                if (!v.ok) { notify('bad', '发起实施失败: ' + v.error); return null; }
                if (!res?.prompt) { notify('bad', '服务端没有返回可派发的指令，已中止（不假装已发送）。'); return null; }
                const sid = res?.assignedModel?.siteId || 'deepseek';
                // 带上 task.sessionKey：同一任务的多次实施落在**同一条会话**里，
                // 这正是「以任务为核心实现会话」那一层的要求。
                return api('chat', { siteId: sid, prompt: res.prompt, sessionKey: res.sessionKey })
                  .then(r2 => {
                    // 派发结果**必须按真实返回值分派**，不得无条件报成功。
                    // 第三轮对抗审查指出：这一段此前**没有任何断言覆盖** —— 把它换成
                    // 一句无条件的成功提示，测试仍全绿，而「派发失败被报成成功」正是
                    // 本项目反复记过的假成功。现在与其它写链路统一走 `verdictOf`。
                    const v2 = verdictOf(r2, '派发');
                    if (v2.ok) notify('ok', '已按批注派发给「' + siteName(sid) + '」。回复：' + String(r2?.reply || '').slice(0, 400));
                    else notify('bad', '派发失败: ' + v2.error);
                  });
              })
              .catch(e => notify('bad', '实施调用异常: ' + e.message));
          },
        });
      }

      // ── 任务行（列表模式复用）──────────────────────────────────────────────
      const taskRow = (t, i, extra) => {
        const st = taskStatusOf(t?.status);
        const blocked = Array.isArray(t?.blockedBy) ? t.blockedBy : [];
        const unresolved = blocked
          .map(id => byId.get(String(id)))
          .filter(Boolean)
          .filter(b => String(b.status) !== 'completed');
        return h('div', {
          key: 't' + i,
          className: 'hwb-panel-row clickable',
          onClick: () => setSelectedTaskId(t.id),
        },
          h('span', { className: 'hwb-dot ' + st.k, 'aria-hidden': 'true' }),
          h('span', { className: 'hwb-panel-title', title: String(t?.id || '') }, String(t?.subject || t?.id || '（无标题）')),
          t?.assignedModel?.siteId && h('span', { className: 'hwb-chip' }, siteName(t.assignedModel.siteId)),
          t?.ownerName && h('span', { className: 'hwb-chip' }, String(t.ownerName)),
          h('span', { className: 'hwb-panel-state' }, st.t),
          Array.isArray(t?.comments) && t.comments.length > 0 && h('span', { className: 'hwb-chip' }, '💬 ' + t.comments.length),
          extra,
          unresolved.length > 0 && h('span', { className: 'hwb-panel-meta' },
            '等在 ' + unresolved.map(b => String(b.subject || b.id) + '（' + taskStatusOf(b.status).t + '）').join('、')),
          Array.isArray(t?.writeScopeWarnings) && t.writeScopeWarnings.length > 0
            && h('span', { className: 'hwb-chip warn' }, '写范围告警'));
      };

      const ready = filteredTasks.filter(t => String(t.status) === 'pending' && t.ready === true);
      const blockedRows = filteredTasks.filter(t => String(t.status) === 'pending' && t.ready !== true);
      const running = filteredTasks.filter(t => String(t.status) === 'in_progress');
      const done = filteredTasks.filter(t => String(t.status) === 'completed');
      const failed = filteredTasks.filter(t => String(t.status) === 'failed');

      // ── 看板列定义（5 列：可开工 / 进行中 / 被阻塞 / 已完成 / 失败）──────────────
      const kanbanCols = [
        { key: 'ready', title: '可开工 (Ready)', tasks: ready },
        { key: 'in_progress', title: '进行中 (Running)', tasks: running },
        { key: 'blocked', title: '被阻塞 (Blocked)', tasks: blockedRows },
        { key: 'completed', title: '已完成 (Done)', tasks: done },
        { key: 'failed', title: '失败 (Failed)', tasks: failed },
      ];

      return h('div', { className: 'hwb-panel hwb-taskboard-container' },
        // 顶部控制条：模式切换、项目筛选、搜索、新建任务
        h('div', { className: 'hwb-tb-toolbar' },
          h('div', { className: 'hwb-tb-toolbar-left' },
            h('button', {
              className: 'hwb-btn ' + (viewMode === 'kanban' ? 'primary' : 'ghost'),
              onClick: () => setViewMode('kanban'),
            }, '看板视图'),
            h('button', {
              className: 'hwb-btn ' + (viewMode === 'list' ? 'primary' : 'ghost'),
              onClick: () => setViewMode('list'),
            }, '列表视图'),
            projects.length > 0 && h('select', {
              className: 'hwb-select',
              value: projectFilter,
              onChange: e => setProjectFilter(e.target.value),
            },
              h('option', { value: '' }, '全部项目 (' + allTasks.length + ')'),
              projects.map(p => h('option', { key: p, value: p }, p))),
          ),
          h('div', { className: 'hwb-tb-toolbar-right' },
            h('input', {
              type: 'search',
              className: 'hwb-input hwb-search',
              placeholder: '搜索任务标题 / 描述…',
              value: searchFilter,
              onChange: e => setSearchFilter(e.target.value),
            }),
            h('button', {
              className: 'hwb-btn primary',
              onClick: () => setShowNewModal(true),
            }, '+ 新建任务'),
          ),
        ),

        // 操作回执 / 错误横幅（0.19.0：取代原先的 alert）。
        // 放在工具条之下、状态概要之上——用户刚点的那个动作的结果就在那一带。
        boardNotice && h('div', {
          className: 'hwb-notice ' + (boardNotice.kind === 'bad' ? 'bad' : 'ok'),
          role: boardNotice.kind === 'bad' ? 'alert' : 'status',
        },
          h('span', { className: 'hwb-notice-text' }, boardNotice.text),
          h('button', {
            className: 'hwb-btn-close',
            title: '关闭',
            onClick: () => setBoardNotice(null),
          }, '✕')),

        // 状态概要
        h('div', { className: 'hwb-panel-summary' },
          h('span', { className: 'hwb-panel-stat' }, '共 ' + filteredTasks.length),
          ready.length > 0 && h('span', { className: 'hwb-panel-stat ok' }, '可开工 ' + ready.length),
          running.length > 0 && h('span', { className: 'hwb-panel-stat ok' }, '进行中 ' + running.length),
          blockedRows.length > 0 && h('span', { className: 'hwb-panel-stat bad' }, '被阻塞 ' + blockedRows.length),
          done.length > 0 && h('span', { className: 'hwb-panel-stat' }, '已完成 ' + done.length),
          failed.length > 0 && h('span', { className: 'hwb-panel-stat bad' }, '失败 ' + failed.length)),

        taskErr && h('p', { className: 'hwb-hint bad' }, '任务板读不到（' + taskErr + '）——这不代表没有任务，而是数据源不可用。'),
        !taskErr && filteredTasks.length === 0
          ? h('p', { className: 'hwb-hint' }, '当前无任务。点击右上角「+ 新建任务」或由 AI 创建任务。')
          : null,

        // ── 视图模式分流 ──────────────────────────────────────────────────────
        viewMode === 'kanban'
          ? h('div', { className: 'hwb-kanban-board' },
            kanbanCols.map(col => h('div', { key: col.key, className: 'hwb-kanban-col', 'data-status': col.key },
              h('div', { className: 'hwb-kanban-col-head' },
                h('span', { className: 'hwb-kanban-col-title' }, col.title),
                h('span', { className: 'hwb-kanban-col-count' }, col.tasks.length)),
              h('div', { className: 'hwb-kanban-col-cards' },
                col.tasks.map(t => {
                  const blocked = Array.isArray(t?.blockedBy) ? t.blockedBy : [];
                  const unresolved = blocked
                    .map(id => byId.get(String(id)))
                    .filter(Boolean)
                    .filter(b => String(b.status) !== 'completed');
                  return h('div', {
                    key: t.id,
                    className: 'hwb-kanban-card',
                    onClick: () => setSelectedTaskId(t.id),
                  },
                    h('div', { className: 'hwb-kcard-head' },
                      h('span', { className: 'hwb-kcard-id' }, t.id),
                      t.assignedModel?.siteId && h('span', { className: 'hwb-chip' }, siteName(t.assignedModel.siteId))),
                    h('div', { className: 'hwb-kcard-title' }, t.subject || '（无标题）'),
                    t.description && h('div', { className: 'hwb-kcard-desc' },
                      t.description.length > 80 ? t.description.slice(0, 80) + '…' : t.description),
                    unresolved.length > 0 && h('div', { className: 'hwb-panel-meta' },
                      '等在 ' + unresolved.map(b => String(b.subject || b.id) + '（' + taskStatusOf(b.status).t + '）').join('、')),
                    h('div', { className: 'hwb-kcard-footer' },
                      t.projectId && h('span', { className: 'hwb-tag' }, t.projectId),
                      Array.isArray(t.comments) && t.comments.length > 0 && h('span', { className: 'hwb-comment-badge' }, '💬 ' + t.comments.length),
                      t.ownerName && h('span', { className: 'hwb-chip' }, t.ownerName)));
                }),
                col.tasks.length === 0 && h('div', { className: 'hwb-kanban-empty' }, '无任务')),
            )))
          : h('div', { className: 'hwb-list-view' },
            filteredTasks.map((t, i) => taskRow(t, i))),

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
        // ---- 关键路径 ----
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
        // ---- 当前阻塞点 ----
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

        // 来源标注与说明。0.19.x：`teamSource` 原先只由设置页那张花名册卡渲染，
        // 卡片按用户要求删除后它一度没有消费者（服务端算、前端不读，正是本项目
        // 记过的「只声明不接线」）。花名册载荷的存活消费者是这里，因此由它接上。
        sourceText(data?.teamSource) && h('p', { className: 'hwb-hint' }, sourceText(data?.teamSource)),
        sourceText(data?.tasksSource) && h('p', { className: 'hwb-hint' }, sourceText(data?.tasksSource)),
        h('p', { className: 'hwb-hint' },
          '就绪（ready）取官方算好的判据，桥不重算；阻塞明细、关键路径与结构检查由桥补算。'
          + '写范围重叠只是提醒而不是锁：官方明文没有 worktree，成员共享同一个 checkout。'),

        // 新建任务弹窗
        showNewModal && h(NewTaskModalDialog, {
          onClose: () => setShowNewModal(false),
          onCreate: (taskInput) => {
            api('task-create', taskInput)
              .then(res => {
                const v = verdictOf(res, '创建任务');
                if (v.ok) {
                  setShowNewModal(false);
                  notify('ok', '已创建任务 ' + (res?.task?.id || '') + '。');
                  refreshLedger();
                } else {
                  notify('bad', '创建任务失败: ' + v.error);
                }
              })
              .catch(e => notify('bad', '请求失败: ' + e.message));
          },
        }),
      );
    }

    /**
     * **新建任务弹窗**（对标 reference/dsh-task-board 的 NewTaskModal）。
     *
     * 校验反馈走**内联文案**而不是 `alert`：参考实现的 `TaskForm.tsx` 把
     * `formError` 渲染在字段下方（`board.module.css` 的 `.formError` 用
     * `--dsw-alias-state-error-primary`），这里同口径照做。理由与任务板级
     * 横幅相同：`alert` 阻塞主线程，且不属于官方任何一种反馈形态。
     */
    function NewTaskModalDialog({ onClose, onCreate }) {
      const [subject, setSubject] = React.useState('');
      const [description, setDescription] = React.useState('');
      const [siteId, setSiteId] = React.useState('deepseek');
      const [slot, setSlot] = React.useState('0');
      const [projectId, setProjectId] = React.useState('default');
      const [writeScopes, setWriteScopes] = React.useState('');
      // ── 排期与执行面（0.19.0）─────────────────────────────────────────────
      //
      // 参考实现 `dsh-task-board` 的 NewTaskModal 有 schedule(cron) / mode /
      // permission / reuseSession 一整套，本桥移植任务板时**漏掉了整块**——
      // 用户问的「为什么任务板没有设置开始时间等功能」就是它：不是坏了，
      // 是从来没做（界面没有输入框，台账也没有落脚字段）。
      //
      // `startAt` 用原生 `<input type="datetime-local">`：自带日历、时区与格式
      // 校验，**不需要引入日期库**（本文件是单文件 bundle，引不了依赖）。
      // 读出的是本地时间字符串，`new Date(str).getTime()` 转毫秒。
      const [startAt, setStartAt] = React.useState('');
      const [cron, setCron] = React.useState('');
      const [mode, setMode] = React.useState('');
      const [permission, setPermission] = React.useState('');
      const [reuseSession, setReuseSession] = React.useState(false);
      const [formError, setFormError] = React.useState('');

      const handleSubmit = (e) => {
        e.preventDefault();
        if (!subject.trim()) { setFormError('任务标题不能为空。'); return; }
        // 开始时间填错就别提交：静默丢掉一个非法值会让用户以为排期设上了
        //（本项目反复记过的「说做了、其实没做」）。
        const startMs = startAt ? new Date(startAt).getTime() : null;
        if (startAt && !Number.isFinite(startMs)) { setFormError('开始时间格式不正确，请重新选择。'); return; }
        setFormError('');
        onCreate({
          subject: subject.trim(),
          description: description.trim(),
          assignedModel: { siteId, accountSlot: Number(slot) || 0 },
          projectId: projectId.trim() || 'default',
          writeScopes: writeScopes.split(/[\n,]+/).map(s => s.trim()).filter(Boolean),
          schedule: { startAt: startMs, cron: cron.trim() },
          mode: mode.trim(),
          permission: permission.trim(),
          reuseSession,
        });
      };

      return h('div', { className: 'hwb-modal-overlay', onClick: onClose },
        h('div', { className: 'hwb-modal-content', onClick: e => e.stopPropagation() },
          h('div', { className: 'hwb-modal-header' },
            h('h3', null, '新建任务'),
            h('button', { className: 'hwb-btn ghost', onClick: onClose }, '✕')),
          h('form', { onSubmit: handleSubmit, className: 'hwb-modal-form' },
            h('label', { className: 'hwb-form-field' },
              h('span', { className: 'hwb-field-label' }, '任务标题 (必填)'),
              h('input', {
                className: 'hwb-input',
                value: subject,
                placeholder: '简短描述要实现的功能或修复的目标…',
                // 用户一动手就把上一次的校验错误清掉：错误文案是关于**上一次提交**的，
                // 留在原地会让人以为「改了也还是错」。
                onChange: e => { setFormError(''); setSubject(e.target.value); },
                autoFocus: true,
              }),
              // 官方口径：错误紧贴字段下方（参考实现 `.formError`）。
              formError && h('p', { className: 'hwb-form-error', role: 'alert' }, formError)),
            h('label', { className: 'hwb-form-field' },
              h('span', { className: 'hwb-field-label' }, '任务详细说明 (支持 Markdown)'),
              h('textarea', {
                className: 'hwb-textarea',
                rows: 4,
                value: description,
                placeholder: '详细要求、验收标准与实现细节…',
                onChange: e => setDescription(e.target.value),
              })),
            h('div', { className: 'hwb-form-row' },
              h('label', { className: 'hwb-form-field' },
                h('span', { className: 'hwb-field-label' }, '指定执行站点 / 模型'),
                h('select', {
                  className: 'hwb-select',
                  value: siteId,
                  onChange: e => setSiteId(e.target.value),
                },
                  h('option', { value: 'deepseek' }, 'DeepSeek (网页基线)'),
                  h('option', { value: 'glm' }, '智谱清言 (GLM-4)'),
                  h('option', { value: 'kimi' }, 'Kimi (Moonshot)'),
                  h('option', { value: 'qwen' }, '通义千问 (Qwen)'),
                  h('option', { value: 'doubao' }, '豆包 (Doubao)'),
                  h('option', { value: 'zai' }, 'Z.ai (海外)'))),
              h('label', { className: 'hwb-form-field' },
                h('span', { className: 'hwb-field-label' }, '所属项目 (Project ID)'),
                h('input', {
                  className: 'hwb-input',
                  value: projectId,
                  placeholder: 'default',
                  onChange: e => setProjectId(e.target.value),
                }))),
            h('label', { className: 'hwb-form-field' },
              h('span', { className: 'hwb-field-label' }, '预期写入范围 (Write Scopes，每行一个路径前缀)'),
              h('input', {
                className: 'hwb-input',
                value: writeScopes,
                placeholder: 'package/dsh-webcode-bridge/lib/, doc/',
                onChange: e => setWriteScopes(e.target.value),
              })),
            // ── 开始时间 / 排期 / 执行面（0.19.0）───────────────────────────
            // 这三行就是用户问的「设置开始时间等功能」。它们**真的会落盘**：
            // UI → POST task-create → applyCreate → scheduleOf → ledger.json
            //（三跳缺任何一跳都会变成「填了没用」，因此每一跳都在护栏里钉住）。
            h('div', { className: 'hwb-form-row' },
              h('label', { className: 'hwb-form-field' },
                h('span', { className: 'hwb-field-label' }, '开始时间（留空 = 不定时）'),
                h('input', {
                  type: 'datetime-local',
                  className: 'hwb-input',
                  value: startAt,
                  onChange: e => { setFormError(''); setStartAt(e.target.value); },
                })),
              h('label', { className: 'hwb-form-field' },
                h('span', { className: 'hwb-field-label' }, '周期排期 (cron，可选)'),
                h('input', {
                  className: 'hwb-input',
                  value: cron,
                  placeholder: '0 9 * * *',
                  onChange: e => { setFormError(''); setCron(e.target.value); },
                }))),
            h('div', { className: 'hwb-form-row' },
              h('label', { className: 'hwb-form-field' },
                h('span', { className: 'hwb-field-label' }, '执行模式 (mode，可选)'),
                h('input', {
                  className: 'hwb-input',
                  value: mode,
                  placeholder: '留空 = 用默认预设',
                  onChange: e => setMode(e.target.value),
                })),
              h('label', { className: 'hwb-form-field' },
                h('span', { className: 'hwb-field-label' }, '权限档 (permission，可选)'),
                h('input', {
                  className: 'hwb-input',
                  value: permission,
                  placeholder: '留空 = 用默认权限',
                  onChange: e => setPermission(e.target.value),
                }))),
            h('label', { className: 'hwb-form-field hwb-form-check' },
              h('input', {
                type: 'checkbox',
                checked: reuseSession,
                onChange: e => setReuseSession(e.target.checked),
              }),
              h('span', null, '复用同一网页会话（不勾则每个任务各持一条会话）')),
            h('div', { className: 'hwb-modal-actions' },
              h('button', { type: 'button', className: 'hwb-btn ghost', onClick: onClose }, '取消'),
              h('button', { type: 'submit', className: 'hwb-btn primary' }, '创建任务')))));
    }

    /**
     * **Notion 式卡片展开详情页面**（满足用户针对正文批注、指定模型实施、任务专用会话绑定的完整要求）。
     */
    function TaskDetailNotionView({ task, allTasks, notice, onDismissNotice, onBack, onUpdate, onDelete, onAddComment, onResolveComment, onImplement }) {
      const [subject, setSubject] = React.useState(task.subject || '');
      const [description, setDescription] = React.useState(task.description || '');
      const [status, setStatus] = React.useState(task.status || 'pending');
      const [siteId, setSiteId] = React.useState(task.assignedModel?.siteId || 'deepseek');
      // 排期（0.19.0）：与 subject/description 同一条 dirty 规则——用户正在改时间时
      // 后台 5 秒轮询**不许**覆盖他（那正是「人不能手动编辑任务」的成因）。
      const [startAt, setStartAt] = React.useState('');
      const [cronExpr, setCronExpr] = React.useState('');
      const schedule = task.schedule && typeof task.schedule === 'object'
        ? task.schedule
        : { enabled: false, cron: '', startAt: null, nextRunAt: null, lastTriggeredAt: null };
      const [selectedQuote, setSelectedQuote] = React.useState('');
      const [commentText, setCommentText] = React.useState('');
      const [taskChatMessages, setTaskChatMessages] = React.useState([]);
      const [chatInput, setChatInput] = React.useState('');

      // 同步外部变更 —— **只在任务换人时同步**（0.18.0 真缺陷修复）。
      //
      // 为什么这条注释必须这么长：这里原先依赖的是**整个 task 对象**，而 `task` 是从
      // `TaskBoardPanel` 的 `byId` 里取的、**每 5 秒轮询一次** `task-ledger` 后
      // 重新构造的对象。对象引用每次都变 ⇒ 这个 effect 每 5 秒跑一次 ⇒
      // 用户正在输入的标题 / 正文 / 状态 / 模型**被静默重置回台账里的旧值**。
      // 症状正是用户报的「人不能手动添加/编辑任务」：框在那儿，打进去的字会自己消失。
      //
      // 判据因此必须是**稳定标识**（任务 id）而不是对象引用。
      const taskId = String(task?.id || '');
      // dirtyRef：用户一旦在本页改过任何字段，后台轮询就**不许**再覆盖他。
      // 这不是「更好的做法」，是「不这么做就等于把用户的输入丢掉」。
      const dirtyRef = React.useRef(false);
      const taskRevision = Number(task?.revision) || 0;
      // 换了一条任务：无条件同步，并把 dirty 归零（新任务的字段属于新任务）。
      React.useEffect(() => {
        dirtyRef.current = false;
        setSubject(task.subject || '');
        setDescription(task.description || '');
        setStatus(task.status || 'pending');
        setSiteId(task.assignedModel?.siteId || 'deepseek');
        setStartAt(toLocalInputValue(task.schedule?.startAt));
        setCronExpr(String(task.schedule?.cron || ''));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 只认 id：见上面那段理由
      }, [taskId]);

      // 同一条任务被**外部**改了（另一个成员 / 另一个标签页）：只有用户没在编辑时
      // 才同步。他正在打字就宁可这一拍不同步，也绝不把他的输入冲掉。
      React.useEffect(() => {
        if (dirtyRef.current) return;
        setSubject(task.subject || '');
        setDescription(task.description || '');
        setStatus(task.status || 'pending');
        setSiteId(task.assignedModel?.siteId || 'deepseek');
        setStartAt(toLocalInputValue(task.schedule?.startAt));
        setCronExpr(String(task.schedule?.cron || ''));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖 revision：语义就是「外部改动」
      }, [taskRevision]);

      // 处理划词/摘录引用
      const handleDescSelect = (e) => {
        const sel = window.getSelection()?.toString()?.trim();
        if (sel && sel.length > 2) setSelectedQuote(sel);
      };

      // 每个受控输入的 onChange 都先置 dirty —— 否则后台轮询会在下一拍把
      // 用户刚敲的字覆盖掉（上面 effect 的注释写了完整成因）。
      const markDirty = () => { dirtyRef.current = true; };

      const handleAddComment = (e) => {
        e.preventDefault();
        if (!commentText.trim()) return;
        onAddComment({ quote: selectedQuote, text: commentText.trim() });
        setCommentText('');
        setSelectedQuote('');
      };

      const handleSaveMeta = () => {
        // 开始时间与 cron **必须一起提交**：只提交其中一个的话，`applyUpdate` 的合并
        // 分支拿不到另一个的当前值就会把它当成「未提供」而保留旧值——用户清空
        // 开始时间时会发现它自己又回来了。
        const startMs = startAt ? new Date(startAt).getTime() : null;
        onUpdate({
          subject: subject.trim(),
          description,
          status,
          assignedModel: { siteId, accountSlot: 0 },
          schedule: {
            startAt: Number.isFinite(startMs) ? startMs : null,
            cron: cronExpr.trim(),
          },
        });
        // 保存成功后解除 dirty：此后后台轮询可以正常同步外部变更
        //（比如另一个成员改了这条任务）。
        dirtyRef.current = false;
      };

      const comments = Array.isArray(task.comments) ? task.comments : [];
      // 正文侧锚点：只收**有引用片段**的批注。
      //
      // 必须带上它在 `comments` 里的**原始下标**：右侧批注卡是按 `comments` 顺序
      // 渲染的，锚点按钮要跳到「第 i 张卡」。如果这里只留文本、用数组下标去指卡片，
      // 只要有一条无引用的批注夹在中间，后面的锚点就全部错位一格，点到别的批注上——
      // 而这种错位在界面上完全看不出来（跳转目标看起来同样合理）。
      const anchorQuotes = comments
        .map((c, idx) => ({ quote: String(c?.quote || ''), idx }))
        .filter(a => a.quote);

      return h('div', { className: 'hwb-notion-page' },
        // 头部操作条
        h('div', { className: 'hwb-notion-header' },
          h('button', { className: 'hwb-btn ghost', onClick: onBack }, '← 返回看板'),
          h('div', { className: 'hwb-notion-actions' },
            h('button', { className: 'hwb-btn primary', onClick: handleSaveMeta }, '保存修改'),
            h('button', { className: 'hwb-btn danger', onClick: onDelete }, '删除任务'))),

        // 写操作反馈横幅：**详情页是唯一能发起这些写操作的地方**，所以它必须也在这里。
        // 只放在看板那一支的话，用户在此页做的每一次保存/批注/派发都看不到任何结果
        //（含被 CAS 拒绝）——详见 `TaskBoardPanel` 里传 `notice` 处的完整说明。
        notice && h('div', {
          className: 'hwb-notice ' + (notice.kind === 'bad' ? 'bad' : 'ok'),
          role: notice.kind === 'bad' ? 'alert' : 'status',
        },
          h('span', { className: 'hwb-notice-text' }, notice.text),
          h('button', {
            className: 'hwb-btn-close',
            title: '关闭',
            onClick: () => { if (typeof onDismissNotice === 'function') onDismissNotice(); },
          }, '✕')),

        // 任务主体信息
        h('div', { className: 'hwb-notion-body' },
          h('input', {
            className: 'hwb-notion-title-input',
            value: subject,
            placeholder: '任务标题…',
            onChange: e => { markDirty(); setSubject(e.target.value); },
          }),

          // 属性栅格（Status / Model / Project / SessionKey）
          h('div', { className: 'hwb-notion-properties' },
            h('div', { className: 'hwb-notion-prop-row' },
              h('span', { className: 'hwb-prop-name' }, '状态 (Status)'),
              h('select', {
                className: 'hwb-select',
                value: status,
                onChange: e => { markDirty(); setStatus(e.target.value); },
              },
                h('option', { value: 'pending' }, '待办 (pending)'),
                h('option', { value: 'in_progress' }, '进行中 (in_progress)'),
                h('option', { value: 'completed' }, '已完成 (completed)'),
                h('option', { value: 'failed' }, '失败 (failed)'))),
            h('div', { className: 'hwb-notion-prop-row' },
              h('span', { className: 'hwb-prop-name' }, '指定执行模型'),
              h('select', {
                className: 'hwb-select',
                value: siteId,
                onChange: e => { markDirty(); setSiteId(e.target.value); },
              },
                h('option', { value: 'deepseek' }, 'DeepSeek (网页基线)'),
                h('option', { value: 'glm' }, '智谱清言 (GLM)'),
                h('option', { value: 'kimi' }, 'Kimi (Connect-RPC)'),
                h('option', { value: 'qwen' }, '通义千问 (Qwen)'),
                h('option', { value: 'doubao' }, '豆包 (Doubao)'),
                h('option', { value: 'zai' }, 'Z.ai (海外)'))),
            h('div', { className: 'hwb-notion-prop-row' },
              h('span', { className: 'hwb-prop-name' }, '项目归属'),
              h('span', { className: 'hwb-chip' }, task.projectId || 'default')),
            h('div', { className: 'hwb-notion-prop-row' },
              h('span', { className: 'hwb-prop-name' }, '会话隔离 Key'),
              h('span', { className: 'hwb-session-key', title: task.sessionKey }, task.sessionKey || '未绑定')),
            // ── 开始时间 / 排期（0.19.0）───────────────────────────────────────
            // 详情页是**唯一**能改一条已存在任务的地方，因此这两个输入框必须也在这里：
            // 只在新建弹窗里能设的话，用户建完就再也改不了开始时间——那只是半个功能。
            h('div', { className: 'hwb-notion-prop-row' },
              h('span', { className: 'hwb-prop-name' }, '开始时间'),
              h('input', {
                type: 'datetime-local',
                className: 'hwb-select',
                value: toLocalInputValue(schedule.startAt),
                onChange: e => { markDirty(); setStartAt(e.target.value); },
              })),
            h('div', { className: 'hwb-notion-prop-row' },
              h('span', { className: 'hwb-prop-name' }, '周期排期 (cron)'),
              h('input', {
                className: 'hwb-input',
                value: cronExpr,
                placeholder: '留空 = 不定时（如 0 9 * * *）',
                onChange: e => { markDirty(); setCronExpr(e.target.value); },
              })),
            // 时间戳如实显示：用户问的「开始时间」有一半指的是「这条任务什么时候建的、
            // 最后一次动是什么时候」——而这两个字段在台账里一直有，界面**从不渲染**。
            h('div', { className: 'hwb-notion-prop-row' },
              h('span', { className: 'hwb-prop-name' }, '创建 / 更新'),
              h('span', { className: 'hwb-chip' }, formatStamp(task.createdAt) + ' / ' + formatStamp(task.updatedAt))),
            schedule.nextRunAt
              ? h('div', { className: 'hwb-notion-prop-row' },
                h('span', { className: 'hwb-prop-name' }, '下次触发'),
                h('span', { className: 'hwb-chip' }, formatStamp(schedule.nextRunAt)))
              : null),

          // ── 审阅区：Office / Word 式「左正文 · 右批注栏」（0.18.0）────────────
          //
          // 用户原话（2026-09-22）：「然后是审批界面，参考 office 左正文，右划线
          // 编辑评论并合理显示：完全参考 office 实现」。
          //
          // 为什么是左右分栏而不是上下堆叠（改前就是上下）：Word 的审阅窗格把
          // **被审阅的正文**与**针对它的批注**并排，批注锚在右侧页边（margin），
          // 引用片段与正文段落**水平对齐**。上下堆叠时用户得靠来回滚动才能对照
          // 「这段文字」与「针对这段文字的意見」——那正是审阅最费神的地方。
          //
          // 三处对齐 Word 的细节：
          //   · 右侧是**页边栏**（窄、独立滚动），不是第二篇文章；
          //   · 每条批注带左侧竖线 + 引用片段斜体（Word 的批注标记形态）；
          //   · 选中的引用片段在正文侧**留痕**（当前引用条），用户知道锚在哪。
          h('div', { className: 'hwb-review-split' },
            // ── 左：正文 ────────────────────────────────────────────────
            h('div', { className: 'hwb-review-doc' },
              h('div', { className: 'hwb-review-doc-head' },
                h('h4', { className: 'hwb-section-title' }, '任务正文'),
                h('span', { className: 'hwb-review-tip' }, '选中文字后到右侧写批注')),
              h('textarea', {
                className: 'hwb-notion-desc-textarea hwb-review-textarea',
                rows: 18,
                value: description,
                onMouseUp: handleDescSelect,
                onChange: e => { markDirty(); setDescription(e.target.value); },
                placeholder: '在此输入详细的任务说明、实现思路或规范要求…（选中一段文字即可针对它写批注）',
              }),
              // ── 正文侧留痕：已被批注锚定的片段集合（Word 的「已评论文字」着色）──
              //
              // 这是 0.19.0 补上的一环。此前正文与批注之间**只有**一条「当前选中」
              // 的临时提示，页面刷新或点开后用户就再也说不出「这几条批注到底说的是
              // 正文的哪一段」——Word 正是靠**正文里被底纹标出的那段文字**回答这个
              // 问题的。这里用同一份 `comments[].quote` 做锚点清单：每条引用片段一行，
              // 点击它把右侧对应批注滚进视野。
              //
              // 刻意**不**把 textarea 换成 contenteditable：那会把「编辑正文」这件
              // 事从原生控件换成自绘富文本，光标、输入法、撤销栈都要自己实现——收益
              // 只是着色，代价是整块编辑体验。锚点清单用更小的代价给出同等信息。
              anchorQuotes.length > 0 && h('div', { className: 'hwb-review-anchors' },
                h('span', { className: 'hwb-review-anchors-label' }, '已批注 ' + anchorQuotes.length + ' 处：'),
                anchorQuotes.map((a) => h('button', {
                  key: 'q' + a.idx,
                  className: 'hwb-review-anchor',
                  title: '跳到该批注',
                  onClick: (e) => {
                    // 点了锚点就把对应批注卡滚进视野：Word 里点正文的批注标记
                    // 会定位到页边那条卡，方向反过来也同样成立。
                    const card = e?.currentTarget
                      ?.closest?.('.hwb-review-split')?.querySelectorAll?.('.hwb-comment-card')?.[a.idx];
                    if (card && typeof card.scrollIntoView === 'function') {
                      card.scrollIntoView({ block: 'nearest' });
                    }
                  },
                }, a.quote)))),

            // ── 右：批注栏（Word 的 margin）─────────────────────────────
            h('div', { className: 'hwb-review-margin' },
              h('div', { className: 'hwb-review-margin-head' },
                h('h4', { className: 'hwb-section-title' }, '批注（' + comments.length + '）'),
                comments.some(c => !c.resolved) && h('span', { className: 'hwb-chip warn' },
                  '待处理 ' + comments.filter(c => !c.resolved).length)),
              h('div', { className: 'hwb-comments-list hwb-review-comments' },
                comments.map(c => h('div', {
                  key: c.id,
                  className: 'hwb-comment-card' + (c.resolved ? ' resolved' : ''),
                },
                  c.quote && h('blockquote', { className: 'hwb-comment-quote' }, '“' + c.quote + '”'),
                  h('div', { className: 'hwb-comment-text' }, c.text),
                  h('div', { className: 'hwb-comment-footer' },
                    h('span', { className: 'hwb-comment-time' }, new Date(c.createdAt).toLocaleTimeString()),
                    h('button', {
                      className: 'hwb-btn small ' + (c.resolved ? 'ghost' : 'primary'),
                      onClick: () => onResolveComment(c.id),
                    }, c.resolved ? '✓ 已解决' : '标记为已解决')),
                  // 「指定 AI 依据此评论实施」是**审批动作**：把这条批注变成
                  // 一次真实的模型执行。它单独一行、占满宽度，因为它是这一栏里
                  // 唯一的「会改变代码」的按钮，不该与「已解决」挤在一行里被误点。
                  h('button', {
                    className: 'hwb-btn small primary hwb-comment-implement',
                    onClick: () => onImplement(c.id, c.quote, c.text),
                  }, '⚡ 指定 AI 依据此评论实施'))),
                comments.length === 0 && h('p', { className: 'hwb-hint' },
                  '暂无批注。在左侧选中文字，或直接在下面写一条。')),

              // 添加新批注表单
              h('form', { onSubmit: handleAddComment, className: 'hwb-comment-form' },
                selectedQuote && h('div', { className: 'hwb-quote-preview' },
                  h('span', { className: 'hwb-quote-label' }, '引用：'),
                  h('span', { className: 'hwb-quote-val' }, '“' + selectedQuote + '”'),
                  h('button', { type: 'button', className: 'hwb-btn-close', onClick: () => setSelectedQuote('') }, '✕')),
                h('input', {
                  className: 'hwb-input',
                  placeholder: selectedQuote ? '针对这段引用的修改建议…' : '先选中左侧文字，或直接写一条批注…',
                  value: commentText,
                  onChange: e => setCommentText(e.target.value),
                }),
                h('button', { type: 'submit', className: 'hwb-btn primary' }, '添加批注')))),

          // ── 以任务为核心的会话与实施联动区 ──────────────────────────────
          h('div', { className: 'hwb-notion-section' },
            h('h4', { className: 'hwb-section-title' }, '以任务为核心的会话流 (' + (task.sessionKey || 'task-session') + ')'),
            h('p', { className: 'hwb-hint' }, '针对本任务的对话将独立在此会话中闭环，实现“以任务组织上下文与团队工作”。'),
            h('div', { className: 'hwb-task-chat-box' },
              h('div', { className: 'hwb-task-chat-history' },
                taskChatMessages.map((m, idx) => h('div', { key: idx, className: 'hwb-chat-msg ' + m.role },
                  h('strong', null, m.role === 'user' ? '用户: ' : 'AI (' + siteName(siteId) + '): '),
                  h('span', null, m.text))),
                taskChatMessages.length === 0 && h('p', { className: 'hwb-hint' }, '尚无会话记录。输入消息或点击评论中的「指定 AI 实施」即可开始。')),
              h('div', { className: 'hwb-task-chat-input-row' },
                h('input', {
                  className: 'hwb-input',
                  placeholder: '在此发送指令给分配的模型 (' + siteName(siteId) + ')…',
                  value: chatInput,
                  onChange: e => setChatInput(e.target.value),
                  onKeyDown: e => {
                    if (e.key === 'Enter' && chatInput.trim()) {
                      const msg = chatInput.trim();
                      setChatInput('');
                      setTaskChatMessages(prev => [...prev, { role: 'user', text: msg }]);
                      onImplement(null, '', msg);
                    }
                  },
                }),
                h('button', {
                  className: 'hwb-btn primary',
                  onClick: () => {
                    if (chatInput.trim()) {
                      const msg = chatInput.trim();
                      setChatInput('');
                      setTaskChatMessages(prev => [...prev, { role: 'user', text: msg }]);
                      onImplement(null, '', msg);
                    }
                  },
                }, '发送指令'))))));
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
                // 头像内容（0.16.33）：改用**站点矢量标记** SiteGlyph——
                // 与右侧栏二级菜单、站点 tab 条同一套图标，于是「同一个站点」在
                // 设置页与面板上是同一个符号，不再一处画字、一处画图。
                // 官方矢量未取得的站点仍是「文字标记 + 圆环」那套（SiteGlyph 内
                // 部按 tier 分支），因此这里不新增任何资产或网络依赖。
                // 真正表达**账户状态**的仍是外圈那一道环（颜色不是唯一载体，
                // 见上方 aria-label/title）。
                h('span', { className: 'hwb-avatar-glyph', 'aria-hidden': 'true' },
                  h(SiteGlyph, { sid: s.siteId, size: 12 }))),
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
                title: '把本机已安装浏览器里该站点的登录态导入桥 profile（读取其 cookies；无需在桥里再登录一次）',
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
        subHint ? null : h('p', { className: 'hwb-hint indent' },
          '登录会打开浏览器窗口，请在窗口内完成一次性登录，成功后自动切回无头运行。'));
    }

    // 0.15.10：设置页的「累计等待发送」区块（WaitStats）已删除。
    //
    // 它与输入框底下的药丸读同一份账本（/__webcode/wait-stats），同一个数字
    // 在两处各渲染一遍——用户原话是「设置界面请你删除重复的」。累计明细现在
    // 只在药丸的点击面板里出现一次（detailRows：本会话 + 累计同屏），与官方
    // 「默认只给一个数、点开才有明细」的统计药丸契约一致。

    /**
     * 设置页外壳：经官方 standard prop 取会话身份，再交给 `Settings` 渲染。
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
     * 序列不能因为我们偶尔多调一次 hook 而变化），所以会话读取留在这一层。
     *（0.19.x：设置页里的花名册卡已按用户要求删除，`Settings` 本体不再消费会话
     * id；这一层与 `useCurrentSessionId` 保留——那个 hook 仍是任务板面板与等待药丸
     * 的会话身份入口，本槽「不得用 root 槽的 inject 冒充会话来源」也由护栏钉住。）
     */
    /**
     * **中央区三列模型并列对比视图**（0.17.3，用户需求 5：发挥多站点优势，在中心对话区并列不同模型回复）。
     */
    /**
     * **并列多会话 Team（0.18.0 重构；原 0.17.3 的「三列对比视图」）。**
     *
     * ## 用户要的到底是什么（原话，2026-09-22）
     *
     *   「team不是指的官方team那样，我想更多指的是能够充分发挥本多站点（如果实现）的优势，
     *    能够做到中心对话区域做到：并列不同模型对话进行回复」
     *   「重构team功能，本插件的并列多会话组成的team」
     *
     * 即：Team = **若干条各自独立的网页会话并排**。一次提问同时发车、各答各的，
     * 每列可继续追问（各持会话）。它不是官方 AgentTeams 的花名册。
     *
     * ## 0.17.3 那版的三个真缺陷（本轮全部修掉，不是风格重写）
     *
     *   ① **硬编码三列**：三个独立 state（col1Site/col2Site/col3Site）+ 三段复制粘贴的
     *      JSX。用户要的是「2~4 列」，而三份复制既加不了第四列、也删不掉第三列。
     *      现在改成**一个数组驱动**，加/删列各是一次数组操作。
     *   ② **用 `msgs[msgs.length - 1]` 定位回复**：并发回来时若用户已发下一轮，
     *      后到的回复会把**新一轮的用户消息**覆盖掉。现在每条消息带 `id`，按 id 精确回填。
     *   ③ **不带 `sessionKey`**：每次发起对话都开一条新网页会话，「多会话 Team」
     *      名存实亡——第二轮模型完全不记得第一轮。现在每列首次发送时铸一个稳定
     *      `sessionKey` 并**一直复用**，这才是「各自接着聊」。
     *
     * 错误语义按用户 §4-Q1 的默认：**某一列失败只标那一列，其余列照常**——
     * 对比的价值就在于不被一列拖垮。
     */
    function MultiModelCompareView(props) {
      // 站点清单可由宿主注入；拿不到用内置六个（与 providers.js 的登录站点一致）。
      const siteOptions = Array.isArray(props?.siteOptions) && props.siteOptions.length > 0
        ? props.siteOptions
        : [
          { id: 'deepseek', name: 'DeepSeek (网页基线)' },
          { id: 'glm', name: '智谱清言 (GLM)' },
          { id: 'kimi', name: 'Kimi' },
          { id: 'qwen', name: '通义千问 (Qwen)' },
          { id: 'doubao', name: '豆包 (Doubao)' },
          { id: 'zai', name: 'Z.ai' },
        ];

      // 会话身份：由宿主注入（每个 DSH 会话一套并列会话）。
      const sessionScope = String(props?.sessionId || 'local');

      // ★ 唯一的列状态：一个数组。加列 = 展开，删列 = filter，改站点 = map。
      const [cols, setCols] = React.useState(() => [
        { key: 'c1', siteId: 'deepseek', sessionKey: '', messages: [], status: 'idle', error: '' },
        { key: 'c2', siteId: 'glm', sessionKey: '', messages: [], status: 'idle', error: '' },
        { key: 'c3', siteId: 'kimi', sessionKey: '', messages: [], status: 'idle', error: '' },
      ]);
      const [prompt, setPrompt] = React.useState('');
      const [sending, setSending] = React.useState(false);
      const seqRef = React.useRef(0);
      const aliveRef = React.useRef(true);
      // 在途列数计数器。**必须在组件体顶层创建**（0.19.0 第四轮自查抓到的阻断级缺陷）。
      //
      // 它的第一版被写在 `handleSendAll` 的函数体里 —— 那是**事件处理器**，不是渲染期。
      // 真实 React 在渲染之外把 dispatcher 换成「只会抛错」的那一个，于是 `useRef`
      // 当场抛 `Invalid hook call`：点一次「同时发送」整块视图就炸，一列都发不出去，
      // 而它本来要修的是「按钮永久锁死」——修出来的病比原病更重。
      // 即便某个 React 版本容忍这种写法，每次点击都会新建一个 ref 对象，
      // 「计数在途列数」的语义也就不再跨渲染稳定。
      //
      // 为什么 887 条单测全绿也没看见：`test/client-render.test.mjs` 的 React 桩是
      // `useRef: (init) => ({ current: init })`，它**在任何位置都工作**，结构上无法
      // 察觉 hooks 规则；而 `team-compare.test.mjs` 的判据只断言源码文本里
      // **存在** `const pendingRef = React.useRef(0)` ——写在事件处理器里同样满足。
      // 两处判据都已按「位置」而不是「存在」重写，见对应测试文件的注释。
      const pendingRef = React.useRef(0);

      React.useEffect(() => () => { aliveRef.current = false; }, []);

      const MIN_COLS = 2;
      const MAX_COLS = 4;

      const addCol = () => {
        setCols((prev) => {
          if (prev.length >= MAX_COLS) return prev;
          const used = new Set(prev.map((c) => c.siteId));
          // 优先挑一个还没被占用的站点；全占了就重复第一个 ——
          // 同站多账号（accountSlot）也是合法来源，不算冲突。
          const pick = siteOptions.find((o) => !used.has(o.id))?.id || siteOptions[0].id;
          seqRef.current += 1;
          return [...prev, {
            key: 'c' + Date.now().toString(36) + seqRef.current,
            siteId: pick, sessionKey: '', messages: [], status: 'idle', error: '',
          }];
        });
      };

      const removeCol = (key) => {
        setCols((prev) => (prev.length <= MIN_COLS ? prev : prev.filter((c) => c.key !== key)));
      };

      /** 改某列的站点。**必须清空该列的会话与消息**：sessionKey 绑定在
       *  「站点+账号」上，换了站点还续用旧 key 会把消息发到一个完全陌生的会话里。
       *  这是一次有意的、用户可见的重置，因此 status/error 一并归零。 */
      const setColSite = (key, siteId) => {
        setCols((prev) => prev.map((c) => (c.key === key
          ? { ...c, siteId, sessionKey: '', messages: [], status: 'idle', error: '' }
          : c)));
      };

      /**
       * 同时发送给所有列。
       *
       * 每列**独立**发车、独立收尾：一列失败只标那一列，不 await 全体，
       * 也不让一列的 rejection 影响其它列。
       */
      const handleSendAll = (e) => {
        e?.preventDefault();
        const p = String(prompt || '').trim();
        if (!p || sending) return;
        setPrompt('');
        setSending(true);

        // 先给每一列挂上「用户消息 + 占位回复」；占位回复带 id 供精确回填。
        // jobs 在这里就收集好（含该列的 sessionKey），因为 setCols 的回调
        // 在 React 里可能被延后执行，不能依赖它的副作用顺序。
        const jobs = [];
        setCols((prev) => prev.map((c) => {
          seqRef.current += 1;
          const n = seqRef.current;
          const userId = 'u' + n;
          const botId = 'b' + n;
          // 首次发送时为该列铸一个**稳定会话键**，之后每轮复用 ——
          // 这就是「并列多会话」里「会话」二字的落点。
          const sessionKey = c.sessionKey || ('team-' + sessionScope + '-' + c.key + '-' + c.siteId);
          jobs.push({ key: c.key, siteId: c.siteId, sessionKey, botId });
          return {
            ...c,
            sessionKey,
            status: 'streaming',
            error: '',
            messages: [
              ...c.messages,
              { id: userId, role: 'user', text: p },
              { id: botId, role: 'assistant', text: '正在向 ' + siteName(c.siteId) + ' 发送并等待回复…' },
            ],
          };
        }));

        // 逐列独立收尾；**用计数器判「全体都回来了」**，而不是事后去猜列状态。
        //
        // 0.19.0 修掉的真缺陷（第三轮对抗审查抓到，本文件自己的护栏没覆盖）：
        // 原先的做法是「排一个微任务，在 `setCols` 的 updater 里扫一遍列状态，没有
        // `streaming` 残留才解锁」。它**必然不解锁**——那段微任务排进队列时，上面刚把
        // 每一列设成 `streaming`，而下面那句 POST chat 的网络往返还没回来，于是每列都被
        // 判为「仍在回复」，updater 提前返回，解锁那一行**永不执行**。
        // 后果是**一次挂载只能问一句**：三列最终都显示「已完成」，而发送按钮永远停在
        // 「发送中…」且 disabled —— 而 `conversation.view` 是中央常驻视图、不随交互卸载，
        // 所以不会自愈。（此处**刻意不逐字引用旧写法**：本仓库有多处判据按源码**文本**
        // 解析且不剥注释，写下可被解析成真实调用的字面量会被它们读成真代码，见
        // `doc/verify.md` 0.19.0 补记第六节。）
        //
        // 修法两条：① 用 `pendingRef` 计数（每列发出 +1、回来 -1），归零才解锁；
        // ② **在 updater 之外**调 `setSending`——在 `setCols` 的 updater 里调另一个
        // setState 是**不纯的 reducer**，StrictMode 双调用下行为未定义，即便修好
        // 提前返回也不该这么写。
        //
        // ① 的 `pendingRef` 声明在**组件体顶层**（本函数上方），不是这里 ——
        // 第一版把它写在本函数体里，那是事件处理器，真实 React 会抛
        // `Invalid hook call`。完整成因见那个声明处的注释。
        pendingRef.current += jobs.length;
        for (const job of jobs) {
          api('chat', { siteId: job.siteId, prompt: p, sessionKey: job.sessionKey })
            .then((res) => {
              if (!aliveRef.current) return;
              const ok = res?.ok !== false;
              setCols((prev) => prev.map((c) => (c.key !== job.key ? c : {
                ...c,
                status: ok ? 'done' : 'error',
                error: ok ? '' : String(res?.error || '未知错误'),
                // ★ 按 **id** 回填，而不是按「最后一条」。
                //   并发下「最后一条」可能已是用户刚发的下一轮消息。
                messages: c.messages.map((m) => (m.id !== job.botId ? m : {
                  ...m,
                  text: ok
                    ? String(res?.reply || res?.text || '（空回复）')
                    : '[' + siteName(job.siteId) + ' 失败] ' + String(res?.error || '未知错误'),
                })),
              })));
            })
            .catch((err) => {
              if (!aliveRef.current) return;
              setCols((prev) => prev.map((c) => (c.key !== job.key ? c : {
                ...c,
                status: 'error',
                error: String(err?.message || err),
                messages: c.messages.map((m) => (m.id !== job.botId ? m : {
                  ...m,
                  text: '[' + siteName(job.siteId) + ' 异常] ' + String(err?.message || err),
                })),
              })));
            })
            .finally(() => {
              // 计数归零 = 本轮全线收尾。`finally` 保证**无论成功/失败**都会减，
              // 因此不存在「某一列异常导致按钮永久锁死」。
              pendingRef.current -= 1;
              if (pendingRef.current <= 0 && aliveRef.current) {
                pendingRef.current = 0;
                setSending(false);
              }
            });
        }
      };

      const statusText = (c) => (c.status === 'streaming' ? '回复中…'
        : c.status === 'done' ? '已完成'
          : c.status === 'error' ? '失败' : '待发');

      return h('div', { className: 'hwb-compare-view' },
        h('div', { className: 'hwb-compare-header' },
          h('h3', { className: 'hwb-compare-title' }, '并列多会话 Team'),
          h('p', { className: 'hwb-hint' },
            '同一句话同时发给每一列；每列各持一条独立网页会话，可继续追问，互不干扰。'),
          h('div', { className: 'hwb-compare-tools' },
            h('span', { className: 'hwb-chip' }, cols.length + ' 列'),
            h('button', {
              className: 'hwb-btn small',
              onClick: addCol,
              disabled: cols.length >= MAX_COLS,
              title: cols.length >= MAX_COLS ? '最多 ' + MAX_COLS + ' 列' : '再加一列',
            }, '+ 加一列'))),

        h('div', { className: 'hwb-compare-columns', 'data-cols': String(cols.length) },
          cols.map((c) => h('div', {
            key: c.key,
            className: 'hwb-compare-col' + (c.status === 'error' ? ' bad' : ''),
          },
            h('div', { className: 'hwb-compare-col-head' },
              h('select', {
                className: 'hwb-select',
                value: c.siteId,
                onChange: (e) => setColSite(c.key, e.target.value),
              }, siteOptions.map((o) => h('option', { key: o.id, value: o.id }, o.name))),
              h('span', { className: 'hwb-compare-state ' + c.status }, statusText(c)),
              cols.length > MIN_COLS && h('button', {
                className: 'hwb-btn-close',
                title: '移除这一列',
                onClick: () => removeCol(c.key),
              }, '✕')),

            // 会话身份可见：用户要能核对「这一列到底续在哪条会话上」。
            c.sessionKey && h('div', { className: 'hwb-compare-session', title: c.sessionKey },
              '会话 ' + c.sessionKey.slice(-12)),

            h('div', { className: 'hwb-compare-col-body' },
              c.messages.length === 0 && h('p', { className: 'hwb-hint' }, '等待输入提示词…'),
              c.messages.map((m) => h('div', { key: m.id, className: 'hwb-chat-msg ' + m.role },
                h('strong', null, m.role === 'user' ? '用户: ' : siteName(c.siteId) + ': '),
                h('span', null, m.text)))),

            // 失败只标这一列，其余列照常。
            c.status === 'error' && c.error && h('p', { className: 'hwb-hint bad' }, c.error)))),

        h('form', { onSubmit: handleSendAll, className: 'hwb-compare-input-bar' },
          h('input', {
            className: 'hwb-input',
            placeholder: '输入问题，同时发送给上述 ' + cols.length + ' 个模型…',
            value: prompt,
            onChange: (e) => setPrompt(e.target.value),
          }),
          h('button', { type: 'submit', className: 'hwb-btn primary', disabled: sending },
            sending ? '发送中…' : '同时发送给 ' + cols.length + ' 个模型')));
    }

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
     * 会话身份，消费它的面板会如实显示「读不到：no-session-id」，而不是整块崩掉。
     */
    function useCurrentSessionId(props) {
      const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : noSessions;
      // 无条件调用——条件调用正是本文件上方 SiteAccounts 刚踩过的那条 hooks 规则。
      const current = useSessions(s => (s && s.current) || null);
      // 两条来源都过 sessionIdOf：官方 standard prop 给的是字符串，而 inject 那条在
      // 作用域漂移时可能是包装对象（见 sessionIdOf 的注释）。
      return sessionIdOf(current) || sessionIdOf(props?.sessionId);
    }
     /**
     * 设置页本体（纯展示）。
     *
     * 会话身份由外层 `SettingsSection` 经官方 standard prop `useSessions` 取好；
     * 本页不再消费它——原先唯一的消费者是「正在运行」卡的花名册，那张卡已按用户
     * 要求删除。那一层与 `useCurrentSessionId` 保留：任务板与等待药丸都在用。
     */
    function Settings(props) {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState('');
      const [pending, setPending] = React.useState(false);
      const [models, setModels] = React.useState(null);
      const [defaultModel, setDefaultModel] = React.useState('');
      // modelSaved 只在写入后回读时用（不再有「模型管理」卡自己那套保存按钮，
      // 但子代理卡的两个同步按钮仍走 saveSetting('defaultModel', …)）。
      const [, setModelSaved] = React.useState('');
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
      // 间隔**基准**（0.16.31）：'send-to-send'（默认）| 'end-to-start'。
      // 与 sendGapMs 同一套「草稿 / 已保存 / 提示」三件套——两者是同一条设置的两个
      // 部分（设多少、从哪算），拆成两种交互只会让人以为它们无关。
      const [sendGapBasis, setSendGapBasis] = React.useState('send-to-send');
      const [sendGapBasisSaved, setSendGapBasisSaved] = React.useState('send-to-send');
      // 提示词投递形态（0.16.3）：'attach'（默认）| 'inline'。与 sendGapMs 同一套
      // 「草稿 / 已保存 / 提示」三件套——交互形态相同（改一下、点保存）。
      const [promptTransport, setPromptTransport] = React.useState('attach');
      const [promptTransportSaved, setPromptTransportSaved] = React.useState('attach');
      const [promptTransportNotice, setPromptTransportNotice] = React.useState('');
      // 站点 tab（0.16.33）：设置页内部按站点分页，形态参考 dsh-market 的 tab 条。
      // `''` = 全局页；其余值是 siteId。切 tab **只切视图**，不改任何连接/账号底层。
      // initialSettingsTab（0.16.38）：**只给测试与将来的深链用**的初值入口。
      // 站点的账户/模型/提示词三张卡都只在站点页渲染，护栏必须能直接渲染「站点页」
      // 才能断言它们；没有这个入口，护栏只能在全局页断言「看不见」——那证明不了
      // 站点页是对的。缺省 ''（全局页），真机行为与 0.16.37 逐字相同。
      // 注意：这里**不能**用函数式初值（`useState(() => …)`）。本文件的渲染护栏
      //（test/client-render.test.mjs）是一个最小 React 桩，它把初值原样存下、不调用
      // 函数——函数式初值在桩里会变成「state 是一个函数对象」，于是全局页被当成
      // 站点页渲染，一串用例集体红。求值只需 props 一个表达式，用普通初值即可。
      const [settingsTab, setSettingsTab] = React.useState(
        SITE_NAMES[String(props?.initialSettingsTab || '')] ? String(props.initialSettingsTab) : '');
      // 站点级字典（0.16.38）：`defaultModelBySite` / `extraPromptBySite`。
      // 两者都是「站点 id → 值」，与后端 POST settings 的归一化同名同形。
      const [modelBySite, setModelBySite] = React.useState({});
      const [modelBySiteSaved, setModelBySiteSaved] = React.useState({});
      const [sitePromptBySite, setSitePromptBySite] = React.useState({});
      const [sitePromptSaved, setSitePromptSaved] = React.useState({});
      const [siteModelNotice, setSiteModelNotice] = React.useState('');
      const [sitePromptNotice, setSitePromptNotice] = React.useState('');
      // tab 条的非 passive 滚轮（见样式表注释）。
      const tabsRef = React.useRef(null);
      React.useEffect(() => {
        const el = tabsRef.current;
        if (!el || typeof el.addEventListener !== 'function') return () => {};
        const onWheel = (e) => {
          // 只接管纵向滚轮：横向滚轮（触控板左右滑）本来就能滚，抢过来会变扭。
          if (!e.deltaY || e.deltaX) return;
          const before = el.scrollLeft;
          el.scrollLeft = before + e.deltaY;
          // 真的滚动了才阻止默认：否则页面在条上滚不动（内容本来就没几屏，副作用很小，
          // 但「滚轮在条上失效」正是用户报的那个问题，所以这里必须让它生效）。
          if (el.scrollLeft !== before) e.preventDefault();
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
      }, []);
      // 槽级发送间隔（`sendGapMsBySlot`）。后端**早已支持**这一档（0.14.7 起：
      // accounts.sendGapForSlot 的回落链是「槽显式值 → 站点级键 → 全局值」，
      // web-control 的 POST settings 也已经在归一化它）——只是此前界面上没有入口，
      // 用户改不了也看不见。本版把它接出来，让「不同站点不同排队」真正可配。
      const [slotGaps, setSlotGaps] = React.useState({});
      const [slotGapSaved, setSlotGapSaved] = React.useState({});
      const [slotGapNotice, setSlotGapNotice] = React.useState('');
      // 服务端算好的投递读数（当前生效值），见 web-control 的 GET attach-status：
      // 文案只在服务端算一份，bundle 里不写第二份（本文件是单文件 bundle，
      // import 不到 lib/，两份格式化必然漂移）。
      const [attachStatus, setAttachStatus] = React.useState(null);
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
          // 间隔基准：与服务端 GET settings 同一条归一化（只有逐字 'end-to-start'
          // 才算），前端不自己造默认值——两侧各造一份默认时，面板选中项与真实
          // 行为分叉，用户没有任何办法发现。
          const basis = s.sendGapBasis === 'end-to-start' ? 'end-to-start' : 'send-to-send';
          setSendGapBasis(basis); setSendGapBasisSaved(basis);
          // 投递形态：只有逐字 'inline' 算纯文本（与 browser-driver 的
          // promptTransportNow、web-control 的 POST settings 同一判据）。
          const pt = s.promptTransport === 'inline' ? 'inline' : 'attach';
          setPromptTransport(pt); setPromptTransportSaved(pt);
          // 槽级间隔：原样取回（服务端已归一化过，非法值不会落盘）。
          // 这里**不**在前端补默认值——「没配」与「配了 0」是两件事，前者应当
          // 回落到站点/全局档，后者是明确的「这个槽不等待」。
          const bySlot = s.sendGapMsBySlot && typeof s.sendGapMsBySlot === 'object' ? s.sendGapMsBySlot : {};
          setSlotGaps(bySlot); setSlotGapSaved(bySlot);
          // 站点级字典（0.16.38）：原样取回（服务端已归一化过非法键）。
          const mbs = s.defaultModelBySite && typeof s.defaultModelBySite === 'object' ? s.defaultModelBySite : {};
          setModelBySite(mbs); setModelBySiteSaved(mbs);
          const pbs = s.extraPromptBySite && typeof s.extraPromptBySite === 'object' ? s.extraPromptBySite : {};
          setSitePromptBySite(pbs); setSitePromptSaved(pbs);
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
      /**
       * 保存**站点级**发送间隔（0.16.33）。
       *
       * 写的是 `sendGapMsBySlot[siteId]`——后端回落链的第 ② 档
       * （accounts.sendGapForSlot：槽显式值 → 站点级键 → 全局 sendGapMs）。
       * 注意默认槽的 accountKey 恰好就是 siteId，所以这一档同时承担
       * 「站点级默认」与「该站点默认账户的显式值」两种语义，与 0.14.7 的既有设计
       * 一致，本版不新增档位。
       *
       * 整体读改写：`sendGapMsBySlot` 是一个对象，只 POST 单个键会让其余键丢失。
       */
      async function saveSlotGap(siteId, ms) {
        const next = { ...slotGaps, [siteId]: Math.min(600000, Math.max(0, Math.round(Number(ms) || 0))) };
        setPending(true); setError('');
        try {
          const r = await api('settings', { sendGapMsBySlot: next });
          const back = r.sendGapMsBySlot && typeof r.sendGapMsBySlot === 'object' ? r.sendGapMsBySlot : {};
          setSlotGaps(back); setSlotGapSaved(back);
          setSlotGapNotice('已保存 ' + siteName(siteId) + ' 的排队间隔。下一次向该站点发送起生效。');
        } catch (e) { setError(e.message); }
        finally { setPending(false); }
      }

      /** 清除某站点的覆盖，回落到全局值（删除该键，而不是写 0——两者语义不同）。 */
      async function clearSlotGap(siteId) {
        const next = { ...slotGaps };
        delete next[siteId];
        setPending(true); setError('');
        try {
          const r = await api('settings', { sendGapMsBySlot: next });
          const back = r.sendGapMsBySlot && typeof r.sendGapMsBySlot === 'object' ? r.sendGapMsBySlot : {};
          setSlotGaps(back); setSlotGapSaved(back);
          setSlotGapNotice(siteName(siteId) + ' 已恢复为跟随全局间隔。');
        } catch (e) { setError(e.message); }
        finally { setPending(false); }
      }

      /**
       * 保存某站点的默认模型（0.16.38）。
       *
       * 写 `defaultModelBySite[siteId]`。与 sendGapMsBySlot 同一条纪律：整个字典
       * 读改写，只 POST 单个键会把其余站点的覆盖抹掉。
       * 传空串 = 删除该键（回落到全局默认模型）——「没配」与「配了一个空值」必须
       * 可区分，后者会白白进一次契约指纹、白白整段重建一轮。
       */
      async function saveSiteModel(siteId, modelId) {
        const next = { ...modelBySite };
        if (modelId) next[siteId] = modelId; else delete next[siteId];
        setPending(true); setError(''); setSiteModelNotice('');
        try {
          const r = await api('settings', { defaultModelBySite: next });
          const back = r.defaultModelBySite && typeof r.defaultModelBySite === 'object' ? r.defaultModelBySite : {};
          setModelBySite(back); setModelBySiteSaved(back);
          setSiteModelNotice('已保存 ' + siteName(siteId) + ' 的默认模型。下一轮起生效。');
        } catch (e) { setError(e.message); }
        finally { setPending(false); }
      }

      /** 保存某站点的专属指令（0.16.38）：整个字典读改写，空串删键。 */
      async function saveSitePrompt(siteId, text) {
        const next = { ...sitePromptBySite };
        const trimmed = String(text || '').trim();
        if (trimmed) next[siteId] = trimmed; else delete next[siteId];
        setPending(true); setError(''); setSitePromptNotice('');
        try {
          const r = await api('settings', { extraPromptBySite: next });
          const back = r.extraPromptBySite && typeof r.extraPromptBySite === 'object' ? r.extraPromptBySite : {};
          setSitePromptBySite(back); setSitePromptSaved(back);
          setSitePromptNotice(trimmed
            ? '已保存 ' + siteName(siteId) + ' 的指令。它会随该站点下一次整段重建注入。'
            : '已清空 ' + siteName(siteId) + ' 的指令（该站点只剩全局指令）。');
        } catch (e) { setError(e.message); }
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
      // 「深度思考」三态开关仅对 DeepSeek 站点有意义——判据是**当前看的是哪个站点
      // tab**（0.16.38：模型管理搬到站点页之后，这里配的对象就是那个站点；旧判据
      //「默认模型落在哪个站点」是模型管理还在全局页时的写法，已随之退役）。其余
      // 站点的 pill 契约未真机校准，不硬造开关。
      return h('section', { className: 'hwb-settings' },
        // 标题行：左边是设置名，右边是项目主页链接（用户要求「设置界面加上 github
        // 连接在顶部合适位置」）。放在标题这一行的右端而不是另起一行——设置页顶部
        // 的空间要留给**状态**（构建指纹 + 一句说明），多一行纯链接会把它挤下去。
        h('div', { className: 'hwb-settings-head' },
          h('h2', null, 'Harness Web Bridge'),
          h('a', {
            className: 'hwb-repo-link',
            href: 'https://github.com/RSLN-creator/dsh-web-bridge',
            target: '_blank', rel: 'noreferrer noopener',
            title: '在 GitHub 打开项目主页（新标签）',
          }, 'GitHub')),
        build?.hash && h('p', { className: 'hwb-build' }, '构建指纹：' + build.hash + (build.version ? ' · v' + build.version : '')),
        // 0.19.x：原文写的是「用已登录的 Edge 网页」，那是驱动改造前的措辞——桥用的是
        // 自带的 Chromium（系统浏览器只是兜底），写 Edge 会让用户以为要另装一个。
        h('p', { className: 'hwb-lead' }, '用已登录的网页驱动内容服务：右侧直接显示可操作的真实网页，模型生成与工具调用均以网页原生流程执行，与 API 调用同源。'),

        // ---- 站点 tab 条（0.16.33，0.16.38 改为滚轮横向滚动）------------------
        //
        // 一行 tab = 全局 + 每个已接入站点。选中站点后下方出现**该站点专属**的卡片
        //（账户/登录 + 该站点模型 + 该站点提示词 + 它自己的排队间隔）；选「全局」时
        // 只剩全局项。
        //
        // 0.16.38 的两点改动：
        //   · **横排单行**（不再换行成两行）：用户要「横排，然后可以通过鼠标滚轮滚动而
        //     不用显示进度条」。`flex-wrap:nowrap` + `overflow-x:auto` + 隐藏滚动条，
        //     滚轮由下面的非 passive 原生监听映射到 scrollLeft（React 的 onWheel 在
        //     根容器上是 passive，preventDefault 会失效/告警）。
        //   · tab 与下方卡片之间的间距收成一条显式 margin（见样式表），不再靠
        //     `.hwb-card` 的首个 margin 碰运气。
        //
        // 角标数字是该站点的账户数（含默认槽）——「这个站点有几个号」是切 tab 前
        // 最想知道的一件事，而它恰好只有账户行数据知道，不必再点进去看。
        h('div', { className: 'hwb-settings-tabs', role: 'tablist', 'aria-label': '设置范围', ref: tabsRef },
          h('button', {
            type: 'button', role: 'tab', 'aria-selected': settingsTab === '',
            className: 'hwb-settings-tab' + (settingsTab === '' ? ' on' : ''),
            onClick: () => setSettingsTab(''),
          }, '全局'),
          Object.keys(SITE_NAMES).map(sid => {
            const n = (sites || []).filter(r => r && r.siteId === sid).length;
            return h('button', {
              key: sid, type: 'button', role: 'tab',
              'aria-selected': settingsTab === sid,
              className: 'hwb-settings-tab' + (settingsTab === sid ? ' on' : ''),
              onClick: () => setSettingsTab(sid),
            }, siteName(sid), n > 1 ? h('span', { className: 'hwb-settings-tab-count' }, n) : null);
          })),

        // ---- 站点页：账户与登录（0.16.38 起**只在站点页**）-------------------
        settingsTab && h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, siteName(settingsTab) + ' 的账户与登录'),
          // 只列该站点的账户行——`SiteAccounts` 本来就支持 `onlySiteId`（子代理站点
          // 那一处一直在用），这里复用同一个过滤，不另写一份「按站点筛」的逻辑。
          h(SiteAccounts, { sites, onRefresh: refresh, onlySiteId: settingsTab })),

        // ---- 站点专属排队间隔（0.16.33）--------------------------------------
        // 只在选中某个站点 tab 时出现。这是用户要的「不同站点不同排队选择」：
        // 同一台机器上 DeepSeek 可以 0 秒、GLM 限流严就单独设 30 秒，互不影响。
        settingsTab && (() => {
          const cur = Object.prototype.hasOwnProperty.call(slotGaps, settingsTab)
            ? Math.min(600000, Math.max(0, Math.round(Number(slotGaps[settingsTab]) || 0)))
            : null;
          const draft = cur === null ? Math.min(600000, Math.max(0, Math.round(Number(sendGapMs) || 0))) : cur;
          const presets = [0, 2000, 5000, 10000, 30000, 60000];
          return h('div', { className: 'hwb-card' },
            h('h3', { className: 'hwb-group first' }, siteName(settingsTab) + ' 的排队间隔'),
            h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '发送间隔'),
              h('div', { className: 'hwb-row-main' },
                h('select', {
                  className: 'hwb-model-select', style: { maxWidth: '150px' },
                  value: presets.includes(draft) ? String(draft) : 'custom',
                  disabled: pending,
                  onChange: e => {
                    if (e.target.value === 'custom') return;
                    setSlotGaps(p => ({ ...p, [settingsTab]: Number(e.target.value) }));
                  },
                },
                  presets.map(p => h('option', { key: p, value: String(p) }, p === 0 ? '关闭' : (p / 1000) + ' 秒')),
                  h('option', { value: 'custom' }, '自定义…')),
                h('input', {
                  type: 'number', className: 'hwb-model-select', style: { maxWidth: '130px' },
                  min: 0, max: 600000, step: 500,
                  value: draft, disabled: pending,
                  title: '该站点两次发送之间的最小间隔（毫秒）',
                  onChange: e => setSlotGaps(p => ({ ...p, [settingsTab]: Math.min(600000, Math.max(0, Math.round(Number(e.target.value) || 0))) })),
                }),
                h('button', {
                  disabled: pending || draft === (cur === null ? null : Math.round(Number(slotGapSaved[settingsTab]) || 0)),
                  onClick: () => saveSlotGap(settingsTab, draft),
                }, '保存'),
                cur !== null && h('button', {
                  disabled: pending,
                  title: '删除该站点的覆盖，回落到上面的全局间隔',
                  onClick: () => clearSlotGap(settingsTab),
                }, '跟随全局'),
                slotGapNotice && h('span', { className: 'hwb-hint' }, slotGapNotice))),
            h('p', { className: 'hwb-hint indent' },
              cur === null
                ? '未覆盖：跟随全局间隔 ' + (Math.round(Number(sendGapMs) || 0) / 1000) + ' 秒'
                : '已覆盖为 ' + (cur / 1000) + ' 秒，只对本站点生效（点「跟随全局」清除）'));
        })(),

        // ---- 站点页：模型管理（0.16.38）-------------------------------------
        //
        // 用户要求：「模型管理……两者逻辑上单独适配全局和单独站点！你却全都有放置，
        // 请你按照我的要求删除对应 UI」，并在追问里选定「只留站点页」。
        //
        // 于是模型的配置**全部**落在站点页，全局页不再出现「模型管理」卡；为了不让
        //「默认落在哪个站点」在全局页无处可查，全局页保留一行只读的「主线落点」，
        // 点它直接跳到对应站点 tab（见下方连接卡）。
        //
        // 三件事各自的语义（文档 doc/settings-copy.md 有完整版）：
        //   · 本网站默认模型 → defaultModelBySite[siteId]，只覆盖本站点用哪一支；
        //   · 主线落点       → defaultModel（全局单值），新会话未显式选模型时的落点；
        //   · 深度思考       → thinkMode（全局单值），只有 deepseek 站点的开关已校准。
        settingsTab && h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, siteName(settingsTab) + ' 的模型'),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '本网站默认模型'),
            h('div', { className: 'hwb-row-main' },
              // 只列**该站点**的模型：站点页的选择框里混进别的站点，等于把「这个站点
              // 用哪一支」这件事重新变成全局问题。
              h(ModelSelect, {
                // `models ? … : null` 而不是 `(models || []).filter(…)`：空数组是**真值**，
                // ModelSelect 的 `if (!models)` 兜不住它——目录还在加载时站点页会渲染一个
                // **空下拉**，看起来像「这个站点没有模型」，而真相是「还没读到」。
                // 传 null 才会走它那句「加载模型目录…」的诚实态。
                models: models ? models.filter(m => String(m.siteId) === settingsTab) : null,
                value: modelBySite[settingsTab] || '',
                disabled: pending,
                placeholder: '跟随主线默认模型',
                onChange: v => saveSiteModel(settingsTab, v),
              }),
              h('button', {
                disabled: pending || !modelBySite[settingsTab],
                title: '删除本网站的覆盖，回落到上面的主线默认模型',
                onClick: () => saveSiteModel(settingsTab, ''),
              }, '跟随主线'),
              siteModelNotice && h('span', { className: 'hwb-hint' }, siteModelNotice))),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '主线落点'),
            h('div', { className: 'hwb-row-main' },
              h('span', { className: 'hwb-hint' }, defaultModel ? defaultModel + ' · ' + currentModelName(defaultModel) : '（未设置）'),
              h('button', {
                disabled: pending || !models,
                title: '把主线默认模型设为本站点的默认模型',
                onClick: () => {
                  const hit = (models || []).find(m => String(m.siteId) === settingsTab && /:auto$/.test(m.id))
                    || (models || []).find(m => String(m.siteId) === settingsTab);
                  if (!hit) { setSiteModelNotice('本站点没有可用模型，无法设为主线默认。'); return; }
                  saveSetting('defaultModel', hit.id, r => {
                    setDefaultModel(r.defaultModel || hit.id); setModelSaved(r.defaultModel || hit.id);
                    setSiteModelNotice('主线默认已设为 ' + hit.id + '。');
                  });
                },
              }, '用本站点作为主线默认'))),
          // 深度思考：三态开关**只对 deepseek** 有意义（其余站点的 pill 契约未真机
          // 校准，不硬造开关）。判据从「默认模型落在哪个站点」改成「当前看的是哪个
          // 站点 tab」——模型管理搬到站点页之后，后者才是用户此刻在配的对象。
          settingsTab === 'deepseek' && h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '深度思考'),
            h('div', { className: 'hwb-row-main' },
              h('select', { className: 'hwb-model-select', value: thinkMode, disabled: pending, onChange: e => setThinkMode(e.target.value) },
                h('option', { value: 'auto', title: '按所选模型的默认思考行为' }, '自动'),
                h('option', { value: 'on', title: '强制打开网页「深度思考」开关' }, '始终开启'),
                h('option', { value: 'off', title: '追求速度' }, '始终关闭')),
              h('button', { disabled: pending || thinkMode === thinkSaved, onClick: () => saveSetting('thinkMode', thinkMode, r => { const v = ['on', 'off', 'auto'].includes(r.thinkMode) ? r.thinkMode : thinkMode; setThinkMode(v); setThinkSaved(v); setThinkNotice('已保存。下次生成起生效。'); }) }, '保存'),
              thinkNotice && h('span', { className: 'hwb-hint' }, thinkNotice))),
          h('p', { className: 'hwb-hint indent' }, '当前网页模型：' + (driver?.selectedModel ? currentModelName(driver.selectedModel) : '未选择（按默认模型）'))),

        // ---- 站点页：该站点的首轮提示词（0.16.38）---------------------------
        //
        // 用户要求：站点页的提示词「只能改自己的」，并且**指向该网站本地提示词文本
        // 的存储文件、可点击打开**，而不是把全文铺在设置页里。
        //
        // 因此这一卡只有三行：文件（可打开）+ 本网站指令（唯一可编辑）+ 只读模板
        //（默认折叠，用来核对「此刻真的在教什么」）。
        settingsTab && h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, siteName(settingsTab) + ' 的首轮提示词'),
          h(SitePromptCard, {
            siteId: settingsTab,
            value: sitePromptBySite[settingsTab] || '',
            saved: sitePromptSaved[settingsTab] || '',
            notice: sitePromptNotice,
            onSave: (text) => saveSitePrompt(settingsTab, text),
            disabled: pending,
          })),

        // 0.19.x：原先这里有一张「正在运行（子代理 / Team）」卡（渲染 AgentRoster）。
        // 用户判定它不属于设置界面（原话「为什么设置界面需要？？？」），整卡与组件
        // 一并删除；花名册数据仍由任务板面板经 useRoster 消费，不在这里画第二份。

        // ---- 全局页：全局发送间隔（0.16.38）--------------------------------
        //
        // 「发送间隔」原来长在「模型管理」卡里，而模型管理整块搬去了站点页。间隔
        // 本身是**全局回落档**（站点覆盖在站点页），因此留一张全局卡，只放间隔与
        // 基准两行——不把它塞进「连接」或「会话与子代理」里，那两张卡各有别的语义。
        !settingsTab && h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '发送间隔（全局）'),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '发送间隔'),
            h('div', { className: 'hwb-row-main' },
              (() => {
                const presets = [0, 2000, 5000, 10000, 30000, 60000];
                const gap = Math.min(600000, Math.max(0, Math.round(Number(sendGapMs) || 0)));
                return [
                  h('select', { key: 'gap-preset', className: 'hwb-model-select', style: { maxWidth: '150px' }, value: presets.includes(gap) ? String(gap) : 'custom', disabled: pending,
                    onChange: e => { if (e.target.value !== 'custom') setSendGapMs(Number(e.target.value)); } },
                    presets.map(p => h('option', { key: p, value: String(p) }, p === 0 ? '关闭' : (p / 1000) + ' 秒')),
                    h('option', { value: 'custom' }, '自定义…')),
                  h('input', { key: 'gap-input', type: 'number', className: 'hwb-model-select', style: { maxWidth: '130px' }, min: 0, max: 600000, step: 500, value: gap, disabled: pending,
                    placeholder: '毫秒', title: '两次向同一网站发送之间的最小间隔（毫秒）',
                    onChange: e => setSendGapMs(Math.min(600000, Math.max(0, Math.round(Number(e.target.value) || 0)))) }),
                ];
              })(),
              h('button', { disabled: pending || (Math.round(Number(sendGapMs) || 0) === Math.round(Number(sendGapSaved) || 0) && sendGapBasis === sendGapBasisSaved),
                onClick: () => saveSetting('sendGapBasis', sendGapBasis === 'end-to-start' ? 'end-to-start' : 'send-to-send', r => {
                  const v = r.sendGapBasis === 'end-to-start' ? 'end-to-start' : 'send-to-send';
                  setSendGapBasis(v); setSendGapBasisSaved(v);
                  // 间隔与基准是同一条设置的两半：一次保存把两半都写下去，
                  // 避免「改了基准但间隔还是草稿值」这种半保存状态。
                  saveSetting('sendGapMs', Math.min(600000, Math.max(0, Math.round(Number(sendGapMs) || 0))), r2 => {
                    const g = Math.min(600000, Math.max(0, Math.round(Number(r2.sendGapMs) || 0)));
                    setSendGapMs(g); setSendGapSaved(g); setSendGapNotice('已保存。下一次发送起生效。');
                  });
                }) }, '保存'),
              sendGapNotice && h('span', { className: 'hwb-hint' }, sendGapNotice))),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '间隔基准'),
            h('div', { className: 'hwb-row-main' },
              h('select', { className: 'hwb-model-select', value: sendGapBasis, disabled: pending,
                onChange: e => setSendGapBasis(e.target.value === 'end-to-start' ? 'end-to-start' : 'send-to-send') },
                h('option', { value: 'send-to-send', title: '防限流：距上次发出' }, '距上次发出'),
                h('option', { value: 'end-to-start', title: '防贴太紧：距上次回复完成' }, '距上次回复完成')),
              h('span', { className: 'hwb-hint' }, sendGapBasis === 'end-to-start'
                ? '答完那一刻起重新数满间隔。'
                : '按请求到达计，上一轮跑得久时本轮无需再等。')))),

        // 提示词投递形态（0.16.3）。用户原话：「没有做到能够把提示词放入文本
        //（设置界面也改为打开文本）导致输出对话一开头就很长 token 窗口」——
        // 附件投递此前既没有开关、也没有读数，用户改不了也看不见。
        // 0.16.38：只在全局页——投递形态是进程级选择，站点差异走驱动自己的站点禁令。
        //
        // 0.19.x：机制说明、「最近一次实际投递」与「附件探针」按用户要求撤掉——
        // 探针是开发者自用工具，不该出现在用户设置界面。只留形态选择 + 一行当前
        // 生效值；探针能力仍在服务端（POST /__webcode/attach-probe），需要时从 HTTP
        // 直接调。两个形态的差别挪进 title：界面一行读得完，信息不丢。
        !settingsTab && h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '提示词投递'),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '投递形态'),
            h('div', { className: 'hwb-row-main' },
              h('label', { className: 'hwb-consent', key: 'pt-attach', title: '超过阈值的正文改为附件上传；任何一步失败都自动回落纯文本' },
                h('input', {
                  type: 'radio', name: 'hwb-prompt-transport', checked: promptTransport === 'attach', disabled: pending,
                  onChange: () => setPromptTransport('attach'),
                }),
                h('span', null, '附件投递')),
              h('label', { className: 'hwb-consent', key: 'pt-inline', title: '正文逐字写进网页输入框（旧行为）' },
                h('input', {
                  type: 'radio', name: 'hwb-prompt-transport', checked: promptTransport === 'inline', disabled: pending,
                  onChange: () => setPromptTransport('inline'),
                }),
                h('span', null, '纯文本')),
              h('button', {
                disabled: pending || promptTransport === promptTransportSaved,
                onClick: () => saveSetting('promptTransport', promptTransport, r => {
                  const v = r.promptTransport === 'inline' ? 'inline' : 'attach';
                  setPromptTransport(v); setPromptTransportSaved(v);
                  setPromptTransportNotice('已保存。下一轮起生效。');
                }),
              }, '保存'),
              promptTransportNotice && h('span', { className: 'hwb-hint' }, promptTransportNotice))),
          h('p', { className: 'hwb-hint indent' }, '当前生效：' + (attachStatus?.transportLine || '读数加载中…'))),

        !settingsTab && h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '连接'),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '网页服务'),
            h('div', { className: 'hwb-row-main' }, h('span', null, relay?.running ? '中继已连接' : '未启动'))),
          // 主线落点只读行（0.16.38）：模型配置搬到站点页后，全局页必须仍能回答
          //「默认会落到哪个站点」。点它直接跳到对应站点 tab。
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '主线落点'),
            h('div', { className: 'hwb-row-main' },
              h('span', { className: 'hwb-hint' }, defaultModel ? defaultModel + ' · ' + currentModelName(defaultModel) : '（未设置）'),
              (() => {
                const sid = String(defaultModel || '').split(':')[0];
                return sid && SITE_NAMES[sid]
                  ? h('button', { type: 'button', onClick: () => setSettingsTab(sid) }, '去配置 ' + siteName(sid))
                  : null;
              })())),
          h('div', { className: 'hwb-row' },
            h('label', { className: 'hwb-consent' },
              h('input', {
                type: 'checkbox', checked: consent, disabled: pending,
                onChange: e => action('consent', { accepted: e.target.checked }),
              }),
              h('span', null, '启用网页自动化')),
            h('span', { className: 'hwb-hint' },
              consent
                ? (relay?.consentPersistent ? '已启用（本机永久保存）' : '已启用（仅本次运行）')
                : '未启用'))),

        !settingsTab && h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '速度与等待'),
          // 0.15.10 曾以「重复」为由删掉这里的等待统计。0.16.39 加回来的是**不同**
          // 一块：两本账并排的只读总览（本会话 / 历史累计）+ 平均每次 + 限流重试，
          // 这些数在药丸点开的小面板里放不下。数据仍走同一个 /wait-stats 端点、
          // 服务端算好的 `statBlocks`，因此不会与药丸打架（详见 WaitTotals 注释）。
          h('div', { className: 'hwb-row' }, h('div', { className: 'hwb-row-main' }, h(WaitTotals, { metrics }))),
          // 「速度」实测指标：与本轮生成有关，随对话推进变化，因此单独一段。
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

        !settingsTab && h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '会话与子代理'),
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '子代理网页会话'),
            h('div', { className: 'hwb-row-main' },
              h('select', { className: 'hwb-model-select', value: subAgentMode, disabled: pending, onChange: e => setSubAgentMode(e.target.value) },
                h('option', { value: 'own' }, '独立（推荐）：每个子代理一个新对话'),
                h('option', { value: 'share' }, '共用：与主会话同一对话')),
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
                : h('span', { className: 'hwb-hint' }, '跟随主线站点：与主线共用账户，无需单独登录。'))),
          // 会话隔离（0.16.38）：原文三段把「网页会话槽怎么分」「同站点共享登录」「按钮
          // 只同步站点选择」混在一起，读者要自己拼。压成一句可核对的读数；完整解释
          // 在 doc/settings-copy.md。
          h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '会话隔离'),
            h('div', { className: 'hwb-row-main' }, h('span', { className: 'hwb-hint' },
              (driver?.conversationCount ?? 0) + ' 个网页会话槽')))),

        // ---- 全局页：全局指令（0.16.38）-------------------------------------
        //
        // 站点页只编辑**该站点**那一段；这里编辑的是注入每个新网页会话的公共段。
        // 两块分开之后，「每行一个网站 + 每个网站只能改自己的」才在界面上成立。
        !settingsTab && h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '全局指令'),
          h('p', { className: 'hwb-hint' }, '追加一段 [全局指令] 注入每个新网页会话的首条消息。'),
          h(GlobalPrompt)),

        // ---- 全局页：首轮提示词模板总览（0.16.38）---------------------------
        //
        // 站点页只给该站点那一行与文件入口；这里给一张**全站点对照表**：每行一个
        // 站点 + 它实际使用的协议 + 该站点的提示词文件路径。要看某个站点此刻真的
        // 在教什么，展开对应站点页的只读模板即可（那是唯一正本）。
        !settingsTab && h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '首轮提示词（只读）'),
          h('p', { className: 'hwb-hint' }, '只读：模板按本会话工具清单生成；可编辑的是全局指令与各站点自己的那一段。'),
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

    // ---- 站点图标与一级选择框（0.16.22） --------------------------------------
    //
    // ## 为什么需要一个「档位」表，而不是一张图标表
    //
    // 用户的要求是「用各站官方矢量透明底图标」。调研结论（doc/brand-icons-research.md）
    // 说得很清楚：**多数站点并不对外发布透明底纯符号的官方 SVG**——官方给的多是
    // 「文字+符号」组合标，或干脆只有 PNG/ICO；第三方图集（LobeHub / Wikimedia 社区
    // 上传 / logo.dev）里那些看着像的，**不是品牌方资产**。
    //
    // ## 0.16.36：真实品牌图标已上网取回（用户：「把官方图上网找来」）
    //
    // 来源是 **simple-icons**（CC0-1.0 公有领域），逐条列出来源与取件日期。
    // 用它而不是各家官网的 zipped brand kit，理由与官方 primitives 的选择一致：
    // 官方自己的 `siteGlyph`（LinkIcon 的前导图标）用的就是这个图集
    //（见 `@deepseek-ai/dsh-client-ui-primitives/lib/index.js` 的 `SITE_HOSTS`），
    // 因此「本仓库用 simple-icons」不是自选第三方，而是**跟随官方口径**；且它是
    // CC0，无署名义务、无商标许可问题（商标仍归各品牌方，此处仅作指代）。
    //
    // ## 0.16.37：这九条路径**已与上游逐字符核对**（不再是「声明」）
    //
    // 0.16.36 的注释只能说「取件自某源」，因为当时外网被挡、无从比对
    //（doc/long-term-issues.md §27 把这条挂成了未解决项）。本轮外网通了，改用
    // 「取回上游 SVG → 原样贴进复核脚本 → 逐字符比对」，`.tmp/icon-source-verify.mjs`
    // 一次跑通，**九条全部 IDENTICAL**。
    //
    // 核对时查出一条**必须写在这里的事实**：`openai` 在 simple-icons **latest 里已经 404**，
    // 只在 14.5.0 还能取到（该图标后来被图集移除）。所以下面它那条的来源写成
    // 钉版本的 14.5.0——别人拿 `@latest` 去复核会得到 404，然后**误判成路径是编造的**。
    // 其余七条在 16.32.0 与 latest 一致。
    //
    // 取件日期 2026-09-20（simple-icons）与 2026-09-21（lobehub，见下一节），
    // URL 前缀 `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/`：
    //   deepseek.svg / openai.svg / anthropic.svg / googlegemini.svg / x.svg /
    //   qwen.svg / moonshotai.svg / bytedance.svg   ← 八个站点取到
    //   zhipu.svg / chatglm.svg / doubao.svg / zai.svg  ← **404，确实没有**
    //（0.16.37 补测：z-ai / zhipuai / bigmodel / zcode / glm 五个 slug 同样 404。
    //  缺的那两个改从 lobehub 取，见下一节。）
    //
    // 路径按 24×24 视箱原样落库（只取 path 的 `d`，颜色走 currentColor 随主题）。
    // 站点 → 图标的**对应关系**记在注释里，因为 slug 与站点 id 不同名：
    //   chatgpt→openai   claude→anthropic   gemini→googlegemini
    //   grok→x           kimi→moonshotai    doubao→bytedance
    // 十个站点**全部**有矢量（0.16.37 起），没有一个是文字标记。
    const SITE_ICON_PATHS = {
      // simple-icons/openai.svg —— **钉 14.5.0**：latest 已 404（该图标被图集移除）。
      // 见本节顶部 0.16.37 的说明：拿 @latest 复核会误判成「路径是编造的」。
      chatgpt: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
      // simple-icons/anthropic.svg
      claude: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z',
      // simple-icons/googlegemini.svg
      gemini: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81',
      // simple-icons/x.svg
      grok: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z',
      // simple-icons/qwen.svg
      qwen: 'M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z',
      // simple-icons/moonshotai.svg
      kimi: 'm1.053 16.91 9.538 2.55a21 20.981 0 0 0 .06 2.031l5.956 1.592a12 11.99 0 0 1-15.554-6.172m-1.02-5.79 11.352 3.035a21 20.981 0 0 0-.469 2.01l10.817 2.89a12 11.99 0 0 1-1.845 2.004L.658 15.918a12 11.99 0 0 1-.625-4.796m1.593-5.146L13.573 9.17a21 20.981 0 0 0-1.01 1.874l11.297 3.02a21 20.981 0 0 1-.67 2.362l-11.55-3.087L.125 10.26a12 11.99 0 0 1 1.499-4.285ZM6.067 1.58l11.285 3.016a21 20.981 0 0 0-1.688 1.719l7.824 2.091a21 20.981 0 0 1 .513 2.664L2.107 5.218a12 11.99 0 0 1 3.96-3.638M21.68 4.866 7.222 1.003A12 11.99 0 0 1 21.68 4.866',
      // simple-icons/bytedance.svg（豆包属字节系，品牌方未单独发布豆包矢量）
      doubao: 'M19.8772 1.4685L24 2.5326v18.9426l-4.1228 1.0563V1.4685zm-13.3481 9.428l4.115 1.0641v8.9786l-4.115 1.0642v-11.107zM0 2.572l4.115 1.0642v16.7354L0 21.428V2.572zm17.4553 5.6205v11.107l-4.1228-1.0642V9.2568l4.1228-1.0642z',
      // ---- 0.16.37：GLM 与 Z.ai 终于也有真实矢量了（用户：「z.ai 和 glm 看搜索 zcode
      // 看看有没有图标」）-----------------------------------------------------------
      //
      // 先把**查证过程**写下来，因为结论与 0.16.36 的记载相反：
      //
      //   · simple-icons 里确实没有——本轮逐条实测 `zhipu` / `chatglm` / `zai` /
      //     `z-ai` / `zhipuai` / `bigmodel` / `zcode` / `glm` 八个 slug，
      //     jsDelivr 与 unpkg 两个源**全部 404**。所以 0.16.36「simple-icons 没有"
      //     这一句是**对的**。
      //   · 但它们并非没有矢量：`@lobehub/icons-static-svg` 同时收录了两家的标记。
      //     本轮取回并逐字落库（源 URL 见下），因此不再用文字标记占位。
      //
      // **来源必须分开说清楚，这是本文件最容易被含糊过去的一处**：lobehub 是
      // 社区图集，**不是品牌方发布的资产**，与 simple-icons（CC0）也不同许可。
      // 它满足的是「真实矢量、透明底、随 currentColor」，不满足「官方发布」。
      // 上一轮那份调研（doc/brand-icons-research.md）把这一点写得很死；本轮改用它，
      // 是权衡后的选择而不是忽略——用户明确要求这两站也要有图标，而官方渠道
      // 确实没有可直接引用的透明底符号。逐行 `title` 里照实写「来源 lobehub」。
      //
      // 取件 2026-09-21，URL 前缀 `https://unpkg.com/@lobehub/icons-static-svg@latest/icons/`：
      //   zai.svg（Z.ai）· chatglm.svg（智谱清言 / GLM）
      zai: 'M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z',
      glm: 'M9.917 2c4.906 0 10.178 3.947 8.93 10.58-.014.07-.037.14-.057.21l-.003-.277c-.083-3-1.534-8.934-8.87-8.934-3.393 0-8.137 3.054-7.93 8.158-.04 4.778 3.555 8.4 7.95 8.332l.073-.001c1.2-.033 2.763-.429 3.1-1.657.063-.031.26.534.268.598.048.256.112.369.192.34.981-.348 2.286-1.222 1.952-2.38-.176-.61-1.775-.147-1.921-.347.418-.979 2.234-.926 3.153-.716.443.102.657.38 1.012.442.29.052.981-.2.96.242C17.226 19.632 13.833 22 9.918 22 3.654 22 0 16.574 0 11.737 0 5.947 4.959 2 9.917 2zM9.9 5.3c.484 0 1.125.225 1.38.585 3.669.145 4.313 2.686 4.694 5.444.255 1.838.315 2.3.182 1.387l.083.59c.068.448.554.737.982.516.144-.075.254-.231.328-.47a.2.2 0 01.258-.13l.625.22a.2.2 0 01.124.238 2.172 2.172 0 01-.51.92c-.878.917-2.757.664-3.08-.62-.14-.554-.055-.626-.345-1.242-.292-.621-1.238-.709-1.69-.295-.345.315-.407.805-.406 1.282L12.6 15.9a.9.9 0 01-.9.9h-1.4a.9.9 0 01-.9-.9v-.65a1.15 1.15 0 10-2.3 0v.65a.9.9 0 01-.9.9H4.8a.9.9 0 01-.9-.9l.035-3.239c.012-1.884.356-3.658 2.47-4.134.2-.045.252.13.29.342.025.154.043.252.053.294.701 3.058 1.75 4.299 3.144 3.722l.66-.331.254-.13c.158-.082.25-.131.276-.15.012-.01-.165-.206-.407-.464l-1.012-1.067a8.925 8.925 0 01-.199-.216c-.047-.034-.116.068-.208.306-.074.157-.251.252-.272.326-.013.058.108.298.362.72.164.288.22.508-.31.343-1.04-.8-1.518-2.273-1.684-3.725-.004-.035-.162-1.913-.162-1.913a1.2 1.2 0 011.113-1.281L9.9 5.3zm12.994 8.68c.037.697-.403.704-1.213.591l-1.783-.276c-.265-.053-.385-.099-.313-.147.47-.315 3.268-.93 3.31-.168zm-.915-.083l-.926.042c-.85.077-1.452.24.338.336l.103.003c.815.012 1.264-.359.485-.381zm1.667-3.601h.01c.79.398.067 1.03-.65 1.393-.14.07-.491.176-1.052.315-.241.04-.457.092-.333.16l.01.005c1.952.958-3.123 1.534-2.495 1.285l.38-.148c.68-.266 1.614-.682 1.666-1.337.038-.48 1.253-.442 1.493-.968.048-.106 0-.236-.144-.389-.05-.047-.094-.094-.107-.148-.073-.305.7-.431 1.222-.168zm-2.568-.474c-.135 1.198-2.479 4.192-1.949 2.863l.017-.042c.298-.717.376-2.221 1.337-3.221.25-.26.636.035.595.4zm-7.976-.253c.02-.694 1.002-.968 1.346-.347.01-1.274-1.941-.768-1.346.347z',
    };
    /**
     * 站点 id → { tier, why }。tier 只有 'official' 与 'missing' 两态，没有中间态。
     *
     * 三档的含义（0.16.37 起），每一档都指向**一个可核对的事实**：
     *
     *   · `official` —— 官方发布的矢量。DeepSeek 走本机 primitives 的 FishLogo；
     *     其余八个走 simple-icons（CC0，官方 primitives 自己的 `siteGlyph` 用的也是它）。
     *   · `vector`  —— **真实但非官方发布**的矢量。GLM 与 Z.ai 属这一档：simple-icons
     *     实测没有它们的条目（zhipu / chatglm / zai / z-ai / zhipuai / bigmodel /
     *     zcode / glm 八个 slug 全 404），改取 lobehub 的社区图集。真实矢量、透明底、
     *     随 currentColor——但**不是品牌方资产**，这一档的存在就是为了不把这句话含糊掉。
     *   · `missing` —— 没有矢量，退回文字标记。当前**十个站点一个都不属于这档**；
     *     保留这一档是因为站点表将来还会加人，而「新站点暂时没有图标」必须是一种
     *     可以说出来的状态，而不是悄悄变成首字母。
     */
    const SITE_ICON_TIER = {
      deepseek: { tier: 'official', why: '官方鲸鱼矢量（@deepseek-ai/dsh-client-ui-primitives 的 FishLogo / FISH_LOGO_PATH）' },
      chatgpt: { tier: 'official', why: 'simple-icons/openai.svg（CC0-1.0，取件 2026-09-20）' },
      claude: { tier: 'official', why: 'simple-icons/anthropic.svg（CC0-1.0，取件 2026-09-20）' },
      gemini: { tier: 'official', why: 'simple-icons/googlegemini.svg（CC0-1.0，取件 2026-09-20）' },
      grok: { tier: 'official', why: 'simple-icons/x.svg（CC0-1.0，取件 2026-09-20）' },
      qwen: { tier: 'official', why: 'simple-icons/qwen.svg（CC0-1.0，取件 2026-09-20）' },
      kimi: { tier: 'official', why: 'simple-icons/moonshotai.svg（CC0-1.0，取件 2026-09-20）' },
      doubao: { tier: 'official', why: 'simple-icons/bytedance.svg（CC0-1.0，取件 2026-09-20）' },
      // 0.16.37：这两行从 'missing' 改成 'official' 之外的新档 'vector'——**档位名不能骗人**。
      //
      // 'official' 在本文件里的含义一直是「磁盘上有真实品牌矢量」，而它此前只覆盖
      // simple-icons（CC0）与官方鲸鱼。GLM / Z.ai 现在用的是 lobehub 的矢量：
      // 真实、透明底、随 currentColor，但**不是品牌方发布、也不是 CC0**。
      // 把它并进 'official' 会把「来源等级」这件事含糊掉（而这一档的全部价值就是
      // 让用户一眼看出图标从哪来），因此单开一档，逐行 title 里写明来源。
      glm: { tier: 'vector', why: '真实矢量，来源 @lobehub/icons-static-svg（社区图集，非品牌方发布；simple-icons 实测无此条目），取件 2026-09-21' },
      zai: { tier: 'vector', why: '真实矢量，来源 @lobehub/icons-static-svg（社区图集，非品牌方发布；simple-icons 实测无此条目），取件 2026-09-21' },
    };
    const siteTier = sid => SITE_ICON_TIER[sid]?.tier || 'missing';
    const siteIconWhy = sid => SITE_ICON_TIER[sid]?.why || '官方矢量图标未找到';
    /**
     * 该站点是否有**真实品牌矢量**（official 或 vector 两档都算）。
     *
     * 为什么单独抽出来而不是继续写 `siteTier(sid) === 'official'`：这个判据有两个
     * 用途——给图标上品牌色、决定 title 里要不要说「没有矢量」。0.16.37 多出一档
     * `vector` 之后，两处都得跟着认它；散着写 `=== 'official'` 就会让 GLM / Z.ai
     * 有图标却按「没有图标」渲染（灰的、还带一句「未找到」）。判据只有一个来源。
     */
    const hasBrandVector = sid => siteTier(sid) !== 'missing';

    /**
     * 站点标记：有官方矢量就画官方矢量，没有就画文字标记。
     *
     * 两种形态**共用一个 svg 画布与尺寸口径**，因此同一排里图标的光学大小一致
     * （文字标记按「几个字母填满同样的圆框」排版，不是各自一个尺寸）。
     *
     * DeepSeek 走 FISH_LOGO_PATH 自己组 svg（而不是直接 <FishLogo/>）：鲸鱼原生
     * viewBox 是 23.16×17.04（宽高比 1.36），塞进方形框会左右留白、视觉偏小；
     * 这里按**正方形 viewBox + 手动居中**摆放，与旁边的文字标记对齐。
     * 路径常量是官方注释明说「exported for consumers that compose their own svg」的用法。
     */
    function SiteGlyph({ sid, size = 18 }) {
      const box = size + 8;
      if (sid === 'deepseek') {
        // 0.16.38 修正：旧写法只 translate、**没有 scale**，而鲸鱼路径的坐标是
        // 23.16×17.04 的原始视箱——直接放进 size+8 的方框里会按 1:1 画，右边因此
        // 越出图标框（用户报的「deepseek 图标超出框的范围」）。
        //
        // 现在与下面 simple-icons 那条分支用**同一套几何**：等比缩放到 size，再在
        // 方框里双向居中。高宽比在这里由 viewBox 决定，不需要再手算 hh。
        const scale = size / FISH_LOGO_VIEWBOX.width;
        const drawW = size;
        const drawH = FISH_LOGO_VIEWBOX.height * scale;
        return h('svg', {
          className: 'hwb-glyph-svg', width: box, height: box, viewBox: '0 0 ' + box + ' ' + box,
          'aria-hidden': 'true', focusable: 'false',
        }, h('path', {
          d: FISH_LOGO_PATH, fill: 'currentColor',
          transform: 'translate(' + ((box - drawW) / 2) + ' ' + ((box - drawH) / 2) + ') scale(' + scale + ')',
        }));
      }
      // simple-icons 取回的 24×24 单路径图标（0.16.36）：原样放进方形画布居中。
      // 与鲸鱼那条分支**同一套尺寸口径**（box = size + 8、currentColor），因此同一
      // 排里光学大小一致——两种来源的图标混排时不会一大一小。
      const scIcon = SITE_ICON_PATHS[sid];
      if (scIcon) {
        const pad = (box - size) / 2;
        return h('svg', {
          className: 'hwb-glyph-svg', width: box, height: box, viewBox: '0 0 ' + box + ' ' + box,
          'aria-hidden': 'true', focusable: 'false',
        }, h('path', {
          d: scIcon, fill: 'currentColor',
          transform: 'translate(' + pad + ' ' + pad + ') scale(' + (size / 24) + ')',
        }));
      }
      // 文字标记：品牌名缩写。**不是**「找不到图标就用首字母凑合」——它是有意
      // 为之的占位表达，`title` 里会写明矢量尚未取得，用户一眼能看出区别。
      //
      // 0.16.37：这一支现在是**空的**（十个站点都有真实矢量了），但分支保留——
      // 站点表将来加人时，「新站点暂时没有图标」必须是一种画得出来的状态。
      // 缩进取该站点 id 的前两个字符（大写）：写死一张 GL/ZA 的对照表在上一轮
      // 还有意义（那时确定的只有这两个），现在它只剩「给未知站点兜底」一个用途，
      // 而兜底本来就该对任何 id 成立。
      const mark = String(sid || '?').slice(0, 2).toUpperCase();
      return h('svg', {
        className: 'hwb-glyph-svg', width: box, height: box, viewBox: '0 0 ' + box + ' ' + box,
        'aria-hidden': 'true', focusable: 'false',
      }, h('circle', {
        cx: box / 2, cy: box / 2, r: box / 2 - 0.5,
        fill: 'none', stroke: 'currentColor', 'stroke-opacity': 0.35,
      }), h('text', {
        x: box / 2, y: box / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-size': Math.max(8, Math.round(size * 0.5)), 'font-weight': 600, fill: 'currentColor',
      }, mark));
    }

    /**
     * 一级站点选择框 `SitePicker`（含面板 `SitePickerSurface`）：**已随 0.19.x 边界1 删除**。
     *
     * 它曾是「尚无任何站点连接时」的首屏站点网格，唯一入口是右栏网页区顶上的
     * 「尚未初始化 → 请先登录」引导页。边界1 取消那道登录闸（未登录也直接挂 iframe
     * 打开对应网址，登录在站点网页内完成）后，引导页删除，这两个组件失去全部调用方。
     * 站点选择由 `SiteCatalogBody`（Web Bridge 标签页，从上往下、不显示登录态）与
     * 网页区顶部横向站点胶囊承担，能力没丢。
     */
    // ---- 一级站点选择器：0.16.33 建立 → 0.19.x 删除（不复活）--------------------
    //
    // `SitePicker`（含其面板 `SitePickerSurface`）是「尚无任何站点连接时」的首屏网格，
    // 唯一入口是右栏网页区顶上的「尚未初始化 → 请先登录」引导页。0.19.x 边界1 取消
    // 了那道登录闸（未登录也直接挂 iframe 打开对应网址，登录在站点网页内完成），引导
    // 页随之整体删除，这两个组件失去全部调用方，只能删——留一个没有入口的组件，只会
    // 让下一个人以为还能从某处打开它。
    //
    // 它承担过的能力各有新去处，没丢：
    //   · 「上下排列的站点列表」→ 站点目录 `SiteCatalogBody`（Web Bridge 标签页；
    //     且旧址那块引导里的 `SitePicker` 用到了 `rootRef + useDismissOnOutsidePointer`，
    //     那条路径上的「rootRef 没挂节点 → 列表在 click 前卸载」缺陷已随删除消失）。
    //   · 「网页区顶部横向站点胶囊」仍在 Conversation 里（0.16.35 恢复）。
    //
    // 历史（只删代码，逻辑记忆留档）：0.16.35 曾删掉工具条站点下拉按钮，本组件在那时
    // 起只剩引导态一种形态；0.16.33–0.16.34 的「切换不了了」正是 `useDismissOnOutsidePointer`
    // 被无条件调用而 rootRef 悬空所致——pointerdown 先于 click 卸载列表。

    // ---- **二级站点菜单**：0.16.33 建立 → 0.16.35 **删除**（不复活）------------
    //
    // 它曾用官方 `Menu` 原语画「站点 → 同站点多账户向右展开」，作为工具条站点按钮的
    // 下拉。0.16.35 用户明确否掉了那颗按钮（「你现在的 deepseek 上面那点击排列多个
    // 网点就不要了」），于是这个组件失去**全部**调用方，只能删——留一个没有任何入口
    // 的组件，只会让下一个人以为还能从某处打开它。
    //
    // 它承担过的两件事各有新去处，能力没丢：
    //   · 「上下排列的站点列表」→ 站点目录 `SiteCatalogBody`（Web Bridge 标签页，
    //     从上往下、不显示登录态）；
    //   · 「同站点多账户可选」→ 目录里多账户站点缩进列出的子行，`{siteId, slot}` 一并
    //     交给 `openTab`，账号底层一行未改。
    //
    // 顺带记下它最后一个真缺陷（0.16.35 前用户报的「切换不了了」）：当时
    // `useDismissOnOutsidePointer(rootRef, open, setOpen)` 被无条件调用（hooks 顺序
    // 纪律），但那个分支**没把 rootRef 挂到任何节点**，于是 `root.current` 恒为 null、
    // 官方判据在每次 pointerdown 上都成立（含点在菜单行上），列表在 click 之前就卸载，
    // `onSelect` 永不触发。以后再写「自绘下拉 + 官方 dismiss 钩子」，rootRef 必须挂在
    // **同时包住触发按钮与列表**的那一层元素上。

    /** 选择框的面板体 `SitePickerSurface` 随 `SitePicker` 一并删除（见上方注释），
     * 无独立调用方，不再复活。 */
    /**
     * **站点目录**（0.16.35）——右侧栏「Web Bridge」标签页里的一级页面。
     *
     * ## 用户要的形状
     *
     * 2026-09-20 原话：「文件夹，新建终端，浏览器，这几个是怎么排列？从上往下！我希望
     * 是点击 web bridg 后能够实现，一样的 deepseek，智谱，等这样排列」「新开 web 再次
     * 选择不一样的能够像现在一级跳转回去一样，跳回 webbridge 一级」
     *
     * 因此：从上往下的站点行，**不显示登录态**（「登录态不要看」）。点一行 = 为该站点
     * **新开一个标签**（`openTab(kind, { params: { siteId, slot } })`），不是在本页里切换
     * iframe。于是「一行并列显示不同网址栏目」由官方标签条自然给出：每个站点一个标签，
     * 点回「Web Bridge」标签就是回到这份目录。
     *
     * ## 0.16.37：从「抄 panelRow 的数值」改成「抄官方的**胶囊**」
     *
     * 用户原话：「让你完全参考『新建终端』做，你现在只是在半路」「将 deepseek 等网站做出
     * 和他一样的胶囊和排版」「每行右边能够选择登录账号（有多个账号的）做的类似『新建终端』
     * 右边点击拉取时候的展开」。
     *
     * 「新建终端」在官方右栏就是 `@deepseek-ai/dsh-client-ui-sidebar-terminal` 的
     * `TerminalGuide`：**一张胶囊卡片**，左端主区（图标 + 标题 + 说明）是一颗
     * `Button variant:'ghost'`，右端一颗 44px 宽的 chevron `Button` 作为 `Menu` 的
     * `anchor`，点开是官方 `Menu`（自带键盘走行、边界翻转、portal 与外侧关闭）。
     * 本组件按同一结构写，尺寸逐项取自它的 `TerminalGuide.module.css`（见样式表注释）。
     *
     * **上一轮错在哪**：只把 `panelRow` 的行高与圆角抄了一半——行内是裸 `<button>`、
     * 右侧展开是自绘箭头 + 自管展开态。看着像，但壳子、触发器、键盘行为都不是官方的。
     * 用户说「只是在半路」指的就是这个。
     *
     * ## 数据面
     *
     * 只用 `/status` 的 `driver.sites`（**按槽**一行），与右栏面板同源。因此
     * 「同站点多账户」不需要另写一套账号逻辑：槽数 > 1 的站点右端才出现触发器，菜单条目
     * 就是该站点的各个槽，选中即把 slot 一并交给 `openTab`。**单账户站点不给触发器**——
     * 给一个点了没东西的箭头是骗人的。
     *
     * 加载中/读不到都**如实说**（「读不到」与「确实没有」在界面上必须可区分）。
     */
    function SiteCatalogBody({ onOpenSite }) {
      const [rows, setRows] = React.useState(null); // null = 尚未读到
      const [error, setError] = React.useState('');
      // 当前展开了账户菜单的站点。`''` = 全部关着。
      // 为什么由本组件持有而不是交给 `Menu` 自己：官方 `Menu` 是**受控**的
      //（`open` / `onClose` 都从 props 进，见 Menu.d.ts），开合状态必须由调用方管——
      // 这与「新建终端」的 `TerminalGuide` 里那句 `const [open, setOpen] = useState(false)`
      // 是同一种写法。
      const [openId, setOpenId] = React.useState('');
      React.useEffect(() => {
        let alive = true;
        const load = () => api('status').then(s => {
          if (!alive) return;
          setRows(Array.isArray(s?.driver?.sites) ? s.driver.sites : []);
          setError('');
        }).catch(e => { if (alive) setError(e.message); });
        load();
        const timer = setInterval(load, 8000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      const ids = Object.keys(SITE_NAMES);
      const accountsOf = sid => (rows || []).filter(r => r && r.siteId === sid);
      const open = (sid, slot) => { if (typeof onOpenSite === 'function') onOpenSite(sid, slot || ''); };

      /**
       * 把 `glm#2` 拆成 `{ siteId:'glm', slot:'2' }`（服务端 `accountKeyOf` 的入口形状）。
       *
       * **为什么在这里重写一份**：`SiteAccounts` 里那份 `siteSlot` 是**该组件的局部
       * 函数**（定义在它的函数体内），本组件取不到——直接调用会在点击时抛
       * `ReferenceError`（这正是本轮自查抓到的一处真缺陷：静态看没问题，一按就炸）。
       * 抽到模块作用域当然更干净，但那会动到 `SiteAccounts` 的既有代码；这里按
       * 「两处各一小段纯函数」处理，并在两侧都注明对偶关系，避免将来只改一处。
       * 语义必须与 `SiteAccounts` 的 `siteSlot` **逐字一致**（都按 `#` 切）。
       */
      const slotOf = (key) => {
        const i = String(key).indexOf('#');
        return i === -1
          ? { siteId: String(key), slot: '' }
          : { siteId: String(key).slice(0, i), slot: String(key).slice(i + 1) };
      };

      // 正在开窗的**账号集合**（0.19.4 起按 accountKey，不再是站点）。
      //
      // 为什么粒度必须是账号：用户指令「能够同时开多个账号的窗口/标签」。按站点判的话，
      // 「给 GLM 再加一个账号」会被判成「GLM 正在开窗」而静默丢弃——用户点「新账号」
      // 没有任何反应。粒度改成 accountKey 之后，同站不同账号可以各开各的窗口，
      // 而同**一个**账号的重复点击仍被拦下（那才是会覆盖同一份 profile 的操作）。
      //
      // 集合而不是单值：这条请求要等浏览器真的起来（最长 120s）。用单值 `busyKey` 时，
      // 「点 A → 点 B → B 先返回」会把忙碌态**清空**，而 A 其实还在开 —— A 随即重新可点，
      // 再点一次就拉起了**第二个窗口**覆盖同一个 profile。这正是忙碌态本来要防的那件事。
      const [busyAccounts, setBusyAccounts] = React.useState([]);
      const [notice, setNotice] = React.useState(null);
      const isBusy = (key) => busyAccounts.includes(key);

      /**
       * 打开**桥自己的**浏览器窗口去登录某个站点（0.19.0）。
       *
       * ## 为什么必须是这一个落点
       *
       * 本轮修掉的缺陷是：目录里的账户菜单项写着「登录」，实际调
       * `openTab('browser')`（回落 `window.open`）。那两处**都不是桥的浏览器**——
       * 前者是官方 `ui-sidebar-browser` 的 iframe（另一个进程、另一份 cookie 罐），
       * 后者是用户的日常浏览器。**在那里登录，桥永远不知道**，而界面承诺了「可登录」。
       * 这正是用户报的「设置界面和右侧的登录必须落实一处」。
       *
       * 落点因此统一为 `POST window {action:'open'}`——与站点工具条 🌐、账户卡片
       * 「登录窗口」**同一个控制面动作**，因而共享同一条 profile。入口可以有多个，
       * **落点只有一个**（0.18.0 已真机验证：关掉驱动再重开，`loggedIn` 仍为 true）。
       *
       * ## 防连点按**站点**而非全局（0.19.0 独立审查抓到后修正）
       *
       * 初版用 `if (busySid) return;` 做全局锁。窗口要等最长 120s 才起来，于是
       * 在这段时间里点**其它站点**会被**静默丢弃**——用户只看到上一个站点的成功
       * 回执，自己这次点击毫无反馈。那正是本项目反复记过的「说做了、其实没做」：
       * 点击被吞掉，界面上却一切正常。
       *
       * 现在按站点判：正在开的那个站点再点才是重复（忽略），**其它站点照常受理**
       * （同时开两个窗口是合法需求）。
       *
       * @param {string} sid 站点 id（用于文案与回退）
       * @param {string} accountKey `glm` 或 `glm#2`
       */
      async function openLoginWindow(sid, accountKey) {
        // 只拦**同一个账号**的重复点击；同站其它账号、其它站点都不受影响
        //（同时开两个窗口是合法需求，用户 0.19.4 明确要求「能够同时开多个账号的窗口」）。
        const acctKey = accountKey || sid;
        if (isBusy(acctKey)) return;
        setBusyAccounts((prev) => (prev.includes(acctKey) ? prev : [...prev, acctKey]));
        setNotice(null);
        // `slotOf` 把 `glm#2` 拆成 `{siteId, slot}`——服务端 `accountKeyOf` 要的就是
        // 这个形状。不能自己拼 `{siteId: 'glm#2'}`：那样会绕过拆分而找不到站点。
        const r = await apiSoft('window', { ...slotOf(acctKey), action: 'open' }, 120000);
        if (!r.ok) setNotice({ kind: 'bad', text: '打开登录窗口失败：' + r.error });
        else if (r.data?.alreadyOpen) setNotice({ kind: 'ok', text: '窗口已在，已置前' });
        else setNotice({ kind: 'ok', text: '已打开 ' + siteName(sid) + ' 登录窗口' });
        // 只摘掉**自己**这一个账号：其它在途的必须保持忙碌（见上面那段理由）。
        setBusyAccounts((prev) => prev.filter((x) => x !== acctKey));
      }

      /**
       * 下拉底部那一行「新账号」：先为该站点**新增一个槽**，再打开它的登录窗口。
       *
       * 两步必须都在服务端落定：槽位合法性只有 `accounts.js` 说了算（`default` 的规范名、
       * `#1` 是别名、槽名字符集），面板自己算「下一个空槽」就会长出第二套规则。
       * 新增成功后面板靠既有的 8s 轮询把新账号行读回来，不需要额外的本地状态。
       */
      async function addAccountAndLogin(sid) {
        // 「新增」这一步本身也要防连点：它会写设置，连点会一次加出两个空槽。
        // 用一个**合成键**（不是任何真实 accountKey）占住这个站点的「正在新增」位。
        const guard = '__new__' + sid;
        if (isBusy(guard)) return;
        setBusyAccounts((prev) => [...prev, guard]);
        try {
          const r = await apiSoft('account-add', { siteId: sid }, 30000);
          if (!r.ok || !r.data?.accountKey) {
            setNotice({ kind: 'bad', text: '新增账号失败：' + (r.error || '未知原因') });
            return;
          }
          setNotice({ kind: 'ok', text: '已新增 ' + siteName(sid) + ' 账号 ' + r.data.slot });
          await openLoginWindow(sid, r.data.accountKey);
        } finally {
          setBusyAccounts((prev) => prev.filter((x) => x !== guard));
        }
      }

      /**
       * 打开下拉时顺手刷一次「真实昵称/头像」。
       *
       * 为什么要刷新而不是只靠 8s 轮询：轮询读的是驱动**缓存**里的身份，而缓存只在
       * 登录/检测那两刻写过。用户在站点网页里**手动登录**之后，缓存仍是空的——
       * 点开下拉就是他能主动触发的一次刷新，刷不到就照旧回落槽名。
       */
      function refreshIdentities(accounts) {
        for (const a of accounts) {
          const acctKey = a.accountKey || a.siteId;
          apiSoft('account-identity', { ...slotOf(acctKey) }, 20000).catch(() => {});
        }
      }
      return h('div', { className: 'hwb-catalog' },
        error && h('p', { className: 'hwb-hint bad' }, '站点状态读不到：' + error + '（这行不代表「没有站点」，只是读不到）'),
        notice && h('div', { className: 'hwb-notice ' + (notice.kind === 'bad' ? 'bad' : 'ok') },
          h('span', { className: 'hwb-notice-text' }, notice.text)),
        h('div', { className: 'hwb-catalog-list' },
          ids.map(sid => {
            const accounts = accountsOf(sid);
            // 槽数 > 1 才有「同站点多账户」可选。`rows` 还没到时一律按单账户处理
            // （宁可不显示触发器，也不显示一个内容未知的箭头）。
            const multi = accounts.length > 1;
            const expanded = openId === sid;
            // 主区：官方 `Button variant:'ghost'`——与「新建终端」同一个原语。
            // 自己写 <button> 会丢掉 ghost 的配色、按下态与焦点环，而「排版一样」
            // 最容易露馅的正是这些细节。
            const main = h(Button, {
              variant: 'ghost', className: 'hwb-site-main',
              title: siteName(sid) + ' · ' + siteIconWhy(sid),
              onClick: () => open(sid, ''),
            },
              h('span', { className: 'hwb-catalog-ico' + (hasBrandVector(sid) ? ' official' : '') },
                h(SiteGlyph, { sid, size: 26 })),
              h('span', { className: 'hwb-site-text' },
                h('span', { className: 'hwb-site-title' }, siteName(sid)),
                // 说明行**只在多账号时出现**：官方 `TerminalGuide` 也是
                // `description !== undefined && …` 才画第二行。单账号站点给一句
                // 「1 个账号」是噪音，不如让它长得像左栏那些朴素行。
                multi && h('span', { className: 'hwb-site-desc' }, accounts.length + ' 个账号')));
            // 每一行都给**同一种右侧下拉**（用户指令：「改为类似新建终端框右侧选择」）。
            //
            // 为什么单账号站点也要给：没有它，「给这个站点加第二个账号」就没有入口——
            // 而用户明确要求「一个网址可以多个账号」。下拉底部固定一行「新账号」承担
            // 这件事，顺带把 0.19.0 那颗孤立的「登录」按钮统一掉了（同一个落点、
            // 少一种控件形状）。
            const acctIcon = (a) => {
              const url = a.avatarUrl || null;
              if (!url) return h('span', { className: 'hwb-acct-glyph' }, h(SiteGlyph, { sid, size: 16 }));
              // 真实头像（0.19.4）。跨域 CDN 可能拒热链 → onError 时把 img 藏掉，
              // 露出后面的站点标记；**不造假**：读不到就不用槽名冒充头像。
              return h('img', {
                className: 'hwb-acct-img', src: url, alt: '', loading: 'lazy',
                onError: (e) => { try { e.currentTarget.style.display = 'none'; } catch { /* 忽略 */ } },
              });
            };
            // 昵称优先级：**抓到的真实昵称** → 桥生成的槽名。这一行是本轮要求的
            // 「抓真实值 + 抓不到回落槽名」在界面上的唯一落点。
            const acctName = (a) => a.accountName || a.displayName || siteName(sid);
            return h('div', { className: 'hwb-site-card', key: sid },
              main,
              // 右端触发器 + 官方 `Menu`：与 `TerminalGuide` 逐字同构。
              // `portal: true` 是因为本面板在窄栏里、祖先有 overflow 裁剪（官方
              // TerminalGuide 同样开了 portal）；`align: 'end'` 让列表与触发器右对齐。
              h(Menu, {
                open: expanded, portal: true, autoFocus: true, align: 'end',
                className: 'hwb-site-menu',
                items: [
                  ...accounts.map(a => ({
                    id: a.accountKey || a.siteId,
                    label: acctName(a),
                    icon: acctIcon(a),
                  })),
                  { type: 'separator', id: '__sep__' + sid },
                  // 文案按用户要求压到三个字（「新账号」），括号补充一律去掉。
                  // `disabled` 是**必须的**：只改文案会让这一项看起来仍可点，
                  // 连点会为同一个槽拉起多个窗口（官方 Menu 的 item 支持 disabled）。
                  { id: '__new__' + sid, label: '新账号', disabled: isBusy('__new__' + sid) },
                ],
                onClose: () => setOpenId(''),
                onSelect: (key) => {
                  setOpenId('');
                  if (key === '__new__' + sid) { addAccountAndLogin(sid); return; }
                  const hit = accounts.find(a => (a.accountKey || a.siteId) === key);
                  if (hit) open(sid, hit.slot || '');
                },
                anchor: h(Button, {
                  variant: 'ghost', className: 'hwb-site-trigger',
                  'aria-label': siteName(sid) + ' 账号',
                  'aria-haspopup': 'menu', 'aria-expanded': expanded,
                  onClick: () => {
                    const next = expanded ? '' : sid;
                    setOpenId(next);
                    // 打开时顺手刷一次真实昵称/头像（读不到就保持槽名）。
                    if (next) refreshIdentities(accounts);
                  },
                }, h(IconChevronDown, { size: 14 })),
              }));
          })));
    }

    /**
     * 「下一个新开的分屏应该落在哪个站点」（0.16.22）。
     *
     * 旧实现里 Ctrl/⌘+点击站点只是 `setSiteId(sid)` 之后再 `onSplit()`——而分屏出来的
     * 新 pane 是**另一个 Conversation 实例**，它的 `useState('deepseek')` 恒等于默认站点。
     * 于是「Ctrl+点击 Kimi 想在旁边再开一个 Kimi」得到的是一左一右两个 DeepSeek，
     * 用户看到的是一句「多开不同网址」的承诺没有兑现。
     *
     * 这里用一个模块级的一次性交接：请求方把目标站点放进来，新实例初始化时取走并清空。
     * 之所以不做成 Context/服务，是因为它只跨一次**新实例初始化**，而且必须在新实例
     * 挂载前就已确定（挂载后再 setState 会让新 pane 先闪一下 DeepSeek）。
     */
    let pendingPaneSite = null;

    // ---- 0.20.0 工作区画面流（路线 B）--------------------------------------
    //
    // LivePane：把**自带 Chromium 的真实页面**投到右栏（CDP 损伤帧 + 输入回传）。
    // 登录只有自带内核 profile 一份（右栏画面 = 驱动 = 同一个浏览器），图片查看/
    // 文件预览/下载/弹窗回归真实浏览器行为——镜像 iframe 的运行时覆盖边界
    // （动态查看器打不开）就此绕开。协议与安全面见 lib/live.js，方案见
    // doc/plans/PLAN-2026-09-25-live-workspace.md。
    //
    // P1 范围：只有 LIVE_SITES 里的站点走画面流（先 DeepSeek 跑通再铺开）；面板
    // 上保留「改用镜像页」按钮，链路异常时一键回落到旧 iframe 路线（不删旧路）。
    const LIVE_SITES = new Set(['deepseek']);
    /**
     * 本面板的有效 dpr（0.21.2）。
     *
     * ⚠️ **必须与 `lib/live.js` 的 `VP_MAX_DPR` 逐字一致**。服务端用它把页面渲染成
     * 「面板 CSS × dpr」，客户端用它把画布 backing 设成同一个值——两端算出同一个数
     * 才是 1:1（源图 = 画布，drawImage 不做任何重采样）；任一端改口径就会重新引入
     * 上采样模糊，这是本次修复最容易回归的一点。
     * 上限 2 是因为更高 dpr 的画面面积增长快于观感收益，且编码耗时随面积线性涨。
     */
    const panelDpr = () => Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    function LivePane({ sid, slot, siteName, style, onUseMirror }) {
      const [pages, setPages] = React.useState([]);
      const [current, setCurrent] = React.useState(null);
      const [status, setStatus] = React.useState('connecting');
      const [reloadTick, setReloadTick] = React.useState(0);
      const canvasRef = React.useRef(null);
      const frameRef = React.useRef(null);   // { img, meta, dx, dy, dw, dh } 坐标换算依据
      const wsRef = React.useRef(null);
      const account = slot ? sid + '#' + slot : sid;

      React.useEffect(() => {
        let alive = true;
        const ws = new WebSocket('ws://127.0.0.1:' + RELAY_PORT + '/webcode/live?account=' + encodeURIComponent(account));
        wsRef.current = ws;
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          setStatus('live');
          // 建连即报一次面板尺寸（hub 建连默认视口在 resize 到达前可能比例不合）。
          const box = canvasRef.current?.parentElement;
          if (box && box.clientWidth > 40 && box.clientHeight > 40) {
            send({ t: 'resize', w: Math.round(box.clientWidth), h: Math.round(box.clientHeight), dpr: panelDpr() });
          }
        };
        ws.onmessage = async (ev) => {
          // 0.20.4：帧走二进制包（[metaLen u16be][metaJSON][jpeg]），控制消息仍是
          // 文本 JSON——按 typeof ev.data 区分。
          if (typeof ev.data === 'string') {
            let msg = null;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (!msg || typeof msg !== 'object') return;
            if (msg.t === 'pages') {
              setPages(Array.isArray(msg.pages) ? msg.pages : []);
              setCurrent(msg.current ?? null);
              setStatus('live');
            } else if (msg.t === 'rtc-answer') {
              // WebRTC 建联成功：视频接管画面（投屏已由服务端停掉）
              try {
                const pc = rtcRef.current;
                if (pc) {
                  awaitingAnswer.current = false;
                  await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
                  for (const c of (msg.candidates || [])) { try { await pc.addIceCandidate(c); } catch {} }
                  setStatus('rtc');
                }
              } catch { setStatus('rtc-failed'); send({ t: 'rtc-failed' }); }
            } else if (msg.t === 'rtc-failed') {
              // 降级：hub 已重启自适应投屏，回画布路线
              try { rtcRef.current?.close(); } catch {}
              rtcRef.current = null;
              offerSent.current = false;
              setStatus('live');
            } else if (msg.t === 'bye' || msg.t === 'error') {
              setStatus(String(msg.reason || msg.message || 'error').slice(0, 140));
            }
            return;
          }
          try {
            const view = new DataView(ev.data);
            const metaLen = view.getUint16(0);
            const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(ev.data, 2, metaLen)));
            onFramePacket(meta, new Uint8Array(ev.data, 2 + metaLen));
          } catch { /* 坏帧丢弃 */ }
        };
        ws.onclose = () => { if (alive) setStatus('closed'); };
        ws.onerror = () => { if (alive) setStatus('closed'); };
        return () => {
          alive = false;
          try { ws.close(); } catch { /* 已断 */ }
        };
      }, [account, reloadTick]);

      // ---- 0.20.4 帧管线：最新帧制胜 + Blob 原生解码 -------------------------
      //
      // 学习远程浏览器产品（browserless / steel live view）的标准做法：
      //   · 二进制 + Blob URL：省掉 base64 双重编解码，JPEG 解码走浏览器原生路径；
      //   · 最新帧制胜：滚动时帧到达快于绘制，旧实现逐帧排队 → 越拖越 lag；
      //     现在绘制中的帧完成时只补画「最新的一帧」，中间帧直接丢弃——
      //     端到端延迟不再随拖动时长累积。
      let decoding = false;
      let pendingFrame = null;
      let lastBlobUrl = null;
      function onFramePacket(meta, jpeg) {
        if (decoding) { pendingFrame = { meta, jpeg }; return; }
        decoding = true;
        const blobUrl = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
        const img = new Image();
        img.onload = () => { drawImage(img, meta); cleanup(blobUrl); };
        img.onerror = () => cleanup(blobUrl);
        function cleanup(url) {
          if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
          lastBlobUrl = url;
          decoding = false;
          const p = pendingFrame;
          pendingFrame = null;
          if (p) onFramePacket(p.meta, p.jpeg);
        }
        img.src = blobUrl;
      }

      const send = (obj) => {
        const ws = wsRef.current;
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch { /* 已断 */ }
      };

      // 0.21.0 WebRTC：面板为接收端（recvonly），offer/answer 各带完整候选
      //（非 trickle，免第二条信令通道）；失败自动回落自适应投屏画布。
      const videoRef = React.useRef(null);
      const rtcRef = React.useRef(null);
      const offerSent = React.useRef(false);
      const awaitingAnswer = React.useRef(false);
      const statusRef = React.useRef('connecting');
      React.useEffect(() => { statusRef.current = status; }, [status]);

      function toPagePointLive(e) {
        // RTC 路径：video 内在尺寸即页面视口，object-fit contain 换算与画布同型
        const v = videoRef.current;
        if (!v || !v.videoWidth) return null;
        const r = v.getBoundingClientRect();
        const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        const dw = v.videoWidth * s, dh = v.videoHeight * s;
        const dx = (r.width - dw) / 2, dy = (r.height - dh) / 2;
        return {
          x: (e.clientX - r.left - dx) * v.videoWidth / dw,
          y: (e.clientY - r.top - dy) * v.videoHeight / dh,
        };
      }

      function startRTC() {
        if (rtcRef.current || typeof RTCPeerConnection === 'undefined') return;
        try {
          const pc = new RTCPeerConnection();
          rtcRef.current = pc;
          offerSent.current = false;
          awaitingAnswer.current = true;
          pc.addTransceiver('video', { direction: 'recvonly' });
          pc.ontrack = (e) => {
            const v = videoRef.current;
            if (v) { v.srcObject = e.streams[0]; v.play?.().catch(() => {}); }
          };
          pc.addEventListener('icegatheringstatechange', () => {
            if (pc.iceGatheringState === 'complete' && !offerSent.current) {
              offerSent.current = true;
              send({ t: 'rtc-offer', sdp: pc.localDescription.sdp, candidates: [] });
            }
          });
          pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => { send({ t: 'rtc-failed' }); });
          // 无候选超时兜底（loopback host 候选通常立刻齐）
          setTimeout(() => { if (!offerSent.current && pc.iceGatheringState === 'complete') { offerSent.current = true; send({ t: 'rtc-offer', sdp: pc.localDescription.sdp, candidates: [] }); } }, 1500);
        } catch { /* 无 WebRTC：留在投屏路线 */ }
      }

      // 状态到 live 且视频空 → 起一次 WebRTC（失败自动回落，不重试轰炸）
      React.useEffect(() => {
        if (status === 'live' && !rtcRef.current) startRTC();
        if (status !== 'rtc' && status !== 'live' && rtcRef.current) {
          try { rtcRef.current.close(); } catch {}
          rtcRef.current = null;
          offerSent.current = false;
        }
      }, [status]);
      React.useEffect(() => {
        const box = canvasRef.current?.parentElement;
        if (!box || typeof ResizeObserver === 'undefined') return;
        // 0.20.2 视口自适应注释：面板尺寸变化（拖分栏/开合侧栏）上报 hub，
        // 120ms 防抖，服务端按「同尺寸跳过」兜底。
        let timer = null;
        const report = () => {
          const w = Math.round(box.clientWidth), h = Math.round(box.clientHeight);
          // dpr 一并上报（0.21.2）：服务端据此把页面渲染成「面板 CSS × dpr」，
          // 与下面 drawImage 的 backing 尺寸（box.clientWidth × dpr）相等 ⇒ 1:1 落笔。
          // 拖到不同缩放比的显示器上时 dpr 会变，所以每次 resize 都重报，不能只报一次。
          if (w > 40 && h > 40) send({ t: 'resize', w, h, dpr: panelDpr() });
        };
        const ro = new ResizeObserver(() => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(report, 120);
        });
        ro.observe(box);
        return () => { if (timer) clearTimeout(timer); ro.disconnect(); };
      }, []);

      // 0.21.2 主题同步：把宿主的昼夜状态报给 hub，hub 用 prefers-color-scheme 仿真
      // 推给页面——站点自己的深浅色逻辑（CSS 媒体查询、JS matchMedia）因此跟着 DSH 走，
      // 不用注入任何 CSS，也不用猜站点的主题实现方式。
      //
      // 判据取自 DSH 自己的主题引导脚本：它把深色标记在 document.body 的
      // `data-ds-dark-theme` 属性上（见 @deepseek-ai/dsh-client-ui-theme 的
      // bootThemeBodyScript）。因此观察 body 属性即可，不依赖任何内部 API；
      // 宿主若改换实现，只需跟着改这一条判据。
      React.useEffect(() => {
        const readDark = () => document.body.hasAttribute('data-ds-dark-theme');
        const push = () => send({ t: 'theme', dark: readDark() });
        push();   // 建连即报一次，页面不用等下一次切换
        if (typeof MutationObserver === 'undefined') return;
        const mo = new MutationObserver(push);
        mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
        return () => mo.disconnect();
      }, []);

      // 绘制：canvas 按 devicePixelRatio 放大（超采样 1:1 落笔），高质量重采样
      //（imageSmoothingQuality='high' 是缩小的多步滤波，默认档会把 ×2 超采样
      // 的锐度在最后一步丢掉）。
      function drawImage(img, meta) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const box = canvas.parentElement;
        if (!box) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const bw = Math.max(1, Math.round(box.clientWidth * dpr));
        const bh = Math.max(1, Math.round(box.clientHeight * dpr));
        if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
        const ctx2d = canvas.getContext('2d');
        ctx2d.imageSmoothingEnabled = true;
        ctx2d.imageSmoothingQuality = 'high';
        ctx2d.fillStyle = '#111';
        ctx2d.fillRect(0, 0, canvas.width, canvas.height);
        const s = Math.min(bw / img.width, bh / img.height);
        const dw = img.width * s, dh = img.height * s;
        const dx = (bw - dw) / 2, dy = (bh - dh) / 2;
        ctx2d.drawImage(img, dx, dy, dw, dh);
        frameRef.current = { img, meta, dx, dy, dw, dh, dpr };
      }

      function toPagePoint(e) {
        if (statusRef.current === 'rtc') return toPagePointLive(e);
        const f = frameRef.current;
        const canvas = canvasRef.current;
        if (!f || !canvas) return null;
        const r = canvas.getBoundingClientRect();
        // 0.20.3 真机事故修复：dx/dy/dw/dh 是**画布 backing-store 像素**（0.20.2
        // 起按 dpr 放大），而 clientX 是 CSS 像素——两个坐标空间必须先对齐再换算，
        // 否则屏幕缩放 125%/150% 的机器上所有点击整体偏移（表现即「点了没反应」）。
        const mx = (e.clientX - r.left) * f.dpr, my = (e.clientY - r.top) * f.dpr;
        const meta = f.meta || {};
        const vw = Number(meta.deviceWidth) || f.img.width;
        const vh = Number(meta.deviceHeight) || f.img.height;
        return {
          x: (mx - f.dx) * vw / f.dw,
          y: (my - f.dy) * vh / f.dh,
        };
      }

      function onMouse(e, action) {
        const pt = toPagePoint(e);
        if (!pt) return;
        if (action === 'down') e.currentTarget.focus();
        // 0.20.4：mousemove 按 rAF 合并（拖动时每条都发 = WS 洪泛 + 乱序排队）；
        // 按下/抬起是状态事件，先冲刷挂起的 move 再即时发送，保住顺序。
        const msg = { t: 'mouse', action, x: pt.x, y: pt.y, button: ['left', 'middle', 'right'][e.button] || 'none', buttons: e.buttons, clickCount: e.detail || 1 };
        if (action === 'moved') queueMove(msg);
        else { flushMove(); send(msg); }
      }
      // rAF 合并：一帧之内多次 mousemove 只发最新位置。
      let pendingMove = null, moveRaf = 0;
      function queueMove(msg) {
        pendingMove = msg;
        if (!moveRaf) moveRaf = requestAnimationFrame(() => { moveRaf = 0; const m = pendingMove; pendingMove = null; if (m) send(m); });
      }
      function flushMove() {
        if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
        const m = pendingMove;
        pendingMove = null;
        if (m) send(m);
      }
      function onWheel(e) {
        const pt = toPagePoint(e);
        if (!pt) return;
        e.preventDefault();
        send({ t: 'mouse', action: 'wheel', x: pt.x, y: pt.y, deltaX: e.deltaX, deltaY: e.deltaY });
      }
      function onKey(e, action) {
        // F12 / 浏览器开发者键不拦；其余按键转发给远端并拦下本地默认行为
        //（否则方向键/空格会滚动 DSH 页面而不是远端页面）。
        if (e.key === 'F12') return;
        if (action === 'key' && e.key.length === 1) {
          send({ t: 'key', action: 'key', key: e.key, code: e.code, keyCode: e.keyCode, text: e.key, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey });
        } else {
          send({ t: 'key', action, key: e.key, code: e.code, keyCode: e.keyCode, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey });
        }
        e.preventDefault();
      }

      // 0.21.2：**删掉面板内那条自建状态行**（原先的 .hwb-live-bar：
      // 「● DeepSeek · 实时画面」+ 页面标签 + 「+」）。
      //
      // 用户原话（2026-09-25）：「1.顶部那个保留，应该是原来 iframe 路线那个是吧
      // 2.多的这一行删除」。判据成立：上面 `.hwb-toolbar`（站点图标 + 站点名 +
      // 状态点 + 状态词）已经把这行的全部信息说了一遍——站点名重复、
      // 「实时画面」是内部状态词（用户不需要知道画面走 RTC 还是投屏）。
      //
      // 用户还指出这一行**在骗人**：「你直接新开了页面干嘛不用」——点「+」开了新页，
      // 行里的标签换成了新页标题，画面却仍停在旧页。两个修法都做了：
      //   · 画面跟随（hub 的 `open` 分支现在会 attach 到新页，见 lib/live.js）；
      //   · 整行删除，不再用「标题已变」暗示一件没发生的事。
      //
      // `pages` / `current` 两个 state 保留：hub 仍按 `pages` 消息推送页面列表，
      // 是「同一账户开了几个页」的唯一读数来源（`/__webcode/status` 之外）；
      // 页面切换/关闭的协议分支也仍在，只是当前没有 UI 触发它们。
      return h('div', { className: 'hwb-live', style },
        h('div', { className: 'hwb-live-view' },
          h('canvas', {
            ref: canvasRef,
            className: 'hwb-live-canvas',
            tabIndex: 0,
            style: status === 'rtc' ? { visibility: 'hidden' } : null,
            onMouseDown: (e) => onMouse(e, 'pressed'),
            onMouseUp: (e) => onMouse(e, 'released'),
            onMouseMove: (e) => onMouse(e, 'moved'),
            onWheel: onWheel,
            onContextMenu: (e) => e.preventDefault(),
            onKeyDown: (e) => onKey(e, 'key'),
            onKeyUp: (e) => onKey(e, 'keyup'),
          }),
          h('video', {
            ref: videoRef,
            className: 'hwb-live-video',
            autoPlay: true, muted: true, playsInline: true,
            style: status === 'rtc' ? null : { display: 'none' },
            onMouseDown: (e) => onMouse(e, 'pressed'),
            onMouseUp: (e) => onMouse(e, 'released'),
            onMouseMove: (e) => onMouse(e, 'moved'),
            onWheel: onWheel,
            onContextMenu: (e) => e.preventDefault(),
            tabIndex: 0,
            onKeyDown: (e) => onKey(e, 'key'),
            onKeyUp: (e) => onKey(e, 'keyup'),
          }),
          status !== 'rtc' && status !== 'live' && h('div', { className: 'hwb-live-mask' },
            h('div', null, '画面流未接通：' + status),
            h('button', { className: 'hwb-retry', onClick: () => setReloadTick(t => t + 1) }, '重试'),
            onUseMirror && h('button', { className: 'hwb-retry', onClick: onUseMirror }, '改用镜像页'))));
    }

    function Conversation({ browserSrc, onSplit, onFloat, siteId: controlledSite, slot: controlledSlot }) {
      const [siteId, setSiteId] = React.useState(() => {
        const handed = pendingPaneSite;
        pendingPaneSite = null;
        return controlledSite || handed || 'deepseek';
      });
      // 受控站点（0.16.35）：站点标签把 `{ siteId }` 放在自己的 navigation.params 里
      // （见 apply 里的 WebcodeBody 与 lib 侧 openTab 调用），于是"这个标签是谁"由标签
      // 自己决定，面板不再需要靠猜。params 变化时跟着走——例如在同一标签里被重新导航到
      // 另一个站点。
      //
      // 为什么用 effect 而不是直接以 controlledSite 为唯一真相：本面板还有两处**不受控**
      // 的用法（分屏 pane 的初始站点、首屏网格选站点），它们靠内部 state 切换。两者共存
      // 的代价就是这一行同步。
      React.useEffect(() => {
        if (controlledSite && SITE_NAMES[controlledSite]) setSiteId(controlledSite);
      }, [controlledSite]);
      const [siteStatuses, setSiteStatuses] = React.useState({});
      // 账户行（0.16.33）：`/status` 的 `driver.sites` 是**按槽**的（`glm` 与 `glm#2`
      // 各一行），而 `siteStatuses` 是按站点索引的（同站点多账户时后一行覆盖前一行）。
      // 二级菜单要展示「同一站点的多个账户」，因此必须再留一份**原样的行数组**。
      // 两份并存而不是把 siteStatuses 改成数组：下面有十几处按 siteId 取状态，
      // 改形状等于把整块面板重写一遍，而多账户只是菜单里多一层展开。
      const [accountRows, setAccountRows] = React.useState([]);
      // 当前选中的账户槽（0.16.33）。默认 `''` = 默认槽，与 0.14.6 行为逐字相同。
      // 二级菜单里选「账户2」时置成 `'2'`，随后 connect 带上它——`{siteId, slot}`
      // 是**后端既有**的入参形状（见 lib/web-control.js 的 login/connect 分支），
      // 本版只是把界面接上去，不新增也不改动账号底层的任何连接逻辑。
      //
      // 0.16.35：初值改为**受控槽**——站点标签把自己的 `{ siteId, slot }` 放在 params 里，
      // 目录里点「某站点的账户2」开出来的标签，一挂载就该带着那个槽（否则「选了账户2
      // 却在动账户1」，正是 0.14.7 修过的那类）。不受控的用法（首屏网格 / 分屏）槽为空。
      const [accountSlot, setAccountSlot] = React.useState(controlledSlot || '');
      React.useEffect(() => {
        if (controlledSlot !== undefined) setAccountSlot(controlledSlot || '');
      }, [controlledSlot]);
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
          if (alive) {
            setSiteStatuses(Object.fromEntries(rows.map(row => [row.siteId, row])));
            setAccountRows(rows);
          }
        }).catch(() => {});
        refreshSites();
        const statusTimer = setInterval(refreshSites, 5000);
        // ── 「有独立窗口就自动切过去」的守卫（0.19.0 修，用户报的 ①）──────────────
        //
        // 用户原话：「质谱清言等网站的登录没问题，但是回点击直接打开 deepseek?」
        //
        // 现场：这条自动采纳**无条件覆盖**当前站点。只要**任何一个别的站点**开着独立
        // 窗口（DeepSeek 的窗口是常驻的，`GET window` 实测 `windows.deepseek.open=true`），
        // 挂载一个「智谱清言」标签就会被 `setSiteId('deepseek')` 顶掉——标签标题写着
        // 智谱清言，正文区却是 DeepSeek 镜像（`siteBase('deepseek')` 就是中继根）。
        // 于是「点开站点 → 直接打开 DeepSeek」，而登录本身一直是好的（登录走的是
        // 另一个控制面动作 `POST window`，与这里无关）——这正是用户观察到的组合。
        //
        // 它为什么能活这么久：这段代码是 0.11.0 单站点时代的遗留（那时面板只显示
        // 「当前那个站点」，跟着窗口走是对的）。0.16.35 起每个站点有**自己的标签**、
        // 站点由标签的 `navigation.params` 决定，这条自动采纳就从「合理」变成了
        // 「**推翻用户明确的选择**」。
        //
        // 修法：只在**没有明确站点**时才采纳窗口站点（`controlledSite` 为空 ⇒ 首屏
        // 网格 / 分屏这类不受控用法）。受控标签（从目录点进来的站点标签）一律
        // **尊重标签自己的 siteId**，绝不被窗口改写。
        const adoptWindowSite = !controlledSite;
        if (adoptWindowSite) {
          winState().then(w => {
            const open = Object.keys(w?.windows || {});
            if (alive && open.length && !open.includes(siteId)) setSiteId(open[0]);
          });
        } else {
          winState();
        }
        const poll = setInterval(() => winState(), 5000);
        return () => { alive = false; clearInterval(poll); clearInterval(statusTimer); };
      }, []);
      // 当前站点状态：**优先取当前槽那一行**（0.16.33）。
      //
      // `siteStatuses` 是按站点索引的，同站点多账户时后一行会覆盖前一行；用户选了
      // 「账户2」却看到默认账户的状态，正是 0.14.7 修过的那类「点账户2 却在动账户1」。
      // 因此这里按 `{siteId, accountSlot}` 精确命中，命中不到才回落到站点级那一行。
      const siteStatus = (accountSlot
        ? accountRows.find(r => r && r.siteId === siteId && (r.slot || '') === accountSlot)
        : null) || siteStatuses[siteId] || null;
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
      // 0.19.x 边界1：登录态**不再**挡网页。右栏一打开就逐站 connect 拉起浏览器、挂
      // iframe，网页自己呈现——未登录就停在站点登录页，用户就地完成登录（满足「未
      // 登录也能直接打开对应网址」）。原来的「请先登录再打开」引导因此取消，只保留
      // 两种真实失败态：站点本机不可达（下方 unreachable）与内嵌被站点拦截
      // （frameBlocked）。返回恒 false 即「不再引导」。
      const shouldGuide = () => false;
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
            // 带上槽（0.16.35）：`{siteId, slot}` 是后端**既有**入参形状（web-control 的
            // connect 分支），默认槽不传 slot，请求体逐字回到 `{siteId}`。
            await api('connect', accountSlot ? { siteId, slot: accountSlot } : { siteId }, 90000);
            if (alive) ensureFrame(siteId);
          } catch (e) { if (alive) setConnectError(e.message); }
        })();
        return () => { alive = false; };
      }, [siteId, accountSlot, frames, ensureFrame, siteStatuses[siteId]?.initialized, siteStatuses[siteId]?.loggedIn, probes[siteId]]);
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
      // ---- 站点标签条的滚轮/键盘漫游：**已删除**（0.16.36）------------------
      //
      // 0.14.4 挂的滚轮横向滚动、以及 tablist 的左右方向键漫游，都只服务于面板内
      // 那条横向站点条。用户 0.16.36 要求去掉那一行后，它们没有宿主元素了。
      // 「一行并列」现在由 DSH 官方右侧栏自己的标签条承担，键盘切换归它管。
      /** 在新分屏里打开某个站点（多开不同网页）。宿主不支持时安静略过。 */
      const openSiteInPane = (sid) => {
        setSiteId(sid);
        if (typeof onSplit !== 'function') return;
        // 交接给即将挂载的新 pane：它自己 useState 的初值恒为默认站点，不交接的话
        // 「分屏看另一个站点」实际得到两个相同的站点（见 pendingPaneSite 注释）。
        pendingPaneSite = sid;
        try { onSplit(sid); } catch { pendingPaneSite = null; }
      };
      // ---- `pickAccount`：**已删除**（0.16.35）--------------------------------
      //
      // 0.16.33–0.16.34 里它承担「在二级菜单里选中某站点的某个账户」：记下槽 → 切站点 →
      // 用 `{siteId, slot}` 连一次。菜单与工具条按钮按用户要求删掉后，它没有调用方了；
      // 而「选账户」这件事现在发生在**目录页**：点目录里的账户行 = `openTab` 带
      // `{siteId, slot}` 开一个新标签，槽由标签自己的 params 带进来（见 Conversation 的
      // `controlledSlot`），连接发生在面板的 effect 里——`api('connect', {siteId, slot})`
      // 仍是 0.14.7 那个后端入参形状，账号底层一行未改。
      //
      // 站点状态的「色点 + tooltip」表达（0.14.5）。
      //
      // 旧实现把「已登录(缓存)」「未登录」「待检查」这些文案直接写进标签条（0.16.34
      // 已删），十个站点各带一段文字 → 标签条被撑爆，用户报「状态有点简略，而且
      // 不统一风格」。正解不是把文案写得更好，而是**换一种表达**：状态用一颗 8px 色点，
      // 完整解释（含判定依据）留在 title/aria-label。这是 AI-IDE 浏览器里
      // 语言服务/连接状态的通行做法。
      const statusDot = (row) => h('span', {
        className: 'hwb-dot ' + statusClass(row),
        title: statusLabel(row) + (statusTitle(row) ? ' · ' + statusTitle(row) : ''),
        'aria-hidden': 'true',
      });
      return h('div', { className: 'hwb-conversation' },
        // ---- 顶层工具条：当前站点身份 + 图标动作（AI-IDE 浏览器常见形态）----
        // 0.16.35：这里的站点下拉按钮**已删**（用户原话「你现在的 deepseek 上面那点击
        // 排列多个网点就不要了」）。工具条现在只回答「我在哪个站点、它什么状态、我能对
        // 它做什么」——站点身份是**只读文字**（可点：切回站点目录），切站点走下面那排
        // 横向站点胶囊或 Web Bridge 标签页里的竖排目录。
        h('div', { className: 'hwb-toolbar' },
          h('div', { className: 'hwb-toolbar-id' },
            // 站点图标 + 名称 + 状态点 + 状态词。图标带档位说明的 title（「官方矢量 /
            // 文字标记」），与站点目录里的同一套 SiteGlyph 口径一致。
            h('span', {
              className: 'hwb-glyph' + (hasBrandVector(siteId) ? ' official' : ''),
              title: siteName(siteId) + ' · ' + siteIconWhy(siteId),
            }, h(SiteGlyph, { sid: siteId, size: 16 })),
            h('span', { className: 'hwb-toolbar-name' }, siteName(siteId)),
            statusDot(siteStatus),
            h('span', { className: 'hwb-toolbar-state' }, winBusy ? '切换中' : statusLabel(siteStatus))),
          // 0.16.39：四颗动作按钮的图标从字符字形（`↻ ▣ ⧉ ◫`）换成**官方 primitives**
          // 的线框图标。字符字形随字体变、光学粗细不一致，与官方那排 15px 线框图标
          // 并排时一眼能看出不是一套（用户：「那些功能的图标有点不符合整体审美」）。
          h('div', { className: 'hwb-toolbar-actions' },
            h('button', {
              className: 'hwb-act-btn', title: '刷新当前站点网页（重新加载镜像页面）',
              'aria-label': '刷新右侧网页', onClick: reloadFrame,
            }, h(IconRefreshOutline14, { size: 15 })),
            h('button', {
              className: 'hwb-act-btn' + (winIsOpen(siteId) ? ' on' : ''), disabled: winBusy,
              title: winIsOpen(siteId) ? '收起独立窗口（回到无头运行）' : '在独立窗口中打开真实网页（已开的窗口会聚焦弹到最前，不会覆盖）',
              'aria-label': winIsOpen(siteId) ? '收起独立窗口' : '打开独立窗口',
              'aria-pressed': winIsOpen(siteId), onClick: toggleWindow,
            }, h(IconRightUpOutline16, { size: 15 })),
            h('button', {
              className: 'hwb-act-btn',
              // 0.18.0：这个按钮原先调 `ctx.sidebarRight.openTab('browser', { url })` ——
              // 打开的是**官方 iframe 浏览器**（ui-sidebar-browser，自述「在 sandbox 中
              // 访问 HTTP(S) 页面」，不注入任何能力）。在那里登录，桥的 Chromium profile
              // **完全不知道**：它是另一个进程、另一份 cookie 罐。
              //
              // 这与用户指出的「登录入口有两套」是同一类问题：界面承诺「可在这里登录」，
              // 实际登了不算数。现在改为打开**桥自己的**登录窗口 —— 那才是登录态真的会被
              // 保存下来的地方（真机实测：关闭驱动再重开，loggedIn 仍为 true）。
              title: '在桥自带的浏览器窗口中打开此站点（这里的登录会被保存并用于自动化；' +
                '官方内置浏览器是独立 iframe，在那里登录桥不会知道）',
              'aria-label': '在桥自带的浏览器窗口打开并登录',
              onClick: toggleWindow,
            }, h(IconGlobe, { size: 15 })),
            h('button', {
              className: 'hwb-act-btn' + (frames[siteId]?.live ? ' on' : ''), title:
                '真实模式：切换到自带内核的画面流（真浏览器行为：图片/文件查看器、下载、弹窗都真实可用；日常浏览用镜像更顺滑）',
              'aria-label': '切换真实模式', 'aria-pressed': Boolean(frames[siteId]?.live),
              onClick: () => setFrames(prev => ({ ...prev, [siteId]: { ...(prev[siteId] || { src: siteBase(siteId) }), live: !prev[siteId]?.live } })),
            }, h(IconBrowse, { size: 15 })),
            onSplit && h('button', {
              className: 'hwb-act-btn', title: '在新面板中打开（可同时看两个不同站点）',
              'aria-label': '在新面板中打开', onClick: onSplit,
            }, h(IconFullscreenOutline16, { size: 15 })),
            onFloat && h('button', {
              className: 'hwb-act-btn', title: '打开为浮动面板（可拖拽、可同时开多个）',
              'aria-label': '打开为浮动面板', onClick: onFloat,
            }, h(IconPanelLeftOutline16, { size: 15 })))),
        // ---- 面板内的横向站点条：0.16.34 删 → 0.16.35 恢复 → 0.16.36 **再删**
        //
        // 用户 0.16.36 原话：「页面内顶部那一行去除，顶部一行那个去除，只留下官方多开一级
        // 和 web bridge 并列那行（独立标签保留就是）」。
        //
        // 意思是：**一行并列**由 DSH 官方右侧栏自己的标签条承担（Web Bridge / DeepSeek /
        // 智谱清言… 那一行），面板里**不要**再有自己的站点导航条。这与 0.16.35 我的理解
        // 不同——当时我把「一行并列显示不同网址栏目」读成了「面板内恢复横向胶囊」。
        // 现在按他说的去掉：网页区因此拿回那一行高度，站点入口只剩两处，且都在更合适的位置：
        //   · Web Bridge 标签页里的站点目录（从上往下，多账户可展开）——新建站点标签的入口；
        //   · 官方标签条本身（每个站点一个标签，点标签切换）。
        //
        // 随之删除的配套代码（同在本文件，别处已无引用）：
        //   · `tabsRef` + 滚轮横向滚动 effect；
        //   · `onTabKey`（tablist 方向键漫游）与 `siteIds`；
        //   · `.hwb-sitebar*` / `.hwb-site-tab*` / `.hwb-tab-glyph` 六条样式。
        //
        // Ctrl/⌘+点击分屏这个手势**随条消失**；分屏本身仍在工具条那颗按钮上（onSplit）。
        // 站点栏之下的「网页区」：iframe 与各种遮罩（加载中 / 拦截 / 不可达 /
        // 未初始化）全部放在这里。遮罩的 position:absolute;inset:0 于是只覆盖
        // 网页区——0.12.9 的遮罩是面板根的兄弟节点，加载时会把整条站点栏也糊掉，
        // 用户连切站点都点不到。
        h('div', { className: 'hwb-frame-host' },
          // 两条错误只显示一条：镜像被站点拦截时，连接类错误没有信息量，不重复刷屏。
          connectError && !frameBlocked && h('div', { className: 'hwb-error', role: 'status' },
            '浏览器视图未能连接：' + connectError + ' ',
            h('button', { className: 'hwb-retry', onClick: reloadFrame }, '重试')),
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
          // 0.21.2 路线还原（用户拍板：日常要 iframe 的原生帧率，镜像做默认）：
          // 画面流 LivePane 只在 f.live 显式置位时进入（工具栏「真实模式」按钮），
          // LivePane 内可一键退回镜像。镜像路线的运行时查看器边界与修复方案见
          // doc/research/2026-09-25-mirror-real-viewer-research.md（SW 拦截层）。
          Object.entries(frames).map(([sid, f]) => f.live
            ? h(LivePane, {
              key: sid,
              sid,
              slot: accountSlot || '',
              siteName: siteName(sid),
              style: sid === siteId ? null : { display: 'none' },
              onUseMirror: () => setFrames(prev => ({ ...prev, [sid]: { ...prev[sid], live: false } })),
            })
            : h('iframe', {
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
          // 「正在加载」遮罩只属于 iframe 路线：ready 由 iframe onLoad 置位。
          // 0.20.0 真机事故（会话 session-fdda64fe，用户原话「为什么右侧一直
          // 『正在加载 DeepSeek 网页..』」）：LivePane 分支没有 iframe，ready
          // 永远不会置位，而这层遮罩是不透光的——把已经连上、正在收帧的画面
          // 整个盖死。画面流分支自带状态遮罩（LivePane 的 mask），这里必须让路。
          active && !active.ready && !connectError && !active.live
            && h('div', { className: 'hwb-frame-status' }, '正在加载 ' + siteName(siteId) + ' 网页…')));
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
        // 标题行：h2 在左、项目链接在右。`margin:0 0 2px` 移到 h2 上（上面那条），
        // 这里只负责两端对齐，避免 h2 的 margin 把这一行撑高。
        ".hwb-settings-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:4px}",
        ".hwb-settings-head h2{margin:0}",
        ".hwb-repo-link{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#6b7280);text-decoration:none;padding:2px 8px;border:.5px solid var(--dsw-alias-border-l3,#8885);border-radius:12px;transition:background .12s ease,color .12s ease}",
        ".hwb-repo-link:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,#8882)}",
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
        // 设置页站点 tab 条（0.16.33）：形态逐项对齐 dsh-market 的
        // Market.module.css（已收录进 reference/dsh-market/src/client/）。
        // 下边框高亮是「这是一排同级 tab」的唯一视觉信号；换填充块会读成按钮。
        // 0.16.38：**横排单行 + 滚轮横向滚动 + 不显示滚动条**（用户原话：「变为横排
        // 而不是两行，然后可以通过鼠标滚轮滚动而不用显示进度条，然后注意和下面隔行
        // 的线的间距」）。三件事各有对应的一条：
        //   · nowrap      —— 不再折成两行；
        //   · overflow-x  —— 装不下时横向滚动（滚轮映射见 Settings 里的非 passive 监听）；
        //   · scrollbar 隐藏 —— 两个属性各管一半浏览器（Firefox 的 scrollbar-width、
        //                      WebKit/Chromium 的 ::-webkit-scrollbar）。
        // 下边距 12px：分隔线由 border-bottom 提供，卡片与它之间必须留一口气，否则
        //「下面隔行的线」会贴着卡片边框，看着像两条重复的线。
        ".hwb-settings-tabs{display:flex;gap:2px;align-items:flex-end;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;border-bottom:.5px solid var(--dsw-alias-border-l2,#e5e7eb);margin:4px 0 12px}",
        ".hwb-settings-tabs::-webkit-scrollbar{display:none;width:0;height:0}",
        ".hwb-settings-tab{flex:none;border:none;background:none;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#6b7280);padding:7px 12px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}",
        ".hwb-settings-tab:hover{color:var(--dsw-alias-label-primary,inherit)}",
        ".hwb-settings-tab.on{color:var(--dsw-alias-brand-primary,#4f6ef7);border-bottom-color:var(--dsw-alias-brand-primary,#4f6ef7);font-weight:600}",
        ".hwb-settings-tab-count{font-size:11px;line-height:16px;padding:0 6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,#8885);color:var(--dsw-alias-label-tertiary,#8a8f98);font-weight:400}",
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
        // 0.19.7：模型下拉与文本框统一成「填满可用宽度、上限 340px」——旧版是
        // `min-width:220px;max-width:340px` 且没有宽度，于是下拉比标签列还窄、
        // 一行里长短不一（用户：「统一UI风格」）。需要更窄的调用点写 inline
        // `maxWidth`（发送间隔的两个数字框就是这么做的）。
        ".hwb-model-select,.hwb-prompt-input{box-sizing:border-box;width:100%;max-width:340px;min-width:0;padding:6px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:.5px solid var(--dsw-alias-border-l3,#8885);border-radius:8px}",
        // `box-sizing:border-box` 是**必须**的，不是保险。缺它时 `width:100%` 是内容盒
        // 宽度，加上左右 padding（20px）与边框（1px）就比容器宽 22px，`max-width:340px`
        // 同理。`.hwb-card` 没有 `overflow:hidden`，用户看到的就是输入框/下拉探出卡片
        // 边框——真机反馈（2026-09-24）「设置界面：输入框超出卡片框！」。
        ".hwb-prompt-input{max-width:100%;min-height:96px;line-height:1.5;font-family:inherit;resize:vertical}",
        // 提示词文件路径（0.16.38）：等宽、单行、超长靠省略号，完整路径在 title 里。
        // 它是**只读读数**，因此不进输入框样式族；点击打开走旁边那颗按钮。
        ".hwb-filepath{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;padding:2px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,#8881);color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
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
        // 头像内层（0.16.33）：现在装的是 SiteGlyph 的 svg（size 12 → 画布 20px），
        // 因此必须是 inline-flex 居中，而不是靠 font-size/line-height 摆一个字符。
        // 两者对文字标记同样成立（SiteGlyph 的文字分支也是 svg），所以这一条
        // 同时覆盖有官方矢量与只有文字标记的站点，不需要第二条规则。
        ".hwb-avatar-glyph{display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary,inherit);pointer-events:none}",
        // 花名册那组 `.hwb-roster*` 类名随设置页「正在运行（子代理 / Team）」卡
        //（0.19.x）一并删除——它们的唯一消费者是 AgentRoster，留着就是没人用的样式。
        ".hwb-site-state{font-size:12px;line-height:18px;padding:1px 8px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3,#8885);color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-site-state.ok{color:var(--dsw-alias-state-success-primary,#2e7d32);border-color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-site-state.bad{color:var(--dsw-alias-state-error-primary,#93443e);border-color:var(--dsw-alias-state-error-primary,#93443e)}",
        ".hwb-metrics{display:flex;flex-direction:column;gap:6px;width:100%}",
        ".hwb-metrics-head{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-bottom:2px}",
        ".hwb-badge{display:inline-block;font-size:11px;line-height:16px;padding:0 8px;margin-right:6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,#8885);color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-badge.measured{color:var(--dsw-alias-state-success-primary,#2e7d32);border-color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        // ---- 等待总时长统计区（0.16.39）----------------------------------------
        //
        // 形态与官方 stat-dialog 的 details 网格同一套写法：minmax(76px,auto) +
        // 数值右对齐 + tabular-nums（扫读时数字宽度不跳）。两栏并排，各有标题文字，
        // 第一栏（本会话）加一层极浅底色区分「活账」——**颜色不是唯一载体**。
        ".hwb-stats{display:flex;flex-direction:column;gap:8px;width:100%}",
        ".hwb-stat-cols{display:flex;gap:12px;flex-wrap:wrap}",
        ".hwb-stat{flex:1 1 200px;min-width:0;box-sizing:border-box;padding:10px 12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l3,#8885);background:var(--dsw-alias-bg-layer-1,transparent)}",
        ".hwb-stat.live{background:var(--dsw-alias-interactive-bg-hover,#8881)}",
        ".hwb-stat-head{font-size:12px;line-height:18px;margin-bottom:6px;color:var(--dsw-alias-label-secondary,inherit);font-weight:500}",
        ".hwb-stat-grid{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0}",
        ".hwb-stat-row{display:contents}",
        ".hwb-stat-grid dt,.hwb-stat-grid dd{min-width:0;margin:0}",
        ".hwb-stat-grid dt{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
        ".hwb-stat-grid dd{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);font-variant-numeric:tabular-nums;text-align:right}",
        ".hwb-stat-empty{font-size:12px;line-height:18px;margin:0;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
        ".hwb-bar-row{display:flex;align-items:center;gap:12px}",
        // 输入框底下的等待药丸（0.15.11）。
        //
        // 取值与尺寸逐项抄自官方 ui-chat 的 StatsPills.module.css：药丸
        // 28px 高、border-radius 24px、padding 1px 8px、gap 6px、14px 线框图标，
        // 悬停/展开用 interactive-bg-hover + label-secondary。
        //
        // 「同栏」由结构决定（0.16.18 简化）：本节点**本来就是**官方 dock 行的直接
        // 子项（ui-conversation 的 InputBar 直接 `renderSlot('conversation.composer.dock')`
        // 再渲染 ContextMeter），因此只需把自己收成 inline-flex 即可与官方药丸同排。
        //
        // 0.15.11 那套「找官方统计行 → portal 进去 → 找不到就自建整行」在
        // DSH 0.1.6-alpha.2 上已经失效：官方标记 `data-composer-stats` 整个包
        // 命中 0 处，于是自建整行**永远**生效，`width:100%` 把官方药丸挤到下一行。
        // 那条自建行规则因此一并删除——留着一个永不生效、但一旦生效就排版崩坏的
        // 规则，比没有更糟。
        // 0.16.38：`flex:none` → `0 1 auto`。用户报的「窗口变窄后这枚药丸长度不变、
        // 不像官方会跟着缩」根因就在这里——`flex:none` 明确禁止收缩，同一行里官方
        // 药丸在缩、这一枚不动。官方 StatsPills 的 root 是
        // `min-width:0;max-width:100%;justify-content:center`，本 wrap 与它同形。
        ".hwb-waitwrap{position:relative;display:inline-flex;align-items:center;min-width:0;max-width:100%;flex:0 1 auto;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}",
        // 尺寸**逐项**取自官方药丸（ui-chat 的 StatsPills 与 TurnUsagePanel 两张
        // module.css），不是照着截图量的近似值。三个值分别是：字号取官方
        // `--dsh-content-font-size-secondary`（缺省 13px）；行高取官方
        // `--dsh-content-font-delta-secondary` 以 24px 为基；高度取官方
        // `--dsh-content-font-delta` 以 28px 为基。
        //
        // 为什么必须写 token 而不是把 13px/24px/28px 抄下来：用户在设置里改
        // 「内容字号」时，官方所有药丸按这两个 delta 一起缩放，而写死的那一枚
        // **不跟着变**——同一行里出现一大一小两枚药丸，正是「没适配」在数值层面
        // 的形态。0.16.21 之前这里正是写死的三个值；本版改为官方 token。图标仍是
        // 官方规定的 14px 线框（`.hwb-waitpill svg` 那条）。
        ".hwb-waitpill{box-sizing:border-box;max-width:100%;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;font:inherit;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a8f98);background:0 0;border:none;border-radius:24px;cursor:pointer;transition:background .12s ease,color .12s ease}",
        ".hwb-waitpill:hover,.hwb-waitpill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-waitpill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px}",
        ".hwb-waitpill svg{flex:none;width:14px;height:14px}",
        ".hwb-waitpill-label{min-width:0;overflow:hidden;text-overflow:ellipsis}",
        // 点击面板：尺寸/圆角/阴影/网格逐项对齐官方 stat-dialog.module.css。
        // 向上展开（bottom:calc(100% + 8px)）而不是向下，因为药丸本身就在输入框
        // 底下，向下会盖住输入框——官方那两枚药丸同样朝上开。
        // 0.16.39：面板改成**官方 stat-dialog 的定位口径**（用户报的「现在是右边缘对齐」）。
        //
        // 逐项对照官方 `@deepseek-ai/dsh-client-ui-chat/stat-dialog.module.css` 的 `.panel`：
        //   position:fixed  ← 旧值 absolute。坐标由官方 useAnchoredPosition 给（左对齐
        //                     药丸左缘 + 视口 12px 夹紧），因此不能再自己写 right/bottom。
        //   z-index:1100 / 圆角 12px / padding 16px / 背景 --dsw-specific-menu /
        //   阴影 --dsw-elevation-prominent / 宽 max-content + 300~440 夹紧 —— 逐字相同。
        //
        // 字号走 token（`--dsh-content-font-size-secondary` / `--dsh-content-font-delta`）：
        // 官方这套弹层在字体缩放时会跟着变，写死 12px 的话放大字体后弹层会比药丸小一圈。
        // 面板在 portal 里（body 下），所以 fixed 不再被右栏面板的 transform 包含块劫持。
        ".hwb-waitpanel{position:fixed;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);padding:16px;border-radius:12px;border:0;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#fff));box-shadow:var(--dsw-elevation-prominent,0 8px 24px #0003);color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,12px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px));cursor:default;text-align:left}",
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
        // 0.16.25 首轮提示词：按网站逐行。每行 = 网站名 + 协议下拉 + 「实际使用」标注，
        // 完整模板折进 details——十个站点各铺一份全文会把设置页淹掉。
        // 0.19.x：站点行由「拥挤的单行」改成与官方设置卡同口径的紧凑块——站点名 +
        // 协议标注一行，路径各占一行（长路径不再把前两者挤到折行），模板仍折叠。
        // 圆角/边框/字号沿用 .hwb-card 的 token 档位，不引第二个视觉体系。
        ".hwb-site-prompt{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l4,#8884);border-radius:12px;padding:8px 10px}",
        ".hwb-site-prompt-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
        ".hwb-site-prompt-name{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit)}",
        ".hwb-site-prompt-variant{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
        ".hwb-site-prompt-path{flex:none;display:block;width:100%}",
        ".hwb-site-prompt details{margin-top:0}",
        ".hwb-site-prompt summary{cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-site-prompt pre{max-height:240px;margin-top:6px}",
        ".hwb-conversation{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0}",
        // 0.16.34：原先这里还有一条注释，解释站点栏为什么 flex:none + z-index
        //（用户报过「有一点遮挡」，根因是旧实现里网页区在层叠上压过了标签条）。
        // 标签条删除后那条约束失去对象；网页区（.hwb-frame-host）的 z-index:1 与
        // 工具条的 z-index:3 仍在，两者之间的层叠关系不变。
        // ---- 顶层工具条（0.14.5 重排）--------------------------------------
        // 尺寸依据来自官方包实测（@deepseek-ai/dsh-client-ui-sidebar-right）：
        //   expand 按钮 width/height:28px + border-radius:28px + padding:6px；
        //   guide 卡片 min-height:56px + border-radius:24px + .5px 边框；
        //   排版 15px（标题）/ 13px（描述，--dsw-alias-label-caption）。
        // 旧实现把标签和动作挤在一行，两者互相抢宽度；现在工具条回答「我在哪个
        // 站点、什么状态、能做什么」，标签条只负责切站点。
        // 0.16.39：工具条尺寸对齐官方 browser 工具条（`.SB_kFW_toolbar`）：
        //   height:38px / padding:5px 6px / gap:4px
        // 旧值 36px + padding 0 8px 与官方差 2px 高、左右各多 2px，与右栏标签条
        // 相邻时能看出不齐。
        ".hwb-toolbar{flex:none;position:relative;z-index:3;display:flex;align-items:center;gap:4px;height:38px;padding:5px 6px;background:var(--dsw-alias-bg-base,transparent)}",
        ".hwb-toolbar-id{display:flex;align-items:center;gap:6px;min-width:0;flex:1}",
        ".hwb-toolbar-name{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".hwb-toolbar-state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap;flex:none}",
        ".hwb-toolbar-actions{flex:none;display:inline-flex;align-items:center;gap:2px}",
        // ---- 站点标签条样式：**0.16.36 再删**（用户要求去掉面板内那行）------
        //
        // 0.16.34 删过 → 0.16.35 恢复 → 0.16.36 按用户「页面内顶部那一行去除，只留下官方
        // 多开一级和 web bridge 并列那行」再删。这一组 `.hwb-sitebar` / `.hwb-sitebar-tabs`
        // / `.hwb-site-tab(.active/-name)` / `.hwb-tab-glyph` 服务于面板内那条横向站点条，
        // 它已不存在；「一行并列」归 DSH 官方右侧栏自己的标签条。
        // ---- 站点图标与选择框（0.16.22）-------------------------------------
        // 尺寸口径：图标框 = 图标尺寸 + 8（内边距），与官方图标按钮的 28px 同族。
        // 颜色一律 currentColor：官方鲸鱼是单条填充路径，随宿主主题变色——
        // 这也是「透明底」的实际含义（没有底色块需要跟着主题反转）。
        ".hwb-glyph-svg{display:block;flex:none}",
        // 挂点共用一条：`.hwb-glyph`（工具条站点图标）、`.hwb-catalog-ico`（站点目录行）。
        // `hwb-picker-ico`（首屏网格）随 SitePicker 在 0.19.x 删除，不再出现在这里。
        ".hwb-glyph,.hwb-catalog-ico{display:inline-flex;align-items:center;justify-content:center;flex:none;color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-glyph.official,.hwb-catalog-ico.official{color:var(--dsw-alias-brand-primary,#3b82f6)}",
        // ---- 站点目录（0.16.35 建立，0.16.37 改为官方的**胶囊**）----------------
        //
        // 尺寸与结构**逐项**取自官方 `@deepseek-ai/dsh-client-ui-sidebar-terminal`
        // 的 `TerminalGuide.module.css`（那就是右栏的「新建终端」）：
        //
        //   .entry    box-sizing:border-box / border:.5px solid border-l4 /
        //             background:bg-layer-1 / border-radius:24px /
        //             align-items:stretch / width:100% / display:flex / overflow:hidden
        //   .main     text-align:left / border-radius:24px 0 0 24px / flex:1 /
        //             justify-content:flex-start / gap:14px / min-width:0 /
        //             height:auto / min-height:56px / padding:14px 20px
        //   .icon     flex:none
        //   .text     flex-direction:column / gap:3px / min-width:0 / display:flex
        //   .title    color:label-primary / nowrap+ellipsis / font-size:15px / line-height:1.4
        //   .description color:label-caption / nowrap+ellipsis / font-size:13px / line-height:1.4
        //   .trigger  border-radius:0 24px 24px 0 / flex:none / align-self:stretch /
        //             width:44px / height:auto / padding:0
        //
        // 为什么不再用 0.16.36 那套 `panelRow` 数值（36px / radius 12px / padding 7px 8px）：
        // 那是**左栏**列表行的口径，用户要的是「新建终端」那张**胶囊**——两者在官方
        // 是两套不同的组件，混着抄正是上一轮「只是在半路」的原因。
        //
        // `.hwb-site-main` / `.hwb-site-trigger` 是**加在官方 `Button` 上的类名**
        //（`className` 透传），因此 ghost 的配色、按下态、焦点环都由官方给，这里只负责
        // 胶囊的几何。
        // 0.16.38：目录与站点胶囊与左右边界留出间距（与首屏网格同一条口径）。
        // 0.17.0：完全参考官方 GuideBody（min-height:100% + justify-content:center + :after 10% 弹性留白），
        // 做到点击进入网站选择界面后垂直水平居中，解决顶部贴着的问题。
        ".hwb-catalog{box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:14px;min-height:100%;padding:0 clamp(8px,3vw,24px);color:inherit}",
        ".hwb-catalog:after{content:\"\";flex:0 10%}",
        // 0.16.39：列表宽度与首屏网格**同一口径**（官方 guide 的 380px + 居中）。
        // 官方的 `.entryCell` 就是 `width:380px;max-width:100%`，所以「目录页」与
        //「首屏选站点」在同一块面板里读起来是同一列宽——这也是用户说的
        //「宽度需要和官方一致」在目录页那一半的对应实现。
        ".hwb-catalog-list{display:flex;flex-direction:column;gap:8px;width:380px;max-width:100%;margin:0 auto}",
        ".hwb-site-card{box-sizing:border-box;min-width:0;border:.5px solid var(--dsw-alias-border-l4,#8884);background:var(--dsw-alias-bg-layer-1,#fff);border-radius:24px;align-items:stretch;width:100%;display:flex;overflow:hidden}",
        ".hwb-site-main{text-align:left;border-radius:24px 0 0 24px;flex:1;justify-content:flex-start;gap:14px;min-width:0;height:auto;min-height:56px;padding:14px 20px}",
        ".hwb-site-text{flex-direction:column;gap:3px;min-width:0;display:flex}",
        ".hwb-site-title{color:var(--dsw-alias-label-primary,inherit);white-space:nowrap;text-overflow:ellipsis;font-size:15px;line-height:1.4;overflow:hidden}",
        ".hwb-site-desc{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary,#8a8f98));white-space:nowrap;text-overflow:ellipsis;font-size:13px;line-height:1.4;overflow:hidden}",
        ".hwb-site-trigger{border-radius:0 24px 24px 0;flex:none;align-self:stretch;width:44px;height:auto;padding:0}",
        // 账号下拉里的头像与回落标记（0.19.4）。尺寸取官方 Menu 的 leading icon 档
        // （figma `.Menu_cell` gap 8、图标 16），圆框是为了让真实头像与站点标记
        // 在**同一列宽**里对齐——两种来源混排时，列宽不齐比图标不精致更显眼。
        ".hwb-acct-img{width:16px;height:16px;border-radius:50%;object-fit:cover;flex:none}",
        ".hwb-acct-glyph{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none}",
        // `.hwb-site-login`（0.19.0 单账号站的「登录」按钮）随本轮统一成下拉而删除：
        // 它的落点已被下拉底部的「新账号」承担，留着就是没有挂点的死规则。
        // ---- 站点下拉菜单样式：**随 SiteMenu 一起删除**（0.16.35）------------
        //
        // 这里曾有一组 `.hwb-menu-row` / `.hwb-menu-name` / `.hwb-menu-state` /
        // `.hwb-menu-glyph(.official)` / `.hwb-site-menu`，服务于工具条那颗站点下拉按钮
        // 弹出的二级菜单。按钮按用户要求删除、`SiteMenu` 随之删掉，这些规则就没有任何
        // 挂点。删而不是留：死规则不会报错，只会让下一个改样式的人把时间花在它上面。
        // 动作组：四颗**同形图标按钮**（官方 expand 按钮的 28px/圆角/透明底）。
        // 旧实现里刷新是裸图标、独立窗口是一颗长药丸，两套视觉语言并存——用户报
        // 「刷新栏目/独立窗口状态有点简略，而且不统一风格」。文字全部进
        // title/aria-label，按钮本身只留图标。
        ".hwb-act-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;color:var(--dsw-alias-label-secondary,inherit);background:0 0;border:0;border-radius:6px;cursor:pointer;transition:background .12s ease,color .12s ease}",
        ".hwb-act-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-primary,inherit)}",
        ".hwb-act-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:-1px}",
        ".hwb-act-btn:disabled{color:var(--dsw-alias-label-quaternary,#c2c7cf);cursor:default}",
        ".hwb-act-btn.on{color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-frame-host{position:relative;flex:1;min-height:0;overflow:hidden;z-index:1}",
        ".hwb-browser-frame{display:block;width:100%;height:100%;min-height:0;border:0;background:#fff}",
        // ---- 0.20.0 工作区画面流 LivePane ----
        ".hwb-live{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#111)}",
        // 0.21.2 删除：原先这里还有 .hwb-live-bar / -dot / -status / -tab / -tag /
        // -close / -new 七条样式，服务于面板内那条自建状态行。该行已按用户要求
        // 删除（上面 LivePane 的注释记录理由），样式一并删掉——留着会是七条
        // 永远匹配不到元素的死规则。
        ".hwb-live-view{position:relative;flex:1;min-height:0}",
        ".hwb-live-canvas{position:absolute;inset:0;width:100%;height:100%;outline:none;cursor:default}",
        ".hwb-live-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#111;outline:none}",
        ".hwb-live-mask{position:absolute;inset:0;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;background:rgba(17,17,17,.55);color:#fff;font-size:13px}",
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
        // ---- 面板类名（0.15.12）--------------------------------------------
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
        // 任务板与设置页花名册共用一套类名，因为它们的信息结构相同
        //（摘要行 + 若干分组 + 若干行），差别只在数据来源。两套类名会让
        //「任务板的行高比花名册大一像素」这类漂移永远没人发现。
        //（0.19.0：原先还有第三个消费者「Team 面板」，已按用户要求删除。）
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
        // 小标签（角色 / 归属 / 任务数 / 写范围告警）：任务板自己的行内小标签，
        // 独立命名而不是跨面板复用——复用会让两处样式互相牵制。
        ".hwb-chip{font-size:12px;line-height:18px;padding:0 8px;border-radius:9px;flex:none;white-space:nowrap;color:var(--dsw-alias-label-secondary,inherit);border:.5px solid var(--dsw-alias-border-l3,#8885)}",
        ".hwb-chip.warn{color:var(--dsw-alias-state-error-primary,#93443e);border-color:var(--dsw-alias-state-error-primary,#93443e)}",
        // 空态/加载态：与官方 guide 卡片同一套措辞位置（顶部对齐、不要垂直居中——
        // 面板常常是窄条，垂直居中的空态会飘在中间显得像加载失败）。
        ".hwb-panel>p.hwb-hint{margin:0}",
        // 左栏入口切过来的主列页面（0.16.0）。滚动与页面内边距归**容器**，
        // 面板内部继续用 .hwb-panel 那一套——同一个语义只有一份排版。
        //
        // 0.16.18：中央列容器在新版官方里是**列向 flex**
        //（ui-layout 的 `pI_x6G_centerCol{flex-direction:column;display:flex}`，
        // 见 AppFrame 的 CenterColumn），main 座位渲染进去的就是它的 flex 子项。
        // 因此这里必须按 flex 子项的规则写：`flex:1;min-height:0` 才能正确占满并
        // 允许内部滚动；旧写的 `height:100%` 在 flex 父容器下**不保证**解析出高度
        //（百分比高度要求父级有确定高度），表现是内容撑不满或底部滚不到。
        //
        // box-sizing 仍必须显式写：少这一句 padding 会把容器撑出可视区。
        // 内层排版**逐项**对齐官方整列页面（ui-plugin-manager 的 page / pageHead /
        // pageTitle 那条 CSS）：页面内边距上下 28px、左右随视口在 24–48px 之间伸缩；
        // 分节间距 32px；正文列宽上限 960px 并居中；页面标题 20px/500/28px。
        //
        // 为什么标题从 15px 改成官方的 20px/28px：15px 是**右栏窄条**那一档的
        // 尺度。左栏入口切过来的是**整列页面**，官方给整列页面的标题就是 20px/28px；
        // 沿用窄条的 15px 会让页面看起来像「一条被放大的侧栏」，层级也压不住
        // 下面 13px 的正文——这正是用户说的「没适配」在观感层面的样子。
        //
        // 为什么正文列要 max-width 居中：整列页面在宽屏上可以到 1600px+，任务标题
        // 与关键路径一行铺满整屏就没法读了。960px 是官方整列页面的正文列宽。
        //
        // 容器自身仍保留 flex:1;min-height:0（中央列在新版官方里是列向 flex，
        // 见 AppFrame 的 CenterColumn，上面那段注释已说明为什么不能写 height:100%）；
        // 这里只是把**内层排版**换成官方 page 那一套。
        ".hwb-main{flex:1;min-height:0;box-sizing:border-box;overflow:auto;display:flex;flex-direction:column;align-items:center;gap:32px;padding:28px clamp(24px,4vw,48px) 48px}",
        ".hwb-main>*{width:100%;max-width:960px}",
        ".hwb-main-head{margin:0;font-size:20px;font-weight:500;line-height:28px;color:var(--dsw-alias-label-primary,inherit)}",
        // 页面内边距归 .hwb-main（官方 page 也是这么分的），面板自己那圈内边距
        // 在这里就是重复留白。.hwb-panel 本身**不改**——它同时挂在右栏窄条与
        // 设置页下，那两处的内边距是对的，动了会让它们一起漂移。
        ".hwb-main>.hwb-panel{padding:0}",
        // ── 任务看板（Kanban）与 Notion 式卡片详情样式 ──
        ".hwb-taskboard-container{display:flex;flex-direction:column;gap:16px;width:100%}",
        ".hwb-tb-toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l3,#8884)}",
        ".hwb-tb-toolbar-left,.hwb-tb-toolbar-right{display:flex;align-items:center;gap:8px}",
        ".hwb-btn{height:28px;padding:0 12px;font:inherit;font-size:12px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;border:.5px solid var(--dsw-alias-border-l3,#8885);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);transition:background .12s ease}",
        // 主按钮的字色与底色都走官方 token，逐项对照参考实现
        // （`reference/dsh-task-board/src/client/board.module.css` 的 `.primaryButton`，
        // 用户明确指定以它为标准）：
        //   · 底色 = `--dsw-alias-button-info-fill`（**不是** `brand-primary`——
        //     官方按钮语义 token 才有配套的 hover 档，`brand-primary` 没有）；
        //   · 字色 = `--dsw-alias-label-primary-foreground`（**不是** `#fff`：
        //     官方 token 家族里**没有**「label-inverse」这个名字，凭直觉写一个
        //     不存在的 token 会静默落到回落值，换主题时字色不跟随）；
        //   · hover 换底色 = `--dsw-alias-button-info-hover`（官方口径），
        //     而不是整块 `opacity:.9`（那会把文字一起调淡）。
        ".hwb-btn.primary{background:var(--dsw-alias-button-info-fill,#3b82f6);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}",
        ".hwb-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,#2563eb)}",
        ".hwb-btn.ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary,inherit)}",
        // 危险按钮同理：`#dc2626` 是写死的十六进制，换主题不会跟着变。
        // 官方语义 token `--dsw-alias-state-error-primary` 才是「危险」的唯一真相。
        ".hwb-btn.danger{background:var(--dsw-alias-state-error-primary,#dc2626);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}",
        ".hwb-btn.small{height:22px;padding:0 8px;font-size:11px}",
        // hover 不再整块 `opacity:.9`：那会把边框、文字一起调淡（官方按钮 hover
        // 只换底色，文字保持全对比）。改用官方交互底色 token。
        ".hwb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8882)}",
        ".hwb-btn:disabled{opacity:.5;cursor:not-allowed}",
        ".hwb-search{width:200px;height:28px;font-size:12px;padding:0 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,#8885);background:var(--dsw-alias-bg-layer-1,transparent);color:inherit}",
        // 五列看板必须是**可收缩**的：写死 `repeat(5,1fr)` 时每列最小宽度由内容
        // 决定，窄面板下五列一起被压到读不出字。官方的做法是给列一个可用下限、
        // 超出就横向滚动（`.hwb-kanban-col` 的 `min-width` 与这里的 `auto-fit` 配对）。
        ".hwb-kanban-board{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;align-items:start;overflow-x:auto;padding-bottom:16px}",
        ".hwb-kanban-col{background:var(--dsw-alias-bg-layer-1,#f8f9fa);border:.5px solid var(--dsw-alias-border-l4,#8883);border-radius:12px;display:flex;flex-direction:column;min-width:180px;max-height:80vh}",
        ".hwb-kanban-col-head{padding:10px 12px;display:flex;align-items:center;justify-content:space-between;border-bottom:.5px solid var(--dsw-alias-border-l4,#8883)}",
        ".hwb-kanban-col-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}",
        ".hwb-kanban-col-count{font-size:11px;padding:1px 6px;border-radius:9px;background:var(--dsw-alias-border-l4,#8883);color:var(--dsw-alias-label-tertiary,#888)}",
        ".hwb-kanban-col-cards{padding:8px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}",
        ".hwb-kanban-card{background:var(--dsw-alias-bg-base,#fff);border:.5px solid var(--dsw-alias-border-l3,#8884);border-radius:8px;padding:10px;cursor:pointer;display:flex;flex-direction:column;gap:6px;transition:box-shadow .15s ease,border-color .15s ease}",
        // 卡片 hover 不再 `transform:translateY(-1px)`：官方列表行 hover **不位移**
        // （位移会让整列文字在鼠标扫过时抖动，是「不安静」的界面）。只换边框 + 阴影，
        // 阴影走官方 elevation token，不写死 rgba。
        ".hwb-kanban-card:hover{border-color:var(--dsw-alias-border-l2,#8885);box-shadow:var(--dsw-elevation-prominent,0 2px 8px rgba(0,0,0,.08))}",
        ".hwb-kcard-head{display:flex;align-items:center;justify-content:space-between;font-size:11px}",
        ".hwb-kcard-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-tertiary,#888)}",
        ".hwb-kcard-title{font-size:13px;font-weight:500;line-height:1.4;color:var(--dsw-alias-label-primary,inherit)}",
        ".hwb-kcard-desc{font-size:12px;color:var(--dsw-alias-label-tertiary,#666);line-height:1.4}",
        ".hwb-kcard-footer{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-top:4px}",
        ".hwb-tag{font-size:11px;padding:1px 6px;border-radius:8px;background:var(--dsw-alias-border-l4,#8883);color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-comment-badge{font-size:11px;color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-kanban-empty{text-align:center;padding:24px 8px;font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}",
        // 操作回执 / 错误横幅（0.19.0，取代 alert）。形态对齐官方内联提示：
        // 12px 行高 18px、语义色走 state token、不写死颜色。
        ".hwb-notice{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;border:.5px solid var(--dsw-alias-border-l3,#8884);background:var(--dsw-alias-bg-layer-1,transparent)}",
        ".hwb-notice-text{flex:1 1 auto;min-width:0;word-break:break-word}",
        ".hwb-notice.ok{color:var(--dsw-alias-state-success-primary,#2e7d32);border-color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-notice.bad{color:var(--dsw-alias-state-error-primary,#93443e);border-color:var(--dsw-alias-state-error-primary,#93443e)}",
        // 字段级校验错误：逐项对照参考实现的 `.formError`
        // （12px / 零边距 / `--dsw-alias-state-error-primary`）。
        ".hwb-form-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#93443e)}",
        // 表单输入走官方输入底与聚焦色（参考实现 `.input` / `.input:focus`）。
        ".hwb-modal-form .hwb-input,.hwb-modal-form .hwb-textarea,.hwb-modal-form .hwb-select{background:var(--dsw-specific-input-major,transparent);border:.5px solid var(--dsw-alias-border-l2,#8885)}",
        ".hwb-modal-form .hwb-input:focus,.hwb-modal-form .hwb-textarea:focus,.hwb-modal-form .hwb-select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#3b82f6)}",
        // ── 审阅区：Office / Word 式「左正文 · 右批注栏」（0.18.0）────────────
        // 用户要求：「参考 office 左正文，右划线编辑评论并合理显示：完全参考 office 实现」。
        // 布局取 Word 审阅窗格的三条本质：正文占主区、批注走**右侧页边**、两者各自滚动。
        // 窄屏（<720px）回落为上下——硬撑两栏会让两栏都窄到不能用。
        ".hwb-review-split{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(240px,1fr);gap:20px;align-items:start}",
        "@media (max-width:720px){.hwb-review-split{grid-template-columns:1fr}}",
        ".hwb-review-doc{display:flex;flex-direction:column;gap:8px;min-width:0}",
        ".hwb-review-doc-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}",
        ".hwb-review-tip{font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}",
        ".hwb-review-textarea{min-height:340px}",
        // 正文侧的「已批注片段」锚点清单：Word 用正文底纹表达这件事，这里用可点的
        // 片段行表达（见组件处对「为何不改 contenteditable」的说明）。
        ".hwb-review-anchors{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px}",
        ".hwb-review-anchors-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);flex:none}",
        ".hwb-review-anchor{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit;font-size:11px;line-height:18px;padding:0 8px;border-radius:9px;cursor:pointer;background:var(--dsw-alias-brand-subtle,#eef2ff);color:var(--dsw-alias-label-secondary,inherit);border:.5px solid var(--dsw-alias-border-l3,#8884)}",
        ".hwb-review-anchor:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}",
        // 页边栏：独立滚动，宽度随内容自适应但不挤掉正文
        ".hwb-review-margin{display:flex;flex-direction:column;gap:10px;min-width:0;padding-left:16px;border-left:.5px solid var(--dsw-alias-border-l3,#8884)}",
        ".hwb-review-margin-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
        ".hwb-review-comments{max-height:420px;overflow-y:auto;padding-right:4px}",
        ".hwb-comment-implement{align-self:stretch;margin-top:2px}",
        // Notion 式详情页
        ".hwb-notion-page{width:100%;max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:20px;padding:16px 0}",
        ".hwb-notion-header{display:flex;align-items:center;justify-content:space-between;border-bottom:.5px solid var(--dsw-alias-border-l3,#8884);padding-bottom:12px}",
        ".hwb-notion-actions{display:flex;align-items:center;gap:8px}",
        ".hwb-notion-body{display:flex;flex-direction:column;gap:18px}",
        ".hwb-notion-title-input{font-size:24px;font-weight:600;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,inherit);width:100%}",
        ".hwb-notion-properties{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;padding:12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f9fafb);border:.5px solid var(--dsw-alias-border-l4,#8883)}",
        ".hwb-notion-prop-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}",
        ".hwb-prop-name{color:var(--dsw-alias-label-tertiary,#888)}",
        ".hwb-session-key{font-family:monospace;font-size:11px;color:var(--dsw-alias-label-secondary,inherit);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".hwb-notion-section{display:flex;flex-direction:column;gap:10px}",
        ".hwb-section-title{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}",
        ".hwb-notion-desc-textarea{width:100%;box-sizing:border-box;font:inherit;font-size:13px;line-height:1.6;padding:10px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3,#8885);background:var(--dsw-alias-bg-base,#fff);color:inherit;resize:vertical}",
        ".hwb-comments-list{display:flex;flex-direction:column;gap:10px}",
        ".hwb-comment-card{padding:10px 12px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3,#8884);background:var(--dsw-alias-bg-layer-1,#fafafa);display:flex;flex-direction:column;gap:6px}",
        ".hwb-comment-card.resolved{opacity:.65;border-style:dashed}",
        ".hwb-comment-quote{margin:0;padding-left:8px;border-left:3px solid var(--dsw-alias-brand-primary,#3b82f6);font-size:12px;color:var(--dsw-alias-label-secondary,#555);font-style:italic}",
        ".hwb-comment-text{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}",
        ".hwb-comment-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px}",
        ".hwb-comment-time{color:var(--dsw-alias-label-tertiary,#888)}",
        ".hwb-comment-form{display:flex;flex-direction:column;gap:8px;margin-top:8px}",
        ".hwb-quote-preview{display:flex;align-items:center;gap:6px;font-size:12px;padding:6px 10px;border-radius:4px;background:var(--dsw-alias-brand-subtle,#eff6ff);border:.5px solid var(--dsw-alias-brand-primary,#3b82f6)}",
        ".hwb-quote-label{color:var(--dsw-alias-brand-primary,#3b82f6);font-weight:500}",
        ".hwb-quote-val{font-style:italic;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".hwb-btn-close{background:0 0;border:0;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}",
        ".hwb-comment-input-row{display:flex;gap:8px}",
        ".hwb-task-chat-box{border:.5px solid var(--dsw-alias-border-l3,#8884);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-1,#fafafa)}",
        ".hwb-task-chat-history{display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto}",
        ".hwb-chat-msg{font-size:13px;line-height:1.5;padding:6px 10px;border-radius:6px;background:var(--dsw-alias-bg-base,#fff);border:.5px solid var(--dsw-alias-border-l4,#8883)}",
        ".hwb-chat-msg.user{background:var(--dsw-alias-brand-subtle,#eff6ff)}",
        ".hwb-task-chat-input-row{display:flex;gap:8px}",
        // Modal 弹窗
        ".hwb-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:grid;place-items:center;z-index:9999}",
        ".hwb-modal-content{width:90%;max-width:540px;background:var(--dsw-alias-bg-base,#fff);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.15);border:.5px solid var(--dsw-alias-border-l3,#8884);display:flex;flex-direction:column}",
        ".hwb-modal-header{padding:14px 18px;display:flex;align-items:center;justify-content:space-between;border-bottom:.5px solid var(--dsw-alias-border-l4,#8883)}",
        ".hwb-modal-header h3{margin:0;font-size:15px;font-weight:600}",
        ".hwb-modal-form{padding:18px;display:flex;flex-direction:column;gap:14px}",
        ".hwb-form-field{display:flex;flex-direction:column;gap:6px;font-size:12px}",
        // 0.19.7：任务板弹窗的控件此前只覆盖了底色/边框（下面那条 `.hwb-modal-form` 规则），
        // **没有** `box-sizing` —— 弹窗内 `width:100%` 的输入框因此按内容盒计算，探出
        // `.hwb-modal-content` 的内边距（与设置页同一类溢出）。这里把盒子模型、padding、
        // 圆角补齐，与 `.hwb-model-select` 同一套刻度；`max-width:100%` 兜住窄面板。
        ".hwb-input,.hwb-select,.hwb-textarea{box-sizing:border-box;max-width:100%;min-width:0;padding:6px 10px;font:inherit;font-size:13px;border-radius:8px}",
        ".hwb-input:focus,.hwb-select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4f6ef7)}",
        ".hwb-field-label{font-weight:500;color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}",
        ".hwb-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}",
        // 并列多会话视图样式（列布局按 data-cols 自适应 2~4 列，见下）
        ".hwb-compare-view{display:flex;flex-direction:column;gap:16px;width:100%;height:100%;padding:16px;box-sizing:border-box}",
        ".hwb-compare-header{display:flex;flex-direction:column;gap:4px}",
        ".hwb-compare-title{margin:0;font-size:18px;font-weight:600}",
        // 列数**按实际列数**排（0.18.0）：原先写死 repeat(3,1fr)，于是「加一列」
        // 加出来的第四列会被挤到第二行 —— 那是 0.17.3 硬编码三列的另一半。
        ".hwb-compare-columns{display:grid;gap:16px;flex:1;min-height:0;grid-auto-rows:minmax(0,1fr)}",
        ".hwb-compare-columns[data-cols=\"2\"]{grid-template-columns:repeat(2,minmax(0,1fr))}",
        ".hwb-compare-columns[data-cols=\"3\"]{grid-template-columns:repeat(3,minmax(0,1fr))}",
        ".hwb-compare-columns[data-cols=\"4\"]{grid-template-columns:repeat(4,minmax(0,1fr))}",
        ".hwb-compare-col{background:var(--dsw-alias-bg-layer-1,#f8f9fa);border:.5px solid var(--dsw-alias-border-l4,#8883);border-radius:8px;display:flex;flex-direction:column;overflow:hidden}",
        ".hwb-compare-col-head{padding:10px 12px;background:var(--dsw-alias-bg-base,#fff);border-bottom:.5px solid var(--dsw-alias-border-l4,#8883);display:flex;align-items:center;gap:8px}",
        ".hwb-col-idx{font-weight:600;font-size:12px}",
        ".hwb-compare-col-body{padding:12px;display:flex;flex-direction:column;gap:8px;flex:1;overflow-y:auto}",
        ".hwb-compare-input-bar{display:flex;gap:8px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l3,#8884)}",
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
      // **一个**标签页 kind（0.16.18 由三个减为两个，0.19.0 再减为一个）：
      //   • webcode-bridge —— 网页镜像（可多开、可浮动）。
      //
      // 另两个 kind 都是在各自的时点被**删除**的，理由不同：
      //   • `webcode-tasks`（0.16.18）—— 与左栏全局面板同数据同组件，两个入口互相
      //     打架，而右栏窄条也放不下依赖图。任务板现在只走左栏 `sidebar.panellist`
      //     + `main`（见下方注册处）；
      //   • `webcode-team`（0.19.0）—— 它读的是官方 `agentTeams` 花名册，用户明确
      //     指出「参考错误了」。本插件的 Team 是中央对话区的**并列多会话**
      //     （`MultiModelCompareView`），完整理由见下方「Team 面板标签页：已删除」。
      //
      // 为什么每个面板一个**独立 kind** 而不是一个 kind 内部再分栏：官方契约
      //（tab-registry.d.ts）里 kind 就是「这是什么类型的标签页」，每个 kind 有自己
      // 的标题、地址识别与 guide 入口；合成一个的话，标签条上会出现同名标签，
      // 浮动/分屏也无法按类型定位。而 pane.tab 座位是 keyed 的（按定义 id 派发），
      // 两个 kind 各注册自己的 body 即自然成立。
      const TAB_ID = 'dsh-webcode-bridge';
      const TAB_KIND = 'webcode-bridge';
      // 站点网页标签（0.16.35）：一个站点一个标签。
      //
      // 为什么另开一个 kind 而不是复用 TAB_KIND：`multiple: true` 是**按 kind** 声明
      // 的（tab-registry.d.ts:84「Each open by kind creates independent content」）。
      // 目录页必须每 pane 只有一份，站点页必须可以多份——两个要求互斥，只能两个 kind。
      // 而 pane.tab 座位是 keyed 的（按定义 id 派发），所以各注册各的正文即可。
      const SITE_ID = 'dsh-webcode-bridge/site';
      const SITE_KIND = 'webcode-site';
      // 0.19.0：`TEAM_ID` / `TEAM_KIND` 已随「官方花名册 Team 面板」一并删除，见下方
      // 「Team 面板标签页：已删除」处的完整理由（本插件的 Team 是并列多会话，不是花名册）。
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
      /**
       * 为一个站点打开一个独立标签（0.16.35）。
       *
       * 这是「一行并列显示不同网址栏目」的实现：`kind` 用 `multiple: true` 注册，
       * 每次调用都是一条**独立**标签，标题由 `sidebar.right.pane.tab.title` 按
       * `navigation.params.siteId` 现算（见下方 TITLE_ID 注册）——于是标签条上就是
       * 「DeepSeek / 智谱清言 / Kimi …」一排。
       *
       * 同一站点重复点击会**揭示已有标签**而不是再开一个（官方 `revealIfOpened` 默认
       * 行为对 page type 恒为去重），这也是用户要的「选择不一样的能跳回去」。
       */
      const openSiteTab = (sid, slot) => {
        if (!sid || !SITE_NAMES[sid]) return;
        try {
          ctx.sidebarRight.openTab(SITE_KIND, { params: { siteId: sid, slot: slot || '' } });
        } catch (e) { warn('sidebarRight.openTab (site)', e); }
      };
      /**
       * 读本标签的 hook context（`useTabInfo`），失败一律回 null。
       *
       * 抽出来是因为目录页与站点页都要它，而两处的**失败语义必须一致**：读不到
       * 就回落，不抛。读取本身就是一次 hook 调用，因此只能在组件体顶层调——
       * 这也是为什么它包在 try/catch 里而不是写成「先判断再调」。
       */
      const safeTabInfo = (props) => {
        try {
          return props && typeof props.useTabInfo === 'function' ? props.useTabInfo() : null;
        } catch (e) { warn('tab info', e); return null; }
      };
      /**
       * 目录页：「Web Bridge」标签的全部内容（一级）。
       *
       * ## 0.16.39：选站点**替代本标签页**（用户：「web bridges 内选择网站后，是直接
       * 替代 web 页面打开，而不是新开/保留 web」）
       *
       * 旧实现调 `ctx.sidebarRight.openTab(SITE_KIND, …)`——那是在当前 pane 里**新开
       * 一条**标签，于是「Web Bridge」这条永远留在标签条上（用户看到的「保留 web」）。
       *
       * 官方「新建终端」不是这么做的：它的入口胶囊点一下走的是
       *
       *     tab.actions.openTab(kind, { replaceTab: true })
       *
       * —— guide 把自己**让位**给被打开的页面（`GuideBody` 的 `replaceTab: true`）。
       * 这里改用同一条官方路径：借本标签自己的 `tab.actions`，`replaceTab` 顶掉自己。
       * 目录页让位之后，官方 settle planner 会在 pane 空出时补回 guide 标签，因此
       * 「再选一个站点」永远有入口——不需要我们额外保留什么。
       *
       * 降级：拿不到本标签动作（旧版右栏 / 测试桩）时退回 `ctx.sidebarRight.openTab`，
       * 即旧行为「新开一条标签」。此时目录不会被顶掉——**降级不是崩溃**，只是少一个
       * 更贴合官方语义的行为，用户仍能正常用。
       */
      const CatalogBody = (props) => {
        const info = safeTabInfo(props);
        const openInPlace = (sid, slot) => {
          if (!sid || !SITE_NAMES[sid]) return;
          const params = { siteId: sid, slot: slot || '' };
          const actions = info && info.tab ? info.tab.actions : null;
          if (actions && typeof actions.openTab === 'function') {
            try {
              actions.openTab(SITE_KIND, { params, replaceTab: true });
              return;
            } catch (e) { warn('tab.actions.openTab (site)', e); }
          }
          openSiteTab(sid, slot);
        };
        return h(SiteCatalogBody, { onOpenSite: openInPlace });
      };
      /**
       * 站点网页标签的正文。
       *
       * `siteId` 从**本标签自己的** navigation.params 读（官方 Browser 面板同款做法，
       * 见 dsh-client-ui-sidebar-browser 的 `tab.navigation.params?.url`）。因此两个
       * 站点标签可以在同一个 pane 里并存而互不干扰——这正是「一行并列」成立的前提。
       *
       * useTabInfo 是框架注入的（`sidebar.right.pane.tab` 的 hookContext），缺失时
       * 回落成「没有受控站点」：面板照常渲染默认站点，而不是白屏（降级不是崩溃）。
       */
      /**
       * 读本标签的 `{ siteId, slot }`。
       *
       * 抽成一处而不是在 body/title 里各写一遍：两处判据必须**逐字相同**，各写一遍
       * 迟早漂移（标题写着 Kimi、正文却是 DeepSeek 那种）。读取失败一律回落空值——
       * 降级不是崩溃：正文退回默认站点、标题退回类型名，而不是白屏或空标题。
       */
      const siteTabParams = (props) => {
        const info = safeTabInfo(props);
        const p = info && info.tab && info.tab.navigation ? info.tab.navigation.params : null;
        if (p && SITE_NAMES[p.siteId]) return { siteId: p.siteId, slot: p.slot || '' };
        return { siteId: '', slot: '' };
      };
      const SiteTabBody = (props) => {
        const { siteId: sid, slot } = siteTabParams(props);
        return h(Conversation, {
          browserSrc: relayBase + '/', siteId: sid, slot, onSplit: splitPanel, onFloat: floatPanel,
        });
      };
      /** 标签标题：站点名（无 params 时回落成类型名，而不是空标题）。 */
      const SiteTabTitle = (props) => {
        const sid = siteTabParams(props).siteId;
        return sid ? siteName(sid) : 'Web 站点';
      };

      // 「Web Bridge」＝站点目录（一级页面，不绑地址）。
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
              description: () => '按站点打开网页，一个站点一个标签，可并列多个',
            }],
          });
        } catch (e) { warn('sidebarRightTabs.register', e); }
      });

      own(() => {
        try {
          return ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab', key: TAB_ID,
          }, CatalogBody));
        } catch (e) { warn('pane.tab body', e); }
      });

      // 站点网页＝独立 kind，`multiple: true` 让「一个站点一个标签」成立。
      own(() => {
        try {
          return ctx.sidebarRightTabs.register({
            id: SITE_ID,
            kind: SITE_KIND,
            multiple: true,
            priority: 'extension',
            title: () => 'Web 站点',
          });
        } catch (e) { warn('sidebarRightTabs.register (site)', e); }
      });
      own(() => {
        try {
          return ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab', key: SITE_ID,
          }, SiteTabBody));
        } catch (e) { warn('pane.tab body (site)', e); }
      });
      own(() => {
        try {
          return ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab.title', key: SITE_ID,
          }, SiteTabTitle));
        } catch (e) { warn('pane.tab title (site)', e); }
      });

      // ---- Team 面板标签页：**已删除**（0.19.0）------------------------------
      //
      // 0.15.12 曾在右栏注册 kind `webcode-team`（id `…/team`），渲染 `TeamPanel`：
      // 一张读官方 `agentTeams.listMembers` 花名册的只读视图。**参考错了。**
      //
      // 用户 2026-09-22 的两次澄清（`doc/user-voice-log.md:3670` 为逐字原话）：
      //
      //   「team不是指的官方team那样，我想更多指的是能够充分发挥本多站点（如果实现）
      //    的优势，能够做到中心对话区域做到：并列不同模型对话进行回复」
      //   「删除参考官方用的team面板，和我设想的team不同，参考错误了……重构team功能，
      //    本插件的并列多会话组成的team」
      //
      // 即：本插件的 Team = **若干条各自独立的网页会话并排**（每列一个站点、各自持
      // 稳定 `sessionKey`、各自接着聊），落点是**中央对话区**，不是右栏的一份花名册。
      // 官方 AgentTeams 描述的是「同一 checkout 里的多个 agent 会话」——那是官方
      // 包自己的模型，与本插件「多站点并排」的目标不是一回事，照抄它等于把别人的
      // 概念装进这个插件。
      //
      // 正解是 `MultiModelCompareView`（本文件内，注册在下方 `conversation.view`）。
      // 这个标签页连同它的 `TEAM_ID` / `TEAM_KIND` 常量一并删除；**不得复活**——
      // 护栏见 `test/team-compare.test.mjs` 与 `test/client-render.test.mjs`。
      //
      // `roster.js` 对官方 `agentTeams` 的读取**保留**：它仍是任务板 `listTasks`
      // 的官方来源，删的是「把它当成本插件的 Team」这一层呈现。

      // ---- 任务板的右栏标签页：**已删除**（0.16.18）------------------------
      //
      // 0.15.12 曾在右栏注册第三个 kind `webcode-tasks`（id `…/tasks`），与左栏
      // 那个全局面板**指向同一份数据、同一个组件**（`TaskBoardPanel`）。用户
      // 0.16.18 明确要求删掉这一份注册，理由成立：
      //
      //   • 同一件事有两个入口，用户不知道哪个是「真的」——点开左边和点开右边
      //     看到的是同一张板，却各自记着独立的滚动位置与选中标签；
      //   • 右栏是**窄条常驻**视图（几百像素），依赖图在那里只能一行一省略号，
      //     而左栏那份是整列页面、宽度充足。窄条那版从来没被真正用过。
      //
      // 任务板现在只有**一个**入口：左栏 `sidebar.panellist` 行 + 同名 `main`
      // 中央列页面（见下方注册处）。`TaskBoardPanel` 组件本身保留——它仍是那
      // 个页面的渲染体，只是不再被右栏标签页复用。

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

      // 会话头角落席位让官方 dsh-client-ui-sidebar-right 持有（其 ExpandButton
      // 与本面板同 store、同 toggleExpanded 职责，重复声明反酿席位冲突）。

      // ---- 中央区并列多会话 Team（0.17.3 起，0.19.0 收敛为本插件唯一的 Team 形态）----
      //
      // 这是用户需求 5 的落点：「中心对话区域做到：并列不同模型对话进行回复」。
      // 它是本插件对「Team」的**唯一**实现——右栏那份官方花名册 Team 面板已于
      // 0.19.0 删除（理由见上方注册处）。
      //
      // `label` 必须与真实能力一致：列数由 `MultiModelCompareView` 的数组状态驱动，
      // 支持 2~4 列（`MIN_COLS`/`MAX_COLS`）。旧标签「三列模型对比」在用户加到
      // 第四列时就是一句假陈述，故改为「并列多会话」。
      own(() => {
        try {
          return ctx.slots.inject('conversation.view', () => ctx.slots.register({
            name: 'conversation.view',
            id: 'webcode-compare-view',
            order: 15,
            label: () => '并列多会话',
          }, MultiModelCompareView));
        } catch (e) { warn('conversation.view compare', e); }
      });

      return () => disposers.reverse().forEach(d => { try { d(); } catch (_) {} });
    }
    const exports = { name: 'webcode-bridge-client', inject, apply };
    if (module) module.exports = exports;
    return exports;
  },
});
