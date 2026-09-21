// glm-tool-snapshot-dedup.test.mjs — GLM 工具调用后正文残留护栏（2026-09-21 真机证据）。
//
// ## 为什么需要它（真机缺陷，任务 0.2/2.1）
//
// 用户原话：「支付宝 GLN 产品真实对话，会发现它有正文残留」。
// real-probe-26-glm-frames.mjs 真机抓帧（chatglm.cn，触发 execute_sandbox_code 工具轮，
// 30 帧原始 SSE，落在 .tmp/glm-replay/raw-frames.jsonl）证实：GLM 的 text 帧**不是
// 纯增量、也不是纯累积，而是「增量碎片 → 工具轮 → 完整段落快照」混合语义**——
// 工具执行后（role='tool' / type='tool_result' 之后），站点把整段结论（如 121 字符
// 的「代码已成功执行…」）作为新前缀文本在 status=init 与 status=finish **连续两帧
// 原样重发**。旧解码器把这两帧都判 NEW、分别 emit，同一段落被播两遍（叠加 DOM 侧
// 3 倍观感 = 「正文残留/加倍」）。
//
// ## 这条护栏钉什么
//
// 只钉**解码器**层的去重契约，不涉及 index.js：
//   ① 工具轮后连续两帧的相同完整快照，第二帧必须被丢弃（残留=0）；
//   ② 其余纯增量碎片必须逐字按序 emit，不得因去重而漏字；
//   ③ 快照若带**实际新增**（同一前缀但更长），必须外发增量，不得误判为重复。
//
// 反向验证纪律：把 GlmDecoder 的 `if (t === this.lastGlmTextSegment) continue;` 删掉，
// 本文件①必须变红（正文多出 121 字符）。
import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/decoder.js';

const GlmDecoder = globalThis.WebCodeStreamDecoders?.glm;
if (!GlmDecoder) { throw new Error('glm decoder not registered'); }

/** 构造一个只含 text content 的 GLM SSE 帧。 */
function frame(text, { status = 'init', alsoToolFrame = false } = {}) {
  const content = alsoToolFrame
    ? [{ type: 'tool_calls', tool_calls: { id: 'call_x', name: 'execute_sandbox_code', arguments: '{}' } }]
    : [{ type: 'text', text, tool_calls: {} }];
  return 'data: ' + JSON.stringify({
    id: 'assist1', conversation_id: 'conv-1', status,
    parts: [{ role: 'assistant', content, status }],
  }) + '\n\n';
}

function makeDecoder() {
  const emits = { text: [], think: [] };
  const dec = new GlmDecoder();
  dec.emitText = (t) => { if (t) emits.text.push(t); };
  dec.emitThink = (t) => { if (t) emits.think.push(t); };
  dec.pushImage = () => {};
  return { dec, emits, joined: () => emits.text.join('') };
}

// 工具轮后完整快照（真机 121 字符原样）：增量碎片 + 完整快照 ×连续2帧
const SNAP = '代码已成功执行，结果是：\n\n**3 的 12 次方 = 531441**\n\n'
  + '计算方式很简单，使用 Python 的幂运算符 `**`：\n```python\nresult = 3 ** 12\n```\n\n'
  + '如果你还需要计算其他数值的幂，随时告诉我！';

test('GLM 工具轮：连续两帧的相同完整快照只 emit 一次（残留=0）', () => {
  const { dec, emits, joined } = makeDecoder();
  // 工具轮前正文：模型先说要写代码（增量碎片）
  for (const t of ['我来', '编写', '并', '执行这段', ' Python', ' ', '代码：']) dec.push(frame(t));
  // 工具调用帧 + 结果帧（模拟 execute_sandbox_code → tool_result）
  dec.push(frame('', { alsoToolFrame: true }));
  dec.push('data: ' + JSON.stringify({
    id: 'assist1', conversation_id: 'conv-1', status: 'init',
    parts: [{ role: 'tool', content: [{ type: 'tool_result', tool_calls: {}, content: '{"success":true}' }], status: 'finish' }],
  }) + '\n\n');
  // 工具轮后增量碎片（真机 f20-f28）
  for (const t of ['代码', '已', '成功', '执行，结果是', '：\n\n**3', ' 的 12 次方 = 531441**\n\n计算方式很简单，',
    '使用 Python 的幂运算符 `**`：\n```python\nresult', ' = 3 ** 12\n```\n\n如果你还需要计算其他数值的幂，']) {
    dec.push(frame(t));
  }
  dec.push(frame('随时告诉我！'));
  // 完整快照：init 帧 + finish 帧 —— 两帧 t 完全相同，第二帧必须丢弃
  dec.push(frame(SNAP, { status: 'init' }));
  dec.push(frame(SNAP, { status: 'finish' }));
  const fin = dec.finish();

  const countSnapshot = emits.text.filter((t) => t === SNAP).length;
  // 快照内容已由工具轮后碎片逐字 emit，整段快照帧应被丢弃（残留=0）
  assert.equal(countSnapshot, 0, `工具轮后整段快照应被丢弃（碎片已拼出内容），实际外发 ${countSnapshot} 次`);
  assert.equal(joined(), '我来编写并执行这段 Python 代码：' + SNAP, '前后片段应完整、无重复拼接');
});

test('GLM 工具轮：同一前缀但更长（真新增）必须外发增量，不得误判为重复', () => {
  const { dec, emits } = makeDecoder();
  dec.push(frame(SNAP));
  // 同前缀但多出结尾一句 = 真新增：必须补发新增后缀
  const longer = SNAP + '\n\n还有别的需要吗？';
  dec.push(frame(longer));
  const added = emits.text.filter((t) => t.endsWith('还有别的需要吗？'));
  assert.equal(added.length, 1, '真新增后缀必须 emit 1 次');
  assert.equal(emits.text.join(''), longer, '拼接结果应为完整原文');
});

test('GLM 工具轮：非工具场景的纯累积文本交错重发不得放大', () => {
  const { dec, emits } = makeDecoder();
  dec.push(frame('你好'));
  dec.push(frame('你好，世界'));   // 增长 → 只补发「，世界」
  dec.push(frame('你好，世界'));   // 重复 → 跳过（累积快照）
  assert.equal(emits.text.join(''), '你好，世界', '累积流不得重复放大');
});