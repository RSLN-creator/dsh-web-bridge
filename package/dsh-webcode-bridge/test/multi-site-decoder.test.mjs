import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../lib/decoder.js';
import { qualifyModelId, resolveWebModel, listAllModels, SITES } from '../lib/providers.js';

const D = globalThis.WebCodeStreamDecoders;

test('qualifyModelId：裸 id 补站点前缀、限定 id 原样、空值透传', () => {
  assert.equal(qualifyModelId('auto', 'glm'), 'glm:auto');
  assert.equal(qualifyModelId('deepseek:deepseek', 'deepseek'), 'deepseek:deepseek');
  assert.equal(qualifyModelId('flash', undefined), 'flash');
  assert.equal(qualifyModelId(null, 'glm'), null);
});

test('listAllModels：全站点目录含 DeepSeek/GLM/ChatGPT/Kimi/Qwen 与兼容别名', () => {
  const all = listAllModels();
  const ids = new Set(all.map((m) => m.id));
  // 三合一后 DeepSeek 只有唯一模型（旧 id 仍可解析为别名，但不再出现在目录里）
  assert.ok(ids.has('deepseek:deepseek') && !ids.has('deepseek:flash') && !ids.has('deepseek:vision'));
  assert.ok(ids.has('glm:auto') && ids.has('chatgpt:auto') && ids.has('kimi:auto'));
  assert.ok(ids.has('qwen:auto') && ids.has('deepseek-web'));
  // z.ai（GLM 海外站点）已入目录，且别名可解析
  assert.ok(ids.has('zai:auto'), '目录应包含 zai:auto');
  assert.equal(resolveWebModel('zai').siteId, 'zai');
  assert.equal(resolveWebModel('z-ai').siteId, 'zai');
  const m = resolveWebModel('glm:auto');
  assert.equal(m.siteId, 'glm');
  assert.equal(m.id, 'auto');
});

test('z.ai：站点契约（origin / SSE 端点 / 解码器 / 静态域）', () => {
  const z = resolveWebModel('zai:auto');
  assert.equal(z.siteId, 'zai');
  assert.equal(z.origin, 'https://chat.z.ai');
  assert.equal(z.decoder, 'openai-sse');
  const st = SITES.find(s => s.id === 'zai');
  assert.ok(st, 'SITES 必须包含 zai');
  assert.ok(st.completionPaths.includes('/api/chat/completions'));
  assert.deepEqual([...st.staticOrigins], ['https://z-cdn.chatglm.cn', 'https://api.z.ai']);
  // 解码器注册表里确实有这个 kind（否则驱动会静默拿不到 decoder）
  assert.equal(typeof D['openai-sse'], 'function');
});

test('glm：parts[].content[] 嵌套结构的正文与图片（glm-free-api 同构帧）', () => {
  const deltas = [];
  const images = [];
  const decoder = new D.glm({ onDelta: (t) => deltas.push(t), onImage: (i) => images.push(i) });
  const frame = (obj) => decoder.push('data: ' + JSON.stringify(obj) + '\n\n');
  frame({
    conversation_id: 'c1', status: 'processing',
    parts: [{ status: 'processing', content: [
      { status: 'init', type: 'text', text: '你好，' },
    ] }],
  });
  frame({
    conversation_id: 'c1', status: 'processing',
    parts: [{ status: 'processing', content: [
      { status: 'finish', type: 'text', text: '我是 GLM。' },
      { status: 'finish', type: 'image', image: [{ image_url: 'https://glm.example/a.png' }] },
    ] }],
  });
  frame({ conversation_id: 'c1', status: 'finish', parts: [] });
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.equal(out.text, '你好，我是 GLM。');
  assert.deepEqual(deltas.join(''), '你好，我是 GLM。');
  assert.equal(images.length, 1);
  assert.equal(images[0].url, 'https://glm.example/a.png');
});

