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
async function renderPane({ payloads, which = 'pane' } = {}) {
  const saved = { window: global.window, document: global.document, fetch: global.fetch, setInterval: global.setInterval, clearInterval: global.clearInterval };
  const realSetTimeout = global.setTimeout;
  let captured = null;
  let PaneComponent = null;
  let SettingsComponent = null;
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
        body = { ok: true, relay: { running: true, consent: true, consentPersistent: true, metrics: { timing: 'measured', firstTokenMs: 500, thinkingMs: 100, responseMs: 2000, responseTps: 20, durationMs: 3000, sendWaitMs: 15000, rateLimitRetries: 1 } }, driver: { sites: [], selectedModel: 'deepseek:deepseek' }, build: { hash: 'x', version: 'test' } };
      }
      else if (u.includes('/__webcode/settings')) body = { ok: true, extraPrompt: '', sendGapMs: 10000, thinkMode: 'auto', subAgentMode: 'own', subAgentSite: 'follow' };
      else if (u.includes('/__webcode/models')) body = { ok: true, models: [{ id: 'deepseek:deepseek', name: 'DeepSeek', siteId: 'deepseek', thinking: true }] };
      else if (u.includes('/__webcode/connect')) body = { ok: true, loggedIn: true };
      return { ok: true, json: async () => body };
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
      slots: {
        inject: (_n, fn) => fn(),
        register: (def, Comp) => {
          if (def?.name === 'sidebar.right.pane.tab') PaneComponent = Comp;
          if (def?.name === 'settings.section') SettingsComponent = Comp;
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
    const instantiate = (el) => (el && typeof el.type === 'function' ? el.type(el.props) : el);
    const errors = [];
    const Target = which === 'settings' ? SettingsComponent : PaneComponent;
    for (const p of payloads) {
      current = p;
      states = []; effectSlots = [];
      for (let pass = 0; pass < 4; pass++) {
        cursor = 0; effectSlotCursor = 0; pendingEffects = [];
        try { instantiate(Target()); } catch (e) { errors.push(e); break; }
        for (const fn of pendingEffects) { try { fn(); } catch (e) { errors.push(e); } }
        await flush(); await flush();   // ← 异步 setState 必须在这里落地
      }
    }
    return { errors, windowHits };
  } finally {
    global.window = saved.window; global.document = saved.document;
    global.fetch = saved.fetch; global.setInterval = saved.setInterval; global.clearInterval = saved.clearInterval;
  }
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