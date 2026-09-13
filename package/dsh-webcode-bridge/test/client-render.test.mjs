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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(here, '../lib/client.cjs');

/** 在当前进程里加载 client.cjs 并跑若干渲染周期，返回每次渲染捕获的异常。 */
async function renderPane({ payloads, which = 'pane', sites = [] } = {}) {
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
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => {
      const i = cursor++;
      if (!(i in states)) states[i] = init;
      return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; }];
    },
    useEffect: (fn, deps) => {
      const i = effectSlotCursor++;
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
        body = { ok: true, relay: { running: true, consent: true, consentPersistent: true, metrics: { timing: 'measured', firstTokenMs: 500, thinkingMs: 100, responseMs: 2000, responseTps: 20, durationMs: 3000, sendWaitMs: 15000, rateLimitRetries: 1 } }, driver: { sites, selectedModel: 'deepseek:deepseek' }, build: { hash: 'x', version: 'test' } };
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
      // 函数组件：调它，并**继续展开它的返回值**（这才是「深度实例化」）。
      if (typeof el.type === 'function') return instantiate(el.type(el.props));
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
    let tree = null;
    for (const p of payloads) {
      current = p;
      states = []; effectSlots = [];
      for (let pass = 0; pass < 8; pass++) {
        cursor = 0; effectSlotCursor = 0; pendingEffects = [];
        try { tree = instantiate(Target()); } catch (e) { errors.push(e); break; }
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
  // 四态徽标都要能渲染出来（真实站点表里这四种状态是并存的）。
  for (const s of ['已登录', '已登录(缓存)', '未登录', '待检查']) {
    assert.ok(text.includes(s), '站点栏缺少登录态「' + s + '」');
  }
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