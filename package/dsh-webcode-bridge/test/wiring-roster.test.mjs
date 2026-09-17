// wiring-roster.test.mjs — 花名册**接线**护栏（0.15.2 补）。
//
// ## 为什么需要它（这是一次真机抓到的静默缺陷）
//
// 0.15.0 把 `/__webcode/status` 的 `subAgents` / `team` 从写死的空数组接到
// 真实数据源，注入点在 `lib/index.js` 里写成一句箭头函数：调用 `projectRoster`，
// 参数是 `(ctx, sessionId)`。
//
// 但 **index.js 从未从 roster 模块导入过 `projectRoster`**。
//
// 它是箭头函数体，创建时不求值 → 模块加载不报错；
// `roster.test.mjs` 直接测 `roster.js` 导出的纯函数 → 也不报错。
// 于是全量 421 项全绿，而真机上 `/__webcode/status` 的 `subAgentsError` 恒为
// `roster-threw: projectRoster is not defined`。
// 面板永远空白 —— 与 0.14.9「写死空数组」的可见后果一模一样，
// 连 `*Error` 这层「如实说读不到」的设计都被绕过了（它报的是**接线错误**，
// 不是任何一种正常降级）。
//
// ## 这条护栏的判据刻意选「整条路径真的活着」，而不是「某个名字出现在源码里」
//
// 源码文本断言（grep `projectRoster`）会**正好放过这个 bug**：那行调用确实
// 存在。判据必须是**行为**：
//
//   ① 反向（抓本 bug）：真实 apply() → 真实 HTTP → /__webcode/status，
//      `*Error` 不得是 `is not defined` / `is not a function` 这类**接线错误**。
//      放宽到「不是 ReferenceError/TypeError」而不是「等于某个具体字符串」，
//      是因为其余降级原因（服务没注册、无 sessionId…）都是**合法**的，
//      钉死具体值会在无关重构时误报。
//
//   ② 正向（证明 ① 不是空转）：同一个注入点接上完整服务桩时，
//      `/status` 必须真的读出成员。否则「不抛接线错误」可以靠
//      「把 rosterOf 整个删掉」满足 —— 那等于退回写死空数组。
//
// 两条都过，才说明「注入点存在且通向真实数据源」。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

/**
 * 起一个只挂了本插件 `webServer.register` 路由的真 HTTP 服务。
 *
 * 为什么走真实 HTTP 而不是直接调 `handler(req,res)`：`/status` 的 roster 分支
 * 在 `web-control.js` 里被包了 try/catch 并把异常文本**降级**成 `*Error` 字符串
 * ——直接把 handler 拿来调也得经过同一层才看得见那条字符串，但真实 HTTP 还额外
 * 覆盖了 `csrfSafe`（Host 必须是回环名族）与 JSON 序列化两层。真机走的就是这条路。
 */
function makeCtx({ services = {} } = {}) {
  const routes = new Map();
  const ctx = {
    llm: { registerAdapter() { /* 本护栏不关心模型注册 */ } },
    webServer: {
      register(def) { routes.set(def.path, def); return () => {}; },
    },
    // 官方两条取法（属性直取 / ctx.get）都要能被 roster.js 命中。
    get: (name) => services[name] ?? null,
    ...services,
  };
  return { ctx, routes };
}

const DRIVER_STUB = {
  status: () => ({ running: true, loggedIn: true }),
  close: async () => {},
  resetConversation: async () => {},
  sendTurn: async () => ({ text: '' }),
  sendPrompt: async () => ({ text: '' }),
};

