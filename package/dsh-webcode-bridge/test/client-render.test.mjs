// client-render.test.mjs — 右栏组件渲染护栏（问题②：面板全白）。
//
// 背景：0.11.0 把「独立窗口」状态从「开着的站点 id（字符串/null）」改成多站点聚合
// 对象（`winOpen[siteId]?.open`），初始 useState 也换成了 {}，但 winState() 里
// `setWinOpen(openSite)` 仍塞字符串/null。于是没有独立窗口（null）时，渲染执行
// `null['deepseek']` 抛 TypeError，整块右栏 React 树崩掉 → 面板点开全是空白。
//
// 这个测试用最小 React 运行时真跑一遍 client.cjs 注册的 pane 组件，并**等异步
// setState 落地后重渲染**。踩过的坑：不等 tick 的话状态永远是初始 {}，旧代码也
// 「跑得过」——那样的护栏是空转的，证明不了任何事。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(here, '../lib/client.cjs');

/**
 * 读 client.cjs 的源码文本，用于**静态样式断言**（去臃肿那两条）。
 * 渲染树里读不到 CSS 值，而 CSS 值恰恰是最容易被「顺手调一下」改回去的。
 */
const bridgeSrcFrom = (rel) => readFileSync(path.resolve(here, '../lib/', rel), 'utf8');

/**
 * 渲染组件时喂进去的 props，形状与官方槽 `inject` 的产物一致。
 *
 * 0.15.0 起设置页需要当前会话 id（花名册的 subagentCatalog 是会话级投影，
 * 见 lib/roster.js 的 projectSubAgents）。这里用固定的假 id 而不是 null：
 * `null` 会让花名册走「no-session-id」降级分支，那条路径另有用例专门覆盖。
 */
const SESSION_PROPS = { sessionId: 'session-render-test' };

