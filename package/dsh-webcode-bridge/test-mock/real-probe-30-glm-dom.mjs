// real-probe-30-glm-dom.mjs — chatglm.cn 助手消息节点实测（2026-09-26，0.19.16）。
//
// 只回答一个问题：GLM 页面上「助手这条回复」的 DOM 节点该用什么选择器找到？
// 为什么必须实测而不是猜：browser-driver 里 WIP 巡检与超时现场两处硬编码的是
// DeepSeek 专用串 `.markdown, [data-message-author-role="assistant"], .ds-markdown`，
// 对 chatglm.cn 可能一个都不命中 —— 那时 domLen 恒为 0，`lastDomGrowthAt` 从不刷新，
// shouldSettleWip 的「DOM 停长」条件**恒成立**，收束器会在页面还在写字时提前收束。
//
// 本探针**只读**：导航到一条**既有会话**（resume，不发消息、不消耗额度、不触发风控），
// 采样 DOM 结构并给出候选选择器的命中读数。判定由真机层高读数决定，不由类名猜。
//
// 用法：
//   node test-mock/real-probe-30-glm-dom.mjs
//   $env:PROBE_CID='6ab246509e6edca3f64ce306'   # 可选，覆盖默认会话
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROFILE = process.env.PROBE_PROFILE
  || 'C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/glm';
// 默认取 glm 会话台账里最近一条真实会话（只读导航）。
const CID = process.env.PROBE_CID || '6ab246509e6edca3f64ce306';
const URL = 'https://chatglm.cn/main/alltoolsdetail?cid=' + encodeURIComponent(CID);
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'glm-dom-probe.json');

const say = (...a) => console.log(...a);

// 页面里跑的采样器：对每个候选选择器给出「命中数 / 是否可见 / 文本长度 /
// 该节点的祖先链类名」，并对**最深的**文本块回溯它的容器——因为 GLM 把正文
// 切成多个块，最外层容器才是「这一条回复」。
const SAMPLE = `(() => {
  const out = { url: location.href, candidates: [], blocks: [], containers: [] };
  const sels = [
    '.markdown', '.ds-markdown', '.answer', '.response-container',
    '[data-message-author-role]', '[data-role]', '[class*=markdown]',
    '[class*=answer]', '[class*=message]', '[class*=chat-item]',
    '[class*=conversation]', '[class*=assistant]', '[class*=reply]',
    '[class*=bubble]', '[class*=content]', 'main'
  ];
  const desc = (el) => {
    const cls = (typeof el.className === 'string' ? el.className : '').trim();
    return { tag: el.tagName.toLowerCase(), cls: cls.slice(0, 120),
             id: el.id || '', len: (el.innerText || '').length };
  };
  for (const s of sels) {
    let nodes = [];
    try { nodes = [...document.querySelectorAll(s)]; } catch { continue; }
    const visible = nodes.filter(n => n.offsetParent !== null || n.getClientRects().length);
    out.candidates.push({
      sel: s, count: nodes.length, visible: visible.length,
      lens: visible.slice(-3).map(n => (n.innerText || '').length),
    });
  }
  // 最深文本块：叶子级、有实际文本的元素——正文的真实落点。
  const all = [...document.querySelectorAll('main *')];
  const leaves = all.filter(el => {
    const t = (el.innerText || '').trim();
    if (t.length < 2 || t.length > 4000) return false;
    return ![...el.children].some(c => ((c.innerText || '').trim().length > t.length * 0.6));
  });
  out.blocks = leaves.slice(-40).map(desc);
  // 对最后几个文本块回溯祖先链：找出「文本最长、且不含输入框」的容器。
  const seen = new Set();
  for (const leaf of leaves.slice(-8)) {
    let n = leaf;
    for (let up = 0; up < 8 && n; up++, n = n.parentElement) {
      const key = n.tagName + '.' + (typeof n.className === 'string' ? n.className : '') + '#' + n.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const d = desc(n);
      d.depth = up;
      d.hasInput = Boolean(n.querySelector && n.querySelector('textarea, [contenteditable="true"]'));
      d.childCount = n.children ? n.children.length : 0;
      out.containers.push(d);
    }
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
  // 等前端把会话正文渲染出来。这里是**读**，不是发消息：只等，不做任何交互。
  await page.waitForTimeout(8000);
  const sample = await page.evaluate(SAMPLE);
  result.ok = true;
  result.sample = sample;
  result.pageUrl = page.url();
  // 登录态旁证：与 providers.js 的 loginProbe 同口径。
  result.loginOk = await page.evaluate(() => {
    const el = document.querySelector('.userInfoBar, p.sidebar-user-name');
    return el ? (el.innerText || '').trim().slice(0, 40) : null;
  }).catch(() => null);
  say('\n[候选选择器命中读数]');
  for (const c of sample.candidates) {
    say(`  ${c.sel.padEnd(34)} count=${String(c.count).padStart(4)} visible=${String(c.visible).padStart(4)} lens=[${c.lens.join(',')}]`);
  }
  say('\n[最深文本块（末 12）]');
  for (const b of sample.blocks.slice(-12)) {
    say(`  <${b.tag} class="${b.cls}"> len=${b.len}`);
  }
  say('\n[回溯祖先链：非输入框、文本最多的容器]');
  const cands = sample.containers.filter(c => !c.hasInput).sort((a, b) => b.len - a.len).slice(0, 10);
  for (const c of cands) {
    say(`  depth=${c.depth} <${c.tag} class="${c.cls}"> len=${c.len} children=${c.childCount}`);
  }
  result.best = cands[0] || null;
  say('\n[登录态旁证] ' + JSON.stringify(result.loginOk));
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  say('\n[落盘] ' + OUT);
} catch (e) {
  result.error = String(e && e.message || e);
  say('[失败] ' + result.error);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  process.exitCode = 1;
} finally {
  try { if (browser) await browser.close(); } catch {}
}
