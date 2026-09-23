// auto-continue-notice.test.mjs — 0.19.3 护栏：自动续跑的**展示文案**。
//
// 用户诉求（原话）：「能够给他一行好看的 markdown 格式嘛？顺便区分和回复正文区别」。
//
// ## 为什么值得单独一条护栏
//
// 0.16.29 之后这条说明是界面上**唯一**的归因来源：再教学提示全文只走补发通道、
// 只落 reply-log，正文一个字都不铺。它此前散在八处各写一遍的裸文本，与模型正文
// 在视觉上无从区分——用户会把桥的进度说明读成模型的回答。改成 markdown 引用块
// 之后，有三条性质必须被钉住，否则改动会在别处以两种方式坏事：
//
//   ① **协议安全**：这段文案会作为助手正文外发，必须永远不被 `findProtocolStart`
//      当成调用边界、也不被 `parseAgentReply` 解析出任何调用。一旦它含了行首裸
//      `{`、`<tool_call` 或 ``` 围栏，桥会把自己的进度说明当调用去执行——
//      这是「把散文当调用执行」那条红线在展示层的同一形状。
//   ② **不许静默降级**：必须含字面量 `AUTO_CONTINUED`（既有两个测试文件靠它
//      判定「如实说明这是自动续跑」）；且不得含 `TOOL_CALL_UNPARSED`（0.16.29
//      用户指令「直接隐藏」）。
//   ③ **与事实一致**：`disabled` 支**不能**说「已自动补发提醒」——那一支根本没
//      补发（autoContinueRounds=0 或无会话键），说「已补发」是与事实相反的陈述。

import test from 'node:test';
import assert from 'node:assert/strict';
import { autoContinuedNotice } from '../lib/notices.js';
import { findProtocolStart, parseAgentReply } from '../lib/agent-preset.js';

/** 出口集合：有调用 / 无调用（继续收场）/ 无调用（最终答复）/ 补发通道不存在 /
 *  整会话累计超限后改用完整提醒（0.19.3「加整会话累计」）。 */
const EXITS = [
  { label: '有调用', v: { calls: 2 } },
  { label: '无调用·按最终答复收场', v: { calls: 0, final: true } },
  { label: '无调用·继续收场', v: { calls: 0 } },
  { label: '补发通道不存在', v: { disabled: true } },
  { label: '升级为完整提醒·无调用', v: { calls: 0, cumulative: 4, complete: true, after: 3 } },
  { label: '升级为完整提醒·有调用', v: { calls: 2, cumulative: 9, complete: true, after: 3 } },
];

test('① 四个出口全部协议安全：findProtocolStart 恒 -1、解析出 0 条调用', () => {
  for (const { label, v } of EXITS) {
    const text = autoContinuedNotice(v);
    const { index } = findProtocolStart(text);
    assert.equal(index, -1, `${label}：不得出现协议边界（否则桥会把自己的进度说明当调用执行）`);
    assert.equal(parseAgentReply(text).calls.length, 0, `${label}：不得解析出任何调用`);
  }
});

test('② 不许静默降级：含 AUTO_CONTINUED、不含 TOOL_CALL_UNPARSED', () => {
  for (const { label, v } of EXITS) {
    const text = autoContinuedNotice(v);
    assert.match(text, /AUTO_CONTINUED/, `${label}：必须如实说明这是自动续跑`);
    assert.ok(!/TOOL_CALL_UNPARSED/.test(text), `${label}：再教学提示全文不得出现在展示文案里（0.16.29 用户指令）`);
  }
});

test('③ 与事实一致：disabled 支不说「已自动补发提醒」', () => {
  const disabled = autoContinuedNotice({ disabled: true });
  assert.ok(!/已自动补发提醒/.test(disabled),
    'disabled 支根本没补发，说「已补发」是与事实相反的陈述（doc/comment-style.md §2.5 不假装成功）');
  const sent = autoContinuedNotice({ calls: 0 });
  assert.match(sent, /已自动补发提醒/, '真的补发了才可以说「已自动补发提醒」');
});

test('④ 形态：markdown 引用块 + 加粗标记（与正文视觉分层）', () => {
  for (const { label, v } of EXITS) {
    const text = autoContinuedNotice(v);
    assert.match(text, /^> \*\*AUTO_CONTINUED\*\*/, `${label}：必须以引用块 + 加粗标记开头`);
    // 至少两行引用块：标题行 + 说明行。单行会让「侧条」退化成一个普通段落。
    assert.ok(text.split('\n').length >= 2, `${label}：引用块必须含标题行与说明行`);
    assert.ok(text.split('\n').every((l) => l.startsWith('> ')), `${label}：引用块每一行都要带 '> ' 前缀`);
  }
});

test('⑤ 条数如实透出：有调用时报出准确条数', () => {
  assert.match(autoContinuedNotice({ calls: 3 }), /\*\*3\*\* 条调用/);
  assert.match(autoContinuedNotice({ calls: 1 }), /\*\*1\*\* 条调用/);
  // 负数/非法值收敛到 0，不得渲染出「-1 条调用」这种读数。
  assert.match(autoContinuedNotice({ calls: -5 }), /仍未发起可执行调用/);
  assert.match(autoContinuedNotice({ calls: 'x' }), /仍未发起可执行调用/);
});

test('⑥ 升级形态必说三件事：第几次、已改用完整提醒、**没有停手**', () => {
  const text = autoContinuedNotice({ calls: 0, cumulative: 4, complete: true, after: 3 });
  assert.match(text, /累计补发 \*\*4\*\* 次/, '「整会话累计」这个读数必须出现在界面上（用户要的就是它）');
  assert.match(text, /超过升级点 3 次/, '升级点 N 必须如实写出来，否则「为什么这轮变了」无从归因');
  assert.match(text, /完整提醒/, '形态切换必须被点名');
  // 用户原话「不能停！继续后续需要 auto！！」——文案若暗示桥收手，就是与事实相反。
  assert.match(text, /不停手|照常继续/, '必须明说自动续跑继续，不得让人读成「桥放弃了」');
});

test('⑦ 未升级 / disabled 支不得出现升级文案（与事实一致）', () => {
  for (const v of [{ calls: 2 }, { calls: 0, cumulative: 9 }, { disabled: true, cumulative: 9, complete: true }]) {
    const text = autoContinuedNotice(v);
    assert.ok(!/完整提醒/.test(text), `未升级或通道不存在的出口不得说「完整提醒」：${JSON.stringify(v)}`);
  }
});
