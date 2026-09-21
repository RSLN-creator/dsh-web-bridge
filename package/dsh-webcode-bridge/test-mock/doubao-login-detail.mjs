// doubao-login-detail.mjs — 查清 doubao 的登录判定为什么与用户真值相反（2026-09-21）。
//
// 已知：用户说 doubao **已登录**；探针判 NOT_LOGGED_IN，依据 probe-bad，即命中了
// providers.js DOUBAO.loginProbe.bad 里的 `button:has-text("登录")`。
// Playwright 的 has-text 是**子串匹配**——「退出登录」按钮同样含「登录」二字，
// 这正是最可疑的假阳性来源。本脚本把匹配到的元素**连文本**一起列出来，用证据定性。
import { chromium } from 'playwright-core';
import path from 'node:path';
import os from 'node:os';

const dir = path.join(os.homedir(), '.dsh', 'webcode-edge-profile', 'sites', 'doubao');
const ctx = await chromium.launchPersistentContext(dir, { channel: 'msedge', headless: true });
try {
  const page = await ctx.newPage();
  await page.goto('https://www.doubao.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  const info = await page.evaluate(() => {
    const out = { url: location.href, title: document.title, loginish: [], allTextHits: [] };
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], [role="menuitem"], span, div'));
    for (const n of nodes) {
      const t = (n.textContent || '').trim().replace(/\s+/g, ' ');
      if (!t || t.length > 16) continue;
      if (!t.includes('登录')) continue;
      const visible = !!(n.offsetParent);
      const sel = n.tagName.toLowerCase() + (n.getAttribute('class') ? '.' + String(n.getAttribute('class')).split(' ')[0] : '');
      out.allTextHits.push({ sel, text: t, visible });
      if (t.includes('退出')) out.loginish.push({ sel, text: t, visible, kind: 'LOGOUT-SUBSTRING' });
      else out.loginish.push({ sel, text: t, visible, kind: 'LOGIN-ENTRY' });
    }
    out.avatars = document.querySelectorAll('[class*="avatar"]').length;
    out.composers = document.querySelectorAll('div.tiptap.ProseMirror, div[contenteditable="true"], textarea').length;
    return out;
  });
  console.log(JSON.stringify(info, null, 2));
} finally {
  await ctx.close().catch(() => {});
}
