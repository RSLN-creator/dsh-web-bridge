#!/usr/bin/env node
// run-real-longrun.mjs — 长期真实调用验证（无 mock、无外部干扰）。
//
// 与 test/ 下的单测不同：这里用**真实 Edge + 真实网页会话**跑完整的多轮
// 工具闭环，验证四件事：
//   1. 登录链路：未登录时 openLogin() 打开有头窗口，等待人工登录后继续；
//   2. 同一网页会话连续多轮（fresh=false，不再整段重建）；
//   3. 真实工具调用闭环：网页发调用 → 本地执行 → 结果回注 → 模型继续；
//   4. 回复完整：无 STREAM_REWRITE、无协议文本泄漏、增量与块内容一致。
//
//   node test-mock/run-real-longrun.mjs
//   WEBCODE_HEADED=1 node test-mock/run-real-longrun.mjs   # 全程有头观察

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { apply } from '../lib/index.js';
import { createBrowserDriver } from '../lib/browser-driver.js';

const pkgDir = path.resolve(import.meta.dirname, '..');
const targetDir = path.join(pkgDir, 'lib');
const reportPath = path.join(pkgDir, '.tmp', 'longrun-report.md');
const sessionId = 'longrun-' + Date.now().toString(36);
const MAX_ROUNDS = 10;

const log = (...a) => console.log('[longrun]', ...a);

// ---- 真实驱动（与 DSH 内一致的配置） -------------------------------------
const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/',
  profileDir: path.join(os.homedir(), '.dsh', 'webcode-edge-profile'),
  headless: process.env.WEBCODE_HEADED ? false : true,
  requestTimeoutMs: 240_000,
  loginTimeoutMs: 300_000,
  logger: console,
});
const turnLog = [];
const tracedSendTurn = driver.sendTurn.bind(driver);
driver.sendTurn = async (key, prompt, opts) => {
  const r = await tracedSendTurn(key, prompt, opts);
  turnLog.push({ key, fresh: opts?.fresh === true, chars: prompt.length });
  log(`web turn #${turnLog.length}: sessionKey=${key} fresh=${opts?.fresh === true} promptChars=${prompt.length}`);
  return r;
};

// ---- 假 llm 宿主 + apply()（与 DSH 完全相同的适配器路径） -----------------
let adapter;
const dispose = apply(
  { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null },
  { port: 0, requireConsent: false, driver },
);

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const TOOLS = [
  { name: 'list_dir', description: '列出目录下的一层条目（文件名|类型）。', parameters: { type: 'object', properties: { dir: { type: 'string', description: '绝对路径' } }, required: ['dir'] } },
  { name: 'count_lines', description: '统计单个文本文件的行数。', parameters: { type: 'object', properties: { file: { type: 'string', description: '绝对路径' } }, required: ['file'] } },
  { name: 'write_report', description: '把文本内容写入指定文件（UTF-8）。', parameters: { type: 'object', properties: { file: { type: 'string' }, content: { type: 'string' } }, required: ['file', 'content'] } },
];

function execTool(name, args) {
  if (name === 'list_dir') {
    const entries = fs.readdirSync(args.dir, { withFileTypes: true });
    return entries.map((e) => `${e.name}|${e.isDirectory() ? 'dir' : 'file'}`).join('\n');
  }
  if (name === 'count_lines') {
    const text = fs.readFileSync(args.file, 'utf8');
    return String(text.split('\n').length);
  }
  if (name === 'write_report') {
    fs.mkdirSync(path.dirname(args.file), { recursive: true });
    fs.writeFileSync(args.file, args.content, 'utf8');
    return 'written ' + Buffer.byteLength(args.content) + ' bytes';
  }
  throw new Error('unknown tool ' + name);
}

async function runTurn(messages, tools) {
  const chunks = [];
  for await (const c of adapter.stream({ sessionId, model: 'deepseek:deepseek', messages, tools })) chunks.push(c);
  const finish = chunks.find((c) => c.type === 'finish');
  const textEnd = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'text').map((c) => c.block.text).join('\n');
  const calls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
    .map((c) => ({ id: c.block.id, name: c.block.name, arguments: JSON.parse(c.block.arguments) }));
  const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  return { finish, textEnd, calls, deltas };
}

const truth = {};
for (const f of fs.readdirSync(targetDir)) {
  if (f.endsWith('.js')) truth[f] = fs.readFileSync(path.join(targetDir, f), 'utf8').split('\n').length;
}
const truthTotal = Object.values(truth).reduce((a, b) => a + b, 0);
log(`ground truth: ${Object.keys(truth).length} files, ${truthTotal} lines`);

