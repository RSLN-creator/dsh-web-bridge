// probe-zai-send.mjs — zai 点击发送按钮 → 抓点击前后状态与全部 api 请求（取证用）
import { createBrowserDriver } from '../lib/browser-driver.js';
import path from 'node:path';

const profileDir = path.join(process.env.USERPROFILE, '.dsh', 'webcode-edge-profile', 'sites', 'zai');
const driver = createBrowserDriver({
  site: 'https://chat.z.ai/', siteId: 'zai',
  profileDir, headless: true, requestTimeoutMs: 240_000, logger: console,
});
try {
  await driver.connect();
  const page = driver.page;
  await page.waitForTimeout(2500);
  const reqs = [];
  page.on('websocket', (ws) => {
    console.log('WS OPEN ' + ws.url().slice(0, 120));
    ws.on('framereceived', (f) => { const p = String(f.payload || '').slice(0, 300); if (p.length > 2) console.log('WS<< ' + p.replace(/s+/g, ' ')); });
    ws.on('close', () => console.log('WS CLOSE'));
  });
  page.on('request', (r) => {
    const u = r.url();
    if (/\/api\//i.test(u)) reqs.push(r.method() + ' ' + u.slice(0, 130));
  });
  const bodies = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (!/completions|stream/i.test(u)) return;
    let b = '';
    try { b = (await r.text()).slice(0, 800).replace(/\s+/g, ' '); } catch { b = '(unreadable)'; }
    bodies.push(r.status() + ' ' + u.slice(0, 110) + ' :: ' + b);
  });
  await page.evaluate(() => {
    const el = document.querySelector('#chat-input');
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, '1+1等于几？');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => {
    const btn = document.querySelector('#send-message-button');
    const ta = document.querySelector('#chat-input');
    return { btnDisabled: btn?.disabled, taLen: ta?.value?.length, cls: String(btn?.className).slice(0, 60) };
  });
  console.log('BEFORE CLICK:', JSON.stringify(before));
  await page.locator('#send-message-button').click({ timeout: 8000 }).catch((e) => console.log('click err:', e.message.slice(0, 60)));
  await page.waitForTimeout(35000);
  const after = await page.evaluate(() => ({
    taLen: document.querySelector('#chat-input')?.value?.length,
    bubbles: [...document.querySelectorAll('[class*=message], [class*=bubble], [class*=chat-item]')].length,
    url: location.href.slice(0, 90),
  }));
  console.log('AFTER:', JSON.stringify(after));
  const text = await page.evaluate(() => document.body.innerText.replace(/s+/g, ' ').slice(-500));
  console.log('PAGE TEXT TAIL:', text);
  for (const r of reqs.slice(0, 10)) console.log('REQ ' + r);
  for (const b of bodies.slice(0, 3)) console.log('RESP ' + b);
  if (!bodies.length) console.log('RESP (none captured)');
} finally { await driver.close().catch(() => {}); }
