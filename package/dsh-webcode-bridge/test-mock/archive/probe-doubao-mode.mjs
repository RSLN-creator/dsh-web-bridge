// probe-doubao-mode.mjs — 豆包「对话 / 工作」模式切换器的结构取证（0.13.0 补）。
//
// 用户指出：豆包的「模型」其实是**对话 / 工作**两个模式，不是下拉式模型选择器。
// 本脚本定位这两个控件所在的容器与类名，并观察：
//   • 点击后是否弹出「弹窗」（用户提示：切换需要关弹窗）
//   • 模式是否体现在 URL / 页面主区
//
// 用法：node test-mock/probe-doubao-mode.mjs
// 输出：test-mock/out/doubao-mode-<ts>.json

import { chromium } from '../node_modules/playwright-core/index.mjs';
import { getSite } from '../lib/providers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = path.resolve('test-mock', 'out');
const SHOT_DIR = path.resolve('.tmp', 'shots');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const site = getSite('doubao');
const root = process.env.WEBCODE_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'webcode-edge-profile');
const portFile = path.join(root, 'sites', 'doubao', 'DevToolsActivePort');
let port = null;
try {
  port = fs.readFileSync(portFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).find((l) => /^\d+$/.test(l));
} catch { /* 下面报错 */ }
if (!port) { console.error('✗ doubao 的 Edge 没在跑'); process.exit(1); }

/** 找「对话 / 工作」这两个控件，dump 它们自己与祖先链。 */
const FIND_MODES = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const text = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      text: text(el).slice(0, 40),
      cls: String(el.className || '').slice(0, 160),
      role: el.getAttribute('role'),
      ariaSelected: el.getAttribute('aria-selected'),
      ariaChecked: el.getAttribute('aria-checked'),
      dataState: el.getAttribute('data-state'),
      testid: el.getAttribute('data-testid'),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    };
  };
  const hits = [];
  for (const el of document.querySelectorAll('button, [role="button"], [role="tab"], [role="radio"], div, span')) {
    if (!vis(el)) continue;
    const t = text(el);
    if (t !== '对话' && t !== '工作') continue;
    // 只要最贴近的节点（自身没有同文本子元素）
    const childSame = [...el.children].some((c) => text(c) === t);
    if (childSame) continue;
    // 祖先链（最多 4 层）——用来找共同容器
    const chain = [];
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) chain.push(describe(p));
    hits.push({ self: describe(el), ancestors: chain });
  }
  return hits;
};

const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
const page = await browser.contexts()[0].newPage();
const report = { at: new Date().toISOString(), url: null, steps: [] };
try {
  await page.goto(site.origin + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(9000);
  report.url = page.url();
  report.title = await page.title();
  report.modes = await page.evaluate(FIND_MODES);
  console.log('页面:', report.url);
  console.log('找到 ' + report.modes.length + ' 个「对话/工作」节点:');
  for (const m of report.modes) {
    console.log('  [' + m.self.tag + (m.self.role ? ' role=' + m.self.role : '') + '] '
      + JSON.stringify(m.self.text) + ' @' + m.self.x + ',' + m.self.y
      + ' aria-selected=' + m.self.ariaSelected + ' cls=' + m.self.cls.slice(0, 70));
  }

  // 点击「工作」，看是否出现弹窗/对话框，以及 URL 变化
  const before = await page.evaluate(() => ({
    url: location.href,
    dialogs: document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog').length,
  }));
  const workBtn = page.locator('button:has-text("工作")').first();
  if (await workBtn.count()) {
    await workBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  const after = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const dialogs = [];
    for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog, [class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"]')) {
      if (!vis(el)) continue;
      dialogs.push({ cls: String(el.className || '').slice(0, 120), text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100) });
    }
    return { url: location.href, dialogs, bodyHead: document.body.innerText.slice(0, 200).replace(/\s+/g, ' ') };
  });
  report.workClick = { before, after };
  console.log('\n点「工作」后:');
  console.log('  url:', after.url);
  console.log('  可见弹窗:', after.dialogs.length);
  for (const d of after.dialogs.slice(0, 5)) console.log('    - ' + JSON.stringify(d.text) + ' cls=' + d.cls.slice(0, 60));
  console.log('  正文开头:', JSON.stringify(after.bodyHead.slice(0, 120)));

  const shot = path.join(SHOT_DIR, `doubao-mode-${TS}.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  report.screenshot = shot;
} catch (err) {
  report.error = String(err?.message || err);
  console.error('✗ ' + report.error);
} finally {
  const outFile = path.join(OUT_DIR, `doubao-mode-${TS}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log('\n证据: ' + outFile);
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}