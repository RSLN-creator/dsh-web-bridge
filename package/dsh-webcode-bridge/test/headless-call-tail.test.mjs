// headless-call-tail.test.mjs — 「无头调用残片」泄漏回归（真机 2026-09-26 session-c20f43e9）。
//
// ## 真机症状
//
// GLM 会话的 assistant/message 里，两条完整调用之间夹着 364 字符的正文块：
//
//     "\n\nname\":\"pwsh\",\"purpose\":\"查看 git 状态、远程仓库、标签与最近提交\",
//      \"arguments\":{\"command\":\"git status; …\",\"workdir\":\"D:\\9_Code_Workspace\\dsh-webcode-bridge"
//
// 即：网页流重传调用时把 JSON 头 `{"mcp_action": "call", ` 吃掉，剩下的「尾巴」被
// 当正文逐字发进会话（reply-log 2026-09-26T06:27:40Z 逐字可查）。完整的 pwsh 调用
// 随后在重传快照里照常到达并执行，所以残片是垃圾、不是调用。
//
// ## 为什么既有防线全都没拦
//
// 残片没有围栏、没有 `<tool_call>` 标签、没有行首裸 `{`——`findProtocolStart` 对它
// 返回 -1；`partialProtocolAt` 只认标签/围栏半成品；`unresolvedCallFenceAt` 认的是
// 落单反引号。于是它一路落到「正文」里。
//
// ## 修法（只收窄、绝不放宽）
//
// `headlessCallTailAt`：残片是「JSON 对象尾巴」——键的开引号可被吃（`name":` 或
// `"name":`）、值可以是未闭合的字符串/对象、链尾允许逗号+半成品键。语法里没有
// mcp_action（讨论完整调用形状的散文带它，到第一个键就放行）；任何散文字符让语法
// 失配 → 立即放行。接线三处：流式外发上限（lib/index.js）、权威散文剔除
// （stripProtocolRegions）、安全终点（proseSafeEnd）。
//
// ## 本文件锁死的行为
//
//   ① 纯函数：真机残片两种引号形态必命中；完整调用/散文对照必不命中；
//   ② 流式逐字符：残片**每个中间态**都扣得住（没有「放行一瞬」）；
//   ③ E2E（真实 adapter.stream）：整段/快照切分/逐字符三种到达方式，正文零泄漏，
//      调用照常解析执行；
//   ④ 散文对照：讨论协议形状的正文一字不扣、照常流式外发。
//
// ## 诚实边界
//
// 逐字符到达 + **配平收尾**（残片以 `}}` 完整闭合）的形态不在 ③ 覆盖内：残片闭合后
// 到达的第一个反引号会让语法失配放行（无法把「已闭合残片」与「后面的半成品围栏」
// 区分开）。真机残片全部是**截断收尾**（reply-log 与三个会话实锤：结尾停在未闭合
// 字符串里），配平收尾只是理论形态——整段/快照切分两种真实到达方式下它同样被扣住
// 并随协议区间消化，只有逐字符人工驱动才会在围栏半成品窗口放行。

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { headlessCallTailAt, stripProtocolRegions, proseSafeEnd } from '../lib/agent-preset.js';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const TOOLS = [
  { name: 'read', description: 'r', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
  { name: 'pwsh', description: 'p', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' }, workdir: { type: 'string' } }, required: ['command', 'description'] } },
];
const call = (name, args) => '```json\n' + JSON.stringify({ mcp_action: 'call', name, arguments: args }) + '\n```\n\n';

// 与真机逐字同型的无头残片（reply-log 2026-09-26T06:27:40Z 的截取）：
const PWSH = { name: 'pwsh', purpose: '查看 git 状态、远程仓库、标签与最近提交', arguments: { command: "git status; Write-Host '--- remote ---'; git remote -v; git log --oneline -8", description: 'Show git status remotes tags and log', workdir: 'D:\\9_Code_Workspace\\dsh-webcode-bridge' } };
const frag = (obj, dangling = true) => {
  const json = JSON.stringify({ mcp_action: 'call', ...obj });
  const tail = json.slice(json.indexOf('"name"'));
  return '\n\n' + (dangling ? tail.slice(1) : tail);
};

async function run(reply, deltas = null, tools = TOOLS) {
  let adapter;
  const dispose = apply(
    { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null },
    {
      port: 0, requireConsent: false,
      driver: {
        status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
        sendTurn: async (key, prompt, opts) => { for (const piece of deltas ?? [reply]) opts.onDelta?.(piece); return { text: null }; },
        sendPrompt: async (prompt, opts) => { for (const piece of deltas ?? [reply]) opts.onDelta?.(piece); return { text: null }; },
      },
    },
  );
  try {
    const chunks = [];
    for await (const c of adapter.stream({ sessionId: 'headless-tail', model: 'deepseek:deepseek', tools, messages: [user('做事')] })) chunks.push(c);
    return chunks;
  } finally { await dispose(); }
}
const proseOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
const textBlocks = (chunks) => chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'text').map((c) => c.block.text);
const callBlocks = (chunks) => chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').map((c) => c.block);
const noFragment = (s) => !s.includes('name":') && !s.includes('"name"') && !s.includes('"purpose"') && !s.includes('mcp_action');

// ──────────────── ① 纯函数：真机残片命中 / 对照不命中 ────────────────

test('① 纯函数：真机残片（name": 与 "name": 两种引号形态）命中', () => {
  const a = frag(PWSH, true);
  const b = frag(PWSH, false);
  assert.ok(headlessCallTailAt(a, 0) >= 0, 'name": 残片必须命中');
  assert.ok(headlessCallTailAt(b, 0) >= 0, '"name": 残片必须命中');
  // 返回残片区域起点（含前导空白）；第一个非空白字符是 `n`（开引号被吃）。
  const at = headlessCallTailAt(a, 0);
  assert.ok(/^[ \t\r\n]*$/.test(a.slice(at, at + /^[ \t\r\n]*/.exec(a.slice(at))[0].length)), '起点之前只有空白');
  // 键被吃得更多（"purpose": 开头）同样命中。
  assert.ok(headlessCallTailAt('\n\n"purpose":"查看 git 状态","arguments":{"command":"git status"', 0) >= 0);
});

test('①b 纯函数：完整调用与散文对照不命中', () => {
  assert.equal(headlessCallTailAt('```json\n{"mcp_action":"call","name":"pwsh","purpose":"x","arguments":{"command":"git status"}}\n```', 0), -1, '完整调用是协议、不是残片');
  assert.equal(headlessCallTailAt('收到。接下来我会做三件事。', 0), -1, '普通散文');
  assert.equal(headlessCallTailAt('name it something useful', 0), -1, '以 name 开头的散文');
  assert.equal(headlessCallTailAt('"name": "pwsh" 是字段名，purpose 也一样', 0), -1, '引述键名的散文（值后跟散文）');
  assert.equal(headlessCallTailAt('"as I said before', 0), -1, '以引号开头的普通散文');
  assert.equal(headlessCallTailAt('not a fragment', 0), -1);
  assert.equal(headlessCallTailAt('name x', 0), -1, '前缀后跟散文 → 放行');
  // `name` 单独一个词是键前缀的瞬时态：流式里必须扣住（下一个字符可能是 `"`），
  // 但静态度量上它尚未成为残片——这里只断言「不误报为已确认残片」没有意义，
  // 扣留是设计行为（见 ①c 的逐字符锁死）。
  assert.equal(headlessCallTailAt('name', 0), 0, '孤立键前缀 → 瞬时扣留');
});

test('①c 纯函数：逐字符中间态每个都扣得住（无「放行一瞬」）', () => {
  const full = frag(PWSH, true);
  // 从残片第一个非空白字符起逐个前缀：每个中间态都必须扣住。
  const start = /^[ \t\r\n]*/.exec(full)[0].length;
  for (let i = start + 1; i <= full.length; i++) {
    const slice = full.slice(0, i);
    const at = headlessCallTailAt(slice, 0);
    assert.ok(at >= 0, `len=${i} 必须扣住，slice=${JSON.stringify(slice.slice(-12))}`);
  }
});

test('①d 纯函数：limit 边界——残片在扫描区之外不命中', () => {
  const full = frag(PWSH, true);
  const start = headlessCallTailAt(full, 0);
  assert.equal(headlessCallTailAt(full, 0, start), -1, '扫描上界在残片起点时不可见');
  assert.ok(headlessCallTailAt(full, 0, start + 10) >= 0, '扫描上界越过残片起点后可见');
});

// ──────────────── ② stripProtocolRegions / proseSafeEnd ────────────────

test('② 权威散文剔除：残片随协议区间一起被挖掉，两侧散文保留', () => {
  const reply = '先做两件事。\n\n' + call('read', { file_path: 'a.md' }) + frag(PWSH, true)
    + call('read', { file_path: 'b.md' }) + '\n\n然后收尾。';
  const clean = stripProtocolRegions(reply);
  assert.ok(!clean.includes('name":'), '残片不得留在散文里，实际=' + JSON.stringify(clean));
  assert.ok(!clean.includes('mcp_action'), '协议 JSON 不得留在散文里');
  assert.ok(clean.includes('先做两件事。'), '残片之前的散文必须保留');
  assert.ok(clean.includes('然后收尾。'), '残片之后的散文必须保留');
});

test('②b 安全终点：正文最远发到残片之前', () => {
  const reply = '先做。\n\n' + call('read', { file_path: 'a.md' }) + frag(PWSH, true);
  const safe = proseSafeEnd(reply, 0);
  assert.ok(safe < reply.indexOf('name":'), '安全终点必须在残片起点之前，实际 safe=' + safe);
  assert.ok(reply.slice(0, safe).includes('先做。'), '残片之前的散文照常可达');
});

// ──────────────── ③ E2E：真机形状三种到达方式，正文零泄漏 ────────────────

const PROD_REPLY = () => call('read', { file_path: 'D:\\9_Code_Workspace\\dsh-webcode-bridge\\package.json' })
  + frag(PWSH, true).slice(0, -3)   // 真机形态：截断收尾（workdir 未闭合，无 `}}`）
  + call('read', { file_path: 'D:\\9_Code_Workspace\\dsh-webcode-bridge\\package.json' })
  + call('pwsh', PWSH.arguments)
  + call('read', { file_path: 'D:\\9_Code_Workspace\\dsh-webcode-bridge\\package.json' })
  + call('pwsh', PWSH.arguments);

// 三种到达方式：整段一次（终块路径）、快照切分（残片独立成段，真机形态）、逐字符。
const SPLIT_SCHEMES = () => {
  const reply = PROD_REPLY();
  const FRAG = frag(PWSH, true).slice(0, -3);
  const B = reply.indexOf(FRAG);
  const fragEnd = reply.indexOf('```json', B);
  return [
    ['整段一次到达', [reply]],
    ['快照切分（残片独立成段）', [reply.slice(0, B), reply.slice(B, fragEnd), reply.slice(fragEnd)]],
    ['逐字符', [...reply]],
  ];
};

for (const [label, deltas] of SPLIT_SCHEMES()) {
  test(`③ E2E ${label}：正文零泄漏、调用照常解析执行`, async () => {
    const chunks = await run(PROD_REPLY(), deltas);
    const prose = proseOf(chunks);
    assert.ok(noFragment(prose), '正文不得含残片，实际=' + JSON.stringify(prose.slice(0, 200)));
    for (const b of textBlocks(chunks)) {
      assert.ok(noFragment(b), '正文块不得含残片，实际=' + JSON.stringify(b.slice(0, 200)));
    }
    const calls = callBlocks(chunks);
    const pwshCalls = calls.filter((c) => c.name === 'pwsh');
    assert.ok(pwshCalls.length >= 1, 'pwsh 调用必须执行');
    assert.ok(pwshCalls.some((c) => JSON.parse(c.arguments).command.includes('git status')), 'pwsh 参数完整（command 含 git status）');
    assert.ok(calls.some((c) => c.name === 'read'), 'read 调用必须执行');
    assert.equal(chunks.at(-1).reason?.kind, 'tool-calls', '收尾必须是 tool-calls');
  });
}

// ──────────────── ④ E2E 散文对照：一字不扣 ────────────────

test('④ E2E 散文对照：讨论协议形状的正文照常流式外发', async () => {
  const reply = '讨论格式：字段 name 是工具名，purpose 是原因。完整形状是 `{"mcp_action": "call", "name": "read", "purpose": "读文件", "arguments": {"file_path": "a.md"}}`。\n\n另外，`"name": "pwsh"` 这种引用只是举例，不是调用。';
  const chunks = await run(reply, [reply]);
  const prose = proseOf(chunks);
  assert.ok(prose.includes('字段 name 是工具名'), '散文必须完整外发');
  assert.ok(prose.includes('mcp_action'), '讨论完整形状的散文不得被扣');
  assert.ok(prose.includes('这种引用只是举例'), '散文尾部必须外发');
  assert.equal(callBlocks(chunks).length, 0, '散文里的引述不得被当成调用执行');
});

test('④b E2E 散文对照：以引号键名开头的回复完整外发', async () => {
  const reply = '"name": "pwsh" 这样的写法是残缺片段，我不会用它。';
  const chunks = await run(reply, [...reply]);
  const prose = proseOf(chunks);
  assert.ok(prose.includes('"name": "pwsh"'), '引述键名的回复不得被扣，实际=' + JSON.stringify(prose));
});
