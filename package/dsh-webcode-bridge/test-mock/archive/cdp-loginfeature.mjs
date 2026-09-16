// cdp-loginfeature.mjs — 抓站点页面上的登录/未登录 DOM 特征,供 loginProbe 契约用。
// 用法: node cdp-loginfeature.mjs <profileDirSuffix(zai|glm|...)>
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const site = process.argv[2] || 'zai';
const base = process.env.DSH_HOME || path.join(process.env.HOME, '.dsh');
const profileDir = site === 'deepseek' ? path.join(base, 'webcode-edge-profile') : path.join(base, 'webcode-edge-profile', 'sites', site);
const port = String(fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]).trim();
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 8000 });
try {
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page = pages[pages.length - 1];
  console.log('PAGE:', page.url());
  const feat = await page.evaluate(() => {
    const txt = (el) => (el?.innerText || el?.textContent || '').trim().slice(0, 24);
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const loginish = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter(vis)
      .map(txt)
      .filter((t) => t && /登录|login|sign in|sign up|注册|register/i.test(t));
    const links = [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => /login|signin|auth/i.test(h || '')).slice(0, 6);
    const avatars = [...document.querySelectorAll('img[alt], [class*="avatar" i], [class*="user" i]')].filter(vis).slice(0, 4).map(el => ({ tag: el.tagName, cls: String(el.className).slice(0, 60), alt: el.getAttribute('alt') }));
    const tas = [...document.querySelectorAll('textarea')].map(t => ({ ph: (t.placeholder || '').slice(0, 30), vis: vis(t) }));
    return { url: location.href, loginish: [...new Set(loginish)].slice(0, 10), links, avatars, tas };
  });
  console.log(JSON.stringify(feat, null, 1));
} finally { await browser.close().catch(() => {}); }
