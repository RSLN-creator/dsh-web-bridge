// probe-model-dropdown.mjs — 深挖单个站点的模型弹层结构（0.13.0）。
//
// probe-model-picker.mjs 已经定位到触发按钮，但通用选择器抓不到弹层里的选项
//（z.ai：点击 button.modelSelectorButton 后 0 个候选）。本脚本点开之后**把整个
// 页面新出现的可见节点全量 dump 出来**，用增量对比找真实结构，而不是靠猜选择器。
//
// 用法：
//   node test-mock/probe-model-dropdown.mjs zai
//   node test-mock/probe-model-dropdown.mjs glm --selector '.model-select-container'
//   node test-mock/probe-model-dropdown.mjs kimi --text '快速'
//
// 输出：test-mock/out/model-dropdown-<site>-<ts>.json

import { chromium } from '../node_modules/playwright-core/index.mjs';
import { getSite } from '../lib/providers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const siteId = process.argv[2];
if (!siteId) { console.error('用法: node test-mock/probe-model-dropdown.mjs <siteId> [--selector X] [--text T]'); process.exit(1); }
const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SEL = argOf('--selector', null);
const TEXT = argOf('--text', null);
const SETTLE_MS = Number(argOf('--settle', '8000'));
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const site = getSite(siteId);
if (!site) { console.error('未知站点: ' + siteId); process.exit(1); }

const root = process.env.WEBCODE_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'webcode-edge-profile');
const portFile = path.join(root, 'sites', siteId, 'DevToolsActivePort');
let port = null;
try {
  port = fs.readFileSync(portFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).find((l) => /^\d+$/.test(l));
} catch { /* 下面报错 */ }
if (!port) { console.error('✗ ' + siteId + ' 的 Edge 没在跑（缺 ' + portFile + '）。先打开一次它的「独立窗口」。'); process.exit(1); }

const OUT_DIR = path.resolve('test-mock', 'out');
const SHOT_DIR = path.resolve('.tmp', 'shots');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

/** 全量可见节点快照：用于点击前后做增量对比。 */
const SNAPSHOT = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || '1') > 0.05;
  };
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('*')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    // 只看上半屏 + 中部（弹层通常出现在触发附近），并限制数量
    const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
    const leaf = el.children.length === 0;
    if (!leaf && t.length > 60) continue;      // 跳过把整块界面都包住的祖先
    const key = el.tagName + '|' + t.slice(0, 50) + '|' + Math.round(r.x) + ',' + Math.round(r.y);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      tag: el.tagName.toLowerCase(),
      text: t.slice(0, 80),
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      cls: String(el.className || '').slice(0, 140),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      z: getComputedStyle(el).zIndex,
      leaf,
    });
    if (out.length >= 900) break;
  }
  return out;
};

const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
const context = browser.contexts()[0];
const page = await context.newPage();
const report = { siteId, port, selector: SEL, text: TEXT, at: new Date().toISOString() };
try {
  await page.goto(site.origin + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(SETTLE_MS);
  report.url = page.url();
  report.title = await page.title();

  const before = await page.evaluate(SNAPSHOT);
  report.beforeCount = before.length;

  // 决定点哪儿：显式 selector > 显式 text > 站点专用默认
  let targetDesc = null;
  /** 记录被点元素自身的身份 —— 这才是能写进 providers 的触发选择器。 */
  const describeLoc = (loc) => loc.evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    cls: String(el.className || '').slice(0, 140),
    ariaLabel: el.getAttribute('aria-label'),
    testid: el.getAttribute('data-testid'),
    role: el.getAttribute('role'),
    text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
    parentCls: el.parentElement ? String(el.parentElement.className || '').slice(0, 100) : null,
  })).catch(() => null);

  const tryClick = async () => {
    if (SEL) {
      const loc = page.locator(SEL).first();
      if (await loc.count()) {
        targetDesc = { how: 'selector', sel: SEL, element: await describeLoc(loc) };
        await loc.click({ timeout: 5000 });
        return true;
      }
      targetDesc = { how: 'selector', sel: SEL, error: 'not found' };
      return false;
    }
    if (TEXT) {
      const loc = page.getByText(TEXT, { exact: false }).first();
      if (await loc.count()) {
        targetDesc = { how: 'text', text: TEXT, element: await describeLoc(loc) };
        await loc.click({ timeout: 5000 });
        return true;
      }
      targetDesc = { how: 'text', text: TEXT, error: 'not found' };
      return false;
    }
    // 站点默认：z.ai 的 .modelSelectorButton / glm 的 .model-select-container
    const defaults = siteId === 'zai' ? ['.modelSelectorButton', '[aria-label="选择一个模型"]']
      : siteId === 'glm' ? ['.model-select-container', '.model-select-icon-container']
        : siteId === 'kimi' ? ['[class*="chat-input"] [class*="model"]', 'button:has-text("快速")']
          : ['.modelSelectorButton', '[class*="model-select"]'];
    for (const sel of defaults) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count() && await loc.isVisible().catch(() => false)) {
          targetDesc = { how: 'siteDefault', sel, element: await describeLoc(loc) };
          await loc.click({ timeout: 5000 });
          return true;
        }
      } catch { /* next */ }
    }
    return false;
  };

  report.clicked = await tryClick().catch((e) => { targetDesc = { error: String(e?.message || e) }; return false; });
  report.target = targetDesc;
  await page.waitForTimeout(1200);

  const after = await page.evaluate(SNAPSHOT);
  report.afterCount = after.length;
  const beforeKeys = new Set(before.map((b) => b.tag + '|' + b.text.slice(0, 50) + '|' + b.x + ',' + b.y));
  report.appeared = after.filter((a) => !beforeKeys.has(a.tag + '|' + a.text.slice(0, 50) + '|' + a.x + ',' + a.y));

  const shot = path.join(SHOT_DIR, `dropdown-${siteId}-${TS}.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  report.screenshot = shot;

  console.log('站点 ' + siteId + ' (' + report.url + ')');
  console.log('触发: ' + JSON.stringify(report.target));
  console.log('节点数 ' + before.length + ' → ' + after.length + '，新增 ' + report.appeared.length + ' 个：');
  for (const a of report.appeared.slice(0, 70)) {
    console.log('  [' + a.tag + (a.role ? ' role=' + a.role : '') + (a.ariaLabel ? ' aria=' + a.ariaLabel : '') + '] '
      + JSON.stringify(a.text.slice(0, 60)) + '  @' + a.x + ',' + a.y + ' ' + a.cls.slice(0, 70));
  }
} catch (err) {
  report.error = String(err?.message || err);
  console.error('✗ ' + report.error);
} finally {
  const outFile = path.join(OUT_DIR, `model-dropdown-${siteId}-${TS}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log('\n证据: ' + outFile);
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}