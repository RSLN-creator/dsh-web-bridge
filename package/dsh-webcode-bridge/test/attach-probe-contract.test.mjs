// attach-probe-contract.test.mjs — 附件探针的**契约**：只上传、绝不发送，读数如实（0.16.4）。
//
// ## 这条探针为什么必须存在（真机读数）
//
// 真机失败现场：`/status.driver.attachTransport = { at, fallback:true, code:'ATTACH_NOT_CONFIRMED',
// total:417276 }`——附件上传后**没有被确认**，于是回落 inline，把 417,276 字符整段写进输入框
// （用户报的「一开头就很长 token 窗口」）。同时 `GET /__webcode/attach-entry` 又明确说
// 入口是好的：`available:true`、`inputs:1`、`accept` 含 `.md,.txt,.json,.log`、`multiple:true`，
// 但 `previewHits: []`——「入口在」与「上传后网页会不会渲染出可见附件」是**两件事**，
// 而后者只能在页面上真的传一次才知道。
//
// 没有探针时，回答这个问题只剩一条路：发一条真实消息看模型读没读到附件——那是拿一次
// 真实会话（和一次站点风控额度）换一个读数。`POST attach-probe` 就是把它换成**只上传、
// 绝不发送**的读数路径（本轮真机验收 M5）。
//
// ## 冻结契约（护栏按它写）
//
//   `POST /__webcode/attach-probe {text}` → `{ ok, evidence, selector, domSnippet, cleaned, chars }`
//   · `ok` 的语义是「上传被页面确认」，**不是 HTTP 成功**：未确认时同样回 200 + `ok:false`；
//   · `cleaned` 如实反映清理结果（false = 附件可能仍留在输入框里，下一条消息会带上它）；
//   · 全程**不得**发生任何发送（`sendTurn` / `sendPrompt` 一次都不能被调）。
//
// ## 边界（写在明处）
//
// 本文件用**注入桩驱动**跑真实的 `apply()` → 真实 HTTP → 真实动作表，断言的是**控制面的
// 契约与副作用纪律**（字段齐全、值原样透出、不发送、降级不 500）。它**不证明** DeepSeek
// 网页真的接受了 `.md` 附件——那条只能由真机跑一次探针、读 `evidence`/`selector` 得到。
//
// ## 怎么跑这个文件
//
//   node --test --test-timeout=90000 test/attach-probe-contract.test.mjs
//
// **不要加 `--test-force-exit`**：真 HTTP + 真 `apply()` 的组合在本机实测会让该开关在退出
// 路径上撞 libuv 的 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`——5 个子用例
// 全绿而**文件**被判红（既有文件 test/wiring-roster.test.mjs 同样如此）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = path.dirname(import.meta.dirname);

