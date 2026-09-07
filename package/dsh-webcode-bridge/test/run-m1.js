// run-m1.js — automated M1 gate (v4, no browser): the full DSH⇄webcode loop
// in-process with a scripted driver standing in for the web page.
//
// Session mode (one web conversation per DSH session, webcode-style):
//   1. apply(ctx) with mock services → provider + adapter + relay + same-origin
//      /__webcode/* routes on a mock DSH webServer
//   2. consent gate + CSRF/host guards
//   3. turn 1 → preset+opening message into a FRESH web conversation
//   4. web replies with mcp_action call fences → adapter replays native DSH
//      tool-call chunks; the tool REALLY runs (reads PLAN.md)
//   5. turn 2 carries ONLY the tool-result increment (no preset/history re-flatten)
//      → final text streams back
//   6. history shrink (rewind) → conversation restart with full re-flatten
//   7. web-side control plane: sessions / branch-aware history / import
//   8. token endpoint + public status hygiene

import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const repo = dirname(dirname(dirname(here))); // workspace root
let failures = 0;

const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures += 1;
};

// ---- scripted driver (stands in for the playwright web driver) ----------
const turns = []; // every message the "web page" received: {key, message, fresh}
let replyScript = ['...'];
let replyIdx = 0;

function scriptedDriver() {
  return {
    async sendTurn(key, message, { fresh = false, images } = {}) {
      turns.push({ key, message, fresh, images });
      const text = replyScript[Math.min(replyIdx++, replyScript.length - 1)];
      return { text, sessionId: fresh ? 'sess-web-' + turns.filter((t) => t.fresh).length : 'sess-web-1', metrics: { endToEndMs: 1200, firstResponseMs: 300, thinkingMs: 500, responseMs: 900 } };
    },
    async sendPrompt(message) { turns.push({ key: '__adhoc__', message, fresh: true }); return { text: 'adhoc-reply', sessionId: 'sess-adhoc' }; },
    async resetConversation() {},
    async listSessions() {
      return { ok: true, sessions: [
        { id: 'sess-web-1', title: '网页自动命名的会话标题（实时）', updatedAt: Date.now() - 60_000 },
        { id: 'sess-old', title: '更早的网页会话', updatedAt: Date.now() - 3_600_000 },
      ] };
    },
    async fetchHistory(sessionId) {
      if (sessionId !== 'sess-web-1') throw new Error('invalid sessionId');
      // main line m0→m1→m2→m3 plus one regeneration branch (mb) off m0
      return { ok: true, sessionId, messages: [
        { id: 'm0', role: 'user', content: '第一条', parentId: null },
        { id: 'm1', role: 'assistant', content: '主线回答 v1', parentId: 'm0' },
        { id: 'mb', role: 'assistant', content: '重新生成的分支回答', parentId: 'm0' },
        { id: 'm2', role: 'user', content: '继续', parentId: 'm1' },
        { id: 'm3', role: 'assistant', content: '主线最终回答', parentId: 'm2' },
      ] };
    },
    async screenshotBase64({ withMeta } = {}) { return withMeta ? { base64: Buffer.from('fake-jpeg').toString('base64'), clip: { x: 48, y: 0, width: 592, height: 900 }, viewport: { width: 640, height: 900 } } : Buffer.from('fake-jpeg').toString('base64'); },
    async getToken() { return 'fake-token-never-log'; },
    status() { return { running: true, busy: false, loggedIn: true, needLogin: false, profileDir: 'fake', lastTurn: { sessionId: 'sess-web-1', at: 1 } }; },
    openLogin: async () => {},
    importStorageFromProfile: async () => ({ loggedIn: true }),
    close: async () => {},
  };
}

