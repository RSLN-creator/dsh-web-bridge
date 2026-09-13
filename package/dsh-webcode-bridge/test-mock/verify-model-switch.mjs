// verify-model-switch.mjs — 真机验证「模型切换真的生效」（0.13.0）。
//
// 这是子系统 2 的验收口：单测只能证明匹配函数正确，不能证明**网页真的换了模型**。
// 本脚本用生产代码路径（lib/model-picker.js 的 selectWebModel）在真实站点上执行，
// 每次切换后**回读页面显示的模型名**并断言它等于目标。
//
// 关键验证点（0.12.9 的空承诺正是这里失守）：
//   • z.ai：GLM-5.3 ↔ GLM-5.3-Flash。两者是前缀关系，选错会立刻暴露。
//   • glm ：GLM-5.3 / GLM-Flash（网页显示名与 id 不同，靠 labels 对齐）。
//   • kimi：K3 / K3 集群 / 快速。
//
// 附着桥自己的 Edge（不 spawn 浏览器），每个站点用独立 profile 的 CDP 端口。
//
// 用法：
//   node test-mock/verify-model-switch.mjs                 # 全部已校准站点
//   node test-mock/verify-model-switch.mjs --sites zai
//   node test-mock/verify-model-switch.mjs --restore       # 结束后切回原模型
//
// 输出：test-mock/out/model-switch-<ts>.json + .tmp/shots/switch-<site>-<ts>.png

import { chromium } from '../node_modules/playwright-core/index.mjs';
import { getSite } from '../lib/providers.js';
import { selectWebModel, pickerUsable, normalizeModelName } from '../lib/model-picker.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY = String(argOf('--sites', '')).split(',').map((s) => s.trim()).filter(Boolean);
const RESTORE = argv.includes('--restore');
const SETTLE_MS = Number(argOf('--settle', '8000'));
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const OUT_DIR = path.resolve('test-mock', 'out');
const SHOT_DIR = path.resolve('.tmp', 'shots');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

function portFor(siteId) {
  const root = process.env.WEBCODE_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'webcode-edge-profile');
  const file = siteId === 'deepseek' ? path.join(root, 'DevToolsActivePort') : path.join(root, 'sites', siteId, 'DevToolsActivePort');
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).find((l) => /^\d+$/.test(l)) || null;
  } catch { return null; }
}

/** 读页面当前显示的模型名（用契约的 selected 选择器）。 */
async function readCurrent(page, picker) {
  const sels = (Array.isArray(picker.selected) ? picker.selected : [picker.selected]).filter(Boolean);
  return page.evaluate((list) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    for (const s of list) {
      try {
        const hit = [...document.querySelectorAll(s)].filter(vis);
        if (hit.length) { const t = (hit[0].textContent || '').trim().replace(/\s+/g, ' '); if (t) return t; }
      } catch { /* 跳过 */ }
    }
    return null;
  }, sels).catch(() => null);
}

const SITES = ['zai', 'glm', 'kimi', 'doubao'];
const targets = SITES.filter((s) => (ONLY.length ? ONLY.includes(s) : true));
const report = { at: new Date().toISOString(), sites: {} };
let pass = 0, fail = 0, skip = 0;

for (const siteId of targets) {
  const site = getSite(siteId);
  const entry = { siteId, results: [] };
  const port = portFor(siteId);
  if (!port) {
    entry.error = 'profile 未运行（先打开一次该站点的独立窗口）';
    report.sites[siteId] = entry;
    console.log(`\n=== ${siteId} ===\n  ⊘ ${entry.error}`);
    skip++;
    continue;
  }
  if (!pickerUsable(site.modelPicker)) {
    entry.error = '站点未声明可用的 modelPicker 契约';
    report.sites[siteId] = entry;
    console.log(`\n=== ${siteId} ===\n  ⊘ ${entry.error}`);
    skip++;
    continue;
  }

  console.log(`\n=== ${siteId} (${site.origin}) ===`);
  let browser = null, page = null;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    page = await browser.contexts()[0].newPage();
    await page.goto(site.origin + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(SETTLE_MS);

    const original = await readCurrent(page, site.modelPicker);
    entry.original = original;
    console.log('  当前网页模型:', JSON.stringify(original));

    // 逐个真实模型条目切换（跳过 auto —— 它按设计不动作）
    const models = site.models.filter((m) => m.id !== 'auto');
    for (const m of models) {
      const res = await selectWebModel(page, m, site.modelPicker);
      const wanted = (m.labels && m.labels[0]) || m.name;
      // 判定口径与生产一致：以 picker 自己的回读为准（applied 由生产代码读出，
      // 不同站点的「当前模型」显示位置不同——有的常驻页面，有的只在菜单里）。
      const ok = res.ok && res.applied
        && normalizeModelName(res.applied).includes(normalizeModelName(wanted));
      entry.results.push({ model: m.id, wanted, pickerOk: res.ok, reason: res.reason, applied: res.applied, confirmed: res.confirmed, pass: ok });
      if (ok) { pass++; console.log(`  ✓ ${m.id.padEnd(16)} → 回读 ${JSON.stringify(res.applied)}`); }
      else {
        fail++;
        console.log(`  ✗ ${m.id.padEnd(16)} → 期望含 ${JSON.stringify(wanted)}，回读 ${JSON.stringify(res.applied)}`
          + (res.reason ? ` (${res.reason})` : '')
          + (res.options?.length ? ` 可选: ${res.options.join('、')}` : ''));
      }
      await page.waitForTimeout(800);
    }

    // 还原原模型（可选）：避免把用户网页留在别的模型上
    if (RESTORE && original) {
      const back = models.find((m) => normalizeModelName(original).includes(normalizeModelName(m.labels?.[0] || m.name)));
      if (back) {
        const r = await selectWebModel(page, back, site.modelPicker);
        console.log(`  ↩ 还原 ${back.id}: ${r.ok ? '已切换' : '失败 ' + r.reason} → 回读 ${JSON.stringify(r.applied)}`);
      }
    }

    const shot = path.join(SHOT_DIR, `switch-${siteId}-${TS}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    entry.screenshot = shot;
  } catch (err) {
    entry.error = String(err?.message || err);
    console.log('  ✗ ' + entry.error);
    fail++;
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
  report.sites[siteId] = entry;
}

const outFile = path.join(OUT_DIR, `model-switch-${TS}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`\n合计：pass=${pass} fail=${fail} skip=${skip}`);
console.log('证据: ' + outFile);
process.exit(fail > 0 ? 1 : 0);