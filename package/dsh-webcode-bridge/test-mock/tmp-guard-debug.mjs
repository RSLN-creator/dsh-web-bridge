// 一次性诊断（不在交付物里）：点「工作区胶囊」→ 点浮层里的选项，并把守卫的
// window.__hwbPanelGuard 读数打出来。用于定位 0.19.64 的守卫为何不拉回。
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';

const url = process.argv[2];
const exe = resolveBrowserExecutable();
const browser = await chromium.launch({ executablePath: typeof exe === 'string' ? exe : exe.path, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', (m) => console.log('[console.' + m.type() + ']', m.text().slice(0, 260)));
page.on('pageerror', (e) => console.log('[pageerror]', String(e && e.message || e).slice(0, 300)));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.getByText('并发会话', { exact: true }).first().waitFor({ timeout: 45000 });
await page.getByText('并发会话', { exact: true }).first().click();
await page.locator('.hwb-concurrent-panel').first().waitFor({ timeout: 15000 });
if ((await page.locator('.hwb-concurrent-col').count()) === 0) {
  await page.locator('.hwb-concurrent-action').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.hwb-concurrent-col').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(2000);
}
console.log('dom@start:', JSON.stringify(await page.evaluate(() => ({ hasEntry: !!document.querySelector('[data-hwb-nav-entry]'), hasPanel: !!document.querySelector('.hwb-concurrent-panel'), guard: window.__hwbPanelGuard || null }))));

// 1) 点第一个工作区胶囊（面板内）
const crumb = await page.evaluate(() => {
  const el = document.querySelector('.hwb-concurrent-panel [class*="workspace"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: String(el.textContent || '').slice(0, 30) };
});
console.log('crumb:', JSON.stringify(crumb));
if (!crumb) { await browser.close(); process.exit(1); }
await page.mouse.click(crumb.x, crumb.y);
await page.waitForTimeout(600);
console.log('guard@after-crumb:', JSON.stringify(await page.evaluate(() => window.__hwbPanelGuard || null)));

// 2) 找浮层选项并点第一个
const opt = await page.evaluate(() => {
  const sel = '[role="option"],[role="menuitem"],[role="menuitemradio"],[class*="popover"] button,[class*="Popover"] button,[class*="dropdown"] button';
  const list = Array.from(document.querySelectorAll(sel)).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 8; });
  if (!list.length) return null;
  const el = list[0];
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: String(el.textContent || '').slice(0, 30), n: list.length };
});
console.log('option:', JSON.stringify(opt));
if (!opt) { await browser.close(); process.exit(1); }
await page.mouse.click(opt.x, opt.y);
await page.waitForTimeout(1800);
console.log('guard@after-option:', JSON.stringify(await page.evaluate(() => window.__hwbPanelGuard || null)));
console.log('panelAlive:', await page.locator('.hwb-concurrent-panel').count());
console.log('url:', await page.evaluate(() => location.href));
await page.screenshot({ path: 'test-mock/out/guard-debug.png' });
await browser.close();