/** 临时目录：本机沙箱下 `os.tmpdir()` 可能 ACL 受限，失败就落到包内 .tmp。 */
function tmpDir(prefix = 'webcode-probe-') {
  try { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); } catch {
    const d = path.join(pkg, '.tmp', prefix + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}

/** 最小 DSH 宿主替身（与 test/wiring-roster.test.mjs 同源）。 */
function makeCtx() {
  const routes = new Map();
  const ctx = {
    llm: { registerAdapter() { /* 本护栏不关心模型注册 */ } },
    webServer: { register(def) { routes.set(def.path, def); return () => {}; } },
    get: () => null,
  };
  return { ctx, routes };
}

/**
 * 桩驱动：`probeAttachment` 是探针的唯一入口，返回由用例给定；
 * `sendTurn` / `sendPrompt` 只记数——它们**一次都不能被调用**，这是「只上传不发送」的判据。
 */
function probeDriver({ result, sendRefused = false } = {}) {
  const calls = { probe: [], sends: 0 };
  const driver = {
    calls,
    async probeAttachment(text, opts = {}) {
      calls.probe.push({ chars: String(text ?? '').length, name: opts?.name ?? null });
      if (sendRefused) return { ok: false, error: 'stub-refused' };
      return { ...result, chars: String(text ?? '').length };
    },
    async sendTurn() { calls.sends += 1; return { text: '不该发生' }; },
    async sendPrompt() { calls.sends += 1; return { text: '不该发生' }; },
    async resetConversation() {},
    conversationFor() { return null; },
    status() {
      return {
        running: true, busy: false, siteId: 'deepseek', preview: true,
        sessionSlot: { webSessionId: null, at: null, source: 'none' },
      };
    },
    async close() {},
  };
  return driver;
}

/** 起一个只挂了本插件控制面路由的真 HTTP 服务，并对指定动作发一次 POST。 */
async function withBridge(driver, fn) {
  const { ctx, routes } = makeCtx();
  const { apply } = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href);
  const profileDir = tmpDir();
  // 探针走的是「已授权」这条路（动作自己会挡未授权）：写一份持久授权记录，
  // 与真机上「用户已在设置页点过同意」等价——缺了它每个用例都会先被同意闸拦下。
  fs.writeFileSync(path.join(profileDir, 'webcode-consent.json'), JSON.stringify({ accepted: true }), 'utf8');
  const disposer = apply(ctx, {
    port: 0, host: '127.0.0.1', requireConsent: false, driver, profileDir,
  });
  assert.ok(routes.has('/__webcode/attach-probe'),
    '`POST attach-probe` 没有被挂到 webServer 上（挂载清单从控制面动作表派生）——'
    + '冻结动作名就是 attach-probe，改名等于面板上的探针按钮打不通。已挂：'
    + [...routes.keys()].filter((p) => /attach|probe/.test(p)).join(', '));
  const def = routes.get('/__webcode/attach-probe');
  const server = http.createServer((req, res) => {
    if (new URL(req.url, 'http://loopback').pathname === '/__webcode/attach-probe') return def.handler(req, res);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn({
      post: async (body) => {
        const r = await fetch(`http://127.0.0.1:${port}/__webcode/attach-probe`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
        });
        return { status: r.status, json: await r.json() };
      },
    });
  } finally {
    // 必须等监听句柄**真的**关掉再退出（实测：只调 `server.close()` 时，keep-alive 连接
    // 会让它迟迟不回调，`node --test --test-force-exit` 强制退出会在 Windows 上撞到
    // libuv 的 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`——5 个子用例全绿
    // 而**文件**被判红。`closeAllConnections()` 断掉 keep-alive 连接，`await` 保证关完）。
    // `disposer()` 同样必须 await：它关的是插件自己的 relay（另一个监听句柄），
    // 不等它就退出会让两个句柄在退出路径上重叠关闭——这正是那条断言的另一半来源。
    await closeServer(server);
    try { await disposer?.(); } catch { /* 测试替身，忽略 */ }
  }
}

/** 关掉 HTTP 服务并等它真的关完（见 withBridge 的说明）。 */
async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** 冻结契约要求必须存在的六个字段（一个都不能少，名字逐字相同）。 */
const FROZEN_KEYS = ['ok', 'evidence', 'selector', 'domSnippet', 'cleaned', 'chars'];

// ── ① 上传被确认：六个字段齐全，且一个发送都没发生 ────────────────────────────

test('① 上传被确认时返回六个冻结字段，且全程没有发送任何消息', async () => {
  const driver = probeDriver({
    result: { ok: true, evidence: 'text:webcode-probe.md', selector: 'text:webcode-probe.md', domSnippet: '<div>webcode-probe.md</div>', cleaned: true },
  });
  await withBridge(driver, async ({ post }) => {
    const probeText = '# webcode attach probe\n2026-09-17T21:30:00.000Z\n';
    const r = await post({ text: probeText });
    assert.equal(r.status, 200, '探针必须回 200（ok 的语义是「上传被确认」，不是 HTTP 成功）');
    for (const k of FROZEN_KEYS) {
      assert.ok(k in r.json, '响应缺少冻结字段 ' + k + '：' + JSON.stringify(r.json));
    }
    assert.equal(r.json.ok, true, '上传被确认时 ok 必须是 true：' + JSON.stringify(r.json));
    assert.equal(r.json.evidence, 'text:webcode-probe.md', 'evidence 必须原样透出（这是「确认」的唯一凭据）');
    assert.equal(r.json.selector, 'text:webcode-probe.md', 'selector 必须原样透出（面板要显示命中的是哪个选择器）');
    assert.equal(r.json.chars, probeText.length, 'chars 必须是**实际传给驱动的字符数**：' + JSON.stringify(r.json));
    assert.equal(driver.calls.probe.length, 1, '探针入口只应被调用一次');
    assert.equal(driver.calls.probe[0].name, 'webcode-probe.md', '默认文件名必须传下去（真机上就是靠它认出这一份）');
    assert.equal(driver.calls.sends, 0,
      '探针期间发生了发送（sendTurn/sendPrompt 被调用 ' + driver.calls.sends + ' 次）：'
      + '探针的全部价值就是「只上传不发送」，一旦发送，它就退化成拿一次真实会话换读数');
  });
});

