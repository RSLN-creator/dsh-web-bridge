// doubao-frames-probe.mjs — 判断 doubao 的验证码是否在**子框架**里（只读，零发送）。
//
// ## 为什么这一步是决定性的
//
// 0.19.83 的 #63 修复在超时点用 `page.evaluate(...)` 查页面文案 —— 而 Playwright 的
// `page.evaluate` **只跑在主框架**。图片选择式验证（滑块/点选/拖拽）在业界**普遍渲染在
// 独立 iframe 里**（风控脚本要隔离自己的 CSS/JS），那样主框架 `document.body.innerText`
// **一个字都看不到** ⇒ 词表再全也抓不到。
//
// 这正好能解释真机读数：修完重跑 doubao，仍是 `web turn timed out`（**不是**验证归因）。
//
// 本探针**只读**：列出页面的全部 frame（含跨域）、每个 frame 的 URL 与主框架可见文案，
// 不做任何写入或发送。
import { createBrowserDriver } from '../lib/browser-driver.js';
import { getSite } from '../lib/providers.js';
import { slotProfileDir, DEFAULT_SLOT } from '../lib/accounts.js';
import path from 'node:path';
import os from 'node:os';

const site = getSite('doubao');
const ROOT = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, '.dsh', 'webcode-edge-profile')
  : path.join(os.homedir(), '.dsh', 'webcode-edge-profile');
const profileDir = slotProfileDir(ROOT, 'doubao', DEFAULT_SLOT, { primary: site.mountAtRelayRoot === true });

const driver = createBrowserDriver({
  siteId: 'doubao', site: site.origin + '/', profileDir, headless: false,
  requestTimeoutMs: 30_000,
  logger: { log() {}, warn(...a) { console.log('[warn]', ...a); }, error(...a) { console.log('[err]', ...a); } },
});

try {
  await driver.connect();
  const page = driver.page;
  console.log('url =', page.url());

  const frames = page.frames();
  console.log(`\n=== ${frames.length} 个 frame ===`);
  for (const [i, f] of frames.entries()) {
    console.log(`${i}. url=${f.url()}`);
    console.log(`   name=${JSON.stringify(f.name())}`);
    // 逐 frame 取可见文案（**跨域 frame 取不到 #document，这正是要看的**）
    const info = await f.evaluate(() => ({
      ok: true,
      bodyLen: String(document.body?.innerText || '').length,
      head: String(document.body?.innerText || '').slice(0, 220),
      hasCaptchaKeywords: ['验证', '请选择', '拖拽', '图片', '滑块', '拖动', '人机', '安全'].filter((k) => (document.body?.innerText || '').includes(k)),
    })).catch((e) => ({ ok: false, err: String(e?.message || e).slice(0, 160) }));
    console.log(`   eval=${JSON.stringify(info)}`);
  }

  // 主框架里所有 iframe 元素的属性（看有没有风控域）
  const iframeAttrs = await page.evaluate(() =>
    [...document.querySelectorAll('iframe, frame')].map((el) => ({
      src: String(el.getAttribute('src') || '').slice(0, 200),
      id: el.id || null,
      cls: String(el.className || '').slice(0, 100),
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height),
    }))).catch((e) => ({ err: String(e?.message || e).slice(0, 160) }));
  console.log('\n=== 主框架内的 iframe 元素 ===');
  console.log(JSON.stringify(iframeAttrs, null, 2));
} catch (e) {
  console.log('ERR:', `${e?.code || ''} ${String(e?.message || e).slice(0, 200)}`);
} finally {
  await driver.close?.().catch(() => {});
}
console.log('DONE（本探针零发送：未写入输入框、未点击）');
