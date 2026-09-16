// run-m4-security-review.js — 长自用案例：让网页模型对"审查本项目安全性"
// 连续三次真实工具调用（read package.json → search 依赖 → grep 鉴权模式），
// 每次结果回填后仅发增量（不重放历史/不重复 preset），最后流式返回安全总结。
//
// 无浏览器、无登录：用脚本化的 sendTurn 代替网页，但工具（读文件）真实在
// 本地执行。验证"每个工具的实际调用"在多轮循环下真实落地。

import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const repo = dirname(dirname(dirname(here))); // workspace root
let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures += 1;
};

// ---- 脚本化网页驱动：按顺序吐"工具调用围栏 → 工具调用围栏 → 最终文本" ----
const turns = [];            // 网页收到的每一轮：{key, message, fresh}
let script = [];             // 预设的网页回复序列
let idx = 0;
const driver = {
  async sendTurn(key, message, { fresh = false, images } = {}) {
    turns.push({ key, message, fresh, images });
    const text = script[Math.min(idx++, script.length - 1)];
    return { text, sessionId: fresh ? 'sess-sec-' + turns.filter(t => t.fresh).length : 'sess-sec-1', metrics: { endToEndMs: 900, firstResponseMs: 260, thinkingMs: 420, responseMs: 640 } };
  },
  async sendPrompt(message) { turns.push({ key: '__adhoc__', message, fresh: true }); return { text: 'adhoc', sessionId: 's-adhoc' }; },
  async resetConversation() {}, listSessions() { return { ok: true, sessions: [] }; },
  async fetchHistory() { return { ok: true, messages: [], branchCount: 0 }; },
  async getToken() { return null; },
  status() { return { running: true, busy: false, loggedIn: true, needLogin: false, profileDir: 'fake', lastTurn: null }; },
  openLogin: async () => {}, importStorageFromProfile: async () => ({ loggedIn: true }), close: async () => {},
};

// ---- mock DSH host（复用 run-m1 的最小形态） ----
function mockCtx() {
  const reg = { adapter: null, routes: new Map() };
  const llm = { registerConfigurableProviders() {}, registerAdapter(_ids, adapter) { reg.adapter = adapter; } };
  const webServer = { register: ({ path, handler }) => { reg.routes.set(path, handler); } };
  return { ctx: { llm, get: (n) => (n === 'webServer' ? webServer : null) }, reg };
}

function mockRes() {
  const headers = {}; let statusCode = 0; const chunks = [];
  const res = {
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    writeHead(code, hs = {}) { statusCode = code; Object.assign(headers, Object.fromEntries(Object.entries(hs).map(([k, v]) => [k.toLowerCase(), v]))); return res; },
    end(b) { if (b) chunks.push(b); res.finished = true; }, write(b) { chunks.push(b); }, on() { return res; }, destroy() {},
  };
  Object.defineProperty(res, 'statusCode', { get: () => statusCode, set: (v) => { statusCode = v; } });
  res.body = () => chunks.join('');
  return res;
}
function mockReq(method, { headers = {}, body = null } = {}) {
  const req = { method, headers: { host: '127.0.0.1:46111', ...headers } };
  req.on = (ev, cb) => { if (ev === 'data' && body) cb(Buffer.from(body)); if (ev === 'end') cb(); return req; };
  return req;
}

// 本地工具执行器：收到 {name, arguments} 就在工作区真实执行。
const executed = [];
function runTool(name, args) {
  if (name !== 'read' && name !== 'search' && name !== 'grep') throw new Error('unknown tool ' + name);
  if (name === 'read') {
    const rel = String(args.path || '').replace(/^\/+/, '');
    const p = join(pkg, rel);
    const text = readFileSync(p, 'utf8');
    executed.push({ name, args, chars: text.length });
    return { name, status: 'success', output: text.slice(0, 2400) };
  }
  if (name === 'search') {
    const matches = readdirSync(repo).filter((n) => new RegExp(String(args.pattern || ''), 'i').test(n));
    executed.push({ name, args, matches: matches.length });
    return { name, status: 'success', output: JSON.stringify(matches.slice(0, 60)) };
  }
  // grep：在工作区根扫描 secrets/token 特征
  const pat = new RegExp(String(args.pattern || ''), 'img');
  const hits = [];
  for (const f of ['package.json', 'README.md', 'PLAN.md']) {
    try {
      const text = readFileSync(join(repo, f), 'utf8');
      for (const m of text.matchAll(pat)) hits.push({ file: f, line: m.index, sample: (m[0] || '').slice(0, 40) });
    } catch {}
  }
  executed.push({ name, args, hits: hits.length });
  return { name, status: 'success', output: JSON.stringify(hits.slice(0, 30)) };
}

