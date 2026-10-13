// zai-capture-frames.mjs — z.ai 一轮的**原始 completion 帧**取证（#30 的唯一出路）。
//
// 为什么需要这个文件（以及它为什么在 `test-mock/` 而不是 `.tmp-probe/`）：
//
// `.tmp-probe/` 被 `.gitignore:61` 覆盖 ⇒ 那里的一切**对克隆仓库的人不存在**。
// 而 `lib/providers.js`（ZAI 条目）与 `doc/long-term-issues.md` §30 都在正文里叫读者去
// `.tmp-probe/zai/RESULT.md` 与 `.tmp-probe/zai/probe-zai-chat-frames.mjs` 取抓帧步骤——
// 那是本仓库明令禁止的形态：「任何『外面没有它就理解不了』的信息必须放在 `doc/` 或随包发布的
// 源码里」（`wiki/protocol.md` §5、`AGENTS.md` §1）。本文件就是那条引用的**入库落点**。
//
// 为什么不能走 driver：`sendTurn` 只认「开新会话」这一条路（zai 的会话地址形状实测
// **不可导航**，见 providers.js 的 `CONVERSATION_URL_SHAPES` 注释与 §30），而新会话必然先
// `POST /api/v1/chats/new`，那一步在真机上触发了阿里云滑块风控（见 §30 的证据链），
// completion 请求根本没发出去 —— 于是永远抓不到帧。
//
// 本探针换一条**只读页面 + 手工发送**的路：
//   ① 打开 https://chat.z.ai/（已登录的**副本** profile）；
//   ② 在**左侧会话列表里点开一个既有会话**（SPA 客户端路由 → 不新建会话）；
//   ③ 在页面里装自己的 fetch tee（只对 `/api/chat/completions` tee 出响应流）；
//   ④ 用 `lib/providers.js` 里 zai 声明的**同一个**输入框/发送按钮选择器填字并点发送；
//   ⑤ 把 tee 到的**原始字节**逐字落盘，再用 `lib/decoder.js` 的注册表分别解一遍。
//
// 关键纪律：本探针**不使用 browser-driver**，因此不碰账号互斥锁（`bridge-lock.js`），
// 也不改任何 `lib/` 代码；它抓到的字节就是「z.ai 真正的 wire 形状」的第一手证据。
//
// ⚠ 风控（#29）挡在发送之前 ⇒ **必须有人在场**：有头窗口里人工把滑块拖过去，
//   帧才会到。无头/无人值守跑只会得到 0 帧，这不是脚本坏了。
//
// 用法（在仓库根跑）：
//   $env:PROBE_HEADED='1'; node package/dsh-webcode-bridge/test-mock/zai-capture-frames.mjs
//   $env:PROBE_PROFILE='C:\path\to\profile'   # 指定已登录的副本 profile（默认见下）
//   $env:PROBE_PROMPT='请只回复三个字：你好呀'
//   $env:PROBE_WAIT_MS=150000                 # 停在页面上等人过闸的时间
//
// 退出码：0 = 跑完（**帧为零也退 0**，读数在 summary.json 里如实记；脚本不替人下结论）；
//         1 = 自身出错（浏览器起不来 / 选择器找不到 / 没登录）。
//
// 产物：`test-mock/out/zai-capture/<时间戳>/{summary.json,raw-stream.log,page.png}`
//   （`test-mock/out/` 被 `.gitignore` 覆盖——它是每次跑都变的产物，不是证据本体；
//     要留档的真帧夹具必须**逐字**搬进 `test/fixtures/zai-real-frames/`，见 §30 的下一步。）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const PKG = path.join(ROOT, 'package', 'dsh-webcode-bridge');
const requirePkg = createRequire(pathToFileURL(path.join(PKG, 'package.json')).href);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = path.join(HERE, 'out', 'zai-capture', STAMP);

/**
 * 默认 profile：`test-mock/.zai-probe-profile`（被 `.gitignore` 的
 * `test-mock/.*-profile…` 那条通配规则覆盖，与其它真机探针同一口径）。
 *
 * 为什么用**副本**而不是桥自己的 profile：源 profile 会被 DSH 启动的那个浏览器独占
 * （`Network/Cookies` 复制稳定 EBUSY，§30 实测 3/3），在它上面再开浏览器会与运行中的桥
 * 抢账号。副本里必须剔除 `webcode-bridge.lock.json`，否则被判 `BRIDGE_ACCOUNT_BUSY`。
 */
