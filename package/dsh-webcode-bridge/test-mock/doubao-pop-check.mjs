// doubao-pop-check.mjs — **只读**：验证候选选择器在 `.pop()`（驱动现有取法）下读到的是**助手**。
//
// ## 为什么必须验这一步（避免用一个更坏的假读数替换旧假读数）
//
// 驱动用 `[...querySelectorAll(sel)].pop()` 取**最后一个**匹配节点。
// 候选 `[class*="receiveMessage"]` 只命中助手轮（3 个），理论上 `.pop()` = 最后一条助手消息。
// 但**必须实测确认**，否则可能：
//   · 选择器同时命中用户轮 ⇒ `.pop()` 读到**用户提问**（比现在更坏）；
//   · 或命中的是**外层**容器（含两侧）⇒ 读到的文本混了。
//
// 判据：对每个候选，报 `.pop()` 节点是「助手 or 用户」+ 文本长度与前 80 字。
// 判「助手」的依据：节点内**不含** `[class*="sendMessage"]` 的兄弟结构（doubao 用 send/receive 区分），
// 且文本不含用户那句提问。
//
// **零发送、只读**。
import { createBrowserDriver } from '../lib/browser-driver.js';
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

const CANDS = [
  '[class*="receiveMessage"]',
  '[class*="receiveMessage"] [class*="content-"]',
  '[class*="message-list"] [class*="receiveMessage"]',
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
  const r = await page.evaluate((sels) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (el) => String(el?.innerText || '').trim().replace(/\s+/g, ' ');
    const out = [];
    for (const sel of sels) {
      let all = [];
      try { all = [...document.querySelectorAll(sel)].filter(vis); } catch (e) { out.push({ sel, err: String(e?.message || e).slice(0, 60) }); continue; }
      const last = all[all.length - 1] || null;
      const t = last ? txt(last) : '';
      // 助手判据：节点内不含 sendMessage 结构，且文本不含用户那句（"按规矩来"）
      const hasSend = last ? [...last.querySelectorAll('[class*="sendMessage"]')].length : 0;
      const isAssistant = Boolean(last) && hasSend === 0 && !t.includes('按规矩来');
      out.push({ sel, visible: all.length, lastLen: t.length, lastHead: t.slice(0, 90), hasSendInside: hasSend, isAssistant });
    }
    return out;
  }, CANDS).catch((e) => [{ err: String(e?.message || e).slice(0, 160) }]);

  console.log('=== 候选在 .pop() 取法下的判定（只读）===');
  for (const x of r) {
    if (x.err) { console.log('  ERR ' + JSON.stringify(x)); continue; }
    console.log(`  ${x.isAssistant ? '★ 助手' : '✗ 非助手'}  visible=${x.visible} lastLen=${x.lastLen} hasSendInside=${x.hasSendInside}`);
    console.log(`      sel = ${x.sel}`);
    console.log(`      pop() head = ${JSON.stringify(x.lastHead)}`);
  }
  const good = r.filter((x) => x.isAssistant && x.lastLen > 20);
  console.log('\n=== 可用候选（.pop() 读到助手正文且 >20 字）===');
  for (const x of good) console.log(`  ★ ${x.sel}  → ${x.lastLen} 字`);
  if (!good.length) console.log('  （无 —— 需换思路）');
  fs.writeFileSync(path.join(outDir, 'doubao-pop-check.json'), JSON.stringify({ at: new Date().toISOString(), rows: r }, null, 2));
} catch (e) {
  console.log('ERR:', `${e?.code || ''} ${String(e?.message || e).slice(0, 200)}`.trim());
} finally {
  await driver.close?.().catch(() => {});
}
console.log('\n[纪律] 零发送：只 goto 已有会话地址 + querySelectorAll。');