/** 在当前进程里加载 client.cjs 并跑若干渲染周期，返回每次渲染捕获的异常。 */
async function renderPane({ payloads, which = 'pane', sites = [], roster = null, primitiveOmit = [], waitStats = null } = {}) {
  const saved = { window: global.window, document: global.document, fetch: global.fetch, setInterval: global.setInterval, clearInterval: global.clearInterval };
  const realSetTimeout = global.setTimeout;
  let captured = null;
  // 0.15.12：`sidebar.right.pane.tab` 是 **keyed** 座位，本轮起有三个 kind
  // （网页 / Team / 任务板）各注册一个正文。旧 harness 只留「最后一个注册的」，
  // 于是新增两个标签页会把网页正文挤掉——那不是产品缺陷，是桩建模失真。
  // 按 key 收全，再按用途取。
  const PaneComponents = new Map();
  /** 已注册的标签页定义（kind → definition），用于断言三个 kind 各自成立。 */
  const TabDefinitions = new Map();
  // 0.16.0：左栏入口（sidebar.panellist）与中央列 main 座位。前者是 list 座位，
  // 后者的 key 必须与前者 id 逐字相同——两半各收一处，便于断言「成对」。
  const PanelEntries = [];
  const MainKeys = [];
  // 0.16.18：main 是 **keyed** 座位，按 key 派发。只收 key 已经不够——任务板正文
  // 现在只从这里取（右栏那份 `sidebar.right.pane.tab` 注册已按用户要求删除），
  // 因此组件本身也要留一份，否则 which:'tasks' 无座位可渲染。
  const MainComponents = new Map();
  let SettingsComponent = null;
  // 0.15.11：输入框底下的等待药丸也必须被真的渲染到。此前没有任何用例捕获
  // `conversation.composer.dock` 的组件，于是「药丸长什么样、点了会怎样」
  // 这整条路径在测试里是空白——护栏再密也拦不住它回归。
  let DockComponent = null;
  const MenuItems = [];
  const effectDisposers = [];
  let windowHits = 0;
  // 每次 setInterval 的周期（ms）。药丸的轮询节奏由它在途与否决定，见 0.16.24 用例。
  const intervalDelays = [];
  let current = payloads[0];

  let states = [], cursor = 0, effectSlots = [], effectSlotCursor = 0, pendingEffects = [];
  // ── 组件级 hook 作用域（2026-09-15） ────────────────────────────────────────
  // 真实 React 的 hook 状态挂在**组件实例**上，不是全局扁平下标。旧实现用
  // 「整棵树共用一个 cursor」模拟，只有在每个组件的 hook **数量与顺序**都
  // 恒定、且组件出现顺序不变时才等价。
  //
  // 一旦某个组件多一个 useState（本轮 SiteAccounts 为「选中账户」新增了
  // picked），它之后所有组件的 hook 下标就整体后移，于是嵌套的 PromptPanel
  // 会从**别人**的槽位读到值——实测表现是 `variants.find is not a function`
  // （PromptPanel 的 variants 拿到了一个字符串/对象）。那是护栏自己的建模
  // 失真，不是产品缺陷；但它会让正确的实现被误判为崩溃。
  //
  // 修法：按「正在渲染哪个组件」分段计数（ownerStack 栈顶即当前 owner），
  // 状态槽的键 = 组件身份 + 该组件内的 hook 序号。组件内部顺序仍必须稳定
  //（这正是 React 的 hooks 规则），但**其他组件**增删 hook 不再影响它。
  const ownerStack = [];
  let anonOwner = 0;
  const ownerKey = () => (ownerStack.length ? ownerStack[ownerStack.length - 1].id
    : 'root#' + (ownerStack.rootSeq = (ownerStack.rootSeq || 0)));
  const renderWithScope = (fn, identity) => {
    const frame = { id: identity + '#' + (typeof fn === 'function' ? (fn.name || 'anon') : 'x'), n: 0, e: 0 };
    ownerStack.push(frame);
    try { return fn(); } finally { ownerStack.pop(); }
  };
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => {
      const frame = ownerStack[ownerStack.length - 1];
      // `i` 是**该组件内**的序号；无 owner 帧时回落到旧的全局 cursor（顶层调用）。
      const i = frame ? frame.id + '::' + (frame.n++) : 'g::' + (cursor++);
      if (!(i in states)) states[i] = init;
      return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; }];
    },
    useEffect: (fn, deps) => {
      const frame = ownerStack[ownerStack.length - 1];
      const i = frame ? frame.id + '::e' + (frame.e++) : 'ge::' + (effectSlotCursor++);
      const prev = effectSlots[i];
      const changed = !prev || (deps && (!prev.deps || deps.some((d, k) => d !== prev.deps[k])));
      if (changed) { effectSlots[i] = { fn, deps }; pendingEffects.push(fn); }
      else effectSlots[i] = prev || { fn, deps };
    },
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
  };
  const mockRequire = (id) => {
    if (id === 'react') return React;
    if (id === 'react-dom/client') return { createRoot: () => ({ render() {} }) };
    // 0.16.18：等待药丸不再 require react-dom——官方 `[data-composer-stats]`
    // 标记在新版里已不存在，portal 已删除（见 client.cjs 的长注释与源码护栏）。
    // 这里仍留一条 react-dom 桩，但要求它**不得**被用到：真被 require 到说明
    // portal 路线又被加回来了。
    if (id === 'react-dom') return { createPortal: () => { throw new Error('不得再用 createPortal：官方统计行标记已不存在'); } };
    // 官方 primitives 桩（0.16.23 起按真实契约补齐）：client.cjs 还解构了
    // IconChevronDownOutline14 / FishLogo / FISH_LOGO_PATH / FISH_LOGO_VIEWBOX /
    // useDismissOnOutsidePointer（站点图标与选择框，0.16.23 接手网页会话半成品时
    // 加入）。桩按真机 0.1.6-alpha.2 的导出形状给**可渲染**的替身——FISH_LOGO_VIEWBOX
    // 用官方真实值，路径给一条合法占位 d（断言不依赖形状细节，只依赖渲染不崩）。
    // primitiveOmit：模拟旧版 primitives 缺导出（每个缺位导出必须被 client.cjs 的
    // 防御回退接住——「降级不是崩溃」，0.16.21 事故的回归钉子）。
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      const stub = {
        IconCodeOutline16: () => null,
        IconQueueOutline14: () => null,
        IconChevronDownOutline14: () => null,
        FishLogo: () => null,
        FISH_LOGO_PATH: '<path d="M11.58 17.04C6.5 16.6 1 12.6 1 8.5 1 3.8 5.6 0 11.6 0c5.4 0 10 3 11.2 7.2L14 6l-2.4 11z" fill="currentColor"/>',
        FISH_LOGO_VIEWBOX: { width: 23.16, height: 17.04 },
        useDismissOnOutsidePointer: () => {},
      };
      for (const k of primitiveOmit) delete stub[k];
      return stub;
    }
    throw new Error('unexpected require: ' + id);
  };

  try {
    global.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };
    global.document = { createElement: () => ({ textContent: '', remove() {} }), head: { appendChild() {} }, body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {} };
    global.MutationObserver = class { observe() {} disconnect() {} };
    // 组件的轮询计时器：不 stub 会拖住事件循环。0.16.24 起还要**记下周期**——
    // 「在途等待时 1 秒一问」是需求的一半（10 秒一问的话数字 10 秒才动一格）。
    global.setInterval = (_fn, ms) => { intervalDelays.push(ms); return {}; };
    global.clearInterval = () => {};
    global.fetch = async (url) => {
      const u = String(url);
      let body = { ok: true };
      if (u.includes('/__webcode/window')) { windowHits++; body = current; }
      else if (u.includes('/__webcode/status')) {
        body = { ok: true, relay: { running: true, consent: true, consentPersistent: true, metrics: { timing: 'measured', firstTokenMs: 500, thinkingMs: 100, responseMs: 2000, responseTps: 20, durationMs: 3000, sendWaitMs: 15000, rateLimitRetries: 1 } }, driver: { sites, selectedModel: 'deepseek:deepseek' }, build: { hash: 'x', version: 'test' },
          // 0.15.0 花名册：子代理与 Team 两段由服务端真实投影（lib/roster.js）。
          // 缺省 null 而不是 []，是为了让「没有该字段」与「确实为空」在测试里可区分。
          // teamError / subAgentsError 一并支持：面板要能把「确实没有」与
          // 「读不到」分开说，这条路径必须有夹具覆盖。
          // 0.15.4 追加：`members`（官方 TeamView 的词，team 的同值别名）与
          // `tasks`（团队级任务板）、`tasksError`。四个分区都要能被夹具驱动。
          ...(roster ? {
            subAgents: roster.subAgents || [],
            team: roster.team || roster.members || [],
            members: roster.members || roster.team || [],
            tasks: roster.tasks || [],
            // 0.15.12：图诊断（就绪集/阻塞点/关键路径/结构问题）由服务端
            // lib/task-graph.js 算好后经 /status 透出。缺省 null 而不是造一个
            // 空图——「图算不出来」与「图是空的」在面板上说法不同。
            graph: roster.graph ?? null,
            subAgentsError: roster.subAgentsError ?? null,
            teamError: roster.teamError ?? null,
            tasksError: roster.tasksError ?? null,
          } : {}) };
      }
      else if (u.includes('/__webcode/settings')) body = { ok: true, extraPrompt: '', sendGapMs: 10000, thinkMode: 'auto', subAgentMode: 'own', subAgentSite: 'follow' };
      else if (u.includes('/__webcode/prompt-variants')) {
        // 0.14.0：设置页默认显示首轮提示词。变体必须真的带 text，否则「默认显示」
        // 只会渲染一个空 <pre>，与折叠起来没有区别。
        // 0.16.25：载荷追加 `sites`——UI 改为「按网站逐行」，每行的 text 是**该站点
        // 实际会用的协议**的模板（服务端按站点现算）。夹具照真实形状给两份，
        // 其中 deepseek 与 glm 用不同协议，才能验证「每行取的是自己那一支」。
        body = {
          ok: true, toolsSource: 'session',
          active: { variantId: 'glm', siteId: 'glm', model: 'glm:glm-5.3', tools: ['read', 'pwsh'], at: '2026-09-13T00:00:00.000Z' },
          variants: [
            { id: 'default', label: '标签形状（<tool_call> 标签）', note: 'n1', text: 'DEFAULT-PROMPT-TEXT', trainNote: 'tn1', siteIds: null, excludes: ['glm', 'deepseek'] },
            { id: 'glm', label: 'GLM 代码块（```json 代码块）', note: 'n2', text: 'GLM-PROMPT-TEXT', trainNote: 'tn2', siteIds: ['glm'], excludes: [] },
            { id: 'official', label: 'DeepSeek 官方模板（原生工具调用格式）', note: 'n3', text: 'OFFICIAL-PROMPT-TEXT', trainNote: 'tn3', siteIds: ['deepseek'], excludes: [] },
          ],
          sites: [
            { siteId: 'deepseek', siteName: 'DeepSeek 网页版', variantId: 'official', variantLabel: 'DeepSeek 官方模板（原生工具调用格式）', text: 'OFFICIAL-PROMPT-TEXT' },
            { siteId: 'glm', siteName: '智谱清言 (GLM)', variantId: 'glm', variantLabel: 'GLM 代码块（```json 代码块）', text: 'GLM-PROMPT-TEXT' },
          ],
        };
      }
      else if (u.includes('/__webcode/models')) body = { ok: true, models: [{ id: 'deepseek:deepseek', name: 'deepseek/deepseek', siteId: 'deepseek', thinking: true }] };
      else if (u.includes('/__webcode/connect')) body = { ok: true, loggedIn: true };
      // 0.15.11：等待药丸的数据面。服务端已把文案与明细算好（label / detailRows），
      // 客户端只负责渲染——夹具照真实载荷形状给，含本会话与累计两类行。
      // 0.16.24：`waitStats` 可整体替换该载荷（在途等待用例要带 live/now/liveValue），
      // 缺省仍给 0.15.11 那份「已结算」夹具。文案里的 `3 s` 与 wait-stats.js 的
      // formatElapsed（秒级取整）一致——夹具必须照真实服务端输出给，否则护栏是假绿。
      else if (u.includes('/__webcode/wait-stats')) body = waitStats || {
        ok: true,
        total: { totalWaitMs: 20000, turns: 9, waitedTurns: 4, rateLimitRetries: 1, updatedAt: 1789000000000 },
        session: { totalWaitMs: 3000, turns: 2, waitedTurns: 1, rateLimitRetries: 0, updatedAt: 1789000000000 },
        rows: [{ label: '累计等待发送', value: '20.0 s' }],
        line: '本次会话等待发送 3 s',
        label: '等待发送 3 s',
        sessionValue: '3 s',
        detailRows: [
          { label: '本次会话等待发送', value: '3 s' },
          { label: '累计等待发送', value: '20.0 s' },
        ],
      };
      // 必须是**忠实**的 Response：真实 client.cjs 走 response.text() +
      // response.headers.get('content-type') 解析（见 lib/client.cjs 的 request()）。
      // 旧 mock 只给 json()，于是 text() 抛错被吞、headers 为 undefined——
      // **所有** 数据路径都静默失败，而断言只看「不抛错」，护栏等于空转。
      // 这里补齐 text/headers/status，让数据真的到达组件。
      const text = JSON.stringify(body);
      return {
        ok: true, status: 200, statusText: 'OK',
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
        text: async () => text,
        json: async () => body,
      };
    };
    if (!global.AbortSignal) global.AbortSignal = {};
    if (!global.AbortSignal.timeout) global.AbortSignal.timeout = () => undefined;

    // 同一进程里第二次 renderPane 会命中 require 缓存，client.cjs 顶层的
    // __ModuleLoader__.load 不再执行、captured 永远是 null——每个用例必须
    // 从干净模块状态开始。
    const req = createRequire(import.meta.url);
    delete req.cache[req.resolve(CLIENT)];
    req(CLIENT);
    assert.ok(captured, 'client.cjs 未调用 window.__ModuleLoader__.load');
    const mod = captured.factory(mockRequire, { exports: {} });
    mod.apply({
      // DSH 的规范生命周期：disposer 交给 ctx.effect 统一回收。这里桩成
      // 「立刻执行并把返回的注销函数存起来」，与宿主行为等价（apply 期间注册、
      // 卸载时注销）。
      effect: (fn) => { const off = fn(); if (typeof off === 'function') effectDisposers.push(off); return () => {}; },
      slots: {
        inject: (_n, fn) => fn(),
        register: (def, Comp) => {
          if (def?.name === 'sidebar.right.pane.tab') PaneComponents.set(def.key, Comp);
          if (def?.name === 'settings.section') SettingsComponent = Comp;
          if (def?.name === 'sidebar.right.tab.menu.item') MenuItems.push(Comp);
          if (def?.name === 'conversation.composer.dock') DockComponent = Comp;
          // 0.15.12/0.16.0：左栏入口与中央列 main 座位。list 座位带 id（= main key）；
          // main 是 keyed 座位，按 key 派发。两者分别收下，用于断言成对且同名。
          if (def?.name === 'sidebar.panellist') PanelEntries.push({ id: def.id, order: def.order, label: def.label, Comp });
          if (def?.name === 'main') { MainKeys.push(def.key); MainComponents.set(def.key, Comp); }
          return () => {};
        },
      },
      // 标签页类型注册：收下定义，便于断言「三个 kind 都存在且都是 page type」。
      sidebarRightTabs: { register: (def) => { if (def?.kind) TabDefinitions.set(def.kind, def); return () => {}; } },
      sidebarRight: { toggleExpanded() {} },
      get: () => null,
    });
    assert.ok(PaneComponents.size > 0, 'sidebar.right.pane.tab 正文从未注册');
    assert.ok(SettingsComponent, 'settings.section 从未注册');

    const flush = () => new Promise((r) => realSetTimeout(r, 0));
    // 深度实例化：函数组件要**递归**展开——只展开顶层的话，嵌套的子组件
    // （如 PromptSection → PromptPanel）的 hooks 根本不会注册，它们的 useEffect
    // 也就永远不跑，测试会「跑得过」但什么也没证明（这正是 0.13.0 那条
    // 「护栏必须证明自己不是空转」的教训）。
    const instantiate = (el) => {
      if (Array.isArray(el)) return el.map(instantiate);
      if (el === null || el === undefined || typeof el !== 'object') return el;
      // 函数组件：**在一个组件作用域里**调用它（ownerStack 决定 hook 状态槽的
      // 归属，见上面 ownerKey 的注释），并继续展开它的返回值。
      // 作用域用「组件函数身份」区分同一个组件的多次调用。
      if (typeof el.type === 'function') {
        const fn = el.type;
        const identity = fn.name || 'anon';
        return instantiate(renderWithScope(() => fn(el.props), identity));
      }
      // 普通节点：必须递归进 children。
      //
      // 旧实现到这里就 `return el` 了，于是**整棵树只有根组件跑过一次**：根是
      // <section>，不是函数组件，递归当场终止——嵌套组件（PromptSection →
      // PromptPanel）的 useState/useEffect 从未注册，它们的请求也就从未发出。
      // 表现是护栏「跑得过」却什么都没验证（0.14.0 修首轮提示词默认显示时暴露：
      // 数据路径全通、只有嵌套面板停在「加载中」）。
      return { ...el, children: (el.children || []).map(instantiate) };
    };
    const errors = [];
    /** which → 座位 key。标签页正文、中央列 main 面板、设置页、等待药丸各一条路径。 */
    const PANE_KEYS = {
      pane: 'dsh-webcode-bridge',
      team: 'dsh-webcode-bridge/team',
    };
    // 0.16.18：任务板正文不再挂在 `sidebar.right.pane.tab` 上（右栏那份注册已按
    // 用户要求删除），它现在只由左栏 `sidebar.panellist` 行 + 同名 `main` 座位提供。
    // 因此 `which: 'tasks'` 去 MainComponents 取，而不是 PaneComponents。
    const TASKS_PANEL_ID = 'webcode-tasks-panel';
    const Target = which === 'settings' ? SettingsComponent
      : which === 'dock' ? DockComponent
        : which === 'tasks' ? MainComponents.get(TASKS_PANEL_ID)
          : PaneComponents.get(PANE_KEYS[which] || PANE_KEYS.pane);
    if (which === 'dock') assert.ok(DockComponent, 'conversation.composer.dock 从未注册');
    if (which === 'tasks') {
      assert.ok(Target, '未注册 main 座位 ' + TASKS_PANEL_ID
        + '（已注册：' + [...MainComponents.keys()].join(', ') + '）——任务板必须由左栏入口 + main 成对提供');
    } else {
      assert.ok(Target, '未注册座位 ' + which + '（已注册：' + [...PaneComponents.keys()].join(', ') + '）');
    }
    // 0.15.0：设置页的官方槽 inject 会喂进**当前会话 id**（花名册的
    // subagentCatalog 是会话级投影，服务端要用它去 sessions.get(sessionId)）。
    // 旧 harness 直接 `Target()` 调，等于模拟了一个「inject 什么都没给」的宿主；
    // 这里改成把真实的 props 形状传进去，并把「拿不到会话身份」单独做成一个
    // 用例（见「花名册：读不到」那条），两种宿主行为都被覆盖。
    let tree = null;
    for (const p of payloads) {
      current = p;
      // 保留组件状态跨 pass 演进（异步 setState 需要在下一 pass 被读到），
      // 但在切换 payload 时清空——不同 payload 是不同场景，状态必须从头来。
      states = {}; effectSlots = {};
      for (let pass = 0; pass < 8; pass++) {
        cursor = 0; effectSlotCursor = 0; pendingEffects = [];
        try { tree = instantiate(Target(SESSION_PROPS)); } catch (e) { errors.push(e); break; }
        for (const fn of pendingEffects) { try { fn(); } catch (e) { errors.push(e); } }
        await flush(); await flush(); await flush(); await flush();   // ← 异步 setState 必须在这里落地
      }
    }
    return {
      errors, windowHits, tree, menuItems: MenuItems, effectDisposers,
      tabDefinitions: TabDefinitions, paneKeys: [...PaneComponents.keys()],
      // 0.16.0：左栏入口与中央列 main 座位的登记结果。两个都返回，用例才能断言
      // 「成对且同名」——只看一半会放过「侧栏行存在但点了报未注册」那类缺陷。
      panelEntries: PanelEntries, mainKeys: MainKeys,
      // 0.16.24：药丸 setInterval 的周期序列（静止 10000 / 在途 1000）。
      intervalDelays,
    };
  } finally {
    global.window = saved.window; global.document = saved.document;
    global.fetch = saved.fetch; global.setInterval = saved.setInterval; global.clearInterval = saved.clearInterval;
  }
}

