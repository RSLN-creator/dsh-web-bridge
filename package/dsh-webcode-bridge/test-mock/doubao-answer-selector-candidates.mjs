// doubao-answer-selector-candidates.mjs — **只读**：找出 doubao 助手回复的真实容器选择器。
//
// 背景（2026-10-16 真机 + 只读取证）：
//   · 驱动在 doubao 上恒定报 `replyChars:0, selectorHit:false`；
//   · 但只读导航到同一会话页，**页面上确有一段完整回复**（截图可见）；
//   · 驱动实际用的是 `answerSelectorFor('doubao')` 的**兜底串**
//     `.markdown, [data-message-author-role="assistant"], .ds-markdown`
//     （这是 DeepSeek 形状的兜底，0.19.19 的承诺是「未声明站点零位移」）；
//   · 只读取证里「像助手正文」的可见容器类名含 **`receiveMessage`** 与 `content-xxxx`。
//
// ⇒ 本探针逐个试**候选选择器**，报出「哪个能命中、命中几个、读到多少字」。
//   **只读、零发送**（只 goto 已有会话地址 + querySelectorAll）。
import { createBrowserDriver } from '../lib/browser-driver.js';
import { getSite } from '../lib/providers.js';
import { answerSelectorFor } from '../lib/browser-driver.js';
import { slotProfileDir, DEFAULT_SLOT } from '../lib/accounts.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TARGET = process.env.DOUBAO_TARGET_URL || 'https://www.doubao.com/chat/38447511625363202';
const site = getSite('doubao');
const ROOT = process.env.USERPROFILE
  ? path.join(os.homedir() && process.env.USERPROFILE, '.dsh', 'webcode-edge-profile')
  : path.join(os.homedir(), '.dsh', 'webcode-edge-profile');
const profileDir = slotProfileDir(ROOT, 'doubao', DEFAULT_SLOT, { primary: site.mountAtRelayRoot === true });

// 候选：现有的兜底 + 从只读取证反查出来的类名
const CANDIDATES = [
  answerSelectorFor('doubao'),                       // 驱动现在实际用的
  '.receiveMessage',                                  // 只读取证里看到的类名片段
  '[class*="receiveMessage"]',
  '[class*="content-"]',
  '[class*="message-list"]',
  '[class*="markdown"]',
  '.ds-markdown',
  '[data-message-author-role="assistant"]',
];

const driver = createBrowserDriver({
  siteId: 'doubao', site: site.origin + '/', profileDir, headless: false,
  requestTimeoutMs: 45_000,
  logger: { log() {}, warn(...a) { console.log('[warn]', ...a); }, error(...a) { console.log('[err]', ...a); } },
});

try {
  await driver.connect();
  const page = driver.page;
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(6_000);

  const rows = await page.evaluate((sels) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const out = [];
    for (const sel of sels) {
      let all = []; let err = null;
      try { all = [...document.querySelectorAll(sel)]; } catch (e) { err = String(e?.message || e).slice(0, 60); }
      const v = all.filter(vis);
      const last = v[v.length - 1] || null;
      const t = last ? String(last.innerText || '').trim().replace(/\s+/g, ' ') : '';
      out.push({ sel, err, total: all.length, visible: v.length, lastLen: t.length, lastHead: t.slice(0, 100) });
    }
    return out;
  }, CANDIDATES).catch((e) => [{ err: String(e?.message || e).slice(0, 160) }]);

  console.log('驱动现在用的 =', JSON.stringify(answerSelectorFor('doubao')));
  console.log('\n=== 候选选择器逐条 ===');
  for (const r of rows) {
    console.log(`  visible=${String(r.visible).padStart(3)} total=${String(r.total).padStart(3)} len=${String(r.lastLen).padStart(5)}  ${r.sel}`);
    if (r.lastHead) console.log(`        head=${JSON.stringify(r.lastHead)}`);
    if (r.err) console.log(`        ERR=${r.err}`);
  }
  const good = rows.filter((r) => r.visible > 0 && r.lastLen > 20);
  console.log('\n=== 能读到「真的回复文本」的候选 ===');
  for (const r of good) console.log(`  ★ ${r.sel}  → ${r.lastLen} 字`);
  if (!good.length) console.log('  （没有任何候选读到 >20 字的文本 —— 需要换思路）');
  fs.writeFileSync(path.resolve('.tmp', 'real-lane', 'out', 'doubao-answer-candidates.json'), JSON.stringify({ at: new Date().toISOString(), used: answerSelectorFor('doubao'), rows }, null, 2));
} catch (e) {
  console.log('ERR:', `${e?.code || ''} ${String(e?.message || e).slice(0, 200)}`.trim());
} finally {
  await driver.close?.().catch(() => {});
}
console.log('\n[纪律] 零发送：只 goto 已有会话地址 + querySelectorAll。');
