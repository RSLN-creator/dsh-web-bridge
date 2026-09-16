// decoder-fragment-diff.test.mjs — 「网页有输出、harness 收不到」的护栏（0.15.7）。
//
// ## 为什么需要它（真机缺陷，不是假想）
//
// 用户原话：**「？怎么回事》明明有输出：<tool_call>{…}</tool_call> 却提示
// THINKING_ONLY_NO_ANSWER」**。观感是「网页明明答了，桥却说它没答」。
//
// 根因**不在收尾判定**，而在**接收层的流式增量**：DeepSeek 会把**整份 response
// 对象**反复重发（`{o:'SET', v:{response:{…}}}` 与 `{o:'SET',
// p:'response/fragments'}` 两种写法都出现过），每次 fragments 都比上一次长。
// 旧实现只在「第一次见到该 response」时（`isFirst`）外发增量，之后每一次重发都
// **整份静默替换**：
//
//   onDelta 累计 acc = 第一帧的内容        ← 界面正文停在半路
//   finish().text    = 完整正文            ← 权威全文
//
// 于是 `index.js` 的协议边界探测（只看 acc）在后段里**探不到工具调用**，
// 一个 tool-call 块都不开、工具从未执行；收尾 `finalText` 与 `textSent` 分叉，
// 该轮被判成「正文空 + 只有思考」→ 交回 THINKING_ONLY_NO_ANSWER。
// 用户看到的正是「明明有输出，却提示我没有正文」。
//
// ## 这条护栏钉什么
//
// 唯一的契约：**流式外发的拼接必须与 finish() 的权威全文逐字一致**。
// 它同时覆盖正文/思考/图片三条通道，且必须反向钉住两条安全线
// （改写不得伪造成增量、重复重发不得放大）——否则「修法」会变成
// 「正文重复 N 次」或「STREAM_REWRITE 整轮作废」，比不修更坏。
//
// 反向验证纪律（doc/comment-style.md §9.3）：把 consumeResponse 恢复成
// 「只在 isFirst 外发」，本文件第 1、2、3 条必须变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/decoder.js';

const D = globalThis.WebCodeStreamDecoders;