/** 把渲染树里所有可见文本拼起来（树已由 instantiate 展开为纯节点）。 */
function treeText(el) {
  if (el === null || el === undefined || el === false || el === true) return '';
  if (typeof el === 'string' || typeof el === 'number') return String(el);
  if (Array.isArray(el)) return el.map(treeText).join(' ');
  if (typeof el.type === 'function') return treeText(el.type(el.props));
  return (el.children || []).map(treeText).join(' ');
}

/**
 * 收集渲染树里所有节点的指定属性值。
 *
 * 0.14.5 起右栏把「登录态」从可见文案改成 8px 色点（见 client.cjs 的 statusDot），
 * 状态词只存在于 title/aria-label。护栏因此需要能读到属性——只读可见文本的话，
 * 「美化把状态信息弄丢」这类回归会完全测不出来（点还在、话没了）。
 */
function treeAttrs(el, names, out = []) {
  if (el === null || el === undefined || typeof el !== 'object') return out;
  if (Array.isArray(el)) { for (const c of el) treeAttrs(c, names, out); return out; }
  if (typeof el.type === 'function') return treeAttrs(el.type(el.props), names, out);
  const props = el.props || {};
  for (const n of names) {
    const v = props[n];
    if (typeof v === 'string' && v) out.push(v);
  }
  for (const c of (el.children || [])) treeAttrs(c, names, out);
  return out;
}

const emptyWindows = { ok: true, siteId: 'deepseek', window: { open: false, headed: false }, windows: {} };
const oneWindow = { ok: true, siteId: 'deepseek', window: { open: true }, windows: { deepseek: { open: true } } };
const otherSiteWindow = { ok: true, siteId: 'deepseek', window: { open: true }, windows: { glm: { open: true } } };

test('右栏：没有独立窗口时渲染不得抛错（回归：面板全白）', async () => {
  const { errors, windowHits } = await renderPane({ payloads: [emptyWindows] });
  // 旧实现在这里报 TypeError: Cannot read properties of null (reading 'deepseek')
  assert.deepEqual(errors, [], 'windows={} 时渲染抛错：' + errors.map(e => e.message).join('; '));
  // 同时证明 effect 真跑了——否则状态停在初始 {}，这个断言是空转的
  assert.ok(windowHits > 0, '组件没有轮询 /__webcode/window，渲染未真正发生');
});

test('右栏：窗口状态切换（无窗 ↔ 有窗 ↔ 他站有窗）全程稳定', async () => {
  const { errors } = await renderPane({ payloads: [emptyWindows, oneWindow, otherSiteWindow, emptyWindows] });
  assert.deepEqual(errors, [], '状态切换时渲染抛错：' + errors.map(e => e.message).join('; '));
});

test('设置面板：发送间隔行与「发送前等待」统计条渲染不抛错', async () => {
  // Settings 依赖 status/settings/models 三个接口；status 里带 sendWaitMs>0 +
  // rateLimitRetries 的 metrics，证明新增的等待条与限流重试文案走的是真实渲染路径。
  const { errors } = await renderPane({ payloads: [emptyWindows], which: 'settings' });
  assert.deepEqual(errors, [], '设置面板渲染抛错：' + errors.map(e => e.message).join('; '));
});

// ------------------------------------------------------------------ 0.14.0

