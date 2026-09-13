// probe-model-picker.mjs — 真机枚举各站点的**模型选择器** DOM（0.13.0）。
//
// 为什么必须有这个脚本：providers.js 里的 `models` 目录是给用户看的承诺。
// 0.12.9 之前每个站点只有一条 `auto`（「网页当前模型」），驱动拿到 auto 直接
// 返回、**页面上一个动作都不做**——模型选择器里写什么名字都不会真的切换。
// 要把它换成真实条目（如 z.ai 的 GLM-5.3 / GLM-5.3-Flash），就必须知道：
//   1. 触发按钮长什么样（文本 / aria-label / class / 位置）
//   2. 点开之后选项是什么文本（这才是能写进 models 的**事实**）
//
// 证据通路与 real-mirror-matrix.mjs 相同：**附着**到桥自己已经开着的 Edge
//（profile 里有登录态），绝不 spawn 浏览器（本机沙箱下 spawn 必 EPERM）。
//
// 用法：
//   node test-mock/probe-model-picker.mjs                     # 全部已登录站点
//   node test-mock/probe-model-picker.mjs --sites zai,glm
//   node test-mock/probe-model-picker.mjs --keep              # 保留页面
//
// 输出：test-mock/out/model-picker-<ts>.json + .tmp/shots/picker-<sid>-<ts>.png
//       控制台打印每个站点可直接抄进 providers.js 的 options 文本清单。

import { chromium } from '../node_modules/playwright-core/index.mjs';
import { SITES, getSite } from '../lib/providers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ONLY = String(argOf('--sites', '')).split(',').map((s) => s.trim()).filter(Boolean);
const KEEP = argv.includes('--keep');
const SETTLE_MS = Number(argOf('--settle', '6000'));
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const OUT_DIR = path.resolve('test-mock', 'out');
const SHOT_DIR = path.resolve('.tmp', 'shots');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

/** 找出**全部**活着的桥 profile 及其 CDP 端口。
 *
 * 多站点下每个站点一个独立 profile（<root>/sites/<siteId>），各自一个
 * DevToolsActivePort —— 只认根目录会漏掉除 deepseek 外的所有站点
 *（0.13.0 首跑踩过：以为「站点没开」，其实是找错了文件）。 */
function findCdpAll() {
  const root = process.env.WEBCODE_PROFILE_DIR
    || path.join(os.homedir(), '.dsh', 'webcode-edge-profile');
  const found = new Map();   // siteId -> { port, file }
  const readPort = (file) => {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
      const port = lines.find((l) => /^\d+$/.test(l));
      return port || null;
    } catch { return null; }
  };
  const rootPort = readPort(path.join(root, 'DevToolsActivePort'));
  if (rootPort) found.set('deepseek', { port: rootPort, file: path.join(root, 'DevToolsActivePort') });
  try {
    for (const entry of fs.readdirSync(path.join(root, 'sites'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, 'sites', entry.name, 'DevToolsActivePort');
      const port = readPort(file);
      if (port) found.set(entry.name, { port, file });
    }
  } catch { /* 没有 sites 目录 = 只有 deepseek */ }
  // 兼容旧布局（工作区里的 .edge-real-profile）
  const legacy = readPort(path.resolve('.edge-real-profile', 'DevToolsActivePort'));
  if (legacy && !found.size) found.set('deepseek', { port: legacy, file: path.resolve('.edge-real-profile', 'DevToolsActivePort') });
  return found;
}

