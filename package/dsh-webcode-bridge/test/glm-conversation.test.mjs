// glm-conversation.test.mjs — 会话身份与三态导航契约（0.14.1，C-1/C-2/C-3）。
//
// 用户症状：「GLM 作为子代理时**同一会话却每轮新开对话**」。
//
// 真机取证（2026-09-14，探针 real-probe-23-glm-budget.mjs）：
//   1. 发一轮后 page.url() =
//      https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=6aa6f08454b3a5a4e4f64a77
//   2. 同一轮的 SSE 首帧里 conversation_id = 6aa6f08454b3a5a4e4f64a77
//      ——**与 URL 的 cid 逐字相同**，身份一直在，只是没人读。
//   3. result.sessionId === null → rememberConversation 从不执行 →
//      webcode-sessions-glm.json 恒为 "{}"（2 字节；deepseek 那份 6058 字节）
//      → 下一轮 conversationFor 为空 → WEB_SESSION_LOST → 上层 fresh 重开。
//
// 根因是驱动的会话地址知识**硬编码成 DeepSeek 的两种形状**。本文件钉住收口后的
// 契约：形状按站点声明（providers.js）、导航判定成三态（contract.conversationNav）、
// 且「不支持」必须报错而**不是**静默开新会话。
//
// 同时钉住 C-1 的第二个来源：解码器要从流里透出 conversation_id（z.ai 这类地址
// 形状尚未取证到的站点，流里的 id 是唯一身份来源）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../lib/decoder.js';
import {
  conversationIdFromUrl, conversationUrlFor, NAVIGATION_STATES,
} from '../lib/providers.js';
import { conversationNav } from '../lib/contract.js';

const D = globalThis.WebCodeStreamDecoders;
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const readLib = (f) => fs.readFileSync(path.join(pkgRoot, 'lib', f), 'utf8');

// 真机实录的那一对（URL 的 cid === SSE 的 conversation_id）
const GLM_URL = 'https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=6aa6f08454b3a5a4e4f64a77';
const GLM_CID = '6aa6f08454b3a5a4e4f64a77';

// ---------- C-1：解码器透出 conversation_id ----------