test('设置面板：首轮提示词默认就显示，且**按网站逐行**列出', async () => {
  // 用户原话（0.14.0）：「设置界面提示词应该默认就显示，首轮提示词又不会变？有多的
  // 适配就可选择框选择列出」。旧实现折叠在 <details> 里，不点开页面上一个字都没有。
  //
  // 用户原话（0.16.25）：「改为以网站为导向列出，每行一个网站，然后后面选择框
  // 选择已有协议中的一个」。因此这里断言的是**逐站点行**与每行自己的协议文本，
  // 而不是「下拉里列出了几个协议」——后者在按协议列时也成立，测不出本次改动。
  const { errors, tree } = await renderPane({ payloads: [emptyWindows], which: 'settings' });
  assert.deepEqual(errors, [], '设置面板渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  // 两个站点各一行，且各自显示**自己实际会用的协议**的模板全文。
  // （deepseek 走官方模板、glm 走代码块——若 UI 拿同一份文本填所有行，这里会红。）
  assert.ok(text.includes('DeepSeek 网页版'), '未按网站列出 deepseek 行');
  assert.ok(text.includes('智谱清言 (GLM)'), '未按网站列出 glm 行');
  assert.ok(text.includes('OFFICIAL-PROMPT-TEXT'), 'deepseek 行未渲染它自己的模板');
  assert.ok(text.includes('GLM-PROMPT-TEXT'), 'glm 行未渲染它自己的模板');
  // 「实际使用」标注必须在（用户要能分辨「预览」与「生效」）。
  assert.ok(/实际使用：/.test(text), '每行必须标出该网站实际在用的协议');
  // 协议仍要能选（每行一个下拉），选项文案用新标签。
  assert.ok(text.includes('标签形状（<tool_call> 标签）'), '协议下拉未列出标签形状');
  assert.ok(text.includes('GLM 代码块'), '协议下拉未列出 GLM 代码块');
  assert.ok(text.includes('DeepSeek 官方模板'), '协议下拉未列出官方模板');
  // 全局指令仍是可编辑的（唯一可编辑项）
  assert.ok(text.includes('保存全局指令'), '全局指令编辑区未默认渲染');
});

test('右栏：站点栏在空站点表与十站点表下都渲染不抛错（tablist 规范）', async () => {
  const ten = [
    { siteId: 'deepseek', siteName: 'DeepSeek 网页版', initialized: true, loggedIn: true },
    { siteId: 'glm', siteName: '智谱清言 (GLM)', initialized: false, loggedIn: true, loggedInCached: true, loginBasis: 'probe-fallback' },
    { siteId: 'chatgpt', siteName: 'ChatGPT', initialized: false, loggedIn: null, loginBasis: 'stale' },
    { siteId: 'kimi', siteName: 'Kimi', initialized: false, loggedIn: false },
    { siteId: 'qwen', siteName: '通义千问', initialized: false, loggedIn: null },
    { siteId: 'doubao', siteName: '豆包', initialized: false, loggedIn: false },
    { siteId: 'grok', siteName: 'Grok', initialized: false, loggedIn: null },
    { siteId: 'claude', siteName: 'Claude', initialized: false, loggedIn: null },
    { siteId: 'gemini', siteName: 'Gemini', initialized: false, loggedIn: null },
    { siteId: 'zai', siteName: 'Z.ai', initialized: false, loggedIn: true, loggedInCached: true },
  ];
  const empty = await renderPane({ payloads: [emptyWindows] });
  assert.deepEqual(empty.errors, [], '空站点表渲染抛错：' + empty.errors.map(e => e.message).join('; '));
  const full = await renderPane({ payloads: [emptyWindows], sites: ten });
  assert.deepEqual(full.errors, [], '十站点表渲染抛错：' + full.errors.map(e => e.message).join('; '));
  // 站点名与登录徽标都要真的渲染出来（不是空 tablist）
  const text = treeText(full.tree);
  for (const n of ['DeepSeek', '智谱清言', 'Kimi', '豆包', 'Z.ai']) {
    assert.ok(text.includes(n), '站点栏缺少 ' + n);
  }
  // 0.14.5：登录态从「标签内文案」改为「8px 色点 + tooltip」。四态仍必须都
  // 能表达出来，但表达的位置变了——断言跟着契约走，而不是跟着实现细节走。
  //
  // 这一条同时钉住「美化不得把信息弄丢」：点本身没有文字，状态词必须在
  // title/aria-label 里可读到，否则屏幕阅读器与悬停提示都拿不到状态。
  const titles = treeAttrs(full.tree, ['title', 'aria-label']).join(' | ');
  for (const s of ['已登录(缓存)', '未登录', '待检查']) {
    assert.ok(titles.includes(s), '登录态「' + s + '」未出现在任何 title/aria-label 中：' + titles.slice(0, 300));
  }
  // 反过来锁住这次改动的意图：长状态文案不得再出现在**可见文本**里
  //（它正是把标签条挤爆、被用户报「状态有点简略」的那段文字）。
  assert.ok(!text.includes('已登录(缓存)'), '长状态文案仍渲染在可见文本中，标签条会被撑爆');
});

test('右栏：注册全部走 ctx.effect，并把「刷新 / 独立窗口」挂进标签动作菜单', async () => {
  // 0.14.0 的 DSH 规范化：注册不再是「注册完把 disposer 塞进数组」，而是交给
  // ctx.effect（宿主统一回收，热重载不会留下重复注册——tab-registry 明确把
  // 「重复 id」判为 wiring mistake）。动作入口也按官方 slot 挂到标签菜单上。
  const { errors, menuItems, effectDisposers } = await renderPane({ payloads: [emptyWindows] });
  assert.deepEqual(errors, [], '渲染抛错：' + errors.map(e => e.message).join('; '));
  assert.ok(effectDisposers.length >= 4, '注册未被 ctx.effect 接管（disposer 数：' + effectDisposers.length + '）');
  // 菜单项：刷新 + 独立窗口，各一个
  assert.equal(menuItems.length, 2, '标签动作菜单项应有两个，实际 ' + menuItems.length);
  // 菜单项必须能安全渲染，并如实说明作用于哪个站点。
  //
  // 0.15.12：菜单项现在**只对网页标签页显示**（官方契约原文：「Entries decide
  // their own visibility from the tab they are given」）。owner 必须带 tab——
  // 旧用例只给 dismiss，等于模拟了一个「没有 tab 的菜单」，那在新契约下应当
  // 返回 null（隐藏），因此这里按真实 owner 形状喂进去。
  for (const Item of menuItems) {
    // 非网页标签页：必须隐藏（返回 null），否则会在 Team/任务板菜单里出现
    // 一个「刷新网页」——而它作用于**另一个**面板的站点，用户完全看不出来。
    assert.equal(Item({ dismiss: () => {}, tab: { kind: 'webcode-team' } }), null,
      '菜单项在非网页标签页上也渲染了——点下去会作用到别的面板');
    let el;
    assert.doesNotThrow(() => { el = Item({ dismiss: () => {}, tab: { kind: 'webcode-bridge' } }); });
    const t = treeText(el);
    assert.ok(t.length > 0, '菜单项没有可见文案');
    assert.match(t, /刷新网页|切换独立窗口/);
  }
});

// ------------------------------------------------------------------ 0.14.8

test('★ 站点图标与一级选择框（0.16.23 接手网页会话半成品）：图标/档位说明/首屏选择框都要渲染出来', async () => {
  const ten = [
    { siteId: 'deepseek', siteName: 'DeepSeek 网页版', initialized: true, loggedIn: true },
    { siteId: 'glm', siteName: '智谱清言 (GLM)', initialized: false, loggedIn: true },
  ];
  const full = await renderPane({ payloads: [emptyWindows], sites: ten });
  assert.deepEqual(full.errors, [], '站点图标渲染抛错：' + full.errors.map(e => e.message).join('; '));
  // 档位表语义：DeepSeek 是官方鲸鱼矢量（official 档），GLM 如实标注「未找到」——
  // 不许把第三方图集冒充官方（doc/brand-icons-research.md 的结论）。
  const titles = treeAttrs(full.tree, ['title']).join(' | ');
  assert.ok(titles.includes('官方鲸鱼矢量'), 'DeepSeek 的 official 档位说明未出现在 title 中');
  assert.ok(titles.includes('未找到品牌方发布的透明底矢量'), 'GLM 的 missing 档位说明未出现在 title 中');
  // 站点栏每个 tab 内都有 glyph 挂点（图标或文字标记的容器）。
  const html = JSON.stringify(full.tree);
  assert.ok(html.includes('hwb-tab-glyph'), '站点栏 tab 缺少图标挂点');
});

test('★ 站点图标：旧版 primitives 缺导出时必须降级而不是白屏（0.16.21 事故回归钉子）', async () => {
  // 0.16.21 误打包的半成品里，对 primitives 的新增导出**无回退解构**，而测试桩
  // 只给了两个图标——FishLogo/FISH_LOGO_VIEWBOX/IconChevronDownOutline14/
  // useDismissOnOutsidePointer 全是 undefined，渲染期 h(undefined/读 .height) 抛
  // TypeError，6 条渲染测试全崩。修复 = 防御回退解构（client.cjs）；本条钉住：
  // 把新增导出**全部抽走**（模拟 < 0.1.6 的旧版 primitives），渲染必须照样成立。
  const { errors } = await renderPane({
    payloads: [emptyWindows],
    sites: [{ siteId: 'deepseek', siteName: 'DeepSeek 网页版', initialized: true, loggedIn: true }],
    primitiveOmit: ['IconChevronDownOutline14', 'FishLogo', 'FISH_LOGO_PATH', 'FISH_LOGO_VIEWBOX', 'useDismissOnOutsidePointer'],
  });
  assert.deepEqual(errors, [], '缺导出时渲染抛错（回退缺失，会白屏）：' + errors.map(e => e.message).join('; '));
});

test('右栏账户头像：圆框按真实读数分三态，且颜色不是唯一状态载体', async () => {
  // 用户原话：「账户栏目已登录的账户有头像一样的（就是适应大小的圆框账户，
  // 点击选择后是对应账户，外层有浅绿色正常状态显示，浅红色就是会话没了）」。
  //
  // 这一条同时钉住调研里点名「最容易犯的错」的那条约束
  //（doc/research/agent-ui-design-references.md:180）：**不用颜色作为唯一状态载体**。
  // 所以断言分两半：类名（视觉）与 title/aria-label（可读文本）都要到位。
  const sites = [
    // 正常：已登录且从未丢过网页会话
    { siteId: 'deepseek', siteName: 'DeepSeek 网页版', accountKey: 'deepseek', displayName: 'DeepSeek 网页版', initialized: true, loggedIn: true, sessionLostCount: 0 },
    // 会话没了：登录态还在，但网页会话丢过 —— 这是「浅红」的**唯一**合法依据
    { siteId: 'glm', siteName: '智谱清言 (GLM)', accountKey: 'glm#2', slot: '2', displayName: '智谱清言 (GLM) (账户2)', initialized: true, loggedIn: true, sessionLostCount: 3, lastSessionLost: { reason: 'no-stored-session', siteId: 'glm' } },
    // 待检查：没有可信读数
    { siteId: 'kimi', siteName: 'Kimi', accountKey: 'kimi', displayName: 'Kimi', initialized: false, loggedIn: null },
  ];
  const { errors, tree } = await renderPane({ payloads: [emptyWindows], sites, which: 'settings' });
  assert.deepEqual(errors, [], '账户头像渲染抛错：' + errors.map(e => e.message).join('; '));

  // 头像存在且是圆框：断言类名（视觉契约）
  const classes = treeAttrs(tree, ['className']).join(' ');
  assert.match(classes, /hwb-avatar/, '没有渲染账户头像元素');
  assert.match(classes, /hwb-avatar ok/, '已登录账户未标为 ok（浅绿正常态）');
  assert.match(classes, /hwb-avatar dead/, '丢过会话的账户未标为 dead（浅红「会话没了」态）');
  assert.match(classes, /hwb-avatar idle/, '无可信读数的账户未标为 idle');

  // 【核心】颜色不是唯一载体：三个账户的状态都必须能在 title/aria-label 里读到
  const labels = treeAttrs(tree, ['aria-label', 'title']).join(' | ');
  assert.ok(labels.includes('正常'), '「正常」态未出现在 aria-label/title：' + labels.slice(0, 300));
  assert.ok(labels.includes('会话已失效'), '「会话没了」态未出现在 aria-label/title（颜色成了唯一载体）：' + labels.slice(0, 300));
  assert.ok(labels.includes('待检查'), '「待检查」态未出现在 aria-label/title：' + labels.slice(0, 300));

  // 会话丢失次数要如实出现在可读文本里（用 loggedIn 冒充会话失效是错的：
  // 两者会同时为真——GLM 那一行 loggedIn=true 且 sessionLostCount=3）
  assert.ok(labels.includes('3'), '会话失效次数未如实透出：' + labels.slice(0, 300));
});

test('右栏账户头像：per-slot 会话丢失读数缺失时退化为 idle，不得凭 loggedIn 猜', async () => {
  // 后向兼容：旧后端（≤0.14.7）的 sites 行**没有** sessionLostCount 字段。
  // 缺字段时必须退化成 idle（待检查），而不是把 undefined > 0 当 false 升绿，
  // 也不是编一个「会话失效」的红色——两者都是造假状态。
  const old = [{ siteId: 'deepseek', siteName: 'DeepSeek 网页版', accountKey: 'deepseek', displayName: 'DeepSeek 网页版', initialized: true, loggedIn: true }];
  const { errors, tree } = await renderPane({ payloads: [emptyWindows], sites: old, which: 'settings' });
  assert.deepEqual(errors, [], '旧后端行渲染抛错：' + errors.map(e => e.message).join('; '));
  const classes = treeAttrs(tree, ['className']).join(' ');
  assert.match(classes, /hwb-avatar ok/, '缺 sessionLostCount 时已登录账户应仍是 ok（正常）');
  assert.ok(!/hwb-avatar dead/.test(classes), '缺 sessionLostCount 时不得编造「会话没了」的红态');
});

// ------------------------------------------------------------------ 0.14.9

test('花名册：子代理与 Team 成员必须分成两区，子代理缩进、Team 平级', async () => {
  // 用户原话：「子代理和team效果需要单独区分」。
  // 依据是两者的结构性差异（doc/research/agent-ui-design-references.md §4.5）：
  // 子代理结果回报给调用方 → 从属于发起它的会话（缩进）；Team 成员互相发消息、
  // 共享任务板 → 平级。合成一个列表会把这两种关系画错。
  const sites = [];
  const { errors, tree } = await renderPane({ payloads: [emptyWindows], sites, which: 'settings' });
  assert.deepEqual(errors, [], '花名册渲染抛错：' + errors.map(e => e.message).join('; '));
  // 空态是个**状态**（确实没有在跑的），不是错误：必须给出可读文案。
  //
  // 0.15.5（P3-4）改口径：旧文案「当前没有正在运行的子代理或 Team 成员」把
  // 两件不同的事混成一句——官方语义下「每个普通顶层会话都是隐式 Team 的 Lead」
  //（agent-team README.md:128），而 Team 工具只对成员安装
  //（tool-agent-team/lib/index.js:533）。所以「空」的正确解释是
  //「本会话不是 Team 成员（Team 工具未挂载）」，不是「团队里没人」。
  // 断言随之改成新口径，**判据强度不变**：仍要求给出可读、可执行的状态说明。
  const empty = treeText(tree);
  assert.ok(/本会话不是 Team 成员/.test(empty),
    '空花名册未说明「本会话不是 Team 成员」：' + empty.slice(0, 300));
  assert.ok(/没有正在运行的子代理/.test(empty),
    '空花名册未说明子代理侧为空：' + empty.slice(0, 300));
  // 反向：空态不得被当成错误（那是把「没有」与「读不到」混成一句）。
  assert.ok(!/读不到花名册/.test(empty), '确实为空时不得报「读不到」：' + empty.slice(0, 300));
});

test('花名册：有成员时两区标题与状态词都可能被读到（颜色不是唯一载体）', async () => {
  // 这条用真实 payload 形状：status 里的 subAgents / team 两段。
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'settings',
    roster: {
      subAgents: [{ id: 'sa1', name: '修 OOM 的子代理', status: 'running' }],
      team: [{ id: 't1', name: 'benchdev', status: 'idle', taskCount: 3 }],
    },
  });
  assert.deepEqual(errors, [], '花名册（有成员）渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  // 两个分区标题必须同时在——这是「单独区分」的直接可验证形态。
  assert.ok(text.includes('子代理（属于本会话）'), '缺少子代理分区标题：' + text.slice(0, 300));
  assert.ok(text.includes('Team 成员（平级）'), '缺少 Team 分区标题：' + text.slice(0, 300));
  // 状态词必须可读（不能只有一个色点）。
  assert.ok(text.includes('工作中') && text.includes('空闲'), '状态词未渲染为可读文本：' + text.slice(0, 300));
  // 共享 checkout 的事实必须如实说明，不能让「并行面板」看起来像隔离环境。
  assert.ok(/共享同一个 checkout/.test(text), '未说明 Team 共享 checkout（会让人以为文件系统也隔离）');
});

// ------------------------------------------------------------------ 0.15.0 花名册接真实数据源

