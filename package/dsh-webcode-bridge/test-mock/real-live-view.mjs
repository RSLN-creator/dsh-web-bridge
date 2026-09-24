#!/usr/bin/env node
// real-live-view.mjs — 工作区画面流（路线 B）的真机自证探针（0.20.0 P1）。
//
// 用 playwright 自带 Chromium（无头、一次性临时 profile、about:blank 级页面，
// **不碰任何登录站点**）验证整条管道端到端成立：
//   1. driver 形状的 live API（与 browser-driver.js 的 live 同一契约）+
//      lib/live.js hub 挂在临时 http server 的 upgrade 上；
//   2. Node WebSocket 客户端连入 → hello → pages → **真实损伤帧到达**；
//   3. 向页面真实坐标发一次点击（Input.dispatchMouseEvent）→ 页面内 onclick
//      改 document.title → listPages 读到新标题 ⇒ 输入回传端到端生效。
//
// 运行：node test-mock/real-live-view.mjs   （本机跑，不需要 DSH）

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';
import { createLiveHub } from '../lib/live.js';

const log = (...a) => console.log('[live-probe]', ...a);
const failures = [];
const check = (name, ok, detail = '') => {
  log((ok ? '✔' : '✖') + ' ' + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
};

// 与 browser-driver.js 的 driver.live 同一契约的最小实现（探针自持，不依赖 DSH）。
function makeLive(ctx, initialPage) {
  const ids = new WeakMap();
  let seq = 0;
  const idOf = (p) => { if (!ids.has(p)) ids.set(p, 'p' + (++seq)); return ids.get(p); };
  const resolve = (pageId) => pageId == null ? initialPage : (ctx.pages().find((p) => idOf(p) === pageId) || null);
  return {
    async listPages() {
      return await Promise.all(ctx.pages().map(async (p) => ({ id: idOf(p), title: await p.title().catch(() => ''), url: p.url(), active: p === initialPage })));
    },
    async openPage(url) { const p = await ctx.newPage(); if (url) await p.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {}); return this.listPages(); },
    async closePage(pageId) { const p = resolve(pageId); if (!p) return { ok: false }; if (p === initialPage) return { ok: false, reason: 'automation-page' }; await p.close().catch(() => {}); return { ok: true }; },
    async activatePage(pageId) { const p = resolve(pageId); if (p) await p.bringToFront().catch(() => {}); return { ok: !!p }; },
    async attach(pageId) {
      const p = resolve(pageId);
      if (!p) throw new Error('page not found');
      const cdp = await ctx.newCDPSession(p);
      return { pageId: idOf(p), send: (c, pa) => cdp.send(c, pa), on: (e, cb) => cdp.on(e, cb), off: (e, cb) => cdp.off(e, cb), detach: async () => { try { await cdp.detach(); } catch {} } };
    },
    onPagesChanged(cb) { ctx.on('page', cb); ctx.on('close', cb); return () => { try { ctx.off('page', cb); ctx.off('close', cb); } catch {} }; },
  };
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'hwb-live-probe-'));
const { path: exe } = resolveBrowserExecutable();
if (!exe) { console.error('no bundled chromium found'); process.exit(1); }
log('chromium:', exe);

let exitCode = 0;
try {
  const ctx = await chromium.launchPersistentContext(profile, { headless: true, executablePath: exe, args: ['--no-first-run'] });
  const page = await ctx.newPage();
  // 带一个可点击按钮的本地页面：点击 → title 变化 ⇒ 输入回传可被页面事实证实。
  await page.setContent('<body style="margin:0"><button id="go" style="width:300px;height:200px;font-size:40px" onclick="document.title=\'CLICKED-42\'">go</button></body>');

  const live = makeLive(ctx, page);
  const hub = createLiveHub({ getDriver: () => ({ live }), warn: (...a) => log('warn:', ...a) });
  const server = http.createServer(() => {});
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  const port = server.address().port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/webcode/live?account=deepseek`);
  const frames = [];
  let pagesSnap = null;
  const otherMsgs = [];
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'frame') frames.push(m);
    else if (m.t === 'pages') pagesSnap = m;
    else otherMsgs.push(m);
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
  await new Promise((r) => setTimeout(r, 1200));   // 等 hello/pages/首帧

  check('hello+pages 到达', Array.isArray(pagesSnap?.pages) && pagesSnap.pages.length >= 1, JSON.stringify(pagesSnap?.pages?.map((p) => p.title)));
  check('真实损伤帧到达', frames.length >= 1, frames.length + ' 帧');
  const meta = frames[frames.length - 1]?.m;
  check('帧带视口元数据', !!(meta && meta.deviceWidth > 0 && meta.deviceHeight > 0), JSON.stringify({ w: meta?.deviceWidth, h: meta?.deviceHeight }));

  // 坐标换算（与 LivePane 同一公式）：帧内按钮中心 → 页面 CSS 坐标 → 点击。
  const box = await page.locator('#go').boundingBox();
  const imgScale = 1;   // 无头视口 1280x720 < 上限 1680x1050，帧不被缩小
  const px = (box.x + box.width / 2) * imgScale;
  const py = (box.y + box.height / 2) * imgScale;
  const sendJson = (o) => ws.send(JSON.stringify(o));
  sendJson({ t: 'mouse', action: 'moved', x: px, y: py, button: 'none', buttons: 0 });
  sendJson({ t: 'mouse', action: 'pressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 });
  sendJson({ t: 'mouse', action: 'released', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 600));
  const groundTruth = await page.title();   // playwright 直读：点击到底有没有生效
  await ws.send(JSON.stringify({ t: 'pages' }));
  await new Promise((r) => setTimeout(r, 400));
  // ctx 里还有启动自带的 about:blank 页（listPages 全量返回），按 title 找目标页。
  const clicked = Array.isArray(pagesSnap?.pages) && pagesSnap.pages.some((p) => p.title === 'CLICKED-42');
  check('点击输入端到端生效（title=CLICKED-42）', clicked, 'pages=' + JSON.stringify(pagesSnap?.pages?.map((p) => p.title))
    + ' / playwright直读=' + JSON.stringify(groundTruth) + ' / 其他消息=' + JSON.stringify(otherMsgs));

  ws.close();
  await new Promise((r) => setTimeout(r, 200));
  await ctx.close().catch(() => {});
  await new Promise((res) => server.close(res));
  hub.close();
} catch (err) {
  failures.push('unexpected: ' + (err?.message || err));
  log('unexpected error:', err);
} finally {
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
if (failures.length) { log('FAIL (' + failures.length + '): ' + failures.join(' | ')); process.exit(1); }
log('ALL PASS');