// ---- mock DSH host services ---------------------------------------------
function mockCtx() {
  const registered = { providers: [], adapter: null, routes: new Map() };
  const llm = {
    registerConfigurableProviders(list) { registered.providers.push(...list); },
    registerAdapter(ids, adapter) { registered.adapter = adapter; registered.adapterIds = [...ids]; },
  };
  const persisted = { created: [], appended: {}, attached: null };
  const sessionPersistence = {
    async create(meta) { persisted.created.push(meta); },
    async append(sid, events) { persisted.appended[sid] = events; },
  };
  const workspaces = [{ id: 'ws-1', title: '演示工作区', path: 'D:/ws', attachSession: async (sid) => { persisted.attached = sid; } }];
  const workspaceRegistry = { list: () => workspaces.map(({ id, title, path }) => ({ id, title, path })), get: (id) => workspaces.find((w) => w.id === id) || null };
  const webServer = { register: ({ path, handler }) => { registered.routes.set(path, handler); } };
  const ctx = {
    llm,
    get(name) {
      if (name === 'llm') return llm;
      if (name === 'sessionPersistence') return sessionPersistence;
      if (name === 'workspaceRegistry') return workspaceRegistry;
      if (name === 'webServer') return webServer;
      return undefined;
    },
  };
  return { ctx, registered, persisted };
}

// ---- harness helpers -----------------------------------------------------
function mockRes() {
  const headers = {};
  let statusCode = 0;
  const chunks = [];
  const res = {
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    writeHead(code, hs = {}) { statusCode = code; Object.assign(headers, Object.fromEntries(Object.entries(hs).map(([k, v]) => [k.toLowerCase(), v]))); return res; },
    end(body) { if (body) chunks.push(body); res.finished = true; },
    write(body) { chunks.push(body); },
    on() { return res; },
    destroy() {},
  };
  Object.defineProperty(res, 'statusCode', { get: () => statusCode, set: (v) => { statusCode = v; } });
  res.body = () => chunks.join('');
  return res;
}
function mockReq(method, { headers = {}, body = null } = {}) {
  const req = { method, headers: { host: '127.0.0.1:45999', ...headers } };
  req.on = (ev, cb) => {
    if (ev === 'data' && body) cb(Buffer.from(body));
    if (ev === 'end') cb();
    return req;
  };
  return req;
}

