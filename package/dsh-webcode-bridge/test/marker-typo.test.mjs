// marker-typo.test.mjs — 标记**词形畸变**（写成 DSH 而不是 DSML）必须仍解得出调用（0.16.4）。
//
// ## 用户症状与真机读数（每一条都可复核）
//
// 用户原话：「返回真实工具调用……调用工具的源文本出现在会话中」——界面上同时出现
// 「工具真的被调了」与「正文里夹着协议原文」。真机取证（本轮，不是推测）：
//
//   · 解 `~/.dsh/sessions/…session-063b0a99…` 的帧后，畸形标记（名字写成 DSH 而不是
//     DSML）出现 **457 次**，而正确形态只有个位数；
//   · 桥**教的是对的**：`GET /__webcode/preset` 里是标准 DSML 标记（码点含 `44 53 4D 4C`）
//     ⇒ 这是**模型漂移**，不是桥的字符串 bug；
//   · 后果链：`normalizeDsml` 只剥 DSML 族 ⇒ 畸形标记原样留下（用户看到的「源文本出现在
//     会话中」），`findProtocolStart` 也认不出 ⇒ 整段协议被当散文外发，收尾靠 invoke 兜底
//     才救回调用（63 个调用仍执行了）——所以症状是「工具调了、正文却夹着源码」。
//
// 原始字节的取法（本夹具的词形就是这么数出来的，任何人在同一份 dump 上都能重跑）：
// 用 `String.fromCharCode(0xFF5C)` 现造标记字符，在 `.tmp/063b-full.jsonl`（该会话的逐帧
// 解码 dump）上逐次 `indexOf` 计数——刻意不用正则，免得再次踩「转义把码位弄错」的坑。
//
// 读数：形态 A（标记少了尾部两条竖线 + 空格）**26 次**；形态 B（标记完整、名字是 DSH + 空格）
// **308 次**；形态 C（标记与标签名之间**缺空格**）**0 次**；标准形态 **2 次**。形态 C 在真机
// dump 里一次都没出现，它是**预案形态**——写进夹具是为了让「缺空格」这条宽容度也有判据，
// 不是因为真机发生过（不许把构造说成取证）。
//
// ## 保守判据（宽容的边界，实现里也按它写）
//
// 只对「标记 + 已知标签名（calls/invoke/parameter/tool_call/function…）」动手。散文里
// 裸写的 `<calls>` / `<invoke name="x">` 示例**不得**被改写或被当成调用——宁可少救，
// 不可错认：把散文当调用执行会真的跑一条命令，比丢一条调用更坏。
//
// ## 反向验证纪律（doc/comment-style.md §9.3）
//
// ②③④ 是正向判据（三种词形各解出一条同名同参调用、diagnostics 为空）；⑤ 是「标准形态
// 仍然照解」的对照；⑥⑦⑧⑨ 是反向安全线：散文示例、散文 + 一条真闭合调用、空白/垃圾输入、
// 截半的块都必须落在「不许多认」这一侧。把词形宽容回滚成只认 DSML 时，②③ 必须变红
// （等价实验记录在报告里，工作区 lib/ 不留改动）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseAgentReply, findProtocolStart } from '../lib/agent-preset.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'marker-typo-dsh-calls.txt');

/** U+FF5C：标记的构成字符（全角竖线形）。用码位现造，源码里不出现该字符本身。 */
const BAR = String.fromCharCode(0xFF5C);
/** 标准标记。 */
const MARK = BAR + BAR + 'DSML' + BAR + BAR;
/** 畸变标记：名字写成 DSH。 */
const TYPO_MARK = BAR + BAR + 'DSH' + BAR + BAR;
/** 畸变标记的「少尾部竖线」形态。 */
const SHORT_TYPO_MARK = BAR + BAR + 'DSH';

/** 本会话真实下发的工具表（形状判据要用真实 schema，只给名字会让反推类判据失效）。 */
const TOOLS = [
  { name: 'read', parameters: { type: 'object', properties: { file_path: {}, offset: {}, limit: {} }, required: ['file_path'] } },
  { name: 'grep', parameters: { type: 'object', properties: { pattern: {}, path: {}, include: {} }, required: ['pattern'] } },
  { name: 'pwsh', parameters: { type: 'object', properties: { command: {}, description: {}, workdir: {} }, required: ['command', 'description'] } },
];

/** 夹具原文（LF 口径：真机回复来自 JSON，本机 `core.autocrlf=true` 可能换行尾）。 */
function readFixture() {
  return fs.readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n');
}

const TEXT = readFixture();
const PARSED = parseAgentReply(TEXT, { tools: TOOLS });

/** 把调用参数摊平成文本，供「散文有没有漏进参数」这类断言使用。 */
function argsText(call) {
  return JSON.stringify(call.arguments ?? {});
}

