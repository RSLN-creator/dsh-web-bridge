// dsml-real-reply-regression.test.mjs — 真机夹具 14：网页原话（1204 字符）→ 3 条调用（0.16.3）。
//
// ## 为什么单独钉这一份夹具（它是用户原话的直接物证）
//
// 用户原话：「用 bridegege 怎么总是现在返回真实工具调用说正文没有返回？之前让你看了
// 你说是没有返回，但是我看 web 是真实有的啊！你可以去看网页端真实对话回复」。
//
// 「web 是真实有的」是**字面为真**。取法（桥自己的只读控制面，不改网页、不重发）：
//
//   POST http://127.0.0.1:8931/__webcode/history
//   body: {"sessionId":"971db3e8-7ea6-4f63-ad41-c14bb44a6d27"}
//
// 该会话的 assistant 消息 **1204 字符**，逐字落成
// test/fixtures/dsml-real-14-step5-grep-pwsh.txt。0.16.2 的 parseAgentReply 对它的读数是
// **calls=3**（grep / pwsh / pwsh）、diagnostics 为空——问题 1「真实工具调用被丢」在这一份
// 物证上已经修好。本文件把这组读数钉死，让「有一天它又变回 0 条」变成红灯。
//
// ## 与前 13 份夹具的分工（刻意不重复）
//
// dsml-native-close.test.mjs 钉的是**旧代码解不出来**的两族畸形（无名闭合 `</>`、漏写
// invoke 开标签）。本份是**正常形态**：标签具名、闭合完整——它回归的是「这条真机回复本身」，
// 也就是用户在网页上看到的那三条调用。畸形族的覆盖仍在那份文件里，本文件不重复。
//
// ## 读数的来源口径（写进注释的数字必须可核对，doc/comment-style.md §5）
//
//   · 1204 字符 —— UTF-8 文件的字符数（不是字节数；该文件 1380 字节、无 BOM、行尾 LF）。
//   · calls=3 / diagnostics=[] —— node 里直接 parseAgentReply(夹具原文) 的返回值，见 ②③④。
//   · 首 12 个码点 —— 0x3C 0xFF5C 0xFF5C 0x44 0x53 0x4D 0x4C 0xFF5C 0xFF5C 0x20 0x63 0x61，
//     即 `<` + U+FF5C×2 + DSML + U+FF5C×2 + ` ca`。码位以**现造**的方式写进断言
//     （String.fromCharCode(0xFF5C)），源码里不出现该字符本身——否则这个文件自己就分不清
//     「标记字符」与「一个长得像标记的普通竖线」。
//
// ## 反向验证纪律（doc/comment-style.md §9.3）
//
// ②③④⑤ 是正向判据：夹具必须解出 3 条调用、参数逐字相等、无 diagnostics、探测与解析不分叉。
// ⑥⑦⑧ 是**反向安全线**：截断、畸形闭合、追加散文都**不许多出**调用（把散文当调用执行是
// 比丢调用更坏的错）；⑨ 是垃圾输入不许抛错。回滚 DSML 归一化（等价实验记录在报告里）时
// ②③ 必须变红——这是本文件存在的意义。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseAgentReply, findProtocolStart, proseSafeEnd } from '../lib/agent-preset.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'dsml-real-14-step5-grep-pwsh.txt');

/** 真机字节的 sha256（LF 口径）：夹具是冻结物证，内容被改写必须是有意为之且要改这里。 */
const FIXTURE_SHA256 = '9357106b92ab71a4519309760a7d43b74cbddca68bc28fd6dd2f65b74e93fdfe';

/**
 * 本会话真实下发的工具表：形状判据（inferToolNameFromArgs）要用真实 schema，
 * 只给名字会让「按参数形状反推」这类判据在测试里失效。
 */
