// kimi-postselect-diagnose.mjs — kimi「发送未确认」的**发送前状态**取证（零发送）。
//
// ## 为什么这条与 `kimi-send-diagnose.mjs` 不同（关键）
//
// 上一条只读取证是在**刚 connect 的干净页面**上做的，读数全绿（按钮 stable/enabled、
// trial 点击通过、无弹层）。但真机失败那一轮的顺序是：
//
//     connect → **selectModel(kimi:k3)** → 写输入框 → 点 .send-button-container → 失败
//
// ⇒ 前一条探针**漏掉了 `selectModel` 这一步**。而 kimi 的 `modelPicker` 恰恰声明了
// `readbackInMenu: true`（`lib/providers.js`）——它的回读路径会**重新打开模型菜单**、
// 读选中项、再 `page.keyboard.press('Escape')`。若那次 Escape 留下了**不可见的菜单容器
// 或遮罩**，按钮本身的一切属性仍会显示正常（`pointer-events:auto`、`stable`），
// 但**点到的是盖在上面的那一层**。这正是「所有读数都正常、点了却没反应」的经典形态。
//
// 本探针复现真机的前提（connect + 真的调用 `selectWebModel`），然后**只用只读判据**
// 回答「此刻按钮还点得到吗」：
//   · `elementFromPoint` 在按钮中心命中的是按钮自身还是**别的层**；
//   · 逐层打印 `z-index` / `pointer-events` / 可见性；
//   · `locator.click({trial:true})` **是否仍通过**（trial 不派发点击）；
//   · 页面上此刻有多少「可见的菜单/遮罩」节点（对比 connect 之后的那一刻）。
//
// ⚠ **绝不发送**：不写输入框、不 click()（只有 trial）、不按 Enter。
//   `selectWebModel` 只改「网页当前模型」这一 UI 状态，**不是发消息**。
//
// 用法：node test-mock/kimi-postselect-diagnose.mjs
import { createBrowserDriver } from '../lib/browser-driver.js';
import { getSite } from '../lib/providers.js';
import { slotProfileDir, DEFAULT_SLOT } from '../lib/accounts.js';
import { selectWebModel } from '../lib/model-picker.js';
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

/** 抓「此刻按钮中心命中的是谁」+ 页面上的拦截层数量。 */
const SNAP = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const btn = document.querySelector('.send-button-container');
  const out = { btnFound: Boolean(btn), centerHit: null, centerHitIsBtn: null, centerHitInsideBtn: null };
  if (btn) {
    const r = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    out.centerHit = hit ? { tag: hit.tagName.toLowerCase(), cls: String(hit.className || '').slice(0, 120), text: txt(hit) } : null;
    out.centerHitIsBtn = hit === btn;
    out.centerHitInsideBtn = Boolean(hit && btn.contains(hit));
    // 按钮矩形**四个采样点**（中心点可能恰好落在子节点，这是正常的；这里看有没有别的层覆盖）
    out.samples = [[0.5, 0.5], [0.15, 0.5], [0.85, 0.5], [0.5, 0.15], [0.5, 0.85]].map(([fx, fy]) => {
      const h = document.elementFromPoint(r.x + r.width * fx, r.y + r.height * fy);
      const inside = Boolean(h && btn.contains(h));
      return { fx, fy, tag: h?.tagName?.toLowerCase() ?? null, cls: String(h?.className || '').slice(0, 80), inside };
    });
  }
  // 页面上**此刻可见**的菜单/遮罩层（对比 connect 后的那一刻）
  out.overlays = [...document.querySelectorAll(
    '[role="dialog"], [class*="modal"], [class*="dialog"], [class*="popup"], [class*="mask"], [class*="overlay"], [class*="dropdown"], [class*="menu"]',
  )].filter(vis).slice(0, 15).map((e) => ({
    tag: e.tagName.toLowerCase(),
    cls: String(e.className || '').slice(0, 110),
    z: getComputedStyle(e).zIndex,
    pe: getComputedStyle(e).pointerEvents,
    text: txt(e),
  }));
  out.activeElement = document.activeElement ? { tag: document.activeElement.tagName.toLowerCase(), cls: String(document.activeElement.className || '').slice(0, 90) } : null;
  return out;
};

const driver = createBrowserDriver({
  siteId: 'kimi', site: site.origin + '/', profileDir, headless: false,
  requestTimeoutMs: 60_000,
  logger: { log() {}, warn(...a) { console.log('[warn]', ...a); }, error(...a) { console.log('[err]', ...a); } },
});

const report = { at: new Date().toISOString(), steps: [] };
try {
  const conn = await driver.connect();
  report.conn = conn;
  const page = driver.page;

  // ── 步骤 1：connect 之后（干净态）──
  const before = await page.evaluate(SNAP).catch((e) => ({ err: String(e?.message || e) }));
  report.steps.push({ step: 'after-connect', snap: before });
  console.log('--- after connect ---');
  console.log(JSON.stringify(before, null, 2));

  // ── 步骤 2：真的跑一次 selectWebModel（真机失败那一轮的第一步，**非发送**）──
  //
  // 传的就是站点目录里那一条（`wanted` 取 `labels[0]` = `K3`），与驱动
  // `selectModel` 里给 `selectWebModel` 的入参同形。
  const modelObj = site.models.find((m) => m.id === 'k3') || site.models[0];
  let selResult = null;
  try {
    selResult = await selectWebModel(page, modelObj, site.modelPicker);
  } catch (e) {
    selResult = { threw: String(e?.message || e).slice(0, 300) };
  }
  report.selectModel = selResult;
  console.log('--- selectWebModel(k3) ---');
  console.log(JSON.stringify(selResult, null, 2));

  await page.waitForTimeout(1200);   // 给菜单关闭动画留时间（真机失败发生在写入之后）

  // ── 步骤 3：selectModel 之后，按钮还点得到吗 ──
  const after = await page.evaluate(SNAP).catch((e) => ({ err: String(e?.message || e) }));
  report.steps.push({ step: 'after-selectModel', snap: after });
  console.log('--- after selectModel ---');
  console.log(JSON.stringify(after, null, 2));

  // ── 步骤 4：trial 点击（**不派发点击**）──
  const b = page.locator('.send-button-container').first();
  const trial = { count: await b.count().catch(() => -1) };
  try { await b.click({ timeout: 4000, trial: true }); trial.ok = true; }
  catch (e) { trial.ok = false; trial.error = String(e?.message || e).slice(0, 300); }
  report.trialAfterSelect = trial;
  console.log('--- trial click after selectModel ---');
  console.log('   ok=' + trial.ok + (trial.error ? '  err=' + trial.error : ''));

  report.url = page.url();
  const shot = await driver.screenshotBase64?.().catch(() => null);
  if (shot) {
    const p = path.join(outDir, `kimi-postselect-${Date.now()}.jpg`);
    fs.writeFileSync(p, Buffer.from(shot, 'base64'));
    report.screenshot = p;
  }
} catch (e) {
  report.err = `${e?.code || ''} ${String(e?.message || e).slice(0, 300)}`.trim();
} finally {
  await driver.close?.().catch(() => {});
}

const file = path.join(outDir, 'kimi-postselect-diagnose.json');
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log('\n[saved]', file);
console.log('[纪律] 零发送：未写输入框、未 click()（只有 trial:true）、未按 Enter。');
