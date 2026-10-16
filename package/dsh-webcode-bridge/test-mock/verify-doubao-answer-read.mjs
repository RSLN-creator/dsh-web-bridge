// verify-doubao-answer-read.mjs — **只读**：验证驱动**真的读到了** doubao 的回复
//（即 #76 的修复在真实页面上生效：`replyChars>0` / `selectorHit:true`）。
//
// ## 判据（与驱动同源）
//
// 驱动的超时现场读数用同一段 `page.evaluate`（见 `browser-driver.js` 的 timeout scene）：
//   `const last = [...document.querySelectorAll(answerSelector)].pop();`
//   → `replyChars = last ? last.innerText.length : 0`
//   → `selectorHit = Boolean(last)`
// 本脚本**逐字复刻**那段，并把 `answerSelectorFor('doubao')` 的**现值**喂进去，
// 断言：修前应当 `selectorHit:false`、修后必须 `selectorHit:true` 且 `replyChars>0`。
//
// ⚠ 关键是**不用** `page.evaluate` 之外的东西：判据必须与驱动那条完全一样，
//   否则验的是另一件事。**零发送**。
import { createBrowserDriver, answerSelectorFor } from '../lib/browser-driver.js';
import { getSite } from '../lib/providers.js';
import { slotProfileDir, DEFAULT_SLOT } from '../lib/accounts.js';
import fs from 'node:fs';
import path from 'node:path';

const TARGET = process.env.DOUBAO_TARGET_URL || 'https://www.doubao.com/chat/38447511625363202';
const site = getSite('doubao');
const ROOT = path.join(process.env.USERPROFILE || '', '.dsh', 'webcode-edge-profile');
const profileDir = slotProfileDir(ROOT, 'doubao', DEFAULT_SLOT, { primary: site.mountAtRelayRoot === true });
const outDir = path.resolve('.tmp', 'real-lane', 'out');
fs.mkdirSync(outDir, { recursive: true });

const ANS = answerSelectorFor('doubao');
const FALLBACK = '.markdown, [data-message-author-role="assistant"], .ds-markdown';

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

  // ★ 逐字复刻驱动的那段读数（用**修后**的选择器）
  const after = await page.evaluate((sel) => {
    const last = [...document.querySelectorAll(sel)].pop();
    return { replyChars: last ? (last.innerText || '').length : 0, selectorHit: Boolean(last), head: last ? String(last.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 140) : null };
  }, ANS).catch((e) => ({ err: String(e?.message || e).slice(0, 140) }));

  // 对照：**旧**兜底串在同一页上的读数（证明修复确实改变了结论）
  const before = await page.evaluate((sel) => {
    const last = [...document.querySelectorAll(sel)].pop();
    return { replyChars: last ? (last.innerText || '').length : 0, selectorHit: Boolean(last) };
  }, FALLBACK).catch((e) => ({ err: String(e?.message || e).slice(0, 140) }));

  console.log('answerSelectorFor("doubao") =', JSON.stringify(ANS));
  console.log('\n=== 修**前**（旧兜底串）· 同一页面 ===');
  console.log('  ' + JSON.stringify(before), ' ← 真机超时读数就是这个（selectorHit:false）');
  console.log('\n=== 修**后**（新声明）· 同一页面 ===');
  console.log('  ' + JSON.stringify(after));
  const ok = after && after.selectorHit === true && after.replyChars > 0;
  console.log('\n判定：' + (ok ? '★ PASS —— 驱动现在读得到回复（#76 在真实页面生效）' : '✗ FAIL —— 仍未读到，需继续查'));
  console.log('对照变化：selectorHit ' + (before?.selectorHit) + ' → ' + (after?.selectorHit)
    + '；replyChars ' + (before?.replyChars) + ' → ' + (after?.replyChars));

  fs.writeFileSync(path.join(outDir, 'doubao-answer-read-verify.json'), JSON.stringify({ at: new Date().toISOString(), target: TARGET, ans: ANS, before, after, pass: ok }, null, 2));
} catch (e) {
  console.log('ERR:', `${e?.code || ''} ${String(e?.message || e).slice(0, 200)}`.trim());
} finally {
  await driver.close?.().catch(() => {});
}
console.log('\n[纪律] 零发送：只 goto 已有会话地址 + 与驱动同源的读数。');
