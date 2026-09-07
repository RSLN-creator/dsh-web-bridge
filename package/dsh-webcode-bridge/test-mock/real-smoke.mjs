// real-smoke.mjs — one-shot real DeepSeek web smoke: expert mode + native tool loop.
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn, parseAgentReply } from '../lib/agent-preset.js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/9_Code_Workspace/dsh-webcode-bridge';
const PKG = path.join(ROOT, 'package', 'dsh-webcode-bridge');
const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/',
  profileDir: ROOT + '/.edge-real-profile',
  headless: true,
  requestTimeoutMs: 120_000,
  logger: console,
});

const tools = [
  { name: 'read', description: '读取本地工程内文件的文本内容。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep', description: '在本地工程源码内按关键词(支持正则)检索，返回 相对路径:行号。', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];

function runTool(name, args) {
  if (name === 'read') {
    const p = path.resolve(PKG, String(args?.path || ''));
    if (!fs.existsSync(p)) return { status: 'error', error: '文件不存在: ' + p };
    return { status: 'success', output: fs.readFileSync(p, 'utf8').slice(0, 1500) };
  }
  if (name === 'grep') {
    let body = String(args?.query || '');
    let flags = 'i';
    const m = /^\(\?([imsx]+)\)/.exec(body);
    if (m) { flags = m[1].replace(/[g]/g, ''); body = body.slice(m[0].length); }
    let re; try { re = new RegExp(body, flags); } catch (e) { return { status: 'error', error: '正则无效: ' + e.message }; }
    const hits = [];
    const walk = (d, depth) => {
      if (depth > 3 || hits.length >= 20) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp, depth + 1);
        else if (/\.(js|mjs|cjs|json|md)$/i.test(e.name)) {
          try { const txt = fs.readFileSync(fp, 'utf8'); if (re.test(txt)) hits.push(path.relative(PKG, fp)); } catch {}
        }
      }
    };
    walk(PKG, 0);
    return { status: 'success', output: hits.length ? hits.join('\n') : '（0 个匹配）' };
  }
  return { status: 'error', error: '未知工具: ' + name };
}
const resultFence = (r) => '```json\n' + JSON.stringify(r) + '\n```';

const timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); process.exit(2); }, 300_000);
try {
  const conn = await driver.connect();
  console.log('connect loggedIn=', conn.loggedIn);
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }

  const prompt = '请审查本项目安全性：先调用 read 读取 package.json，再用 grep 搜索源码中硬编码的 token/secret/password。完成后给一行安全结论并收束。';
  console.log('R1: injecting preset (expert mode)');
  let r = await driver.sendTurn('real-smoke-1', serializeFirstTurn({ messages: [{ role: 'user', content: prompt }], tools, model: { id: 'deepseek' } }), { fresh: true, model: 'deepseek' });
  console.log('R1 metrics=', JSON.stringify(r.metrics));
  let turns = 0;
  const seen = {};
  while (turns < 5) {
    turns++;
    const p = parseAgentReply(r?.text ?? '');
    if (!p.calls.length) break;
    console.log('R' + turns + ' calls=', p.calls.map(c => c.name).join(','));
    const results = p.calls.map(c => { seen[c.name] = (seen[c.name] || 0) + 1; return resultFence(runTool(c.name, c.arguments || {})); });
    r = await driver.sendTurn('real-smoke-1', results.join('\n') + '\n请基于真实结果给一行安全结论并收束，不要再调用工具。', { fresh: false, model: 'deepseek' });
  }
  const finalText = (r?.text || '').trim();
  console.log('seen=', JSON.stringify(seen));
  console.log('summary=', finalText.slice(0, 120).replace(/\n/g, ' '));
  const ok = seen.read >= 1 && seen.grep >= 1 && finalText.length > 20;
  console.log(ok ? 'REAL-SMOKE PASS' : 'REAL-SMOKE FAIL');
  await driver.resetConversation('real-smoke-1');
} catch (e) {
  console.error('REAL-SMOKE ERROR:', e?.message, e?.code ?? '');
} finally {
  clearTimeout(timer);
  try { await driver.close(); } catch {}
}