test('★ 花名册：读不到时必须说「读不到」而不是「没有成员」（不得把两者画成同一句话）', async () => {
  // 0.15.0 把 subAgents/team 从写死的空数组换成了真实投影，于是多出一种状态：
  // **读不到**（官方包没装 / 服务没注册 / 凭据解析失败）。旧实现只有「确实没有」
  // 一句话，用户无法区分「Team 没在用」和「桥坏了」——这正是接真实数据源之后
  // 最容易出现的倒退，所以必须有护栏钉住。
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'settings',
    roster: {
      subAgents: [], team: [],
      teamError: 'official-team-package-not-loaded',
      subAgentsError: 'session-projections-unavailable',
    },
  });
  assert.deepEqual(errors, [], '花名册（读不到）渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  assert.ok(/读不到花名册/.test(text), '未如实报告「读不到」：' + text.slice(0, 300));
  assert.ok(text.includes('official-team-package-not-loaded'), '未给出可排查的原因：' + text.slice(0, 300));
  assert.ok(/不代表没有成员在跑/.test(text), '未澄清「读不到 ≠ 没有」：' + text.slice(0, 300));
  // 关键反向断言：不能同时又宣称「当前没有正在运行的…」——那是把两种状态混成一句。
  assert.ok(!/当前没有正在运行的子代理/.test(text), '「读不到」时不得同时断言「确实没有」');
});

test('★ 花名册：部分分区读不到时仍渲染已有分区，并说明缺的那一半', async () => {
  // Team 侧读不到、子代理侧有真实数据。旧实现会因为「两段都空才提示」的结构
  // 而完全不提 Team 侧的问题，用户看到子代理列表就以为一切都好。
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'settings',
    roster: {
      subAgents: [{ id: 'sa1', name: 'recon 子代理', status: 'running' }],
      team: [], teamError: 'no-team-member-authority', subAgentsError: null,
    },
  });
  assert.deepEqual(errors, [], '花名册（部分可用）渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  assert.ok(text.includes('子代理（属于本会话）'), '可用分区必须照常渲染：' + text.slice(0, 300));
  assert.ok(text.includes('recon 子代理'), '可用的成员行必须照常渲染：' + text.slice(0, 300));
  assert.ok(/部分分区读不到/.test(text), '缺的那一半必须被说明：' + text.slice(0, 300));
  assert.ok(text.includes('no-team-member-authority'), '未给出缺那一半的原因：' + text.slice(0, 300));
});

// ------------------------------------------------------------------ 0.15.4 团队任务板

test('★ 花名册：Team 任务板必须与成员一起渲染（否则「平级」只剩一个名字）', async () => {
  // 官方 TeamView 是 `{ members, tasks }` —— 任务板是**团队级**事实，不是成员的属性。
  // 0.15.4 之前桥只透出成员行，用户看不到「他们在协作什么」：谁在做什么、
  // 被谁卡住、写哪些文件。这条护栏钉住任务板真的到达了界面。
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'settings',
    roster: {
      subAgents: [],
      team: [{ id: 't1', name: 'reviewer', role: 'teammate', status: 'running', model: 'deepseek:deepseek', taskCount: 1 }],
      tasks: [{
        id: 'task-1', subject: '修 POST 405', status: 'in_progress', ownerName: 'reviewer',
        blockedBy: ['task-0'], writeScopes: ['lib/'], ready: false, writeScopeWarnings: ['与 task-2 重叠'],
      }],
    },
  });
  assert.deepEqual(errors, [], '任务板渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  assert.ok(text.includes('Team 任务板'), '缺少任务板分区：' + text.slice(0, 400));
  assert.ok(text.includes('修 POST 405'), '任务标题必须渲染：' + text.slice(0, 400));
  assert.ok(text.includes('进行中'), '任务状态必须是可读文本而不是黑话：' + text.slice(0, 400));
  assert.ok(text.includes('reviewer'), '任务归属必须显示：' + text.slice(0, 400));
  assert.ok(/阻塞于 1 项/.test(text), '被阻塞的任务必须能看出「被什么卡住」：' + text.slice(0, 400));
  assert.ok(/写范围告警/.test(text), '写范围告警（官方算好的）必须透出：' + text.slice(0, 400));
  // 成员行上的模型：Team 与子代理最直观的差别之一。
  assert.ok(text.includes('deepseek:deepseek'), '成员模型必须显示：' + text.slice(0, 400));
  // 写范围是 advisory 而不是锁 —— 官方明文，界面必须说清楚，否则用户会以为有互斥。
  assert.ok(/写范围只是提醒而不是锁/.test(text), '未说明写范围是 advisory 而非锁');
});

test('★ 花名册：teamError 与 tasksError 同源失败时不得把同一句话重复两遍', async () => {
  // Team 成员与任务板都走官方 agentTeams 服务：同一个失败会在两处各报一次。
  // 旧实现用 ' / ' 硬拼，于是界面出现「X / X」——读起来像两个独立问题。
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'settings',
    roster: {
      subAgents: [], team: [], tasks: [],
      teamError: 'caller-not-live', subAgentsError: 'no-session-id',
    },
  });
  assert.deepEqual(errors, [], '渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  assert.ok(/读不到花名册/.test(text), '未如实报告「读不到」：' + text.slice(0, 300));
  assert.ok(text.includes('caller-not-live') && text.includes('no-session-id'),
    '两个**不同**的原因都要出现：' + text.slice(0, 300));
  // 同一个原因出现两次就是噪音，不是信息。
  assert.equal((text.match(/caller-not-live/g) || []).length, 1,
    '同一原因被重复渲染：' + text.slice(0, 300));
});

// ------------------------------------------------------------------ 0.14.9 去臃肿

test('★ 等待药丸：真的渲染出短读数，且默认不展开明细', async () => {
  // 这条必须走真实组件（不再只是扫源码）：此前 dock 组件从未被捕获，
  // 「药丸到底渲染出什么」在测试里是空白。
  const { errors, tree } = await renderPane({ which: 'dock', payloads: [{}] });
  assert.deepEqual(errors, [], '药丸渲染抛错');
  const text = treeText(tree);
  assert.match(text, /等待发送 3 s/, '药丸必须显示服务端算好的短读数');
  // 默认收起：明细只在点击后才出现——「默认没有，点击能出现」是用户的要求。
  assert.ok(!/累计等待发送/.test(text), '明细默认不应展开');
  assert.ok(!/本会话尚无等待记录/.test(text), '不该显示空态文案');
});

// --------------------------------------------------------- 0.16.24 在途等待计时

// 需求（用户原话）：「能做到等待发送实际显示和官方一样开始就计时增长，不要等过了
// 再变一下子从 n 秒到 m 秒？」这条链路跨三处，缺一处就退回旧观感：
//   index.js  在等待**开始**时发布 live（而不是等账本结算）
//   web-control.js 把 live + now 透给药丸
//   client.cjs 在途时把轮询提到 1 秒（否则 10 秒才动一格）
// 前两处由 wait-stats 单测与服务端夹具钉住，这里钉住「客户端确实照它渲染与加速」。

/** 在途等待的服务端载荷（字段照 /__webcode/wait-stats 真实输出给）。 */
const liveWaitPayload = {
  ok: true,
  total: { totalWaitMs: 20000, turns: 9, waitedTurns: 4, rateLimitRetries: 1, updatedAt: 1789000000000 },
  // 本会话账本里已有 12 秒历史等待：在途读数必须**盖过**它，否则用户看到的
  // 仍是一个不动的数（这正是旧观感）。
  session: { totalWaitMs: 12000, turns: 2, waitedTurns: 1, rateLimitRetries: 0, updatedAt: 1789000000000 },
  live: { startedAt: 1789000000000, endsAt: 1789000010000, baseMs: 0, kind: 'gap' },
  now: 1789000003000,
  rows: [{ label: '累计等待发送', value: '20.0 s' }],
  label: '等待发送 3 s',
  sessionValue: '12 s',
  liveValue: '3 s',
  detailRows: [
    { label: '本次会话等待发送', value: '12 s' },
    { label: '累计等待发送', value: '20.0 s' },
  ],
};

test('★ 等待药丸：在途读数盖过账本累计（显示正在涨的那个数）', async () => {
  const { errors, tree } = await renderPane({ which: 'dock', payloads: [{}], waitStats: liveWaitPayload });
  assert.deepEqual(errors, [], '在途药丸渲染抛错');
  const text = treeText(tree);
  assert.match(text, /等待发送 3 s/, '在途时必须显示现算的短读数');
  // 账本里的 12 s 不得到药丸上——两个数同时出现等于没修。
  assert.ok(!/等待发送 12 s/.test(text), '在途时药丸不得回落到账本累计值');
});

test('★ 等待药丸：在途时轮询提到 1 秒（10 秒一问等于没在动）', async () => {
  // 这条是需求里最容易漏掉的一半：服务端算得再勤，客户端 10 秒才问一次，
  // 数字仍然是「一下子跳」。两者必须成对。
  const live = await renderPane({ which: 'dock', payloads: [{}], waitStats: liveWaitPayload });
  assert.deepEqual(live.errors, []);
  assert.ok(live.intervalDelays.includes(1000), '在途等待时轮询周期必须是 1000ms（实得：' + live.intervalDelays.join(',') + '）');
  // 静止（无 live）时保持 10 秒，不要把本地回环请求变成每秒一次。
  const idle = await renderPane({ which: 'dock', payloads: [{}] });
  assert.ok(idle.intervalDelays.includes(10000), '静止时必须保持 10000ms 轮询');
  assert.ok(!idle.intervalDelays.includes(1000), '静止时不该每秒轮询');
});

test('★ 等待药丸：展开面板含「正在等待发送」行（与药丸同源同数）', async () => {
  // 展开态的内容由本条源码护栏 + wait-stats 单测覆盖（同 0.15.11 的既有做法：
  // 本 harness 的 setState 不触发重渲染，点开态无法在渲染树里直接观察）。
  const src = bridgeSrcFrom('client.cjs');
  // 药丸文案与面板行都取服务端算好的字段，客户端不自己算时长——
  // 否则「两个数字迟早对不上」（见 wait-stats.js 开头的口径说明）。
  assert.ok(/data\?\.liveValue/.test(src), '展开面板必须渲染 liveValue（在途那一段）');
  assert.ok(src.includes('正在等待发送'), '展开面板必须有「正在等待发送」行');
  // 空态判定要把 liveValue 算进去：在途但账本还空时（首次等待）不能落到
  // 「本会话尚无等待记录」——那正是「首次等待整枚药丸不渲染」的同族缺陷。
  assert.ok(/\(data\?\.liveValue \|\| rows\.length\)/.test(src), '空态判定必须包含 liveValue');
});

test('★ 等待药丸：可点（onClick 存在），且 aria 契约完整', async () => {
  const { errors, tree } = await renderPane({ which: 'dock', payloads: [{}] });
  assert.deepEqual(errors, []);
  // 找到药丸按钮并触发它的 onClick（真实组件树的第一次点击）。
  const buttons = [];
  const collect = (el) => {
    if (el === null || el === undefined || typeof el !== 'object') return;
    if (Array.isArray(el)) { el.forEach(collect); return; }
    if (typeof el.type === 'function') { collect(el.type(el.props)); return; }
    if (el.type === 'button') buttons.push(el);
    (el.children || []).forEach(collect);
  };
  collect(tree);
  assert.ok(buttons.length > 0, '药丸按钮不存在');
  const pill = buttons[0];
  // 「默认没有，点击能出现」：收起态 + 真的挂了 onClick（点击由 React 驱动，
  // 这里能验证的是契约本身——展开态的内容由下一条源码护栏与 wait-stats 单测覆盖）。
  assert.equal(pill.props['aria-expanded'], false, '默认必须是收起的');
  assert.equal(pill.props['aria-haspopup'], 'dialog', '对齐官方统计药丸的 aria 契约');
  assert.equal(typeof pill.props.onClick, 'function', '药丸必须可点（点击才出现明细）');
  // 官方那两枚药丸只给 aria-haspopup/aria-expanded，不挂 role="status"。
  assert.equal(pill.props.role, undefined, '按钮不得挂 role="status"');
  assert.match(String(pill.props['aria-label']), /等待发送/);
});