let fail = 0;
try {
  const { apply } = await import(pathToFileURL(join(pkg, 'lib', 'index.js')).href);
  const { ctx, reg } = mockCtx();
  const consentDir = mkdtempSync(join(tmpdir(), 'webcode-m4-'));
  const disposer = apply(ctx, { port: 0, host: '127.0.0.1', requireConsent: false, driver, profileDir: consentDir });
  const adapter = reg.adapter;
  ok('adapter registered', typeof adapter?.stream === 'function');

  const tools = [
    { name: 'read', description: '读取工作区文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'search', description: '列出工作区匹配模式的文件', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
    { name: 'grep', description: '在工作区源码中搜索正则', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  ];
  const collect = async (gen) => { const out = []; for await (const ch of gen) out.push(ch); return out; };

  // 第 1 轮：用户发起长自用"安全性审查"
  const msgQ = [{ role: 'user', content: [{ type: 'text', text: '请审查本项目的安全性：先读 package.json 看依赖，再列出 Risky 相关文件，最后搜索 token 泄露特征。' }] }];
  const messages = [...msgQ];

  script = [
    // 首条围栏故意用"转义 JSON 字符串"形式的 arguments（DeepSeek 网页真实输出风格），
    // 验证 parseAgentReply 能把字符串还原为对象并让 read 工具真实执行。
    '```json\n' + JSON.stringify({ mcp_action: 'call', name: 'read', purpose: '读取依赖配置以审查安全性', arguments: JSON.stringify({ path: 'package.json' }) }) + '\n```',
    '```json\n{"mcp_action":"call","name":"search","purpose":"定位安全审查相关文档","arguments":{"pattern":"readme|plan"}}\n```',
    '```json\n{"mcp_action":"call","name":"grep","purpose":"扫描疑似 token 泄露","arguments":{"pattern":"(token|secret|api[_-]?key)"}}\n```',
    '安全审查结论：依赖使用 playwright-core 与 ws（playwright 仅本机驱动网页，不向外部暴露）；未发现明文 token 存储；建议保持 Harness 原生审批并定期轮换登录态。[SEC-SUMMARY-OK]',
  ];

  // 回合 1 → 工具 read
  let chunks = await collect(adapter.stream({ system: '你是 DSH 的安全审查助手。', sessionId: 'sec-session', messages, tools }));
  let calls = chunks.filter(c => c.type === 'tool-call-delta');
  ok('R1: 网页发起 read 工具', calls.length === 1 && calls[0].name === 'read', calls.map(c => c.name).join(','));
  ok('R1: 参数解析完整', JSON.parse(calls[0].argumentsDelta).path === 'package.json');
  const t1 = turns[0] || {};
  ok('R1: 首轮 fresh 且注入 preset+用户长案例', t1.fresh === true && t1.key === 'sec-session' && String(t1.message).includes('审查本项目的安全性'));
  // 执行工具，结果回填
  let r = runTool('read', JSON.parse(calls[0].argumentsDelta));
  messages.push({ role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: JSON.stringify({ path: 'package.json' }) }] });
  messages.push({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: r.output }] }] });

  // 回合 2 → 工具 search
  chunks = await collect(adapter.stream({ system: '你是 DSH 的安全审查助手。', sessionId: 'sec-session', messages, tools }));
  calls = chunks.filter(c => c.type === 'tool-call-delta');
  ok('R2: 继发 search 工具', calls.length === 1 && calls[0].name === 'search', calls.map(c => c.name).join(','));
  const t2 = turns[1] || {};
  ok('R2: 非 fresh（同会话）且仅发增量', t2.fresh === false && !String(t2.message).includes('[系统指令]') && !String(t2.message).includes('审查本项目安全性') && String(t2.message).includes('"status": "success"'));
  ok('R2: 上一工具结果被携带', String(t2.message).includes('playwright-core'));
  r = runTool('search', JSON.parse(calls[0].argumentsDelta));
  messages.push({ role: 'assistant', content: [{ type: 'tool-call', id: 'call-2', name: 'search', arguments: JSON.stringify({ pattern: 'readme|plan' }) }] });
  messages.push({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'text', text: r.output }] }] });

  // 回合 3 → 工具 grep
  chunks = await collect(adapter.stream({ system: '你是 DSH 的安全审查助手。', sessionId: 'sec-session', messages, tools }));
  calls = chunks.filter(c => c.type === 'tool-call-delta');
  ok('R3: 再继发 grep 工具', calls.length === 1 && calls[0].name === 'grep', calls.map(c => c.name).join(','));
  r = runTool('grep', JSON.parse(calls[0].argumentsDelta));
  messages.push({ role: 'assistant', content: [{ type: 'tool-call', id: 'call-3', name: 'grep', arguments: JSON.stringify({ pattern: '(token|secret|api[_-]?key)' }) }] });
  messages.push({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-3', content: [{ type: 'text', text: r.output }] }] });

  // 回合 4 → 最终文本总结
  chunks = await collect(adapter.stream({ system: '你是 DSH 的安全审查助手。', sessionId: 'sec-session', messages, tools }));
  const finalText = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
  ok('R4: 最终安全总结流式返回', finalText.includes('SEC-SUMMARY-OK'), finalText.slice(0, 40));
  ok('R4: 结束原因为 stop', chunks.at(-1)?.type === 'finish' && chunks.at(-1)?.reason?.kind === 'stop');

  // 每轮只发一条网页请求（4 个回合），无额外重放
  ok('全程 4 次网页请求（无额外重放）', turns.length === 4, 'turns=' + turns.length);
  ok('3 个工具真实本地执行', executed.length === 3, executed.map(e => e.name).join(','));
  ok('read 工具读到真实 package.json', executed[0]?.chars > 100);
  ok('search 工具命中真实文件', executed[1]?.matches >= 1);
  ok('grep 工具扫描到鉴权关键词', executed[2]?.hits >= 1);

  await disposer();
} catch (err) {
  fail = 1;
  console.log('  ❌ M4 harness failure:', err.stack || err.message);
}
console.log(failures === 0 && fail === 0 ? '\nM4 RESULT: PASS' : `\nM4 RESULT: FAIL (${failures})`);
process.exit(failures === 0 && fail === 0 ? 0 : 1);