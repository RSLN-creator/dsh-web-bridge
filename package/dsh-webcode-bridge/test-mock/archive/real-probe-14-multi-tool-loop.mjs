// real-probe-14-multi-tool-loop.mjs — 真实网页多工具闭环：
// 网页自主发起 read + grep，回填真实结果，验证多工具自主调用与收束。
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn, parseAgentReply } from '../lib/agent-preset.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/', profileDir: 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\.edge-real-profile',
  headless: true, requestTimeoutMs: 90_000, logger: console,
});

// --- 两个真实只读工具执行器 ---
function runRead(p) {
  const abs = path.resolve(PKG, String(p || ''));
  if (!fs.existsSync(abs)) return { status: 'error', error: '文件不存在: ' + abs };
  return { status: 'success', output: fs.readFileSync(abs, 'utf8').slice(0, 1200) };
}
// grep：把网页常见的 PCRE 内联修饰 (?i)(?s) 剥成 JS flag，再递归搜关键词，返回 相对路径:行号。
function stripInlineMods(q) {
  let flags = '';
  let body = q;
  for (;;) {
    const m = /^\(\?([iimsx]+)\)/.exec(body);
    if (!m) break;
    for (const c of m[1]) if (!flags.includes(c)) flags += c;
    body = body.slice(m[0].length);
  }
  return { body, flags };
}
function walk(dir, rel, hits, re) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name); const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { walk(p, r, hits, re); continue; }
    if (!/\.(js|mjs|md|json|toml)$/i.test(e.name)) continue;
    let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const lines = txt.split('\n');
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(`${r}:${i + 1}`);
  }
}
function runGrep(q) {
  const { body, flags } = stripInlineMods(String(q || ''));
  if (!body) return { status: 'error', error: '未提供搜索内容' };
  let re;
  try { re = new RegExp(body, 'i' + flags.replace('i', '').replace('s', '').replace('g', '')); }
  catch (e) { return { status: 'error', error: '正则无效: ' + e.message }; }
  const hits = [];
  walk(PKG, '', hits, re);
  return { status: 'success', output: hits.length ? hits.slice(0, 30).join('\n') : '（0 个匹配）' };
}
const tools = [
  { name: 'read', description: '读取本地工程内文件的文本内容（用于审查）。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep', description: '在本地工程源码内按关键词(支持正则)检索，返回 相对路径:行号。', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];
const resultFence = ({ name, status, output, error }) => '```json\n' + JSON.stringify(status === 'error' ? { mcp_action: 'result', name, status, error: String(error || '').slice(0, 1400) } : { mcp_action: 'result', name, status, output: String(output || '').slice(0, 1400) }) + '\n```';
const dispatcher = { read: ({ path: p }) => runRead(p), grep: ({ query }) => runGrep(query) };

let timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); process.exit(2); }, 240_000);
const callsSeen = {};
try {
  const conn = await driver.connect();
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }
  const prompt = '请审查本项目依赖的安全性：先调用 read 读取 package.json，再用 grep 检索源码中疑似硬编码的 token/secret/password 关键词。全部完成后给一行简洁结论并收束。';
  let running = await driver.sendTurn('multi-loop', serializeFirstTurn({ messages: [{ role: 'user', content: prompt }], tools, model: { id: 'deepseek' } }), { fresh: true, model: 'deepseek' });
  let turns = 0;
  while (turns < 5) {
    turns++;
    const p = parseAgentReply(running?.text ?? '');
    if (!p.calls.length) break;
    const results = p.calls.map(c => { callsSeen[c.name] = (callsSeen[c.name] || 0) + 1; return resultFence(dispatcher[c.name]?.(c.arguments || {}) ?? { status: 'error', name: c.name, error: '未知工具' }); });
    running = await driver.sendTurn('multi-loop', results.join('\n') + '\n请继续或基于所有真实结果给一行安全结论并收束，不要再调用工具。', { fresh: false, model: 'deepseek' });
  }
  const finalText = (running.text || '').trim();
  console.log('calls=', JSON.stringify(callsSeen));
  console.log('summary=', finalText.slice(0, 90).replace(/\n/g, ' '));
  const okRead = callsSeen.read >= 1;
  const okGrep = callsSeen.grep >= 1;
  const okSummary = finalText.length > 20;
  console.log(`RESULT ${okRead && okGrep && okSummary ? 'PASS' : 'FAIL'}  read=${okRead} grep=${okGrep} summary=${okSummary}`);
  await driver.resetConversation('multi-loop');
} catch (e) {
  console.error('ERR:', e?.message, e?.code ?? '');
} finally {
  clearTimeout(timer);
  try { await driver.close(); } catch {}
}