test('★ 等待药丸：靠官方 dock 行自身的 flex 同栏，不得 portal、不得几何偏移', () => {
  // 用户原话：「写死的会被侧面面板挤到重叠的」。0.15.10 用负上边距把本行拽进
  // 官方那一行，官方行一旦换行（右栏把输入区挤窄）两块内容就叠在一起。
  //
  // 0.15.11 改成 portal 进 [data-composer-stats] 行容器，但**那个官方标记在
  // DSH 0.1.6-alpha.2 里已经不存在**（新版 StatsPills 根节点只渲染 className，
  // 整个包 grep 命中 0 处）。于是 portal 分支永不生效，回落的自建整行
  // （width:100%）反而把官方药丸挤到下一行——这就是用户报的「没适配」。
  //
  // 新版正确解：`conversation.composer.dock` 的条目本来就是官方 dock flex 行的
  // 直接子项（ui-conversation 的 InputBar 直接 renderSlot 再渲染 ContextMeter），
  // 所以只要自己是 inline-flex，同栏就自动成立。
  //
  // 这条同时钉住三件事：不许再 portal（依赖已消失的标记）、不许有几何偏移、
  // 必须是 inline-flex 而不是整行。
  const src = bridgeSrcFrom('client.cjs');
  // 断言的是**调用形态**而不是这个词：0.16.18 的注释里正当地解释了「为什么不再用
  // portal」，把注释一起禁掉会逼着后续维护者删掉那段解释——那是本末倒置。
  assert.ok(!/\bcreatePortal\s*\(/.test(src), 'client.cjs 不得再调用 createPortal：官方 [data-composer-stats] 标记已不存在');
  assert.ok(!src.includes('useOfficialStatsHost'), '不得保留找官方统计行的旧钩子');
  assert.ok(!/data-composer-stats'\]/.test(src), '不得再按已消失的官方标记去 querySelector');
  assert.ok(!/joinOffset/.test(src), '不得再保留负边距的几何补偿量 joinOffset');
  assert.ok(!/marginTop:\s*-/.test(src), '不得给等待 wrap 写负上边距');
  assert.ok(!/\.hwb-waitwrap\.joined/.test(src), '不得保留 joined 的几何 hack 样式');
  // 必须是内联行内盒：整行 width:100% 正是「药丸独占一行」的成因。
  const wrap = src.slice(src.indexOf('".hwb-waitwrap{'), src.indexOf('".hwb-waitpill{'));
  assert.match(wrap, /display:inline-flex/, '等待 wrap 必须是 inline-flex（官方 dock 行已提供 justify-content:center）');
  assert.ok(!/width:100%/.test(wrap), '不得给等待 wrap 写 width:100%——那会独占官方 dock 行');
});

test('★ 等待药丸：关闭语义必须与官方一致（Esc + 点外部）', () => {
  // 官方 StatsPills 由 useStatDialog + useDismissOnOutsidePointer 驱动：同一时刻
  // 只有一枚药丸开着，点别处收起。本组件是独立 dock 条目、拿不到那份 state，
  // 因此必须等价实现这两个事件，否则面板会一直挂着不自动收缩。
  const src = bridgeSrcFrom('client.cjs');
  assert.ok(/key === 'Escape'/.test(src), '必须支持 Esc 收起');
  assert.ok(src.includes("'pointerdown'"), '必须监听 pointerdown 以复刻官方的点外部关闭');
  assert.ok(/!root\.contains\(event\.target\)/.test(src), '关闭边界必须是本组件自身，而不是整行');
});

test('★ 等待药丸：字号/行高/高度必须走官方 content-font token，不得写死像素', () => {
  // 官方药丸（ui-chat 的 StatsPills 与 TurnUsagePanel）三个值都走 token：字号取
  // `--dsh-content-font-size-secondary`（缺省 13px），行高取
  // `--dsh-content-font-delta-secondary` 以 24px 为基，高度取
  // `--dsh-content-font-delta` 以 28px 为基。
  // 用户在设置里改「内容字号」时，这两个 delta 会让官方所有药丸一起缩放；
  // 写死 13px/24px/28px 的那一枚**不跟着变**——同一行里出现一大一小两枚药丸，
  // 就是「没适配」在数值层面的形态。
  //
  // 为什么用静态样式断言：这是 CSS 值，渲染树的文本里读不到；而它恰恰最容易
  // 被后续「顺手调一下」改回写死值（13px 看着也不丑）。钉住 token = 把适配
  // 结论变成可执行约束。
  const src = bridgeSrcFrom('client.cjs');
  // 取单条规则：CSS 是 `".hwb-x{...}"` 形式，所以规则的右界是 `}"` 而不是 `"}`。
  // 写错会静默变成 `slice(i, -1)`——那会扫到文件结尾（26KB），断言于是横跨几十条
  // 规则。这类断言看起来更严，实际是在别处命中，是**假绿**。
  const ruleAt = (sel) => {
    const i = src.indexOf(sel);
    assert.ok(i > 0, '找不到样式规则：' + sel);
    const end = src.indexOf('}"', i);
    assert.ok(end > i, '样式规则 ' + sel + ' 没有终止符' );
    return src.slice(i, end + 2);
  };
  const pill = ruleAt('".hwb-waitpill{');
  assert.match(pill, /font-size:var\(--dsh-content-font-size-secondary,13px\)/, '药丸字号必须走官方 content-font token');
  assert.match(pill, /line-height:calc\(24px \+ var\(--dsh-content-font-delta-secondary,0px\)\)/, '药丸行高必须跟随官方 content-font delta');
  assert.match(pill, /height:calc\(28px \+ var\(--dsh-content-font-delta,0px\)\)/, '药丸高度必须跟随官方 content-font delta');
  assert.ok(!/font-size:13px/.test(pill), '药丸字号不得写死 13px：用户改内容字号时它不会跟着缩放');
});

test('★ 左栏任务板：整列页面排版必须对齐官方 page 契约', () => {
  // 左栏入口切过来的是**整列页面**。官方给整列页面的排版是 ui-plugin-manager 的
  // `X_2TxG_page` / `X_2TxG_pageTitle`：
  //   padding: 28px clamp(24px,4vw,48px) 48px；分节间距 32px
  //   正文列:  width:100%; max-width:960px（居中）
  //   标题:    font-size:20px; font-weight:500; line-height:28px
  // 旧的 15px/24px + padding:16px 20px 是**右栏窄条**那一档的尺度。沿用窄条
  // 尺度会让整列页面像「一条被放大的侧栏」，也压不住下面 13px 的正文。
  const src = bridgeSrcFrom('client.cjs');
  // 同 `ruleAt`：右界必须是 `}"`。写 `"}` 会返回 -1，回落分支于是扫到文件结尾，
  // 断言横跨几十条规则——看着更严，其实是假绿。
  const grab = (sel) => {
    const i = src.indexOf(sel);
    assert.ok(i > 0, '找不到样式规则：' + sel);
    const end = src.indexOf('}"', i);
    assert.ok(end > i, '样式规则 ' + sel + ' 没有终止符');
    return src.slice(i, end + 2);
  };
  const main = grab('".hwb-main{');
  assert.match(main, /display:flex/, '整列页面容器应为 flex 列');
  assert.match(main, /gap:32px/, '分节间距应为 32px（官方 page 契约）');
  assert.match(main, /padding:28px clamp\(24px,4vw,48px\) 48px/, '页面内边距应对齐官方 page 契约');
  assert.match(main, /flex:1/, '必须保留 flex:1 占满中央列');
  assert.match(main, /min-height:0/, '必须保留 min-height:0 以便内部滚动');
  assert.match(grab('".hwb-main>*{'), /max-width:960px/, '正文列应为官方 960px 列宽');
  const head = grab('".hwb-main-head{');
  assert.match(head, /font-size:20px/, '页面标题应为 20px（官方 pageTitle），而不是右栏窄条的 15px');
  assert.match(head, /line-height:28px/, '页面标题行高应为 28px');
});

test('去臃肿：设置页密度 token 必须与调研 token 表一致，且不再用线分隔行', async () => {
  // 用户原话：「做到简洁高效美观，而不是现在的臃肿」。
  // 数值依据不是审美偏好，而是 doc/research/agent-ui-design-references.md §4.4
  // 的 token 表（Apple HIG 可执行约束 + Fluent 2 的 4px 阶梯 + 官方包实测值）。
  //
  // 为什么用**静态样式断言**而不是渲染断言：这是 CSS 值，渲染树的文本里读不到；
  // 而它恰恰是最容易被后续「顺手调一下」改回去的东西（16px 看着也「不丑」）。
  // 钉住数值 = 把调研结论变成可执行的约束，而不是一段会被遗忘的文档。
  const src = bridgeSrcFrom('client.cjs');
  // 右界是 `}"`（CSS 写成 `".hwb-x{...}"`）。旧写 `"}` 恒返回 -1，回落分支
  // `slice(i, i+400)` 于是横跨好几条规则——断言在**别的规则**里命中，是假绿。
  const grab = (sel) => {
    const i = src.indexOf(sel);
    assert.ok(i > 0, '找不到样式规则：' + sel);
    const end = src.indexOf('}"', i);
    assert.ok(end > i, '样式规则 ' + sel + ' 没有终止符');
    return src.slice(i, end + 2);
  };
  // 卡片圆角：12px（§4.4 明列「从现 16px 收紧」）
  const card = grab('".hwb-card{');
  assert.match(card, /border-radius:12px/, '卡片圆角应为 12px（§4.4），实际：' + card.slice(0, 160));
  assert.ok(!/border-radius:16px/.test(card), '卡片圆角退回 16px（用户报的「臃肿」来源之一）');
  // 标签列宽：96px（Apple「omit unnecessary words」，§4.4 明列）
  const label = grab('".hwb-row-label{');
  assert.match(label, /flex:0 0 96px/, '标签列宽应为 96px（§4.4），实际：' + label.slice(0, 160));
  assert.ok(!/0 0 128px/.test(label), '标签列宽退回 128px');
  // 行内边距：8px（Fluent 4 的倍数，§4.4 明列）
  assert.match(grab('".hwb-row{'), /padding:8px 0/, '行内边距应为 8px（§4.4）');
  // 删线，用间距（Fluent 原文：spacing creates sections without having to use lines）
  assert.ok(!/\.hwb-row\{[^}]*border-bottom/.test(src), '.hwb-row 又画回了分隔线（应用间距）');
  assert.ok(!/\.hwb-site-block\{[^}]*border-bottom/.test(src), '.hwb-site-block 又画回了分隔线');
});

test('去臃肿：气泡状按钮圆角应收紧，不保留 16px 的「药丸」', async () => {
  // 同一条依据（§4.4「卡片圆角 12px」的同一取向）。注意**不能**把状态 pill
  // 一起去掉——那只 pill 是状态载体，属于「不要为了美观丢掉信息」的反面。
  const src = bridgeSrcFrom('client.cjs');
  const i = src.indexOf('".hwb-row button,.hwb-settings button{');
  assert.ok(i > 0, '找不到主按钮样式');
  const rule = src.slice(i, src.indexOf('"}', i));
  const m = /border-radius:(\d+)px/.exec(rule);
  assert.ok(m, '主按钮未声明 border-radius：' + rule.slice(0, 200));
  assert.ok(Number(m[1]) <= 12, '主按钮圆角 ' + m[1] + 'px 仍偏「药丸」，应与收紧后的卡片一致（≤12px）');
});

/**
 * `settings.section` 的会话身份契约（0.15.3 真机缺陷）。
 *
 * 真机：设置页花名册恒回 `subAgentsError: "no-session-id"`，永远读不到成员。
 * 根因是**槽作用域与 inject 参数的错配**：
 *
 *   • `settings.section` 在官方槽目录里是 `scope: "root"`；
 *   • renderer 的 `runInject` 只对**带 binding 的会话级槽**传 `binding.key`，
 *     root 槽只拿到 `actions`；
 *   • 旧写法 `inject: (sessionId) => ({ sessionId })` 于是把那个 actions 对象
 *     当成会话 id 一路送到服务端，服务端解析不出会话，回 no-session-id。
 *
 * 正规入口是 official standard prop **`useSessions`**（官方 ui-settings-general
 * 自己就这么读会话）。这条断言把「不许再用 root 槽的 inject 冒充会话来源」
 * 钉死——它正是本轮修掉的第三个「引用存在、另一端不存在」型缺陷。
 */
test('设置页：会话身份必须经 useSessions 取，不得用 root 槽的 inject 冒充', async () => {
  const src = bridgeSrcFrom('client.cjs');

  // 1) settings.section 的注册块里不得再有 sessionId 形状的 inject。
  const regAt = src.indexOf("ctx.slots.inject('settings.section'");
  assert.ok(regAt > 0, '找不到 settings.section 的注册点');
  const regEnd = src.indexOf('SettingsSection));', regAt);
  assert.ok(regEnd > regAt, 'settings.section 未注册 SettingsSection（会话注入层缺失）');
  const block = src.slice(regAt, regEnd);
  assert.ok(!/inject\s*:/.test(block),
    'root 作用域的 settings.section 又声明了 inject —— 它拿不到会话 id，会把 actions 对象当成 sessionId：\n' + block);

  // 2) 必须真的走官方 useSessions 通道。
  assert.ok(/function SettingsSection\(/.test(src), '缺少 SettingsSection 会话注入层');
  assert.ok(/props\.useSessions|\.useSessions\b/.test(src), '没有使用官方 useSessions standard prop 读取会话');
  assert.ok(/useSessions\(s => \(s && s\.current\)/.test(src), 'useSessions 的取值形态变了（应读 state.current）');
});

// ------------------------------------------------------------------ 0.15.12 / 0.16.18 面板注册

/**
 * 标签页注册的**当前**形态：两个 kind，且都是 page type。
 *
 * 官方契约（tab-registry.d.ts）：省略 `patterns` 的类型是 page type，「is opened by
 * kind」，不做地址识别。团队面板本来就没有「打开某个资源」的语义——若照抄网页那个
 * kind 的写法给它加 patterns，它会去和文件类 kind 抢地址。
 *
 * 0.16.18 起任务板**不再是**右栏标签页（用户要求删掉那份注册）：它与左栏全局面板
 * 指向同一份数据、同一个组件，两个入口只会让用户不知道该看哪个；而右栏是窄条
 * 常驻视图，放不下依赖图。任务板现在只由左栏 `sidebar.panellist` + `main` 提供。
 */
test('★ 标签页：只注册 webcode-bridge 与 webcode-team，任务是左栏面板而非右栏标签', async () => {
  const { errors, paneKeys, tabDefinitions } = await renderPane({ payloads: [emptyWindows] });
  assert.deepEqual(errors, [], '注册阶段抛错：' + errors.map(e => e.message).join('; '));
  for (const kind of ['webcode-bridge', 'webcode-team']) {
    assert.ok(tabDefinitions.has(kind), '标签页类型未注册：' + kind + '（已注册：' + [...tabDefinitions.keys()].join(', ') + '）');
    const def = tabDefinitions.get(kind);
    assert.equal(typeof def.title, 'function', kind + ' 的 title 必须是 thunk（语言切换要能重读）');
    assert.equal(def.priority, 'extension', kind + ' 必须声明 extension 优先级');
    assert.ok(Array.isArray(def.guide) && def.guide.length > 0, kind + ' 缺少 guide 入口');
  }
  // 0.16.18：右栏不得再有任务板标签页。反向断言——防止日后「顺手」把那个 kind
  // 加回来，从而把用户明确要求删掉的双入口重新引入。
  assert.ok(!tabDefinitions.has('webcode-tasks'),
    '右栏不得再注册任务板标签页（0.16.18 起任务板只走左栏 sidebar.panellist）');
  // team 是 page type：不得声明 patterns。
  assert.equal(tabDefinitions.get('webcode-team').patterns, undefined,
    'webcode-team 声明了 patterns —— 它是 page type，不该参与地址识别');
  // 正文各自占一个 keyed 座位，且 key 互不相同（合成一个会让标签条出现同名项）。
  assert.equal(new Set(paneKeys).size, paneKeys.length, 'pane.tab 座位 key 有重复：' + paneKeys.join(', '));
  assert.ok(paneKeys.length >= 2, '面板正文未注册（座位：' + paneKeys.join(', ') + '）');
  assert.ok(!paneKeys.includes('dsh-webcode-bridge/tasks'),
    '任务板正文仍挂在 sidebar.right.pane.tab 上——右栏那份注册没删干净');
});

/**
 * Team 面板：成员行必须带可读的角色/状态/归属，且读不到时说「读不到」。
 *
 * 为什么不能只断言「不抛错」：那正是本项目已经踩过三次的坑（mock 失真 → 全绿
 * 但什么也没证明）。这里逐项要求**信息真的到达界面**：状态词、角色、模型、任务数。
 */
test('★ Team 面板：成员的角色/状态/模型/任务数都必须渲染成可读文本', async () => {
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'team',
    roster: {
      team: [
        { id: 's1', name: 'lead', role: 'lead', status: 'running', model: 'deepseek:deepseek' },
        { id: 's2', name: 'reviewer', role: 'teammate', status: 'idle', context: 'fresh', taskCount: 2 },
      ],
      tasks: [],
    },
  });
  assert.deepEqual(errors, [], 'Team 面板渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  assert.ok(text.includes('reviewer'), '成员名必须渲染：' + text.slice(0, 400));
  assert.ok(text.includes('teammate'), '角色必须渲染（官方给的就是这个词，原样透出）：' + text.slice(0, 400));
  assert.ok(text.includes('空闲'), '成员状态必须是可读词而不是只有色点：' + text.slice(0, 400));
  assert.ok(text.includes('deepseek:deepseek'), '成员模型必须显示：' + text.slice(0, 400));
  assert.ok(/任务 2/.test(text), '任务归属数必须显示：' + text.slice(0, 400));
  assert.ok(text.includes('fresh'), '上下文模式必须透出：' + text.slice(0, 400));
  // 共享 checkout 的事实不能省：否则「并行面板」看起来像隔离环境。
  assert.ok(/共享同一个 checkout/.test(text), '未说明 Team 共享 checkout');
});

/**
 * Team 面板：`inactive` 必须显示成「未加载（可唤醒）」，不是「已停止」。
 *
 * 官方 README（agent-team）明说这种成员仍会收到排队消息。显示成「已停止」会让
 * 用户去重建一个本来还活着的成员——动作完全错，而界面上看不出错。
 */
test('★ Team 面板：inactive 成员必须说「可唤醒」，不得显示成已停止', async () => {
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'team',
    roster: { team: [{ id: 's2', name: 'reviewer', role: 'teammate', status: 'inactive' }], tasks: [] },
  });
  assert.deepEqual(errors, [], '渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  assert.ok(/未加载（可唤醒）/.test(text), 'inactive 未按官方语义显示：' + text.slice(0, 400));
  assert.ok(!/已停止/.test(text), 'inactive 被显示成「已停止」——用户会去重建一个还活着的成员');
  assert.ok(/发一条消息就会唤醒/.test(text), '未给出可执行的下一步（怎么唤醒它）');
});

/**
 * Team 面板：只有 lead 一行时必须说明「没有派生 teammate」。
 *
 * 官方语义：**每个普通顶层会话都是隐式 Team 的 Lead**（agent-team README）。
 * 因此 `listMembers` 在没有团队时也会返回一行 lead——照单渲染会让用户以为
 * 有一个团队在协作，而实际上 `spawn_teammate` 根本没挂载。
 */
test('★ Team 面板：只有 lead 一行时必须说明「没有派生 teammate」', async () => {
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'team',
    roster: { team: [{ id: 's1', name: 'lead', role: 'lead', status: 'running' }], tasks: [] },
  });
  assert.deepEqual(errors, [], '渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  assert.ok(/没有派生出的 teammate/.test(text),
    '只有 lead 时未说明「没有派生 teammate」，会被读成「有一个团队」：' + text.slice(0, 400));
});