// ── ① 夹具形状：三种畸变词形各在夹具里出现过，且标记是码位现造的那两个 ──────────

test('① 夹具含三种畸变词形，且标记字符是 U+FF5C（不是半角竖线）', () => {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  assert.ok(!raw.startsWith('\uFEFF'), '夹具带 BOM：真机回复没有 BOM，BOM 会改变首个码点');
  for (const [label, needle] of [
    ['形态 A（少了尾部竖线）', '<' + SHORT_TYPO_MARK + ' calls>'],
    ['形态 B（名字是 DSH）', '<' + TYPO_MARK + ' invoke name="grep">'],
    ['形态 C（标记与标签名之间缺空格）', '<' + TYPO_MARK + 'invoke name="pwsh">'],
  ]) {
    assert.ok(TEXT.includes(needle), label + ' 不在夹具里：夹具被改写成别的形状了（' + needle + '）');
  }
  // 半角竖线组成的假标记必须一个都没有：那会让「宽容」与「认错」无法区分。
  assert.ok(!TEXT.includes('||DSH') && !TEXT.includes('||DSML'),
    '夹具里出现了半角竖线拼的假标记：真机标记是 U+FF5C，半角竖线是另一回事');
});

// ── ②③④ 正向：三种词形各解出一条同名同参调用 ────────────────────────────────

test('② 三种畸变词形各解出一条调用，顺序 read / grep / pwsh', () => {
  assert.equal(PARSED.calls.length, 3,
    '三种畸变词形解出 ' + PARSED.calls.length + ' 条调用（应为 3）——'
    + '这正是用户看到的「调用工具的源文本出现在会话中」：标记认不出 ⇒ 协议被当散文。'
    + ' diagnostics=' + JSON.stringify(PARSED.diagnostics));
  assert.deepEqual(PARSED.calls.map((c) => c.name), ['read', 'grep', 'pwsh'],
    '三条调用的顺序/名字不是 read → grep → pwsh');
});

test('③ 参数逐字相等（形态 A/B/C 各一条，互相不得串味）', () => {
  const [read, grep, pwsh] = PARSED.calls;
  assert.deepEqual(read.arguments, { file_path: 'doc/progress.md' },
    '形态 A 的 read 参数与夹具不再逐字相等');
  assert.deepEqual(grep.arguments, { pattern: 'block-end', path: 'package/dsh-webcode-bridge/lib' },
    '形态 B 的 grep 参数与夹具不再逐字相等');
  assert.deepEqual(pwsh.arguments, { command: 'Get-Date -Format o', description: 'Read the current local time' },
    '形态 C（缺空格）的 pwsh 参数与夹具不再逐字相等');
});

test('④ diagnostics 必须为空数组（畸变词形是**已知形态**，不该被记成「需要救」）', () => {
  assert.deepEqual(PARSED.diagnostics, [],
    '夹具被记下了 diagnostics：' + JSON.stringify(PARSED.diagnostics)
    + ' —— 三种词形都是本轮明确要宽容的形态，出现 diagnostics 说明宽容路径只是「碰巧解出来」');
});

// ── ⑤ 对照：把标记换成标准形态，同样必须解出这三条 ────────────────────────────

test('⑤ 同一份内容换成标准 DSML 形态仍解出三条（宽容是额外的，不是替代）', () => {
  const strict = TEXT
    // 形态 A 的标准写法（标记补全尾部竖线）
    .split('<' + SHORT_TYPO_MARK + ' calls>').join('<' + MARK + ' calls>')
    .split('</' + SHORT_TYPO_MARK + ' calls>').join('</' + MARK + ' calls>')
    .split('<' + SHORT_TYPO_MARK + ' invoke').join('<' + MARK + ' invoke')
    .split('</' + SHORT_TYPO_MARK + ' invoke>').join('</' + MARK + ' invoke>')
    .split('<' + SHORT_TYPO_MARK + ' parameter').join('<' + MARK + ' parameter')
    .split('</' + SHORT_TYPO_MARK + ' parameter>').join('</' + MARK + ' parameter>')
    // 形态 B/C 的标准写法：标记换成 DSML，形态 C 还补回缺掉的空格
    .split('<' + TYPO_MARK + ' ').join('<' + MARK + ' ')
    .split('</' + TYPO_MARK + ' ').join('</' + MARK + ' ')
    .split('<' + TYPO_MARK).join('<' + MARK + ' ')
    .split('</' + TYPO_MARK).join('</' + MARK + ' ');
  assert.ok(!strict.includes('DSH'), '对照文本里还残留 DSH 标记：替换没覆盖全，这条对照就失去意义');
  const r = parseAgentReply(strict, { tools: TOOLS });
  assert.deepEqual(r.calls.map((c) => c.name), ['read', 'grep', 'pwsh'],
    '标准形态解出的调用与畸变形态不同——说明宽容路径把标准路径改坏了');
  assert.deepEqual(r.diagnostics, [], '标准形态产生了 diagnostics：' + JSON.stringify(r.diagnostics));
});

