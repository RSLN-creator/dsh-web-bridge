// cdp-diag.mjs — 只读诊断当前 deepseek 会话页：
// ① 有没有「空白/未加载」的图片节点（naturalWidth=0、src 失效、blob 已回收、alt 缺失）
// ② 页面里附件节点的形态（webcode-context.md 挂上了没有）
// ③ 页面报错线索（空白图片常伴随 SPA 的 blob URL 被 revoke）
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const port = fs.readFileSync(path.join(os.homedir(), '.dsh', 'webcode-edge-profile', 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 8000 });
const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => p.url().includes('deepseek.com'));
console.log('[diag] deepseek pages=' + pages.length + ' urls=' + JSON.stringify(pages.map((p) => p.url())));
const page = pages[0];
const out = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll('img')].map((i) => ({
    src: (i.src || '').slice(0, 70),
    nw: i.naturalWidth, nh: i.naturalHeight,
    cw: i.clientWidth, ch: i.clientHeight,
    alt: i.alt || '', cls: (i.className || '').toString().slice(0, 50),
    complete: i.complete,
  }));
  const broken = imgs.filter((i) => i.nw === 0 || i.nh === 0);
  const blob = imgs.filter((i) => i.src.startsWith('blob:'));
  // 附件/文件节点（含文件名文本）
  const texts = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /webcode-context|\.md\b/.test(e.textContent || '')).map((e) => (e.textContent || '').trim().slice(0, 60)).slice(0, 8);
  return {
    url: location.href,
    imgTotal: imgs.length,
    brokenCount: broken.length,
    blobCount: blob.length,
    blobNatural: blob.map((i) => i.nw + 'x' + i.nh),
    brokenSample: broken.slice(0, 6),
    fileTexts: texts,
    bodyLen: document.body.innerText.length,
    bodyHead: document.body.innerText.slice(0, 300).replace(/\n+/g, ' | '),
    bodyTail: document.body.innerText.slice(-300).replace(/\n+/g, ' | '),
  };
});
console.log(JSON.stringify(out, null, 2).slice(0, 4000));
await browser.close();