let fail = 0;
try {
  const { apply } = await import(pathToFileURL(join(pkg, 'lib', 'index.js')).href);
  const driver = scriptedDriver();
  const { ctx, registered, persisted } = mockCtx();

  const consentDir = mkdtempSync(join(tmpdir(), 'webcode-m1-'));
  const disposer = apply(ctx, {
    port: 0, host: '127.0.0.1', requireConsent: true,
    driver, profileDir: consentDir,
  });

  ok('provider adapter registered as route "webcode"', registered.adapterIds?.includes('webcode'));
  ok('provider NOT double-registered as configurable', registered.providers.length === 0);
  ok('adapter registered', typeof registered.adapter?.stream === 'function');
  ok('model selector lists multiple models', (await registered.adapter.listModels('webcode')).length >= 2);
  ok('reasoner model resolvable', (await registered.adapter.resolveModel('webcode', 'deepseek-reasoner')).id === 'deepseek-reasoner');
  ok('unknown model rejected', await registered.adapter.resolveModel('webcode', 'nope-model').then(() => false, () => true));
  ok('same-origin routes mounted', ['/__webcode/status', '/__webcode/consent', '/__webcode/sessions', '/__webcode/history', '/__webcode/import', '/__webcode/preview', '/__webcode/settings'].every((p) => registered.routes.has(p)));

  async function callRoute(path, req, res) {
    const handler = registered.routes.get(path);
    if (!handler) throw new Error('no route ' + path);
    await handler(req, res);
    return res;
  }

  // ---- consent gate + CSRF guards ----
  const st0 = await callRoute('/__webcode/status', mockReq('GET'), mockRes());
  ok('status: consent closed', JSON.parse(st0.body()).relay.consent === false);

  const csrf = await callRoute('/__webcode/consent', mockReq('POST', { headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, body: JSON.stringify({ accepted: true }) }), mockRes());
  ok('cross-site control rejected (403)', csrf.statusCode === 403, 'status=' + csrf.statusCode);
  const rebind = await callRoute('/__webcode/consent', mockReq('POST', { headers: { host: 'evil.example:80' }, body: JSON.stringify({ accepted: true }) }), mockRes());
  ok('non-loopback Host rejected (403)', rebind.statusCode === 403, 'status=' + rebind.statusCode);
  const evilLocal = await callRoute('/__webcode/consent', mockReq('POST', { headers: { origin: 'http://127.0.0.1:9999' }, body: JSON.stringify({ accepted: true }) }), mockRes());
  ok('foreign loopback Origin rejected (403)', evilLocal.statusCode === 403, 'status=' + evilLocal.statusCode);

  const c1 = await callRoute('/__webcode/consent', mockReq('POST', { headers: { origin: 'http://127.0.0.1:3080' }, body: JSON.stringify({ accepted: true }) }), mockRes());
  ok('consent accepted (allowlisted origin)', JSON.parse(c1.body()).consent === true);

  // ---- turn 1: preset + opening message into a FRESH web conversation ----
  const adapter = registered.adapter;
  const collect = async (gen) => { const out = []; for await (const ch of gen) out.push(ch); return out; };
  const tools = [{ name: 'read', description: '读取工作区文件内容', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
  const baseOptions = (messages) => ({
    system: '你是 DSH 的助手，工作区在本地。',
    messages,
    tools,
    sessionId: 'dsh-session-A',
  });

  replyScript = ['先看这个：\n```json\n{"mcp_action":"call","name":"read","purpose":"查看 PLAN 标题","arguments":{"path":"PLAN.md"}}\n```'];
  const r1 = await collect(adapter.stream(baseOptions([
    { role: 'user', content: [{ type: 'text', text: '请读取 PLAN.md 的标题行' }] },
  ])));
  const t1 = turns[0] || {};
  ok('turn1: fresh conversation used', t1.fresh === true && t1.key === 'dsh-session-A', JSON.stringify({ key: t1.key, fresh: t1.fresh }));
  ok('turn1: preset injected (system)', String(t1.message).includes('[系统指令]') && String(t1.message).includes('工作区在本地'));
  ok('turn1: tools+protocol injected', String(t1.message).includes('# 可用本地工具') && String(t1.message).includes('mcp_action') && String(t1.message).includes('read'));
  ok('turn1: opening user message present', String(t1.message).includes('请读取 PLAN.md 的标题行'));

  const types1 = r1.map((c) => c.type).join(',');
  ok('turn1: tool-call chunk sequence', /^block-start,tool-call-delta,block-end(,block-start,tool-call-delta,block-end)?,usage,finish$/.test(types1), types1);
  const callChunk = r1.find((c) => c.type === 'tool-call-delta');
  ok('turn1: tool name parsed (mcp_action)', callChunk?.name === 'read', callChunk?.name);
  ok('turn1: harness tool-loop finish reason', r1.at(-1)?.reason?.kind === 'tool-calls');
  ok('turn1: args parsed', JSON.parse(callChunk?.argumentsDelta || '{}').path === 'PLAN.md', callChunk?.argumentsDelta);

  // ---- the tool really runs: read PLAN.md from disk ----
  const planText = await readFile(join(repo, 'PLAN.md'), 'utf8');
  ok('tool executed for real (file read)', planText.includes('# Harness Web Bridge'));

  // ---- turn 2: ONLY the tool-result increment lands in the SAME conversation ----
  replyScript = ['PLAN.md 标题是 Harness Web Bridge。任务完成。[E2E-MARKER-FROM-PLAN]'];
  const r2 = await collect(adapter.stream(baseOptions([
    { role: 'user', content: [{ type: 'text', text: '请读取 PLAN.md 的标题行' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"PLAN.md"}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: planText.slice(0, 2000) }] }] },
  ])));
  const types2 = r2.map((c) => c.type).join(',');
  ok('turn2: text chunk sequence', types2 === 'block-start,text-delta,block-end,usage,finish', types2);
  const finalText = r2.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  ok('turn2: final answer streamed', finalText.includes('E2E-MARKER-FROM-PLAN'), finalText.slice(0, 60));

  const t2 = turns[1] || {};
  ok('turn2: SAME conversation (not fresh)', t2.fresh === false && t2.key === 'dsh-session-A');
  ok('turn2: increment ONLY — mcp_action result fence', String(t2.message).includes('"mcp_action"') && String(t2.message).includes('"name"') && String(t2.message).includes('"status": "success"'), String(t2.message).slice(0, 90));
  ok('turn2: tool output carried', String(t2.message).includes('# Harness Web Bridge'));
  ok('turn2: NO preset repetition', !String(t2.message).includes('[系统指令]'));
  ok('turn2: NO history re-flatten', !String(t2.message).includes('请读取 PLAN.md 的标题行'));

  // ---- rewind divergence: history shrink → fresh restart ----
  replyScript = ['重启后回答。'];
  await collect(adapter.stream(baseOptions([
    { role: 'user', content: [{ type: 'text', text: '重新开始：只回答这一句' }] },
  ])));
  const t3 = turns[2] || {};
  ok('rewind: fresh restart after shrink', t3.fresh === true && String(t3.message).includes('重新开始：只回答这一句'), `fresh=${t3.fresh}`);

  // ---- multi-call reply → multiple native tool-call chunks ----
  replyScript = ['```json\n{"mcp_action":"call","name":"read","purpose":"a","arguments":{"path":"A"}}\n```\n```json\n{"mcp_action":"call","name":"read","purpose":"b","arguments":{"path":"B"}}\n```'];
  const r4 = await collect(adapter.stream(baseOptions([
    { role: 'user', content: [{ type: 'text', text: '连续读两个文件' }] },
  ])));
  const deltas = r4.filter((c) => c.type === 'tool-call-delta');
  ok('multi-call: two native tool calls replayed', deltas.length === 2 && deltas[0].name === 'read' && JSON.parse(deltas[1].argumentsDelta).path === 'B', deltas.map((d) => d.name).join(','));

  // ---- plain text passes through when there are no call fences ----
  replyScript = ['普通文字回答，没有工具。'];
  const r5 = await collect(adapter.stream(baseOptions([{ role: 'user', content: [{ type: 'text', text: '纯文本' }] }])));
  ok('plain text streams when no call fences', r5.filter((c) => c.type === 'text-delta').map((c) => c.text).join('').includes('普通文字回答'));

  // ---- aux title call stays local (no web send) ----
  const beforeAux = turns.length;
  await collect(adapter.stream({ system: '生成会话标题', messages: [{ role: 'user', content: [{ type: 'text', text: '帮我给会话起个标题' }] }], purpose: 'session-title' }));
  ok('title aux call intercepted locally', turns.length === beforeAux);

  // ---- web-side control plane: naming feed / history / import ----
  const sess = await callRoute('/__webcode/sessions', mockReq('POST', { body: JSON.stringify({ count: 20 }) }), mockRes());
  const sessBody = JSON.parse(sess.body());
  ok('sessions list (web naming feed)', sessBody.ok && sessBody.sessions[0].title.includes('实时'), sessBody.sessions?.[0]?.title);

  const hist = await callRoute('/__webcode/history', mockReq('POST', { body: JSON.stringify({ sessionId: 'sess-web-1' }) }), mockRes());
  const histBody = JSON.parse(hist.body());
  ok('history with branch detection', histBody.ok && histBody.count === 5 && histBody.messages.length === 4 && histBody.branchCount === 1, `count=${histBody.count}, line=${histBody.messages.length}, branch=${histBody.branchCount}`);

  const imp = await callRoute('/__webcode/import', mockReq('POST', { body: JSON.stringify({ sessionId: 'sess-web-1', workspaceId: 'ws-1' }) }), mockRes());
  const impBody = JSON.parse(imp.body());
  ok('import → DSH session persisted', impBody.ok && impBody.messageCount === 4 && impBody.attached === true, JSON.stringify(impBody).slice(0, 120));
  const events = persisted.appended[impBody.sessionId] || [];
  const evTypes = events.map((e) => e.type).join(',');
  ok('session event stream valid', evTypes.startsWith('session/title,') && evTypes.includes('user/message') && evTypes.endsWith('session/end-seed'), evTypes.slice(0, 80));

  // ---- token endpoint shape (mirror seeding; never echoed in errors) ----
  ok('token export route removed', !registered.routes.has('/__webcode/token'));

  // ---- settings-page prompt-template preview ----
  const sset0 = await callRoute('/__webcode/settings', mockReq('GET'), mockRes());
  ok('settings route: empty global prompt by default', JSON.parse(sset0.body()).extraPrompt === '', JSON.parse(sset0.body()).extraPrompt);
  const sset1 = await callRoute('/__webcode/settings', mockReq('POST', { body: JSON.stringify({ extraPrompt: '先读文件再下结论' }) }), mockRes());
  ok('settings route: global prompt saved', JSON.parse(sset1.body()).extraPrompt === '先读文件再下结论');
  replyScript = ['已按全局指令执行。'];
  await collect(adapter.stream({ ...baseOptions([{ role: 'user', content: [{ type: 'text', text: '按全局指令执行' }] }]), sessionId: 'dsh-session-global' }));
  const tGlob = turns[turns.length - 1] || {};
  ok('global prompt injected into fresh first turn', String(tGlob.message).includes('[全局指令]') && String(tGlob.message).includes('先读文件再下结论'), String(tGlob.message).slice(0, 80));
  const preset = await callRoute('/__webcode/preset', mockReq('GET'), mockRes());
  const presetBody = JSON.parse(preset.body());
  ok('preset route: last first-turn prompt', presetBody.ok === true && String(presetBody.prompt).includes('[系统指令]') && String(presetBody.prompt).includes('mcp_action') && String(presetBody.prompt).length > 100, JSON.stringify({ model: presetBody.model, promptLen: (presetBody.prompt||'').length }));

  // ---- vision: image attachment rides into the web turn ----
  replyScript = ['图中内容是一张测试图。'];
  const rImg = await collect(adapter.stream({ system: '你是 DSH 的助手。', sessionId: 'dsh-session-vision', messages: [
    { role: 'user', content: [
      { type: 'text', text: '看看这张图' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: Buffer.from('hello-image').toString('base64') } },
    ] },
  ] }));
  const tImg = turns.at(-1);
  ok('vision: image decoded into web turn', Array.isArray(tImg.images) && tImg.images.length === 1 && tImg.images[0].contentType === 'image/png' && Buffer.from(tImg.images[0].data, 'base64').toString() === 'hello-image', JSON.stringify(tImg.images || null)?.slice(0, 120));
  ok('vision: reply streamed', rImg.some(c => c.type === 'text-delta'));

  // ---- parallel agents: same DSH session, own web conversation ----
  replyScript = ['并行代理响应'];
  await collect(adapter.stream({
    system: '你是 DSH 的助手。', messages: [{ role: 'user', content: [{ type: 'text', text: '并行代理任务' }] }],
    tools, sessionId: 'dsh-session-A', agentId: 'sub-agent-1',
  }));
  const tAgent = turns.at(-1);
  ok('parallel agents: agent-qualified web conversation', tAgent.key === 'dsh-session-A::sub-agent-1' && tAgent.fresh === true, JSON.stringify({ key: tAgent.key, fresh: tAgent.fresh }));
  // ---- relay healthy after loop ----
  const relayStatus = await callRoute('/__webcode/status', mockReq('GET'), mockRes());
  const rs = JSON.parse(relayStatus.body());
  ok('relay healthy after loop', rs.relay.running === true && rs.relay.busy === false, JSON.stringify(rs.relay));
  ok('same-origin status carries driver facts', rs.driver && rs.driver.running === true);

  await disposer();
  ok('disposer stops relay + driver', true);
} catch (err) {
  fail = 1;
  console.log('  ❌ M1 harness failure:', err.stack || err.message);
}

console.log(failures === 0 && fail === 0 ? '\nM1 RESULT: PASS' : `\nM1 RESULT: FAIL (${failures})`);
process.exit(failures === 0 && fail === 0 ? 0 : 1);