const TOOLS = [
  { name: 'grep', parameters: { type: 'object', properties: { pattern: {}, path: {}, include: {} }, required: ['pattern'] } },
  { name: 'glob', parameters: { type: 'object', properties: { pattern: {}, path: {} }, required: ['pattern'] } },
  { name: 'pwsh', parameters: { type: 'object', properties: { command: {}, description: {}, workdir: {} }, required: ['command', 'description'] } },
  { name: 'read', parameters: { type: 'object', properties: { file_path: {}, offset: {}, limit: {} }, required: ['file_path'] } },
];

/**
 * 读夹具并统一成 LF 口径。
 *
 * 为什么归一化行尾：本机 `git config core.autocrlf=true`，这批夹具入库后在不同检出上可能
 * 变成 CRLF。真机回复来自 JSON（LF），「1204 字符」这个读数也是 LF 口径；把行尾归一化再
 * 断言，才能让「字符数不符」只意味着**内容被改过**，而不是「这台机器的 git 配置不同」。
 * 解析路径则两种行尾都覆盖（⑨b 单独钉 CRLF）。
 */
function readFixture() {
  return fs.readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n');
}

/** U+FF5C：DSML 标记的构成字符（全角竖线形）。用码位现造，源码里不出现该字符。 */
const BAR = String.fromCharCode(0xFF5C);
const DSML = BAR + BAR + 'DSML' + BAR + BAR;

const FIXTURE_TEXT = readFixture();
const PARSED = parseAgentReply(FIXTURE_TEXT, { tools: TOOLS });

/** 散文哨兵：⑧ 用它断言「追加的散文没有变成第四条调用」。 */
const PROSE = '\n\n上面三条调用已经发出，下一轮我会核对结果并汇报。这段是散文，没有协议标签。';
const PROSE_SENTINEL = '下一轮我会核对结果并汇报';

/** 把调用的参数摊平成一段文本，供「散文有没有漏进参数」这类断言使用。 */
function argsText(call) {
  return JSON.stringify(call.arguments ?? {});
}

// ── ① 正向：夹具本身没有被改写（它是冻结的真机字节）─────────────────────────────

test('① 夹具是网页原话：1204 字符、无 BOM、首 12 码点固定、sha256 一致', () => {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  assert.ok(!raw.startsWith('\uFEFF'), '夹具带 BOM：真机回复没有 BOM，BOM 会连带毁掉首个码点判据');
  assert.equal(FIXTURE_TEXT.length, 1204,
    '夹具不再是 1204 字符的网页原话（实际 ' + FIXTURE_TEXT.length + ' 字符）——物证被改写过');
  const head = Array.from(FIXTURE_TEXT.slice(0, 12), (c) => c.codePointAt(0));
  assert.deepEqual(head,
    [0x3C, 0xFF5C, 0xFF5C, 0x44, 0x53, 0x4D, 0x4C, 0xFF5C, 0xFF5C, 0x20, 0x63, 0x61],
    '首 12 码点不再是 `<` + U+FF5C×2 + DSML + U+FF5C×2 + ` ca`'
    + '（实际 ' + head.map((c) => 'U+' + c.toString(16).toUpperCase()).join(' ') + '）'
    + '：夹具被改写，或标记字符被换成了别的码位');
  assert.ok(FIXTURE_TEXT.startsWith('<' + DSML + ' ca'),
    '夹具开头不是 DSML 调用块（`<` + 标记 + ` ca`）：真机原话的第一个字符就是协议起点');
  const hash = createHash('sha256').update(FIXTURE_TEXT, 'utf8').digest('hex');
  assert.equal(hash, FIXTURE_SHA256,
    '夹具内容变了（sha256 不符）：它是逐字冻结的真机物证，任何改写都必须是有意的');
});

// ── ②③④ 正向：这条真机回复必须解出 3 条可执行调用 ───────────────────────────

test('② calls=3，顺序 grep / pwsh / pwsh', () => {
  assert.equal(PARSED.calls.length, 3,
    '真机原话解出 ' + PARSED.calls.length + ' 条调用（应为 3）——' + '「网页明明给了真实调用」又丢了。'
    + ' diagnostics=' + JSON.stringify(PARSED.diagnostics));
  assert.deepEqual(PARSED.calls.map((c) => c.name), ['grep', 'pwsh', 'pwsh'],
    '三条调用的顺序/名字不再是 grep → pwsh → pwsh');
  assert.ok(PARSED.calls.every((c) => c.nameInferred !== true),
    '夹具里三个 invoke 都写了 name，不该有任何调用被标成「按参数形状反推」');
});