test('glm 解码器：从真机帧里取出 conversation_id（C-1）', () => {
  const decoder = new D.glm({ onDelta: () => {} });
  // 首帧逐字来自真机抓包（.tmp/sse-glm-probe/sse-glm-*.log），仅截断到关键字段
  decoder.push('data: ' + JSON.stringify({
    id: '6aa6f08454b3a5a4e4f64a78',
    conversation_id: GLM_CID,
    assistant_id: '65940acff94777010aa6b796',
    parts: [],
    status: 'init',
  }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({
    conversation_id: GLM_CID, status: 'processing',
    parts: [{ status: 'processing', content: [{ type: 'text', text: '收到' }] }],
  }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ conversation_id: GLM_CID, status: 'finish', parts: [] }) + '\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.equal(out.conversationId, GLM_CID, 'finish() 必须带回 conversation_id');
  assert.equal(decoder.conversationId, GLM_CID, '解码器实例上也应可读（驱动在 finishActive 前取）');
});

test('glm 解码器：帧里没有 conversation_id 时不伪造（保持 null）', () => {
  const decoder = new D.glm({ onDelta: () => {} });
  decoder.push('data: ' + JSON.stringify({
    status: 'finish', parts: [{ content: [{ type: 'text', text: 'hi' }] }],
  }) + '\n\n');
  const out = decoder.finish();
  assert.equal(out.conversationId, null, '拿不到就如实 null，不编一个 id 出来');
});

test('C-1：真机证据里 URL 的 cid 与流里的 conversation_id 是同一个串', () => {
  // 这条断言是「两个来源可以互相兜底」的基础：如果它们不是同一个命名空间，
  // 就不能拿地址的 id 去 rememberConversation，也不能拿流的 id 去拼地址。
  assert.equal(conversationIdFromUrl('glm', GLM_URL), GLM_CID);
});

// ---------- C-2：三态导航契约 ----------

test('三态常量固定为 fresh / resume / unsupported（没有第四态）', () => {
  assert.deepEqual([...NAVIGATION_STATES], ['fresh', 'resume', 'unsupported']);
});

test('deepseek：两种历史地址形状都还认（不能因为重构而回归）', () => {
  assert.equal(conversationIdFromUrl('deepseek', 'https://chat.deepseek.com/a/chat/s/abc12345-6789'), 'abc12345-6789');
  assert.equal(conversationIdFromUrl('deepseek', 'https://chat.deepseek.com/?chat_session_id=xyz-987654'), 'xyz-987654');
  assert.equal(conversationUrlFor('deepseek', 'https://chat.deepseek.com', 'abc12345-6789'),
    'https://chat.deepseek.com/a/chat/s/abc12345-6789');
});

test('glm：从 ?cid= 解析、并能拼回可导航的地址', () => {
  assert.equal(conversationIdFromUrl('glm', GLM_URL), GLM_CID);
  const built = conversationUrlFor('glm', 'https://chatglm.cn', GLM_CID);
  assert.equal(built, 'https://chatglm.cn/main/alltoolsdetail?cid=' + GLM_CID);
  // 拼出来的地址必须能被解析回来（往返一致），否则导航过去会开成新会话
  assert.equal(conversationIdFromUrl('glm', built), GLM_CID);
});

test('glm：无 cid 的落地页不能被当成「会话地址」', () => {
  // 游客落地页也是 /main/alltoolsdetail，只是没有 cid。若把它当会话地址，
  // 导航过去等于开新会话，而驱动会以为自己在续聊。
  assert.equal(conversationIdFromUrl('glm', 'https://chatglm.cn/main/alltoolsdetail?lang=zh'), null);
});

test('zai：未取证到地址形状 → 如实返回 null，不照抄 GLM 的形状', () => {
  // 探针 real-probe-25-zai-url.mjs 在 chat.z.ai 上只拿到裸根地址（query 键为空、
  // 页面无会话链接），real-probe-23 在 zai 上整轮 120s 超时。**没有证据就不声明**：
  // 编一个形状会导航到不存在的地址，比「不支持」更糟。
  assert.equal(conversationIdFromUrl('zai', 'https://chat.z.ai/'), null);
  assert.equal(conversationUrlFor('zai', 'https://chat.z.ai', 'some-id'), null);
});

test('未知站点 / 垃圾地址一律 null，不得抛错', () => {
  assert.equal(conversationIdFromUrl('nope', 'https://x.example/?cid=1'), null);
  assert.equal(conversationIdFromUrl('glm', 'not a url'), null);
  assert.equal(conversationIdFromUrl('glm', ''), null);
  assert.equal(conversationUrlFor('glm', 'https://chatglm.cn', null), null);
});

// kimi：真机两轮实录（2026-09-27）拿到了**可导航**的形状，因此这次声明它。
//
// 补这一条之前 kimi 的读数是 `WEB_SESSION_LOST: 会话槽为空（site=kimi，
// no-stored-session） — 需要整段重建`——即每轮都整段重建、用户看到「每轮新开对话」。
// 与 zai 的取舍差别只有一条：**按形状导航回去之后，地址与页面内容是否还是那个会话**。
test('kimi：/chat/<uuid> 可解析且可导航回去（真机读数，不是照抄别的站点）', () => {
  const URL1 = 'https://www.kimi.com/chat/1a0e26b2-8e72-8a5a-8000-09c279d31e8d?chat_enter_method=home';
  const ID = '1a0e26b2-8e72-8a5a-8000-09c279d31e8d';
  assert.equal(conversationIdFromUrl('kimi', URL1), ID, '真机地址必须能解析出会话 id');
  // 构造器与解析器必须互为逆运算（否则「存进去的 id 导航不回去」）。
  const built = conversationUrlFor('kimi', 'https://www.kimi.com', ID);
  assert.equal(built, 'https://www.kimi.com/chat/' + ID);
  assert.equal(conversationIdFromUrl('kimi', built), ID);
  // 反例：落地页与其它路径都不带会话 id，不得被误判成会话地址
  // （误判的后果是导航到不存在的地址，比「不支持」更糟）。
  assert.equal(conversationIdFromUrl('kimi', 'https://www.kimi.com/'), null);
  assert.equal(conversationIdFromUrl('kimi', 'https://www.kimi.com/chat'), null);
  assert.equal(conversationIdFromUrl('kimi', 'https://www.kimi.com/other/1a0e26b2-8e72-8a5a-8000-09c279d31e8d'), null);
  // 太短的串不是 uuid（防止把 `/chat/new` 之类当 id）。
  assert.equal(conversationIdFromUrl('kimi', 'https://www.kimi.com/chat/abc'), null);
});

test('conversationNav：fresh 请求 → fresh 态（即使槽里有会话）', () => {
  const nav = conversationNav({ siteId: 'glm', origin: 'https://chatglm.cn', fresh: true, sessionId: GLM_CID });
  assert.equal(nav.state, 'fresh');
  assert.equal(nav.url, null);
});

test('conversationNav：glm 有槽 → resume 态且给出地址', () => {
  const nav = conversationNav({ siteId: 'glm', origin: 'https://chatglm.cn', fresh: false, sessionId: GLM_CID });
  assert.equal(nav.state, 'resume');
  assert.equal(nav.url, 'https://chatglm.cn/main/alltoolsdetail?cid=' + GLM_CID);
});

test('conversationNav：槽为空 → unsupported（绝不能默默开新会话）', () => {
  const nav = conversationNav({ siteId: 'glm', origin: 'https://chatglm.cn', fresh: false, sessionId: null });
  assert.equal(nav.state, 'unsupported');
  assert.equal(nav.reason, 'no-stored-session');
});

test('conversationNav：站点没有地址形状 → unsupported 且原因可分辨', () => {
  const nav = conversationNav({ siteId: 'zai', origin: 'https://chat.z.ai', fresh: false, sessionId: 'some-id' });
  assert.equal(nav.state, 'unsupported');
  assert.equal(nav.reason, 'site-has-no-conversation-url-shape');
});

// ---------- C-3：WEB_SESSION_LOST 不再静默 ----------

test('接线：sendTurn 走 conversationNav 三态，且 unsupported 必须抛码', () => {
  const src = readLib('browser-driver.js');
  assert.ok(/conversationNav\(/.test(src), 'sendTurn 必须走三态判定');
  // 0.19.52：`let nav`（stay 分支会在 unsupported 之后改判为 resume——落地地址锚）。
  // 判据按「const 或 let」匹配，钉的是「三态判定的存在」而不是声明关键字。
  const at = src.search(/(?:const|let) nav = conversationNav\(/);
  assert.ok(at > 0, '应有 nav 判定');
  // 0.19.52 二改：stay 分支插在 nav 判定与 unsupported 处理之间（约 40 行），固定
  // 窗口会漏——改锚「unsupported 块本身」，抛码就在它里面。
  const unsupportedAt = src.indexOf("if (nav.state === 'unsupported')");
  assert.ok(unsupportedAt > 0, 'unsupported 必须被显式处理');
  const unsupportedBody = src.slice(unsupportedAt, unsupportedAt + 1200);
  // 0.19.54：码改走 `withWebcodeCode`（唯一真源，同时挂 `failure` 快照）。
  // 裸赋值不带快照 ⇒ 码在 harness 边界变成 `UNKNOWN`，而 `WEB_SESSION_LOST`
  // 正是上层「作废游标 + 整段重建」的判据（lib/index.js 的 CURSOR_INVALIDATING_CODES）。
  assert.ok(/withWebcodeCode\(err,\s*'WEB_SESSION_LOST'\)/.test(unsupportedBody),
    'unsupported 必须经错误码真源抛 WEB_SESSION_LOST');
  assert.ok(!/err\.code\s*=\s*'WEB_SESSION_LOST'/.test(unsupportedBody),
    '不得回退成裸赋值（码会被 harness 归一化成 UNKNOWN）');
  // 关键：不得再有「默默开新会话」的老路径
  assert.ok(!/navigate = root\.origin \+ '\/a\/chat\/s\/'/.test(src),
    'DeepSeek 专用地址拼接不得残留在驱动里（已收口到 providers）');
});

test('接线：会话丢失计数与现场进入 status()（原先完全静默）', () => {
  const src = readLib('browser-driver.js');
  assert.ok(/let sessionLostCount = 0;/.test(src), '应有丢失计数');
  assert.ok(/let lastSessionLost = null;/.test(src), '应有最近一次现场');
  // status() 的返回对象里必须带上这两个字段（供 /__webcode/status 与右栏读取）。
  //
  // ⚠ 这里按**函数边界**取体，而不是旧的 `stAt + 4000` 定长窗口：
  // 0.19.75 在 status() 里新增了 `loginState` / `loginVerified` 两段带原因的注释，
  // 把 `sessionLostCount` 推到了偏移 5802 处 —— 定长窗口于是**假红**
  // （字段就在函数里、只是不在窗口内）。定长窗口测的是「字段离函数头多近」，
  // 那从来不是我们要的判据。
  const stAt = src.indexOf('function status() {');
  assert.ok(stAt > 0, '应有 status()');
  // 函数体：从 status() 起，到下一个顶层 `  function ` 或 `  async function ` 为止。
  const rest = src.slice(stAt + 'function status() {'.length);
  const nextFn = rest.search(/\n {2}(?:async )?function /);
  const stBody = nextFn >= 0 ? rest.slice(0, nextFn) : rest.slice(0, 8000);
  assert.ok(stBody.length > 500, 'status() 函数体取体失败（长度可疑：' + stBody.length + '）');
  assert.ok(/^\s*sessionLostCount,\s*$/m.test(stBody), 'status() 必须透出 sessionLostCount');
  assert.ok(/^\s*lastSessionLost,\s*$/m.test(stBody), 'status() 必须透出 lastSessionLost');
});

test('接线：驱动身份取「地址优先、流兜底」两个来源', () => {
  const src = readLib('browser-driver.js');
  assert.ok(/function turnSessionId\(/.test(src), '应有双来源的身份取值函数');
  const at = src.indexOf('function turnSessionId(');
  const body = src.slice(at, at + 700);
  assert.ok(/conversationIdFromUrl\(siteId, url\)/.test(body), '地址是第一来源');
  assert.ok(/decoderConversationId/.test(body), '流是兜底来源（z.ai 这类地址无形状的站点靠它）');
  assert.ok(/lastTurn = \{ sessionId: turnSessionId\(/.test(src), 'lastTurn 必须用双来源');
});

test('接线：控制面兜底分支也透出会话丢失（两个入口字段集一致）', () => {
  const src = readLib('web-control.js');
  assert.ok(/sessionLostCount/.test(src) && /lastSessionLost/.test(src),
    '无 relay 的独立启动分支也要带这两个字段');
});