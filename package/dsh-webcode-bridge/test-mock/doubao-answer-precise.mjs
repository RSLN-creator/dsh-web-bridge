// doubao-answer-precise.mjs — **只读**：精确定位 doubao 的**助手回复**容器（区分助手 vs 用户）。
//
// ## 为什么需要它（在 #76 的粗读数之后）
//
// 粗读数已证实：驱动用的兜底串在 doubao 命中 **0** 个，而 `[class*="receiveMessage"]`
// 命中 3 个可见、最内层 150 字。但**还不能直接拿去声明**，因为：
//   · 驱动用 `[...querySelectorAll(sel)].pop()` 取**最后一个**匹配节点；
//   · 若该选择器同时命中**用户消息**容器，`.pop()` 可能取到用户那条，
//     于是「助手回复」被读成用户提问 —— 那是**新的假读数**，比现在更坏。
//
// 因此本探针要分清：
//   ① 每个候选节点是**助手轮**还是**用户轮**（doubao 的前端用 send/receive 区分）；
//   ② 最后一条**助手**消息的完整文本（这才是驱动该读的东西）；
//   ③ `.pop()` 落在哪一个（即「按现在的取法会读到谁」）。
//
// **只读、零发送**：只 goto 已有会话地址 + querySelectorAll。
import { createBrowserDriver } from '../lib/browser-driver.js';
import { getSite } from '../lib/providers.js';
import { answerSelectorFor } from '../lib/browser-driver.js';
import { slotProfileDir, DEFAULT_SLOT } from '../lib/accounts.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TARGET = process.env.DOUBAO_TARGET_URL || 'https://www.doubao.com/chat/38447511625363202';
const site = getSite('doubao');
const ROOT = path.join(process.env.USERPROFILE || os.homedir(), '.dsh', 'webcode-edge-profile');
const profileDir = slotProfileDir(ROOT, 'doubao', DEFAULT_SLOT, { primary: site.mountAtRelayRoot === true });
const outDir = path.resolve('.tmp', 'real-lane', 'out');
fs.mkdirSync(outDir, { recursive: true });

const driver = createBrowserDriver({
  siteId: 'doubao', site: site.origin + '/', profileDir, headless: false,
  requestTimeoutMs: 45_000,
  logger: { log() {}, warn(...a) { console.log('[warn]', ...a); }, error(...a) { console.log('[err]', ...a); } },
});

const report = { target: TARGET, at: new Date().toISOString(), usedNow: answerSelectorFor('doubao') };
try {
  await driver.connect();
  const page = driver.page;
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(6_000);

  const r = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (el) => String(el?.innerText || '').trim().replace(/\s+/g, ' ');
    const dump = (sel) => {
      let all = [];
      try { all = [...document.querySelectorAll(sel)]; } catch { return []; }
      return all.filter(vis).map((el, i) => ({
        i,
        cls: String(el.className || '').slice(0, 110),
        len: txt(el).length,
        head: txt(el).slice(0, 110),
      }));
    };
    // doubao 的轮次容器：助手 = receiveMessage，用户 = sendMessage（只读实测的类名族）
    const recv = dump('[class*="receiveMessage"]');
    const send = dump('[class*="sendMessage"]');
    // 也试更窄的：带 content- 的正文区
    const recvContent = dump('[class*="receiveMessage"] [class*="content-"]');
    // 页面里所有可见的 message-list 子项（按顺序 = 会话时序）
    const ordered = dump('[class*="message-list"] > *');
    return {
      url: location.href, title: document.title,
      bodyLen: String(document.body?.innerText || '').length,
      recv, send, recvContent, ordered,
      // 「最后一条助手消息」= recv 的最后一个（若 recv 都是助手轮）
      lastRecv: recv.length ? recv[recv.length - 1] : null,
      lastSend: send.length ? send[send.length - 1] : null,
    };
  }).catch((e) => ({ err: String(e?.message || e).slice(0, 160) }));

  report.result = r;
  console.log('title =', JSON.stringify(r.title), ' bodyLen =', r.bodyLen);
  console.log('\n=== [class*="receiveMessage"]（助手轮？）===');
  for (const x of r.recv || []) console.log(`  #${x.i} len=${String(x.len).padStart(5)} ${x.cls}\n       ${JSON.stringify(x.head)}`);
  console.log('\n=== [class*="sendMessage"]（用户轮？）===');
  for (const x of r.send || []) console.log(`  #${x.i} len=${String(x.len).padStart(5)} ${x.cls}\n       ${JSON.stringify(x.head)}`);
  console.log('\n=== 最后一条 recv ===');
  console.log('  ' + JSON.stringify(r.lastRecv));
  console.log('\n=== 驱动现在会读到什么 ===');
  console.log('  answerSelectorFor("doubao") =', JSON.stringify(report.usedNow), '（命中 0 ⇒ 读不到）');

  const shot = await driver.screenshotBase64?.().catch(() => null);
  if (shot) { const p = path.join(outDir, `doubao-answer-precise-${Date.now()}.jpg`); fs.writeFileSync(p, Buffer.from(shot, 'base64')); report.screenshot = p; console.log('\nscreenshot:', p); }
} catch (e) {
  report.err = `${e?.code || ''} ${String(e?.message || e).slice(0, 200)}`.trim();
  console.log('ERR:', report.err);
} finally {
  await driver.close?.().catch(() => {});
}
fs.writeFileSync(path.join(outDir, 'doubao-answer-precise.json'), JSON.stringify(report, null, 2));
console.log('\n[纪律] 零发送：只 goto 已有会话地址 + querySelectorAll。');
