// capture-connect.test.mjs — 注入脚本 connect 分支的**真实执行**护栏（2026-09-21）。
//
// ## 为什么需要它（在写它之前，这条通路一格自动化证据都没有）
//
// 0.16.40 给 kimi 加的 Connect-RPC 支持有三层：`providers.js` 声明 `streamTransport:'connect'`、
// `browser-driver.js` 的 `captureInit` 里按 `[flags(1)][len(4BE)][json]` 切帧、`decoder.js`
// 的 `kimi-connect` 解码。**第三层有测试（multi-site-decoder 的 3 条），前两层没有**：
// `captureInit` 是模块私有函数，而它的产物是**一段注入到页面的字符串**——正则读源码只能证明
// 「字符串里有某几个字」，证明不了「切帧真的切对了」。而真机上这条链一旦错，症状是
// 「页面有回复、harness 收到零事件、最后 240s 超时」，正是最难归因的一类。
//
// 因此这里做两件事：
//   ① 源码契约：站点声明 → 调用点 → 脚本里的 CONNECT 常量，三段接线必须都在；
//   ② **把 captureInit 的真身抽出来，在 vm 沙箱里当脚本跑**，用假 fetch + 假 Response
//      喂真实字节，断言 emit 出来的每一条 chunk 都是**可 JSON.parse 的整帧**。
//
// 抽函数用大括号配平扫描（与 upload-attachment-structure.test.mjs 同一套做法）：
// 不复制协议文本、不新增导出面，被测的就是磁盘上那一份。
//
// ## 它当天就抓到一个真缺陷（留在这里，别把本文件当形式）
//
// 第一版写出来、**还没提交**就红了三条：切帧器用逐字节 `String.fromCharCode` 拼 JSON 串，
// 中文正文被解成 mojibake（`你好` → `ä½ å¥½`）。而 JSON.parse 对 mojibake 是**合法**的，
// 所以整条链不抛错、不留痕，只有用户看到乱码。已改为 `TextDecoder('utf-8')` 解码。
// 这就是「注入脚本的真实执行」比「正则读源码」值钱的地方——后者只会证明字符串里
// 有 `JSON.parse` 这四个字。
//
// ## 已知边界（本文件不修，只钉住事实）
//
// XHR 分支**不认 connect**：它靠 `responseText` 增量 drain，而 responseText 已被浏览器按
// 文本解码，二进制帧头在那里已经损坏。connect 站点若走 XHR 而非 fetch，本层无法救。
// 钉在第 ⑥ 条，并登记在 doc/long-term-issues.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const pkg = path.resolve(import.meta.dirname, '..');
const DRIVER = path.join(pkg, 'lib', 'browser-driver.js');
const PROVIDERS = path.join(pkg, 'lib', 'providers.js');
const src = fs.readFileSync(DRIVER, 'utf8');

/**
 * 抽出 `captureInit` 的真身（含函数体，逐字来自磁盘）。
 *
 * **不能用大括号配平扫描**（第一版本就是这么写的，当场红）：函数体返回的是一个
 * **模板字符串**，里面全是页面侧代码的 `{` / `}` 与 `${...}` 占位符，按括号数会把
 * 函数截在半路（`new Function` 报 `Unexpected token '}'`）。这里的判据改成
 * 「从签名到下一行行首的 `}`」——捕获脚本本身以 `})();` 结尾，随后是反引号加分号，
 * 函数收尾的 `}` 独占一行，这个形状在源码里是稳定的。
 */
