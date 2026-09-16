// real-probe-17-autonomous-marathon.mjs — 长时自主运行验证（无外部输入）：
// 只下发一个任务，之后模型全权决策（读什么、grep 什么、跑什么命令、何时收束），
// 期间零人工干预、零外部提示。全部轮次（任务、思维链、工具调用、结果、收束）
// 落盘为 DSH 存档同形状的 JSONL 轨迹，指标口径与官方 API 轨迹对比一致。
//
// 与 probe-16 的差异：probe-16 验证「错误恢复」；本脚本验证「长时自主性」——
// 更高轮数上限、按序号写档、每轮用时/思考/调用/错误全量记录、最终按官方轨迹
// 口径（calls、errRate、reasoningChars、自驱动步数）输出指标块。
// 用法：node test-mock/real-probe-17-autonomous-marathon.mjs [--rounds N] [--model deepseek]
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn, parseAgentReply } from '../lib/agent-preset.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(PKG, '..', '..');
const argv = process.argv.slice(2);
const argAfter = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MAX_ROUNDS = parseInt(argAfter('--rounds', '10'), 10);
const MODEL = argAfter('--model', 'deepseek');
const TRACE = path.join(PKG, 'test-mock', `trace-probe17-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 17)}.jsonl`);
const t0 = Date.now();

// --- 轨迹留档：DSH 存档同形状（type/time/data），可被 doc/research 对比脚本直接消费 ---
const trace = fs.createWriteStream(TRACE, { flags: 'a' });
const traceWrite = (type, data) => trace.write(JSON.stringify({ type, time: Date.now(), data }) + '\n');
traceWrite('meta', { probe: 'real-probe-17-autonomous-marathon', model: MODEL, maxRounds: MAX_ROUNDS, repo: REPO, provider: 'webcode(web-bridge)', version: JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version });