// ── ⑥ 反向安全线：散文里的裸标签示例不得被当成调用 ────────────────────────────

test('⑥ 反向安全线：散文里的裸 calls / invoke 示例 → 0 条调用', () => {
  // 判据写清：示例里的 invoke 起标签**没有闭合**，calls 也没有闭合，
  // 因此「真正闭合的那条」一条都不存在 ⇒ 正确读数是 0 条。
  const prose = [
    '格式说明（这是散文，不是调用）：最外层写成 <calls>，',
    '每条调用写成 <invoke name="x">，参数写成 <parameter name="y" string="true">值</parameter>。',
    '以上只是讲解，我没有真的要调任何工具。',
  ].join('\n');
  const r = parseAgentReply(prose, { tools: TOOLS });
  assert.equal(r.calls.length, 0,
    '散文里的标签示例被当成调用了（' + r.calls.length + ' 条：' + JSON.stringify(r.calls.map((c) => c.name))
    + '）——宽容词形若连裸标签一起改，就会真的去执行一条命令');
});

test('⑥b 散文里插一条**真闭合**的畸变调用 → 只解出那一条，散文不进口参数', () => {
  const prose = [
    '下面是唯一一条真调用，其余都是说明文字。',
    '<' + TYPO_MARK + ' calls>',
    '<' + TYPO_MARK + ' invoke name="read">',
    '<' + TYPO_MARK + ' parameter name="file_path" string="true">lib/index.js</' + TYPO_MARK + ' parameter>',
    '</' + TYPO_MARK + ' invoke>',
    '</' + TYPO_MARK + ' calls>',
    '这一行是结尾散文，不是调用。',
  ].join('\n');
  const r = parseAgentReply(prose, { tools: TOOLS });
  assert.deepEqual(r.calls.map((c) => c.name), ['read'],
    '真闭合的那一条没有（或没有只）被解出来：' + JSON.stringify(r.calls.map((c) => c.name)));
  assert.ok(!/说明文字|结尾散文/.test(argsText(r.calls[0])),
    '散文被塞进了调用参数：' + argsText(r.calls[0]));
});

// ── ⑦ 反向安全线：空/垃圾输入不抛错、不给调用 ────────────────────────────────

test('⑦ 反向安全线：空串 / undefined / 纯空白 / 只有标记没有调用 → 0 条且不抛错', () => {
  const cases = [
    ['空字符串', ''],
    ['undefined', undefined],
    ['纯空白', '   \n\t  '],
    ['只有标记没有调用', '<' + TYPO_MARK + ' calls>\n</' + TYPO_MARK + ' calls>'],
  ];
  for (const [label, input] of cases) {
    let r;
    assert.doesNotThrow(() => { r = parseAgentReply(input, { tools: TOOLS }); }, label + ' 让解析抛错了');
    assert.equal(r.calls.length, 0, label + ' 解出了调用（应为 0 条）：' + JSON.stringify(r.calls));
  }
});

// ── ⑧ 反向安全线：截半的调用块不得凭空拼成完整调用 ────────────────────────────

test('⑧ 反向安全线：截到第一块中间时调用数 < 3（半截协议不许执行）', () => {
  const cut = parseAgentReply(TEXT.slice(0, 200), { tools: TOOLS });
  assert.ok(cut.calls.length < 3,
    '截到 200 字符后解出 ' + cut.calls.length + ' 条调用——半截的协议被拼成了完整调用');
});

// ── ⑨ 探测与解析同源：畸形标记必须被 findProtocolStart 认成协议起点 ──────────

test('⑨ findProtocolStart 必须认得出畸变标记（否则流式阶段就会把协议当正文外发）', () => {
  const probe = findProtocolStart(TEXT);
  assert.ok(probe.index >= 0,
    'findProtocolStart 认不出畸变标记（index=' + probe.index + '）：流式阶段协议会被当正文一路发出去，'
    + '这正是用户看到的「源文本出现在会话中」的机制');
  assert.equal(probe.transport, true, '命中点没有被判成「待执行调用形态」：' + JSON.stringify(probe));
  // 三种词形在原文里各出现一次，探测必须落在**第一块**而不是被散文带偏。
  const head = '<' + SHORT_TYPO_MARK + ' calls>';
  assert.equal(TEXT.slice(probe.index, probe.index + head.length), head,
    '探测落点不是第一块的开始：' + JSON.stringify(TEXT.slice(probe.index, probe.index + 24)));
});