async function withBridge(services, fn) {
  const { ctx, routes } = makeCtx({ services });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcode-wiring-'));
  const dispose = apply(ctx, { port: 0, requireConsent: false, driver: DRIVER_STUB, profileDir });
  // 路由以 `/__webcode/<suffix>` 为键注册（见 index.js 的 webControl.routes 循环）。
  const def = routes.get('/__webcode/status');
  assert.ok(def, '`/__webcode/status` 必须被挂到 webServer 上（路由清单从 webControl.routes 派生）');

  const server = http.createServer((req, res) => {
    if (new URL(req.url, 'http://loopback').pathname === '/__webcode/status') {
      return def.handler(req, res);
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn({
      port,
      get: async (qs = '') => {
        const r = await fetch(`http://127.0.0.1:${port}/__webcode/status${qs}`);
        return { status: r.status, json: await r.json() };
      },
    });
  } finally {
    // 收尾把监听句柄关干净：`closeAllConnections()` 断掉上面那次 `fetch` 留下的
    // keep-alive socket，`await` 保证关完再往下走。
    //
    // 实测读数（2026-09-17）：这样收尾后本文件**不加 `--test-force-exit` 也能自己退出**
    // （2/2 全绿、进程自然结束）。反过来，加了 `--test-force-exit` 时本文件会撞 libuv 的
    // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c line 94`
    // ——**两条断言都 ✔，文件级却是红**（3/3 复现）。排查结论：把收尾改成 await 仍然复现、
    // 让响应带 `connection: close` 仍然复现、`apply()+dispose()` 单独跑则完全干净
    // ⇒ 触发条件是**这个开关本身**在 Windows + Node 24 下的退出路径竞态，不是本文件（更不是插件）
    // 的缺陷。因此这类「真 HTTP + 真 apply()」的护栏请用 `node --test <file>` 跑。
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await dispose();
  }
}

/**
 * 是不是「接线错误」。
 *
 * ReferenceError（`X is not defined`）与 TypeError（`X is not a function`）
 * 都只可能来自**这个标识符本身没接上**，不可能是任何一种业务降级 ——
 * roster.js 的设计是「读不到就给空数组 + 原因」，它自己从不抛这两种错，
 * 它连 `projectRoster` 都包了 try/catch 返回 `*-projection-threw` 前缀。
 */
function isWiringError(text) {
  const s = String(text || '');
  return /\bis not defined\b/.test(s) || /\bis not a function\b/.test(s);
}

test('★ 接线：/status 的花名册不得报「未定义」——注入点必须真的接上 lib/roster.js', async () => {
  // 这一条就是抓 0.15.0 那个 bug 的判据：源码里那行调用存在、单测全绿，
  // 只有真的走一遍 HTTP 才会暴露 `projectRoster is not defined`。
  await withBridge({}, async ({ get }) => {
    const r = await get();
    assert.equal(r.status, 200, '状态端点必须可用');
    assert.equal(r.json.ok, true);

    for (const field of ['subAgents', 'team', 'subAgentsError', 'teamError']) {
      assert.ok(field in r.json, `status 必须含 ${field} 字段（面板按它区分「没有」与「读不到」）`);
    }
    assert.ok(Array.isArray(r.json.subAgents) && Array.isArray(r.json.team));

    // 空服务桩下**合法**的结果是一串「服务不可用」原因，而不是接线错误。
    assert.ok(
      !isWiringError(r.json.subAgentsError) && !isWiringError(r.json.teamError),
      '花名册报的必须是真实降级原因，不得是接线错误（ReferenceError/TypeError）：'
        + `subAgentsError=${r.json.subAgentsError} teamError=${r.json.teamError}`,
    );
    // `roster-not-wired` 是「rosterOf 压根没注入」的兜底，同样等于功能不存在。
    assert.notEqual(r.json.subAgentsError, 'roster-not-wired',
      'rosterOf 必须被注入（否则退回 0.14.9 的「恒空且不说原因」）');
    assert.notEqual(r.json.teamError, 'roster-not-wired', 'rosterOf 必须被注入');
  });
});

test('★ 接线：注入点接上完整服务桩时，/status 必须真的读出成员（证明上一条不是空转）', async () => {
  // 负向判据若只断言「不抛错」，可以靠「把 rosterOf 整个删掉」满足 ——
  // 那就等于退回写死空数组。这一条钉住正向：同一条路径必须能读出真实数据。
  const member = { id: 'session-lead-1', name: 'lead', role: 'lead', status: 'running' };
  const child = { id: 'session-child-1', label: 'reviewer', createdAt: 1_700_000_000_000, mode: 'one-shot' };
  const services = {
    agentTeams: { listMembers: () => [member], listTasks: () => [{ id: 't1', subject: '修 405', status: 'pending', ownerName: 'lead', blockedBy: [], writeScopes: ['lib/'], ready: true }] },
    // 0.15.4：权威凭据取法是 `agents.get(sessionId)`，不是遍历 `list()`。
    // 桩必须提供 get，否则这条护栏会因为「桩缺方法」而红——那是桩的失真，
    // 不是实现的缺陷（本文件顶部记的那一族教训）。
    agents: {
      get: (id) => (id === 'session-lead-1' ? { id: 'session-lead-1' } : undefined),
      list: () => [{ id: 'session-lead-1' }, { id: 'session-child-1' }],
    },
    sessions: { get: () => ({ id: 'session-lead-1' }) },
    sessionProjections: {
      snapshot: (_session, keys) => (keys.includes('subagentCatalog')
        ? { values: { subagentCatalog: [child] } }
        : { values: {} }),
    },
  };

  await withBridge(services, async ({ get }) => {
    const r = await get('?sessionId=session-lead-1');
    assert.equal(r.status, 200);
    assert.equal(r.json.teamError, null, '真实服务可用时不该报错：' + r.json.teamError);
    assert.equal(r.json.subAgentsError, null, '真实服务可用时不该报错：' + r.json.subAgentsError);
    assert.equal(r.json.tasksError, null, '真实服务可用时不该报错：' + r.json.tasksError);
    assert.deepEqual(r.json.team.map((m) => m.name), ['lead'], 'Team 成员必须从 agentTeams 服务读出来');
    assert.deepEqual(r.json.team.map((m) => m.role), ['lead']);
    // members 是 team 的同值别名（官方 TeamView 的词）。
    assert.deepEqual(r.json.members, r.json.team, 'members 必须与 team 同值');
    // 任务板是团队级事实，必须与成员一起到达。
    assert.deepEqual(r.json.tasks.map((t) => t.subject), ['修 405']);
    assert.deepEqual(r.json.tasks.map((t) => t.status), ['pending']);
    assert.deepEqual(r.json.subAgents.map((s) => s.name), ['reviewer'], '子代理必须从 subagentCatalog 投影读出来');
    // **目录路径不给运行时状态**：subagentCatalog 条目本身不含 activity，
    // 桥不替官方断言「运行中」（0.15.4 修）。权威状态在官方
    // `subagents.listChildren` 那条路上，本用例没装那个服务，所以这里就是「未知」。
    assert.ok(!('status' in r.json.subAgents[0]),
      '投影路径不得推断 status（旧实现用 agents.list() 猜 running，会把已结束的显示成运行中）');
  });
});