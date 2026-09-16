// real-probe-21-glm-think.mjs — GLM-5.3 思考中工具调用真机探针（2026-09-13）。
//
// 背景：用户真机确认 GLM-5.3（强制思考）把工具调用写进思考流、正文只有散文，
// 旧实现只从正文解析 → 调用静默丢失。0.12.6 加了两层适配：
//   1) adapter 层正文解析不到时从思考全文兜底解析；
//   2) parseAgentReply 认 GLM 原生裸名形状 <tool_call>pwsh{…}</tool_call>。
// 本探针发一轮真实 GLM 网页对话，打印正文/思考原文与两层解析结果，
// 验证兜底路径在真实流上生效。用独立会话槽，不碰用户既有网页对话。
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn, parseAgentReply } from '../lib/agent-preset.js';

const driver = createBrowserDriver({
  siteId: 'glm', site: 'https://chatglm.cn/',
  profileDir: 'C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/glm',
  headless: true, requestTimeoutMs: 240_000, loginTimeoutMs: 300_000, logger: console,
});
const TOOL = { name: 'pwsh', description: '在本机执行 PowerShell 命令并返回真实输出', parameters: { type: 'object', properties: { command: { type: 'string' } } } };
const prompt = serializeFirstTurn({
  system: 'You are a helpful software engineer assistant.',
  tools: [TOOL],
  messages: [{ role: 'user', content: [{ type: 'text', text: '请调用 pwsh 工具查看当前时间，拿到真实结果后告诉我几点了。' }] }],
});
try {
  const r = await driver.sendTurn('probe-glm-think-' + Date.now(), prompt, { fresh: true, model: 'glm:auto' });
  console.log('\n===== 正文 (text) =====\n' + String(r.text || '').slice(0, 900));
  console.log('\n===== 思考 (thinking) 前 1500 字 =====\n' + String(r.thinking || '').slice(0, 1500));
  const fromText = parseAgentReply(r.text || '').calls;
  const fromThink = r.thinking ? parseAgentReply(r.thinking).calls : [];
  console.log('\n===== 解析：正文识别调用 =====\n' + JSON.stringify(fromText));
  console.log('\n===== 解析：思考识别调用 =====\n' + JSON.stringify(fromThink));
  const ok = (fromText.length || fromThink.length) > 0;
  console.log('\nPROBE RESULT: ' + (ok ? 'PASS（识别到工具调用）' : 'INCONCLUSIVE（本轮未识别到调用——检查思考原文是否含协议）'));
  if (!ok) process.exitCode = 2;
} catch (e) {
  console.error('PROBE FAIL:', e.message);
  process.exitCode = 1;
} finally {
  try { driver.close?.(); } catch {}
}
