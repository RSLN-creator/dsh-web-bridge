// marker-typo.test.mjs — 标记**词形畸变**的处置（0.16.4 建立宽容；0.16.23 起退役钉子）。
//
// ## 历史与现状（先读这个再动本文件）
//
// 0.16.4：用户报「返回真实工具调用……调用工具的源文本出现在会话中」，真机会话
// 063b0a99 的 text 块里畸形标记（名字写成 DSH 而不是 DSML）出现 457 次——当时桥教
// 的是标准 DSML，模型漂成 DSH，解析层认不出 ⇒ 协议被当散文外发。那次的修法是
// 「解析层宽容 DSML/DSH/DS 全族词形」。
//
// 0.16.23：用户拍板「正式使用完全按照官方来，DSML 只备份」——DSML 词形链整体退役
// （备份见分支 backup/dsml-protocol），本文件从「宽容回归」翻转为**退役钉子**：
//   · 畸变词形（含标准 DSML 形态）一律 **0 条可执行调用**；
//   · 锚点必须仍然命中（transport=false）——扣住防泄漏，0 calls 走
//     TOOL_CALL_UNPARSED 自动再教官方格式；
//   · 反向安全线（散文示例、空/垃圾输入、截半块）逐字保留——它们防的是
//     「把不该执行的当执行」，与协议在役与否无关。
//
// 读数（历史取证，保留）：形态 A（标记少了尾部竖线 + 空格）26 次；形态 B（名字
// DSH + 空格）308 次；形态 C（缺空格）0 次——预案形态，写进夹具让判据可断。
//
// ## 夹具纪律（不变）
//
// 用 String.fromCharCode(0xFF5C) 现造标记字符，不在源码里内联全角标记字面量
// （DSH 会把 DSML 形的标记序列从工具参数里剥掉，内联字面量会截断/损坏文件）。
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

// ── ②③ 退役正向：畸变词形一律 0 条可执行调用 + 锚点扣留 ─────────────────────

test('② DSML 畸变词形退役：整份夹具 0 条可执行调用（0.16.23）', () => {
  assert.equal(PARSED.calls.length, 0,
    'DSML 形状退役后仍解出 ' + PARSED.calls.length + ' 条调用——宽容链没有删干净，'
    + '备份见分支 backup/dsml-protocol');
});

test('③ 退役后锚点必须仍命中且 transport=false（扣留 + UNPARSED 再教学接管）', () => {
  const probe = findProtocolStart(TEXT);
  assert.ok(probe.index >= 0,
    'findProtocolStart 认不出畸变标记（index=' + probe.index + '）：流式阶段协议会被当正文一路发出去，'
    + '退役 ≠ 撤哨——DSML 锚点是它唯一的防泄漏入口');
  assert.equal(probe.transport, false,
    '命中点被判成「待执行调用形态」：' + JSON.stringify(probe) + '——退役形状不得可执行');
  // 三种词形在原文里各出现一次，探测必须落在**第一块**而不是被散文带偏。
  const head = '<' + SHORT_TYPO_MARK + ' calls>';
  assert.equal(TEXT.slice(probe.index, probe.index + head.length), head,
    '探测落点不是第一块的开始：' + JSON.stringify(TEXT.slice(probe.index, probe.index + 24)));
});

test('④ 退役轮的 diagnostics 为空是**预期**：诊断在 index 层由 withheld>0 触发 UNPARSED', () => {
  // 旧宽容路径把「已知形态」压成无诊断；退役路径同样不产 diagnostics——
  // 恢复通知的触发条件是「锚点扣留 > 0 且 0 calls」（lib/index.js unparsedCallNotice）。
  assert.deepEqual(PARSED.diagnostics, []);
});

// ── ⑤ 对照：标准 DSML 形态同样退役 ──────────────────────────────────────────

test('⑤ 同一份内容换成标准 DSML 形态也必须 0 条（退役不分畸变与否）', () => {
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
  assert.equal(r.calls.length, 0, '标准 DSML 形态退役后仍被解析——宽容链没有删干净');
  assert.ok(findProtocolStart(strict).index >= 0, '标准形态同样必须被锚点扣住');
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
    + '）——把散文当调用执行会真的跑一条命令，比丢一条调用更坏');
});

test('⑥b 散文里插一条**真闭合**的畸变调用 → 退役后 0 条（扣留，不执行）', () => {
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
  assert.equal(r.calls.length, 0,
    '退役后的 DSML 调用被执行了：' + JSON.stringify(r.calls.map((c) => c.name)));
  assert.ok(findProtocolStart(prose).index >= 0, '真闭合的 DSML 块必须被锚点扣住');
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

test('⑧ 反向安全线：截到第一块中间时调用数必须为 0（半截协议不许执行）', () => {
  const cut = parseAgentReply(TEXT.slice(0, 200), { tools: TOOLS });
  assert.equal(cut.calls.length, 0,
    '截到 200 字符后解出 ' + cut.calls.length + ' 条调用——退役后 DSML 形状一条都不该执行');
});
