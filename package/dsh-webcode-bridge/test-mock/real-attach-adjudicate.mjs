#!/usr/bin/env node
// real-attach-adjudicate.mjs — 0.19.11 真机判定：**附件轮到底把什么送进了完成请求**。
//
// 为什么这条必须真机跑：用户报障「明明在附件投递模式下，看的还是完整上下文」
// （2026-09-24，见 lib/browser-driver.js:2714 的现场读数 userMsgChars=81139 /
// mentionsFullHistory=true）。离线断言只能证明「判据算出来是 attach」，
// 证明不了「网页那一侧收到的到底是附件还是全文」—— 后者只有真机能答。
//
// 判定口径（三条一起看，缺一条就可能自欺）：
//   ① requestMetadata.ref_file_ids  —— 完成请求带没带文件（0.19.11 起才可见）
//   ② requestMetadata.promptChars   —— 完成请求里正文有多长（全文 ⇒ 没走附件）
//   ③ 页面里那条用户消息的字数        —— 网页实际渲染了什么
// 期望的「真·附件投递」：①非空 且 ②是短指令 且 ③是小数字。
import path from 'node:path';
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn } from '../lib/agent-preset.js';

const PROFILE = process.env.REAL_PROFILE || path.join(process.cwd(), '.tmp', 'real-profile-probe');
// 默认走**全站默认阈值 60_000**，正文取真机典型首轮尺寸 48,937——
// 这正是修前的病根现场：48,937 < 60,000 ⇒ under-limit ⇒ 全文灌进输入框。
// 修后站点上限 8,000 生效 ⇒ 同一份正文必须落到附件。
const INLINE_LIMIT = Number(process.env.ATTACH_INLINE_LIMIT || 60_000);
const PROMPT_CHARS = Number(process.env.PROMPT_CHARS || 48_937);

const tools = [
  { name: 'read', description: '读取本地文件文本内容。', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
];
// 用一段明确超过阈值、且尺寸等于真机典型首轮的正文
const filler = (() => {
  const pad = '本地上下文占位行：用于把正文推到真机典型首轮尺寸。\n';
  let s = '';
  while (s.length < PROMPT_CHARS - 600) s += pad;
  return s;
})();
const prompt = serializeFirstTurn({
  messages: [{ role: 'user', content: [{ type: 'text', text: filler }] }, { role: 'user', content: [{ type: 'text', text: '请只回一行：收到。' }] }],
  tools, siteId: 'deepseek',
});
console.log(`正文 ${prompt.length} 字符，attachInlineLimitChars=${INLINE_LIMIT}`);

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/', profileDir: PROFILE, headless: true,
  requestTimeoutMs: 150_000, attachInlineLimitChars: INLINE_LIMIT, logger: console,
});

const fileTraffic = [];
let completionBody = null;
try {
  const conn = await driver.connect();
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }
  const page = driver.page;
  if (page) {
    page.on('request', (r) => {
      const u = r.url();
      if (!/\/api\/v0\//.test(u)) return;
      const post = (() => { try { return r.postDataJSON(); } catch { return null; } })();
      if (/completion/.test(u) && post && typeof post === 'object') {
        completionBody = { promptChars: typeof post.prompt === 'string' ? post.prompt.length : null, ref_file_ids: post.ref_file_ids ?? null };
      }
      if (/file|upload|attach/i.test(u)) fileTraffic.push({ kind: 'req', method: r.method(), url: u.replace('https://chat.deepseek.com', ''), bodyKeys: post && typeof post === 'object' ? Object.keys(post).slice(0, 12) : null });
    });
    page.on('response', async (resp) => {
      const u = resp.url();
      if (!/file|upload|attach/i.test(u) || !/\/api\/v0\//.test(u)) return;
      let keys = null, sample = null;
      try { const j = await resp.json(); keys = j && typeof j === 'object' ? Object.keys(j).slice(0, 16) : null; sample = JSON.stringify(j).slice(0, 300); } catch {}
      fileTraffic.push({ kind: 'resp', status: resp.status(), url: u.replace('https://chat.deepseek.com', ''), keys, sample });
    });
  }

  let acc = '';
  const r = await driver.sendTurn('real-attach-adj', prompt, { fresh: true, model: 'deepseek', onDelta: (d) => { acc += d; } });
  const diag = await driver.diagnostics().catch(() => null);
  const st = (() => { try { return driver.status(); } catch { return null; } })();
  const meta = diag?.requestMetadata ?? {};
  const text = (acc || r.text || '').trim();

  // 网页上那条用户消息实际渲染了多少字
  const rendered = await driver.page?.evaluate?.(() => {
    const nodes = [...document.querySelectorAll('[data-message-author-role="user"], .fbb737a4, ._9663006')];
    const last = nodes.pop();
    return last ? (last.innerText || '').length : null;
  }).catch(() => null);

  console.log('\n== 文件相关网络（网页自己发的）==');
  for (const t of fileTraffic.slice(0, 20)) console.log('  ' + JSON.stringify(t));
  console.log('\n== 完成请求（驱动捕获）==');
  console.log('  ' + JSON.stringify(completionBody));
  console.log('\n== 驱动读数 ==');
  console.log('  requestMetadata: ' + JSON.stringify(meta));
  console.log('  attachTransport: ' + JSON.stringify(st?.attachTransport ?? null));
  console.log('  attachBlocked: ' + JSON.stringify(st?.attachBlocked ?? null));
  console.log('  lastEndReason: ' + st?.lastEndReason);
  console.log(`  页面用户消息渲染字数: ${rendered}`);
  console.log(`  回复字符: ${text.length}`);

  const refIds = Array.isArray(meta.ref_file_ids) ? meta.ref_file_ids : (completionBody?.ref_file_ids ?? null);
  const promptChars = meta.promptChars ?? completionBody?.promptChars ?? null;
  const verdict = (Array.isArray(refIds) && refIds.length > 0 && promptChars !== null && promptChars < prompt.length * 0.5)
    ? 'ATTACH-OK（文件在场 + 正文是短指令）'
    : (promptChars !== null && promptChars >= prompt.length * 0.9
        ? 'INLINE（全文进了完成请求 ⇒ 附件没生效）'
        : 'UNKNOWN（读数不足，逐字段看上面）');
  console.log('\n判定: ' + verdict);
  await driver.resetConversation('real-attach-adj').catch(() => {});
} catch (e) {
  console.log('ERR: ' + (e?.message || e));
} finally {
  try { await driver.close(); } catch {}
}
