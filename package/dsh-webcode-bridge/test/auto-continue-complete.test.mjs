// auto-continue-complete.test.mjs — 0.19.3 护栏：累计超过升级点后，续跑轮改用**完整提醒**。
//
// ## 为什么必须有一条**行为**护栏，而不是只断言源码
//
// 「超过 N 次改用完整教学」这条分支在真机里要**先连续失败 N 次**才会第一次走到。
// 也就是说：它是最不容易被日常使用碰到、却最需要正确的一条路径。只钉源码形状
// （`test/continue-budget.test.mjs` ③d 做的那一层）挡不住「分支接上了但拼出来的
// 提示是错的」——真实链路上要验证的是**发进网页会话的那段文本**。
//
// ## 这条护栏同时钉住用户的两个相反要求
//
//   ① 升级真的发生：第 N+1 轮补发的文本里必须有**完整教学**（工具清单段），
//      且界面上必须写出「累计第几次 / 已改用完整提醒」。
//   ② **不能停**：同一轮里调用照旧被派发、`finish=tool-calls`——升级只换形态。
//
// ## 怎么造出「已经失败过 N 次」的现场
//
// 累计计数落盘在 `<WEBCODE_CONTINUE_STATE_DIR>/continuations/<sessionKey>.json`。
// 测试把这个根指到工作区内的临时目录并**预置 cumulative=3**，于是本次补发是第 4 次
// ⇒ 越过默认升级点 3 ⇒ 走完整提醒。预置而不是真的失败四轮：真的跑四轮要 4 次
// 60s 发送间隔，而且验的是同一件事。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';
import { continuationFilePath } from '../lib/continue-budget.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const B = String.fromCharCode(0xFF5C);
const S = String.fromCharCode(0x2581);
const official = (name, args) => `<${B}tool${S}calls${S}begin${B}>\n<${B}tool${S}call${S}begin${B}>${name}<${B}tool${S}sep${B}>${args}<${B}tool${S}call${S}end${B}>\n<${B}tool${S}calls${S}end${B}>`;
const BAD = official('edit', '{"file_path":"D:/x.js","old_string":"a","new_string":"b"},{"replace_all":false}');
const GOOD = official('edit', '{"file_path":"D:/x.js","old_string":"a","new_string":"b"}');

const TOOLS = [
  {
    name: 'edit',
    description: '改文件',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
];

function harness(sendTurnImpl, extraConfig = {}) {
  let adapter;
  const dispose = apply(
    { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null },
    {
      port: 0, requireConsent: false,
      driver: {
        status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
        sendTurn: sendTurnImpl,
        sendPrompt: async (prompt, opts) => sendTurnImpl('main', prompt, opts),
      },
      ...extraConfig,
    },
  );
  const collect = async (options) => {
    const chunks = [];
    for await (const c of adapter.stream(options)) chunks.push(c);
    return chunks;
  };
  return { collect, dispose };
}

test('端到端：累计第 4 次补发改用完整提醒（含完整教学），且续跑不停手', async () => {
  const dir = fs.mkdtempSync(path.join(repoRoot, 'test', '.tmp-continue-complete-'));
  const sessionId = 'auto-full-1';
  // 计数文件名必须与桥真实用的**会话键**逐字一致。0.19.4 起会话键含账号段
  //（`<sessionId>::<agentId>::<accountKey>`，见 index.js 的 keyPath 注释）；默认槽的
  // accountKey 就是 siteId，本用例 model='deepseek:deepseek' 因此是 `::deepseek`。
  // 这里**故意写死**这个形状：键格式若再变，本用例会在「必须走完整提醒」那条断言上
  // 响亮失败，而不是悄悄退化成短提示还全绿（那才是最难发现的假绿）。
  const sessionKey = sessionId + '::deepseek';
  // 预置「本会话已补发过 3 次」——与真实连续失败 3 轮后的计数文件**同构**。
  const stateFile = continuationFilePath(dir, sessionKey);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ cumulative: 3, updatedAt: new Date().toISOString() }) + '\n');

  const prevDir = process.env.WEBCODE_CONTINUE_STATE_DIR;
  process.env.WEBCODE_CONTINUE_STATE_DIR = dir;
  const prompts = [];
  const { collect, dispose } = harness(async (key, prompt, opts) => {
    prompts.push(prompt);
    if (prompts.length === 1) { opts.onDelta?.(BAD); return { text: BAD }; }
    return { text: GOOD };
  });
  try {
    const chunks = await collect({
      sessionId, model: 'deepseek:deepseek', tools: TOOLS, messages: [user('改文件')],
    });

    assert.equal(prompts.length, 2, '补发轮数不受累计策略影响（仍然只补发一轮）');
    const sent = prompts[1];

    // ① 升级真的发生：完整教学在场，短提示形态的判据不成立。
    assert.match(sent, /\[完整提醒·本会话累计第 4 次补发，已超过升级点 3 次\]/,
      '补发文本必须自述这是第几次、越过了哪个升级点');
    assert.match(sent, /# 可用本地工具/, '完整提醒必须带上首轮才有的工具清单段（短提示没有这一段）');
    assert.match(sent, /edit/, '工具清单里必须有本会话真实工具名');

    // ② 不能停：同一轮的调用照旧被派发（用户原话「不要停」）。
    assert.match(sent, /不会停手/, '提示文本必须明说续跑继续');
    const callEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
    assert.ok(callEnd, '升级形态下调用仍必须被派发（升级 ≠ 停手）');
    assert.equal(callEnd.block.name, 'edit');
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls', 'finish 必须是 tool-calls，让循环继续');

    // ③ 界面侧同时说清三件事（与模型侧同一口径）。
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.match(deltas, /AUTO_CONTINUED/);
    assert.match(deltas, /累计补发 \*\*4\*\* 次/, '界面必须给「整会话累计」这个读数');
    assert.match(deltas, /完整提醒/, '界面必须点名形态已升级');
    assert.match(deltas, /不停手|照常继续/, '界面不得让人读成桥收手了');

    // ④ 累计落账：确认送出后 +1，跨进程可读回。
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(after.cumulative, 4, '补发确认送出后累计必须 +1 并落盘');
  } finally {
    await dispose();
    if (prevDir === undefined) delete process.env.WEBCODE_CONTINUE_STATE_DIR;
    else process.env.WEBCODE_CONTINUE_STATE_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
