// probe-composer.mjs — 真机探查各站点 composer 的思考/联网开关与输入框形态。
// 输出每个已登录站点：输入框选择器命中、按钮/标签文本清单（供契约校准）。
import { createBrowserDriver } from '../lib/browser-driver.js';

const site = process.argv[2];
const cfgs = {
  glm: 'https://chatglm.cn/',
  zai: 'https://chat.z.ai/',
  qwen: 'https://chat.qwen.ai/',
  kimi: 'https://www.kimi.com/',
};
const driver = createBrowserDriver({
  site: cfgs[site] || cfgs.glm,
  siteId: site,
  profileDir: process.env.HOME + '/.dsh/webcode-edge-profile/sites/' + site,
  headless: true,
  requestTimeoutMs: 240_000,
  logger: console,
});
try {
  await driver.connect();
  const page = driver.page;
  await page.waitForTimeout(3000);
  const dump = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const out = { inputs: [], toggles: [], buttons: [] };
    for (const el of document.querySelectorAll('textarea, [contenteditable="true"]')) {
      if (vis(el)) out.inputs.push({ tag: el.tagName, id: el.id, ph: el.getAttribute('placeholder'), cls: String(el.className).slice(0, 80) });
    }
    // composer 附近（输入框向上 6 层）的按钮/开关文本
    const input = document.querySelector('textarea, [contenteditable="true"]');
    let scope = input;
    for (let i = 0; i < 6 && scope.parentElement; i++) scope = scope.parentElement;
    for (const el of scope.querySelectorAll('button, [role="switch"], [role="button"], [aria-pressed], [class*="toggle"], [class*="switch"], [class*="think"], [class*="search"], [class*="deep"]')) {
      if (!vis(el)) continue;
      const t = (el.textContent || '').trim().slice(0, 24);
      out.toggles.push({
        tag: el.tagName, type: el.getAttribute('role') || '', pressed: el.getAttribute('aria-pressed'),
        text: t, cls: String(el.className).slice(0, 90), id: el.id || '',
      });
    }
    return out;
  });
  console.log(JSON.stringify(dump, null, 1).slice(0, 4000));
} finally { await driver.close().catch(() => {}); }