// --- 真实只读工具执行器（与 DSH 宿主一致：错误真实产生并回显） ---
function runRead(p) {
  const abs = path.resolve(REPO, String(p || ''));
  const rel = path.relative(REPO, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { status: 'error', error: '路径越界: ' + p };
  if (!fs.existsSync(abs)) return { status: 'error', error: '文件不存在: ' + abs };
  const st = fs.statSync(abs);
  if (st.isDirectory()) return { status: 'error', error: '是目录不是文件: ' + abs };
  return { status: 'success', output: fs.readFileSync(abs, 'utf8').slice(0, 2000) };
}
function stripInlineMods(q) {
  let flags = ''; let body = String(q || '');
  for (;;) {
    const m = /^\(\?([iimsx]+)\)/.exec(body);
    if (!m) break;
    for (const c of m[1]) if (!flags.includes(c)) flags += c;
    body = body.slice(m[0].length);
  }
  return { body, flags };
}
function walk(dir, rel, hits, re, depth) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name); const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { walk(p, r, hits, re, depth + 1); continue; }
    if (!/\.(js|mjs|cjs|md|json|html|css)$/i.test(e.name)) continue;
    let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const lines = txt.split('\n');
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(`${r}:${i + 1}: ${lines[i].trim().slice(0, 80)}`);
  }
}
function runGrep(q) {
  const { body, flags } = stripInlineMods(q);
  if (!body) return { status: 'error', error: '未提供搜索内容' };
  let re;
  try { re = new RegExp(body, 'i' + flags.replace(/[igs]/g, '')); }
  catch (e) { return { status: 'error', error: '正则无效: ' + e.message }; }
  const hits = [];
  walk(REPO, '', hits, re, 0);
  return { status: 'success', output: hits.length ? hits.slice(0, 40).join('\n') : '（0 个匹配）' };
}
// 严格 schema 复刻 DSH pwsh 校验：缺 command 报 invalid arguments
function runShell(args) {
  if (!args || typeof args.command !== 'string' || !args.command.trim()) {
    return { status: 'error', error: 'invalid arguments: missing required property "command"' };
  }
  if (/rm\s|del\s|remove-item|set-content|out-file|>[\s]*\S/i.test(args.command)) {
    return { status: 'error', error: '只读审查模式：拒绝写操作' };
  }
  try {
    // maxBuffer 16MB：1MB 时 Recurse 全仓清单类命令超限抛 ENOBUFS（2026-09-09 首跑
    // 5 次 shell error 全是这一形状，16MB 与 DSH 宿主 pwsh 容量同量级）。
    const out = execSync(args.command, { cwd: REPO, timeout: 30_000, encoding: 'utf8', maxBuffer: 16 << 20, shell: 'powershell.exe' });
    return { status: 'success', output: String(out).slice(0, 2000) };
  } catch (e) { return { status: 'error', error: (e.stdout || e.message || '').toString().slice(0, 500) }; }
}
const tools = [
  { name: 'read', description: '读取本仓库内文件的文本内容（相对路径）。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep', description: '在本仓库源码内按关键词(支持正则)检索，返回 相对路径:行号。', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'shell', description: '在仓库根目录执行只读命令（如 git log --oneline -10、git diff --stat）。写操作会被拒绝。', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];
const dispatcher = { read: ({ path: p }) => runRead(p), grep: ({ query }) => runGrep(query), shell: (args) => runShell(args) };
const resultFence = (r) => '```json\n' + JSON.stringify(r.status === 'error'
  ? { mcp_action: 'result', name: r.name, status: 'error', error: String(r.error || '').slice(0, 1500) }
  : { mcp_action: 'result', name: r.name, status: 'success', output: String(r.output || '').slice(0, 1500) }) + '\n```';

// 与官方 API 轨迹（DSH 存档 08-14~08-24 deepseek-official/deepseek-v4-pro）同口径的指标：
// calls 总数、errRate、reasoningChars、带调用的自主步数（官方 57~96）、工具多样性。
const stats = { rounds: 0, calls: {}, callTotal: 0, errors: 0, reasoningChars: 0, textChars: 0, callRounds: 0, errThenOk: {}, lastErrRecovered: true, callShapedUnparsed: false };
const GLOBAL_TIMEOUT = 20 * 60_000;
let timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); traceWrite('meta-end', { ...stats, timeout: true }); trace.end(); process.exit(2); }, GLOBAL_TIMEOUT);
// driver 必须在 finally 里关掉：Playwright 的浏览器连接会一直吊着事件循环，
// 不关就等于每次长跑都留一个孤儿 Edge 进程树（会锁住 profile，下次跑直接起不来）。
let driver = null;
try {
  driver = createBrowserDriver({
    site: 'https://chat.deepseek.com/',
    profileDir: process.env.WEBCODE_PROFILE || path.join(REPO, '.edge-real-profile'),
    headless: true, requestTimeoutMs: 150_000, logger: console,
  });
  const conn = await driver.connect();
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }

  // 单一任务，此后无任何外部输入。
  const task = '对本仓库做一次完整的深度审查并交付简报：1) 理解项目结构与目标（README/PLAN/doc）；2) 审查关键实现源码（lib/ 下的解析、驱动、契约）找真实缺陷与风险；3) 检查凭据/密钥泄漏（grep token/secret/password/api_key）；4) 用 git log 了解演进脉络；5) 对每个疑点用 read/shell 亲自核实，不要臆断。若工具报错（参数无效/路径不存在），修正参数后重试。全部核实完成后输出 5-10 行审查简报（发现、证据、建议）并停止调用工具。';
  traceWrite('user/message', { role: 'user', content: task });

  const onThink = (t) => { stats.reasoningChars += t.length; traceWrite('reasoning-chunk', { round: stats.rounds, text: t }); };
  let running = await driver.sendTurn('probe17', serializeFirstTurn({ messages: [{ role: 'user', content: task }], tools, model: { id: MODEL } }), { fresh: true, model: MODEL, onThink });
  let finalText = ''; let round = 0;
  while (round < MAX_ROUNDS) {
    round++; stats.rounds = round;
    const turnStart = Date.now();
    const p = parseAgentReply(running?.text ?? '');
    traceWrite('assistant/message', { round, calls: p.calls.map((c) => ({ name: c.name, arguments: c.arguments })), text: (running?.text || '').slice(0, 4000) });
    if (!p.calls.length) {
      finalText = (running.text || '').trim();
      // 静默丢调用护栏：收束文本如果还带着调用记号（invoke/mcp_action/parameter），
      // 说明解析器漏了一种调用形状——这不是「模型收束」，是工具循环被打断，
      // 必须让本次长跑 FAIL，而不是记一个好看的 PASS。
      stats.callShapedUnparsed = /<\s*invoke\s+name\s*=|"mcp_action"\s*:\s*"call"|<\s*parameter\s+name\s*=|[\uFF5C|]\s*DSML\s*[\uFF5C|]/.test(finalText);
      traceWrite('round/end', { round, durMs: Date.now() - turnStart, calls: 0, callShapedUnparsed: stats.callShapedUnparsed });
      break;
    }
    stats.callRounds++;
    const results = p.calls.map((c) => {
      stats.callTotal++; stats.calls[c.name] = (stats.calls[c.name] || 0) + 1;
      traceWrite('tool/call', { round, name: c.name, arguments: c.arguments || {} });
      const r = dispatcher[c.name]?.(c.arguments || {}) ?? { status: 'error', error: '未知工具: ' + c.name };
      if (r.status === 'error') { stats.errors++; console.log('  [tool-err]', c.name, JSON.stringify(c.arguments || {}).slice(0, 100), '→', String(r.error).slice(0, 100)); }
      const slot = (stats.errThenOk[c.name] ||= { err: 0, ok: 0 });
      if (r.status === 'error') slot.err++; else slot.ok++;
      traceWrite('tool/result', { round, name: c.name, status: r.status, error: r.status === 'error' ? String(r.error).slice(0, 500) : undefined, output: r.status === 'success' ? String(r.output).slice(0, 500) : undefined });
      return resultFence({ name: c.name, ...r });
    });
    traceWrite('round/end', { round, durMs: Date.now() - turnStart, calls: p.calls.length });
    running = await driver.sendTurn('probe17', results.join('\n') + '\n[系统] 以上是真实工具结果。继续任务：需要更多数据就继续调用工具（修正无效参数）；信息足够就输出最终审查简报并停止调用。', { fresh: false, model: MODEL, onThink });
  }
  if (round >= MAX_ROUNDS) finalText = (running.text || '').trim();
  stats.textChars = finalText.length;

  const recovered = Object.entries(stats.errThenOk).every(([n, s]) => s.err === 0 || s.ok > 0);
  const errRate = stats.callTotal ? (stats.errors / stats.callTotal * 100).toFixed(1) : '0.0';
  const toolDiversity = Object.keys(stats.calls).length;
  console.log('\n===== probe-17 自主马拉松指标（官方 API 口径） =====');
  console.log(`selfDrivenRounds=${stats.callRounds}  calls=${stats.callTotal} ${JSON.stringify(stats.calls)}`);
  console.log(`errRate=${errRate}% (${stats.errors}/${stats.callTotal})  errThenOk=${JSON.stringify(stats.errThenOk)}`);
  console.log(`reasoningChars=${stats.reasoningChars}  finalBriefChars=${stats.textChars}`);
  console.log(`toolDiversity=${toolDiversity}  duration=${((Date.now() - t0) / 1000).toFixed(0)}s  trace=${path.basename(TRACE)}`);
  console.log('brief=', finalText.slice(0, 300).replace(/\n/g, ' '));
  // 判据（对照官方轨迹：86-107 调用、errRate 1.2-3.8%、reasoning 5k-378k）：
  const okCalls = stats.callTotal >= 8;
  const okErr = stats.errors === 0 || recovered;
  const okThink = stats.reasoningChars > 1500;
  const okBrief = stats.textChars > 200;
  const okSelf = stats.callRounds >= 4;
  const okDiversity = toolDiversity >= 2;
  const okParsed = !stats.callShapedUnparsed;
  if (!okParsed) console.log('注意：收束文本仍含调用记号——解析器漏形状，工具循环是被打断的（静默丢调用）。');
  const pass = okCalls && okErr && okThink && okBrief && okSelf && okDiversity && okParsed;
  console.log(`RESULT ${pass ? 'PASS' : 'FAIL'}  calls=${okCalls} errLoop=${okErr} think=${okThink} brief=${okBrief} selfDriven=${okSelf} diversity=${okDiversity} parsed=${okParsed}`);
  traceWrite('meta-end', { ...stats, pass, errRate, durationMs: Date.now() - t0 });
  await driver.resetConversation('probe17');
} catch (e) {
  console.error('ERR:', e?.message, e?.code ?? '');
  traceWrite('meta-end', { ...stats, error: String(e?.message) });
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try { await driver?.close(); } catch {}
  trace.end();
}
