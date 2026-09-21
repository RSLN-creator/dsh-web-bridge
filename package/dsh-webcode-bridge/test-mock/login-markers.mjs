// login-markers.mjs — 只读 DOM 取证：某一站点在**指定 profile** 下，登录相关标记各是什么（2026-09-21）。
//
// ## 为什么需要它（与 login-probe.mjs 的分工）
//
// `login-probe.mjs` 回读的是 judgeLoggedIn 的**结论**（LOGGED_IN / NOT_LOGGED_IN +
// basis）。当 basis 落在 `probe-fallback`（bad/ok 双缺、回退成「有可见输入框=已登录」）时，
// 结论本身是**语义歧义**的——它与「站点改版」「特征选择器写错」「页面没加载完」三种
// 情况都自洽，光看结论分不出是哪种。本脚本把那一刻的 DOM **原始读数**取回来：
// 每个候选特征的选择器计数与可见性、composer 计数、页面标题与地址。
//
// 纪律：只读（不点、不输入、不导航到别的页）；不打印 cookie/存储内容；每个选择器
// 的 try/catch 独立，坏一个不影响其余读数。
//
// 用法：
//   REAL_PROFILE=D:\...\sites\kimi node test-mock/login-markers.mjs --site kimi
import { chromium } from 'playwright-core';
import path from 'node:path';

const SITES = {
  glm: { origin: 'https://chatglm.cn/', input: 'textarea, div[contenteditable="true"]' },
  qwen: { origin: 'https://chat.qwen.ai/', input: 'textarea, div[contenteditable="true"]' },
  doubao: { origin: 'https://www.doubao.com/', input: 'textarea, div[contenteditable="true"]' },
  kimi: { origin: 'https://www.kimi.com/', input: 'div.chat-input-editor, div[contenteditable="true"], textarea' },
  zai: { origin: 'https://chat.z.ai/', input: 'textarea, div[contenteditable="true"]' },
};
const GENERIC = [
  'button:has-text("登录")', 'a:has-text("登录")', 'button:has-text("Sign in")', 'a:has-text("Sign in")',
  'button:has-text("注册")', 'a:has-text("注册")',
  '[class*="avatar"]', 'img[class*="avatar"]', '[class*="user-info"]', '[class*="userInfo"]',
];

const siteArg = process.argv.includes('--site') ? process.argv[process.argv.indexOf('--site') + 1] : null;
const siteId = siteArg || 'kimi';
const site = SITES[siteId];
if (!site) { console.error('未知站点：' + siteId); process.exit(2); }
const profileDir = process.env.REAL_PROFILE ? path.resolve(process.env.REAL_PROFILE) : null;
if (!profileDir) { console.error('必须给 REAL_PROFILE=<该站点的 profile 目录>'); process.exit(2); }

const ctx = await chromium.launchPersistentContext(profileDir, { channel: 'msedge', headless: true });
try {
  const page = await ctx.newPage();
  await page.goto(site.origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4_000);   // 与 judgeLoggedIn 的 2s 水合重探同一量级，只多不少
  const out = { siteId, url: page.url(), title: await page.title(), markers: [], composer: null };
  const probe = async (sel) => {
    try {
      const loc = page.locator(sel);
      const count = await loc.count();
      const firstVisible = count ? await loc.first().isVisible().catch(() => false) : false;
      return { sel, count, firstVisible };
    } catch (e) { return { sel, error: String(e?.message || e).slice(0, 60) }; }
  };
  for (const s of [...GENERIC, site.input]) out.markers.push(await probe(s));
  out.markers.push(await probe(site.input));
  out.composer = await probe(site.input);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await ctx.close().catch(() => {});
}