/**
 * 任务板：四组分区必须都在，且「可开工 / 被阻塞」按**官方 ready** 分流。
 */
test('★ 任务板：可开工与被阻塞必须分开，且阻塞明细要点名上游与它的状态', async () => {
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'tasks',
    roster: {
      team: [],
      tasks: [
        { id: 'a', subject: '跑基线', status: 'in_progress', ownerName: 'lead', blockedBy: [], ready: false },
        { id: 'b', subject: '可以开工的', status: 'pending', blockedBy: [], ready: true },
        { id: 'c', subject: '等基线的', status: 'pending', blockedBy: ['a'], ready: false },
        { id: 'd', subject: '已完成的', status: 'completed', blockedBy: [], ready: false },
      ],
    },
  });
  assert.deepEqual(errors, [], '任务板渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  for (const head of ['可开工', '被阻塞', '进行中', '已完成']) {
    assert.ok(text.includes(head), '缺少分区：' + head + ' —— ' + text.slice(0, 400));
  }
  assert.ok(text.includes('可以开工的'), '就绪任务未渲染：' + text.slice(0, 400));
  assert.ok(text.includes('等基线的'), '被阻塞任务未渲染：' + text.slice(0, 400));
  // 阻塞明细必须点名上游**并带它自己的状态**：否则分不清「正常等待」与
  // 「上游已失败、需要人处理」——那是两个完全不同的动作。
  assert.ok(/等在 跑基线（进行中）/.test(text),
    '阻塞明细未点名上游或没带上游状态：' + text.slice(0, 600));
  // 写范围是 advisory 而不是锁：官方明文，界面必须说清楚。
  assert.ok(/写范围重叠只是提醒而不是锁/.test(text), '未说明写范围是 advisory');
  // 就绪来源必须如实标注（官方值 vs 桥现算）。
  assert.ok(/就绪（ready）取官方算好的判据/.test(text), '未说明就绪判据的来源');
});