/**
 * ★ 0.19.23：GLM 原生**结构化 code part** 里的调用必须被解出来。
 *
 * 参考实现 `reference/glm-free-api/src/api/controllers/chat.ts:994-1013` 把
 * `type == 'code'` 当**一等公民**（为它拼 ``` 围栏再交给上层）——即在这条流里，
 * `code` 与 `text` 是**并列的两种正文载体**。本桥此前只实现后者，
 * `code` 一路落到 obj() 末尾被静默忽略。
 *
 * 离线实证（`.tmp-probe-glm-native.mjs` ①a 对照 ①b）：
 *   同一段调用 JSON 放进 type:'code' ⇒ 修复前 deltas 为空、text 为空，
 *                                     **整个调用消失**；放进 type:'text' ⇒ 正常外发。
 *
 * 判据刻意收窄：**只有调用形态才外发**。普通代码块维持既有行为（丢弃）——
 * 把模型内部的草稿代码整段铺进会话，比丢一个调用是更常见的噪声。
 */
test('★ 0.19.23 glm：原生 code part 携带的调用必须解出来（普通代码块仍不外发）', () => {
  const CALL = '{"mcp_action": "call", "name": "read", "arguments": {"path": "lib"}}';
  const SEP = String.fromCharCode(10) + String.fromCharCode(10);
  const mk = () => {
    const deltas = [];
    const d = new D.glm({ onDelta: (t) => deltas.push(t) });
    return { d, deltas, f: (obj) => d.push('data: ' + JSON.stringify(obj) + SEP) };
  };

  // ① 调用形态：init 帧 + finish 帧重发全量 ⇒ 只外发一次。
  const a = mk();
  a.f({ conversation_id: 'c1', status: 'processing', parts: [{ status: 'processing', content: [{ status: 'init', type: 'code', code: CALL }] }] });
  a.f({ conversation_id: 'c1', status: 'finish', parts: [{ status: 'finish', content: [{ status: 'finish', type: 'code', code: CALL }] }] });
  const out1 = a.d.finish();
  assert.equal(a.deltas.join(''), CALL, 'code part 里的调用 JSON 必须原样外发（修复前为空）');
  assert.equal(out1.text, CALL, '结果正文里也必须带上它 —— 否则协议解析器看不到这条调用');

  // ② 普通代码块：维持既有行为 —— 不外发。
  const b = mk();
  b.f({ conversation_id: 'c2', status: 'processing', parts: [{ status: 'processing', content: [{ status: 'init', type: 'code', code: 'const a = 1;\nconsole.log(a);' }] }] });
  const out2 = b.d.finish();
  assert.equal(b.deltas.join(''), '', '普通代码块不得被当正文外发（它没有 mcp_action、也不以 { 开头）');
  assert.equal(out2.text, '', '普通代码块不得进入结果正文');

  // ③ 分段累积：同一段分两次到达不得重复外发。
  const c = mk();
  const half = Math.floor(CALL.length / 2);
  c.f({ status: 'processing', parts: [{ status: 'processing', content: [{ status: 'init', type: 'code', code: CALL.slice(0, half) }] }] });
  c.f({ status: 'processing', parts: [{ status: 'processing', content: [{ status: 'processing', type: 'code', code: CALL }] }] });
  assert.equal(c.deltas.join(''), CALL, '分段累积后只应外发一次完整内容（不得重复）');
});

