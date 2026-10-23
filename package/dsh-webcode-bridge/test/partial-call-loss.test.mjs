// partial-call-loss.test.mjs — #25 残余：**部分丢失**的调用必须被找回，且不得重复派发（0.19.74）。
//
// ## 本文件针对的真实缺陷
//
// 两个既有恢复点（lib/index.js 的 `withheld > 0 && !calls.length`）只在「一条调用都
// 没解析出来」时运行。于是这条形态被静默漏掉：
//
//   一轮回复里有 3 条调用 → 主解析拿到 2 条、丢了 1 条
//   ⇒ 恢复层不跑（因为 calls.length > 0）、UNPARSED 提示不发（同上）
//   ⇒ **那条调用凭空消失，用户与模型都收不到任何提示**（静默丢步骤）
//
// 离线实测（.tmp/probe-partial-loss.mjs）：修前派发 2/3 且正文零提示；修后 3/3。
//
// ## 为什么修法是「减法」而不是「追加」（本文件第二个必须钉住的点）
//
// `recoverUnparsedCalls` 读的是 DSML `<invoke>` 骨架，对主解析**已经成功拿到**的
// 调用同样会返回一份。实测（.tmp/probe-dedup2.mjs 用例 A/D）：纯 DSML 文本下主解析
// 得到 read+glob，恢复层**也**返回 read+glob。若把门放宽成「有扣留就跑」并直接
// 追加结果，同一个工具会被**派发两次**（重复副作用）。因此 `callsLostFromParse`
// 必须按「名+参数」做可消耗配对，只留主解析没覆盖到的。
//
// ② 就是这条反向安全线：把「减法」破坏成「直接追加」时它必须变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { callsLostFromParse } from '../lib/agent-preset.js';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

// 真实工具 schema（带 required）——第一版探针漏了 required，导致推断层过度匹配、读数失真。
const TOOLS = [
  { name: 'read', description: '读文件', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'glob', description: '找文件', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'grep', description: '搜索', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'pwsh', description: '跑命令', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];

function harness(reply) {
  let adapter;
  const prompts = [];
  const dispose = apply(
    { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null, settings: { get: () => ({ toolsEnabled: true }), set: () => {} } },
    {
      port: 0, requireConsent: false,
      driver: {
        status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
        sendTurn: (key, prompt, opts) => { prompts.push(String(prompt)); opts?.onDelta?.(reply); return Promise.resolve({ text: reply }); },
        sendPrompt: async (p, opts) => { opts?.onDelta?.(reply); return { text: reply }; },
      },
    },
  );
  return { dispose, prompts, getAdapter: () => adapter };
}

async function run(reply) {
  const { dispose, prompts, getAdapter } = harness(reply);
  const chunks = [];
  try {
    for await (const c of getAdapter().stream({
      sessionId: 'partial-loss-' + Math.random().toString(36).slice(2),
      model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('做三件事')],
    })) chunks.push(c);
  } finally { try { await dispose(); } catch {} }
  return {
    calls: chunks.filter((x) => x.type === 'block-end' && x.block?.type === 'tool-call').map((x) => x.block.name),
    shown: chunks.filter((x) => x.type === 'text-delta').map((x) => x.text).join(''),
    finish: chunks.find((x) => x.type === 'finish'),
    prompts,
  };
}

// ── ① 正向：3 条调用里丢 1 条（白名单只读 glob）必须被找回 ──────────────────

test('① 部分丢失：一轮 3 条调用、解析出 2 条 → 第 3 条（只读 glob）必须被恢复派发', async () => {
  const reply = [
    '先做三件事。',
    '<tool_call>{"mcp_action":"call","name":"read","arguments":{"file_path":"doc/progress.md"}}</tool_call>',
    '<tool_call>{"mcp_action":"call","name":"pwsh","arguments":{"command":"echo hi"}}</tool_call>',
    // 缺 name 的 DSML 形态：主解析拿不到，恢复层按参数形状可认（glob/grep 皆只读）
    '<invoke name=""><parameter name="pattern">TODO</parameter></invoke>',
  ].join('\n');
  const r = await run(reply);
  assert.equal(r.calls.length, 3, `3 条调用必须全部派发，实际 ${JSON.stringify(r.calls)}`);
  assert.ok(r.calls.includes('glob') || r.calls.includes('grep'), '丢失的那条只读调用必须被找回：' + JSON.stringify(r.calls));
  // 已解析的两条不得因恢复而消失或改名
  assert.ok(r.calls.includes('read') && r.calls.includes('pwsh'), '已解析的调用必须原样保留：' + JSON.stringify(r.calls));
});

// ── ② 反向安全线：不得因为恢复而重复派发同一个工具 ───────────────────────────