/** 在页面里跑的 DOM 枚举：只读，不点击。 */
const DUMP_SCRIPT = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || '1') > 0.05;
  };
  const txt = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const cls = (el) => String(el.className || '').slice(0, 120);

  const composer = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .find((e) => vis(e) && e.getBoundingClientRect().width > 40) || null;
  // composer 附近（向上 6 层）是模型/模式控件的常见归属区
  let scope = composer;
  for (let i = 0; i < 6 && scope?.parentElement; i++) scope = scope.parentElement;
  const root = scope || document.body;

  const describe = (el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      text: txt(el),
      ariaLabel: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
      haspopup: el.getAttribute('aria-haspopup'),
      expanded: el.getAttribute('aria-expanded'),
      pressed: el.getAttribute('aria-pressed'),
      testid: el.getAttribute('data-testid'),
      cls: cls(el),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    };
  };

  const collect = (container, cap) => {
    const out = [];
    const seen = new Set();
    for (const el of container.querySelectorAll('button, [role="button"], [role="combobox"], [aria-haspopup], [aria-pressed], [data-testid], select')) {
      if (!vis(el) || seen.has(el)) continue;
      seen.add(el);
      if (!txt(el) && !el.getAttribute('aria-label') && !el.getAttribute('data-testid')) continue;
      out.push(describe(el));
      if (out.length >= cap) break;
    }
    return out;
  };

  // ① composer 附近（点开弹层的触发大概率在这里）
  const controls = collect(root, 120);
  // ② 整页（模型切换器也可能在顶栏/侧栏——z.ai 首跑就没在 composer 区找到）
  const pageControls = collect(document.body, 200);
  // ③ 显式找「模型」味道的节点：class/id/aria 里带 model 的
  const modelNodes = [];
  for (const el of document.querySelectorAll('[class*="model" i], [id*="model" i], [data-testid*="model" i], [aria-label*="model" i], [class*="Model"]')) {
    if (!vis(el)) continue;
    modelNodes.push(describe(el));
    if (modelNodes.length >= 40) break;
  }

  // 整页里带「模型/版本号」味道的文本节点（触发按钮可能在 composer 之外，
  // 例如顶栏）。只取叶子节点，避免祖先 div 把整段界面文字都吐出来。
  const modelish = [];
  const RE = /(GLM|GPT|Claude|Gemini|Qwen|Kimi|DeepSeek|Grok|Doubao|豆包|通义|月之暗面|模型|Model|模式|Mode|\d+\.\d+)/i;
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length) continue;
    if (!vis(el)) continue;
    const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (!t || t.length > 40 || !RE.test(t)) continue;
    const r = el.getBoundingClientRect();
    modelish.push({ text: t, tag: el.tagName.toLowerCase(), cls: cls(el), x: Math.round(r.x), y: Math.round(r.y) });
    if (modelish.length >= 60) break;
  }

  return {
    url: location.href,
    title: document.title,
    hasComposer: Boolean(composer),
    composer: composer ? { tag: composer.tagName.toLowerCase(), cls: cls(composer), id: composer.id || '' } : null,
    controls,
    pageControls,
    modelNodes,
    modelish,
  };
};

/** 按坐标点开一个控件，再枚举弹层里的选项文本。
 *
 * 用坐标而不是 DOM 下标：控件可能来自三份不同的清单（composer 附近 / 整页 /
 * class 带 model 的节点），按坐标点击对三者一视同仁。 */
async function openAndListAt(page, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'no coordinates' };
  await page.mouse.click(x + 4, y + 4);
  await page.waitForTimeout(900);
  const out = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const res = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="radio"], [role="listbox"] *, [class*="option" i], [class*="model-item" i], [class*="ModelItem"], [class*="dropdown" i] *, [class*="menu" i] *')) {
      if (!vis(el)) continue;
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!t || t.length > 80) continue;
      if (el.children.length && t.length > 40) continue;   // 跳过把整块菜单都包住的祖先
      const key = t + '@' + Math.round(el.getBoundingClientRect().y);
      if (seen.has(key)) continue;
      seen.add(key);
      res.push({ text: t, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), cls: String(el.className || '').slice(0, 100) });
      if (res.length >= 40) break;
    }
    return res;
  });
  // 关掉弹层，不改变站点状态
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  return { ok: true, options: out };
}

const cdpAll = findCdpAll();
if (!cdpAll.size) {
  console.error('✗ 找不到任何 DevToolsActivePort —— 桥的 Edge 没在跑。先打开一次任意站点的「独立窗口」。');
  process.exit(1);
}
console.log('活着的 profile：' + [...cdpAll.entries()].map(([s, v]) => s + '=' + v.port).join(', '));

const targets = SITES.filter((s) => (ONLY.length ? ONLY.includes(s.id) : true)
  && !['chatgpt', 'claude', 'gemini'].includes(s.id));   // 三个上游不可达站点不在本轮范围

const report = { at: new Date().toISOString(), profiles: Object.fromEntries([...cdpAll].map(([s, v]) => [s, v.port])), sites: {} };