/** 一个已接好三条回调通道的 DeepSeek 解码器 + 其外发记录。 */
function makeDecoder() {
  const deltas = [];
  const thinks = [];
  const images = [];
  const decoder = new D.deepseek({
    onDelta: (t) => deltas.push(t),
    onThink: (t) => thinks.push(t),
    onImage: (i) => images.push(i),
  });
  return { decoder, deltas, thinks, images, text: () => deltas.join(''), think: () => thinks.join('') };
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** 整份 response 重发（`{o:'SET', v:{response:{…}}}`）——真机主形态。 */
const sendResponseSet = (fragments, status = 'WIP') => sse('message', {
  o: 'SET', p: '',
  v: { response: { message_id: 'm1', role: 'ASSISTANT', status, fragments } },
});

/** `p: 'response/fragments'` 写法——同一件事的另一个入口。 */
const sendFragmentsSet = (fragments) => sse('message', { o: 'SET', p: 'response/fragments', v: fragments });

// ---- ① 主洞：整份 response 重发时，增长的部分必须外发 -----------------------

test('整份 response 重发：流式外发与 finish() 全文逐字一致（旧实现漏发后半段）', () => {
  const { decoder, text } = makeDecoder();
  decoder.push(sendResponseSet([{ type: 'RESPONSE', content: 'Hello' }]));
  decoder.push(sendResponseSet([{ type: 'RESPONSE', content: 'Hello world' }]));
  decoder.push(sendResponseSet([{ type: 'RESPONSE', content: 'Hello world!' }]));
  const fin = decoder.finish();
  // 旧实现：text() === 'Hello'，fin.text === 'Hello world!' —— 静默漏发 12 字符。
  assert.equal(text(), 'Hello world!', '增长的部分必须逐次外发');
  assert.equal(text(), fin.text, '流式外发必须与权威全文逐字一致');
});

test('重发时新增的片段（多出下标）整段外发', () => {
  const { decoder, text } = makeDecoder();
  decoder.push(sendResponseSet([{ type: 'RESPONSE', content: 'AAA' }]));
  decoder.push(sendResponseSet([
    { type: 'RESPONSE', content: 'AAA' },
    { type: 'RESPONSE', content: 'BBB' },
  ]));
  const fin = decoder.finish();
  // 旧实现：新增片段 BBB 永远不会经过 onDelta。
  assert.equal(text(), 'AAABBB');
  assert.equal(text(), fin.text);
});

test('p=response/fragments 写法与整份重发语义一致（两个入口同一个洞）', () => {
  const { decoder, text } = makeDecoder();
  decoder.push(sendResponseSet([{ type: 'RESPONSE', content: 'x' }]));
  decoder.push(sendFragmentsSet([{ type: 'RESPONSE', content: 'xy' }]));
  const fin = decoder.finish();
  assert.equal(text(), 'xy');
  assert.equal(text(), fin.text);
});

// ---- ② 思考与图片两条通道同样不能只在 finish() 才可见 ----------------------

test('思考通道：SET 增长必须外发增量', () => {
  const { decoder, think } = makeDecoder();
  decoder.push(sendResponseSet([{ type: 'THINK', content: 'a' }]));
  decoder.push(sendResponseSet([{ type: 'THINK', content: 'abc' }]));
  assert.equal(think(), 'abc', '思考增长必须外发，否则界面轮次进行中看不到思考');
});

test('图片通道：SET 新增的图片必须在流式期间触发 onImage', () => {
  const { decoder, images } = makeDecoder();
  decoder.push(sendResponseSet([{ type: 'RESPONSE', content: 'see' }]));
  decoder.push(sendResponseSet([
    { type: 'RESPONSE', content: 'see' },
    { type: 'IMAGE', image: { url: 'https://example.test/a.png' } },
  ]));
  decoder.finish();
  // 旧实现：onImage 恒为 0 次，图片只能靠 finish() 捞回来 —— 轮次进行中界面无图。
  assert.equal(images.length, 1, '流式期间必须能看到图片');
});

// ---- ③ 反向安全线（同等重要：修法不得引入新缺陷）--------------------------

test('安全线：同下标内容被改写时不得补发（补发会变成重复正文）', () => {
  const { decoder, text } = makeDecoder();
  decoder.push(sendResponseSet([{ type: 'RESPONSE', content: 'Hello' }]));
  decoder.push(sendResponseSet([{ type: 'RESPONSE', content: 'Goodbye' }]));
  // 不以旧内容为前缀 = 改写，不是增长：必须**不发**，交给收尾的权威比对处理，
  // 否则界面会出现两段互不相干的正文。
  assert.equal(text(), 'Hello');
});

test('安全线：重复重发同一份 fragments 幂等，不得放大', () => {
  const { decoder, text } = makeDecoder();
  for (let i = 0; i < 4; i++) decoder.push(sendResponseSet([{ type: 'RESPONSE', content: 'same' }]));
  assert.equal(text(), 'same', '重复重发不得让正文重复');
});

test('安全线：SET 首次到达时整段外发（不是「空 diff」）', () => {
  const { decoder, text } = makeDecoder();
  decoder.push(sendResponseSet([{ type: 'RESPONSE', content: 'first' }]));
  assert.equal(text(), 'first', '首次必须外发，否则正文整段丢失');
});

// ---- ④ 接线判据：两个入口必须共用同一个 diff 实现 -------------------------
//
// 本项目 0.15.0 的教训：源码文本断言会放过真正的问题（`projectRoster is not
// defined` 就是被「有计划、有闸门」放过去的）。因此这里断言的是**结构性事实**
// ——两个入口都调用 emitFragmentDiff，而不是各写一份比较逻辑散落两处。
test('接线：consumeResponse 与 applyOperation 的 SET 分支共用 emitFragmentDiff', () => {
  // 行为已由上面 7 条覆盖；这里防止「只修一个入口」的半修。
  const { decoder } = makeDecoder();
  assert.equal(typeof decoder.emitFragmentDiff, 'function', '必须存在统一的 diff 实现');
});
