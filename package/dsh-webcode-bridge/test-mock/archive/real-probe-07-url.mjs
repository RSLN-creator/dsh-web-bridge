// real-probe-07-url.mjs — 逐 profile 打开 chat.deepseek.com，dump 真实登录状态
// 区分：token 失效（跳到 /sign_in） vs 选择器变更（已登录但 input 选择器找不到）
import { chromium } from 'playwright-core';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profiles = [
  'd:\\9_Code_Workspace\\dsh-webcode-bridge\\.edge-real-profile',
  'd:\\9_Code_Workspace\\dsh-webcode-bridge\\.edge-real-profile2',
  'd:\\9_Code_Workspace\\dsh-webcode-bridge\\package\\dsh-webcode-bridge\\test-mock\\.edge-profile-run',
];
for (const p of profiles) {
  let ctx = null;
  try {
    ctx = await chromium.launchPersistentContext(p, {
      executablePath: edge, headless: true,
      args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
      viewport: { width: 640, height: 900 },
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    const url = page.url();
    const info = await page.evaluate(() => {
      const q = s => document.querySelectorAll(s).length;
      const tok = localStorage.getItem('userToken');
      return {
        path: location.pathname,
        textareas: q('textarea'),
        dsArea: q('.ds-scroll-area'),
        inputCount: q('textarea[placeholder]'),
        signInText: !!document.body.innerText.match(/登录|sign in|sign_in/i),
        hasToken: !!tok,
        tokenHead: tok ? tok.slice(0, 6) : null,
        title: document.title,
      };
    });
    console.log('PROFILE', p);
    console.log('  url=', url);
    console.log('  info=', JSON.stringify(info));
  } catch (e) {
    console.log('PROFILE', p, 'ERROR', e.message);
  } finally {
    try { await ctx?.close(); } catch {}
  }
}