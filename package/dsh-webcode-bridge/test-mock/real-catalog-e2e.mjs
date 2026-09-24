#!/usr/bin/env node
// real-catalog-e2e.mjs — 真机验证 0.19.11 的技能目录收敛：把**真实 83 项目录**
// 按 deepseek 站点收敛后作为首轮发出去，看真实网页模型能不能照常发起工具调用。
//
// 为什么这条必须真机跑：目录收缩是**提示词层**的改动，离线断言只能证明「文本变短了」，
// 证明不了「模型还认得出工具协议、还肯调工具」。判失败签名：回复里 0 个可解析调用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn, parseAgentReply, skillCatalogPlan, compactSkillCatalog } from '../lib/agent-preset.js';
import { estimateTokens } from '../lib/metrics.js';

const PROFILE = process.env.REAL_PROFILE || path.join(process.cwd(), '.edge-real-profile');

/** 取最近一份**真机落盘首轮**里的目录块（与用户实际会话逐字同源）。 */
function realCatalogBlock() {
  const dir = path.join(os.homedir(), '.dsh', 'webcode', 'sessions');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  for (const { f } of files) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    const i = t.indexOf('<system-reminder>\nA skill is a reusable');
    if (i < 0) continue;
    return { file: f, block: t.slice(i, t.indexOf('</system-reminder>', i) + 18) };
  }
  throw new Error('本机找不到带技能目录的落盘首轮');
}

const { file, block } = realCatalogBlock();
const entries = (block.match(/^- `[a-z0-9-]+`:/gm) || []).length;
const plan = skillCatalogPlan({ siteId: 'deepseek' });
const compacted = compactSkillCatalog(block, plan);
const kept = (compacted.match(/^- `[a-z0-9-]+`:/gm) || []).length;

const tools = [
  { name: 'read', description: '读取本地文件文本内容。', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'pwsh', description: 'Run a PowerShell command.', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command', 'description'] } },
];
const ask = '请调用 read 读取 package.json（只读这一个文件），然后基于返回内容给一行结论并收束。';
const prompt = serializeFirstTurn({
  messages: [{ role: 'user', content: [{ type: 'text', text: block }] }, { role: 'user', content: [{ type: 'text', text: ask }] }],
  tools, siteId: 'deepseek',
});

console.log('== 离线读数（发送前）==');
console.log(`目录来源: ${file}`);
console.log(`原始目录: ${entries} 项 / ${estimateTokens(block)} token`);
console.log(`收敛目录: ${kept} 项 / ${estimateTokens(compacted)} token`);
console.log(`首轮全文: ${estimateTokens(prompt)} token / ${prompt.length} 字符`);
console.log(`含省略说明: ${compacted.includes('省略了')} | 已丢 gsd-debug: ${!compacted.includes('gsd-debug')}`);
const glmPrompt = serializeFirstTurn({
  messages: [{ role: 'user', content: [{ type: 'text', text: block }] }, { role: 'user', content: [{ type: 'text', text: ask }] }],
  tools, siteId: 'glm',
});
console.log(`对照组 glm 首轮（零漂移）: ${estimateTokens(glmPrompt)} token | 目录逐字未动: ${glmPrompt.includes(block)}`);

const driver = createBrowserDriver({ site: 'https://chat.deepseek.com/', profileDir: PROFILE, headless: true, requestTimeoutMs: 110_000, logger: console });
let ok = false, detail = '';
try {
  const conn = await driver.connect();
  if (!conn.loggedIn) { console.log('NEED_LOGIN: profile 未登录'); process.exit(3); }
  console.log('\n== 真机轮次 ==');
  let acc = '';
  const r = await driver.sendTurn('real-catalog', prompt, { fresh: true, model: 'deepseek', onDelta: (d) => { acc += d; } });
  const text = (acc || r.text || '').trim();
  const parsed = parseAgentReply(text, { tools });
  const meta = (await driver.diagnostics().catch(() => null))?.requestMetadata ?? {};
  ok = parsed.calls.length >= 1 && parsed.calls[0].name === 'read';
  detail = `calls=${parsed.calls.length} names=${parsed.calls.map((c) => c.name).join(',') || '-'} replyChars=${text.length}`;
  console.log(`回复字符: ${text.length}`);
  console.log(`requestMetadata: ${JSON.stringify(meta)}`);
  console.log(`解析: ${detail}`);
  console.log(`诊断: ${JSON.stringify(parsed.diagnostics.slice(0, 3))}`);
  await driver.resetConversation('real-catalog').catch(() => {});
} catch (e) {
  detail = 'ERR ' + (e?.message || e);
  console.log(detail);
} finally {
  try { await driver.close(); } catch {}
}
console.log(`\nRESULT(目录收敛真机): ${ok ? 'PASS' : 'FAIL'} — ${detail}`);
process.exit(ok ? 0 : 1);
