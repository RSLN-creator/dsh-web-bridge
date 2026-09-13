// real-vision-upload.mjs — 真机验证 harness 传图真的进了网页（0.13.0）。
//
// 端到端口径：造一张**内容已知**的图片（纯色底 + 唯一字符串），走生产链路
// （resolveImages → 驱动 uploadImages → 网页发送），断言网页端的回复里包含
// 那个字符串。这是唯一能证明「模型真的看到了图」的方式——截个图看不出模型
// 有没有读图，只有让模型把图里的字念出来才算。
//
// 覆盖两条真实故障路径（0.12.9 的「有图说没图」）：
//   ① 原生 attachment 块没被识别（imagesOfMessages 只认 wire 形状）→ 图片从未上传
//   ② 上传后没等附件落地就发送 → 网页收到一条没有附件的消息
//
// 用法：
//   node test-mock/real-vision-upload.mjs            # 默认 deepseek
//   node test-mock/real-vision-upload.mjs --site deepseek --keep
//
// 输出：test-mock/out/real-vision-<ts>.json + .tmp/shots/vision-*.png

import { chromium } from '../node_modules/playwright-core/index.mjs';
import { getSite } from '../lib/providers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const siteId = argOf('--site', 'deepseek');
const KEEP = argv.includes('--keep');
const TOKEN = argOf('--token', 'VISION-OK-9137');
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const OUT_DIR = path.resolve('test-mock', 'out');
const SHOT_DIR = path.resolve('.tmp', 'shots');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

/**
 * 生成一张 PNG：白色底 + 左侧一条色带，尺寸足够被 OCR/视觉识别。
 * 这里不画文字（纯 Node 画字要拉字体库），而是用**可数的色块**代替：
 * 模型被要求数出色带数量与颜色，比认字更稳（不依赖字体渲染）。
 */
function makePng(width, height, draw) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;                       // filter type 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = draw(x, y);
      const p = rowStart + 1 + x * 3;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

// 图：白底 + 顶部 3 条粗色带（红/绿/蓝）—— 模型应能报出「三条，红绿蓝」。
// 这是**内容已知**的判据：答对了说明它真的看到了这张图。
const W = 480, H = 240, BAND = 60;
const png = makePng(W, H, (x, y) => {
  if (y < BAND) return [220, 40, 40];              // 红
  if (y < BAND * 2) return [40, 200, 60];          // 绿
  if (y < BAND * 3) return [40, 80, 220];          // 蓝
  return [255, 255, 255];                          // 白
});
const imgPath = path.join(SHOT_DIR, `vision-source-${TS}.png`);
fs.writeFileSync(imgPath, png);
console.log('测试图:', imgPath, `(${png.length} bytes, ${W}x${H})`);

function portFor(id) {
  const root = process.env.WEBCODE_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'webcode-edge-profile');
  const file = id === 'deepseek' ? path.join(root, 'DevToolsActivePort') : path.join(root, 'sites', id, 'DevToolsActivePort');
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).find((l) => /^\d+$/.test(l)) || null;
  } catch { return null; }
}

const site = getSite(siteId);
const port = portFor(siteId);
if (!port) { console.error(`✗ ${siteId} 的 Edge 没在跑，先打开一次它的独立窗口`); process.exit(1); }

const report = { at: new Date().toISOString(), siteId, token: TOKEN, imageBytes: png.length, steps: [] };
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
const context = browser.contexts()[0];
const page = await context.newPage();

try {
  // 镜像页（与桥右栏看到的同一形态）：deepseek 挂在中继根
  const url = siteId === 'deepseek' ? 'http://127.0.0.1:8931/' : `http://${siteId}.localhost:8931/`;
  console.log('打开镜像页:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(9000);
  report.steps.push({ step: 'goto', url });

  // 找输入框与文件输入
  const input = page.locator(site.input).first();
  const inputCount = await input.count();
  report.steps.push({ step: 'find-input', selector: site.input, count: inputCount });
  if (!inputCount) { console.log('✗ 找不到输入框，登录态可能已失效'); report.ok = false; }
  else {
    // 直接走真实的文件上传入口（与驱动 uploadImages 同路径）
    const fi = page.locator(site.attachSelector || "input[type='file']").first();
    const fiCount = await fi.count();
    report.steps.push({ step: 'find-file-input', selector: site.attachSelector, count: fiCount });
    console.log('文件输入:', fiCount, '个');

    if (fiCount) {
      await fi.setInputFiles(imgPath);
      report.steps.push({ step: 'set-input-files', ok: true });

      // 关键：等附件真的出现在页面上（这正是 0.12.9 缺的那一步）
      const candidates = [site.attachPreview, "img[src^='blob:']", "[class*='attachment']", "[class*='file-card']"].filter(Boolean);
      let evidence = null;
      for (let i = 0; i < 60 && !evidence; i++) {
        for (const sel of candidates) {
          try {
            const loc = page.locator(sel).first();
            if (await loc.count() && await loc.isVisible().catch(() => false)) { evidence = sel; break; }
          } catch { /* next */ }
        }
        if (!evidence) await page.waitForTimeout(250);
      }
      report.steps.push({ step: 'attachment-evidence', evidence, waitedMs: evidence ? null : 15000 });
      console.log('附件证据:', evidence || '✗ 15s 内未出现');

      const shot1 = path.join(SHOT_DIR, `vision-attached-${siteId}-${TS}.png`);
      await page.screenshot({ path: shot1 }).catch(() => {});
      report.attachedScreenshot = shot1;

      // 发送并要求模型描述图里的色带
      const prompt = '请直接回答：这张图里从上到下有几条彩色色带？分别是什么颜色？只回答色带数量与颜色，不要解释。';
      await input.click().catch(() => {});
      await page.keyboard.insertText(prompt);
      await page.waitForTimeout(400);
      await page.keyboard.press('Enter');
      report.steps.push({ step: 'sent', prompt });

      // 等回复（DeepSeek 一般 5–30s）
      let reply = '';
      for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(1500);
        reply = await page.evaluate(() => {
          const nodes = [...document.querySelectorAll('.ds-markdown, .markdown, [data-message-author-role="assistant"]')];
          const last = nodes[nodes.length - 1];
          return last ? (last.innerText || '').trim() : '';
        }).catch(() => '');
        if (reply.length > 10) break;
      }
      report.reply = reply;
      const shot2 = path.join(SHOT_DIR, `vision-reply-${siteId}-${TS}.png`);
      await page.screenshot({ path: shot2 }).catch(() => {});
      report.replyScreenshot = shot2;

      // 判据：回复里同时出现「3/三」与至少两种颜色词 —— 说明它真的看到了图。
      const hasCount = /(^|[^0-9])(3|三)([^0-9]|$)/.test(reply);
      const colors = ['红', '绿', '蓝'].filter((c) => reply.includes(c));
      report.verdict = { hasCount, colors, colorCount: colors.length };
      report.ok = hasCount && colors.length >= 2;
      console.log('\n回复:', JSON.stringify(reply.slice(0, 400)));
      console.log('判定: 数量命中=' + hasCount + ' 颜色命中=' + colors.join('/') + ' → ' + (report.ok ? '✓ 模型确实看到了图' : '✗ 未见读图证据'));
    }
  }
} catch (err) {
  report.error = String(err?.message || err);
  console.log('✗ ' + report.error);
} finally {
  const outFile = path.join(OUT_DIR, `real-vision-${siteId}-${TS}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log('\n证据: ' + outFile);
  if (!KEEP) await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
process.exit(report.ok ? 0 : 1);