test('glm：type=think 思维链增量 + finish 帧累积全文不重复（真机 2026-09-12 抓包形状）', () => {
  const th = [], tx = [];
  const decoder = new D.glm({ onThink: (t) => th.push(t), onDelta: (t) => tx.push(t) });
  const SEP = String.fromCharCode(10) + String.fromCharCode(10);
  const frame = (obj) => decoder.push('data: ' + JSON.stringify(obj) + SEP);
  frame({ status: 'processing', parts: [{ status: 'processing', content: [{ type: 'think', think: 'Let me think' }] }] });
  frame({ status: 'processing', parts: [{ status: 'processing', content: [{ type: 'think', think: ' step by step' }] }] });
  frame({ status: 'processing', parts: [{ status: 'processing', content: [{ type: 'text', text: '答案是' }] }] });
  frame({ status: 'finish', parts: [{ status: 'finish', content: [
    { type: 'think', think: 'Let me think step by step' },
    { type: 'text', text: '答案是 42' }] }] });
  const out = decoder.finish();
  assert.equal(out.thinking, 'Let me think step by step');
  assert.equal(out.text, '答案是 42');
  assert.equal(th.join(''), 'Let me think step by step');
  assert.equal(tx.join(''), '答案是 42');
});

test('kimi：cmpl 事件正文 + all_done 收尾（Kimi-Free-API 同构帧）', () => {
  const deltas = [];
  const decoder = new D.kimi({ onDelta: (t) => deltas.push(t) });
  const frame = (obj) => decoder.push('data: ' + JSON.stringify(obj) + '\n\n');
  frame({ event: 'req', id: 'seg1' });
  frame({ event: 'cmpl', text: '你好' });
  frame({ event: 'cmpl', text: '，我是 Kimi。' });
  frame({ event: 'search_plus', msg: { type: 'get_res', title: '来源', url: 'https://x' } });
  frame({ event: 'all_done' });
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.equal(out.text, '你好，我是 Kimi。');
  assert.deepEqual(deltas.join(''), '你好，我是 Kimi。');
});

test('kimi：thinking 字段经 onThink 暴露且不混入正文', () => {
  const think = [];
  const decoder = new D.kimi({ onDelta: () => {}, onThink: (t) => think.push(t) });
  decoder.push('data: ' + JSON.stringify({ event: 'cmpl', thinking: '先分析……', text: '结论。' }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ event: 'all_done' }) + '\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.ok(think.join('').includes('先分析'));
  assert.equal(out.text, '结论。');
  assert.ok(!out.text.includes('先分析'));
});

test('kimi-connect：Connect-RPC 二进制帧 JSON 解码（2026-09-21 真机确证）', () => {
  const deltas = [];
  const think = [];
  const decoder = new D['kimi-connect']({ onDelta: (t) => deltas.push(t), onThink: (t) => think.push(t) });
  const frame = (j) => decoder.push(JSON.stringify(j) + '\n');
  frame({ op: 'set', mask: 'chat.lastRequest', chat: { id: 'chat_x1', lastRequest: { options: { model: 'k2d6-chat' } } } });
  // 思考链增量碎片（mask: block.think.content）
  frame({ op: 'append', mask: 'block.think.content', block: { think: { content: '先思' } } });
  frame({ op: 'append', mask: 'block.think.content', block: { think: { content: '考' } } });
  // 最终正文（set 一次完整）
  frame({ op: 'set', mask: 'block.text', block: { text: { content: '你好' } } });
  // 完成标志
  frame({ done: {}, eventOffset: 1 });
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.equal(out.text, '你好');
  assert.deepEqual(deltas.join(''), '你好');
  assert.deepEqual(think.join(''), '先思考');
  assert.equal(out.conversationId, 'chat_x1');
});

test('kimi-connect：assistant 消息 status COMPLETED 收尾与会话 id 提取', () => {
  const decoder = new D['kimi-connect']({ onDelta: () => {} });
  const frame = (j) => decoder.push(JSON.stringify(j) + '\n');
  frame({ op: 'set', mask: 'chat.lastRequest', chat: { id: 'chat_x2' } });
  frame({ op: 'set', mask: 'message', message: { id: 'm1', role: 'assistant', status: 'MESSAGE_STATUS_COMPLETED' } });
  frame({ op: 'set', mask: 'block.text', block: { text: { content: '正文' } } });
  frame({ done: {} });
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.ok(out.text.includes('正文'));
  assert.equal(out.conversationId, 'chat_x2');
});