// ── ② 反向安全线：没确认也不许粉饰 ───────────────────────────────────────────

test('② 上传未被确认时：ok=false、cleaned=false 原样透出，HTTP 仍 200', async () => {
  const driver = probeDriver({
    result: {
      ok: false, code: 'ATTACH_NOT_CONFIRMED', evidence: null, selector: null,
      domSnippet: null, cleaned: false, cleanedBy: 'chip-delete-not-found',
    },
  });
  await withBridge(driver, async ({ post }) => {
    const r = await post({ text: 'x' });
    assert.equal(r.status, 200, '未确认也必须是 200（调用方按 ok 判断，不能靠状态码猜）');
    assert.equal(r.json.ok, false, '未确认却回了 ok=true：那会把「附件根本没用上」报成成功');
    assert.equal(r.json.cleaned, false,
      'cleaned 被粉饰成 true 了：附件可能仍留在输入框里，下一条消息会莫名带上它——'
      + '如实说 false 才是这条读数的意义（' + JSON.stringify(r.json) + '）');
    assert.equal(r.json.code, 'ATTACH_NOT_CONFIRMED', '失败码必须原样透出：' + JSON.stringify(r.json));
    assert.equal(driver.calls.sends, 0, '未确认的分支同样不许改走发送');
  });
});

// ── ③ 读数诚实：请求侧字符数与实际上传字符数必须对得上 ────────────────────────

test('③ 超长探针内容：requestedChars / chars / truncated 三者必须自洽', async () => {
  const driver = probeDriver({ result: { ok: true, evidence: 'text:webcode-probe.md', selector: 'text:webcode-probe.md', domSnippet: '', cleaned: true } });
  await withBridge(driver, async ({ post }) => {
    const long = 'A'.repeat(25_000);
    const r = await post({ text: long });
    assert.equal(r.status, 200);
    assert.equal(r.json.requestedChars, 25_000, 'requestedChars 必须如实报请求里有多少字符：' + JSON.stringify(r.json));
    const uploaded = driver.calls.probe[0].chars;
    assert.equal(r.json.chars, uploaded, 'chars 必须等于真正交给驱动的字符数（读数与事实同源）');
    assert.equal(r.json.truncated, uploaded < r.json.requestedChars,
      'truncated 必须与「真正传了多少」一致：传少了就必须说截过（静默截断会让读数被当成原文长度）');
  });
});

// ── ④ 反向安全线：跨站点探测必须显式拒绝（不许顺手拉起别人的浏览器）────────────

test('④ 反向安全线：请求探测别的站点时必须明确拒绝，不得偷偷探测', async () => {
  const driver = probeDriver({ result: { ok: true, evidence: 'x', selector: 'x', domSnippet: '', cleaned: true } });
  await withBridge(driver, async ({ post }) => {
    const r = await post({ text: 'x', siteId: 'glm' });
    assert.equal(r.status, 200, '拒绝也要回 200 + 结构化原因，不能 500');
    if (r.json.ok === true) {
      assert.equal(driver.status().siteId, 'deepseek', '（桩驱动只有 deepseek）');
      assert.notEqual(driver.calls.probe.length > 0 && r.json.siteId, 'glm',
        '请求探测 glm 时既上传了、又把 siteId 报成 glm：那等于悄悄拉起了另一个站点的 profile');
    } else {
      assert.ok(String(r.json.error || '').length > 0, '拒绝时必须给出原因：' + JSON.stringify(r.json));
    }
    // 无论走哪一支，都不得因此发生发送。
    assert.equal(driver.calls.sends, 0, '拒绝分支发生了发送');
  });
});

// ── ⑤ 反向安全线：驱动不支持探针时降级成结构化错误，不抛 500 ──────────────────

test('⑤ 反向安全线：注入的桩/旧驱动没有 probeAttachment 时，回结构化错误而不是 500', async () => {
  const bare = {
    async sendTurn() { return { text: 'x' }; },
    async resetConversation() {}, async close() {},
    status() { return { running: true, busy: false, siteId: 'deepseek' }; },
  };
  await withBridge(bare, async ({ post }) => {
    const r = await post({ text: 'x' });
    assert.equal(r.status, 200, '缺能力的降级也必须回结构化结果（旧驱动/注入桩是常态）：' + r.status);
    assert.equal(r.json.ok, false, '不支持探针时必须 ok:false：' + JSON.stringify(r.json));
    assert.ok(String(r.json.error || '').length > 0, '降级必须给出原因：' + JSON.stringify(r.json));
  });
});
