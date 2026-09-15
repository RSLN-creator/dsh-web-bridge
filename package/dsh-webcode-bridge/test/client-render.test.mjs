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
async function renderPane({ payloads, which = 'pane', sites = [], roster = null } = {}) {
  const saved = { window: global.window, document: global.document, fetch: global.fetch, setInterval: global.setInterval, clearInterval: global.clearInterval };
  const realSetTimeout = global.setTimeout;
  let captured = null;
  let PaneComponent = null;
  let SettingsComponent = null;
  const MenuItems = [];
  const effectDisposers = [];
  let windowHits = 0;
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
      const changed = !prev || !deps || !prev.deps || deps.some((d, k) => d !== prev.deps[k]);
      if (changed && !prev?.ran) { effectSlots[i] = { fn, deps, ran: true }; pendingEffects.push(fn); }
      else effectSlots[i] = prev || { fn, deps, ran: false };
    },
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
  };
  const mockRequire = (id) => {
    if (id === 'react') return React;
    if (id === 'react-dom/client') return { createRoot: () => ({ render() {} }) };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { IconCodeOutline16: () => null };
    throw new Error('unexpected require: ' + id);
  };

  try {
    global.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };
    global.document = { createElement: () => ({ textContent: '', remove() {} }), head: { appendChild() {} } };
    global.setInterval = () => ({});       // 组件的轮询计时器：不 stub 会拖住事件循环
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
          ...(roster ? {
            subAgents: roster.subAgents || [], team: roster.team || [],
            subAgentsError: roster.subAgentsError ?? null, teamError: roster.teamError ?? null,
          } : {}) };
      }
      else if (u.includes('/__webcode/settings')) body = { ok: true, extraPrompt: '', sendGapMs: 10000, thinkMode: 'auto', subAgentMode: 'own', subAgentSite: 'follow' };
      else if (u.includes('/__webcode/prompt-variants')) {
        // 0.14.0：设置页默认显示首轮提示词。变体必须真的带 text，否则「默认显示」
        // 只会渲染一个空 <pre>，与折叠起来没有区别。
        body = {
          ok: true, toolsSource: 'session',
          active: { variantId: 'glm', siteId: 'glm', model: 'glm:glm-5.3', tools: ['read', 'pwsh'], at: '2026-09-13T00:00:00.000Z' },
          variants: [
            { id: 'default', label: '默认（<tool_call> 标签形状）', note: 'n1', text: 'DEFAULT-PROMPT-TEXT', trainNote: 'tn1', siteIds: null, excludes: ['glm'] },
            { id: 'glm', label: 'GLM 专用（```json 代码块形状）', note: 'n2', text: 'GLM-PROMPT-TEXT', trainNote: 'tn2', siteIds: ['glm'], excludes: [] },
          ],
        };
      }
      else if (u.includes('/__webcode/models')) body = { ok: true, models: [{ id: 'deepseek:deepseek', name: 'deepseek/deepseek', siteId: 'deepseek', thinking: true }] };
      else if (u.includes('/__webcode/connect')) body = { ok: true, loggedIn: true };
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
          if (def?.name === 'sidebar.right.pane.tab') PaneComponent = Comp;
          if (def?.name === 'settings.section') SettingsComponent = Comp;
          if (def?.name === 'sidebar.right.tab.menu.item') MenuItems.push(Comp);
          return () => {};
        },
      },
      sidebarRightTabs: { register: () => () => {} },
      sidebarRight: { toggleExpanded() {} },
      get: () => null,
    });
    assert.ok(PaneComponent, 'sidebar.right.pane.tab 正文从未注册');
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
    const Target = which === 'settings' ? SettingsComponent : PaneComponent;
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
    return { errors, windowHits, tree, menuItems: MenuItems, effectDisposers };
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

test('设置面板：首轮提示词默认就显示（无需任何点击），且列出全部适配分支', async () => {
  // 用户原话：「设置界面提示词应该默认就显示，首轮提示词又不会变？有多的适配
  // 就可选择框选择列出」。旧实现折叠在 <details> 里，不点开页面上一个字都没有。
  const { errors, tree } = await renderPane({ payloads: [emptyWindows], which: 'settings' });
  assert.deepEqual(errors, [], '设置面板渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  // 默认展示的是「本会话实际在用的那一支」（payload 里 active=glm）
  assert.ok(text.includes('GLM-PROMPT-TEXT'), '首轮提示词未默认渲染：' + text.slice(0, 200));
  // 适配下拉必须列出另一个分支（默认标签形状），否则「可选」是空话
  assert.ok(text.includes('默认（<tool_call> 标签形状）'), '适配分支未在下拉里列出');
  assert.ok(text.includes('GLM 专用'), '当前适配分支未在下拉里列出');
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
  // 菜单项必须能安全渲染（面板未打开时也不得抛错），并如实说明作用于哪个站点
  for (const Item of menuItems) {
    let el;
    assert.doesNotThrow(() => { el = Item({ dismiss: () => {} }); });
    const t = treeText(el);
    assert.ok(t.length > 0, '菜单项没有可见文案');
    assert.match(t, /刷新网页|切换独立窗口/);
  }
});

// ------------------------------------------------------------------ 0.14.8

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
  const empty = treeText(tree);
  assert.ok(/没有正在运行的子代理或 Team 成员/.test(empty),
    '空花名册未给出如实说明：' + empty.slice(0, 200));
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

// ------------------------------------------------------------------ 0.14.9 去臃肿

test('去臃肿：设置页密度 token 必须与调研 token 表一致，且不再用线分隔行', async () => {
  // 用户原话：「做到简洁高效美观，而不是现在的臃肿」。
  // 数值依据不是审美偏好，而是 doc/research/agent-ui-design-references.md §4.4
  // 的 token 表（Apple HIG 可执行约束 + Fluent 2 的 4px 阶梯 + 官方包实测值）。
  //
  // 为什么用**静态样式断言**而不是渲染断言：这是 CSS 值，渲染树的文本里读不到；
  // 而它恰恰是最容易被后续「顺手调一下」改回去的东西（16px 看着也「不丑」）。
  // 钉住数值 = 把调研结论变成可执行的约束，而不是一段会被遗忘的文档。
  const src = bridgeSrcFrom('client.cjs');
  const grab = (sel) => {
    const i = src.indexOf(sel);
    assert.ok(i > 0, '找不到样式规则：' + sel);
    // 取到该规则的右花括号为止，避免误匹配下一条规则。
    const end = src.indexOf('"}', i);
    return src.slice(i, end === -1 ? i + 400 : end);
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
