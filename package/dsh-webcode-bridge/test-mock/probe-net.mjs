// probe-net.mjs — 真机探查站点：composer 开关清单 + 发一句话后的真实网络请求
// （URL/方法/响应体开头）。用于校准 completionPaths、think/search toggle 与解码器。
//   node test-mock/probe-net.mjs <siteId>
import { createBrowserDriver } from '../lib/browser-driver.js';

const site = process.argv[2] || 'glm';
const origins = {
  glm: 'https://chatglm.cn/',
  zai: 'https://chat.z.ai/',
  qwen: 'https://chat.qwen.ai/',
  kimi: 'https://www.kimi.com/',
};
const driver = createBrowserDriver({
  site: origins[site] || origins.glm,
  siteId: site,
  profileDir: process.env.HOME + '/.dsh/webcode-edge-profile/sites/' + site,
  headless: true,
  requestTimeoutMs: 240_000,
  logger: console,
});
const seen = [];
try {
  await driver.connect();
  const page = driver.page;
  await page.waitForTimeout(3000);

  const dump = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const out = { inputs: [], toggles: [] };
    for (const el of document.querySelectorAll('textarea, [contenteditable="true"]')) {
      if (vis(el)) out.inputs.push({ tag: el.tagName, id: el.id, ph: el.getAttribute('placeholder'), cls: String(el.className).slice(0, 70) });
    }
    const input = document.querySelector('textarea, [contenteditable="true"]');
    let scope = input;
    for (let i = 0; i < 6 && scope.parentElement; i++) scope = scope.parentElement;
    for (const el of scope.querySelectorAll('button, [role="switch"], [role="button"], [aria-pressed], [class*="think"], [class*="search"], [class*="deep"], [class*="reason"]')) {
      if (!vis(el)) continue;
      out.toggles.push({
        tag: el.tagName, role: el.getAttribute('role') || '', pressed: el.getAttribute('aria-pressed'),
        text: (el.textContent || '').trim().slice(0, 20), cls: String(el.className).slice(0, 90), id: el.id || '',
      });
    }
    return out;
  });
  console.log('COMPOSER ' + JSON.stringify(dump, null, 1).slice(0, 2600));

  // 发一句话并监听网络
  page.on('request', (r) => {
    const u = r.url();
    if (/\.(png|jpg|svg|woff2?|css|js)(\?|$)/.test(u)) return;
    seen.push({ kind: 'req', method: r.method(), url: u.slice(0, 160) });
  });
  page.on('response', async (r) => {
    const u = r.url();
    if (!/json|stream|event-stream|text\/plain/i.test(String(r.headers()['content-type'] || ''))) return;
    let body = '';
    try { body = (await r.text()).slice(0, 700); } catch { body = '(body unreadable)'; }
    seen.push({ kind: 'resp', status: r.status(), url: u.slice(0, 160), body: body.replace(/\s+/g, ' ') });
  });
  const sent = await page.evaluate(() => {
    const el = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
    if (!el) return 'NO-INPUT';
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, '1+1等于几？只回答数字');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.textContent = '1+1等于几？只回答数字';
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return 'TYPED';
  });
  console.log('TYPE:', sent);
  if (sent === 'TYPED') {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(20000);
  }
  for (const s of seen) console.log('NET ' + JSON.stringify(s));
} finally { await driver.close().catch(() => {}); }
