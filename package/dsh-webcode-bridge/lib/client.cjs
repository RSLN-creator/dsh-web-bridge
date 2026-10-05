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
    /**
     * 统一的降级告警出口（**工厂作用域**，不是 `apply()` 里）。
     *
     * 为什么强调作用域（0.19.63 真机事故）：`ConcurrentPanel`、`createPanelGuard` 等
     * 组件与工具函数定义在 `apply()` **之外**（`function apply(ctx)` 从本文件后段才开始），
     * 而被它们调用的 `warn` 原先声明在 `apply()` **内部** ⇒ 真机上这些 catch 分支一执行
     * 就是 `ReferenceError: warn is not defined`。0.19.62 的守卫把 catch 写进面板 effect
     * 之后，这个错在渲染/提交期被官方 `SlotErrorBoundary` 吞成空盒——**又一次「面板全白、
     * 且看不到原因」**。所以 `warn` 只能有一份、且必须在所有调用者都看得见的最外层。
     *
     * 判据：`test/team-compare.test.mjs` 钉「`const warn` 必须在 `function apply(ctx)` 之前」
     * ＋「全文件只有一处声明」；真机由 `test-mock/probe-concurrent-live.mjs` 收口。
     *
     * @param {string} what 失败的动作名
     * @param {*} e 失败原因（打印 message 优先）
     */
    const warn = (what, e) => console.warn('[webcode-bridge] ' + what + ' failed:', e && e.message ? e.message : e);
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
    // `sessions` 是并发会话的必要服务（0.19.55）：每一列都要 `ctx.sessions.create()`
    // 造一条真会话、再 `retain()` 拿引用交给官方 `SessionProvider`。不声明它，
    // `ctx.sessions` 在宿主里是 undefined —— 面板会如实显示「宿主没有提供 sessions 服务」
    // 而不是崩掉（降级不是崩溃），但并发会话也就无从谈起。
    //
    // `layout`（0.19.63 真机空白根因）：并发面板的「选中意图守卫」要读
    // `ctx.layout.panelInfo`（见 createPanelGuard）。**cordis 的 reflect 代理对未声明
    // inject 的服务读取是直接抛错**（`cannot get property "layout" without inject`），
    // 不是给 undefined —— 0.19.62 把 `ctx.layout` 写在 `main` 条目的组件函数里，于是
    // 组件一渲染就抛，被官方 `SlotErrorBoundary` 兜成 `<div data-slot-error>` 空盒：
    // 真机现象就是「并发界面一片空白、连页签都没有」（侧栏行在、点得动，中央区全空）。
    // 官方同款写法作依据：`dsh-client-ui-sidebar` 的 inject 同样列了 `"layout"`。
    // 本文件的其余 `ctx.*` 读取（slots / sidebarRight / sidebarRightTabs / sessions）
    // 都已在此声明，`ctx.effect`、`ctx.reflect` 是 cordis 自带、不需要声明。
    const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'layout', 'uiWorkspace'];
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
    //
    // ## 槽维度（0.19.46）：非默认槽必须用**带槽的主机名**
    //
    // 用户原话：「现在右侧选择了账户2打开界面仍是用户1：rsyhn的登录账户，deepseek」。
    //
    // 根因在服务端（镜像原先只按 siteId 挂载、cookie 来源写死默认槽，见
    // lib/index.js 的 mirrorFor 注释），而**客户端这里也参与**：旧实现只按
    // `siteId` 拼源、frame 也只按 siteId 缓存 ⇒ 账户2 与账户1 指向同一个地址，
    // 服务端即使修好了也无从区分。
    //
    // 因此两端用同一套形状：默认槽不变（既有用户零位移），非默认槽加 `<slot>--` 前缀。
    //   · 默认槽      → http://deepseek.localhost:8931/   （`deepseek` 仍走中继根）
    //   · 账户2       → http://2--deepseek.localhost:8931/
    //   · glm 默认槽  → http://glm.localhost:8931/
    //   · glm 账户2   → http://2--glm.localhost:8931/
    //
    // ⚠ 两个槽**必须**是两个不同的 frame / 源。共用会让账户2 的标签页拿到账户1
    // 的 cookies —— 那正是本条用户报障，且属于「同一账号不得同时桥接」那条纪律
    // 想防的同一族事故（两个登录态在同一页面上互相覆盖）。
    const ROOT_MOUNTED = { deepseek: true };
    const siteBase = (sid, slot) => {
      const s = String(slot || '').trim();
      // 默认槽（空/`default`/`1`）逐字保持旧形状。
      const isDefault = !s || s === 'default' || s === '1';
      if (isDefault) return ROOT_MOUNTED[sid] ? relayBase + '/' : 'http://' + sid + '.localhost:' + RELAY_PORT + '/';
      // 非默认槽：`<slot>--<siteId>`（分隔符 `--` 与服务端解析逐字对应）。
      return 'http://' + s + '--' + sid + '.localhost:' + RELAY_PORT + '/';
    };
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
    //
    // **值必须逐字等于 `lib/providers.js` 各站点声明的 `name`**（2026-10-03 用户指令：
    // 「全部统一成网站原名」——例：豆包 → Doubao）。此前这里是中文译名（`豆包` /
    // `智谱清言` / `通义千问`），而服务端那份带括号注解（`DeepSeek 网页版` /
    // `智谱清言 (GLM)`），于是**同一个站点在右栏与设置页是两个名字**；用户报的
    // 「右侧网页界面单个账户（豆包）不显示原来网站名称」正是这一处。
    //
    // 这是**展示层**的表：它只决定标签页标题、工具条、目录卡片与设置页 tab 的
    // 文字。站点 id（`doubao`）、模型 id（`doubao:chat`）、分组名（`z.ai`）一律不动。
    const SITE_NAMES = { deepseek: 'DeepSeek', glm: 'GLM', chatgpt: 'ChatGPT', kimi: 'Kimi', qwen: 'Qwen', doubao: 'Doubao', grok: 'Grok', claude: 'Claude', gemini: 'Gemini', zai: 'Z.ai' };
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
          // 0.19.34：标题右侧那个数就是**在途实时读数**本身，不再另起一行。
          //
          // 用户原话：「移除突然出现的：正在等待发送 Ns，改为实时更新面板顶部
          // 『等待发送统计』」。旧形态是标题右侧钉着**已落账**的本会话累计
          //（sessionValue），在途那一段另起一行「正在等待发送 3 秒」——面板里同时
          // 站着两个数，一个不动、一个在涨，而标题那个恰恰是旧的那个。
          //
          // 现在的口径与药丸逐字同源（见 wait-stats.js 的 projectedWaitMs）：
          // 标题右侧 = 本会话等待发送总量 = 账本累计 + 在途增量。在途期间它每秒
          // 前进一格，轮询节奏由上面 liveActive 那条 effect 提到 1 秒。
          data?.projectedValue
            ? h('span', { className: 'hwb-waitpanel-value' }, data.projectedValue)
            : null),
        h('div', { className: 'hwb-waitpanel-rule', 'aria-hidden': true }),
        // 明细只放**账本口径**的条目。在途读数已经上了标题，这里不再重复——
        // 同一个数在一张面板里出现两次，读者就要开始猜它们为什么可能不一样。
        (data?.projectedValue || rows.length)
          ? h('dl', { className: 'hwb-waitpanel-grid' },
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
    function usePromptVariants(revision) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      // ⚠ 依赖里必须有 revision（0.19.33）。
      //
      // 这条 effect 此前是 `React.useEffect(() => { load(); }, [load])`，而 load 是
      // `useCallback(fn, [])` ⇒ **只在挂载时拉一次**。于是用户在站点页改完投递形态后，
      // 派生自 /prompt-variants 的一切（只读模板、增量轮再教学、「实际使用：<协议>」）
      // 永远停在首次挂载那一刻——面板上「已保存」与「看到的仍是旧的」同时成立，
      // 这正是用户报的「更改后提示词更新跟不上」。
      //
      // 为什么不自己做内容比对/定时轮询：那会在浏览器侧造出第二套「设置变了没有」
      // 的判据，而权威判据在服务端（每次落盘自增的 settingsRevision）。让服务端给号、
      // 客户端把它当依赖，是唯一不会分叉的写法。
      React.useEffect(() => {
        let alive = true;
        api('prompt-variants')
          .then(r => { if (alive) { setData(r || null); setError(''); } })
          .catch(e => { if (alive) setError(e.message); });
        return () => { alive = false; };
      }, [revision]);
      return { data, error };
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
     *   · 只读模板默认折叠，展开用于核对「此刻真的在教什么」。展开后是**两个框**
     *（0.19.31 用户要求）：「该站点此刻实际使用的只读模板」与「增量轮再教学」，
     *     两框同形（都用 `<pre>`，样式来自 `.hwb-import pre`）、间距由
     *     `.hwb-site-prompt-frames` 的 `gap` 给。
     */
    function SitePromptCard({ siteId, value, notice, onSave, disabled, revision }) {
      const [draft, setDraft] = React.useState(value);
      const [busy, setBusy] = React.useState(false);
      const [openNotice, setOpenNotice] = React.useState('');
      // revision 透传（0.19.33）：设置一变，这张卡的只读模板与再教学必须跟着重算，
      // 否则「改了设置、页面停在旧模板」在站点页尤其难发现（用户切过来就是为了核对它）。
      const { data, error } = usePromptVariants(revision);
      // 外部值变化（切 tab / 保存后回读）时同步草稿——否则切走再切回来会看到旧文本。
      React.useEffect(() => { setDraft(value); }, [value, siteId]);
      const row = (data?.sites || []).find(r => r && r.siteId === siteId) || null;
      const variant = (data?.variants || []).find(v => v && v.id === (row?.variantId || '')) || null;
      async function openFile() {
        setOpenNotice('');
        // 0.19.36：改用 apiSoft（不抛）。
        //
        // 旧写法用 `api()`，而它在 `ok:false` 时**就抛了**——下面那张 codes 映射表
        // 因此永远走不到，用户看到的是一句 `打开失败：HTTP 200 OK：{"ok":false,
        // "code":"PROMPT_FILE_MISSING","file":"C:\\..."}`（用户实报）。两个后果：
        //   ① 报码映射表形同虚设——它本就是为这条路写的；
        //   ② 整段 JSON（含完整路径）成了界面文案，长到必然溢出所在元素。
        // 现在：非 ok 走映射表给**短文案**；只有真异常（网络/超时）才落 catch。
        const r = await apiSoft('prompt-file', { siteId });
        const data = r.data || null;
        if (r.ok && data && data.ok) { setOpenNotice('已用系统默认程序打开：' + data.file); return; }
        const codes = {
          PROMPT_FILE_MISSING: '该站点的提示词文件还没生成——发送第一条消息后自动落盘。',
          PROMPT_STORE_OFF: '提示词落盘已被显式关闭（WEBCODE_PROMPT_STORE_DIR=off）。',
          OPEN_UNAVAILABLE: '宿主没有提供「用默认程序打开」的能力。',
          OPEN_FAILED: '系统默认程序没有打开成功。',
        };
        const code = data?.code;
        setOpenNotice(codes[code] || ('打开失败：' + (r.error || code || '未知原因')));
      }
      return h('div', { className: 'hwb-import' },
        h('div', { className: 'hwb-row' },
          h('span', { className: 'hwb-row-label' }, '提示词文件'),
          h('div', { className: 'hwb-row-main' },
            h('code', { className: 'hwb-filepath', title: row?.file || '' },
              row?.file || (data ? '（未提供路径）' : '加载中…')),
            // 0.19.31（用户 2026-09-27）：「按钮改名『查看』」—— 两个界面（全局页与
            // 站点页）的这颗按钮现在是同一个词、同一个动作（打开默认程序），
            // 不再一处叫「用默认程序打开」、另一处叫别的。
            h('button', { type: 'button', className: 'hwb-filepath-open', disabled: !row, onClick: openFile }, '查看'),
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
        // ── 0.19.31（用户 2026-09-27 原话）：「各个站点的：『查看该站点此刻的只读模板 /
        //     实际使用：DeepSeek 官方模板（原生工具调用格式）』区域，让增量也通过上面一样
        //     的框展示，然后两框注意间隔」────────────────────────────────────────────
        //
        // 「上面一样的框」= 上面那段只读模板正文的框：两段正文都写成 `<pre>`，而站点卡根
        // 节点就是 `.hwb-import`，于是底色 / 圆角 / 内边距 / 换行口径由**同一条规则**给
        //（`.hwb-import pre`）——不引第二套视觉，两块框天然逐项相同。旧实现里增量再教学
        // 只是一行 `.hwb-hint`（没有框），与上面那个框不同形态，这正是用户报的那点。
        //
        // 「两框注意间隔」由 `.hwb-site-prompt-frames` 的 `gap:8px` 给（与 `.hwb-import` /
        // `.hwb-site-prompt` 同一档），不靠相邻元素 margin 的巧合。
        h('details', { className: 'hwb-site-prompt-details' },
          h('summary', null, '查看该站点此刻的只读模板'),
          error ? h('p', { role: 'alert', className: 'hwb-hint' }, '模板加载失败：' + error)
            : (!row ? h('p', { className: 'hwb-hint' }, '加载中…')
              : h('div', { className: 'hwb-site-prompt-frames' },
                h('div', { className: 'hwb-prompt-frame' },
                  h('p', { className: 'hwb-hint' }, '实际使用：' + ((variant && variant.label) || row.variantId)),
                  h('pre', null, row.text)),
                variant && h('div', { className: 'hwb-prompt-frame' },
                  h('p', { className: 'hwb-hint' }, '增量轮再教学'),
                  h('pre', null, variant.trainNote))))));
    }

    /** 全站点只读总览（全局页）。默认折叠每站模板，避免十个站点把设置页淹掉。 */
    function PromptPanel({ onSaved, revision } = {}) {
      const { data, error } = usePromptVariants(revision);
      // ── 0.19.31（用户 2026-09-27 原话）：「所有界面的查看提示词里面的『查看完整模板』
      //     改为不是展开而是直接打开默认的程序打开文件，然后是这个按钮改名『查看』，
      //     然后是需要放在路径显示右边，做好合适间隔，合适按钮」──────────────────────
      //
      // 于是这一行与站点页那颗「用默认程序打开」走**同一条控制面路由**（`POST prompt-file`，
      // 服务端现算路径、只认 siteId，前端不拼路径），只是按钮文案按用户要求收成「查看」。
      // 每行各自持一个提示（`noticeBySite`）：一个站点的失败不该显示在另一个站点旁边。
      const [noticeBySite, setNoticeBySite] = React.useState({});
      async function openFile(siteId) {
        const put = (msg) => setNoticeBySite(prev => ({ ...prev, [siteId]: msg }));
        put('');
        // 0.19.36：与站点页那颗「查看」同一个缺陷、同一个修法（见 SitePromptCard.openFile）。
        // 这里此前也用 `api()`，`ok:false` 时直接抛，映射表走不到，界面显示整段 JSON。
        const r = await apiSoft('prompt-file', { siteId });
        const data = r.data || null;
        if (r.ok && data && data.ok) { put('已用系统默认程序打开'); return; }
        const codes = {
          PROMPT_FILE_MISSING: '提示词文件还没生成——发送第一条消息后自动落盘。',
          PROMPT_STORE_OFF: '提示词落盘已被显式关闭（WEBCODE_PROMPT_STORE_DIR=off）。',
          OPEN_UNAVAILABLE: '宿主没有提供「用默认程序打开」的能力。',
          OPEN_FAILED: '系统默认程序没有打开成功。',
        };
        const code = data?.code;
        put(codes[code] || ('打开失败：' + (r.error || code || '未知原因')));
      }
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
          // 路径与「查看」同一行：路径可伸缩、按钮固定宽且不换行。
          // 间隔由 `.hwb-site-prompt-pathrow` 的 gap 给（8px），按钮高度走
          // `.hwb-row-actions button` 那套 28px 小刻度，与账户行按钮同一档。
          h('div', { className: 'hwb-site-prompt-pathrow' },
            h('code', { className: 'hwb-filepath hwb-site-prompt-path', title: row.file || '' }, row.file || ''),
            h('button', {
              type: 'button', className: 'hwb-filepath-open',
              title: row.file ? '用系统默认程序打开 ' + row.file : '用系统默认程序打开',
              onClick: () => openFile(row.siteId),
            }, '查看')),
          noticeBySite[row.siteId] && h('p', { className: 'hwb-hint' }, noticeBySite[row.siteId]))),
        data.active?.tools?.length
          ? h('p', { className: 'hwb-hint' }, '本会话工具：' + data.active.tools.join(', '))
          : null);
    }

    function GlobalPrompt({ onSaved, onRevision } = {}) {
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
          // 全局指令改了 ⇒ 每个变体的 text 都跟着变，提示词读数必须重拉（0.19.33）。
          // 旧实现只调 onSaved?.()，而 PromptSection 早就不接这个回调了（0.16.38 拆卡
          // 之后它是 `h(PromptPanel, {})`）——于是「改了全局指令、模板不更新」也是一条
          // 真实的旧缺陷，只是被站点投递形态那条更显眼的症状盖住了。
          //
          // ⚠ 必须用**本组件自己的**回调（onRevision），不能在体内直接调主组件的
          // `applyRevision` —— 那是另一个作用域，静态看不出来、一按就抛
          // `ReferenceError: applyRevision is not defined`（本仓库 0.15.2 的 `nav`、
          // 0.19.33 的 `sleep` 都是这个形状）。
          onRevision?.(r);
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
    function PromptSection({ revision } = {}) {
      return h(PromptPanel, { revision });
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
                  h('option', { value: 'deepseek' }, 'DeepSeek'),
                  h('option', { value: 'glm' }, 'GLM'),
                  h('option', { value: 'kimi' }, 'Kimi'),
                  h('option', { value: 'qwen' }, 'Qwen'),
                  h('option', { value: 'doubao' }, 'Doubao'),
                  h('option', { value: 'zai' }, 'Z.ai'))),
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
                h('option', { value: 'deepseek' }, 'DeepSeek'),
                h('option', { value: 'glm' }, 'GLM'),
                h('option', { value: 'kimi' }, 'Kimi'),
                h('option', { value: 'qwen' }, 'Qwen'),
                h('option', { value: 'doubao' }, 'Doubao'),
                h('option', { value: 'zai' }, 'Z.ai'))),
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
     * **dwb 品牌标记**（0.19.39 引入；0.19.56 改同构；**0.19.57 换 Iconoir
     * `bridge-3d`；0.19.58 按用户微调稿定稿** —— 黑色 + 旋转 90° + 浅蓝副影）。
     *
     * 用户原话（0.19.57）：「名称 bridge-3d 作者 Luca Burgio 许可 MIT 集合下，
     * https://github.com/iconoir-icons/iconoir，请你查看本地图片
     * iconoir_bridge-3d.png 进行使用替换本地全部形象」。
     *
     * ⚠ **0.19.58 的教训**：0.19.57 我拿到图却没照图改——自选了蓝青渐变配色，
     * 而用户的稿子（appicon-forge 微调导出）恰恰是**黑色 + 旋转 90°**。
     * 品牌形象**以用户微调后的稿子为准**，不是以「我觉得好看」为准。
     *
     * ## 几何：Iconoir `bridge-3d` regular 的逐字路径 + 整体旋转 90°
     *
     * 官方 SVG（unpkg `iconoir` npm 包，MIT，作者 Luca Burgio）5 条元素：
     *   · `M18 4L21 4`   —— 短竖线 · `M3 20H6` —— 短竖线
     *   · S 形桥体 `M10 20C10 20 16.5 17.5 12 12C7.5 6.5 14 4 14 4`
     *   · 两个实心圆点 (14,4) 与 (10,20)（r=1）
     * 路径坐标**一个不改**，整体套 `rotate(90 12 12)` —— 用户稿的
     * `iconRotation: 90` 就是它。旋转后落点（1024 画布实测）：左上端点
     * ≈(313,462)、右下端点 ≈(711,562)、两条竖线在各自端点外侧，
     * 与 iconoir_bridge-3d.png 逐点吻合。
     *
     * ## 颜色按位置分（用户 0.19.56 立的规则，0.19.58 按稿定稿）
     *
     *   · 线稿位 `DwbMark`（左栏行 / 右栏 tab 标题 / guide 图标）：**currentColor
     *     不描影**。这些位置与官方图标并排，描影会显脏；currentColor 让明暗主题与
     *     选中态由宿主继承（浅色主题下即用户稿的 `#000000`）。
     *   · 彩色位 `DwbMarkColor`（设置页品牌位）：**黑色 `#000000` + 浅蓝副影
     *     `#65b3fc`**——逐字取自用户稿的 `iconColor: #000000ff` 与
     *     `iconShadow: [[-2,3,1,0,#65b3fcff]]`（offsetX −2 / offsetY +3 /
     *     blur 1），**不另造配色**。
     *
     * 两份共用同一组路径与同一个 `rotate`，只差颜色——漂移在结构上不可能。
     *
     * @param {{size?: number}} props 宿主给的图标呈现（与官方 IconProps 同形）
     */
    function DwbMark(props) {
      return DwbMarkColor({ ...props, monochrome: true });
    }

    /**
     * dwb 品牌标记的**彩色**版（0.19.58）：用户微调稿的定稿实现。
     *
     * 与线稿版的唯一差别是**颜色与副影**（形状、路径、旋转、刻度逐项相同）：
     * 黑色本体 + 浅蓝副影。副影只在彩色位画——线稿位要跟官方图标并排，
     * 带描影会显脏。`props.size` 由宿主给（设置页 20px），必须读而不是写死。
     *
     * 描影用**同一组几何内联画两遍**（副影在下、本体在上）而不是
     * `filter: drop-shadow` 或 `<use href>`：`feDropShadow` 需要独立滤镜通道，
     * 部分宿主渲染路径上不生效；`<use>` 跨节点引用同文档 id 在 React 重渲染时
     * 依赖「被引用节点已挂载」的时序。两次调用同一个纯函数是三者里唯一没有
     * 运行时依赖的。副影坐标按用户稿的 (−2,+3) 与 24 viewBox 等比换算，取
     * (−0.5, +0.75)。
     *
     * @param {{size?: number, monochrome?: boolean}} props
     */
    function DwbMarkColor(props) {
      const size = Number(props?.size) || 16;
      const mono = props?.monochrome === true;
      // 官方正刻度：stroke 1.5 / round 端点 / 圆点 r=1 实心（不改）。
      const sw = 1.5;
      // 官方几何 × 5 条元素 + 整体旋转 90°（用户稿 iconRotation: 90）。
      // ⚠ 旋转写在**内层 <g>** 上，外层 SVG 的 width/height 不动 —— 写在 svg
      // 上会让整个盒子跟着转 90°，在 flex 行里把行高撑歪。
      const art = (c) => h('g', { transform: 'rotate(90 12 12)' },
        h('path', { d: 'M18 4L21 4', stroke: c, strokeWidth: sw, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('circle', { cx: 10, cy: 20, r: 1, fill: c, stroke: c, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('circle', { cx: 14, cy: 4, r: 1, fill: c, stroke: c, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M10 20C10 20 16.5 17.5 12 12C7.5 6.5 14 4 14 4', stroke: c, strokeWidth: sw, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M3 20H6', stroke: c, strokeWidth: sw, strokeLinecap: 'round', strokeLinejoin: 'round' }));
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', 'aria-hidden': 'true', focusable: 'false',
      },
        // 浅蓝副影（用户稿 iconShadow #65b3fc，offset −2,+3）：只在彩色位。
        // 线稿位与官方图标并排，描影会显脏，因此 mono 下这一层不输出。
        !mono ? h('g', { opacity: 0.55, transform: 'translate(-0.5 0.75)' }, art('#65b3fc')) : null,
        // 本体：线稿位 currentColor，彩色位黑色（用户稿 iconColor #000000）。
        art(mono ? 'currentColor' : '#000000'));
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
          // 真实昵称/头像（0.19.37）：**又一处「只挑几个字段」的坑**——
          // 与上面那段注释警告过的 sessionLostCount 逐字同型：服务端算好了、
          // 这里不挑进来，下游就永远读不到，界面只剩默认头像与槽名。
          accountName: s.accountName || null,
          avatarUrl: s.avatarUrl || null,
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
      /**
       * 正在等待二次确认的账户（0.19.59，「删除」按钮）。
       *
       * 与 `picked` 一样，这个 hook 必须写在下面那句提前 `return` **之前**——
       * 写在之后会让「sites 到达」那一次渲染比首屏多一个 hook，真实 React 会硬错误
       *（"Rendered more hooks than during the previous render"），整块设置栏目
       * 变成空占位。护栏见 `test/hooks-order.test.mjs`。
       *
       * 值是 accountKey（不是 siteId）：一次只确认一个账户，且**必须是正在点的那一行**——
       * 用 siteId 会让同站点的两个账户共用一份确认态。
       */
      const [confirming, setConfirming] = React.useState(null);
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
      /**
       * 删除该账户的数据（0.19.59，用户 2026-10-03 指令）。
       *
       * 用户原话：「每个设置界面的网站分页，每个账户除了『更换账户 检测 导入本机登录态
       * 独立窗口』外增加一个按钮：『删除』作用是：删除这个账户数据」。
       *
       * 为什么是**服务端一条动作**而不是前端拼几个请求：删什么、删到什么程度只有
       * 服务端说得清（槽目录由 `accounts.slotProfileDir` 决定，会话记录的键形状由
       * 驱动决定）。面板自己拼，迟早与真正落盘的那一份分叉——本项目记过多次。
       *
       * 为什么确认放在**行内**（`confirming` 状态 + 两颗按钮）而不是 `window.confirm`：
       * 本文件已记明 alert/confirm 是**阻塞式**浏览器模态（弹出期间主线程停住，
       * 5s 轮询的下一拍与所有在途 fetch 回调都被卡住），而官方 harness 的反馈形态
       * 一律是页面内联文案。因此第一次点「删除」只把按钮换成「确认删除 / 取消」，
       * 第二次点「确认删除」才真的删——误点代价从「删掉一个账号」降到「多点一下」。
       *
       * 顺序上是**先删数据、再摘槽位**（服务端保证）：数据删不掉时槽位保持原样、
       * 本行仍在，于是那条失败原因**看得见**；反过来先摘槽位，行会消失，用户就
       * 再也读不到「为什么没删干净」。
       */
      async function removeAccount(s) {
        setConfirming(null);
        setBusySite(s.accountKey); setResult(s.accountKey, null);
        const r = await apiSoft('account-remove', { ...siteSlot(s.accountKey) }, 60000);
        if (!r.ok) setResult(s.accountKey, { ok: false, text: '删除失败：' + r.error });
        else {
          // 被删掉的账户如果正是「本会话选中的那个」，选中态必须一起清掉——
          // 留着会把「已选中」指向一个已经不存在的槽（下一次连接就报未知账户）。
          if (picked === s.accountKey) setPicked(null);
          setResult(s.accountKey, {
            ok: true,
            text: r.data?.slotRemoved
              ? '已删除该账户：槽设置、本机 profile 与会话记录都已清掉'
              : '已清空该账户的本机数据（默认槽保留，不会从列表里消失）',
          });
        }
        setBusySite(null);
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
                // 真实头像（0.19.37）：抓到了就画真实头像，抓不到回落站点矢量标记。
                // 跨域 CDN 可能拒热链 ⇒ onError 时藏掉 img，露出后面的标记；
                // **不造假**：读不到就不用槽名冒充头像（与右栏账户下拉同一纪律）。
                //
                // 0.19.61 修**真缺陷**（用户 2026-10-04：「全部网站都是网站矢量」）：
                // 旧实现的**顺序反了**——矢量标记写在 `<img>` 之前没问题，但
                // `.hwb-avatar-img` 缺 `position:absolute`（目录页那条有、这里没有），
                // 于是 img 与 glyph 是**并排的两个 flex 子项**挤在 28px 按钮里：
                // 头像被压到一边/溢出（`.hwb-avatar` 无 overflow:hidden），
                // 看起来就是「头像没渲染、只剩矢量」。现在与目录页**同一套几何**：
                // 标记先画，头像绝对定位铺满圆框、盖在上面，失败时藏掉即露出标记。
                h('span', { className: 'hwb-avatar-glyph', 'aria-hidden': 'true' },
                  h(SiteGlyph, { sid: s.siteId, size: 12 })),
                s.avatarUrl
                  ? h('img', {
                    className: 'hwb-avatar-img', src: s.avatarUrl, alt: '', loading: 'lazy',
                    onError: (e) => { try { e.currentTarget.style.display = 'none'; } catch { /* 忽略 */ } },
                  })
                  : null),
              // 昵称：**抓到的真实昵称优先**，抓不到才回落槽名（displayName）。
              // 用户原话：「尝试拉取账户名称和图像，替代现在的默认头像和非圆框」。
              // 回落时仍是 displayName，绝不把槽名伪装成真实昵称。
              h('span', { className: 'hwb-site-name' }, s.accountName || s.displayName)),
            // 0.19.37：原来这里的「已登录 / 未登录 / 待检查」占位框已删除。
            //
            // 用户原话：「『已登录』占位框改为右上角和『智谱清言 的账户与登录』
            // 同行合适位置的单独绿色圆点状态指示……只需要通过颜色圆点显示」。
            // 于是状态从「每行一个带文字的框」收敛成**标题行右上角的一个圆点**，
            // 且判据是跨该站点全部账户的聚合（见 siteHealthOf）。
            // 登录依据（basisText）随之少了一个落点——它仍可从「检测」按钮的结果行读到。
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
              }, '独立窗口'),
              // 「删除」（0.19.59，用户 2026-10-03 指令）：删掉这个账户在本机的
              // 全部数据。它是**破坏性**动作，因此排在四个常规动作之后（最右侧、
              // 离手最远），并且要**两次点击**才生效（见 removeAccount 的注释：
              // 确认走行内两颗按钮，不用阻塞式 window.confirm）。
              confirming === s.accountKey
                ? [
                  h('button', {
                    key: 'confirm-del', className: 'danger', disabled: busySite !== null,
                    title: '确认删除该账户在本机的登录态、网页会话记录与身份缓存（不可撤销）',
                    onClick: () => removeAccount(s),
                  }, '确认删除'),
                  h('button', {
                    key: 'cancel-del', disabled: busySite !== null,
                    onClick: () => setConfirming(null),
                  }, '取消'),
                ]
                : h('button', {
                  className: 'danger', disabled: busySite !== null,
                  title: '删除该账户在本机的登录态、网页会话记录与身份缓存（不可撤销）',
                  onClick: () => setConfirming(s.accountKey),
                }, '删除'))),
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
    // ══ 并发会话（0.19.55）—— 每列一条**真官方会话** ═══════════════════════════
    //
    // ## 用户要的是什么（原话，逐字）
    //
    //   「并发必须能够保留真实会话！能够查看！」
    //   「然后是中间区域，将原本在会话中的『并发』删除，改为对齐新会话的『对话』
    //     和『轨迹』--变为『并发对话』和『并发轨迹』」
    //   「我要一摸一样，确保每一列都有完整的官方会话所有能力」
    //
    // 旧实现（0.17.3 起，直到 0.19.31 的 `MultiModelCompareView`）每一列是**自绘的
    // 假会话**：消息只活在 React state 里、回复靠 `/__webcode/chat` 把网页正文抄回来、
    // 对话框是复刻出来的 composer。用户要的是**真会话**：真 sessionId、真 agent loop、
    // 真工具执行、官方的消息渲染 / composer / 模型选择 / 权限 / 轨迹。所以本轮不再
    // 抄外观，而是**把官方自己的会话体渲染进来**。
    //
    // ## 官方给的那条路（实读官方 0.2.0-rc.2 源码，不是推测）
    //
    // 官方 `ui-subagent` 的 SidebarChatTab 已经做了同一件事——把**任意一条真会话**
    // 渲染进一个自有的面板。它分三步：先 `sessions.retain(...)` 拿到真会话引用，
    // 再用官方座位 `SessionProvider` 显式绑定会话作用域，最后渲染官方会话体。
    // 其中「官方会话体」= 官方 `conversation.content` **factory**，可以带一个局部槽
    // 覆盖，指定用哪个视图（对话 / 轨迹）来呈现。
    //
    // ## 四条硬约束（每一条都决定了一处写法，都有源码位置）
    //
    // ① **子槽必须是自有名字。** `SlotCore.register` 对同一槽名只允许一个声明者
    //   （`dsh-client-ui-slots/lib/index.js:193`：`slot "X" is already declared`），而
    //   `conversation.session` 已由官方 `conversation.content` factory 声明
    //   （`dsh-client-ui-conversation/lib/client.js:18151`）。所以我们不能在自己的
    //   注册里声明它，只能声明**自己的** session 作用域子槽；而 `SessionProvider` 与
    //   `renderSlot` 这两件东西，只有在「条目声明了非 root 子槽」时才发给条目
    //   （`dsh-client-ui-renderer/lib/client.js:732-739`）——不声明就两样都拿不到。
    //
    // ② **不能在 `conversation.view` 里做。** `renderFactorySlot` 会检查渲染祖先
    //   （`dsh-client-ui-renderer/lib/client.js:1049`：`recursive render of factory 'X'`）。
    //   会话内的视图本来就长在 `conversation.content` 的子树里，在那里再渲染一次
    //   同名 factory 会**当场抛错**。因此「每列一个真官方会话」只能落在官方会话之外
    //   的中央面板上——这正是用户那句「将原本在会话中的『并发』删除」的技术原因，
    //   两条要求在这一点上其实是同一件事。
    //
    // ③ **引用必须成对释放。** `sessions.retain()` 返回的 `SessionReference` 是引用
    //   计数（`SessionRetainInfo.retainedBy`），不释放会让会话作用域与历史永远驻留。
    //   列被移除、面板被卸载都要 release，见 `releaseColumn` 与挂载 effect 的清理。
    //
    // ④ **`SessionProvider` 的 `session` 只认真引用。** 官方 `ui-session` 的
    //   `bindingSource` 会校验引用属于当前 Controller 世代（拿 sessionId 字符串或
    //   别的替身会抛 `Session reference is not active in this Controller`）。所以每列
    //   保存的是 retain 出来的引用对象本身，而不是 id。

    /**
     * 左栏入口 id / 中央面板 key / 列正文子槽名（三处必须成对：官方契约原文
     * 「Each list id addresses the matching main panel」）。
     *
     * ⚠ 三个常量放在**工厂作用域**，不放注册它们的那段 `apply()` 里：`ConcurrentPanel`
     * 与 `ConcurrentPanelIcon` 定义在 `apply()` **之外**，面板挂载 effect 要用面板 id
     * （`createPanelGuard(props.layout, CONCURRENT_PANEL_ID, …)`）。0.19.62 把它声明在
     * `apply()` 内 ⇒ 真机每次挂载都是 `ReferenceError: CONCURRENT_PANEL_ID is not defined`，
     * 被 effect 的 try/catch 吞成一句 warn ⇒ **守卫从来没生效过**——这正是用户 2026-10-05
     * 报「还是会切回到官方工作区」的直接原因。与 `warn` 同族：**跨作用域接线断裂**。
     */
    const CONCURRENT_PANEL_ID = 'webcode-concurrent-panel';
    const CONCURRENT_COLUMN_SLOT = 'webcode-concurrent.column';

    /** 一组的列数上限。与旧实现一致：用户要的是「多列并排」，不是无限列。 */
    const CONCURRENT_MAX_COLS = 4;

    /**
     * 新建一组时的默认列数。
     *
     * 用户 2026-10-02 原话：「明显的一行是3个重叠标签页形状一行区分与普通会话」
     * —— 三列是并发的默认形态，所以新建一组默认开三条真会话（用户可再加到 4 列）。
     */
    const CONCURRENT_DEFAULT_COLS = 3;

    /**
     * 会话组的**浏览器侧**存储前缀。
     *
     * 为什么放浏览器本地而不是桥端：这里存的是「这一组面板由哪几条会话组成」，
     * 是**本浏览器的面板布局**，不是任何服务端事实。会话本身早就是 Host 上的真会话
     * （`ctx.sessions.create()` 落库、进官方会话清单、可单独打开与重开），所以这份
     * 存储丢了也只是「面板要重新建组」，**不会丢任何对话内容**——这正是它可以放在
     * 本地的前提。桥端那边反而没有可存的地方：`create` 返回的 id 只在面板知道。
     */
    const CONCURRENT_STORE_PREFIX = 'dsh-webcode-bridge.concurrent.';

    // 「过去的并发会话」＝多组留痕（用户 2026-10-06：「否则怎么找回已过去的并发会话」）。
    // 存**组**（{id, at, ids}）：主入口每次新建一组；历史组由左栏目录找回——每一组注册
    // 一条 `sidebar.panellist` 行 + 一个**同名 main key**（官方契约原文
    //「Each list id addresses the matching main panel」）。
    const CONCURRENT_GROUPS_KEY = CONCURRENT_STORE_PREFIX + 'groups';
    const CONCURRENT_MAX_GROUPS = 12;
    const CONCURRENT_GROUP_PREFIX = 'webcode-concurrent-group-';

    /** 读全部历史组；任何异常回空数组（降级不是崩溃）。 */
    function readConcurrentGroups() {
      try {
        const arr = JSON.parse(window.localStorage.getItem(CONCURRENT_GROUPS_KEY) || '[]');
        return Array.isArray(arr) ? arr.filter(g => g && typeof g.id === 'string' && Array.isArray(g.ids) && g.ids.length) : [];
      } catch (e) { return []; }
    }

    /** 新建一组留痕，返回组 id（写不进去返回 null：降级为「这次找不回」）。 */
    function createConcurrentGroup(ids) {
      try {
        const list = (ids || []).filter(id => typeof id === 'string' && id);
        if (!list.length) return null;
        const rest = readConcurrentGroups().filter(g => g.ids.join(',') !== list.join(','));
        const group = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), ids: list };
        rest.unshift(group);
        window.localStorage.setItem(CONCURRENT_GROUPS_KEY, JSON.stringify(rest.slice(0, CONCURRENT_MAX_GROUPS)));
        return group.id;
      } catch (e) { return null; }
    }

    /** 往已有组追加一条会话（「+ 加一列」）；组不存在就新建一组。 */
    function appendToConcurrentGroup(groupId, sessionId) {
      try {
        const all = readConcurrentGroups();
        const hit = groupId ? all.find(g => g.id === groupId) : null;
        if (!hit) return createConcurrentGroup([sessionId]);
        if (!hit.ids.includes(sessionId)) hit.ids = hit.ids.concat(sessionId);
        window.localStorage.setItem(CONCURRENT_GROUPS_KEY, JSON.stringify(all));
        return hit.id;
      } catch (e) { return null; }
    }

    /**
     * 写回一组真会话 id。失败静默。
     *
     * 0.19.65 起**只写不读**：用户第 7/8 条要求「点并发会话 = 点新会话」，每次打开都新建
     * 一组，所以挂载不再恢复旧组。留着写是因为它仍是这条组的唯一留痕（排障时能核对
     * 「上一次那一组是哪几条会话」），也是将来做「切回历史组」时的现成数据源。
     */
    function writeConcurrentGroup(key, ids) {
      try {
        window.localStorage.setItem(CONCURRENT_STORE_PREFIX + key, JSON.stringify(ids || []));
      } catch (e) { /* 存储不可用：降级为「下次重新建组」 */ }
    }

    /**
     * 官方 `conversation.content` factory 的 `views` 局部槽替身：只渲染**指定**视图。
     *
     * 官方默认那一个（`ConversationSessionView`）做的是 `renderSlot('conversation.session', {})`
     * —— 把「用哪个视图」交给会话自己记着的选择。并发面板不行：同一组会话在
     * 「并发对话」里要看对话、在「并发轨迹」里要看轨迹，是两个并列面板，不共享一个选择。
     * 所以这里显式钉死视图 id（官方 id 就是 `chat` 与 `trajectory`）。
     */
    // 0.19.65：`ChatOnlySessionView` / `TrajectoryOnlySessionView` 两个「钉死视图」的替身
    // **已删**——它们正是「面板级页签」的实现基础，用户 2026-10-06 要求移除页签、按官方
    // 默认（会话自己记住的视图）渲染。

    /**
     * 一列 = 一条真官方会话（用户：「确保每一列都有完整的官方会话所有能力」）。
     *
     * 0.19.65（用户 2026-10-06）：「**移除顶部的并发对话和并发轨迹**——反正都是界面内自行切换；
     * 每列直接贯通一列」。⇒ 不再覆盖 `conversation.content` 的 `views` 局部槽，让官方按它自己
     * 的默认路径走：`renderSlot("conversation.session", {})`（`dsh-client-ui-conversation:16202`），
     * 也就是**这条会话自己记住的那个视图**（对话 / 轨迹由官方 `conversation.view` 那两个条目提供，
     * 注册处 `ui-chat:12390` / `ui-trajectory:8736`，渲染点 `:16415`）。
     * 我们因此不再需要 `hwbView` / `data-concurrent-view` / 面板级页签——少一层自绘，多一分
     * 「与官方同一份渲染」。
     *
     * @param {Object} props 官方 session 作用域标准 props
     */
    function ConcurrentColumn(props) {
      const renderFactorySlot = props.renderFactorySlot;
      // 三个 hook 都可能缺席（旧宿主 / 测试桩）。缺席时用空实现而不是条件调用——
      // 条件调用 hook 正是本文件上方 SiteAccounts 踩过的那条红线。
      const useSession = typeof props.useSession === 'function' ? props.useSession : noSessions;
      const useConversation = typeof props.useConversation === 'function' ? props.useConversation : noSessions;
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : noSessions;
      const sessionId = sessionIdOf(props.sessionId);
      const session = useSession(s => s) || {};
      const conversation = useConversation(s => s) || {};
      const summaryBlank = useSessions(s => (s && sessionId ? s.byId[sessionId]?.blank : undefined));
      const activeTargets = conversation.activeTargets;
      const shellPhase = (activeTargets && activeTargets.size > 0)
        || (!session.blank && !session.awaitingFirstTurn) || session.running
        ? 'active'
        : session.promptAttempted ? 'engaging' : 'blank';
      const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true;
      const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true);
      return h('div', { className: 'hwb-concurrent-body' },
        renderFactorySlot('conversation.content', {
          variant: 'embedded',
          phase: settling ? 'settling' : hero ? 'hero' : 'active',
          hero,
        }));
    }

    /**
     * 会话组正文：N 列 = N 条真会话，各自独立（一条在跑不影响其余列）。
     *
     * 列的**宽度与平移**算法与旧实现逐字相同：它验证过，而且是纯布局，与「列里装什么」
     * 无关。宽度上下限全部由官方常量推出，不自己编数（见下方各处注释）。
     *
     * @param {Object} props 面板座位标准 props + `{ sessions, slotName, groupKey, view }`
     */
    function ConcurrentColumns(props) {
      const sessions = props.sessions;
      const SessionProvider = props.SessionProvider;
      const renderSlot = props.renderSlot;
      const slotName = props.slotName;
      const groupKey = props.groupKey || 'panel';
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : noSessions;
      const useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : noSessions;
      // 只取 byId 这个**稳定引用**（store 自己的对象），不要在选择器里造新对象：
      // 每次返回新对象会让 useSyncExternalStore 判定「变了」，进而无限重渲染。
      const byId = useSessions(s => s && s.byId) || {};
      // 当前会话 id 与工作区清单：createColumns 给新列绑 workspaceId 用（见其注释）。
      // current 在官方快照里是「主视图选中的会话 id」；无会话（面板是唯一焦点）时为空。
      const currentSessionId = useSessions(s => (s && s.current) || null);
      const workspaces = useWorkspaces(s => s) || null;

      /**
       * 新列要绑的工作区 id（依次回落：当前会话的工作区 → 最近更新的工作区 → 不绑）。
       * 全部按官方字段语义取（workspace.sessionIds / workspaceId / updatedAt），不猜形状；
       * 快照未就绪（phase 缺失/非 ready）一律按「取不到」处理，交给守卫兜底。
       */
      const currentWorkspaceId = () => {
        try {
          const items = (workspaces && Array.isArray(workspaces.items)) ? workspaces.items : [];
          if (items.length) {
            const ofCurrent = currentSessionId
              ? items.find(w => Array.isArray(w.sessionIds) && w.sessionIds.includes(currentSessionId))
              : null;
            if (ofCurrent) return ofCurrent.workspaceId;
            let recent = null;
            for (const w of items) {
              if (!w || typeof w.workspaceId !== 'string' || !w.workspaceId) continue;
              if (!recent || (Number(w.updatedAt) || 0) > (Number(recent.updatedAt) || 0)) recent = w;
            }
            if (recent) return recent.workspaceId;
          }
        } catch (e) { /* 快照形状漂移：按「取不到」处理，不建列失败 */ }
        return null;
      };

      // ★ 唯一的列状态：一个数组。加列 = 展开，删列 = filter。
      const [cols, setCols] = React.useState([]);
      const [ready, setReady] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      // 「开工指令」面板（0.19.64）：复制成功与否的提示 + 剪贴板不可用时摊开的文本。
      const [brief, setBrief] = React.useState('');
      const [briefCopied, setBriefCopied] = React.useState(false);
      // sessionId → SessionReference。用 ref 而不是 state：引用对象不是渲染数据，
      // 它只在「建列 / 删列 / 卸载」三个时刻变化，而每次变化都伴随一次 setCols。
      const refsRef = React.useRef({});
      const aliveRef = React.useRef(true);
      const viewRef = React.useRef(null);
      // 打开面板只自动建一次组（0.19.65，用户第 7/8 条：点「并发会话」= 点「新会话」）。
      const createdRef = React.useRef(false);
      // 这一列组在「历史组」里的 id（无 hwbGroup = 主入口新建的组）。
      const groupRef = React.useRef(props.hwbGroup ? props.hwbGroup.id : null);

      // ── 挂载：把上次的组恢复回来；卸载：把所有引用成对释放 ────────────────────
      React.useEffect(() => {
        aliveRef.current = true;
        const refs = refsRef.current;
        if (!sessions || typeof sessions.retain !== 'function') {
          // 旧宿主没有 sessions 服务：如实说明不可用，而不是画一个点了没反应的按钮。
          setError('宿主没有提供 sessions 服务，并发会话不可用');
          setReady(true);
          return undefined;
        }
        // 主入口（无 hwbGroup）：每次打开都新建一组（用户第 7/8 条）。
        // 历史组入口（有 hwbGroup）：把那一组的会话重新 retain 出来 ⇒ **找回过去的并发会话**。
        const group = props.hwbGroup;
        if (group && Array.isArray(group.ids)) {
          const restored = [];
          for (const id of group.ids) {
            try {
              refs[id] = sessions.retain(id, { source: 'webcodeConcurrent' });
              restored.push({ key: 'c:' + id, sessionId: id });
            } catch (e) { delete refs[id]; }
          }
          if (aliveRef.current) { setCols(restored); setReady(true); }
        } else {
          setCols([]);
          setReady(true);
        }
        return () => {
          aliveRef.current = false;
          for (const id of Object.keys(refs)) {
            try { refs[id].release(); } catch (e) { /* 释放失败不该阻断卸载 */ }
            delete refs[id];
          }
        };
      }, []);

      // 打开面板就建组（等挂载 effect 把 ready 置真之后再动手，避免与恢复逻辑抢时序）。
      // 历史组面板（hwbGroup）不建：它的会话在上面那段恢复里已经 retain 好了。
      React.useEffect(() => {
        if (!ready || createdRef.current || props.hwbGroup) return;
        createdRef.current = true;
        createColumns(CONCURRENT_DEFAULT_COLS);
      }, [ready]);

      // 组变了就落盘。放在 effect 而不是每个动作里：只有一处写法，不会漏。
      React.useEffect(() => {
        if (!ready) return;
        writeConcurrentGroup(groupKey, cols.map(c => c.sessionId));
      }, [ready, cols, groupKey]);

      // 当前中间区宽度（左右栏之间）。视图根节点的宽度**就是**中间区宽度。
      const [viewportW, setViewportW] = React.useState(
        () => (typeof window !== 'undefined' ? window.innerWidth : 1440),
      );
      React.useEffect(() => {
        const el = viewRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const publish = () => {
          const w = el.getBoundingClientRect().width;
          if (w > 0) setViewportW(Math.round(w));
        };
        const ro = new ResizeObserver(publish);
        ro.observe(el);
        publish();
        return () => { ro.disconnect(); };
      }, []);

      // ── 列宽：上下限全部从官方常量推 ────────────────────────────────────────
      //
      // 下限 = 左右栏都拉到**最宽**时中间区剩下的宽度（= 中间区最窄）；
      // 上限 = 官方会话的完整最宽（内容上限 920 + 卡片余量 32），且不超过中间区最宽。
      // 默认 = 官方对话的默认内容宽公式（clamp(680, 列宽×0.64, 920)），再夹进上下限。
      const SIDEBAR_MAX = 420;
      const SIDEBAR_MIN = 264;
      const RIGHTBAR_MIN = 300;
      const RIGHTBAR_MAX_RATIO = 0.7;
      const OFFICIAL_CONTENT_MAX = 920;
      const OFFICIAL_CARD_PAD = 32;
      const COL_GAP = 16;
      const colWidthMin = Math.max(
        320,
        viewportW - SIDEBAR_MAX - Math.round(viewportW * RIGHTBAR_MAX_RATIO),
      );
      const colWidthMax = Math.min(
        OFFICIAL_CONTENT_MAX + OFFICIAL_CARD_PAD,
        Math.max(colWidthMin, viewportW - SIDEBAR_MIN - RIGHTBAR_MIN),
      );
      const officialDefault = Math.min(OFFICIAL_CONTENT_MAX, Math.max(680, Math.round(viewportW * 0.64)));
      const colWidth = Math.round(Math.min(colWidthMax, Math.max(colWidthMin, officialDefault)));
      const visible = Math.max(1, Math.floor((viewportW + COL_GAP) / (colWidth + COL_GAP)));

      // 平移量永远是**整列宽 + 列间距**，所以永远不会停在半列上（用户要的对齐语义）。
      const [firstCol, setFirstCol] = React.useState(0);
      const maxFirst = Math.max(0, cols.length - visible);
      const first = Math.min(firstCol, maxFirst);
      const canPanLeft = first > 0;
      const canPanRight = first < maxFirst;
      React.useEffect(() => {
        setFirstCol(prev => Math.min(prev, Math.max(0, cols.length - visible)));
      }, [cols.length, visible]);
      const panBy = (delta) => setFirstCol(prev => Math.min(Math.max(0, prev + delta), maxFirst));

      /**
       * 新建一列（或首次建组）。每条列都是一条 Host 上的真会话。
       *
       * ## 为什么必须带 `workspaceId`（0.19.62，「点击选择范围就跳走」的治本半边）
       *
       * `sessions.create({})` 造出的会话没有绑定工作区 ⇒ 官方 conversation 把它渲染成
       * 「虚线选择工作区」的 composer 卡 ⇒ 用户一点就走到
       * `selectWorkspace → uiWorkspace.openWorkspace → replaceMain('reveal') →
       * selectPanel(null)`，中央区整体跳回单个会话（机理见 createPanelGuard 注释）。
       * 官方自己建会话也走这条：`reuseOrCreateBlank` 用
       * `sessions.create({ workspaceId: workspace.workspaceId })`（ui-workspace 源码）。
       *
       * 工作区取值（依次回落，全部官方语义，缺工作区服务时不绑、保持旧行为）：
       *   ① **当前会话所在的工作区**——与主视图一致，最符合「就在这里开几列」的直觉；
       *   ② **最近更新的工作区**——官方 `startSession` 的回落就是 recentWorkspace；
       *   ③ 都取不到（极端：宿主还没就绪）才允许不绑，此时守卫（createPanelGuard）
       *      兜住「选择工作区」跳走的那一下。
       */
      const createColumns = (n) => {
        if (!sessions || typeof sessions.create !== 'function' || busy) return;
        setBusy(true);
        setError('');
        const want = Math.max(1, Math.min(Number(n) || 1, CONCURRENT_MAX_COLS));
        const workspaceId = currentWorkspaceId();
        // 0.19.62 真机韧性：带 workspaceId 的 create 若被宿主拒（工作区参数形状漂移、
        // workspace 未连接、writer-held……），**回落到不绑**重试一次——最坏退回
        // 0.19.61 的行为（有守卫兜住「选择工作区」那一下），而不是整组建不出来。
        const make = () => (workspaceId
          ? sessions.create({ workspaceId }).catch(() => sessions.create({}))
          : sessions.create({}));
        Promise.all(Array.from({ length: want }, make))
          .then((ids) => {
            if (!aliveRef.current) return;
            const added = [];
            for (const id of ids) {
              try {
                refsRef.current[id] = sessions.retain(id, { source: 'webcodeConcurrent' });
                added.push({ key: 'c:' + id, sessionId: id });
              } catch (e) { /* 这一列拿不到引用：跳过，而不是留一条永远打不开的列 */ }
            }
            if (!added.length) { setError('新建会话成功但拿不到会话引用'); return; }
            // 留痕 + 刷左栏目录（0.19.65）：这样「过去的并发会话」才有地方找回来。
            try {
              const fresh = added.map(a => a.sessionId);
              if (groupRef.current) { for (const id of fresh) appendToConcurrentGroup(groupRef.current, id); }
              else { groupRef.current = createConcurrentGroup(fresh); }
              if (typeof props.hwbSyncGroups === 'function') props.hwbSyncGroups();
            } catch (e) { warn('concurrent group record', e); }
            setCols(prev => [...prev, ...added].slice(0, CONCURRENT_MAX_COLS));
          })
          .catch((err) => {
            if (aliveRef.current) setError('新建会话失败：' + String(err?.message || err));
          })
          .finally(() => { if (aliveRef.current) setBusy(false); });
      };

      /**
       * 把一列移出面板。
       *
       * **只移出面板，不删会话**：用户说「并发必须能够保留真实会话」——那条会话在 Host
       * 上照样活着、照样在左侧清单里，可以单独打开继续。删它会违背这条要求。
       * 但引用必须释放：留着会让这条会话的作用域与历史永远驻留。
       */
      const releaseColumn = (key) => {
        const col = cols.find(c => c.key === key);
        if (!col) return;
        try { if (refsRef.current[col.sessionId]) refsRef.current[col.sessionId].release(); } catch (e) { /* 已释放 */ }
        delete refsRef.current[col.sessionId];
        setCols(prev => prev.filter(c => c.key !== key));
      };

      const titleOf = (id) => {
        const row = byId[id];
        return (row && (row.displayTitle || row.title)) || String(id || '').slice(0, 12);
      };

      /**
       * 一列的「独立工作区」开工/收尾指令（用户 2026-10-05 的想法：git 分支 + 最后轮转合并）。
       *
       * ## 为什么这件事必须由用户/列里的 agent 执行，而不是本插件代跑
       * 官方沙箱是**按会话**解析工作区根（`dsh-sandbox-policy`：「One primary workspace root
       * per session … policy resolves `SessionHeader.cwd`」，README §147），而官方 Agent Team
       * 明确写着「**One process and one shared checkout** — members share cwd …; this package
       * provides no worktree, remote member, merge, or filesystem lock」，并把 worktree 隔离列为
       * **未承诺方向**。⇒ 官方流程里**没有** worktree 设施：并发列若共用同一个检出，文件写入
       * 互相可见（只有「写作用域」这种咨询性约定 + Lead 收尾复核）。
       *
       * 所以本插件能做的最实在的一件事，就是把这套**用户自己的隔离流程**变成一键可复制：
       * 每列一个分支 + 一个 git worktree，收尾时合并回主线（「最后旋转」）。插件不代跑 git
       *（客户端没有 fs/子进程），也不假装官方有这个能力。
       *
       * @param {{sessionId: string}} col 列（真会话）
       * @param {number} index 列序号（从 0 起）
       * @returns {string} 可直接粘进该列会话的多行指令
       */
      const columnBrief = (col, index) => {
        const n = index + 1;
        const branch = 'hwb/col-' + n;
        const wt = '.hwb/worktrees/col-' + n;
        return [
          '这一列（会话 ' + col.sessionId + '）请在**自己的** git 分支与工作区里干活，不要动主检出：',
          '',
          '  git worktree add -b ' + branch + ' ' + wt + ' HEAD',
          '  cd ' + wt,
          '',
          '收尾（全部列跑完后，由主线那一列或你本人执行「轮转」）：',
          '',
          '  git -C <主检出> merge --no-ff ' + branch,
          '',
          '为什么这样：官方 DSH 的沙箱按**会话**解析工作区根（SessionHeader.cwd），并发列共用同一'
            + '检出时文件写入互相可见；官方 Agent Team 同样是 one shared checkout、不带 worktree。'
            + '隔离这一步因此落在分支/工作区上，本插件只负责把它变成可复制的指令。',
        ].join('\n');
      };

      /** 复制一列的开工指令；剪贴板不可用时把文本摊在面板里（用户自己选中复制）。 */
      const copyColumnBrief = (col, index) => {
        let text = '';
        try { text = columnBrief(col, index); } catch (e) { text = ''; }
        if (!text) return;
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
              () => { setBrief(text); setBriefCopied(true); },
              () => { setBrief(text); setBriefCopied(false); },
            );
            return;
          }
        } catch (e) { /* 剪贴板被策略挡住：走下面的摊开路径 */ }
        setBrief(text);
        setBriefCopied(false);
      };

      if (!ready) return h('div', { className: 'hwb-concurrent' }, h('p', { className: 'hwb-hint' }, '正在读取并发会话…'));

      return h('div', {
        className: 'hwb-concurrent',
        ref: viewRef,
        // 列宽是一个**算出来的像素值**，交给 CSS 用（三列同一个值 ⇒ 宽度同步）。
        style: { '--hwb-col-width': colWidth + 'px' },
      },
        // 0.19.65（用户第 3 条）：**删掉顶部那一行工具条**（「N 列 / + 加一列」不再占高度，
        // 会话框因此能完整上下铺满），「+ 加一列」改成右上角**悬浮置顶**的圆钮。
        h('button', {
          type: 'button',
          className: 'hwb-concurrent-fab',
          disabled: busy || cols.length >= CONCURRENT_MAX_COLS,
          title: cols.length >= CONCURRENT_MAX_COLS
            ? '最多 ' + CONCURRENT_MAX_COLS + ' 列'
            : (cols.length ? '再加一条真会话' : '新建一组（' + CONCURRENT_DEFAULT_COLS + ' 条真会话）'),
          onClick: () => createColumns(cols.length === 0 ? CONCURRENT_DEFAULT_COLS : 1),
        }, busy ? '…' : (cols.length === 0 ? '新建并发会话' : '+ 加一列')),
        error && h('p', { className: 'hwb-hint bad' }, error),
        brief && h('div', { className: 'hwb-concurrent-brief' },
          h('div', { className: 'hwb-concurrent-brief-head' },
            h('span', null, briefCopied
              ? '已复制到剪贴板：粘进对应列的输入框即可（收尾时按末尾那条合并回主线）'
              : '剪贴板不可用：请手动选中下面的文本复制'),
            h('button', {
              type: 'button', className: 'hwb-concurrent-mini',
              onClick: () => { setBrief(''); setBriefCopied(false); },
            }, '收起')),
          h('pre', { className: 'hwb-concurrent-brief-body' }, brief)),
        cols.length === 0 && h('p', { className: 'hwb-hint' },
          '每一列都是一条真的官方会话：各自有独立 sessionId，跑真实的 agent loop，'
          + '带官方原生的消息、模型选择与输入框。新建之后它们也会出现在左侧会话清单里，'
          + '可以单独打开、继续、重开。'),
        cols.length > 0 && h('div', { className: 'hwb-concurrent-viewport' },
          cols.length > visible && h('button', {
            type: 'button', className: 'hwb-concurrent-pan left', disabled: !canPanLeft,
            title: '看左边一列', onClick: () => panBy(-1),
          }, '‹'),
          cols.length > visible && h('button', {
            type: 'button', className: 'hwb-concurrent-pan right', disabled: !canPanRight,
            title: '看右边一列', onClick: () => panBy(1),
          }, '›'),
          h('div', {
            className: 'hwb-concurrent-columns',
            'data-cols': String(cols.length),
            style: { transform: 'translateX(' + (-first * (colWidth + COL_GAP)) + 'px)' },
          },
          // 0.19.65（用户第 4 条）：**列与列之间只留左右间隔**（16px，与平移步长同值），
          // 间隔本身是一个真元素——鼠标移上去才画出 1px 竖线，平时完全隐藏。
          // 「上下不用框」：列不画边框、不画分隔线，列头平时隐形（既有行为）。
          cols.reduce((acc, col, i) => {
            if (i > 0) {
              acc.push(h('div', { key: 'gap:' + col.key, className: 'hwb-concurrent-gap', 'aria-hidden': 'true' },
                h('span', { className: 'hwb-concurrent-gap-line' })));
            }
            acc.push(h('div', { key: col.key, className: 'hwb-concurrent-col' },
              h('div', { className: 'hwb-concurrent-col-head' },
                h('span', { className: 'hwb-concurrent-col-title', title: col.sessionId }, titleOf(col.sessionId)),
                h('button', {
                  type: 'button', className: 'hwb-concurrent-mini',
                  title: '把这一条会话交回官方单会话视图打开（那里才有官方的标题栏/标准模式/后台任务/团队）',
                  onClick: () => {
                    try {
                      // 先放行（见守卫里的 allowLeave），再交回官方视图；否则守卫会把我们拉回来。
                      if (props.hwbAllowLeave) props.hwbAllowLeave();
                      if (props.hwbOpenOfficial) props.hwbOpenOfficial(col.sessionId);
                    } catch (e) { warn('open official view (column)', e); }
                  },
                }, '↗ 官方视图'),
                h('button', {
                  type: 'button', className: 'hwb-concurrent-mini',
                  title: '复制这一列的「独立工作区」指令（git worktree + 分支，收尾时合并回主线）',
                  onClick: () => copyColumnBrief(col, cols.indexOf(col)),
                }, '⧉ 开工'),
                h('button', {
                  type: 'button', className: 'hwb-concurrent-mini',
                  title: '把这一列移出面板（不删那条会话）',
                  onClick: () => releaseColumn(col.key),
                }, '✕')),
              h('div', { className: 'hwb-concurrent-col-body' },
                SessionProvider && refsRef.current[col.sessionId]
                  ? h(HwbBoundary, { label: '并发列 ' + titleOf(col.sessionId) },
                    h(SessionProvider, { session: refsRef.current[col.sessionId] },
                      renderSlot(slotName, {})))
                  : h('p', { className: 'hwb-hint' }, '这一列的会话引用不可用（换 profile 或会话被删）'))));
            return acc;
          }, []))),
      );
    }

    /**
     * 插件自己的**条目内错误边界**（0.19.62 真机排障轮）。
     *
     * 官方 SlotErrorBoundary 对崩溃条目的呈现是一只**空 div**（`data-slot-error`），
     * 控制台报错只有 F12 才看得到——真机上「哪里炸了」完全不可见，用户只能看到
     * 「一片空白」。本边界包住**列正文**（官方 SessionProvider + 官方会话体）与
     * 整个列区：任何一层渲染抛错时，显示**可读的错误文本**（含错误 message），
     * 其余部分照常——把「空白」变成「能贴给助手的诊断」。
     *
     * 为什么不用函数组件 + try/catch：渲染期异常只能被 class 边界
     *（getDerivedStateFromError / componentDidCatch）捕获，函数体 try/catch 够不着。
     *
     * 边界类**惰性构建**：`class extends React.Component` 在模块求值时就读
     * React.Component——测试桩（client-render 的 React 桩没有 Component）会让
     * **整个 bundle 求值失败**（本轮实锤：32 条用例全死在 "Class extends value
     * undefined"，组件连渲染机会都没有）。所以 React.Component 存在才建类，
     * 否则回退为透传函数组件——没有边界 = 退回官方空盒行为（与 0.19.61 相同），
     * 真机 React 必有 Component，回退分支只在桩里生效。
     */
    const HwbBoundary = (typeof React.Component === 'function')
      ? class extends React.Component {
          constructor(props) {
            super(props);
            this.state = { error: null };
          }
          static getDerivedStateFromError(error) {
            return { error };
          }
          componentDidCatch(error) {
            // 与官方边界同一口径：报进 console（F12 可查），但 UI 上不再空白。
            console.error('[webcode-bridge] ' + (this.props.label || 'panel') + ' render failed:', error);
          }
          render() {
            if (this.state.error) {
              const msg = String(this.state.error && this.state.error.message || this.state.error);
              return h('div', { className: 'hwb-hint bad', 'data-hwb-boundary': this.props.label || '' },
                h('p', { style: { margin: '0 0 6px', fontWeight: 600 } },
                  (this.props.label || '这一块') + ' 渲染失败：'),
                h('p', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, msg));
            }
            return this.props.children;
          }
        }
      : (props) => props.children;

    /**
     * 并发会话面板：两条**并列的视图**——「并发对话」与「并发轨迹」。
     *
     * 用户原话：「将原本在会话中的『并发』删除，改为对齐新会话的『对话』和『轨迹』
     * ——变为『并发对话』和『并发轨迹』」。也就是说这个面板自己就是「一个会话那样」
     * 的页面，它的两个页签与普通会话的「对话 / 轨迹」一一对齐，只是每一页里是**并排
     * 的多条真会话**。
     *
     * 为什么页签在这里自绘而不是用 `conversation.view`：见上面约束 ② ——
     * `conversation.view` 处在 `conversation.content` 的子树里，在那里渲染官方会话体
     * 会触发「recursive render of factory」当场抛错。官方会话体只能在会话之外渲染，
     * 所以这一页的页签必然是自有的（它的**内容**仍然是官方那一份）。
     */
    function ConcurrentPanel(props) {
      // 0.19.65：面板级页签（并发对话 / 并发轨迹）**已删**（用户 2026-10-06：「移除顶部的
      // 并发对话和并发轨迹——反正都是界面内自行切换」）。视图由每条会话自己记住的那一个决定，
      // 走官方默认路径（见 ConcurrentColumn）。
      // 意图守卫：机理与降级口径见 createPanelGuard 的注释。
      //
      // 0.19.62 真机教训（「并发界面打开是一片空白」）：守卫绝不能进**渲染路径**。
      // 首版在渲染期同步 `createPanelGuard(...)`——其中 `layout.panelInfo.subscribe()`
      // 一旦同步抛错（服务面形状/时机与预期不符），赋值中断、`guardRef.current` 停在
      // null，紧接着读 `.onPointerDown` 就是 TypeError ⇒ 整个 main 条目被官方
      // SlotErrorBoundary 捕获，渲染成 `<div data-slot-error>` **空 div**——这就是
      // 「面板全空、连页签都没有」的形态（官方边界对崩溃条目就是一只空盒子）。
      // 修法：渲染路径**零守卫**——根节点不挂 onPointerDown prop，挂载后用
      // `addEventListener` 在 DOM 上接 pointerdown，订阅也在同一个 effect 里，
      // 整个 effect 体 try/catch：守卫的任何失败都降级成「没有守卫」，面板照常渲染。
      // 清理走 effect 的返回函数（卸载时 removeEventListener + 注销订阅）。
      const rootRef = React.useRef(null);
      // 守卫要的**唯一**外部事实：本面板根节点（用来判「点在面板内」与推算「左栏子树」）。
      // 只放事实、不放状态——0.19.64 的第一版把会话 id 也塞进来，结果导航那一刻读到的
      // 还是上一次渲染的旧值（真机拉不回来），所以改成纯 DOM 事实。
      const factsRef = React.useRef({ rootEl: null });
      React.useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        let guard = null;
        factsRef.current.rootEl = el;
        try { guard = createPanelGuard(props.layout, CONCURRENT_PANEL_ID, factsRef.current); } catch (e) { warn('concurrent panel guard', e); }
        const onDown = () => { try { guard?.onPointerDown(); } catch (e) { /* 指纹失败不影响面板 */ } };
        try { el.addEventListener('pointerdown', onDown, true); } catch (e) { warn('concurrent panel pointerdown', e); }
        return () => {
          try { el.removeEventListener('pointerdown', onDown, true); } catch (e) { /* 同上 */ }
          try { guard?.dispose(); } catch (e) { /* 注销失败不影响卸载 */ }
        };
      }, []);
      return h('div', { className: 'hwb-concurrent-panel', ref: rootRef },
        // 列区整体再包一层边界：ConcurrentColumns 自身（create/加列等逻辑）抛错时不再把
        // 整个 main 条目炸成官方空 div，而是显示可读错误。
        h(HwbBoundary, { label: '并发会话面板' },
          h(ConcurrentColumns, {
            ...props,
            // 「本面板主动放行」的接线（0.19.65）：列头那颗「↗ 官方视图」用它告诉守卫
            // 「这一下是用户明确要离开」，否则守卫会把面板拉回来（真机实测过）。
            hwbAllowLeave: () => { try { factsRef.current.allowLeave = true; } catch (e) { /* 放行标记失败不影响面板 */ } },
          })));
    }

    /**
     * 并发面板的「选中意图守卫」（0.19.62）。
     *
     * ## 症状与官方机理（实读官方 0.2.0-rc.2 bundle 取证，不是推测）
     *
     * 用户报「一点击选择范围就会跳成单独那里对话」。链条在**官方代码**里：
     *
     *   uiWorkspace.openSession(id) / openWorkspace(...)
     *     → replaceMain(target, signal, "reveal")
     *         → ctx.layout.selectPanel(null)      ← 中央区整体切回「单个会话」
     *
     * 官方布局契约：`main` keyed 面板与 `conversation`（单个会话）互斥，
     * `selectPanel(null)` = 回到单个会话（ui-layout README：「`null` 则选中会话界面」）。
     * 官方 `ui-workspace` 的 `replaceMain` 在 `panel === "reveal"` 时就这么做。
     *
     * ## 为什么列内点击会走到那条链
     *
     * 官方 `conversation.content` factory 把「工作区选择」作为**inject 注入**的
     * `selectWorkspace` prop 交给 hero/composer（`conversation.hero.workspace` 拾取器、
     * composer 卡片的 `onRequestWorkspace`）。`sessions.create({})` 造出的会话没有绑定
     * 工作区 ⇒ 列里渲染的是「虚线选择工作区」卡 ⇒ 用户一点，`selectWorkspace →
     * openWorkspace → replaceMain → selectPanel(null)` —— 面板被换掉，列全没了。
     * 这就是「点击选择（工作区）范围就跳走」的准确机理。
     *
     * ## 修法（两件配套，缺一不可）
     *
     * ① **治本**：`createColumns` 建列时带 `workspaceId`（当前工作区），composer
     *    直接可用，「选择工作区」这一步根本不出现（见 ConcurrentColumns 的注释）。
     * ② **兜底（本函数）**：列内还有别的官方入口会导航（hero 胶囊、crumb、分支按钮），
     *    无法逐个替换——它们都是官方组件的内部行为。所以在面板根上记「最近一次
     *    pointerdown 发生在面板内」，并订阅 `ctx.layout.panelInfo`：当面板被
     *    `selectPanel(null)` 切回会话、且那次切换**紧邻一次面板内点击**（PANEL_GUARD_MS
     *    内），判定为「列内官方交互触发的跳走」，立刻 `selectPanel(面板id)` 拉回。
     *    面板外的导航（用户点左栏清单里的某条会话——官方行为，用户已确认放行）
     *    没有面板内 pointerdown，不拦截。
     *
     * `ctx.layout` 经 `ctx.reflect` 服务面公开（ui-layout 源码：`ctx.reflect.provide(
     * "layout", layout)`），`panelInfo` 是 `{ getSnapshot(): { activePanelId },
     * subscribe(listener) }` 的裸 observable——与本文件既有的「官方事实、运行时探测、
     * 缺席降级」口径一致，不硬编码宿主实现。
     */
    const PANEL_GUARD_MS = 900;

    /**
     * 「门户链」窗口（0.19.64）：面板内点一下打开浮层 → 在浮层里再点一下，两次点击之间
     * 隔多久由用户决定（挑工作区可能要看几秒）。取 15s：足够覆盖真实操作，又不至于把
     * 「几分钟前点过面板」也算进链里。
     */
    const POPUP_CHAIN_MS = 15000;

    /** @returns {boolean} ctx.layout 服务面是否可用（旧宿主/测试桩缺席时守卫整体关闭）。 */
    function panelGuardAvailable(layout) {
      return !!layout
        && typeof layout.selectPanel === 'function'
        && !!layout.panelInfo
        && typeof layout.panelInfo.getSnapshot === 'function'
        && typeof layout.panelInfo.subscribe === 'function';
    }

    /**
     * 读 `ctx.layout` 的**唯一入口**（0.19.63 真机空白根因的收口）。
     *
     * 根因修法是**声明**：`inject` 里已补 `'layout'`（cordis 对未声明服务的读取直接抛
     * `cannot get property "layout" without inject`，这一抛发生在渲染期就必然变成官方
     * 空盒）。本函数只处理「服务确实缺席」的降级——旧宿主、测试桩、或 ui-layout 未装
     * 的组合：返回 `undefined`，守卫整体关闭、面板照常渲染，符合本文件「降级不是崩溃」
     * 的一贯口径。
     *
     * 它**不是** inject 漏声明的遮羞布：那种情况由 `test/team-compare.test.mjs` 的
     * 「client.cjs 里每个 `ctx.<服务>` 读取都必须出现在 inject 列表里」判据当场变红，
     * 不靠这层 try/catch 掩盖。
     *
     * @param {Object} ctx 客户端插件上下文
     * @returns {Object|undefined} 布局服务面（缺席为 undefined）
     */
    function layoutFaceOf(ctx) {
      try { return ctx.layout; } catch (e) { return undefined; }
    }

    /**
     * 守卫的运行体（独立成函数以便护栏与复用；ConcurrentPanel 挂载 effect 里调用）。
     *
     * ## 0.19.64 真机取证：0.19.62 的判据漏掉了**门户（portal）**这一整类
     * 官方 hero 的工作区胶囊与 composer 的「工作区内修改」都把浮层开在**门户**里，其 DOM
     * **不在面板子树内**（真页面探针读数 `insidePanel=false`）。链条因此变成：
     *   点胶囊（面板内 pointerdown，记上了）→ 在浮层里选工作区（**面板外** pointerdown，
     *   记不上）→ `uiWorkspace.openWorkspace → replaceMain('reveal') → selectPanel(null)`
     * ⇒ 面板被换走，守卫因为「没有紧邻的面板内点击」而放行。用户报的
     * 「还是会切回到官方工作区」就是这一条（`probe-concurrent-live.mjs --explore` 复现，
     * 读数在 `test-mock/out/concurrent-live-*-broke-opt-*.png`）。原判据还有时间窗脆弱性：
     * 用户在浮层里挑工作区超过 900ms，连那次面板内点击也过期。
     *
     * ## 现在怎么判（按落点分三类，覆盖门户）
     * document 捕获每一次 `pointerdown`（门户里的点击也在捕获范围内）：
     *   · **左栏子树内**（点会话 / 点「新会话」/ 点工作区）⇒ 一律放行——用户 2026-10-04
     *     明确确认「左栏点会话可以跳，列内不跳就行」；
     *   · **面板子树内** ⇒ 记「面板内点击」（原语义保留，窗口 `PANEL_GUARD_MS`）；
     *   · **面板外且左栏外、但刚点过面板内**（`POPUP_CHAIN_MS` 内）⇒ 判为**面板打开的门户
     *     浮层里那一下**（工作区选择、模型选择……），同样拉回。
     *
     * 三条都**不需要知道会话 id**：本条第一版曾用「跳去的会话是不是刚新建的」当判据，但
     * React 闭包里的会话 id 在导航那一刻仍是**上一次渲染的旧值**（真机实测拉不回来），
     * 而「这一下点在哪儿」是当下的事实、不受渲染时机影响。少一个状态就少一类失败。
     *
     * 左栏子树**不靠类名认**（官方类名是哈希的，`pXSMma_*` 之类，钉不住）：入口节点自己
     * 打 `data-hwb-nav-entry`，从它往上走到**第一个不含本面板根节点**的祖先——那就是左栏
     * 那一列；点击目标在该祖先内即视为「来自左栏」。
     *
     * 边界（如实写）：左栏子树算不出来时（入口未挂载 / 面板根未知）`inSidebar` 恒假，
     * 于是「面板外 + 刚点过面板内」会被判成门户链——宁可多拉一次，也不放走用户报的那条。
     *
     * 0.19.62 真机教训：本函数内部**任何**一步都可能因官方服务面的真实形状而抛
     * （subscribe 同步抛、getSnapshot 抛……）。调用方已把整个调用包进 try/catch
     *（降级 = 没有守卫），但本函数自身也不该让「后半段可降级的失败」变成「调用方
     * 拿不到守卫体」——所以 subscribe 也单独 try/catch：订阅失败只损失守卫，
     * onPointerDown 指纹照常记录。
     *
     * @param {Object} layout ctx.layout 服务（缺席时返回 no-op，守卫关闭）
     * @param {string} panelId 本面板的 main key
     * @param {Object} [probe] 事实面（缺席时只剩「面板内点击」一条判据）
     * @param {Element} [probe.rootEl] 本面板根节点（判「点在面板内」＋算「左栏子树」）
     * @returns {{ onPointerDown: () => void, dispose: () => void }}
     *   onPointerDown 由挂载 effect 接到根节点 DOM；dispose 注销订阅与 document 监听。
     */
    function createPanelGuard(layout, panelId, probe) {
      if (!panelGuardAvailable(layout)) {
        // 降级不是崩溃：没有服务面就等于没有守卫，行为与 0.19.61 相同。
        try { if (typeof window !== 'undefined') window.__hwbPanelGuard = { available: false, reason: 'layout-face-missing' }; } catch (e) { /* 取证挂不上不影响面板 */ }
        return { onPointerDown: () => {}, dispose: () => {} };
      }
      let lastInsidePointerAt = 0;
      let lastAnyPointerAt = 0;
      let popupOwnedAt = 0;
      let sidebarRoot; // 惰性求值：本插件入口挂载后再算官方左栏子树
      let suppress = false; // 自己 selectPanel 回拉触发的订阅回调不再处理，防自激
      let unsubscribe = () => {};

      /**
       * 真机取证通道（0.19.64）：把守卫**实际看到的事实与做出的决定**挂到 window 上。
       *
       * 为什么要它：守卫的判据是「点击落点 × 官方布局变化」的时序，只在测试里断言源码形状
       * 证明不了真机上到底走了哪一支——0.19.64 的第一版判据就是「源码看着对、真机拉不回来」。
       * 有了它，探针（或用户在 F12 里）一眼能看到 `lastDecision`，不必靠猜。
       * 只写事实、不改行为，失败也不影响面板。
       */
      const forensics = { available: true, pulls: 0, lastActive: 'init', lastDecision: 'init', lastClick: 'init' };
      try { if (typeof window !== 'undefined') window.__hwbPanelGuard = forensics; } catch (e) { /* 取证挂不上不影响守卫 */ }

      /**
       * 官方左栏那一列：从本插件入口节点（`data-hwb-nav-entry`）往上走，取**最后一个不含本
       * 面板根节点**的祖先——左栏与中央区在那一层分叉，所以它正好是左栏容器。不靠官方
       * 哈希类名（`pXSMma_*` 之类钉不住）。算不出来返回 null。
       *
       * ⚠ 必须是「**最后**一个」而不是「第一个」（0.19.65 真机教训）：入口外面常套着一层
       * 0×0 的包裹 DIV，第一个不含面板根的祖先就是它 ⇒ 拿 0×0 当左栏，左栏豁免整体失效，
       * 用户点左栏单会话会被当成门户链拉回面板（报障第 6 条）。实测最后一个才是
       * `pI_x6G_sidebarCol`（280×1000 的左栏列）。
       */
      const sidebarOf = () => {
        if (sidebarRoot && sidebarRoot.isConnected !== false) return sidebarRoot;
        sidebarRoot = null;
        try {
          const entry = typeof document !== 'undefined' && document.querySelector ? document.querySelector('[data-hwb-nav-entry]') : null;
          const root = probe && probe.rootEl;
          if (entry && root) {
            // 取**最后一个**不含面板根的祖先，而不是第一个：真机实测（0.19.65）第一个常常是
            // 一个 0×0 的包裹 DIV，拿它当左栏 ⇒ 左栏豁免整体失效 ⇒ 用户点左栏单会话回不去
            // （第 6 条报障）。最后一个才是 `pI_x6G_sidebarCol`（280×1000 的左栏列）。
            let node = entry.parentElement;
            let last = null;
            for (let i = 0; node && i < 15; i += 1) {
              if (!node.contains(root)) last = node; else break;
              node = node.parentElement;
            }
            sidebarRoot = last;
            try { forensics.sidebar = last ? Math.round(last.getBoundingClientRect().width) : null; } catch (e) { forensics.sidebar = null; }
          }
        } catch (e) { sidebarRoot = null; }
        return sidebarRoot;
      };
      /** 点在面板根子树里？ */
      const inPanel = (target) => {
        const root = probe && probe.rootEl;
        try { return !!(root && target && typeof root.contains === 'function' && root.contains(target)); } catch (e) { return false; }
      };
      /** 点在官方左栏子树里？（左栏的导航一律放行：用户 2026-10-04 确认的口径） */
      const inSidebar = (target) => {
        const side = sidebarOf();
        try { return !!(side && target && typeof side.contains === 'function' && side.contains(target)); } catch (e) { return false; }
      };
      // document 捕获：**门户里的点击也算数**（0.19.64 修的就是这一类——官方工作区浮层
      // 开在 portal 里，DOM 不在面板子树内，挂在面板根上的监听永远看不到那一下）。
      const onDocumentPointerDown = (ev) => {
        try {
          // 「本面板主动放行」（0.19.65）：列头的「↗ 官方视图」是**用户明确要离开**的按钮，
          // 但它在面板内点击 ⇒ 会被判成「面板内点击/门户链」而拉回来（真机实测就是这条把
          // 官方视图挡住的）。所以放行标记优先于一切指纹。
          if (probe && probe.allowLeave) {
            probe.allowLeave = false;
            lastInsidePointerAt = 0;
            popupOwnedAt = 0;
            lastAnyPointerAt = 0;
            forensics.lastClick = 'allow-leave';
            return;
          }
          const target = ev && ev.target;
          const now = Date.now();
          if (inSidebar(target)) {
            // 左栏点击：这是一次**用户明确要离开面板**的导航（点会话 / 点「新会话」/ 点工作区），
            // 清掉链式指纹，后面不看它。
            lastInsidePointerAt = 0;
            popupOwnedAt = 0;
            lastAnyPointerAt = now;
            forensics.lastClick = 'sidebar';
            return;
          }
          if (inPanel(target)) {
            lastInsidePointerAt = now;
            lastAnyPointerAt = now;
            forensics.lastClick = 'panel';
            return;
          }
          // 面板外、左栏外：如果**刚点过面板内**，这一下极可能就是面板内那一下打开的
          // 门户浮层（工作区选择、模型选择……）。记成「链上的一次点击」。
          if (lastInsidePointerAt && now - lastInsidePointerAt <= POPUP_CHAIN_MS) popupOwnedAt = now;
          lastAnyPointerAt = now;
          forensics.lastClick = popupOwnedAt === now ? 'portal-chain' : 'outside';
        } catch (e) { /* 指纹失败不影响面板 */ }
      };
      try {
        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener('pointerdown', onDocumentPointerDown, true);
        }
      } catch (e) { warn('concurrent panel document pointerdown', e); }
      try {
        unsubscribe = layout.panelInfo.subscribe(() => {
          try {
            if (suppress) return;
            const active = layout.panelInfo.getSnapshot().activePanelId;
            if (active === panelId) return;             // 仍是本面板：无事
            if (active !== null) return;                // 别的全局面板被选中：放行（用户真实选择）
            // 面板被切回「单个会话」：两类判据（机制见函数头注释）。
            const now = Date.now();
            const insideWindow = now - lastInsidePointerAt <= PANEL_GUARD_MS;
            // 门户链：面板内那一下打开了浮层，随后在浮层里又点了一下（落点在面板外、
            // 左栏外）。两次点击之间隔多久由用户决定（挑工作区可能看几秒），所以窗口给足。
            const popupWindow = !!popupOwnedAt && now - popupOwnedAt <= POPUP_CHAIN_MS;
            forensics.lastActive = active;
            forensics.lastDecision = insideWindow ? 'pull:inside' : (popupWindow ? 'pull:popup' : 'allow');
            if (insideWindow || popupWindow) {
              forensics.pulls += 1;
              suppress = true;
              try { layout.selectPanel(panelId); } finally { suppress = false; }
            }
          } catch (e) { /* 监听回调里的任何失败不外泄：守卫坏一拍，不炸面板 */ }
        });
      } catch (e) {
        // subscribe 本身同步抛（服务面时机/形状不符）：守卫降级，指纹仍记录，
        // 至少 dispose 语义完整（回一个 no-op）。
        warn('concurrent panel guard subscribe', e);
      }
      return {
        onPointerDown: () => { lastInsidePointerAt = Date.now(); },
        dispose: () => {
          try { unsubscribe(); } catch (e) { /* 注销失败不影响卸载 */ }
          try {
            if (typeof document !== 'undefined' && document.removeEventListener) {
              document.removeEventListener('pointerdown', onDocumentPointerDown, true);
            }
          } catch (e) { /* 同上：document 监听注销失败不影响卸载 */ }
        },
      };
    }

    /**
     * 「并发会话」入口图标：**三个重叠的标签页**。
     *
     * 用户 2026-10-02 原话：「明显的一行是3个重叠标签页形状一行区分与普通会话」。
     * 这一行代表的是一个**会话组**（多条会话并排），不是一条会话，所以它不能长得像
     * 会话那一行的图标。三个错位叠放的圆角矩形是「多开、互相覆盖」最直接的说法。
     * 画法与 `TaskBoardPanelIcon` 逐项同源（viewBox 16 / stroke 1.3 / round 端点 /
     * currentColor），于是并排时光学粗细一致，明暗主题与选中态也自动继承。
     *
     * @param {{size?: number, active?: boolean}} props 官方 panel 行给的图标呈现
     */
    function ConcurrentPanelIcon(props) {
      const size = Number(props?.size) || 16;
      return h('svg', {
        // 守卫靠这个标记认出「官方左栏子树」：从本入口往上走到第一个不含面板根的祖先。
        // 不钉官方哈希类名——那种类名一次发版就换，钉了等于没钉。
        'data-hwb-nav-entry': '1',
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
      },
        h('rect', { x: 1.5, y: 4.5, width: 9, height: 9, rx: 2, opacity: 0.45 }),
        h('rect', { x: 3.75, y: 3, width: 9, height: 9, rx: 2, opacity: 0.72 }),
        h('rect', { x: 6, y: 1.5, width: 9, height: 9, rx: 2 }));
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
      // 站点级投递形态（0.19.32）。用户要求「提示词投递：给每个模型站点都做到和『发送
      // 间隔（全局）』一样的逻辑：全局设置一个，但是针对每个单独网站设置能够单独设置」。
      //
      // 键**只在站点显式设过时才存在**——「跟随全局」用**删键**表达，不写第三个值，
      // 这样「没配」与「配成跟随全局」在设置文件里就是两件不同的事（同 extraPromptBySite）。
      const [transportBySite, setTransportBySite] = React.useState({});
      const [transportBySiteSaved, setTransportBySiteSaved] = React.useState({});
      const [siteTransportNotice, setSiteTransportNotice] = React.useState('');
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
          // ── 0.19.38（用户 2026-09-27 原话）：「切换网站标签页这一栏：现在鼠标滚动
          //     让网站到底后这一行的滚动应该就不要继续了，而不是现在的不限制让他
          //     直接页面下滑」────────────────────────────────────────────────────
          //
          // 旧实现只判「`scrollLeft` 变没变」，而**已经到底时**赋值 `scrollLeft`
          // 仍然成立（浏览器把越界值钳回最大值，`before` 与之后的值相等），于是
          // `if (el.scrollLeft !== before)` 为 false ⇒ **不** preventDefault ⇒
          // 同一次滚轮继续冒泡去滚整个设置页。用户描述的就是这个：条滚到头了，
          // 页面接着往下滑。
          //
          // 判据改成「**这一下还能不能真滚**」：只在还有余量时接管；到边就把默认
          // 行为还回去？——不，到边**更要**拦住：用户的意思是「这一行的滚动到此为止」，
          // 而不是「让它去滚页面」。因此到边时 preventDefault 但不动 scrollLeft。
          el.scrollLeft = before + e.deltaY;
          // 只要**这条栏真的有可滚内容**就拦下默认行为——不论这一下是滚动了、
          // 还是已经到边（到边时用户要的是「停在这里」，不是「继续滚页面」）。
          // 唯一放行的是「整条根本没有可滚内容」：那时接管毫无意义，
          // 拦住反而会让设置页在这一行上彻底滚不动（比原缺陷更糟）。
          if (el.scrollWidth > el.clientWidth) e.preventDefault();
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
      // 设置**修订号**（0.19.33）：服务端每次落盘设置就自增，随 /settings、
      // /attach-status、/prompt-variants 一起回来。
      //
      // 为什么需要它：设置面有一批读数是服务端**现算**的（提示词模板、增量再教学、
      // 投递形态生效值），而它们的拉取时机此前只有「挂载时一次」。用户在站点页改完
      // 设置后，那些读数既不知道该重拉、也没有任何依据判断该不该重拉 —— 于是
      // 「已保存」与「看到的仍是旧的」同时成立（真机症状：改了站点投递形态，
      // 「当前生效：」那一行与站点只读模板都不动）。
      //
      // 这里不自己发明判据（内容比对 / 固定轮询都会造出第二套真相），而是把服务端
      // 给的号存成 state，当**依赖**传给消费它的组件：号一变，那些 effect 自己重跑。
      const [settingsRevision, setSettingsRevision] = React.useState(0);
      // 投递读数要**按当前站点**读（0.19.32）：轮询 effect 的依赖是 `[]`，闭包里拿不到
      // 后面的 settingsTab，所以用一个 ref 把「此刻看的是哪个 tab」传进去。
      // 没有它，站点页那一行会永远显示全局口径——而用户要核对的是「这个站点自己设的
      // 到底生效没有」，两者不是一件事。
      const tabRef = React.useRef(settingsTab);
      tabRef.current = settingsTab;
      const refresh = () => api('status').then(s => setStatus(s)).catch(() => {});
      React.useEffect(() => {
        let alive = true;
        const poll = () => {
          api('status').then(s => { if (alive) setStatus(s); }).catch(e => { if (alive) setError(e.message); });
          // 投递读数与状态同频刷新（4s）：真机出问题时用户往往就停在这一页，
          // 读数必须自己更新——旧版本这一页对附件投递完全沉默。
          // 两条调用各自成文（0.19.32）：选着某个站点 tab 时带 siteId ⇒ POST，
          // 全局页不带参数 ⇒ GET（由服务端取驱动当前站点，逐字沿用旧形态）。
          //
          // 为什么写成两个调用点而不是 `api('attach-status', cond ? {…} : undefined)`：
          // 客户端的 api() 契约是「有第二实参就 POST」，三元表达式**始终**有第二实参，
          // 于是那一种写法只走 POST，服务端那两个方法里就有一个永远没有客户端用它——
          // test/client-server-contract.test.mjs 会把注册了却没人用的那个方法判成死路由。
          // 两处写开之后，GET 与 POST 都真的是「有人在用」的。
          const readAttach = tabRef.current
            ? api('attach-status', { siteId: tabRef.current })
            : api('attach-status');
          readAttach.then(s => { if (alive) setAttachStatus(s); }).catch(() => {});
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
          // 站点级投递形态：原样取回（服务端已归一化过非法键与非法值）。
          // 同 slotGaps 的纪律——不在这里补默认值，「没配」（跟随全局）与「配成某个值」
          // 是两件事，前端补默认会把前者渲染成后者。
          const tbs = s.promptTransportBySite && typeof s.promptTransportBySite === 'object' ? s.promptTransportBySite : {};
          setTransportBySite(tbs); setTransportBySiteSaved(tbs);
        }).catch(() => {});
        const timer = setInterval(poll, 4000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      // 切站点 tab 时立刻重读一次该站点的投递读数（0.19.32）。
      //
      // 上面的轮询是 4s 一次且闭包固定在挂载那一刻的 tab 上，只靠它的话：切到站点页后
      // 那一行会先显示**上一个站点**的读数（最长 4 秒），而「投递形态」这一格恰好是
      // 用户切过去就是为了核对的东西——显示成别人的值比不显示更糟。
      React.useEffect(() => {
        if (!settingsTab) return undefined;
        let alive = true;
        api('attach-status', { siteId: settingsTab })
          .then(s => {
            if (!alive) return;
            setAttachStatus(s);
            if (s && typeof s.settingsRevision === 'number') setSettingsRevision(s.settingsRevision);
          }).catch(() => {});
        return () => { alive = false; };
      }, [settingsTab]);
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
          applyRevision(r);
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
          applyRevision(r);
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
          applyRevision(r);
          const back = r.defaultModelBySite && typeof r.defaultModelBySite === 'object' ? r.defaultModelBySite : {};
          setModelBySite(back); setModelBySiteSaved(back);
          setSiteModelNotice('已保存 ' + siteName(siteId) + ' 的默认模型。下一轮起生效。');
        } catch (e) { setError(e.message); }
        finally { setPending(false); }
      }

      /**
       * 保存某站点的**投递形态**（0.19.32）。
       *
       * 与 `saveSlotGap` 逐字同一套纪律（整个字典读改写、只 POST 单个键会把其余站点的
       * 覆盖抹掉）。`mode === null` = **删键**、回落到全局档——不是一个「第三种形态」。
       *
       * 这里**不**动全局那一档：站点档与全局档是两条独立的设置，改其中一条时另一条
       * 原样保留（用户要的正是「全局设一个、每个站点也能自己设」）。
       */
       async function saveSiteTransport(siteId, mode) {
        const next = { ...transportBySite };
        if (mode === 'inline' || mode === 'attach') next[siteId] = mode; else delete next[siteId];
        setPending(true); setError(''); setSiteTransportNotice('');
        try {
          const r = await api('settings', { promptTransportBySite: next });
          applyRevision(r);
          const back = r.promptTransportBySite && typeof r.promptTransportBySite === 'object' ? r.promptTransportBySite : {};
          setTransportBySite(back); setTransportBySiteSaved(back);
          // 读数行必须当场重读（0.19.33）：这一格是用户核对「本站点覆盖到底生效没有」
          // 的唯一入口，而它由服务端按站点现算（`attach-status?siteId=…`）。不重读的话，
          // 保存成功与「当前生效：」仍显示旧值会同时成立——这正是用户报的「跟不上」。
          api('attach-status', { siteId })
            .then(s => {
              setAttachStatus(s);
              if (s && typeof s.settingsRevision === 'number') setSettingsRevision(s.settingsRevision);
            }).catch(() => {});
          setSiteTransportNotice(mode
            ? '已保存 ' + siteName(siteId) + ' 的投递形态。下一轮起生效。'
            : siteName(siteId) + ' 已恢复为跟随全局投递形态。');
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
          applyRevision(r);
          const back = r.extraPromptBySite && typeof r.extraPromptBySite === 'object' ? r.extraPromptBySite : {};
          setSitePromptBySite(back); setSitePromptSaved(back);
          setSitePromptNotice(trimmed
            ? '已保存 ' + siteName(siteId) + ' 的指令。它会随该站点下一次整段重建注入。'
            : '已清空 ' + siteName(siteId) + ' 的指令（该站点只剩全局指令）。');
        } catch (e) { setError(e.message); }
        finally { setPending(false); }
      }

      /**
       * 应用一次设置写入返回的**修订号**（0.19.33）。
       *
       * 所有 `api('settings', …)` 的调用点都必须过这里。为什么不让每个 saver 各写一行：
       * 漏掉任何一处，那条路径就回到「保存了但派生读数不刷新」的旧行为，而这种缺陷
       * 在界面上**看不出来**（保存提示照常显示成功）。集中一处，漏接就等于没写。
       *
       * 服务端 POST settings 会把落盘后的新号直接回在响应里，因此这里是**同一次
       * 交互内**就更新，不必等下一次轮询——这正是「点了保存、提示词与生效值立刻
       * 跟上」要兑现的那一点。
       */
      function applyRevision(r) {
        const v = r && r.settingsRevision;
        if (typeof v === 'number' && Number.isFinite(v)) setSettingsRevision(v);
      }

      async function saveSetting(key, value, onDone) {
        setPending(true); setError('');
        try {
          const r = await api('settings', { [key]: value });
          applyRevision(r);
          onDone(r);
        } catch (e) { setError(e.message); }
        finally { setPending(false); }
      }

      /**
       * 本插件的版本与更新（0.19.39）。
       *
       * 三条状态分开，因为它们是三件不同的事：
       *   · `updateInfo`  —— registry 的检查结果（有没有新版）
       *   · `updating`    —— 正在装（按钮禁用 + 文案换「更新中…」）
       *   · `updateNotice`—— 装完的**重启提醒**（含失败原因）
       * 合成一个对象会让「正在装」与「装完了」互相覆盖，而这恰好是用户最需要
       * 分清的两种时刻（一个该等、一个该去重启）。
       *
       * 检查在挂载时自动做一次：顶部要显示「v0.19.39」这种当前版本，而用户
       * 打开设置页的第一眼就该看到它——不该先去点一次「检查更新」才知道自己跑的是哪版。
       */
      const [updateInfo, setUpdateInfo] = React.useState(null);
      const [updateCheckedLoading, setUpdateCheckedLoading] = React.useState(true);
      const [updating, setUpdating] = React.useState(false);
      const [updateNotice, setUpdateNotice] = React.useState(null);
      const checkUpdate = React.useCallback(async () => {
        setUpdateCheckedLoading(true);
        try {
          const r = await api('update-status');
          if (r && r.ok) setUpdateInfo(r);
          else setUpdateInfo({ status: 'unknown', current: status?.build?.version || '?', reason: '检查失败' });
        } catch (e) {
          setUpdateInfo({ status: 'unknown', current: status?.build?.version || '?', reason: e.message });
        } finally { setUpdateCheckedLoading(false); }
        // 依赖用 `status?.build?.version` 而**不是** `build?.version`：本块的位置在
        // `const build = status?.build;` 之前，而依赖数组是**渲染期**求值的——
        // 引用 `build` 会撞上 TDZ（ReferenceError）。读同一个值但走已声明的 `status`，
        // 既拿到相同依赖，又不依赖声明顺序。
      }, [status?.build?.version]);
      React.useEffect(() => { checkUpdate(); }, [checkUpdate]);
      /** 「检查更新」按钮：已是最新时给一句明确回执（否则用户不知道点没点上）。 */
      async function doCheckUpdate() {
        await checkUpdate();
        setUpdateNotice(null);
      }
      /**
       * 「更新到 vX」按钮：**真装**（用户明确选择），装完给重启提醒。
       *
       * 三件必须说清的事，写在这里而不是让用户猜：
       *   · profile 取服务端给的（浏览器侧不知道自己在哪个 profile 里跑）；
       *   · 装完**不会**自动重启 —— 重启会终止正在跑的会话，那是用户此刻在用的东西；
       *   · 装完**必须**重启才生效（本项目第一号踩坑：「装完不重启 = 等于没装」）。
       */
      async function doUpdate() {
        const target = updateInfo?.latest || '';
        setUpdating(true); setUpdateNotice(null);
        try {
          const r = await api('update', { profile: updateInfo?.profile || 'web', version: target }, 300000);
          if (r && r.ok) {
            setUpdateNotice({
              tone: 'ok',
              text: '已装 v' + target + '。**请重启 dsh web** —— 安装只换了磁盘上的文件，'
                + '正在跑的进程里仍是旧代码（本项目最常见的「装了却没生效」）。',
            });
          } else {
            setUpdateNotice({ tone: 'bad', text: '更新失败：' + ((r && (r.error || r.output)) || '未知原因') });
          }
        } catch (e) {
          setUpdateNotice({ tone: 'bad', text: '更新失败：' + e.message });
        } finally { setUpdating(false); }
      }

      const relay = status?.relay;
      const driver = status?.driver;
      const build = status?.build;
      const sites = driver?.sites;
      // 0.19.59：`consent`（网页自动化启用态）的本地读取随「连接」整卡删除。
      // 开关本身已经**恒开**（服务端 relay 恒返回 true，见 lib/relay.js），
      // 界面不再有任何入口，因此这里也不再需要那份读数。
      const metrics = relay?.metrics;
      const currentModelName = m => models?.find(x => x.id === m)?.name || MODEL_NAMES[m] || m;
      // 「深度思考」三态开关仅对 DeepSeek 站点有意义——判据是**当前看的是哪个站点
      // tab**（0.16.38：模型管理搬到站点页之后，这里配的对象就是那个站点；旧判据
      //「默认模型落在哪个站点」是模型管理还在全局页时的写法，已随之退役）。其余
      // 站点的 pill 契约未真机校准，不硬造开关。
      /**
       * 站点级三色健康度（0.19.37）。
       *
       * 用户原话：「『已登录』占位框改为右上角…单独绿色圆点状态指示：红就是全部
       * 不行了，绿就是全部可以，黄就是有可以有不可以，只需要通过颜色圆点显示，
       * 然后所有网站都需要应用，deepseek 一样」。
       *
       * 因此判据是**跨该站点全部账户**的聚合，而不是单账户那一行：
       *   绿 ← 每个账户都 loggedIn === true
       *   红 ← 没有一个账户可用
       *   黄 ← 部分可用（至少一个可用、至少一个不可用）
       * 无账户行时返回 null，调用方不画点——「没有账户」不是一种健康度。
       *
       * 颜色是唯一**视觉**载体（用户明确要求），因此 aria-label 必须把话说全：
       * 屏幕阅读器用户读到的不能是一个没有含义的色块。
       */
      const siteHealthOf = (sid) => {
        const rows = (Array.isArray(sites) ? sites : []).filter(r => r && r.siteId === sid);
        if (!rows.length) return null;
        const ok = rows.filter(r => r.loggedIn === true).length;
        if (ok === rows.length) return 'ok';
        if (ok === 0) return 'bad';
        return 'warn';
      };
      const healthLabel = (h) => h === 'ok' ? '全部账户可用' : h === 'bad' ? '全部账户不可用' : '部分账户可用';
      return h('section', { className: 'hwb-settings' },
        // ---- 顶部：品牌标记 + 名称 + 版本 + 更新 + GitHub（0.19.39）---------
        //
        // 用户原话：「参考 dsh-store 的设置界面顶部『插件市场 / dsh-market /
        // v1.65.1 / 更新插件市场 / 本次全部忽略』设计好本插件的更新和只做提醒
        // 重启操作，替换现在空白的单独 github 按钮」。
        //
        // 因此这一块是「品牌 + 版本 + 动作」一行：左边 dwb 标记 + 插件名，
        // 右边版本号 + 「更新」+ GitHub。与参考实现同构（它也是左边名字、
        // 右边版本与两颗按钮），但**不抄「本次全部忽略」**——那是给「一次列出
        // 多个可更新插件」的场景准备的，本插件只有它自己一个，忽略提醒只会
        // 让用户再也看不到更新（本项目不做「点了就永远不提醒」这种状态）。
        h('div', { className: 'hwb-settings-head' },
          h('span', { className: 'hwb-brand' },
            // 0.19.56：品牌位用**彩色**版（用户：「能彩色地方彩色，用这里的图」）。
            // 0.19.57：品牌位用**彩色**版（Iconoir bridge-3d 几何 + 桥的品牌蓝青）。
            // 「能彩色的地方彩色」——品牌区是插件自己的地盘，彩色形象在这里成立。
            h('span', { className: 'hwb-brand-mark', 'aria-hidden': 'true' }, h(DwbMarkColor, { size: 20 })),
            h('h2', null, 'Harness Web Bridge')),
          h('span', { className: 'hwb-head-actions' },
            updateInfo
              ? h('span', {
                className: 'hwb-version',
                // 0.19.61：文案里的数据源从「registry」改成「GitHub Releases」。
                // 0.19.56 已把更新源换成 Releases，而这三句 title 仍写着 registry——
                // 用户在排障时被这三句话引到错的源上（本项目对「显示与实现不一致」
                // 记过多次：说 A 做 B 比不说更难查）。状态枚举本身没变。
                title: updateInfo.status === 'outdated'
                  ? '当前 v' + updateInfo.current + '，GitHub Releases 上是 v' + updateInfo.latest
                  : updateInfo.status === 'current'
                    ? 'GitHub Releases 上也是 v' + (updateInfo.latest || updateInfo.current)
                    : '检查失败：' + (updateInfo.reason || '未知原因'),
              }, 'v' + updateInfo.current + (updateInfo.status === 'outdated' ? ' → v' + updateInfo.latest : ''))
              : (build?.version ? h('span', { className: 'hwb-version' }, 'v' + build.version) : null),
            h('button', {
              type: 'button', className: 'hwb-update-btn' + (updateInfo?.status === 'outdated' ? ' primary' : ''),
              disabled: updating || updateCheckedLoading,
              title: updateInfo?.status === 'outdated'
                ? '安装 v' + updateInfo.latest + '（装完需要重启 dsh web）'
                : '到 GitHub Releases 查一次有没有新版本',
              onClick: () => (updateInfo?.status === 'outdated' ? doUpdate() : doCheckUpdate()),
            }, updating ? '更新中…' : updateCheckedLoading ? '检查中…'
              : updateInfo?.status === 'outdated' ? '更新到 v' + updateInfo.latest : '检查更新'),
            h('a', {
              className: 'hwb-repo-link',
              href: 'https://github.com/RSLN-creator/dsh-web-bridge',
              target: '_blank', rel: 'noreferrer noopener',
              title: '在 GitHub 打开项目主页（新标签）',
            }, 'GitHub'))),
        // 更新结果 / 重启提醒。**必须显眼**：装完不重启 = 等于没装，
        // 这是本项目的第一号踩坑，而重启会终止在跑的会话，因此只能由用户手动做。
        updateNotice
          ? h('p', { className: 'hwb-update-notice ' + (updateNotice.tone || ''), role: 'status' }, updateNotice.text)
          : null,
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
          // 标题行：站点名在左，三色健康度圆点在**右上角**（用户指定的位置）。
          (() => {
            const health = siteHealthOf(settingsTab);
            return h('h3', { className: 'hwb-group first hwb-group-row' },
              h('span', null, siteName(settingsTab) + ' 的账户与登录'),
              health ? h('span', {
                className: 'hwb-dot ' + health,
                role: 'img',
                // 颜色是唯一视觉载体 ⇒ 读屏必须能读出含义。
                'aria-label': siteName(settingsTab) + ' 账户状态：' + healthLabel(health),
                // `title` 给逐账户的登录依据（哪一个账户、凭什么判的）。
                // 它顺带让 `basisText` 保持**有调用方**——删掉徽章后它一度成了
                // 死代码，而那正是它存在意义的反面：那句话是给「未登录看起来像
                // 凭空断言」准备的解释，不该随徽章一起消失。
                title: (Array.isArray(sites) ? sites : [])
                  .filter(r => r && r.siteId === settingsTab)
                  .map(r => (r.accountName || r.displayName || '') + '：' + basisText(r))
                  .join('\n') || null,
              }) : null);
          })(),
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

        // ---- 站点专属提示词投递形态（0.19.32）--------------------------------
        //
        // 用户原话：「提示词投递：给每个模型站点都做到和『发送间隔（全局）』一样的逻辑：
        // 全局设置一个，但是针对每个单独网站设置能够单独设置」。
        //
        // 因此这一张卡与上面「排队间隔」那张**逐字同构**：三态（跟随全局 / 附件投递 /
        // 纯文本）+ 一行只读读数。回落链也同构：站点档 → 全局档 → 插件 config → 'attach'。
        //
        // 为什么需要它：投递形态此前是**进程级**的一个开关，而站点差异是真实存在的
        //（deepseek 与 kimi 的输入框实测上限远低于全站默认阈值，见 SITE_ATTACH_INLINE_LIMIT
        // 的取证）。全局只能二选一时，用户只能为某一个站点让所有站点一起改。
        //
        // 读数那一行读的是**服务端按本站点算好的**文案（attach-status 带 siteId），
        // 前端不自己拼「本站点现在是什么」——两处各拼一份，迟早分叉。
        settingsTab && (() => {
          const cur = Object.prototype.hasOwnProperty.call(transportBySite, settingsTab)
            ? transportBySite[settingsTab] : null;
          return h('div', { className: 'hwb-card' },
            // 卡名不带「提示词投递」四个字：那是**全局页**那张卡的标题，而站点页的
            // 「不得出现全局卡」由 test/client-render.test.mjs 的 0.16.38 作用域用例按
            // 词钉住——同词会让那条护栏分不清「全局卡漏到站点页」与「站点卡起了同名」。
            h('h3', { className: 'hwb-group first' }, siteName(settingsTab) + ' 的投递形态'),
            h('div', { className: 'hwb-row' }, h('span', { className: 'hwb-row-label' }, '投递形态'),
              h('div', { className: 'hwb-row-main' },
                h('label', { className: 'hwb-consent', title: '跟随全局页那一档（未覆盖时就是这个）' },
                  h('input', { type: 'radio', name: 'hwb-site-transport', checked: cur === null, disabled: pending,
                    onChange: () => saveSiteTransport(settingsTab, null) }),
                  h('span', null, '跟随全局')),
                h('label', { className: 'hwb-consent', title: '超过阈值的正文改为附件上传；任何一步失败都自动回落纯文本' },
                  h('input', { type: 'radio', name: 'hwb-site-transport', checked: cur === 'attach', disabled: pending,
                    onChange: () => saveSiteTransport(settingsTab, 'attach') }),
                  h('span', null, '附件投递')),
                h('label', { className: 'hwb-consent', title: '正文逐字写进网页输入框（旧行为）' },
                  h('input', { type: 'radio', name: 'hwb-site-transport', checked: cur === 'inline', disabled: pending,
                    onChange: () => saveSiteTransport(settingsTab, 'inline') }),
                  h('span', null, '纯文本')),
                siteTransportNotice && h('span', { className: 'hwb-hint' }, siteTransportNotice))),
            h('p', { className: 'hwb-hint indent' }, cur === null
              ? '未覆盖：跟随全局投递形态。'
              : '已覆盖为「' + (cur === 'inline' ? '纯文本' : '附件投递') + '」，只对本站点生效。'),
            h('p', { className: 'hwb-hint indent' }, '当前生效：' + (attachStatus?.transportLine || '读数加载中…')));
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
            // 设置一变，这张卡的只读模板 / 再教学跟着重算（0.19.33）。
            revision: settingsRevision,
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
              // 0.19.31（用户 2026-09-27 原话）：「全局界面发送间隔：答完那一刻起重新数满
              // 间隔。这样的提示行去除」—— 两个分支的说明文案整行删除，只留下拉本身。
              // 选项各自的语义挪进 option 的 title（悬停即见），因此删掉的是**常驻占位**
              // 而不是信息：界面不再为一句解释长期留一行。
              h('select', { className: 'hwb-model-select', value: sendGapBasis, disabled: pending,
                onChange: e => setSendGapBasis(e.target.value === 'end-to-start' ? 'end-to-start' : 'send-to-send') },
                h('option', { value: 'send-to-send', title: '防限流：距上次发出' }, '距上次发出'),
                h('option', { value: 'end-to-start', title: '防贴太紧：距上次回复完成' }, '距上次回复完成'))))),

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

        // ---- 全局页：「连接」整卡**已删除**（0.19.59，用户 2026-10-03 指令）------
        //
        // 用户原话：「设置界面，给『连接 / 网页服务 / 中继已连接 / 主线落点 /
        // deepseek:deepseek · deepseek/deepseek / 去配置 DeepSeek / 启用网页自动化 /
        // 已启用（本机永久保存）』都不显示，就是去除那一框，内部都是默认全开启」。
        //
        // 因此这一框里三样东西一并消失：
        //   · 「网页服务：中继已连接」——进程内中继起没起来是**运行读数**，
        //     不是用户要配的东西；它属于排障面板，不属于设置页；
        //   · 「主线落点 + 去配置 X」——主线落点仍是 `defaultModel`，而它的配置
        //     入口本来就在站点页（0.16.38 起模型的配置全在站点页），上面那条
        //     站点 tab 条就是唯一的跳转入口，这里再放一颗按钮是重复入口；
        //   · 「启用网页自动化」勾选框——按用户指令改为**恒开**（服务端 `consent`
        //     恒为 true，且忽略落盘记录里的 `accepted:false`，见 lib/relay.js）。
        //     界面不再提供关闭入口，因此留一个只有「开」一个状态的勾选框毫无意义。
        //
        // ⚠ 这条删除**改变了产品姿态**：网页自动化从「用户可关的风险门」变成
        //「默认且不可关」。它是用户明确要求的，不是顺手删的；安全姿态记录见
        // doc/security-review.md 与 doc/settings-copy.md 的对应条目。

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
          h(GlobalPrompt, { onRevision: applyRevision })),

        // ---- 全局页：首轮提示词模板总览（0.16.38）---------------------------
        //
        // 站点页只给该站点那一行与文件入口；这里给一张**全站点对照表**：每行一个
        // 站点 + 它实际使用的协议 + 该站点的提示词文件路径。要看某个站点此刻真的
        // 在教什么，展开对应站点页的只读模板即可（那是唯一正本）。
        !settingsTab && h('div', { className: 'hwb-card' },
          h('h3', { className: 'hwb-group first' }, '首轮提示词（只读）'),
          h('p', { className: 'hwb-hint' }, '只读：模板按本会话工具清单生成；可编辑的是全局指令与各站点自己的那一段。'),
          h(PromptSection, { revision: settingsRevision })),
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
      // doubao：@lobehub/icons-static-svg 的 doubao.svg（0.19.35 换源，见 SITE_ICON_TIER）
      // https://unpkg.com/@lobehub/icons-static-svg@latest/icons/doubao.svg
      // 3 条路径（含浅色层 fill-opacity）；见 SiteGlyph 的多路径分支。
      doubao: [
        { d: 'M5.31 15.756c.172-3.75 1.883-5.999 2.549-6.739-3.26 2.058-5.425 5.658-6.358 8.308v1.12C1.501 21.513 4.226 24 7.59 24a6.59 6.59 0 002.2-.375c.353-.12.7-.248 1.039-.378.913-.899 1.65-1.91 2.243-2.992-4.877 2.431-7.974.072-7.763-4.5l.002.001z', opacity: 0.5 },
        { d: 'M22.57 10.283c-1.212-.901-4.109-2.404-7.397-2.8.295 3.792.093 8.766-2.1 12.773a12.782 12.782 0 01-2.244 2.992c3.764-1.448 6.746-3.457 8.596-5.219 2.82-2.683 3.353-5.178 3.361-6.66a2.737 2.737 0 00-.216-1.084v-.002zM14.303 1.867C12.955.7 11.248 0 9.39 0 7.532 0 5.883.677 4.545 1.807 2.791 3.29 1.627 5.557 1.5 8.125v9.201c.932-2.65 3.097-6.25 6.357-8.307.5-.318 1.025-.595 1.569-.829 1.883-.801 3.878-.932 5.746-.706-.222-2.83-.718-5.002-.87-5.617h.001z' },
        { d: 'M17.305 4.961a199.47 199.47 0 01-1.08-1.094c-.202-.213-.398-.419-.586-.622l-1.333-1.378c.151.615.648 2.786.869 5.617 3.288.395 6.185 1.898 7.396 2.8-1.306-1.275-3.475-3.487-5.266-5.323z', opacity: 0.5 },
      ],
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
      // 取件 2026-09-21（zai）/ 2026-09-27（glm 改 qingyan），URL 前缀
      // `https://unpkg.com/@lobehub/icons-static-svg@latest/icons/`：
      //   zai.svg（Z.ai）· qingyan.svg（智谱清言——0.19.35 前用的是 chatglm.svg，
      //   那是底层 GLM 模型的标，不是这个应用的标）
      zai: 'M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z',
      // glm：@lobehub/icons-static-svg 的 qingyan.svg
      // https://unpkg.com/@lobehub/icons-static-svg@latest/icons/qingyan.svg
      // 2 条路径；见 SiteGlyph 的多路径分支。
      glm: [
        { d: 'M6.075 10.494C7.6 9.446 9.768 8.759 12.222 8.759c2.453 0 4.622.687 6.147 1.735.77.53 1.352 1.133 1.74 1.77C20 10 20 10 20.687 9.362a9.276 9.276 0 00-1.008-.8c-1.958-1.347-4.598-2.143-7.457-2.143-2.858 0-5.499.796-7.457 2.144-1.955 1.345-3.325 3.322-3.325 5.647 0 2.326 1.37 4.303 3.322 5.646C6.721 21.205 9.362 22 12.22 22c2.859 0 5.5-.795 7.457-2.144C21.63 18.513 23 16.538 23 14.21c0-1.48-.554-2.817-1.46-3.94-.046 1.036-.41 2.03-1.012 2.937.099.325.149.663.15 1.003 0 1.33-.782 2.664-2.313 3.717-1.524 1.048-3.692 1.735-6.146 1.735-2.453 0-4.623-.687-6.147-1.735C4.544 16.874 3.76 15.54 3.76 14.21c.003-1.33.785-2.663 2.315-3.716z' },
        { d: 'M3.747 11.494c-.62 1.77-.473 3.365.332 4.51.806 1.144 2.254 1.813 4.117 1.813 1.86 0 4.029-.68 6.021-2.1 1.993-1.42 3.35-3.251 3.967-5.017.62-1.769.473-3.364-.332-4.51-.806-1.143-2.254-1.812-4.117-1.812-1.86 0-4.029.68-6.021 2.099-1.993 1.42-3.35 3.252-3.967 5.017zm-2.228-.79c.8-2.28 2.487-4.498 4.83-6.167C8.691 2.866 11.33 2 13.734 2c2.4 0 4.678.874 6.045 2.817 1.366 1.943 1.431 4.394.633 6.674-.8 2.282-2.487 4.499-4.83 6.168-2.344 1.67-4.981 2.536-7.387 2.537-2.4 0-4.678-.874-6.045-2.817-1.368-1.943-1.431-4.396-.633-6.674h.002z' },
      ],
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
      // 0.19.35：豆包从「字节跳动的 bytedance 标记」换成**豆包自己的品牌矢量**。
      // 用户原话：「右侧面板智谱清言、豆包的矢量图错误了……请你下载替换为正确矢量图」。
      // 上一版用 bytedance 是当时的诚实权衡（simple-icons 确实没有 doubao 条目），
      // 但它画出来的是**字节跳动**的标，不是豆包——用户一眼就看出不对。
      // 现在改取 lobehub 的 doubao.svg，与 GLM / Z.ai 同一档 'vector'（社区图集，
      // 非品牌方发布）；这一档的存在就是为了不把来源含糊掉。
      doubao: { tier: 'vector', why: '真实矢量，来源 @lobehub/icons-static-svg 的 doubao.svg（社区图集，非品牌方发布；simple-icons 无此条目），取件 2026-09-27' },
      // 0.16.37：这两行从 'missing' 改成 'official' 之外的新档 'vector'——**档位名不能骗人**。
      //
      // 'official' 在本文件里的含义一直是「磁盘上有真实品牌矢量」，而它此前只覆盖
      // simple-icons（CC0）与官方鲸鱼。GLM / Z.ai 现在用的是 lobehub 的矢量：
      // 真实、透明底、随 currentColor，但**不是品牌方发布、也不是 CC0**。
      // 把它并进 'official' 会把「来源等级」这件事含糊掉（而这一档的全部价值就是
      // 让用户一眼看出图标从哪来），因此单开一档，逐行 title 里写明来源。
      // 0.19.35：智谱清言从 **chatglm.svg** 换成 **qingyan.svg**。两者都在 lobehub 里，
      // 但 chatglm 是底层 GLM 模型的标，qingyan 才是**智谱清言这个应用**的标——用户
      // 看到的就是「应用图标不对」。取件 2026-09-27。
      glm: { tier: 'vector', why: '真实矢量，来源 @lobehub/icons-static-svg 的 qingyan.svg（智谱清言应用标，社区图集，非品牌方发布；simple-icons 实测无此条目），取件 2026-09-27' },
      zai: { tier: 'vector', why: '真实矢量，来源 @lobehub/icons-static-svg（社区图集，非品牌方发布；simple-icons 实测无此条目），取件 2026-09-21' },
    };
    const siteTier = sid => SITE_ICON_TIER[sid]?.tier || 'missing';
    // 0.19.35：`siteIconWhy` 已删。用户原话：「右侧鼠标悬浮在矢量图时候会有的说明
    // 去除显示」——档位说明此前既挂在站点目录行、也挂在右栏工具条的图标上，都是
    // `title`（悬浮提示）。删的是**显示**，不是**记录**：`SITE_ICON_TIER[].why` 逐条
    // 保留（谁画的、从哪取的、什么许可、取件日期），它仍是「图标从哪来」的唯一正本，
    // 由 test/client-render.test.mjs 在**源码层**核验。把记录一起删掉才是真的丢了信息。
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
      // simple-icons / lobehub 取回的 24×24 图标：原样放进方形画布居中。
      // 与鲸鱼那条分支**同一套尺寸口径**（box = size + 8、currentColor），因此同一
      // 排里光学大小一致——两种来源的图标混排时不会一大一小。
      //
      // 0.19.35：值可以是**单条 d 字符串**，也可以是 `{d, opacity}[]`。豆包的品牌
      // 矢量本身就是多路径带浅色层（两条 fill-opacity=.5），只画一条会得到半个图形
      // ——这正是用户报的「豆包矢量图错误」。两条分支共用同一个 transform，因此
      // 多路径之间的相对位置逐字保持源文件里的关系。
      const scIcon = SITE_ICON_PATHS[sid];
      if (scIcon) {
        const pad = (box - size) / 2;
        const tf = 'translate(' + pad + ' ' + pad + ') scale(' + (size / 24) + ')';
        const parts = Array.isArray(scIcon) ? scIcon : [{ d: scIcon, opacity: 1 }];
        return h('svg', {
          className: 'hwb-glyph-svg', width: box, height: box, viewBox: '0 0 ' + box + ' ' + box,
          'aria-hidden': 'true', focusable: 'false',
        }, parts.map((p, i) => h('path', {
          key: i, d: p.d, fill: 'currentColor',
          // 只有真源里写了 fill-opacity 的路径才带这个属性：给它补 1 会凭空多出一个
          // 与源文件不同的属性，而「逐字照抄源矢量」是这一节的验收口径。
          ...(p.opacity === undefined || p.opacity === 1 ? {} : { 'fill-opacity': p.opacity }),
          transform: tf,
        })));
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
      /**
       * 每个已登录账户的**缓存身份**由服务端在**读 DOM 的时刻**刷新，而不是靠前端轮询
       * 去猜（0.19.47）。
       *
       * ## 为什么刷新必须挂在轮询上，而不是只挂在下拉展开上
       *
       * 用户 2026-09-28 原话：「其余所有已登录网站的用户名和头像一样触发缓存更新字段」。
       * 只在下拉展开时刷有两个覆盖不到的情形，而它们恰好是最常见的：
       *   · 用户**从不点开**下拉（单账号站点没有展开的必要），卡片永远停在站点名；
       *   · **账户 2** 的站点在卡片上根本不会展开到——多账号时卡片按站点名走，
       *     而账户 2 的真实昵称只能靠它自己那一行读到。
       * 轮询本来就在每 8s 读一次 `/status`，顺路把身份探针发出去，三条界面落点
       * （卡片标题、卡片左端头像、下拉每一行）就能各自拿到自己的真实值。
       *
       * ## 为什么只发「登录态已知为真」的账户
       *
       * `readAccountIdentity` 会**真的去读一次页面 DOM**（未登录时读到的是游客态元素，
       * 读不出昵称）。对全部 10 站点 × 全部槽每 8s 各发一次，等于在没有额度收益的
       * 情况下持续给每个站点加负载——而用户要的是「已登录的网站」。因此这里只挑
       * `loggedIn === true` 的槽；未登录的槽等它登录之后自然进入这份名单。
       *
       * 失败一律吞掉（`.catch(()=>{})` 与 `!r.ok` 直接 return）：身份读不到只是一个
       * 缺失的可选装饰，绝不能让目录面板报错或丢行。
       */
      const pollIdentity = (list) => {
        for (const r of list) {
          if (!r || r.loggedIn !== true) continue;
          const acctKey = r.accountKey || r.siteId;
          // 已经有真实昵称的槽**不重复探**：轮询是 8s 一次的常驻路径，反复读同一份
          // 已知结果没有收益（用户手动改昵称的场景由下拉展开时那次强制刷新覆盖）。
          if (r.accountName) continue;
          apiSoft('account-identity', { ...slotOf(acctKey) }, 20000).then((res) => {
            if (!res.ok || !res.data) return;
            const name = res.data.name ? String(res.data.name) : null;
            const avatarUrl = res.data.avatarUrl ? String(res.data.avatarUrl) : null;
            if (!name && !avatarUrl) return;
            setRows((prev) => (Array.isArray(prev) ? prev : []).map((row) => {
              const key = row.accountKey || row.siteId;
              if (key !== acctKey) return row;
              return {
                ...row,
                accountName: name || row.accountName || null,
                avatarUrl: avatarUrl || row.avatarUrl || null,
              };
            }));
          }).catch(() => {});
        }
      };
      React.useEffect(() => {
        let alive = true;
        const load = () => api('status').then(s => {
          if (!alive) return;
          const next = Array.isArray(s?.driver?.sites) ? s.driver.sites : [];
          setRows(next);
          setError('');
          pollIdentity(next);
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
       *
       * ## 为什么结果必须写进 `rows`（0.19.47）
       *
       * 本函数原先只把 `account-identity` 发出去、`apiSoft(...).catch(()=>{})` 丢掉返回值，
       * 于是这次刷新对界面**没有任何作用**：面板渲染的是 `/status` 那批 `rows`，而本轮
       * 读到的昵称/头像两处都没落进去。用户看到的仍是「DeepSeek 网页版」+ 站点矢量图，
       * 且要等到下一次 8s 轮询把服务端缓存读回来——而服务端那次刷新本身也不写缓存
       * （`readAccountIdentity` 是只读探针），所以打开下拉永远换不来真实用户名。
       * 这正是字段挑选表里注释警告的同一形状：读到了、中途丢掉、界面显示默认值。
       *
       * 因此：按 accountKey 把 name/avatarUrl **合并进 `rows`**，并保留
       * `accountName` 的「不为空才算数」语义——服务端读不到时回的是 `null`，
       * 那种情况下**绝不**覆盖（覆盖等于把已知的真实昵称抹回槽名）。
       */
      function refreshIdentities(accounts) {
        for (const a of accounts) {
          const acctKey = a.accountKey || a.siteId;
          apiSoft('account-identity', { ...slotOf(acctKey) }, 20000).then((r) => {
            if (!r.ok || !r.data) return;
            const name = r.data.name ? String(r.data.name) : null;
            const avatarUrl = r.data.avatarUrl ? String(r.data.avatarUrl) : null;
            if (!name && !avatarUrl) return;
            setRows((prev) => (Array.isArray(prev) ? prev : []).map((row) => {
              const key = row.accountKey || row.siteId;
              if (key !== acctKey) return row;
              return {
                ...row,
                accountName: name || row.accountName || null,
                avatarUrl: avatarUrl || row.avatarUrl || null,
              };
            }));
          }).catch(() => {});
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
            /**
             * 身份取值：**只认抓到的真实值**，抓不到一律回落到既有默认。
             *
             * 用户 2026-09-28 原话：「右侧tab展开站点的：DeepSeek 网页版改为真实用户名！
             * ……其余所有已登录网站的用户名和头像一样触发缓存更新字段」——即卡片上那行
             * 字与左端那颗图都必须是他在站点网页里看到的昵称/头像，而不是站点名 + 矢量图。
             *
             * ## 多账号站点怎么画（0.19.59，用户 2026-10-03 指令）
             *
             * 旧实现只在**单账号**站点取真实身份当卡片主身份，多账号一律回落成
             * 「站点名 + 站点矢量图」。用户判定那条规则让展示**在站点之间不同步**：
             *   > 豆包和kimi——一个账户的那种展示不错，但是deepseek和z.ai两个账户的就不行
             * 他给的取舍是「第一个按照原来的那样，2/3/4 你自己适配」，于是新规则是：
             *
             *   · **第 1 个账户**当卡片主身份（真实昵称 + 真实头像），与单账号站点同一套；
             *   · 其余账户在头像右下角**叠层**显示（最多 3 颗，超出的折成 `+N`）——
             *     一个账户都不丢，卡片也不会因为账号多而变形；
             *   · 每一行的真实昵称/头像仍各自在下拉里（`acctName`/`acctIcon`）。
             *
             * 回落仍是与改动前逐字一致的 `siteName(sid)` + 站点矢量图：没抓到身份时
             * （刚重启、缓存为空、该站点本就未登录）必须长得和旧版一样——宁可显示站点名，
             * 也不拿槽名（`deepseek (账户2)`）冒充用户名（本文件「不造假」纪律）。
             */
            const primary = accounts[0] || null;
            const others = accounts.slice(1);
            // 卡片标题 = **网站原名**（0.19.61，用户 2026-10-04 指令）。
            //
            // 旧实现是 `primary.accountName || siteName(sid)`——「抓到昵称就显昵称」，
            // 于是同一份目录里 glm 显示 `RSYHN`、kimi 显示 `TYZ0712`、而 deepseek / z.ai
            // 因为昵称读不到（见 doc/long-term-issues.md #43）显示站点名——**同一列里
            // 两种语义混排**：用户看到的标题有时是人名、有时是网站名。
            // 用户原话：「右侧 tab 菜单显示的是用户名而不是网站名」。
            //
            // 现在标题恒为网站名，真实昵称**只在下拉的各账户行里**（`acctName`）——
            // 昵称没有丢，只是回到了它能被正确解读的位置：一个站点一行标题，
            // 行内的账户才是「人」。头像不受影响（仍是第 1 个账户的真实头像）。
            const title = siteName(sid);
            const primaryAvatar = (primary && primary.avatarUrl) || null;
            // 叠层里最多画几颗。3 是「一眼看得出有几个号、又不把 56px 胶囊撑变形」的
            // 取中；它只影响**显示**，不参与任何读数或选路。
            const STACK_MAX = 3;
            const stacked = others.slice(0, STACK_MAX);
            const stackRest = others.length - stacked.length;
            // 昵称优先级：**抓到的真实昵称** → 桥生成的槽名。卡片主身份与叠层
            // 缩略图的 tooltip 共用它（下拉每一行也走同一个函数，见下面 Menu 的 items）。
            // ⚠ 必须定义在 `main` **之前**：叠层在构造 `main` 时就会调用它，
            // 写成 `const acctName = …` 放在后面会命中 TDZ（`Cannot access
            // 'acctName' before initialization`）——那是「看着没问题、一渲染就白屏」
            // 的典型形态（本文件记过多次：结构性错误在静态阅读时最难看见）。
            const acctName = (a) => a.accountName || a.displayName || siteName(sid);
            // 主区：官方 `Button variant:'ghost'`——与「新建终端」同一个原语。
            // 自己写 <button> 会丢掉 ghost 的配色、按下态与焦点环，而「排版一样」
            // 最容易露馅的正是这些细节。
            const main = h(Button, {
              variant: 'ghost', className: 'hwb-site-main',
              onClick: () => open(sid, ''),
            },
              // `.hwb-catalog-face` 是**固定 26px 的身份盒**：主头像与站点矢量标记
              // 在这个盒子里**重叠**（头像绝对定位盖住标记），因此「有头像」与
              //「回落标记」两种情况占的宽度逐像素相同，标题起始位置不会跳动；
              // 叠层缩略图挂在它的右下角，不参与排版（绝对定位）。
              //
              // 重叠而不是并排：旧实现把 `<img>` 与 `SiteGlyph` 并排放在 flex 行里，
              // 于是**抓到头像时两个图标同时出现**（头像 + 站点矢量并排），
              // 而 onError 那条「藏掉 img 露出后面的标记」的承诺在并排布局下不成立
              //（藏掉头像后标记本来就在旁边，不需要「露出」）。这正是用户报的
              //「各站点账户图像展示方法不同步」的可见来源之一。
              h('span', { className: 'hwb-catalog-face' },
                h('span', { className: 'hwb-catalog-ico' + (hasBrandVector(sid) ? ' official' : '') },
                  // 真实头像优先；与下拉里的 acctIcon 同一纪律——跨域 CDN 拒热链时
                  // 藏掉 img 露出下面的矢量标记，**不造假**。
                  //
                  // 0.19.61 修**真缺陷**（用户 2026-10-04：「头像是网站矢量、头像是网站
                  // 矢量，都没渲染」）：旧实现把 `SiteGlyph` 写在 `<img>` **之后**，
                  // 于是两个都占满身份盒、按 DOM 顺序**矢量图盖在头像上**——头像永远
                  // 看不见（名字能显示是因为文本在另一个节点上）。这不是「抓不到头像」
                  // （服务端实测 deepseek/glm/kimi/doubao/zai 都有真实 avatarUrl），
                  // 而是**画的顺序与占位错**。
                  //
                  // 现在按「谁优先谁后画」排序：矢量标记先画，头像后画 ⇒ 有头像时头像
                  // 在最上层；头像 `onError` 时把自己 display:none，底下的矢量自然露出
                  //（旧注释承诺的「藏掉 img 露出下面的标记」现在才真的成立）。
                  hasBrandVector(sid) ? h(SiteGlyph, { sid, size: 26 }) : null,
                  primaryAvatar
                    ? h('img', {
                      className: 'hwb-catalog-img', src: primaryAvatar, alt: '', loading: 'lazy',
                      onError: (e) => { try { e.currentTarget.style.display = 'none'; } catch { /* 忽略 */ } },
                    })
                    : null),
                others.length
                  ? h('span', {
                    className: 'hwb-catalog-stack',
                    // 叠层是**纯装饰**：账户数与每个账户的身份都有可读落点
                    //（说明行 + 下拉各行），因此不进可访问树，避免读屏念出一串无名图。
                    'aria-hidden': 'true',
                  },
                    ...stacked.map(a => h('span', {
                      key: a.accountKey || a.siteId,
                      className: 'hwb-catalog-stack-item',
                      title: acctName(a),
                    }, a.avatarUrl
                      ? h('img', {
                        className: 'hwb-catalog-stack-img', src: a.avatarUrl, alt: '', loading: 'lazy',
                        onError: (e) => { try { e.currentTarget.style.display = 'none'; } catch { /* 忽略 */ } },
                      })
                      : h(SiteGlyph, { sid, size: 10 }))),
                    stackRest > 0
                      ? h('span', { className: 'hwb-catalog-stack-rest' }, '+' + stackRest)
                      : null)
                  : null),
              h('span', { className: 'hwb-site-text' },
                h('span', { className: 'hwb-site-title' }, title),
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
              const glyph = h('span', { className: 'hwb-acct-glyph' }, h(SiteGlyph, { sid, size: 16 }));
              if (!url) return glyph;
              // 真实头像（0.19.4）。跨域 CDN 可能拒热链 → onError 时把 img 藏掉，
              // 露出后面的站点标记；**不造假**：读不到就不用槽名冒充头像。
              //
              // 0.19.61 修：旧实现这里**只 return 那个 `<img>`**，矢量标记压根没画进
              // DOM ⇒ 注释承诺的「露出后面的站点标记」没有落点，头像加载失败时
              // 那一行就是**空白**（不是回落标记）。现在两者都画、标记在先、
              // 头像绝对定位盖在上面（CSS 见 `.hwb-acct-img`），失败时藏 img 即露出标记。
              //
              // 为什么包一层 `<span>` 而不是直接 return 数组：`Menu` 的 `icon` 契约是
              // **单个 React 节点**，数组会被当成两个并列图标；而且头像要绝对定位，
              // 必须有一个定位父元素（`.hwb-acct-face`）。
              return h('span', { className: 'hwb-acct-face' }, glyph, h('img', {
                className: 'hwb-acct-img', src: url, alt: '', loading: 'lazy',
                onError: (e) => { try { e.currentTarget.style.display = 'none'; } catch { /* 忽略 */ } },
              }));
            };
            // 昵称取值已在上面（叠层要先用到它）定义，这里不再重复一份——
            // 两处各写一份正是本项目记过多次的「口径漂移」形状。
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

    /**
     * 站点探活的**会话级**缓存（0.19.52，用户报障「每次打开右侧都要停顿加载」的
     * 客户端一半）。
     *
     * 旧实现把缓存挂在组件实例的 `useRef` 上，而注释写的是「会话内缓存」——
     * DSH 官方标签条切走再切回会**卸载再重挂**面板（宿主标签的固有生命周期，
     * 见 ui-sidebar-files 的 README：切走即卸载、切回即重挂），useRef 随之清零，
     * 于是每次切回都要把探活**串行地**重跑一遍（可达站点一次真实外网往返，
     * 不可达站点最长 30s 超时），然后才轮到 connect 和 iframe。提升到模块级
     * 后，同一次页面加载内探活只跑一次；「重试」按钮仍传 force 强制重探。
     */
    const siteProbeCache = new Map(); // siteId → { reachable, status, reason, ms, at }

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
      // 站点探活（不可达站点不挂 iframe）：**会话级**缓存（模块级 siteProbeCache，
      // 0.19.52——旧实现挂在组件 ref 上，面板随标签卸载就丢），点「重试」强制重探。
      // `probes` 这个 React state 只服务**渲染**（不可达横幅），probeSite 的命中
      // 判据一律走缓存本体，两者不共用同一份引用。
      const [probes, setProbes] = React.useState({});     // siteId → { reachable, status, reason, ms, at }
      const probeSite = React.useCallback((sid, force) => {
        // 命中会话级缓存（0.19.52，见 siteProbeCache 声明处）直接回——面板重挂
        // 不再串行重跑探活；force（「重试」按钮）仍然真探。
        if (!force && siteProbeCache.has(sid)) return Promise.resolve(siteProbeCache.get(sid));
        return api('site-probe', { siteId: sid }, 30000)
          .then(r => { siteProbeCache.set(sid, r); setProbes(prev => ({ ...prev, [sid]: r })); return r; })
          .catch(() => null);
      }, []);
      const unreachable = sid => { const p = probes[sid]; return p && p.reachable === false ? p : null; };
      const ensureFrame = React.useCallback((sid, force) => {
        setFrames(prev => {
          if (prev[sid] && !force) return prev;   // 已有存活 frame：直接复用，不重载
          // 子域形态：站点在根路径（pathname 与真实站点一致）。强制重载用一个
          // 站点不认识的查询参数绕开缓存——不动 pathname，SPA 路由不受影响。
          // 槽维度（0.19.46）：非默认槽用带槽的主机名，否则账户2 的 iframe 会
          // 加载默认槽的登录态（用户报障原文见 siteBase 的注释）。
          // 取 `accountSlot`（活状态，会随二级菜单切号而变化）而不是 `controlledSlot`
          // （只是初值/受控入参）——否则在同一个标签里切换到账户2 时，src 仍停在
          // 账户1 的源上，用户看到的又是「选了账户2、界面还是账户1」。
          const src = siteBase(sid, accountSlot) + (force ? '?__wc_reload=' + Date.now() : '');
          return { ...prev, [sid]: { src, ready: false, status: null } };
        });
      }, [browserSrc, accountSlot]);
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
          active && !active.ready && !connectError && h('div', { className: 'hwb-frame-status' }, '正在加载 ' + siteName(siteId) + ' 网页…')));
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
        ".hwb-settings-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:4px}",
        ".hwb-settings-head h2{margin:0}",
        // 0.19.39：品牌标记 + 名称 + 版本 + 更新 + GitHub 一行（用户要的顶部形态）。
        ".hwb-brand{display:inline-flex;align-items:center;gap:8px;min-width:0}",
        ".hwb-brand-mark{display:inline-flex;align-items:center;justify-content:center;flex:none}",
        ".hwb-head-actions{display:inline-flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}",
        ".hwb-version{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);font-variant-numeric:tabular-nums;white-space:nowrap}",
        // 0.19.56：更新按钮改成与右侧 GitHub 链接**同一个圆框**（用户原话：「按钮和
        // 右边的github一样圆框」）。数值逐项对齐 .hwb-repo-link（12px 字号 / 18px 行高 /
        // 2px 8px 内边距 / 12px 圆角 / .5px 边框），只保留「有新版时换主色底」这一处差异——
        // 那是「现在是主动作」的唯一视觉信号，形状本身两颗完全一致。
        ".hwb-update-btn{font:inherit;font-size:12px;line-height:18px;padding:2px 8px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:.5px solid var(--dsw-alias-border-l3,#8885);border-radius:12px;cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease}",
        ".hwb-update-btn:disabled{opacity:.45;cursor:default}",
        // 「有新版」时才用主色底：常态是一颗安静的次级按钮，有更新才成为主动作。
        ".hwb-update-btn.primary{background:var(--dsw-alias-button-info-fill,#3b82f6);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}",
        ".hwb-update-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,#2f6fe4)}",
        // 重启提醒：装完必须重启才生效，因此这条**不能**是一条灰色小字。
        ".hwb-update-notice{margin:6px 0 0;padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;max-width:100%;overflow-wrap:anywhere}",
        ".hwb-update-notice.ok{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,#8881);border:.5px solid var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-update-notice.bad{color:var(--dsw-alias-state-error-primary,#93443e);background:var(--dsw-alias-interactive-bg-hover,#8881);border:.5px solid var(--dsw-alias-state-error-primary,#93443e)}",
        ".hwb-repo-link{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#6b7280);text-decoration:none;padding:2px 8px;border:.5px solid var(--dsw-alias-border-l3,#8885);border-radius:12px;transition:background .12s ease,color .12s ease}",
        ".hwb-repo-link:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,#8882)}",
        ".hwb-update-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-bg-hover,#8882)}",
        ".hwb-lead{font-size:13px;line-height:22px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin:0;max-width:100%;overflow-wrap:anywhere}",
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
        //
        // ── 0.19.31（用户 2026-09-27 原话）：「设置界面：全局/deepseek 这样，他的按钮
        //     底部和一条分割线重合……解决为下移一点」────────────────────────────────
        // 成因：`align-items:flex-end` 把每个 tab 的**底边**对齐到容器内容盒底边，
        // 而选中态那条 2px 指示线就画在 tab 的底边上；容器的 `.5px` 分隔线由
        // `border-bottom` 画在内容盒**紧下面** ⇒ 蓝线下面直接贴着灰线，看起来「重合」。
        // 修法：容器加 `padding-bottom:4px` —— 分隔线（border）随内容盒一起下移 4px，
        // 与指示线之间留出可见间隙。不动 tab 自身的内边距，因此选中态不会跳、
        // 整排高度也不变（这 4px 本来就落在原来的 12px 下边距里）。
        // ── 0.19.31（用户 2026-09-27 原话）：「不应该是点击后按钮内部底面有个白色底线，
        //     改为官方常见的……切换标签页里面切『全局』那些」────────────────────────
        //
        // 旧形态是「透明下边框 + 选中时 2px 下划线」，线色取 `--dsw-alias-brand-primary`。
        // 这条线在深色主题下**就是近白的**：官方主题里 `--dsw-alias-brand-primary`
        // 深色取 `--dsw-static-neutral-bluish-50`、浅色取 `neutral-bluish-1000`。
        // 因此「点击后底面出现白色底线」不是画错了，是那支色本身在深色下接近白。
        //
        // 改成**浅色胶囊**（用户选定的形态）：
        //   · 去掉 `border-bottom`（含那条 transparent 占位）与下划线选中态；
        //   · 常态无底；hover 升一档 `interactive-bg-hover`；
        //   · 选中态用 `interactive-bg-active`（比 hover 再实一档）+ 主字色 + 600 字重。
        //     两者分档是为了**同时看得见 hover 与选中** —— 若两态同色，鼠标划过未选中的
        //     tab 会让人以为它已被选中。
        //   · `align-items` 从 flex-end 改回 center：没有下划线要对齐了，胶囊居中即可。
        // ── 0.19.38（用户 2026-09-27 原话）：「切换设置标签页时候，这一行离分割线的
        //     距离不够，参考官方 dsh 常见的文字和线的分隔做好框与线的距离」───────
        //
        // 实测官方同类「文字 + 底线」的分隔栏（逐字取自本机已装包）：
        //   dsh-client-ui-settings-plugins 的 .pbvGtq_tabs{border-bottom:.5px solid
        //     var(--dsw-alias-border-l2); align-items:flex-end; gap:22px}
        //   …/                  .pbvGtq_tab{padding:7px 1px 9px; font-size:13px}
        //   即**文字底边到线 = 9px**，且 tab 是**纯文字**（background:0 0; border:0）。
        //
        // 我们的数字本来也是 9px（tab 的 padding 5px + 容器 padding-bottom 4px），
        // 但形态不同：本实现是**浅色胶囊**（0.19.31 用户选定的形态），于是贴线的
        // 不是文字而是一块**有色块的矩形** —— 色块底边到线只剩 4px，看起来就「太近」。
        // 所以修的不是「把 9 调大一点」，而是**按色块重新定距**：容器 padding-bottom
        // 4 → 10px（色块底到线 10px，文字底到线 5+10 = 15px）。
        // 两处间距都大于官方的 9px —— 色块比文字更「重」，需要更多呼吸空间才不显得挤。
        //
        // `overscroll-behavior-x:contain`（同一条的用户第二问）：见下面滚轮监听的说明。
        ".hwb-settings-tabs{display:flex;gap:4px;align-items:center;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;overscroll-behavior-x:contain;padding-bottom:10px;border-bottom:.5px solid var(--dsw-alias-border-l2,#e5e7eb);margin:4px 0 12px}",
        ".hwb-settings-tabs::-webkit-scrollbar{display:none;width:0;height:0}",
        ".hwb-settings-tab{flex:none;border:none;background:none;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#6b7280);padding:5px 12px;border-radius:999px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;transition:background .12s ease,color .12s ease}",
        ".hwb-settings-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-primary,inherit)}",
        ".hwb-settings-tab.on{background:var(--dsw-alias-interactive-bg-active,#8883);color:var(--dsw-alias-label-primary,inherit);font-weight:600}",
        ".hwb-settings-tab-count{font-size:11px;line-height:16px;padding:0 6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,#8885);color:var(--dsw-alias-label-tertiary,#8a8f98);font-weight:400}",
        ".hwb-group{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary,inherit);margin:16px 0 4px;max-width:100%;overflow-wrap:anywhere}",
        ".hwb-group.first{margin-top:16px}",
        // 0.19.37：标题行（站点名在左、健康度圆点在右上角）。用户指定的圆点位置。
        ".hwb-group-row{display:flex;align-items:center;justify-content:space-between;gap:8px}",
        // 分隔靠间距：行间距 8px（§4.4）取代原来的 1px 底线。
        // gap 同时承担「分组内行距」，因此这里用 row-gap 让相邻两行分开。
        ".hwb-row{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;padding:8px 0}",
        ".hwb-row-label{flex:0 0 96px;min-width:96px;max-width:100%;font-size:13px;line-height:20px;padding-top:6px;color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere}",
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
        //
        // ── 0.19.31（用户 2026-09-27 原话）：「就是提示词模板那里，他的框都超出来了」──
        // 成因与 0.19.7 的输入框**同一个**：`.hwb-site-prompt-path` 是 `display:block;
        // width:100%`，而这里缺 `box-sizing:border-box` ⇒ `width:100%` 按**内容盒**算，
        // 再加左右 padding 各 8px 就比 `.hwb-site-prompt` 卡片的内容盒宽 16px。
        // 卡片没有 `overflow:hidden`，于是那条路径框**探出卡片右缘**。
        // 这条规则在仓库里已经写死过一次（见上面 `.hwb-model-select` 那段注释的
        // 「输入框超出卡片框！」），这次是同一个盒子模型缺陷在路径读数上复发。
        ".hwb-filepath{box-sizing:border-box;flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;padding:2px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,#8881);color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        // 0.19.36：`.hwb-hint` 加换行保护（用户：「完全没有适配好边框！请你全局检测
        // 哪里的报错会突破所在元素范围的一并修复」）。
        //
        // 它是**所有行内提示与报错的公共载体**（80+ 处调用），而此前没有任何换行规则：
        // 一句长报错（如带完整路径的 JSON）会整行撑出卡片右缘。`overflow-wrap:anywhere`
        // 而不是 `word-break:break-all`：前者优先在词边界断，只在**没有可断点**时才硬断
        // （Windows 路径、JSON、URL 正是那种没有空格的长串），可读性更好。
        ".hwb-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin:4px 0 0;min-width:0;max-width:100%;overflow-wrap:anywhere}",
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
        ".hwb-site-name{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit);max-width:100%;overflow-wrap:anywhere}",
        ".hwb-row-actions{display:inline-flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}",
        ".hwb-row-actions button{height:28px;line-height:26px;padding:0 12px;font-size:12px;border-radius:14px}",
        // 破坏性动作（目前的唯一一处是账户行的「删除」，0.19.59）：只把**文字颜色**
        // 换成错误态 token，几何与其余四颗按钮逐像素相同——破坏性不该靠「更大更红
        // 的块」表达（那会抢走正常动作的注意力），而该靠位置（排在最右）+ 二次确认
        // + 一行 hover 说明共同承担。token 走官方语义名，不自己写色值。
        ".hwb-row-actions button.danger{color:var(--dsw-alias-state-error-primary,#93443e)}",
        ".hwb-row-actions button.danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8881)}",
        ".hwb-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;background:var(--dsw-alias-label-tertiary,#9aa0a6)}",
        ".hwb-dot.ok{background:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-dot.bad{background:var(--dsw-alias-state-error-primary,#93443e)}",
        // 0.19.37：黄色档（部分账户可用）。用户原话「黄就是有可以有不可以」。
        // token 取自官方白名单里的 --dsw-alias-state-warn-primary（见 test/client-render
        // 的官方 token 家族断言），不凭直觉编名字。
        ".hwb-dot.warn{background:var(--dsw-alias-state-warn-primary,#a16207)}",
        // 账户头像（0.14.8）：28×28 圆框 + 外圈状态环。
        // 尺寸取自 doc/research/agent-ui-design-references.md §4.4「账户头像 28×28 圆」
        // （与图标按钮同尺寸，视觉对齐）。圆角用 50% 而非固定 px——等比圆框。
        // 状态环用 `border` 实现（而不是 outline/box-shadow）：border 参与布局，
        // 三种状态的框大小恒定，切换时不会让整行跳动。
        // 颜色**不是唯一载体**：aria-label/title/可见文本都带状态，见 SiteAccounts.
        // `.hwb-avatar-glyph` 与 `.hwb-catalog-ico` 都是**同尺寸叠层**的底图：标记先画、头像
        // 绝对定位盖在上面（0.19.61）。三处头像挂点（设置页账户行 / 目录卡片 / 目录下拉）
        // 共用「容器 overflow:hidden + 头像绝对定位」这一套，因此「有头像」与「回落标记」
        // 占的像素完全相同，任何一种失败都不会把整行挤变形。
        //
        // ⚠ `overflow:hidden` 不是装饰：`SiteGlyph` 的画布是 `size + 8`（它自己的居中余量，
        // 见 SiteGlyph 内 `const box = size + 8`）。放进 26px 身份盒时那个 34×34 的画布
        // **会从盒子里溢出来**——用户看到的「矢量图边边角角露出来/头像旁边多一块」
        // 正是它。裁掉溢出后，矢量按盒子边缘对齐，头像也盖得干净。
        ".hwb-avatar{position:relative;overflow:hidden;width:28px;height:28px;padding:0;flex:none;border-radius:50%;cursor:pointer;background:transparent;display:inline-flex;align-items:center;justify-content:center;border:2px solid var(--dsw-alias-label-tertiary,#9aa0a6)}",
        ".hwb-avatar.ok{border-color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-avatar.dead{border-color:var(--dsw-alias-state-error-primary,#93443e)}",
        ".hwb-avatar.picked{box-shadow:0 0 0 2px var(--dsw-alias-label-primary,#1f2328)}",
        ".hwb-avatar:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px}",
        // 头像内层（0.16.33）：现在装的是 SiteGlyph 的 svg（size 12 → 画布 20px），
        // 因此必须是 inline-flex 居中，而不是靠 font-size/line-height 摆一个字符。
        // 两者对文字标记同样成立（SiteGlyph 的文字分支也是 svg），所以这一条
        // 同时覆盖有官方矢量与只有文字标记的站点，不需要第二条规则。
        //
        // 0.19.61：`.hwb-avatar-img` 加 `position:absolute`（与 `.hwb-catalog-img` 同口径）。
        // 旧实现缺这一条 ⇒ img 与 glyph 并排挤在 28px 圆框里，头像看起来「没渲染」。
        // `inset:0` + `object-fit:cover` 让它铺满圆框、盖住底下的矢量标记。
        ".hwb-avatar-img{position:absolute;inset:0;width:100%;height:100%;border-radius:50%;object-fit:cover;flex:none}",
        ".hwb-avatar-glyph{display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary,inherit);pointer-events:none}",
        // 花名册那组 `.hwb-roster*` 类名随设置页「正在运行（子代理 / Team）」卡
        //（0.19.x）一并删除——它们的唯一消费者是 AgentRoster，留着就是没人用的样式。
        // 0.19.37：`.hwb-site-state` 三条已删。它画的「已登录 / 未登录 / 待检查」
        // 徽章被用户要求改成标题行右上角的**三色圆点**（.hwb-dot.ok/.warn/.bad）。
        // 留着规则而调用点已删 = 死 CSS，下一个人会以为还能从某处渲染出来。
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
        // ── 0.19.31（用户 2026-09-27 原话）：「等待时间展开的面板错误的透明修复，和官方一样」──
        // 面板底色 `var(--dsw-specific-menu)` **本身是半透明的**（浅色 #f8f9fa94、深色
        // #30313680，见官方主题 design-platform 段），官方同一块面板之所以看起来是实体，
        // 靠的是**两条同进同出的配套声明**，而本插件上一版两条都漏了：
        //   · `backdrop-filter:var(--dsw-menu-backdrop-filter)` —— blur(40px) saturate(150%)，
        //     把背后的聊天文字糊掉。**漏掉它，半透明底就等于「直接透字」**，这正是用户
        //     看到的「错误的透明」。
        //   · `--dsw-elevation-stroke-color:var(--dsw-alias-border-l1)` —— 官方高层级表面
        //     设 `border:0`，那道 0.5px 发丝边由 elevation 的描边档画出来。
        // 取证（逐字比对，不是照截图量的）：官方
        // `dsh-client-ui-chat/lib/client.js` 的 `css$4`（stat-dialog.module.css 的
        // `.bRhRbq_panel`）与 `dsh-client-ui-conversation` 的 `.lXshSW_root`、
        // `._7yHdaG_panel:before` 三处写法一致；官方主题 README 亦记明这一约定。
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
        ".hwb-waitpanel{position:fixed;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);padding:16px;border-radius:12px;border:0;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,12px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px));cursor:default;text-align:left}",
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
        ".hwb-site-prompt-name{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit);max-width:100%;overflow-wrap:anywhere}",
        ".hwb-site-prompt-variant{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);max-width:100%;overflow-wrap:anywhere}",
        ".hwb-site-prompt-pathrow{display:flex;align-items:center;gap:8px;min-width:0}",
        // 0.19.31：路径与「查看」同一行 —— 路径**可伸缩**（flex:1 1 auto + min-width:0
        // 才能被压缩，`white-space:nowrap` + `text-overflow:ellipsis` 才会真的出省略号），
        // 按钮固定不缩。旧写法 `flex:none;width:100%` 是「独占一行」时的口径，
        // 放进 flex 行里会把按钮挤出去。
        ".hwb-site-prompt-path{flex:1 1 auto;display:block;min-width:0;max-width:100%}",
        // 「查看」按钮：跟账户行那套 28px 小按钮同一刻度（`.hwb-row-actions button`），
        // 不参与收缩、不换行 —— 否则窄面板下它会被压成两个字挤在一起。
        ".hwb-filepath-open{flex:none;white-space:nowrap;height:28px;line-height:26px;padding:0 12px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:.5px solid var(--dsw-alias-border-l3,#8885);border-radius:14px;cursor:pointer;transition:background .12s ease}",
        // 站点页那颗按钮在 `.hwb-row` 里，而 `.hwb-row button` / `.hwb-settings button`
        // 是 32px 高。两者的特指度相同（都 0,1,1），因此靠**同选择器形状 + 更靠后**
        // 覆盖：`button.hwb-filepath-open` 与它们同权，位置在后即胜。
        // 不这样写就会变成「全局页 28px、站点页 32px」两颗不一样高的同款按钮。
        "button.hwb-filepath-open{height:28px;line-height:26px;padding:0 12px;font-size:12px;border-radius:14px}",
        ".hwb-filepath-open:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}",
        ".hwb-filepath-open:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px}",
        ".hwb-site-prompt details{margin-top:0}",
        ".hwb-site-prompt summary{cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-site-prompt pre{max-height:240px;margin-top:6px}",
        // 0.19.31（用户 2026-09-27）：「…让增量也通过上面一样的框展示，然后两框注意间隔」。
        // 「框」本身复用 `.hwb-import pre`（两块正文都是 <pre>，不另立一套样式）；这里只
        // 负责**间隔**：`gap:8px` 与 `.hwb-import` / `.hwb-site-prompt` 同一档。
        // 标题行在框内（`.hwb-prompt-frame`）清零自己的 `margin-top`，否则
        // `.hwb-hint` 的 `margin:4px 0 0` 会与 gap 叠加，两框之间的间距就不是这一个数了。
        ".hwb-site-prompt-frames{display:flex;flex-direction:column;gap:8px}",
        ".hwb-prompt-frame{display:flex;flex-direction:column;gap:4px;min-width:0}",
        ".hwb-prompt-frame>.hwb-hint{margin:0}",
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
        ".hwb-tab-title{display:inline-flex;align-items:center;gap:5px;min-width:0}",
        ".hwb-tab-title-glyph{display:inline-flex;align-items:center;justify-content:center;flex:none}",
        ".hwb-tab-title-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
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
        // 0.17.0：参考官方 GuideBody，做到进入网站选择界面后垂直水平居中。
        //
        // 0.19.61 修**真缺陷**（用户 2026-10-04 原话：「右侧 tab 展开时候，窗口够大就没问题，
        // 但是缩小窗口就能看到，顶部置顶了，已经够大时候就已经是偏上了」）。
        //
        // ## 旧写法为什么必然出这个症状
        //
        // 旧规则是官方 GuideBody 的逐字复制：`justify-content:center` + `min-height:100%`
        // + `:after{flex:0 10%}`。那三件在**官方那个容器里**成立，因为 guide 的内容只有
        // 一两行、永远装得下。但本站点目录是**十行胶囊**，在窄窗口/矮窗口下内容高于
        // 容器 ⇒ 竖直居中（`justify-content:center`）会把**顶部溢出到容器之外**，
        // 而宿主 `.P3OORG_tabBody` 是 `overflow:hidden`（官方原文，不可改）⇒
        // 溢出的那几行**被裁掉且无法滚动到达**。这就是「顶部置顶/被切」。
        //
        // 「窗口够大时也偏上」是同一个原因的另一半：`:after{flex:0 10%}` 只在**有富余
        // 空间**时才分到 10%，而 `justify-content:center` 已经把富余空间从两端平分过一次，
        // 于是视觉重心被那 10% 的下方留白往下推之前就被居中了——富余不足时看起来就是偏上。
        //
        // ## 为什么改成 auto margin（而不是继续抄 GuideBody）
        //
        // `margin:auto` 是**唯一**同时满足两件事的写法：
        //   · 有富余空间时，上下 auto margin 等分 ⇒ **垂直居中**（视觉与旧的居中完全一致）；
        //   · 空间不足时，auto margin 归零 ⇒ 内容从容器顶部开始、**可以自然滚动/
        //     不被裁**（`justify-content:center` 做不到这一条，那是它的已知行为）。
        // 因此 `min-height:100%` 保留（撑满才能居中）、`overflow-y:auto` 补上
        //（矮窗口下能滚到被挤出去的部分），`:after` 那 10% 的假留白**删掉**——
        // 它本来就是「富余空间不够时反而把内容推偏」的来源。
        ".hwb-catalog{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:14px;min-height:100%;padding:0 clamp(8px,3vw,24px);color:inherit;overflow-y:auto}",
        // 上下 auto margin 才是居中本体（见上）；它同时让「装不下」时归零为可滚动。
        //
        // 0.16.39：列表宽度与首屏网格**同一口径**（官方 guide 的 380px + 居中）。
        // 官方的 `.entryCell` 就是 `width:380px;max-width:100%`，所以「目录页」与
        //「首屏选站点」在同一块面板里读起来是同一列宽——这也是用户说的
        //「宽度需要和官方一致」在目录页那一半的对应实现。
        //
        // ⚠ 水平与垂直的 auto 必须写在**同一条**规则里。旧实现这里另有一条
        // `margin:0 auto`（0.16.39 立的），它会覆盖掉垂直居中的 auto——两条同名
        // 规则只有后者生效，而 0.19.61 之前没人注意到「居中是靠哪一条成立的」。
        ".hwb-catalog-list{display:flex;flex-direction:column;gap:8px;width:380px;max-width:100%;margin:auto}",
        ".hwb-site-card{box-sizing:border-box;min-width:0;border:.5px solid var(--dsw-alias-border-l4,#8884);background:var(--dsw-alias-bg-layer-1,#fff);border-radius:24px;align-items:stretch;width:100%;display:flex;overflow:hidden}",
        ".hwb-site-main{text-align:left;border-radius:24px 0 0 24px;flex:1;justify-content:flex-start;gap:14px;min-width:0;height:auto;min-height:56px;padding:14px 20px}",
        ".hwb-site-text{flex-direction:column;gap:3px;min-width:0;display:flex}",
        ".hwb-site-title{color:var(--dsw-alias-label-primary,inherit);white-space:nowrap;text-overflow:ellipsis;font-size:15px;line-height:1.4;overflow:hidden}",
        ".hwb-site-desc{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary,#8a8f98));white-space:nowrap;text-overflow:ellipsis;font-size:13px;line-height:1.4;overflow:hidden}",
        ".hwb-site-trigger{border-radius:0 24px 24px 0;flex:none;align-self:stretch;width:44px;height:auto;padding:0}",
        // 账号下拉里的头像与回落标记（0.19.4）。尺寸取官方 Menu 的 leading icon 档
        // （figma `.Menu_cell` gap 8、图标 16），圆框是为了让真实头像与站点标记
        // 在**同一列宽**里对齐——两种来源混排时，列宽不齐比图标不精致更显眼。
        // 账户下拉行里的身份图（0.19.61）：与另两处头像挂点同一套几何——标记当底图、
        // 头像绝对定位盖在上面。`overflow:hidden` 同样是为了裁掉 SiteGlyph 的
        // `size+8` 画布余量（16px 盒里画布是 24×24，不裁就会溢到相邻文本上）。
        ".hwb-acct-img{position:absolute;inset:0;width:16px;height:16px;border-radius:50%;object-fit:cover;flex:none;z-index:1}",
        ".hwb-acct-glyph{position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;overflow:hidden;border-radius:50%}",
        // 下拉图标那一格的定位父元素（0.19.61）：头像绝对定位要挂在它上面。
        // 16×16 + `overflow:hidden` 与另两处头像挂点同一口径。
        ".hwb-acct-face{position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;overflow:hidden;border-radius:50%}",
        // 卡片左端的**身份盒**（0.19.59）：主头像与站点矢量标记在同一个 26px 圆槽里
        // **重合**（头像绝对定位盖住标记），于是「抓到头像」与「回落标记」两种情况
        // 占宽逐像素相同——卡片宽度与标题起始位置不会因为身份读没读到而跳动。
        //
        // 0.19.47 的注释曾声称这个重合已经成立，但当时两者是**并排**放在 flex 行里的
        //（`<img>` + `SiteGlyph` 各一份），抓到头像时两个图标会同时画出来；注释描述的是
        // 意图而不是实现（本仓库记过多次的同一形状）。本条的 `position:absolute` 才让
        // 那句承诺成立，`onError` 藏掉 img 也才真的「露出下面的标记」。
        // 0.19.61：`overflow:hidden` 裁掉 SiteGlyph 的 `size+8` 画布余量（26px 盒里是 34×34），
        // 否则矢量会从盒子四角溢出来——那正是用户报的「边边角角出来」。
        ".hwb-catalog-face{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px}",
        ".hwb-catalog-ico{position:relative;width:26px;height:26px;overflow:hidden;border-radius:50%}",
        // 主头像：绝对定位盖在矢量标记**上面**（DOM 顺序也是标记先画，见 SiteCatalogBody）。
        // `z-index` 显式写在头像这一侧：两者都是定位元素，靠 DOM 顺序已经够，
        // 但显式一层能让后来改顺序的人不必推理层叠上下文。
        ".hwb-catalog-img{position:absolute;inset:0;width:26px;height:26px;border-radius:50%;object-fit:cover;z-index:1}",
        // 其余账户的叠层缩略图（0.19.59）：绝对定位在身份盒右下角，**不参与排版**，
        // 因此账号多少都不会改变胶囊高度与标题位置。14px 一颗、互相压 5px；
        // 超出上限的账户折成 `+N` 一颗，账户数一个不丢（说明行仍写着总数）。
        ".hwb-catalog-stack{position:absolute;right:-3px;bottom:-3px;display:inline-flex;align-items:center}",
        ".hwb-catalog-stack-item,.hwb-catalog-stack-rest{box-sizing:border-box;width:14px;height:14px;border-radius:50%;overflow:hidden;flex:none;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 0 0 1px var(--dsw-alias-border-l3,#8885);font-size:9px;line-height:1;color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-catalog-stack-item+.hwb-catalog-stack-item,.hwb-catalog-stack-rest{margin-left:-5px}",
        ".hwb-catalog-stack-img{display:block;width:14px;height:14px;border-radius:50%;object-fit:cover}",
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
        ".hwb-act-btn:disabled{color:var(--dsw-alias-label-dimmed,#aaa);cursor:default}",
        ".hwb-act-btn.on{color:var(--dsw-alias-state-success-primary,#2e7d32)}",
        ".hwb-frame-host{position:relative;flex:1;min-height:0;overflow:hidden;z-index:1}",
        ".hwb-browser-frame{display:block;width:100%;height:100%;min-height:0;border:0;background:#fff}",
        ".hwb-frame-status{position:absolute;inset:0;display:grid;place-items:center;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-tertiary,#7a8494);font-size:12px;pointer-events:none}",
        ".hwb-error,.hwb-guide{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#394150)}",
        ".hwb-error p,.hwb-guide p{font-size:12px;line-height:1.7;margin:0;color:var(--dsw-alias-label-tertiary,#8a8f98);max-width:100%;overflow-wrap:anywhere}",
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
        ".hwb-panel-head{font-size:12px;line-height:18px;margin:0 0 4px;color:var(--dsw-alias-label-tertiary,#8a8f98);max-width:100%;overflow-wrap:anywhere}",
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
        ".hwb-kcard-title{font-size:13px;font-weight:500;line-height:1.4;color:var(--dsw-alias-label-primary,inherit);max-width:100%;overflow-wrap:anywhere;max-width:100%;overflow-wrap:anywhere}",
        ".hwb-kcard-desc{font-size:12px;color:var(--dsw-alias-label-tertiary,#666);line-height:1.4;max-width:100%;overflow-wrap:anywhere}",
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
        ".hwb-form-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#93443e);max-width:100%;overflow-wrap:anywhere}",
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
        // 0.19.51：背景色从 `--dsw-alias-brand-subtle`（该 token 在官方主题里
        // **从未被定义**，全树 0 处）改为官方同义写法 `color-mix(in srgb,
        // var(--dsw-alias-brand-primary) 8%, transparent)`——取官方主题里「品牌浅底」
        // 的标准配方（`dsh-client-ui-*` 多处出现同一形状），随主题自动成立。
        // 旧写法的回落值 `#eef2ff` 是硬编码浅色，深色主题下不随主题走。
        ".hwb-review-anchor{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit;font-size:11px;line-height:18px;padding:0 8px;border-radius:9px;cursor:pointer;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);color:var(--dsw-alias-label-secondary,inherit);border:.5px solid var(--dsw-alias-border-l3,#8884)}",
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
        ".hwb-section-title{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);max-width:100%;overflow-wrap:anywhere}",
        ".hwb-notion-desc-textarea{width:100%;box-sizing:border-box;font:inherit;font-size:13px;line-height:1.6;padding:10px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3,#8885);background:var(--dsw-alias-bg-base,#fff);color:inherit;resize:vertical}",
        ".hwb-comments-list{display:flex;flex-direction:column;gap:10px}",
        ".hwb-comment-card{padding:10px 12px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3,#8884);background:var(--dsw-alias-bg-layer-1,#fafafa);display:flex;flex-direction:column;gap:6px}",
        ".hwb-comment-card.resolved{opacity:.65;border-style:dashed}",
        ".hwb-comment-quote{margin:0;padding-left:8px;border-left:3px solid var(--dsw-alias-brand-primary,#3b82f6);font-size:12px;color:var(--dsw-alias-label-secondary,#555);font-style:italic}",
        ".hwb-comment-text{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit);max-width:100%;overflow-wrap:anywhere}",
        ".hwb-comment-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px}",
        ".hwb-comment-time{color:var(--dsw-alias-label-tertiary,#888)}",
        ".hwb-comment-form{display:flex;flex-direction:column;gap:8px;margin-top:8px}",
        ".hwb-quote-preview{display:flex;align-items:center;gap:6px;font-size:12px;padding:6px 10px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);border:.5px solid var(--dsw-alias-brand-primary,#3b82f6)}",
        ".hwb-quote-label{color:var(--dsw-alias-brand-primary,#3b82f6);font-weight:500}",
        ".hwb-quote-val{font-style:italic;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".hwb-btn-close{background:0 0;border:0;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}",
        ".hwb-comment-input-row{display:flex;gap:8px}",
        ".hwb-task-chat-box{border:.5px solid var(--dsw-alias-border-l3,#8884);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-1,#fafafa)}",
        ".hwb-task-chat-history{display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto}",
        ".hwb-chat-msg{font-size:13px;line-height:1.5;padding:6px 10px;border-radius:6px;background:var(--dsw-alias-bg-base,#fff);border:.5px solid var(--dsw-alias-border-l4,#8883)}",
        ".hwb-chat-msg.user{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}",
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
        // 并发会话面板样式（0.19.55）。
        //
        // 这一块**替换**了旧的「并列多会话」样式（`.hwb-compare-*` / `.hwb-col-composer-*`）。
        // 为什么整块删掉而不是改几个色值：旧实现每一列里装的是**自绘的假会话**——自绘的
        // 消息、复刻的 composer（那一整套 `.hwb-col-composer-*` 刻度就是为复刻官方输入框
        // 而存在的）。本轮每一列改渲染**官方自己的会话体**，输入框、消息、模型选择都由
        // 官方那一份提供，所以复刻层连同它的样式一并没有了存在的理由。留下的只有「怎么
        // 摆这些列」这一层，而这一层用户已经验收过，因此判据逐字保留。
        ".hwb-concurrent-panel{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;width:100%;overflow:hidden;box-sizing:border-box}",
        // 页签条：与普通会话顶栏的「对话 / 轨迹」同一套刻度。用户要的是「对齐新会话的
        // 『对话』和『轨迹』」，所以它必须读起来与官方那一行是同一类东西，而不是另一套
        // 自创的胶囊。**用浅色胶囊表达选中**，不画下划线：本仓库 0.19.31 已记过——
        // 深色主题下品牌色的 2px 下划线看起来就是「底面一条白色底线」（用户原话）。
        // 面板正文：撑满剩余高度并**自己滚动**。`min-height:0` 是 flex 子项能真正滚动的
        // 必要条件——没有它，flex 项的最小高度是内容高度，`overflow:hidden` 会把长会话裁掉。
        ".hwb-concurrent{position:relative;display:flex;flex-direction:column;gap:8px;width:100%;flex:1 1 auto;min-height:0;overflow:hidden;padding:12px 12px 0;box-sizing:border-box}",
        // 「+ 加一列」：右上角悬浮置顶（用户第 3 条：删掉顶部那一行工具条，让会话框完整上下）。
        // 它压在列内容之上，所以给 z-index 与半透明底，避免被官方会话体的滚动内容盖住。
        ".hwb-concurrent-fab{position:absolute;top:14px;right:18px;z-index:14;height:28px;padding:0 12px;font:inherit;font-size:13px;line-height:20px;border:.5px solid var(--dsw-alias-border-l3,#8884);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#ffffffd9);color:var(--dsw-alias-label-primary);cursor:pointer;backdrop-filter:blur(8px)}",
        ".hwb-concurrent-fab:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,#00000012)}",
        ".hwb-concurrent-fab:disabled{opacity:.5;cursor:default}",
        // ── 固定列宽 + 观察窗平移（用户 0.19.29 第 3 点）─────────────────────────
        //
        // 不用 grid 等分：那是「列数越多列越窄」，正是用户不要的。这里每列都有**确定的
        // 宽度**（`--hwb-col-width`，由组件按官方常量算出来、三列同一个值），放不下就靠
        // 左右切换看列——所以「3 个会话宽度同步」在结构上成立。
        ".hwb-concurrent-viewport{position:relative;flex:1;min-height:0;overflow:hidden;display:flex}",
        ".hwb-concurrent-columns{display:flex;gap:0;min-height:0;flex:none;transition:transform .18s ease}",
        // 列间「左右间隔」：一个真元素（16px，与平移步长 COL_GAP 同值），平时隐形；
        // 鼠标移到间隔上才画出 1px 竖线（用户第 4 条）。上下不画任何框线。
        ".hwb-concurrent-gap{flex:0 0 16px;position:relative;align-self:stretch}",
        ".hwb-concurrent-gap-line{position:absolute;left:50%;top:10px;bottom:10px;width:1px;margin-left:-.5px;background:var(--dsw-alias-border-l3,#8886);opacity:0;transition:opacity .12s ease}",
        ".hwb-concurrent-gap:hover .hwb-concurrent-gap-line{opacity:1}",
        // 尊重「减少动态效果」偏好：平移是纯装饰性的。
        "@media (prefers-reduced-motion:reduce){.hwb-concurrent-columns{transition:none}}",
        // 左右切换按钮：绝对定位在中间区左右边缘、垂直居中；底色与毛玻璃取自官方胶囊
        // 面板那一对（`specific-menu` + `menu-backdrop-filter`），与官方浮动胶囊同色。
        ".hwb-concurrent-pan{position:absolute;top:50%;transform:translateY(-50%);z-index:11;width:28px;height:28px;padding:0;display:grid;place-items:center;font:inherit;font-size:16px;line-height:1;cursor:pointer;border:none;border-radius:50%;color:var(--dsw-alias-label-secondary);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-soft)}",
        ".hwb-concurrent-pan:hover:not(:disabled),.hwb-concurrent-pan:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}",
        ".hwb-concurrent-pan:disabled{opacity:0;pointer-events:none}",
        ".hwb-concurrent-pan.left{left:6px}",
        ".hwb-concurrent-pan.right{right:6px}",
        // 列：**平时隐形、hover 才浮起一点光**（用户 0.19.29 第 1 点原话：「去除每列对话的
        // 对话框分界，用官方现在的隐形加上鼠标移到后显示一点光线的结构，完全照抄 dsh」）。
        // 本轮改的是「列里装什么」，外观判据没变，因此这一对的取值逐字保留。
        ".hwb-concurrent-col{flex:0 0 var(--hwb-col-width,420px);width:var(--hwb-col-width,420px);background:transparent;border:0;border-radius:12px;display:flex;flex-direction:column;min-height:0;overflow:hidden;transition:background-color .12s ease,box-shadow .12s ease}",
        ".hwb-concurrent-col:hover,.hwb-concurrent-col:focus-within{background:var(--dsw-alias-interactive-bg-hover,#00000008);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3,#8884)}",
        // 列头只放「这是哪条会话」与一个移出按钮，并且平时隐形：用户第 1 点要求上方不占位。
        // 会话身份仍然可见（hover / 键盘进入本列才随那点光一起现形），用户要能核对。
        // 列头 = 官方 header 的**第一段**（0.19.65，用户 2026-10-06：「顶部对应单会话的名称…
        // 那一行的显示」+「你可以做到一摸一样吗」）。官方 header 的标题是**常显**的，所以这里
        // 去掉 0.19.29 那套「hover 才现形」；官方那三块 chip（标准模式 / 后台任务 / 团队）由
        // 三个官方包注册进 `conversation.header` 槽，而该槽的公开投影**不含组件**
        //（`dsh-client-ui-slots/lib/index.js:313`：exported **without components**）⇒ 受支持的
        // 路径下拿不到，只能后续按「复刻」处理（见 doc/research §11）。
        ".hwb-concurrent-col-head{display:flex;align-items:center;gap:8px;flex:none;padding:0 12px;height:44px;box-sizing:border-box}",
        ".hwb-concurrent-col-title{flex:1;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit);opacity:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".hwb-concurrent-col:hover .hwb-concurrent-col-title,.hwb-concurrent-col:focus-within .hwb-concurrent-col-title{opacity:1}",
        ".hwb-concurrent-mini{flex:none;height:24px;padding:0 8px;font:inherit;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;background:transparent;border:none;border-radius:8px;opacity:0;transition:opacity .12s,background-color .1s}",
        ".hwb-concurrent-col:hover .hwb-concurrent-mini,.hwb-concurrent-col:focus-within .hwb-concurrent-mini{opacity:1}",
        ".hwb-concurrent-mini:hover{background:var(--dsw-alias-interactive-bg-hover-solid,#00000012);color:var(--dsw-alias-label-primary)}",
        // 列体：官方会话体自己带滚动容器（`[data-conversation-scroll]`），这里只保证高度
        // 确定，并把**官方那一份**撑满本列（`>*` 只作用于直接子节点，不会串到别处）。
        ".hwb-concurrent-col-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
        ".hwb-concurrent-body{position:relative;display:flex;flex-direction:column;flex:1;min-height:0;width:100%;overflow:hidden}",
        // 「开工指令」面板（0.19.64）：一列的独立工作区（git worktree + 分支）指令。
        // 它属于**面板**而不是列：指令是给用户复制走的，摊在列里会把列挤变形。
        ".hwb-concurrent-brief{margin:8px 12px 0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3,#8884);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#00000005)}",
        ".hwb-concurrent-brief-head{display:flex;align-items:center;gap:8px;justify-content:space-between;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit)}",
        ".hwb-concurrent-brief-body{margin:6px 0 0;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,inherit)}",
        ".hwb-concurrent-body>*{flex:1 1 auto;min-height:0;min-width:0}",
      ].join('');
      document.head.appendChild(style);
      const disposers = [() => style.remove()];
      // `warn` 定义在本文件**工厂作用域**（见文件开头那一处）：`ConcurrentPanel` 等
      // 定义在 `apply()` 之外的函数也要用它，声明在这里就会变成 ReferenceError。
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
      //     指出「参考错误了」。本插件的 Team 是**多条各自独立的会话并排**，
      //     0.19.55 起由左栏「并发会话」行 + 中央面板提供（见下方注册处与
      //     ConcurrentColumns），完整理由见下方「Team 面板标签页：已删除」。
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
      /**
       * 站点标签页的 chip 内容：**dwb 标记 + 站点名**（0.19.39）。
       *
       * 用户要「右侧 tab 界面两个：标签页和主界面大图标」。这里有一点必须说清楚：
       * 官方 `SidebarRightTabDefinition` **没有 `icon` 字段**（见 tab-registry.d.ts）
       * ——类型定义里的图标只出现在 `guide[].icon`。所以标签页 chip 本身不能
       * 「注册一个图标」，**能挂的是它的标题内容**：`sidebar.right.pane.tab.title`
       * 是 keyed 槽，返回什么节点就画什么。因此这里把标记画进标题行，得到同样的
       * 视觉效果，且**没有偏离官方契约**（不改 shell、不注入 DOM）。
       *
       * 标记与文字同色（`currentColor`），随选中态一起变——写死颜色会在选中时
       * 露出一块不协调的灰。
       */
      const SiteTabTitle = (props) => {
        const sid = siteTabParams(props).siteId;
        const label = sid ? siteName(sid) : 'Web 站点';
        return h('span', { className: 'hwb-tab-title' },
          h('span', { className: 'hwb-tab-title-glyph', 'aria-hidden': 'true' }, h(DwbMark, { size: 13 })),
          h('span', { className: 'hwb-tab-title-text' }, label));
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
              // 右栏 guide 的**主界面大图标**（用户要的第 2 处）。
              // 契约：`SidebarRightGuideEntry.icon?: ComponentType<IconProps>`——
              // 不给时官方画一个立方体占位符，那正是「默认图标」的来源。
              icon: DwbMark,
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
      // 即：本插件的 Team = **若干条各自独立的会话并排**（用户 0.19.55 起要求它们
      // 是**真官方会话**：每列一个独立 sessionId），落点是中央区，不是右栏的一份花名册。
      // 官方 AgentTeams 描述的是「同一 checkout 里的多个 agent 会话」——那是官方
      // 包自己的模型，与本插件「多站点并排」的目标不是一回事，照抄它等于把别人的
      // 概念装进这个插件。
      //
      // 正解是 0.19.55 的左栏「并发会话」行 + 中央 `main` 面板（`ConcurrentPanel` /
      // `ConcurrentColumns`，见下方注册处）。这个标签页连同它的 `TEAM_ID` / `TEAM_KIND`
      // 常量一并删除；**不得复活**——护栏见 `test/team-compare.test.mjs` 与
      // `test/client-render.test.mjs`。
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
      //
      // ## 0.19.51：注册选项必须带 `id`——缺了它**整条注册在真实宿主里被拒绝**
      //
      // 这个座位在官方是 **list** 型（`dsh-client-ui-sidebar-right` 声明
      // `sidebar.right.tab.menu.item: { kind:'list' }`），而 `SlotCore.register`
      // 对 list 座位硬性要求 `options.id`（`dsh-client-ui-slots/lib/index.js` 的
      // `list slot "…" requires options.id` 分支）。0.19.51 之前这里不带 `id`，
      // 用真实 SlotCore 复跑：**必然抛错** ⇒ 两项菜单在真机上**从未出现过**，
      // 而本插件自己的 try/catch 把错误降级成一条 warn——「静默少两块 UI」，
      // 与 `iconOf` 注释里记的 0.1.7 图标改名是同一族事故。
      //
      // 为什么护栏当年没拦住：`client-render.test.mjs` 的桩按 name 收组件、
      // 不校验 list 座位的必填字段，于是「桩放行了真实校验器会拒的形状」。
      // 桩已同步升级（按 kind 校验），并有一条反向验证钉住「缺 id 必红」。
      // id 前缀 `webcode-` 与本插件其它注册 id 同族，双项互不相同。
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
            { name: 'sidebar.right.tab.menu.item', id: 'webcode-reload' },
            menuItem('reload', '刷新网页', () => actions.reload()),
          ));
        } catch (e) { warn('tab menu item (reload)', e); }
      });
      own(() => {
        try {
          return ctx.slots.inject('sidebar.right.tab.menu.item', () => ctx.slots.register(
            { name: 'sidebar.right.tab.menu.item', id: 'webcode-window' },
            menuItem('window', '切换独立窗口', () => actions.toggleWindow()),
          ));
        } catch (e) { warn('tab menu item (window)', e); }
      });

      // ---- 左栏「并发会话目录」：找回过去的组（0.19.65，用户 2026-10-06）------------
      //
      // 用户原话：「像是左侧新增同『工作区』面板视图并级的目录显示并发会话那样！
      // 否则怎么找回已过去的并发会话！！！」。官方契约给了做法（`ui-cordis-client-runner`
      // 对 sidebar.panellist 的说明原文：「**Each list id addresses the matching main panel**」）：
      // 每一组 = 一条 `sidebar.panellist` 行 + 一个**同名 `main` key**；点行 → 打开那个面板。
      // 主入口（并发会话）负责**新建**一组；这些历史行负责**找回**。
      //
      // 三个细节都是有理由的，别省：
      //   · **幂等**：已登记的组直接跳过（面板建完新组后会再喊一次 `syncGroupRows`）；
      //   · **子槽名每组唯一**：`conversation` 那类槽名全局唯一，重复声明会抛
      //     `slot "X" is already declared`，所以列正文槽名带上组 id；
      //   · **全程 try/catch**：目录里任何一处失败都只损失那一行，不影响主入口。
      const groupRows = new Map();
      const syncGroupRows = () => {
        try {
          for (const g of readConcurrentGroups()) {
            const key = CONCURRENT_GROUP_PREFIX + g.id;
            if (groupRows.has(key)) continue;
            const colSlot = CONCURRENT_COLUMN_SLOT + ':' + g.id;
            const offRow = (() => {
              try {
                return ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
                  name: 'sidebar.panellist', id: key, order: 31,
                  // 行文字带列数：一眼能看出那一组有几条会话（找回来时最要紧的信息）。
                  label: () => '并发会话 · ' + g.ids.length + ' 列',
                }, ConcurrentPanelIcon));
              } catch (e) { warn('concurrent group row', e); return null; }
            })();
            const offPanel = (() => {
              try {
                return ctx.slots.inject('main', () => ctx.slots.register({
                  name: 'main', key,
                  children: { [colSlot]: { kind: 'single', scope: 'session' } },
                }, (props) => h(HwbBoundary, { label: '并发会话（历史组）' },
                  h(ConcurrentPanel, {
                    ...props,
                    sessions: ctx.sessions,
                    layout: layoutFaceOf(ctx),
                    slotName: colSlot,
                    groupKey: 'group:' + g.id,
                    hwbGroup: g,
                    hwbSyncGroups: syncGroupRows,
                  }))));
              } catch (e) { warn('concurrent group panel', e); return null; }
            })();
            const offCol = (() => {
              try {
                return ctx.slots.inject(colSlot, () => ctx.slots.register(
                  { name: colSlot },
                  (props) => h(ConcurrentColumn, props),
                ));
              } catch (e) { warn('concurrent group column', e); return null; }
            })();
            groupRows.set(key, () => {
              try { if (offCol) offCol(); } catch (e) { /* 卸载期失败不影响其余注销 */ }
              try { if (offPanel) offPanel(); } catch (e) { /* 同上 */ }
              try { if (offRow) offRow(); } catch (e) { /* 同上 */ }
            });
          }
        } catch (e) { warn('concurrent group rows', e); }
      };
      own(() => {
        syncGroupRows();
        return () => {
          for (const off of groupRows.values()) { try { off(); } catch (e) { /* 同上 */ } }
          groupRows.clear();
        };
      });

      // 会话头角落席位让官方 dsh-client-ui-sidebar-right 持有（其 ExpandButton
      // 与本面板同 store、同 toggleExpanded 职责，重复声明反酿席位冲突）。

      // ---- 并发会话：左栏入口 + 中央面板（0.19.55，用户指令）--------------------
      //
      // ## 为什么从「会话内视图」搬到「左栏 + 中央面板」
      //
      // 0.17.3–0.19.54 期间，本插件的「并发」是 `conversation.view` 上的一个**视图页签**
      // （id `webcode-compare-view`）——因为那时每一列只是「自绘的假会话」并排，渲染在
      // 会话里没有任何问题。本轮每列改渲染**官方自己的会话体**，而官方会话体只能渲染在
      // 官方会话**之外**：`renderFactorySlot` 会检查渲染祖先，在 `conversation.content`
      // 的子树里再渲染同名 factory 会当场抛 `recursive render of factory
      // 'conversation.content'`（dsh-client-ui-renderer/lib/client.js:1049）。
      // 所以那个会话内页签**必须删掉**——这正是用户那句「将原本在会话中的『并发』删除」
      // 的技术原因，两条要求在这里是同一件事。
      //
      // ## 位置：与「新会话」同级的左栏行
      //
      // 用户原话：「现在能够让左侧显示『新会话』下面新建一摸一样『并发会话』」。
      // 走官方 `sidebar.panellist`（list、scope root）：按钮由 shell 自己画（Tooltip /
      // aria-current / 折叠成 56px 轨道时的图标 / 选中高亮都在），而 shell 的渲染顺序
      // 本来就是 logoRow → 新会话 → panelList → 工作区，所以「新会话下方」是**结构保证**，
      // 不是靠抢位置。
      //
      // 两半必须成对：官方契约原文是「Each list id addresses the matching main panel」，
      // 只注册侧栏那一半的话，用户点一下就会被 layout service 拒（main panel 未注册）。
      // ⚠ 面板 id 与子槽名是**工厂作用域**的常量（见 ConcurrentColumns 上方那一段注释：
      //   声明在这里会让面板挂载 effect 读不到 ⇒ `ReferenceError` 被吞成 warn ⇒ 守卫静默失效）。
      own(() => {
        try {
          return ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: CONCURRENT_PANEL_ID,
            // order 30：排在官方内置行（默认 0）之后、任务板（40）之前，不与任何行抢位。
            order: 30,
            label: () => '并发会话',
          }, ConcurrentPanelIcon));
        } catch (e) { warn('sidebar.panellist entry (concurrent)', e); }
      });

      // 中央面板本体 + 列正文一起注册，**顺序在同一个回调里定死**。
      //
      // 为什么把子槽注册嵌在父槽的回调里、而不是并列两条 `own(...)`：`webcode-concurrent.column`
      // 是 `main` 这一条注册**声明的**子槽，而 SlotCore 拒绝向未声明的槽注册
      //（`dsh-client-ui-slots/lib/index.js:165`：slot "…" is not declared）。
      // 两条并列的 `inject` 谁先跑取决于宿主怎么调度 `inject` 回调——那是一条
      // 不该由我们来赌的时序。嵌进来之后，「先声明、后注册」成为**结构性**的。
      own(() => {
        try {
          return ctx.slots.inject('main', () => {
            const offPanel = ctx.slots.register({
              name: 'main',
              key: CONCURRENT_PANEL_ID,
              // 声明一个 **session 作用域**子槽，是本面板能拿到官方 `SessionProvider` 与
              // `renderSlot` 的唯一途径（dsh-client-ui-renderer/lib/client.js:732-739）。
              children: { [CONCURRENT_COLUMN_SLOT]: { kind: 'single', scope: 'session' } },
            // 整个条目**再包一层**插件自建边界（0.19.63）。0.19.62 的边界包在
            // `ConcurrentPanel` 内部，而「构造 ConcurrentPanel 元素本身」抛错时它够不着
            // ——真机空白正是这一种形态（组件函数里读 `ctx.layout` 即抛）。边界提到条目
            // 注册处之后，**面板级崩溃也变成可读文本**，不再只能靠 F12。
            }, (props) => h(HwbBoundary, { label: '并发会话面板' },
              h(ConcurrentPanel, {
                ...props,
                sessions: ctx.sessions,
                // 经 layoutFaceOf 读，缺席时降级为「没有守卫」（见该函数的注释）。
                layout: layoutFaceOf(ctx),
                slotName: CONCURRENT_COLUMN_SLOT,
                groupKey: 'panel',
                // 主入口建完一组后，让左栏「并发会话目录」立刻多出那一行（0.19.65）。
                hwbSyncGroups: syncGroupRows,
                // 「↗ 用官方视图打开」：官方 header 那几块 chip（标准模式 / 后台任务 / 团队）只由
                // 官方会话视图渲染（槽的公开投影不含组件，见 doc/research §11），所以受支持的做法
                // 是把这一条会话**交回官方视图**——`uiWorkspace.openSession`。失败只 warn，不影响面板。
                hwbOpenOfficial: (sid) => {
                  try { ctx.uiWorkspace.openSession(sid); } catch (e) { warn('open official view', e); }
                },
              })));
            // 一列的正文（session 作用域）：渲染官方会话体，见 ConcurrentColumn 的注释。
            const offCol = ctx.slots.inject(CONCURRENT_COLUMN_SLOT, () => ctx.slots.register(
              { name: CONCURRENT_COLUMN_SLOT },
              (props) => h(ConcurrentColumn, props),
            ));
            return () => {
              try { offCol(); } catch (_) { /* 卸载期失败不影响其余注销 */ }
              try { offPanel(); } catch (_) { /* 同上 */ }
            };
          });
        } catch (e) { warn('main panel body (concurrent)', e); }
      });

      return () => disposers.reverse().forEach(d => { try { d(); } catch (_) {} });
    }
    const exports = { name: 'webcode-bridge-client', inject, apply };
    if (module) module.exports = exports;
    return exports;
  },
});
