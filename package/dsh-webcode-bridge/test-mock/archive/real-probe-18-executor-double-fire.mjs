// real-probe-18-executor-double-fire.mjs — 真机复验 0.7.1 pendingCall 双发射修复
//
// 背景（2026-09-09 会话 f3fa97fd 复盘）：真实 DSH 会话里 deepseek:flash 每个工具
// 调用都被执行两次——先一条 arguments="" 的空参数调用（ToolArgsError
// INVALID_ARGS 假错误），再一条真参数调用。根因是 index.js executor 流式期间
// 提前开块的 pendingCall 在收尾时另开新 index 重发完整调用，Harness 把两条
// 同 id 调用都执行了。马拉松探针自带执行循环、单测 scriptedDriver 不调
// onDelta，两者都不经过该路径——只有真实流式网页才会触发。
//
// 本探针走完整链路：apply() 注册 adapter → 真实 DeepSeek 网页（onDelta 流式）
// → adapter.stream → 收集原生 chunk 序列 → 断言：
//   1) 每个工具调用 id 只出现一个 block-end（无同 id 双块）；
//   2) 无 arguments 为空串的终块（假 INVALID_ARGS 形状）；
//   3) 工具真实执行一次并回填，第二轮网页能继续（闭环没断）。
import { createBrowserDriver } from '../lib/browser-driver.js';
import { apply } from '../lib/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = process.env.REAL_PROFILE || 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\.edge-real-profile';

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/', profileDir: PROFILE, headless: true,
  requestTimeoutMs: 110_000, logger: console,
});

// 本地真实执行器（只读白名单）
const tools = [
  { name: 'read', description: '读取本地文件文本内容。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];
const execLog = []; // {name,args}
function runTool(name, args) {
  execLog.push({ name, args: JSON.parse(JSON.stringify(args || {})) });
  const p = path.resolve(PKG, String(args?.path || ''));
  if (!fs.existsSync(p)) return { status: 'error', error: '文件不存在: ' + p };
  return { status: 'success', output: fs.readFileSync(p, 'utf8').slice(0, 1200) };
}

let timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); process.exit(2); }, 260_000);
let failures = 0;
const ok = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!cond) failures++; };

try {
  const conn = await driver.connect();
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }

  // 完整宿主装配：真实 driver + adapter 注册（无需 DSH 进程）
  let adapter = null;
  const dispose = apply(
    { llm: { registerAdapter: (_ids, a) => { adapter = a; } }, get: () => null },
    { port: 0, requireConsent: false, driver },
  );

  const collect = async (options) => { const out = []; for await (const c of adapter.stream(options)) out.push(c); return out; };

  // ---- R1：真实网页流式回复带工具调用 ----
  const task1 = '请用 read 工具读取 package.json（相对路径 package.json），然后只回一行 JSON 概要（名称与版本号），不要做别的。';
  const r1 = await collect({
    model: 'deepseek:flash', tools, sessionId: 'probe18-exec',
    messages: [{ role: 'user', content: [{ type: 'text', text: task1 }] }],
  });

  const callEnds = r1.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call');
  const ids = callEnds.map(b => b.block.id);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  ok('R1.每个调用 id 唯一（无同 id 双终块）', dup.length === 0, dup.length ? '重复 id: ' + dup.join(',') : `calls=${ids.length}`);
  const emptyArgs = callEnds.filter(b => !b.block.arguments || b.block.arguments === '{}');
  ok('R1.无空参数终块（假 INVALID_ARGS 形状）', emptyArgs.length === 0, emptyArgs.map(b => b.block.id).join(','));
  ok('R1.finish=tool-calls', r1.at(-1)?.reason?.kind === 'tool-calls', r1.at(-1)?.reason?.kind);

  // 真实执行一次并回填
  const firstCall = callEnds[0];
  ok('R1.解析出 read 调用', firstCall?.block?.name === 'read', firstCall?.block?.name);
  const argsObj = JSON.parse(firstCall?.block?.arguments || '{}');
  const res1 = runTool(firstCall.block.name, argsObj);

  // ---- R2：结果回填，网页应继续并收束（不重复调用）----
  const r2 = await collect({
    model: 'deepseek:flash', tools, sessionId: 'probe18-exec',
    messages: [
      { role: 'user', content: [{ type: 'text', text: task1 }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: firstCall.block.id, name: firstCall.block.name, arguments: firstCall.block.arguments }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: firstCall.block.id, toolName: firstCall.block.name, content: [{ type: 'text', text: res1.output || res1.error || '' }], isError: res1.status === 'error' }] },
    ],
  });
  const callEnds2 = r2.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call');
  const ids2 = callEnds2.map(b => b.block.id);
  const dup2 = ids2.filter((v, i) => ids2.indexOf(v) !== i);
  ok('R2.回填后无同 id 双终块', dup2.length === 0, `calls=${ids2.length}`);
  const textOut = r2.filter(c => c.type === 'text-delta').map(c => c.text).join('');
  ok('R2.收到收束文本', textOut.length > 10, textOut.slice(0, 80));

  // ---- 终判 ----
  const callsPerTool = {};
  for (const e of execLog) callsPerTool[e.name] = (callsPerTool[e.name] || 0) + 1;
  console.log('\nexec log:', JSON.stringify(execLog.map(e => ({ n: e.name, p: e.args.path }))));
  ok('本地执行器只被调一次', Object.values(callsPerTool).every(v => v === 1) && execLog.length >= 1, JSON.stringify(callsPerTool));

  dispose();
  console.log(failures ? `\nPROBE-18 RESULT: FAIL (${failures})` : '\nPROBE-18 RESULT: PASS');
  process.exit(failures ? 1 : 0);
} catch (err) {
  console.log('ERROR', err?.message);
  console.log(err?.stack?.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
} finally { clearTimeout(timer); await driver.close(); }