function loadCaptureInit() {
  const anchor = 'function captureInit(paths, opts = {}) {';
  const start = src.indexOf(anchor);
  assert.ok(start >= 0, '在 lib/browser-driver.js 里找不到 captureInit 的签名锚点：结构被改坏了');
  // 收尾行 = 独占一行的 `}`。**必须容忍 CRLF**：本仓库工作树是 LF，但同一份文件在
  // 别的检出/工具链下可能是 CRLF（第一版写死 '\n}\n' 就因此红过）。
  const m = /\r?\n\}\r?\n/.exec(src.slice(start));
  assert.ok(m, '找不到 captureInit 的收尾行（独占一行的 `}`）：结构被改坏了');
  const braceAt = start + m.index + (m[0].startsWith('\r\n') ? 2 : 1);
  const block = src.slice(start, braceAt + 1);
  assert.ok(/return `/.test(block), 'captureInit 的形态变了：本文件的前提（返回注入脚本文本）失效');
  // eslint-disable-next-line no-new-func -- 被测对象就是这段字符串函数，见文件头注释
  return new Function('return (' + block + ')')();
}

/** 造一个 Connect-RPC 帧：`[flags(1)][len(4BE)][json]`。 */
function connectFrame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(5);
  head[0] = 0;
  head.writeUInt32BE(json.length, 1);
  return Buffer.concat([head, json]);
}

/**
 * 在 vm 沙箱里跑注入脚本，并用假 fetch 驱动一次捕获。
 *
 * @param {string} script captureInit(...) 的产物
 * @param {object} opts
 * @param {string} [opts.url] 触发捕获的 URL
 * @param {Array<Uint8Array>} [opts.chunks] 从响应体分块喂进去的字节/文本
 * @returns {Promise<{calls:Array, fetchCalled:number}>}
 */
async function driveCapture(script, { url = 'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat', chunks = [] } = {}) {
  const calls = [];
  let fetchCalled = 0;
  const sandbox = {
    console, JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, Error,
    Uint8Array, TextDecoder, Response,
    setTimeout, clearTimeout,
    // 脚本收尾装了 500ms 自愈守护；沙箱里换成空实现，否则用例跑完进程不退出。
    setInterval: () => 0,
    clearInterval: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__webcodeChunk = (id, phase, text) => calls.push({ id, phase, text });
  // 页面那一半流：本用例只关心捕获那一半，这里给一条立刻关闭的真 ReadableStream。
  const pageStream = new ReadableStream({ start(c) { c.close(); } });
  let push;
  const captureStream = new ReadableStream({ start(c) { push = c; } });
  sandbox.fetch = async () => {
    fetchCalled++;
    return {
      ok: true, status: 200, statusText: 'OK', headers: {},
      body: { tee: () => [pageStream, captureStream] },
    };
  };
  class FakeXHR { open() {} send() {} addEventListener() {} }
  sandbox.XMLHttpRequest = FakeXHR;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  await sandbox.fetch(url, { method: 'POST' });
  for (const c of chunks) push.enqueue(c instanceof Uint8Array ? c : new Uint8Array(Buffer.from(c)));
  push.close();
  // 等 emit('end')：驱动循环在微任务里跑，轮询到期限为止（不用固定 sleep，避免偶发红）。
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !calls.some((c) => c.phase === 'end')) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return { calls, fetchCalled };
}

const CHUNKS = (calls) => calls.filter((c) => c.phase === 'chunk').map((c) => c.text);

// ---------- ① 源码契约：站点声明 → 调用点 → 脚本常量 ----------

test('接线：kimi 声明 connect，调用点把它传进 captureInit，脚本里落到 CONNECT 常量', () => {
  const prov = fs.readFileSync(PROVIDERS, 'utf8');
  assert.match(prov, /streamTransport:\s*'connect'/, 'providers.js 里 kimi 不再声明 streamTransport');
  assert.match(src, /captureInit\(paths,\s*\{\s*transport:\s*site\.streamTransport\s*\|\|\s*null\s*\}\)/,
    'captureInit 的调用点没把站点 transport 传下去：声明与实现之间会静默断开');
  assert.match(src, /const CONNECT = \$\{connect\};/, '脚本里没有 CONNECT 常量占位符');
  assert.match(src, /const connect = opts\.transport === 'connect';/, 'connect 判定被改坏');
});

// ---------- ② 行为：真跑注入脚本，二进制帧必须被切成整帧 JSON ----------

test('connect：一次喂完整两帧 → emit 出两条可 JSON.parse 的整帧（含中文正文）', async () => {
  const captureInit = loadCaptureInit();
  // 夹具刻意用中文：逐字节 String.fromCharCode 的旧写法在这里会变成 mojibake，
  // 而 JSON.parse 不会报错——本用例是那条缺陷的唯一防线。
  const f1 = { op: 'set', mask: 'block.text', block: { text: { content: '你好' } } };
  const f2 = { done: {}, eventOffset: 1 };
  const script = captureInit(['/apiv2/kimi.gateway.chat.v1.ChatService/Chat'], { transport: 'connect' });
  const { calls, fetchCalled } = await driveCapture(script, {
    chunks: [new Uint8Array(connectFrame(f1)), new Uint8Array(connectFrame(f2))],
  });
  assert.equal(fetchCalled, 1, '假 fetch 没被调用：说明包装没生效');
  const texts = CHUNKS(calls);
  assert.equal(texts.length, 2, '两帧必须 emit 两条；多一条少一条都是切帧错');
  assert.deepEqual(JSON.parse(texts[0]), f1);
  assert.deepEqual(JSON.parse(texts[1]), f2);
  assert.ok(texts.every((t) => t.endsWith('\n')), '每帧必须以换行结尾，下游是行式解码器');
  assert.equal(calls.at(-1).phase, 'end');
});

test('connect：帧被切在两个网络分块之间 → 仍然只 emit 一条整帧（不吐半截）', async () => {
  const captureInit = loadCaptureInit();
  const f = { op: 'set', mask: 'block.think.content', block: { think: { content: '思考' } } };
  const bytes = new Uint8Array(connectFrame(f));
  const cut = 3;   // 切在长度头中间：最坏情况
  const script = captureInit(['/apiv2/kimi.gateway.chat.v1.ChatService/Chat'], { transport: 'connect' });
  const { calls } = await driveCapture(script, { chunks: [bytes.slice(0, cut), bytes.slice(cut)] });
  const texts = CHUNKS(calls);
  assert.equal(texts.length, 1, '半个帧不许被当成一帧吐出去');
  assert.deepEqual(JSON.parse(texts[0]), f);
});

test('connect：前置脏字节 → 跳过并重新对齐，后面的合法帧照样取出（不许死循环）', async () => {
  const captureInit = loadCaptureInit();
  const f = { op: 'append', mask: 'block.text', block: { text: { content: '正文' } } };
  // 5 字节垃圾头：声称长度 0x7fffffff（远超 64MB 上限）→ 必须走 off++ 重同步。
  const junk = Buffer.from([0x01, 0x7f, 0xff, 0xff, 0xff, 0x02]);
  const bytes = new Uint8Array(Buffer.concat([junk, connectFrame(f)]));
  const script = captureInit(['/apiv2/kimi.gateway.chat.v1.ChatService/Chat'], { transport: 'connect' });
  const { calls } = await driveCapture(script, { chunks: [bytes] });
  const texts = CHUNKS(calls);
  assert.equal(texts.length, 1, '脏字节之后应恰好恢复出一帧');
  assert.deepEqual(JSON.parse(texts[0]), f);
});

// ---------- ③ 回归：文本模式（非 connect 站点）逐字不变 ----------

test('文本模式：不经切帧，chunk 就是原文（既有站点行为不许被 connect 分支带偏）', async () => {
  const captureInit = loadCaptureInit();
  const script = captureInit(['/api/v0/chat/completion'], {});
  assert.match(script, /const CONNECT = false;/, '没传 transport 时必须落在文本模式');
  const { calls } = await driveCapture(script, {
    url: 'https://chat.deepseek.com/api/v0/chat/completion',
    chunks: ['data: {"a":1}\n\n'],
  });
  assert.deepEqual(CHUNKS(calls), ['data: {"a":1}\n\n'], '文本模式必须逐字外发，不许被 JSON 化');
});

test('不命中目标路径的请求：包装放行，一个字节都不 emit', async () => {
  const captureInit = loadCaptureInit();
  const script = captureInit(['/apiv2/kimi.gateway.chat.v1.ChatService/Chat'], { transport: 'connect' });
  const { calls, fetchCalled } = await driveCapture(script, {
    url: 'https://www.kimi.com/api/other/thing', chunks: [new Uint8Array(connectFrame({ x: 1 }))],
  });
  assert.equal(fetchCalled, 1);
  assert.deepEqual(calls, [], '不命中还捕获，等于把无关流量灌进解码器');
});

// ---------- ④ 钉住已知边界（不修，只留证据）----------

test('已知边界：XHR 分支不认 connect（responseText 已按文本解码，帧头必损坏）', () => {
  const captureInit = loadCaptureInit();
  const script = captureInit(['/apiv2/kimi.gateway.chat.v1.ChatService/Chat'], { transport: 'connect' });
  const xhrStart = script.indexOf('XMLHttpRequest.prototype.send');
  assert.ok(xhrStart > 0, 'XHR 分支的锚点不在了，本判据的前提失效');
  const xhrBody = script.slice(xhrStart);
  assert.ok(!/CONNECT/.test(xhrBody), 'XHR 分支里出现了 CONNECT——若真接上了，请连同真机证据一起改掉本用例');
  assert.ok(/responseText/.test(xhrBody), 'XHR 分支仍应是 responseText drain（connect 站点走 XHR 时本条救不了）');
});