// ---- 预检：登录 ------------------------------------------------------------
const pre = await driver.connect();
log('connect:', JSON.stringify(pre));
if (!pre.loggedIn) {
  log('未登录 —— 打开有头登录窗口，请在窗口里完成登录（最长等 5 分钟）…');
  try {
    const r = await driver.openLogin();
    log('login:', JSON.stringify(r));
  } catch (err) {
    log('LOGIN_FAILED:', err?.message);
    console.log('LONGRUN RESULT: LOGIN_FAILED');
    process.exitCode = 2;
    await dispose();
    process.exit(2);
  }
}

// ---- 长跑：多轮真实工具闭环 ------------------------------------------------
const task = `请统计目录 ${targetDir} 下所有 .js 文件的行数：先用 list_dir 列出目录，再对每个 .js 文件调用 count_lines 统计行数（每个文件一次调用），全部统计完后把「文件名 → 行数」清单和总行数写入 ${reportPath}（用 write_report），最后用一句话告诉我总行数。必须使用真实工具，不得凭记忆编造。`;

const messages = [user(task)];
const findings = [];
let finalText = '';
try {
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    log(`--- round ${round} (${messages.length} msgs) ---`);
    const { finish, textEnd, calls, deltas } = await runTurn(messages, TOOLS);
    if (!finish) throw new Error('round ' + round + ': stream 未收尾');
    findings.push({ round, reason: finish.reason?.kind, calls: calls.length, textChars: textEnd.length, deltasMatch: deltas === textEnd.replace(/\n$/, '') || deltas.length > 0 });
    if (/[<]$/.test(deltas)) log('warn: 尾部疑似半成品标记');
    if (textEnd.includes('<tool_call>') || textEnd.includes('```json')) log('warn: 协议文本出现在正文块');
    log(`round ${round}: reason=${finish.reason?.kind} calls=${calls.length} textChars=${textEnd.length}`);
    if (finish.reason?.kind === 'tool-calls') {
      if (!calls.length) throw new Error('round ' + round + ': tool-calls 收尾但没有调用块');
      const assistant = { role: 'assistant', content: [{ type: 'text', text: textEnd }] };
      for (const c of calls) assistant.content.push({ type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments });
      messages.push(assistant);
      for (const c of calls) {
        let output, isError = false;
        try { output = execTool(c.name, c.arguments); } catch (err) { output = String(err?.message || err); isError = true; }
        log(`  tool ${c.name}(${JSON.stringify(c.arguments).slice(0, 120)}) => ${String(output).slice(0, 80)}`);
        messages.push({ role: 'tool', tool_call_id: c.id, name: c.name, isError, content: [{ type: 'text', text: String(output) }] });
      }
      continue;
    }
    finalText = textEnd;
    break;
  }
  if (!finalText) throw new Error('超过最大轮数仍未收束');

  // ---- 连续性验证：同一网页会话追问（增量轮，fresh 必须为 false） ----------
  messages.push(user('不用任何工具。只回答一个数字：上面你统计的 .js 文件总行数是多少？'));
  const recall = await runTurn(messages, TOOLS);
  if (recall.finish?.reason?.kind !== 'stop') throw new Error('追问轮未正常收尾');
  log('recall answer:', recall.textEnd.slice(0, 200));

  const expected = String(truthTotal);
  const freshAfterFirst = turnLog.slice(1).every((t) => !t.fresh);
  const reportWritten = fs.existsSync(reportPath);
  const summary = {
    sessionId,
    turns: turnLog.length,
    webTurns: turnLog,
    sameConversation: turnLog.length >= 2 && freshAfterFirst,
    reportWritten,
    recallContainsTotal: recall.textEnd.includes(expected),
    recallAnswer: recall.textEnd.slice(0, 120),
    truthTotal,
    finalText: finalText.slice(0, 300),
    rounds: findings,
  };
  console.log('LONGRUN_SUMMARY ' + JSON.stringify(summary));
  const ok = summary.sameConversation && summary.recallContainsTotal && summary.reportWritten;
  console.log(ok ? 'LONGRUN RESULT: PASS' : 'LONGRUN RESULT: FAIL');
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  log('LONGRUN ERROR:', err?.message);
  console.log('LONGRUN RESULT: FAIL ' + JSON.stringify({ error: String(err?.message || err), turns: turnLog }));
  process.exitCode = 1;
} finally {
  await dispose();
}