for (const st of targets) {
  const cdp = cdpAll.get(st.id);
  const entry = { siteId: st.id, origin: st.origin, ok: false };
  if (!cdp) {
    entry.error = '该站点的 Edge profile 未运行（先打开一次它的「独立窗口」）';
    report.sites[st.id] = entry;
    console.log('\n=== ' + st.id + ' ===\n  ✗ ' + entry.error);
    continue;
  }
  entry.cdpPort = cdp.port;
  let browser = null;
  let page = null;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdp.port);
    const context = browser.contexts()[0];
    page = await context.newPage();
    await page.goto(st.origin + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(SETTLE_MS);
    const dump = await page.evaluate(DUMP_SCRIPT);
    entry.dump = dump;
    entry.loggedInGuess = /登录|Sign in|Log in/i.test(
      (dump.controls || []).map((c) => c.text || '').join(' ') + (dump.modelish || []).map((m) => m.text).join(' '),
    ) ? false : true;

    // 对「看起来像模型选择器」的控件逐个点开枚举选项。
    // 候选来自三处：composer 附近、整页可点控件、class/id 带 model 的节点。
    // 只扫 composer 附近会漏（z.ai 首跑：切换器根本不在输入框容器里）。
    const pool = [
      ...(dump.controls || []).map((c) => ({ c, where: 'composer' })),
      ...(dump.pageControls || []).map((c) => ({ c, where: 'page' })),
      ...(dump.modelNodes || []).map((c) => ({ c, where: 'modelNode' })),
    ];
    const seenKey = new Set();
    const suspects = pool.filter(({ c }) => {
      const s = (c.text || '') + ' ' + (c.ariaLabel || '') + ' ' + (c.cls || '') + ' ' + (c.testid || '');
      if (!/model|模型|mode|模式|glm|gpt|claude|gemini|qwen|kimi|deepseek|grok|doubao|豆包|通义|\d+\.\d+/i.test(s)) return false;
      const key = [c.tag, c.text, c.ariaLabel, c.x, c.y].join('|');
      if (seenKey.has(key)) return false;      // 同一个控件在多份清单里重复出现
      seenKey.add(key);
      return true;
    }).slice(0, 8);
    entry.pickerAttempts = [];
    for (const { c, where } of suspects) {
      try {
        // openAndList 按「composer 附近列表」的下标取元素 —— 这里改成按坐标点，
        // 三份清单的控件都能点，不依赖它在哪份清单里。
        const res = await openAndListAt(page, c.x, c.y);
        entry.pickerAttempts.push({ control: c, where, ...res });
      } catch (err) {
        entry.pickerAttempts.push({ control: c, where, ok: false, error: String(err?.message || err) });
      }
      await page.waitForTimeout(400);
    }
    const shot = path.join(SHOT_DIR, `picker-${st.id}-${TS}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    entry.screenshot = shot;
    entry.ok = true;
  } catch (err) {
    entry.error = String(err?.message || err);
  } finally {
    if (!KEEP) await page?.close().catch(() => {});
    await browser?.close().catch(() => {});   // closeOverCDP 只断开，不杀浏览器
  }
  report.sites[st.id] = entry;

  // 控制台直接给「可抄进 providers.js」的清单
  console.log('\n=== ' + st.id + ' (' + st.origin + ') ===');
  if (!entry.ok) { console.log('  ✗ ' + entry.error); continue; }
  console.log('  composer:', entry.dump.composer ? entry.dump.composer.tag + ' .' + entry.dump.composer.cls : '未找到');
  const opts = new Set();
  for (const a of entry.pickerAttempts || []) {
    if (!a.ok) continue;
    const label = (a.control.text || a.control.ariaLabel || a.control.cls || '?').slice(0, 40);
    console.log('  点[' + a.where + ']「' + label + '」→ ' + (a.options || []).length + ' 个候选');
    for (const o of (a.options || []).slice(0, 25)) opts.add(o.text);
  }
  if (opts.size) {
    console.log('  候选文本：');
    for (const t of opts) console.log('    - ' + t);
  } else {
    console.log('  未枚举到选项（触发未命中，或弹层用的是非标准节点）');
    console.log('  modelish 文本：' + (entry.dump.modelish || []).slice(0, 20).map((m) => m.text).join(' | '));
  }
}

const outFile = path.join(OUT_DIR, `model-picker-${TS}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log('\n证据已写入: ' + outFile);
console.log('截图目录: ' + SHOT_DIR);