test('② 反向安全线：纯 DSML 两条完整调用 → 必须恰好各派发一次，不得被恢复层复制成两次', async () => {
  const reply = [
    '读两个文件。',
    '<invoke name="read"><parameter name="file_path">a.md</parameter></invoke>',
    '<invoke name="glob"><parameter name="pattern">*.md</parameter></invoke>',
  ].join('\n');
  const r = await run(reply);
  const count = (n) => r.calls.filter((x) => x === n).length;
  assert.equal(r.calls.length, 2, `必须恰好 2 条，实际 ${JSON.stringify(r.calls)}`);
  assert.equal(count('read'), 1, 'read 不得被重复派发：' + JSON.stringify(r.calls));
  assert.equal(count('glob'), 1, 'glob 不得被重复派发：' + JSON.stringify(r.calls));
});

// ── ③ 反向安全线：没有任何调用时，本修法不得凭空造出调用 ─────────────────────

test('③ 反向安全线：纯散文（零调用）→ 不得凭空派发任何调用', async () => {
  const r = await run('这轮只想说一句话，不调用任何工具。');
  assert.equal(r.calls.length, 0, '没有调用就不得造出调用：' + JSON.stringify(r.calls));
});

// ── ④ 白名单红线：写类工具不得经由这条路恢复 ─────────────────────────────────

test('④ 红线：缺 name 且参数指向写类（file_path+old_string+new_string）→ 不得被恢复派发', async () => {
  const reply = [
    '改一个文件。',
    '<tool_call>{"mcp_action":"call","name":"read","arguments":{"file_path":"a.md"}}</tool_call>',
    '<invoke name=""><parameter name="file_path">x.md</parameter>'
      + '<parameter name="old_string">a</parameter><parameter name="new_string">b</parameter></invoke>',
  ].join('\n');
  const r = await run(reply);
  assert.equal(r.calls.filter((x) => x === 'edit' || x === 'write').length, 0,
    '写类工具绝不得经由恢复层派发：' + JSON.stringify(r.calls));
});

// ── ⑤ 纯函数口径：减法按「名+参数」而不是「只比名字」────────────────────────

test('⑤ callsLostFromParse 按名+参数配对：同名**不同参数**不得互相抵消', () => {
  // 这是「只比名字」与「名+参数」唯一能分辨出来的形态（由变异 P3 反推得出）：
  //   主解析拿到 read(a.md)；恢复层只有 read(b.md)（a.md 那条此刻不可恢复）
  //   ⇒ b.md 是**真丢失**，必须留下。
  // 若判据退化成只比名字：pool 里 read 计数 1，read(b.md) 会被当成「已被主解析覆盖」
  // 而抵消掉 ⇒ 返回 0 条 ⇒ **真丢的那条调用静默消失**。第一版 ⑤ 写的是
  // 「parsed=[a.md]、recovered=[a.md, b.md]」——那个形态下只比名字**恰好也得到
  // 1 条**（先抵消 a.md、再留下 b.md），所以它分辨不出两种判据（P3 因此逃逸）。
  const parsed = [{ name: 'read', arguments: { file_path: 'a.md' } }];
  const recovered = [{ name: 'read', arguments: { file_path: 'b.md' } }];
  const lost = callsLostFromParse(recovered, parsed);
  assert.equal(lost.length, 1,
    '同名但不同参数是真丢失，不得被主解析的同名调用抵消掉');
  assert.equal(lost[0].arguments.file_path, 'b.md');
});

test('⑤c 同名同参数才算已覆盖：主解析拿到的那一条本身不得被重复计入', () => {
  const parsed = [{ name: 'read', arguments: { file_path: 'a.md' } }];
  const recovered = [{ name: 'read', arguments: { file_path: 'a.md' } }];
  assert.equal(callsLostFromParse(recovered, parsed).length, 0, '同一条调用必须被认成已覆盖');
});

test('⑤d 参数键序不影响等价性（模型产出的键序不保证稳定）', () => {
  const parsed = [{ name: 'edit', arguments: { file_path: 'a.md', old_string: 'x', new_string: 'y' } }];
  const recovered = [{ name: 'edit', arguments: { new_string: 'y', old_string: 'x', file_path: 'a.md' } }];
  assert.equal(callsLostFromParse(recovered, parsed).length, 0, '键序不同但内容相同必须视为同一条');
});

test('⑤e 参数为 JSON 字符串（恢复层的原始形态）也要能配对', () => {
  const parsed = [{ name: 'read', arguments: { file_path: 'a.md' } }];
  const recovered = [{ name: 'read', arguments: '{"file_path":"a.md"}' }];
  assert.equal(callsLostFromParse(recovered, parsed).length, 0, '字符串参数必须能解析后与对象参数配对');
});

test('⑤b 同名同参数的多条调用按出现序一一抵消（一轮三个 read 的既有形态）', () => {
  const parsed = [{ name: 'read', arguments: { file_path: 'a.md' } }, { name: 'read', arguments: { file_path: 'a.md' } }];
  const recovered = [
    { name: 'read', arguments: { file_path: 'a.md' } },
    { name: 'read', arguments: { file_path: 'a.md' } },
    { name: 'read', arguments: { file_path: 'a.md' } },
  ];
  const lost = callsLostFromParse(recovered, parsed);
  assert.equal(lost.length, 1, '两条已覆盖、第三条才是真丢的');
});