const PROFILE = process.env.PROBE_PROFILE || path.join(HERE, '.zai-probe-profile');
const PROMPT = process.env.PROBE_PROMPT || '请只回复三个字：你好呀';
const WAIT_MS = Number(process.env.PROBE_WAIT_MS) || 150_000;
// 有头开关：无头 Chromium 的 UA 字面量是 `HeadlessChrome/…`（CDP /json/version 实录），
// 站点风控一眼可辨。而本探针的**决定性一步是人肉过闸**，所以有头是默认诉求——
// 但没有把它设成强制：无人值守希望先确认「选择器还找得到」时，无头也是有意义的读数。
const HEADED = process.env.PROBE_HEADED === '1';

const say = (...a) => console.log(...a);
const summary = { at: new Date().toISOString(), prompt: PROMPT, headed: HEADED, profile: PROFILE, steps: [] };
const note = (s) => { say(s); summary.steps.push(String(s)); };
const save = () => { try { fs.writeFileSync(path.join(RUN_DIR, 'summary.json'), JSON.stringify(summary, null, 2)); } catch { /* 目录没了 */ } };

if (!fs.existsSync(PROFILE)) {
  console.error('[zai-capture] 找不到 profile：' + PROFILE);
  console.error('  先准备一份**已登录 chat.z.ai** 的副本 profile，再用 PROBE_PROFILE 指过来。');
  console.error('  取法见 doc/runbooks/zai-capture-frames.md。');
  process.exit(1);
}
fs.mkdirSync(RUN_DIR, { recursive: true });

