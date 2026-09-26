// real-probe-31-glm-dom-deep.mjs — chatglm.cn「助手回复节点」深度采样（2026-09-26，0.19.18）。
//
// 为什么需要第二支探针：real-probe-30 只回答「候选选择器命中吗」，实测全部 0。
// 那还不够——要**修**就得知道真实的类名/结构。本探针**只读**地：
//   ① 导航到一条既有会话（resume，不发消息、不消耗额度、不触发风控）；
//   ② 等页面渲染完，把 `main`（或 body）下的**可见元素树**按深度打印出来；
//   ③ 输出每个节点的 tag/class/id/文本长度/子节点数，供人工/程序挑出回复容器。
//
// 用法：
//   node test-mock/real-probe-31-glm-dom-deep.mjs
//   $env:PROBE_CID='<真实会话 cid>'   # 强烈建议指定一条**有正文**的会话
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROFILE = process.env.PROBE_PROFILE || 'C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/glm';
const CID = process.env.PROBE_CID || '6aae94fde630c717fe0361a6';
const URL = 'https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=' + encodeURIComponent(CID);
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'glm-dom-deep.json');
const say = (...a) => console.log(...a);

// 页面侧采样器：把「看起来像消息流」的子树按深度展开。
const SAMPLE = `(() => {
  const out = { url: location.href, title: document.title, nodes: [], counts: {}, candidates: [] };
  const txt = (el) => (el.innerText || '').trim();
  const vis = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
  const desc = (el, depth) => ({
    depth, tag: el.tagName.toLowerCase(),
    cls: (typeof el.className === 'string' ? el.className : '').slice(0, 150),
    id: el.id || '',
    len: txt(el).length,
    kids: el.children ? el.children.length : 0,
    visible: vis(el),
  });

  // ① 先把所有「有可观文本且可见」的元素收上来，按文本长度排序。
  const all = [...document.querySelectorAll('body *')].filter(vis);
  const withText = all.filter((el) => txt(el).length >= 20);
  // 只保留「文本主要在自己身上」的（叶子优先）——回复容器通常是最深的那个大文本节点。
  const leafish = withText.filter((el) => {
    const t = txt(el).length;
    return ![...el.children].some((c) => txt(c).length > t * 0.85);
  });
  out.nodes = leafish.sort((a, b) => txt(b).length - txt(a).length).slice(0, 25).map((el) => {
    const d = desc(el, 0);
    // 往上回溯 6 层，记录祖先链（找「这一条回复」的容器）
    const chain = [];
    let n = el.parentElement;
    for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
      const c = desc(n, i + 1);
      c.hasInput = Boolean(n.querySelector && n.querySelector('textarea, [contenteditable="true"]'));
      chain.push(c);
    }
    d.chain = chain;
    return d;
  });

  // ② 类名频率统计：找出 GLM 自己用的命名族（含 build hash 的那种）。
  const freq = {};
  for (const el of all) {
    const c = typeof el.className === 'string' ? el.className.trim() : '';
    if (!c) continue;
    for (const part of c.split(/\\s+/)) {
      if (part.length < 3 || part.length > 40) continue;
      freq[part] = (freq[part] || 0) + 1;
    }
  }
  out.counts = Object.fromEntries(Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 40));

  // ③ 关键容器探测：GLM 把消息放在哪（按「子节点数 + 文本量」找滚动区）。
  for (const sel of ['main', '[class*=chat]', '[class*=list]', '[class*=scroll]', '[class*=wrap]', '[class*=main]', '[class*=session]', '[class*=dialog]']) {
    let nodes = [];
    try { nodes = [...document.querySelectorAll(sel)].filter(vis); } catch { continue; }
    if (!nodes.length) continue;
    out.candidates.push({
      sel, count: nodes.length,
      top: nodes.sort((a, b) => txt(b).length - txt(a).length).slice(0, 3).map((el) => desc(el, 0)),
    });
  }
  return out;
})()`;

let browser = null;
const result = { at: new Date().toISOString(), profile: PROFILE, url: URL, ok: false };
try {
  const exe = resolveBrowserExecutable().path;
  say('[浏览器] ' + exe);
  browser = await chromium.launchPersistentContext(PROFILE, {
    executablePath: exe, headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = browser.pages()[0] || await browser.newPage();
  say('[导航] ' + URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(10_000);
  const sample = await page.evaluate(SAMPLE);
  result.ok = true;
  result.sample = sample;
  result.pageUrl = page.url();

  say('\n[页面] title=' + JSON.stringify(sample.title) + ' url=' + sample.url);
  say('\n[最长可见文本节点（叶子优先，末 25）]');
  for (const n of sample.nodes) {
    say(`  len=${String(n.len).padStart(6)} <${n.tag} class="${n.cls}" id="${n.id}"> kids=${n.kids}`);
    for (const c of n.chain.slice(0, 4)) {
      say(`       ↑ depth=${c.depth} <${c.tag} class="${c.cls}" id="${c.id}"> len=${c.len} kids=${c.kids} input=${c.hasInput}`);
    }
  }
  say('\n[类名频率 top40]');
  for (const [k, v] of Object.entries(sample.counts)) say(`  ${String(v).padStart(5)}  ${k}`);
  say('\n[容器候选]');
  for (const c of sample.candidates) {
    say(`  ${c.sel.padEnd(22)} count=${c.count} topLens=[${c.top.map((t) => t.len).join(',')}] topCls=[${c.top.map((t) => t.cls.slice(0, 50)).join(' | ')}]`);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  say('\n[落盘] ' + OUT);
} catch (e) {
  result.error = String((e && e.message) || e);
  say('[失败] ' + result.error);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  process.exitCode = 1;
} finally {
  try { if (browser) await browser.close(); } catch {}
}