/**
 * 任务板：图诊断（阻塞点 / 关键路径 / 结构问题）必须真的渲染。
 *
 * 这是本轮新增的**图级**视角——官方逐行事实里没有这一层。三条都必须到达界面，
 * 否则「为什么整块板没动」这个问题在 UI 上仍然没有答案。
 */
test('★ 任务板：图诊断三件套（阻塞点 / 关键路径 / 环）都必须渲染', async () => {
  const graph = {
    counts: { total: 3, pending: 2, inProgress: 1, completed: 0, ready: 1, blocked: 1, unowned: 0, deleted: 0 },
    nodes: [],
    acyclic: true,
    criticalPath: ['a', 'c'],
    criticalPathLength: 2,
    cycles: [],
    selfLoops: [],
    missingEdges: [],
    blockedOn: [{ id: 'a', subject: '跑基线', status: 'in_progress', ownerName: 'lead', waitingCount: 1 }],
  };
  const tasks = [
    { id: 'a', subject: '跑基线', status: 'in_progress', ownerName: 'lead', blockedBy: [], ready: false },
    { id: 'b', subject: '旁路', status: 'pending', blockedBy: [], ready: true },
    { id: 'c', subject: '收尾', status: 'pending', blockedBy: ['a'], ready: false },
  ];
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'tasks',
    roster: { team: [], tasks, graph },
  });
  assert.deepEqual(errors, [], '图诊断渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  assert.ok(/当前阻塞点/.test(text), '缺少「当前阻塞点」分区：' + text.slice(0, 500));
  assert.ok(/卡住 1 项/.test(text), '阻塞点未给出卡住的下游数：' + text.slice(0, 500));
  assert.ok(/关键路径（2 个任务）/.test(text), '缺少关键路径：' + text.slice(0, 500));
  // 关键路径必须用**任务标题**而不是裸 id——裸 id 用户认不出是哪个任务。
  assert.ok(/跑基线 → 收尾/.test(text), '关键路径未渲染成可读标题链：' + text.slice(0, 600));
});

/**
 * 任务板：图结构问题（环 / 自环 / 悬空边）必须红字报出，且说明后果。
 *
 * 带环的图在界面上表现为「一堆永远不 ready 的待办」，看起来像卡死，其实是结构错误。
 * 只说「有环」不够——必须说「环内任务永远不会就绪」。
 */
test('★ 任务板：环 / 自环 / 悬空边必须报出，并说明「永远不会就绪」的后果', async () => {
  const graph = {
    counts: { total: 2, pending: 2, inProgress: 0, completed: 0, ready: 0, blocked: 2, unowned: 2, deleted: 0 },
    nodes: [], acyclic: false, criticalPath: [], criticalPathLength: null,
    cycles: [['a', 'b']], selfLoops: ['c'], missingEdges: [{ from: 'a', to: 'ghost' }],
    blockedOn: [],
  };
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'tasks',
    roster: { team: [], tasks: [{ id: 'a', subject: 'A', status: 'pending', blockedBy: ['b'], ready: false }], graph },
  });
  assert.deepEqual(errors, [], '结构问题渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  assert.ok(/图结构问题/.test(text), '缺少图结构问题分区：' + text.slice(0, 500));
  assert.ok(/依赖成环/.test(text), '未报出环：' + text.slice(0, 500));
  assert.ok(/永远不会就绪/.test(text), '未说明环的后果（环内任务永远不会就绪）');
  assert.ok(/自环/.test(text), '未报出自环：' + text.slice(0, 500));
  assert.ok(/悬空依赖/.test(text), '未报出悬空边：' + text.slice(0, 500));
  // 带环时**不得**给出关键路径——无定义的东西不该有值。
  assert.ok(!/关键路径（/.test(text), '带环时仍渲染了关键路径（图上最长路径无定义）');
  assert.ok(/无法计算关键路径与深度/.test(text), '带环时未说明为何没有关键路径');
});

/**
 * 两个新面板的读不到路径：必须说「读不到」+ 原因，不得画成空列表。
 */
test('★ 新面板：读不到时必须给原因，不得画成「确实没有」', async () => {
  const roster = { team: [], tasks: [], teamError: 'caller-not-live', tasksError: 'caller-not-live' };
  const team = await renderPane({ payloads: [emptyWindows], which: 'team', roster });
  assert.deepEqual(team.errors, [], 'Team 面板读不到时抛错：' + team.errors.map(e => e.message).join('; '));
  const teamText = treeText(team.tree);
  assert.ok(teamText.includes('caller-not-live'), 'Team 面板未给出原因：' + teamText.slice(0, 400));
  assert.ok(/不代表没有成员/.test(teamText), 'Team 面板未澄清「读不到 ≠ 没有成员」');

  const tasks = await renderPane({ payloads: [emptyWindows], which: 'tasks', roster });
  assert.deepEqual(tasks.errors, [], '任务板读不到时抛错：' + tasks.errors.map(e => e.message).join('; '));
  const taskText = treeText(tasks.tree);
  assert.ok(taskText.includes('caller-not-live'), '任务板未给出原因：' + taskText.slice(0, 400));
  assert.ok(/不代表没有任务/.test(taskText), '任务板未澄清「读不到 ≠ 没有任务」');
});

/**
 * 两个新面板不得在浏览器侧重算图论。
 *
 * 图诊断由服务端 `lib/task-graph.js` 算好后经 /status 透出。在浏览器侧再写一份
 * （比如本地按 blockedBy 推 ready）会立刻产生两份真相：面板说「可开工」、服务端
 * 说 ready=false，而用户不知道信哪个——这正是本项目反复踩过的那一族缺陷。
 */
test('★ 新面板：不得在客户端重算就绪/关键路径（图诊断只有一个来源）', async () => {
  const src = bridgeSrcFrom('client.cjs');
  const at = src.indexOf('function TaskBoardPanel');
  assert.ok(at > 0, '找不到 TaskBoardPanel');
  // 取到下一个顶层函数为止，避免把别处的代码算进来。
  const end = src.indexOf('\n    function ', at + 10);
  const body = src.slice(at, end === -1 ? at + 6000 : end);
  assert.ok(!/blockedBy\.every\(/.test(body),
    'TaskBoardPanel 里出现了官方就绪判据的重算 —— 就绪只能取服务端/官方值');
  assert.ok(!/\.depth\s*=/.test(body) && !/topolog/i.test(body),
    'TaskBoardPanel 里出现了图算法 —— 图诊断只能来自服务端 graph 字段');
  assert.ok(/data\.graph|graph\b/.test(body), 'TaskBoardPanel 没有消费服务端的 graph 字段');
});

// ---------------------------------------------------------------- 0.16.0 左栏入口

/**
 * 左栏入口必须**成对**注册：`sidebar.panellist` 的行 + 同名 key 的 `main` 座位。
 *
 * 为什么这条要单独钉住：官方契约原文是「Each list id addresses the matching main
 * panel; the sidebar owns the button」——侧栏行只是指向 main 座位的按钮，点它走
 * shell 的 `selectPanel(id)`，而 layout service 会**校验该 key 是否已注册**
 *（`layout.selectPanel: main panel \"X\" is not registered` 直接抛）。
 * 只注册一半的话，界面看起来正常、点一下就报错——这类「有一半是死的」最难发现。
 * 因此这里同时断言两半都存在，且 id 与 key **逐字相同**（不同名等于没注册 main）。
 */
test('★ 左栏入口：sidebar.panellist 与同名 main 座位必须成对注册', async () => {
  const { errors, panelEntries, mainKeys } = await renderPane({ payloads: [emptyWindows] });
  assert.deepEqual(errors, [], '注册阶段抛错：' + errors.map(e => e.message).join('; '));
  assert.ok(panelEntries.length > 0, 'sidebar.panellist 从未注册（左栏入口不存在）');
  const entry = panelEntries[0];
  assert.ok(entry.id, 'panel 行缺少 id —— 契约要求 list id 即 main 面板 key');
  assert.equal(typeof entry.label, 'function', 'panel 行 label 必须是 thunk（语言切换要能重读）');
  assert.equal(entry.label(), '任务板', 'panel 行的标签不是「任务板」');
  assert.ok(mainKeys.includes(entry.id),
    'main 座位未注册同名 key：' + entry.id + '（已注册：' + mainKeys.join(', ') + '）');
});

/**
 * 左栏入口的图标：只画图标，不得自绘按钮。
 *
 * 官方契约把按钮（含 Tooltip、aria-current、折叠态的 18px 图标、选中高亮）归 shell，
 * 我们只供图标 + 标签。若这里出现 <button> 或 onClick，就是**把 DOM 注入那套
 * 搬回来了**：那会与 shell 的渲染打架（点一下触发两次），且丢掉键盘可达性。
 */
test('★ 左栏入口图标：不得自绘 button（按钮与可访问名归 shell）', async () => {
  const src = bridgeSrcFrom('client.cjs');
  const at = src.indexOf('function TaskBoardPanelIcon');
  assert.ok(at > 0, '找不到 TaskBoardPanelIcon');
  const end = src.indexOf('\n    function ', at + 10);
  const body = src.slice(at, end === -1 ? at + 2000 : end);
  assert.ok(!/'button'/.test(body), 'TaskBoardPanelIcon 自绘了 button —— 按钮必须归 shell');
  assert.ok(!/onClick/.test(body), 'TaskBoardPanelIcon 挂了点击处理 —— 选中动作必须归 shell');
  assert.ok(/props\?\.size|props\.size/.test(body), '图标没有消费 shell 给的 size（折叠态尺寸会错）');
});

test('设置页：useSessions 缺席时优雅降级为 null，不得整块崩掉', async () => {
  const src = bridgeSrcFrom('client.cjs');
  // 回落链必须是 useSessions → props.sessionId → null：测试桩与「会话尚未建立」
  // 都走这条路，且这是**正常情况**而非错误（面板会如实说 no-session-id）。
  assert.ok(/return current \|\| props\?\.sessionId \|\| null;/.test(src),
    'useCurrentSessionId 的回落链变了：应为 useSessions → props.sessionId → null');
  // 无条件调用 hook（条件调用会复现 SiteAccounts 那类 hooks 顺序违规）。
  assert.ok(/const useSessions = typeof props\?\.useSessions === 'function' \? props\.useSessions : noSessions;/.test(src),
    'useSessions 的取值被写成条件分支外的形式之外了；必须常量选择后再无条件调用');
});
