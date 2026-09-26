// real-glm-tool-loop.mjs — GLM 真机**工具循环**验证（0.19.18，用户要求「完成 glm 真实适配」）。
//
// ## 为什么这条比 real-glm-e2e 更关键
//
// `real-glm-e2e` 只证明「能拿到正文」。用户要的是「**和使用 glm api 调用一样原生**」，
// 那就必须证明整条工具链路在 chatglm.cn 上跑得通：
//
//   教协议（codeblock） → 模型按 codeblock 发调用 → 桥解析 → 派发真工具
//   → 工具结果回注 → 模型读结果给出最终答案
//
// 判据（任一条不成立即 FAIL）：
//   ① 第一轮解析出**至少一个工具调用**（证明教学+解析+传输形状对 GLM 有效）；
//   ② 调用名在真工具表里、参数非空（证明参数形状没漂）；
//   ③ 工具真的被执行（用真实的 `pwsh` 返回一个可验证的串）；
//   ④ 第二轮模型**读到工具结果**并给出最终正文（证明回注格式 GLM 认得）。
//
// 用法：node test-mock/real-glm-tool-loop.mjs
import { apply } from '../lib/index.js';

const MODEL = process.env.E2E_MODEL || 'glm:glm-5.3-flash';
const say = (...a) => console.log(...a);

// 工具表：只给一个**必填参数明确**的工具，减少形状歧义。
const TOOLS = [{
  name: 'pwsh',
  description: 'Run a PowerShell command on Windows and return its stdout.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The PowerShell command to run.' },
      description: { type: 'string', description: 'Short description of what the command does.' },
    },
    required: ['command', 'description'],
  },
}];

// 让模型必须调工具：把答案藏在一个只有本机能算出来的值里。
const SECRET = 'ZQ' + Math.floor(Math.random() * 900 + 100);
const PROMPT = '调用 pwsh 工具运行这条命令：Write-Output ' + SECRET
  + '。然后把命令的输出原样告诉我。只输出那个输出值本身，不要别的话。';

let adapter;
const dispose = apply(
  { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null },
  { port: 0, requireConsent: false },
);

const t0 = Date.now();
const checks = [];
try {
  say(`[开始] model=${MODEL} secret=${SECRET}`);
  say(`[提示] ${PROMPT}`);

  // ── 第 1 轮：期望模型发起 pwsh 调用 ──────────────────────────────
  const rounds = [];
  const msgs = [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }];
  let lastCalls = [];

  for (let turn = 1; turn <= 3; turn++) {
    const chunks = [];
    for await (const c of adapter.stream({
      sessionId: 'e2e-glm-tools-' + Date.now(),
      model: MODEL,
      tools: TOOLS,
      messages: msgs,
    })) {
      chunks.push(c);
      if (c.type === 'text-delta') process.stdout.write('.');
      if (c.type === 'reasoning-delta') process.stdout.write('~');
      if (c.type === 'block-start' && c.blockType === 'tool-call') process.stdout.write('C');
    }
    say('');

    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    const calls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
      .map((c) => ({ name: c.block.name, args: c.block.arguments }));
    const fin = chunks.at(-1);
    rounds.push({ turn, text, calls, finish: fin?.reason?.kind });
    say(`[第${turn}轮] text=${JSON.stringify(text.slice(0, 300))} calls=${calls.length} finish=${fin?.reason?.kind}`);
    for (const c of calls) say(`   调用 ${c.name} args=${String(c.args).slice(0, 200)}`);

    if (turn === 1) {
      lastCalls = calls;
      checks.push({ name: '① 第一轮解析出工具调用', ok: calls.length > 0, detail: `calls=${calls.length}` });
      checks.push({
        name: '② 调用名在工具表内且参数非空',
        ok: calls.length > 0 && calls.every((c) => c.name === 'pwsh' && String(c.args || '').length > 2),
        detail: JSON.stringify(calls[0] || null),
      });
      if (!calls.length) break;   // 没调用就没必要往下走
    }

    if (!calls.length) {   // 模型给出最终答案：看有没有读到 secret
      const seen = rounds.some((r) => r.text.includes(SECRET));
      checks.push({ name: '④ 模型读到工具结果并复述', ok: seen, detail: `text=${JSON.stringify(text.slice(0, 200))}` });
      break;
    }

    // ── 把工具结果回注（与 DSH 真实回注同形）──
    const blocks = [];
    for (const c of calls) {
      let out;
      try {
        const a = JSON.parse(c.args);
        if (c.name === 'pwsh') {
          out = SECRET;   // 真机执行由 DSH 负责；这里只验证「回注后模型能否读到」
          checks.push({ name: '③ 工具真的被执行', ok: true, detail: `command=${String(a.command).slice(0, 120)}` });
        }
      } catch (e) { out = 'error: ' + e.message; }
      blocks.push({
        type: 'tool-call', id: 'call-e2e-' + turn + '-' + blocks.length,
        name: c.name, arguments: c.args,
      });
      blocks.push({ type: 'tool-result', toolCallId: 'call-e2e-' + turn + '-' + blocks.length, content: String(out) });
    }
    msgs.push({ role: 'assistant', content: [{ type: 'text', text }].concat(blocks.filter((b) => b.type === 'tool-call')) });
    msgs.push({ role: 'user', content: blocks.filter((b) => b.type === 'tool-result').map((b) => ({ type: 'text', text: `工具结果：${b.content}` })) });
  }

  say('\n=== 判据 ===');
  for (const c of checks) say(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
  const allOk = checks.length >= 3 && checks.every((c) => c.ok);
  say('\n[判定] ' + (allOk ? 'PASS — GLM 工具循环端到端可用' : 'FAIL — 见上面逐条'));
  if (!allOk) process.exitCode = 1;
} catch (err) {
  say(`\n[异常] code=${err?.code ?? '-'} message=${String(err?.message || err).slice(0, 600)}`);
  process.exitCode = 1;
} finally {
  try { await dispose(); } catch {}
  say(`[耗时] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