let browser = null;
try {
  const { chromium } = requirePkg('playwright-core');
  const { resolveBrowserExecutable } = await import(pathToFileURL(path.join(PKG, 'lib', 'browser-runtime.js')).href);
  const mod = (rel) => import(pathToFileURL(path.join(PKG, rel)).href);
  const { SITES } = await mod('lib/providers.js');
  const zai = SITES.find((s) => s.id === 'zai');

  browser = await chromium.launchPersistentContext(PROFILE, {
    executablePath: resolveBrowserExecutable().path,
    headless: !HEADED,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--hide-crash-restore-bubble'],
    viewport: { width: 1280, height: 900 },
  });
  const page = browser.pages()[0] || await browser.newPage();
  note(`[0] headless=${!HEADED}  UA=${await page.evaluate(() => navigator.userAgent)}`);
  const seen = [];
  page.on('request', (r) => { if (String(r.method()).toUpperCase() === 'POST' && /chat\.z\.ai/.test(r.url())) seen.push('REQ ' + r.url()); });
  page.on('response', (r) => { if (/chat\.z\.ai/.test(r.url())) seen.push(`RES ${r.status()} ${String(r.headers()['content-type'] || '')} ${r.url()}`); });

  note('[1] goto https://chat.z.ai/');
  await page.goto('https://chat.z.ai/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 7000));

  // ---- ② 找一个既有会话（SPA 内导航，不新建） ----
  const chats = await page.evaluate(() => [...document.querySelectorAll('a[href^="/c/"]')]
    .map((a) => ({ href: a.getAttribute('href'), text: (a.innerText || '').trim().slice(0, 60) })).slice(0, 10));
  note(`[2] 侧栏既有会话 ${chats.length} 条: ` + JSON.stringify(chats.slice(0, 5)));
  summary.sidebar = chats;

  let opened = null;
  for (const c of chats) {
    try {
      await page.click(`a[href="${c.href}"]`, { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 6000));
      const now = new URL(page.url());
      if (now.pathname.startsWith('/c/')) { opened = page.url(); break; }
    } catch (err) { note('   点击失败（继续下一个）: ' + String(err?.message || err).slice(0, 120)); }
  }
  note(`[2] 打开既有会话 → page.url() = ${opened || page.url()}`);

  // ---- ③ 装自己的 fetch tee（只 tee /api/chat/completions） ----
  const tee = await page.evaluate((pat) => {
    if (window.__probeTee) return 'exists';
    window.__probeChunks = [];
    window.__probeDone = false;
    window.__probeHits = [];
    const orig = window.fetch.bind(window);
    const re = new RegExp(pat);
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const resp = await orig(input, init);
      try {
        if (re.test(url) && resp.body) {
          window.__probeHits.push({ url, status: resp.status, ct: resp.headers.get('content-type') });
          const [forPage, forTee] = resp.body.tee();
          const reader = forTee.getReader();
          const dec = new TextDecoder('utf-8');
          (async () => {
            try { for (;;) { const { done, value } = await reader.read(); if (done) break; window.__probeChunks.push(dec.decode(value, { stream: true })); } } catch (e) { window.__probeErr = String(e && e.message || e); }
            window.__probeDone = true;
          })();
          return new Response(forPage, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
        }
      } catch (e) { window.__probeErr = String(e && e.message || e); }
      return resp;
    };
    window.__probeTee = true;
    return 'installed';
  }, '/api/chat/completions');
  note(`[3] fetch tee = ${tee}`);

  // ---- ④ 用 providers.js 声明的同一组选择器填字 + 点发送 ----
  const inputSel = zai.input;
  const sendSel = zai.sendButton;
  note(`[4] input=${inputSel}  sendButton=${sendSel}`);
  const input = page.locator(inputSel).first();
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  await input.fill(PROMPT);
  await new Promise((r) => setTimeout(r, 500));
  const typed = await input.inputValue().catch(() => '(读不到)');
  note(`[4] composer 回读 = ${JSON.stringify(String(typed).slice(0, 80))}`);
  await page.locator(sendSel).first().click({ timeout: 15_000 });
  note('[4] 已点发送');
  if (HEADED && WAIT_MS > 20_000) {
    note('[4] ⚠ 有头模式：若页面弹出滑块/人机验证，请在**这个窗口里**手动通过——帧会自动落盘。');
  }

  // ---- ⑤ 等流收尾（或超时） ----
  const t0 = Date.now();
  let lastLen = -1;
  while (Date.now() - t0 < WAIT_MS) {
    const st = await page.evaluate(() => ({ done: window.__probeDone === true, n: (window.__probeChunks || []).length, hits: (window.__probeHits || []).length })).catch(() => null);
    if (st && st.n !== lastLen) { lastLen = st.n; note(`   … tee 块=${st.n} 命中=${st.hits} done=${st.done}  (${Date.now() - t0}ms)`); }
    if (st && st.done && st.n > 0) break;
    if (st && st.hits > 0 && st.done) break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  const dump = await page.evaluate(() => ({
    hits: window.__probeHits || [],
    chunks: (window.__probeChunks || []).length,
    chars: (window.__probeChunks || []).join('').length,
    done: window.__probeDone === true,
    err: window.__probeErr || null,
    url: location.href,
  }));
  note(`[5] tee 结果: ${JSON.stringify({ ...dump, chunks: dump.chunks })}`);

  // 逐块取回（避免单次 evaluate 体积过大）
  const total = dump.chunks;
  const raw = [];
  for (let i = 0; i < total; i++) {
    const c = await page.evaluate((k) => window.__probeChunks[k], i);
    raw.push(c);
  }
  const stream = raw.join('');
  if (stream) fs.writeFileSync(path.join(RUN_DIR, 'raw-stream.log'), stream, 'utf8');
  note(`[5] 原始流 ${stream.length} 字符 → ${path.join(RUN_DIR, 'raw-stream.log')}`);

  // ---- 页面现场（正文 / 风控 / URL） ----
  const dom = await page.evaluate((sel) => {
    const nodes = [...document.querySelectorAll(sel)];
    const last = nodes.pop();
    const cap = [...document.querySelectorAll('[id*=aliyunCaptcha],[id*=captcha],[class*=aliyunCaptcha]')]
      .map((e) => ({ id: e.id || null, shown: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) }));
    const assist = document.querySelector('div.chat-assistant');
    return {
      url: location.href,
      answerSelectorNodes: nodes.length + (last ? 1 : 0),
      answerSelectorLastChars: last ? (last.innerText || '').length : null,
      answerSelectorLastHead: last ? (last.innerText || '').slice(0, 120) : null,
      chatAssistantChars: assist ? (assist.innerText || '').length : null,
      chatAssistantHead: assist ? (assist.innerText || '').slice(0, 400) : null,
      captcha: cap.filter((c) => c.shown),
    };
  }, zai.answerSelector);
  note('[6] 页面现场: ' + JSON.stringify(dom));
  await page.screenshot({ path: path.join(RUN_DIR, 'page.png'), fullPage: false }).catch((e) => note('截图失败: ' + String(e?.message || e)));

  // ---- ⑥ 用注册表里的解码器解这串真实字节 ----
  await mod('lib/decoder.js');
  const D = globalThis.WebCodeStreamDecoders || {};
  const runDecoder = (kind) => {
    const Cls = D[kind];
    if (!Cls) return { kind, error: 'no such decoder' };
    const deltas = []; const thinks = [];
    const d = new Cls({ onDelta: (t) => deltas.push(t), onThink: (t) => thinks.push(t), onImage: () => {} });
    for (const c of raw) d.push(c);
    const out = d.finish();
    return {
      kind, complete: out?.complete ?? null, partial: out?.partial ?? null, reason: out?.reason ?? null,
      textLen: String(out?.text || '').length, textHead: String(out?.text || '').slice(0, 200),
      thinkingLen: String(out?.thinking || '').length, conversationId: out?.conversationId ?? null,
      deltas: deltas.length, deltaChars: deltas.join('').length,
    };
  };
  const results = { 'openai-sse': runDecoder('openai-sse'), glm: runDecoder('glm') };
  note('[7] 解码器实产出: ' + JSON.stringify(results));

  // ---- 帧形状统计 ----
  const frames = [];
  const topKeys = new Map(); const typeStat = new Map();
  for (const frame of stream.split(/\r?\n\r?\n/)) {
    const dl = frame.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    if (!dl.length) continue;
    const data = dl.map((l) => l.slice(5).trimStart()).join('\n');
    if (data === '[DONE]') { frames.push('[DONE]'); continue; }
    let j; try { j = JSON.parse(data); } catch { continue; }
    frames.push(j);
    const k = Object.keys(j).sort().join(',');
    topKeys.set(k, (topKeys.get(k) || 0) + 1);
    for (const p of (Array.isArray(j.parts) ? j.parts : [])) {
      for (const c of (Array.isArray(p?.content) ? p.content : [])) {
        const t = String(c?.type || '(empty)');
        const rec = typeStat.get(t) || { n: 0, chars: 0 };
        rec.n += 1; rec.chars += String(c?.text || c?.think || c?.code || '').length;
        typeStat.set(t, rec);
      }
    }
    if (Array.isArray(j.choices)) {
      const d = j.choices?.[0]?.delta || j.choices?.[0]?.message || {};
      const t = typeof d.content === 'string' ? d.content : '';
      const rec = typeStat.get('choices[0].delta.content') || { n: 0, chars: 0 };
      rec.n += 1; rec.chars += t.length; typeStat.set('choices[0].delta.content', rec);
    }
  }
  note(`[8] 帧数=${frames.length}  顶层键分布=${JSON.stringify([...topKeys].sort((a, b) => b[1] - a[1]).slice(0, 8))}`);
  note(`[8] type 分布=${JSON.stringify([...typeStat].sort((a, b) => b[1].n - a[1].n))}`);
  note('[8] 前 5 帧逐字:');
  for (const f of frames.slice(0, 5)) note('   ' + JSON.stringify(f).slice(0, 900));
  note('[8] 末 3 帧逐字:');
  for (const f of frames.slice(-3)) note('   ' + JSON.stringify(f).slice(0, 900));

  summary.dump = dump; summary.dom = dom; summary.decoders = results;
  summary.frames = { count: frames.length, topKeys: [...topKeys].sort((a, b) => b[1] - a[1]).slice(0, 8), typeStat: [...typeStat].sort((a, b) => b[1].n - a[1].n) };
  summary.network = seen;
  summary.runDir = RUN_DIR;
  // 如实结论：帧为零**不是**脚本失败，最可能是风控闸（#29）挡在发送之前。
  summary.verdict = frames.length
    ? 'GOT_FRAMES：真机帧已落盘，按 doc/runbooks/zai-capture-frames.md §3 搬进夹具并写 decoder'
    : 'NO_FRAMES：没有 completion 帧。先看 summary.network 里有没有 /api/chat/completions —— 没有就是被风控闸（#29）挡在发送之前，需人工过闸后重跑';
  save();
  note('PROBE RESULT: ' + summary.verdict);
} catch (err) {
  note('PROBE FAIL: ' + String(err?.message || err));
  note(String(err?.stack || '').split('\n').slice(0, 6).join('\n'));
  summary.fail = String(err?.message || err); save();
  process.exitCode = 1;
} finally {
  try { await browser?.close?.(); } catch { /* 已关 */ }
}
