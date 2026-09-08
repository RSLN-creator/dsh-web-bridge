// real-probe-16-long-review.mjs — 长时间自驱动真实场景：
// 复刻 2026-09-08 会话 f3fa97fd 的失败形态（工具错误 → 第二轮裸 fence 调用被丢），
// 现在必须：错误回填可见 → 模型自主重试/修正参数 → 多轮自主探索 → 收束。
// 全程无外部提示：只给一个任务，模型自己决定读什么、grep 什么。
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn, serializeDelta, parseAgentReply } from '../lib/agent-preset.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(PKG, '..', '..');
const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/',
  profileDir: process.env.WEBCODE_PROFILE || path.join(REPO, '.edge-real-profile'),
  headless: true, requestTimeoutMs: 120_000, logger: console,
});

// --- 真实只读工具执行器（与 DSH 宿主行为一致，错误必须真实产生） ---
function runRead(p) {
  // Windows 大小写不敏感 + 前缀分隔符差异，startsWith 会把 sibling 目录误放行
  // （D:\repo-2 不在 D:\repo 内）；用 path.relative 判界，越界才拒。
  const abs = path.resolve(REPO, String(p || ''));
  const rel = path.relative(REPO, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { status: 'error', error: '路径越界: ' + p };
  if (!fs.existsSync(abs)) return { status: 'error', error: '文件不存在: ' + abs };
  const st = fs.statSync(abs);
  if (st.isDirectory()) return { status: 'error', error: '是目录不是文件: ' + abs };
  return { status: 'success', output: fs.readFileSync(abs, 'utf8').slice(0, 2000) };
}
function stripInlineMods(q) {
  let flags = ''; let body = q;
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
  const { body, flags } = stripInlineMods(String(q || ''));
  if (!body) return { status: 'error', error: '未提供搜索内容' };
  let re;
  try { re = new RegExp(body, 'i' + flags.replace(/[igs]/g, '')); }
  catch (e) { return { status: 'error', error: '正则无效: ' + e.message }; }
  const hits = [];
  walk(REPO, '', hits, re, 0);
  return { status: 'success', output: hits.length ? hits.slice(0, 40).join('\n') : '（0 个匹配）' };
}
// 故意的严格 schema：缺 command 直接报错——复刻 DSH pwsh 工具的参数校验
function runShell(args) {
  if (!args || typeof args.command !== 'string' || !args.command.trim()) {
    return { status: 'error', error: 'invalid arguments: missing required property "command"' };
  }
  if (/rm|del|remove|write|Set-Content|Out-File/i.test(args.command)) {
    return { status: 'error', error: '只读审查模式：拒绝写操作' };
  }
  try {
    const out = execSync(args.command, { cwd: REPO, timeout: 20_000, encoding: 'utf8', maxBuffer: 1 << 20 });
    return { status: 'success', output: String(out).slice(0, 2000) };
  } catch (e) { return { status: 'error', error: (e.message || '').slice(0, 500) }; }
}
const tools = [
  { name: 'read', description: '读取本仓库内文件的文本内容（相对路径）。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep', description: '在本仓库源码内按关键词(支持正则)检索，返回 相对路径:行号。', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'shell', description: '在仓库根目录执行只读命令（如 git log --oneline -10）', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];
const dispatcher = { read: ({ path: p }) => runRead(p), grep: ({ query }) => runGrep(query), shell: (args) => runShell(args) };
const resultFence = (r) => '```json\n' + JSON.stringify(r.status === 'error'
  ? { mcp_action: 'result', name: r.name, status: 'error', error: String(r.error || '').slice(0, 1500) }
  : { mcp_action: 'result', name: r.name, status: 'success', output: String(r.output || '').slice(0, 1500) }) + '\n```';

const GLOBAL_TIMEOUT = 12 * 60_000;
let timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); process.exit(2); }, GLOBAL_TIMEOUT);
const callsSeen = {}; let errorResults = 0; let retryAfterError = 0;
try {
  const conn = await driver.connect();
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }

  const task = '对本仓库做一次真实代码安全审查：1) 读 README.md 和 package.json 了解项目；2) 用 grep 检索源码中硬编码的 token/secret/password/api_key；3) 用 shell 跑 git log --oneline -8 看最近改动；4) 对发现的可疑点用 read 打开核实。若工具调用参数无效收到 error 结果，请修正参数后重试。全部完成后给出 3-5 行审查结论收束，不要继续调用工具。';
  const thinkingSeen = [];
  let running = await driver.sendTurn('long-review', serializeFirstTurn({ messages: [{ role: 'user', content: task }], tools, model: { id: 'deepseek' } }), { fresh: true, model: 'deepseek', onThink: (t) => thinkingSeen.push(t) });
  let rounds = 0; let finalText = ''; let hadError = false;
  const toolErrThenOk = {}; // name → {err: n, ok: m}：错误后同名工具成功过才算真正重试
  while (rounds < 8) {
    rounds++;
    const p = parseAgentReply(running?.text ?? '');
    if (!p.calls.length) { finalText = (running.text || '').trim(); break; }
    const results = p.calls.map((c) => {
      callsSeen[c.name] = (callsSeen[c.name] || 0) + 1;
      const r = dispatcher[c.name]?.(c.arguments || {}) ?? { status: 'error', error: '未知工具: ' + c.name };
      if (r.status === 'error') console.log('  [tool-err]', c.name, JSON.stringify(c.arguments || {}).slice(0, 120), '→', String(r.error).slice(0, 120));
      const slot = (toolErrThenOk[c.name] ||= { err: 0, ok: 0 });
      if (r.status === 'error') { slot.err++; errorResults++; if (hadError) retryAfterError++; hadError = true; }
      else { slot.ok++; hadError = false; }
      return resultFence({ name: c.name, ...r });
    });
    running = await driver.sendTurn('long-review', results.join('\n') + '\n[系统] 以上是真实工具结果。继续任务：需要更多数据就继续调用工具（修正无效参数）；信息足够就给最终审查结论并停止调用。', { fresh: false, model: 'deepseek', onThink: (t) => thinkingSeen.push(t) });
  }
  if (rounds >= 8) finalText = (running.text || '').trim();

  const thinkText = thinkingSeen.join('');
  console.log('rounds=', rounds, 'calls=', JSON.stringify(callsSeen), 'errorResults=', errorResults);
  console.log('toolErrThenOk=', JSON.stringify(toolErrThenOk));
  console.log('thinkingChars=', thinkText.length);
  console.log('summary=', finalText.slice(0, 200).replace(/\n/g, ' '));
  // 通过判据（对比 2026-09-08 失败会话：2 轮即裸奔、第二轮 fence 被丢、无收束）：
  const okMultiTool = (callsSeen.read || 0) + (callsSeen.grep || 0) >= 3;          // 多工具自主探索
  // 错误后恢复：要么没有错误，要么每个报错工具后续都有成功调用（重试修正成功）
  const recovered = Object.entries(toolErrThenOk).every(([n, s]) => s.err === 0 || s.ok > 0);
  const okErrorLoop = errorResults === 0 || recovered;                              // 错误后能继续
  const okSummary = finalText.length > 60;                                        // 有收束结论
  const okSelfDriven = rounds >= 3;                                               // 至少 3 轮自驱动
  console.log(`RESULT ${okMultiTool && okSummary && okSelfDriven && okErrorLoop ? 'PASS' : 'FAIL'}  multiTool=${okMultiTool} errorLoop=${okErrorLoop} summary=${okSummary} selfDriven=${okSelfDriven}`);
  await driver.resetConversation('long-review');
} catch (e) {
  console.error('ERR:', e?.message, e?.code ?? '');
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try { await driver.close(); } catch {}
}