test('③ 逐字段断言参数（逐字相等，且没有多出来的键）', () => {
  const [grep, pwsh1, pwsh2] = PARSED.calls;

  assert.deepEqual(grep.arguments, {
    pattern: 'repairNamelessClosers|resolveNamelessClosers|dsml-repair',
    path: 'D:\\9_Code_Workspace\\dsh-webcode-bridge\\package\\dsh-webcode-bridge\\lib',
  }, '第 1 条 grep 的参数与网页原话不再逐字相等');

  assert.deepEqual(pwsh1.arguments, {
    command: 'node --test test/dsml-native-close.test.mjs 2>&1 | Select-Object -Last 40',
    description: 'Run DSML native-close regression tests',
    workdir: 'D:\\9_Code_Workspace\\dsh-webcode-bridge\\package\\dsh-webcode-bridge',
  }, '第 2 条 pwsh 的参数与网页原话不再逐字相等（注意 workdir 是真实参数，不是补出来的）');

  assert.deepEqual(pwsh2.arguments, {
    command: "$h='C:\\Users\\rsyhn\\.dsh'; Get-ChildItem \"$h\\local-link\" -Force -ErrorAction SilentlyContinue"
      + ' | Select-Object Mode,LastWriteTime,Name | Format-Table -AutoSize; Write-Output "---- settings.yaml ----";'
      + " Select-String -Path \"$h\\settings.yaml\" -Pattern 'webcode' -Context 2,2",
    description: 'Find how bridge plugin is installed',
  }, '第 3 条 pwsh 的参数与网页原话不再逐字相等（真机这条的 description 带 string="true"，'
    + '且**没有** workdir 参数——多出空键同样是漂移）');
});

test('④ diagnostics 必须为空数组（这条回复没有任何畸形需要救）', () => {
  assert.deepEqual(PARSED.diagnostics, [],
    '真机原话被记下了 diagnostics：' + JSON.stringify(PARSED.diagnostics)
    + ' —— 正常形态不该需要任何「修复」，出现 diagnostics 说明解析路径已经偏了');
});

// ── ⑤ 正向：探测与解析不得分叉（同一条回复上）────────────────────────────────

test('⑤ findProtocolStart 命中 0，且整段都是协议（正文外发长度为 0）', () => {
  const probe = findProtocolStart(FIXTURE_TEXT);
  assert.equal(probe.index, 0, '协议起点不在 0：这条回复开头就是调用块，不该有前导正文');
  assert.equal(probe.transport, true, '这条回复必须被判为「待执行调用形态」');
  // 用户抱怨的正是「说有工具调用、又说没有正文」：这条回复的正文长度本来就是 0，
  // 界面上的「没有返回」不是网页没给，而是这一段被扣留后没被解读成调用。
  assert.equal(proseSafeEnd(FIXTURE_TEXT, 0), 0,
    '正文外发长度不是 0：整段都是协议，任何字符外发都意味着协议残片漏进正文');
});

// ── ⑥ 反向安全线：截断不得凭空多出调用 ──────────────────────────────────────

test('⑥ 反向安全线：截断到前 400 字符时绝不出现 3 条调用（实测 1 条）', () => {
  const cut = parseAgentReply(FIXTURE_TEXT.slice(0, 400), { tools: TOOLS });
  assert.ok(cut.calls.length < 3,
    '截断到 400 字符后竟然解出 ' + cut.calls.length + ' 条调用——半截的协议被拼成了完整调用');
  // 400 字符处连第 2 条 invoke 都没开始，出现 pwsh 就意味着「把不完整的东西当调用执行」。
  assert.ok(!cut.calls.some((c) => c.name === 'pwsh'),
    '截断后出现了 pwsh 调用：不完整的调用体被执行了（网页上会真的跑一条残命令）');
});