test('kimi-connect：done 缺失判 incomplete', () => {
  const decoder = new D['kimi-connect']({ onDelta: () => {} });
  decoder.push(JSON.stringify({ op: 'set', mask: 'block.text', block: { text: { content: '半截' } } }) + '\n');
  const out = decoder.finish();
  assert.equal(out.complete, false);
  assert.equal(out.reason, 'incomplete');
});

test('chatgpt：JSON-patch 帧 o/p/v（LLMs2API 同构）', () => {
  const deltas = [];
  const decoder = new D.chatgpt({ onDelta: (t) => deltas.push(t) });
  decoder.push('data: ' + JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: 'Hello' }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: ' world' }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ type: 'message_stream_complete' }) + '\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.equal(out.text, 'Hello world');
  assert.deepEqual(deltas.join(''), 'Hello world');
});

test('chatgpt：reasoning JSON-patch 帧走 onThink', () => {
  const think = [];
  const decoder = new D.chatgpt({ onDelta: () => {}, onThink: (t) => think.push(t) });
  decoder.push('data: ' + JSON.stringify({ o: 'append', p: '/message/reasoning/0', v: '想一下' }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ type: 'message_stream_complete' }) + '\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.ok(think.join('').includes('想一下'));
  assert.equal(out.text, '');
});

test('qwen：contents[] 直连兜底结构（qwen-free-api 同构）', () => {
  const deltas = [];
  const decoder = new D['openai-sse']({ onDelta: (t) => deltas.push(t) });
  decoder.push('data: ' + JSON.stringify({ sessionId: 's1', msgId: 'm1', contentType: 'text', msgStatus: 'running', contents: [{ contentType: 'text', role: 'assistant', content: '你好' }] }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ sessionId: 's1', msgId: 'm1', contentType: 'text', msgStatus: 'finished', contents: [{ contentType: 'text', role: 'assistant', content: '，我是通义。' }] }) + '\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.equal(out.text, '你好，我是通义。');
  assert.deepEqual(deltas.join(''), '你好，我是通义。');
});

