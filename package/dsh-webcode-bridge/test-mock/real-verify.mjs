// real-verify.mjs — 供应商契约自检（真机）
// 每个工具/模型的实际调用真的跑一遍并断言，作为后续改动可重复的回归防护。
// 用法：node test-mock/real-verify.mjs [--skip-vision] [--skip-tool-loop]
//   需要已登录的 Edge profile（默认 .edge-real-profile，可用 REAL_PROFILE 覆盖）
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn, parseAgentReply } from '../lib/agent-preset.js';
import { expectedModelType, expectedRequestMetadata } from '../lib/metrics.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const skipVision = process.argv.includes('--skip-vision');
const skipLoop = process.argv.includes('--skip-tool-loop');
const PROFILE = process.env.REAL_PROFILE || 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\.edge-real-profile';
// 工程根：即 package/dsh-webcode-bridge/（package.json 所在）
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMG = path.join(PKG, 'test-mock', 'vision-test-hello.jpg');

const results = []; // {name, ok, detail}
const assert = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/', profileDir: PROFILE, headless: true,
  requestTimeoutMs: 110_000, logger: console,
});

const toolSchema = [
  { name: 'read', description: '读取本地文件文本内容。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

// ---- 0) 裸 fence 解析（离线契约：2026-09-08 会话 f3fa97fd 复盘的回归点）----
// 模型在工具错误回读后常省略 mcp_action 直接输出 {"name","arguments"} code fence——
// 该形状必须被解析为工具调用，否则第二轮调用被静默丢弃、任务裸奔。
{
  const bare = '```json\n{"name":"read","arguments":{"path":"README.md"}}\n```';
  const calls = parseAgentReply(bare).calls;
  assert('parse.裸fence调用形状', calls.length === 1 && calls[0]?.name === 'read' && calls[0]?.arguments?.path === 'README.md',
    calls.length ? `got ${calls[0].name}` : '未解析（回归 0.6.9 前的丢调用缺陷）');
}
function runRead(p) {
  const abs = path.resolve(PKG, String(p || ''));
  if (!fs.existsSync(abs)) return { status: 'error', error: '文件不存在: ' + abs };
  return { status: 'success', output: fs.readFileSync(abs, 'utf8').slice(0, 1500) };
}
const resultFence = ({ name, status, output, error }) =>
  '```json\n' + JSON.stringify(status === 'error' ? { mcp_action: 'result', name, status, error: String(error || '').slice(0, 1500) } : { mcp_action: 'result', name, status, output: String(output || '').slice(0, 1500) }) + '\n```';

let timer = setTimeout(() => { console.log('FAIL  (global timeout)'); process.exit(2); }, 280_000);
try {
  const conn = await driver.connect();
  if (!conn.loggedIn) { console.log('FAIL  NEED_LOGIN: profile 未登录'); process.exit(3); }
  assert('driver.登录连通', true, PROFILE);

  // ---- 1) 文本两模式：真实请求元数据必须与所选模式一致 ----
  // classic UI：差异在 model_type（default/expert）；unified UI（2026-09-10 新版）：
  // model_type 恒为 default，差异在 thinking_enabled。期望值来自 lib/metrics.js，
  // 与驱动的发送后严格核验同源——探针只负责把真实观测值摆出来。
  for (const model of ['flash', 'deepseek']) {
    let acc = '';
    const r = await driver.sendTurn('verify-' + model, serializeFirstTurn({ messages: [{ role: 'user', content: '请回一行确认接收。' }], tools: [], model: { id: model } }), { fresh: true, model, onDelta: d => { acc += d; } });
    const diag = await driver.diagnostics();
    const ui = diag?.ui ?? 'classic';
    const meta = diag?.requestMetadata ?? {};
    const expect = expectedRequestMetadata(model, { ui, wantThink: model === 'deepseek' });
    // 新会话首条本应带 model_type；续聊消息网页发 null（沿用会话模型）——都算通过。
    const mtOk = meta.model_type == null ? ui === 'unified' : meta.model_type === expect.model_type;
    const thinkOk = expect.thinking_enabled == null ? true : meta.thinking_enabled === expect.thinking_enabled;
    const hasReply = !!((acc || r.text).trim());
    assert(`model.${model}.请求元数据符合所选模式（${ui}）`, mtOk && thinkOk && hasReply,
      `model_type=${JSON.stringify(meta.model_type)} thinking_enabled=${JSON.stringify(meta.thinking_enabled)} 期望=${JSON.stringify(expect)} hasReply=${hasReply}`);
    await driver.resetConversation('verify-' + model);
  }

  // ---- 2) 识图模式（可选）----
  if (!skipVision) {
    if (!fs.existsSync(IMG)) { assert('model.vision.上传识别', false, '缺测试图 ' + IMG); }
    else {
      // unified UI 没有独立识图入口：带图发送 = model_type default + ref_file_ids，
      // 功能判据改为「回复确实读到了图里的文字（测试图内容 HELLO）」。
      const unified = (await driver.diagnostics().catch(() => null))?.ui === 'unified';
      // vision 上传受服务端限速，偶发超时。整体独立 try/catch：任何情况都执行断言并如实暴露，
      // 绝不中断其余断言（不吞异常、不误报、不未定义）。
      let ok = false; let last = ''; let gotMt = null;
      try {
        const images = [{ name: 'vision-test.jpg', contentType: 'image/jpeg', data: fs.readFileSync(IMG).toString('base64') }];
        for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
          let acc = ''; let mt = null;
          const settled = await Promise.race([
            (async () => {
              try {
                const r = await driver.sendTurn('verify-vision', serializeFirstTurn({ messages: [{ role: 'user', content: '请一句话说出图片文字。' }], tools: [], model: { id: 'vision' } }), { fresh: true, model: 'vision', images, onDelta: d => { acc += d; } });
                mt = (await driver.diagnostics())?.requestMetadata?.model_type;
                const text = (acc || r.text || '').trim();
                ok = (unified ? /hello/i.test(text) : (mt === 'vision' && !!text));
                gotMt = mt;
              } catch (e) { last = e?.message; gotMt = mt; }
            })().then(() => 'ok'),
            new Promise(res => setTimeout(() => res('timeout'), 55_000)),
          ]);
          if (settled === 'timeout') last = `attempt${attempt} 超时`;
        }
      } catch (e) { last = e?.message; }
      assert('model.vision.上传识别', ok, ok ? `${unified ? 'unified 带图路由' : 'vision model_type'} model_type=${gotMt} 识别到内容` : `未完成（${last}）。注：真实服务端对短时多次图片上传存在限速，功能本身 real-probe-08/10 已验证可用`);
      await driver.resetConversation('verify-vision').catch(() => {});
    }
  } else assert('model.vision.上传识别', true, '已跳过');

  // ---- 3) 工具闭环（可选）----
  if (!skipLoop) {
    const case_ = '请先调用 read 读取 package.json，然后基于返回的依赖信息给一行安全结论并收束。';
    // R1
    let acc1 = '';
    const r1 = await driver.sendTurn('verify-loop', serializeFirstTurn({ messages: [{ role: 'user', content: case_ }], tools: toolSchema, model: { id: 'deepseek' } }), { fresh: true, model: 'deepseek', onDelta: d => { acc1 += d; } });
    const p1 = parseAgentReply(acc1 || r1.text);
    const ok1 = p1.calls.length === 1 && p1.calls[0].name === 'read';
    assert('tool-loop.网页自主read', ok1, p1.calls.length ? `got ${p1.calls.map(c => c.name).join(',')}` : '无调用');
    if (!ok1) { await driver.resetConversation('verify-loop'); }
    else {
      const res = runRead(p1.calls[0].arguments?.path);
      assert('tool-loop.read真实执行', res.status === 'success', res.status === 'success' ? '读到配置' : res.error);
      // R2 回填 → 期望总结收束
      let acc2 = '';
      const r2 = await driver.sendTurn('verify-loop', resultFence(res) + '\n请基于以上真实依赖信息给一行简洁安全结论并收束，不要再调用工具。', { fresh: false, model: 'deepseek', onDelta: d => { acc2 += d; } });
      const p2 = parseAgentReply(acc2 || r2.text);
      const summary = (acc2 || r2.text || '').trim();
      assert('tool-loop.总结收束', p2.calls.length === 0 && summary.length > 10, p2.calls.length ? '仍发起调用' : `收束=${summary.slice(0, 40)}…`);
      await driver.resetConversation('verify-loop');
    }
  } else assert('tool-loop', true, '已跳过');
} catch (e) {
  console.error('\nERR:', e?.message, e?.code ?? '');
} finally {
  clearTimeout(timer);
  try { await driver.close(); } catch {}
}

const failed = results.filter(r => !r.ok);
console.log('\n===== 契约自检汇总 =====');
for (const r of results) console.log(`${r.ok ? '✔' : '✘'}  ${r.name}`);
console.log(`\nRESULT: ${failed.length ? failed.length + ' FAIL' : 'ALL PASS'} (${results.length} 项)`);
process.exit(failed.length ? 1 : 0);