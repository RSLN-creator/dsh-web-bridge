// kimi-send-diagnose.mjs — kimi「发送未确认」的**只读**诊断器（零写入、零发送）。
//
// ## 为什么需要它（缺陷 #70，2026-10-16 真机登记）
//
// 真机 `site-verify-multiturn --site kimi` 第 1 轮回 `SEND_NOT_CONFIRMED`，驱动日志逐字：
//
//     send path: sel=.send-button-container ready=true composerChars=1549 url=https://www.kimi.com/
//
// ⚠ 报错原文解释成「附件在场时发送键可能变了或被禁用」——**本轮一个附件都没有**，
// 而按钮的可点性也已被证明是好的。**那句文案会把排障引到两条都不成立的方向上。**
//
// 本脚本用**四条只读判据**把「页面自己拒绝发送」与「桥的动作没送达」分开，全部零副作用：
//
//   ① **登录态**：截图 + 昵称节点 ⇒ 排除「停在登录墙」（#53 那种三态诱惑）；
//   ② **发送键可点性**：`locator.click({ trial: true })` 会**完整跑一遍** Playwright 的
//      actionability 检查（attached / visible / **stable** / receives-events / enabled）
//      而**不派发点击** ⇒ 干净地区分「点不到」与「点了没用」。动画 SVG 最容易触发
//      `stable` 失败，所以这一条同时验证了那个假设；
//   ③ **指针链**：宿主 `pointer-events`、祖先链逐层、`elementFromPoint` 的真实命中节点
//      ⇒ 排除「被遮挡 / 命中空白」；
//   ④ **内容与拦截层**：composer 实际字数（对照仓库既有成功读数的 65 字）、可见
//      dialog/modal/mask 列表、页面限额类文案 ⇒ 给出「长度相关」这个假设的直接读数。
//
// ## 边界（写清楚，别让下一个人以为它发了消息）
//
//   · **绝不** `locator.click()`（只有 `trial:true`）、**绝不**写输入框、**绝不**按 Enter；
//   · 只做 `connect()` + 读 DOM + 截图（截图是只读取证）。
//
// 用法：node test-mock/kimi-send-diagnose.mjs
import { createBrowserDriver } from '../lib/browser-driver.js';
import { getSite } from '../lib/providers.js';
import { slotProfileDir, DEFAULT_SLOT } from '../lib/accounts.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const site = getSite('kimi');
const ROOT = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, '.dsh', 'webcode-edge-profile')
  : path.join(os.homedir(), '.dsh', 'webcode-edge-profile');
const profileDir = slotProfileDir(ROOT, 'kimi', DEFAULT_SLOT, { primary: site.mountAtRelayRoot === true });
const outDir = path.resolve('.tmp', 'real-lane', 'out');
fs.mkdirSync(outDir, { recursive: true });

const driver = createBrowserDriver({
  siteId: 'kimi', site: site.origin + '/', profileDir, headless: false,
  requestTimeoutMs: 60_000,
  logger: { log() {}, warn(...a) { console.log('[warn]', ...a); }, error(...a) { console.log('[err]', ...a); } },
});

const report = { at: new Date().toISOString(), profileDir };
try {
  const conn = await driver.connect();
  report.conn = conn;
  const page = driver.page;
  report.url = page.url();

  // ── ④ 内容与拦截层（顺带取登录昵称，证 ① 的页面事实）─────────────────────
  report.dom = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
    const composer = [...document.querySelectorAll('div.chat-input-editor, div[contenteditable="true"]')].find(vis) || null;
    const btn = document.querySelector('.send-button-container');
    const cs = btn ? getComputedStyle(btn) : null;
    const chain = [];
    for (let e = btn, i = 0; e && i < 6; i++, e = e.parentElement) {
      const c = getComputedStyle(e);
      chain.push({ tag: e.tagName.toLowerCase(), cls: String(e.className || '').slice(0, 80), pe: c.pointerEvents, z: c.zIndex });
    }
    const body = document.body?.innerText || '';
    return {
      title: document.title,
      composerChars: composer ? (composer.innerText || '').length : -1,
      composerHead: composer ? (composer.innerText || '').slice(0, 100) : null,
      userNameNodes: [...document.querySelectorAll("[class*='user-profile'], [class*='nickname'], [class*='user-name']")]
        .filter(vis).slice(0, 3).map((e) => txt(e).slice(0, 40)),
      btnFound: Boolean(btn),
      btnCls: btn ? String(btn.className || '').slice(0, 120) : null,
      btnPointerEvents: cs ? cs.pointerEvents : null,
      btnOpacity: cs ? cs.opacity : null,
      chain,
      dialogs: [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="popup"], [class*="mask"]')]
        .filter(vis).slice(0, 12).map((e) => ({ cls: String(e.className || '').slice(0, 90), t: txt(e).slice(0, 100) })),
      limitHits: ['上限', '限制', '额度', '升级', '会员', '繁忙', '稍后'].filter((k) => body.includes(k)),
    };
  }).catch((e) => ({ err: String(e?.message || e) }));

  // ── ②③ 三个候选选择器各跑一次 trial 点击 + 稳定性/指针判据 ─────────────────
  report.trials = [];
  for (const sel of ['.send-button-container', '.send-button-container svg', '.send-button-container path']) {
    const b = page.locator(sel).first();
    const entry = { sel, count: await b.count().catch(() => -1), visible: null, stable: null, enabled: null, receives: null, trialOk: false, trialError: null };
    if (entry.count > 0) {
      entry.visible = await b.isVisible().catch((e) => 'ERR:' + e.message);
      const bb1 = await b.boundingBox().catch(() => null);
      await page.waitForTimeout(400);
      const bb2 = await b.boundingBox().catch(() => null);
      entry.stable = Boolean(bb1 && bb2 && bb1.x === bb2.x && bb1.y === bb2.y && bb1.width === bb2.width && bb1.height === bb2.height);
      entry.enabled = await b.isEnabled().catch((e) => 'ERR:' + e.message);
      entry.receives = await b.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { hitTag: hit?.tagName?.toLowerCase() ?? null, hitInside: Boolean(hit && el.contains(hit)), hitIsSelf: hit === el };
      }).catch((e) => 'ERR:' + e.message);
      // ★ trial：完整跑可点性检查，**不派发点击**
      try { await b.click({ timeout: 4000, trial: true }); entry.trialOk = true; }
      catch (e) { entry.trialError = String(e?.message || e).slice(0, 300); }
    }
    report.trials.push(entry);
  }

  report.urlAfter = page.url();
  const shot = await driver.screenshotBase64?.().catch(() => null);
  if (shot) {
    const p = path.join(outDir, `kimi-send-diagnose-${Date.now()}.jpg`);
    fs.writeFileSync(p, Buffer.from(shot, 'base64'));
    report.screenshot = p;
  }
} catch (e) {
  report.err = `${e?.code || ''} ${String(e?.message || e).slice(0, 300)}`.trim();
} finally {
  await driver.close?.().catch(() => {});
}

const file = path.join(outDir, 'kimi-send-diagnose.json');
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log('\n[saved]', file);
console.log('[纪律] 本脚本只读：零写入、零 click()（只有 trial:true）、零 Enter。');