test('qwen：OpenAI 兼容 SSE 仍正常（LLMs2API 实测浏览器形态）', () => {
  const deltas = [];
  const decoder = new D['openai-sse']({ onDelta: (t) => deltas.push(t) });
  decoder.push('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }) + '\n\n');
  decoder.push('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.equal(out.text, 'Hi');
  assert.deepEqual(deltas.join(''), 'Hi');
});

test('驱动解码器注册表护栏：创建时急加载 + onPageCapture 懒加载兜底（0.12.2）', () => {
  // 回归背景：0.12.0 起启动自动登录核验先于 ensure() 直接 launch 出活页，
  // ensure() 提前返回，注册表永不加载 → 首个真实轮次「no decoder for kind」
  // 静默挂到 240s 超时。这里锁住两道防线，防止再次被重构掉。
  const src = fs.readFileSync(new URL('../lib/browser-driver.js', import.meta.url), 'utf8');
  // 第一道：驱动创建阶段（cfg 就绪后）即预加载注册表。
  assert.match(src, /let Decoders = null;[\s\S]{0,300}try \{ Decoders = loadDecoderRegistry\(cfg\.decoderPath\); \} catch/);
  // 第二道：onPageCapture 在查找解码器类之前必须重试加载。
  const onPage = src.slice(src.indexOf('function onPageCapture'), src.indexOf('function finishActive'));
  assert.ok(onPage.length > 0, 'onPageCapture 必须存在');
  assert.match(onPage, /if \(!Decoders\) \{ try \{ Decoders = loadDecoderRegistry\(cfg\.decoderPath\); \} catch/);
});

// ---------- DeepSeek hint 限流（2026-09-13 真机实锤） ----------
// 真实流首段：ready(request_message_id=31, response_message_id=32) 后紧跟
// hint{type:'error', content:'消息发送过于频繁…', clear_response:true,
// finish_reason:'rate_limited'}，服务端撤回消息、零响应帧收流。旧实现把
// hint 静默丢弃，整轮报 no_response_frames，真实原因只能靠流首段猜。

test('deepseek hint：rate_limited → reason=rate_limited 且带服务端原话', () => {
  const decoder = new D.deepseek({});
  decoder.push('event: ready\ndata: {"request_message_id":31,"response_message_id":32,"model_type":"default"}\n\n');
  decoder.push('event: hint\ndata: {"type":"error","content":"消息发送过于频繁，请稍后重试","clear_response":true,"finish_reason":"rate_limited"}\n\n');
  decoder.push('event: close\ndata: \n\n');
  const out = decoder.finish();
  assert.equal(out.complete, false);
  assert.equal(out.partial, false);
  assert.equal(out.reason, 'rate_limited');
  assert.equal(out.hint, '消息发送过于频繁，请稍后重试');
  assert.equal(out.text, '');
});

test('deepseek hint：非限流错误 hint 不改变 no_response_frames 归类', () => {
  const decoder = new D.deepseek({});
  decoder.push('event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n');
  decoder.push('event: hint\ndata: {"type":"error","content":"内容审核未通过","finish_reason":"content_filter"}\n\n');
  decoder.push('event: close\ndata: \n\n');
  const out = decoder.finish();
  assert.equal(out.reason, 'no_response_frames');
  assert.equal(out.hint, null);
});

test('deepseek hint：已有响应帧时 hint 只是旁路提示，不影响部分流', () => {
  const deltas = [];
  const decoder = new D.deepseek({ onDelta: (t) => deltas.push(t) });
  decoder.push('event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n');
  decoder.push('data: ' + JSON.stringify({ v: { response: { role: 'ASSISTANT', message_id: 2, status: 'WIP', fragments: [{ type: 'RESPONSE', content: '部分回答' }] } } }) + '\n\n');
  decoder.push('event: hint\ndata: {"type":"error","content":"异常","finish_reason":"rate_limited"}\n\n');
  const out = decoder.finish();
  assert.equal(out.reason, 'stream_ended_before_finished');
  assert.equal(out.partial, true);
  assert.equal(out.text, '部分回答');
  assert.equal(out.hint, null);
});

// ---------- 限流帧被掐断（2026-09-13 子代理真机实锤） ----------
// 真实事故：长任务派出的子代理整轮死于
//   web capture ended incomplete: no_response_frames | 流首段: …"finish_reason":"rate_l
// 限流 hint 是流的**最后一帧**，帧尾随连接一起被掐断，于是
//   ① finish_reason 只剩前缀 'rate_l' —— 精确相等比较永远漏判；
//   ② JSON 解析失败 → this.failed 置位 → 先按 invalid_stream 返回。
// 两条路都让「消息发送过于频繁」这个真因看不见，上层拿不到 RATE_LIMITED，
// 不会退避重试，子代理直接死掉。以下用例锁死这几种形态。

test('deepseek hint：finish_reason 被截断成前缀仍判 rate_limited', () => {
  const decoder = new D.deepseek({});
  decoder.push('event: ready\ndata: {"request_message_id":47,"response_message_id":48,"model_type":"default"}\n\n');
  // 帧尾丢失，但 JSON 本身仍完整
  decoder.push('event: hint\ndata: {"type":"error","content":"消息发送过于频繁，请稍后重试","clear_response":true,"finish_reason":"rate_l');
  const out = decoder.finish();
  assert.equal(out.reason, 'rate_limited', '截断的 finish_reason 前缀必须仍被判为限流');
  assert.equal(out.hint, '消息发送过于频繁，请稍后重试');
});

test('deepseek hint：hint 帧无结尾空行（流被掐断）仍判 rate_limited', () => {
  const decoder = new D.deepseek({});
  decoder.push('event: ready\ndata: {"request_message_id":47,"response_message_id":48}\n\n');
  decoder.push('event: hint\ndata: {"type":"error","content":"消息发送过于频繁，请稍后重试","finish_reason":"rate_limited"}');
  const out = decoder.finish();
  assert.equal(out.reason, 'rate_limited');
});

test('deepseek hint：JSON 解析失败但原文含限流话术 → 优先 rate_limited 而非 invalid_stream', () => {
  const decoder = new D.deepseek({});
  decoder.push('event: ready\ndata: {"request_message_id":47,"response_message_id":48}\n\n');
  // JSON 被截断：解析必然失败；真因只能从原文里认出来
  decoder.push('event: hint\ndata: {"type":"error","content":"消息发送过于频繁，请稍后重试","clear_response":true,"finish_reason":"rate_lim');
  const out = decoder.finish();
  assert.equal(out.reason, 'rate_limited', 'JSON 截断不能把限流掩盖成 invalid_stream');
  assert.equal(out.hint, '消息发送过于频繁，请稍后重试');
});

test('deepseek hint：非限流话术的截断帧仍按原语义归类（不误报限流）', () => {
  const decoder = new D.deepseek({});
  decoder.push('event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n');
  decoder.push('event: hint\ndata: {"type":"error","content":"内容审核未通过","finish_reason":"content_fil');
  const out = decoder.finish();
  assert.notEqual(out.reason, 'rate_limited', '审核类失败不得被误判成限流');
  assert.equal(out.hint, null);
});

// ---- 0.19.16：流未收尾时**已解内容不得被丢掉** ------------------------------
//
// 真机故障（用户报「glm-5.3-flash 思维链流到一半 → 空回复」，会话 a23e4ee4）：
// 收束原因 `partial-wip-settled`、最终正文与思维链**双空** → 上层判
// `empty response from web AI`。根因不在 DOM 也不在 SSE 解码，而在收尾：
// JsonLinesDecoder.finish() 的 `!this.done` 分支**只返回 reason，不带
// text/thinking** —— 而 emitText/emitThink 全程把内容累在 this.text/this.think 里，
// 于是「流式通道有内容、finish() 返回值里没有」。驱动拿这个空结果去判空，
// 整轮作废（browser-driver.js 的 partial-wip-settled → emptyWebResponseError）。
//
// 为什么单测原本全绿：既有用例**每一个都补了收尾帧**（status:'finish' / [DONE] /
// finish_reason），于是永远走 `complete:true` 那一支。缺口是「正常关闭但没有收尾帧」
// —— 而 GLM 捕获层在 HTTP 流结束时只 emit(id,'end','')，**不构造任何收尾帧**，
// 所以那是必然出现的一类真实收尾，不是异常路径。

test('glm：无收尾帧时已解的正文与思维链必须带出来（0.19.16 主修）', () => {
  const SEP = String.fromCharCode(10) + String.fromCharCode(10);
  const frame = (o) => 'data: ' + JSON.stringify(o) + SEP;
  const decoder = new D.glm({});
  decoder.push(frame({ conversation_id: 'c9', status: 'WIP', parts: [{ content: [{ type: 'think', think: 'Let me reason' }] }] }));
  decoder.push(frame({ conversation_id: 'c9', status: 'WIP', parts: [{ content: [{ type: 'think', think: ' step by step' }] }] }));
  decoder.push(frame({ conversation_id: 'c9', status: 'WIP', parts: [{ content: [{ type: 'text', text: 'Here is the answer.' }] }] }));
  const out = decoder.finish();
  // 没收完整（网页没送 status:'finish'）—— 这一点本身要如实报出来。
  assert.equal(out.complete, false);
  assert.equal(out.reason, 'incomplete');
  // 但**已经解出来的内容一个字都不能少**：这就是本故障的全部内容。
  assert.equal(out.text, 'Here is the answer.');
  assert.equal(out.thinking, 'Let me reason step by step');
  // partial 是驱动区分「有内容可交」与「整轮作废」的唯一依据（见 browser-driver
  // 的 `!result.complete && !result.partial` 与 emptyWebResponseError）。
  assert.equal(out.partial, true, 'partial 必须为真，否则驱动仍判空回复');
  assert.equal(out.conversationId, 'c9', '会话身份在失败分支同样必须带出');
});

test('glm：缺终结空行的残缺尾帧不得丢内容（0.19.16 附带修）', () => {
  const SEP = String.fromCharCode(10) + String.fromCharCode(10);
  const decoder = new D.glm({});
  decoder.push('data: ' + JSON.stringify({ status: 'WIP', parts: [{ content: [{ type: 'text', text: 'first ' }] }] }) + SEP);
  // 末帧被截断：没有结尾空行。基类 finish() 走 `this.line(this.buf.trim())`，
  // 而 line() 是 JSON.parse —— 缓冲区里是 `data: {...}`，JSON.parse 必抛，
  // 于是整段最后一句静默消失。GlmDecoder 必须覆写 finish() 按 SSE 规则解析它。
  decoder.push('data: ' + JSON.stringify({ status: 'WIP', parts: [{ content: [{ type: 'text', text: 'first second' }] }] }));
  const out = decoder.finish();
  assert.equal(out.text, 'first second', '残缺尾帧里的内容必须解出来，不能被 JSON.parse 静默吞掉');
  assert.equal(out.partial, true);
});

test('glm：有收尾帧时结果形状与改动前逐字相同（不得因本次修复而漂移）', () => {
  const SEP = String.fromCharCode(10) + String.fromCharCode(10);
  const decoder = new D.glm({});
  decoder.push('data: ' + JSON.stringify({ status: 'finish', parts: [{ content: [{ type: 'text', text: 'done' }] }] }) + SEP);
  const out = decoder.finish();
  assert.equal(out.complete, true);
  assert.equal(out.text, 'done');
  // 跑完整的结果**不许**带 partial：调用方用 `!complete && !partial` 判「空流宽限
  // 重绑」（browser-driver.js:1335），多一个恒真字段会让「跑完了」与「跑一半」不可分。
  assert.equal('partial' in out, false, 'complete 结果不得带 partial 字段');
});

test('同族 SSE 解码器：incomplete / invalid_stream 分支同样带出已解内容', () => {
  const SEP = String.fromCharCode(10) + String.fromCharCode(10);
  const F = (o) => 'data: ' + JSON.stringify(o) + SEP;
  // openai-sse（zai / qwen 用）：已解出正文但没收到 finish_reason
  const oai = new D['openai-sse']({});
  oai.push(F({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }));
  const a = oai.finish();
  assert.equal(a.complete, false);
  assert.equal(a.text, 'Hi', 'openai-sse 已解正文不得在 incomplete 分支丢失');
  assert.equal(a.partial, true);
  // claude：content_block_delta 之后流断
  const cl = new D.claude({});
  cl.push(F({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }));
  const b = cl.finish();
  assert.equal(b.text, 'partial');
  assert.equal(b.partial, true);
  // chatgpt：JSON-patch 帧之后没有 message_stream_complete
  const gpt = new D.chatgpt({});
  gpt.push(F({ o: 'append', p: '/message/content/parts/0', v: 'Half' }));
  const c = gpt.finish();
  assert.equal(c.text, 'Half');
  assert.equal(c.partial, true);
});

test('全空且流未收尾：partial 必须为假（不得把「真的什么都没来」伪装成部分流）', () => {
  const decoder = new D.glm({});
  decoder.push('data: ' + JSON.stringify({ conversation_id: 'c1', status: 'WIP', parts: [] }) + String.fromCharCode(10) + String.fromCharCode(10));
  const out = decoder.finish();
  assert.equal(out.complete, false);
  assert.equal(out.partial, false, '零内容轮必须如实报 false，让驱动走真正的失败路径');
  assert.equal(out.text, '');
  assert.equal(out.thinking, '');
});
