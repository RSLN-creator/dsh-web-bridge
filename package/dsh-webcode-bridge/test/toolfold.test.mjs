import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { createMirror } from '../lib/mirror.js';
import { TOOL_FOLD_HTML } from '../lib/toolfold.js';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const hasEdge = fs.existsSync(EDGE);

test('toolfold：注入串自带标记与关键选择器，且不含未转义的反引号', () => {
  assert.match(TOOL_FOLD_HTML, /data-webcode-toolfold/);
  assert.match(TOOL_FOLD_HTML, /__webcodeToolFold/);
  assert.match(TOOL_FOLD_HTML, /hwb-tf-head/);
  // 注入进 <script> 后不能再出现裸反引号，否则会提前闭合外层模板字符串
  assert.ok(!TOOL_FOLD_HTML.includes(String.fromCharCode(96)), '注入串不应含反引号');
});

test('toolfold：工具调用/结果折叠为一行，普通代码块不受影响', { skip: !hasEdge && 'Edge not available' }, async (t) => {
  // 站点返回四种块：调用、结果(success)、结果(error)、普通代码。
  // 前三种应被折叠（<pre> 隐藏 + 生成一行摘要），第四种必须原样保留。
  const FENCE = String.fromCharCode(96).repeat(3);
  const upstream = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head></head><body>' +
        '<pre>{"mcp_action": "call", "name": "pwsh", "arguments": {"command": "Get-ChildItem"}}</pre>' +
        '<pre>{"mcp_action": "result", "name": "pwsh", "status": "success", "output": "ok"}</pre>' +
        '<pre>{"mcp_action": "result", "name": "read", "status": "error", "output": "no"}</pre>' +
        '<pre>const keep = 1;</pre>' +
        '</body></html>');
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const mirror = createMirror({
    siteOrigin: 'http://127.0.0.1:' + upstream.address().port,
    getToken: async () => null,
    logger: { log() {}, warn() {} },
  });
  const relay = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    mirror.handle(req, res, u.pathname, u.search)
      .then((ok) => { if (!ok) { res.writeHead(404); res.end(); } })
      .catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  t.after(() => { upstream.close(); relay.close(); });

  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto('http://127.0.0.1:' + relay.address().port + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  assert.equal(await page.locator('.hwb-tf-head').count(), 3, '三个工具块应各有一行摘要');
  const names = await page.locator('.hwb-tf-name').allInnerTexts();
  assert.ok(names[0].includes('pwsh') && names[1].includes('pwsh'), '调用/结果摘要应带工具名');
  const tags = await page.locator('.hwb-tf-tag').allInnerTexts();
  assert.deepEqual(tags, ['success', 'error'], '结果状态应显示为标签');

  const disp = await page.evaluate(() => [...document.querySelectorAll('pre')].map((e) => e.style.display));
  assert.deepEqual(disp, ['none', 'none', 'none', ''], '普通代码块不得被折叠');

  // 点击展开：对应 pre 恢复显示
  await page.locator('.hwb-tf-head').first().click();
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => [...document.querySelectorAll('pre')].map((e) => e.style.display));
  assert.equal(after[0], '', '点击后首个块应展开');
  assert.equal(after[1], 'none', '未点击的块保持折叠');
});