test('⑥b 反向安全线：把结尾换成无名闭合，调用数不得增加', () => {
  const nameless = FIXTURE_TEXT
    .replace('</' + DSML + ' invoke>\n</' + DSML + ' calls>', '</>\n</>');
  const r = parseAgentReply(nameless, { tools: TOOLS });
  assert.ok(r.calls.length <= 3,
    '换成无名闭合后调用数变多了（' + r.calls.length + ' 条）——畸形形态不该凭空造出调用');
});

// ── ⑦ 反向安全线：追加的散文不得被当成第 4 条调用 ────────────────────────────

test('⑦ 反向安全线：结尾追加散文后仍是 3 条，散文不进任何参数', () => {
  const r = parseAgentReply(FIXTURE_TEXT + PROSE, { tools: TOOLS });
  assert.deepEqual(r.calls.map((c) => c.name), ['grep', 'pwsh', 'pwsh'],
    '追加散文后三条调用变了（' + JSON.stringify(r.calls.map((c) => c.name)) + '）');
  assert.ok(!r.calls.some((c) => argsText(c).includes(PROSE_SENTINEL)),
    '散文被当成参数塞进了某条调用——把散文当调用执行比丢调用更坏');
});

test('⑦b 反向安全线：散文插在最后一个 </invoke> 之后（调用块内部）也不得多出调用', () => {
  // 真机里没有这种形状，这是**对抗性输入**：用它证明「散文不会被当调用」不是靠位置侥幸。
  // 实测读数：这种放法下第 3 条调用被吞掉（calls=2，diagnostics 为空），即「丢调用」而不是
  // 「多调用」——所以安全线写成「不得多于 3 条」，多调用这一族才是本用例要防的方向。
  const at = FIXTURE_TEXT.lastIndexOf('</' + DSML + ' invoke>') + ('</' + DSML + ' invoke>').length;
  const r = parseAgentReply(FIXTURE_TEXT.slice(0, at) + PROSE + FIXTURE_TEXT.slice(at), { tools: TOOLS });
  assert.ok(r.calls.length <= 3,
    '调用块内部插入散文后调用数变成了 ' + r.calls.length + ' 条（不得多于 3 条）');
  assert.ok(!r.calls.some((c) => argsText(c).includes(PROSE_SENTINEL)),
    '插进调用块的散文被当成参数塞进了某条调用');
});

// ── ⑧ 反向安全线：空输入与纯散文必须是 0 条且不抛错 ──────────────────────────

test('⑧ 反向安全线：空文本 / 纯散文 / 空白 / undefined → 0 条调用、不抛错', () => {
  const cases = [
    ['空字符串', ''],
    ['undefined', undefined],
    ['纯空白', '   \n\t  '],
    ['纯散文', '我看了一下 index.js 的第 1500 行附近，等待统计写在那儿。\n\n结论：没问题。'],
  ];
  for (const [label, input] of cases) {
    let r;
    assert.doesNotThrow(() => { r = parseAgentReply(input, { tools: TOOLS }); }, label + ' 让解析抛错了');
    assert.equal(r.calls.length, 0, label + ' 解出了调用（应为 0 条）：' + JSON.stringify(r.calls));
  }
});

test('⑧b 反向安全线：CRLF 行尾不得改变判据（本机 git autocrlf=true，检出可能换行尾）', () => {
  const crlf = FIXTURE_TEXT.replace(/\n/g, '\r\n');
  const r = parseAgentReply(crlf, { tools: TOOLS });
  assert.deepEqual(r.calls.map((c) => c.name), ['grep', 'pwsh', 'pwsh'],
    'CRLF 版本解出的调用与 LF 版本不同——行尾会改变解析结果，说明某个判据对空白敏感');
  assert.deepEqual(r.diagnostics, [], 'CRLF 版本产生了 diagnostics：' + JSON.stringify(r.diagnostics));
});
