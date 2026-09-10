// real-probe-20-newui-facts.mjs — 新版 DeepSeek 网页 UI 事实侦察（2026-09-10）。
//
// 背景：probe-19（只读 DOM + 一次纯文本发送）确认新版 UI 输入框附近只剩
// 「深度思考 / 智能搜索」两个 aria-pressed 开关，没有模型 pill；POST
// /api/v0/chat/completion 的 model_type 恒为 default，模式差异只在
// thinking_enabled。本探针补齐驱动契约需要、probe-19 没回答的四件事：
//
//   1) 带图发送时 model_type 是否仍会变成 vision（识图路径是否还有独立 model_type）
//   2) 空闲/生成中按钮的 svg path d 前缀（sendButton / stopButton 契约是否还成立）
//   3) 发送后 URL 形态（/a/chat/s/<id> 会话游标是否还取得到）
//   4) attach 入口是否仍是 input[type=file]（uploadImages 是否可用）
//
// 用法: node test-mock/real-probe-20-newui-facts.mjs [--profile <dir>] [--headed]

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = argOf('--profile', 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\.edge-real-profile');
const HEADED = argv.includes('--headed');
const IMG = path.join(PKG, 'test-mock', 'vision-test-hello.jpg');
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((c) => fs.existsSync(c));
if (!EDGE) { console.error('system Edge not found'); process.exit(2); }

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: EDGE,
  headless: !HEADED,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
let exitCode = 0;

const posts = [];
page.on('request', (req) => {
  if (req.method() !== 'POST' || !req.url().includes('/api/v0/chat/completion')) return;
  let body = null;
  try { body = req.postDataJSON(); } catch { body = req.postData(); }
  posts.push(body);
});

/** 可点元素 + svg path 前缀（stop/send 契约靠 path d 匹配，改版必看这里）。 */
const BUTTONS = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll('button, [role="button"]')].filter(vis).map((el) => {
    const paths = [...el.querySelectorAll('path')].map((p) => String(p.getAttribute('d') || '').slice(0, 24));
    return {
      text: (el.textContent || '').trim().slice(0, 20),
      aria: el.getAttribute('aria-label'),
      cls: String(el.className || '').slice(0, 48),
      disabled: el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true',
      paths,
    };
  }).filter((b) => b.paths.length || b.text || b.aria);
};

try {
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForSelector('textarea', { timeout: 25_000 });
  await page.waitForTimeout(1200);

  const env = await page.evaluate(() => {
    const ta = [...document.querySelectorAll('textarea')].find(e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 0; });
    const press = (label) => {
      const el = [...document.querySelectorAll('[aria-pressed], button, [role="button"]')]
        .find(e => (e.textContent || '').trim() === label && e.getAttribute('aria-pressed') !== null);
      return el ? el.getAttribute('aria-pressed') : null;
    };
    return {
      url: location.href,
      fileInputs: document.querySelectorAll("input[type='file']").length,
      fileInputAccept: document.querySelector("input[type='file']")?.getAttribute('accept') || null,
      fileInputMultiple: document.querySelector("input[type='file']")?.hasAttribute('multiple') ?? null,
      thinkPressed: press('深度思考'),
      searchPressed: press('智能搜索'),
      textareaDisabled: ta ? ta.disabled : null,
      hasModelPill: /快速模式|专家模式|识图模式/.test(document.body.innerText),
    };
  });
  console.log('=== ENV ===');
  console.log(JSON.stringify(env, null, 1));
  console.log('=== BUTTONS (idle) ===');
  console.log(JSON.stringify(await page.evaluate(BUTTONS), null, 1));

  // --- 带图发送：识图路径是否还有独立 model_type ---
  const ta = page.locator('textarea').first();
  if (fs.existsSync(IMG) && env.fileInputs > 0) {
    await page.locator("input[type='file']").first().setInputFiles(IMG);
    await page.waitForTimeout(2500);
    console.log('=== AFTER ATTACH ===');
    console.log(JSON.stringify(await page.evaluate(() => ({
      url: location.href,
      textareaDisabled: [...document.querySelectorAll('textarea')].find(e => e.getBoundingClientRect().width > 40)?.disabled ?? null,
      bodyMentionsImage: /图片|图像|识图|vision|Vision/.test(document.body.innerText),
    })), null, 1));
  } else {
    console.log('NOTE: 无测试图或页面没有 file input — 跳过带图发送');
  }
  await ta.click();
  await ta.fill('这张图里是什么内容？只回答图中的文字，不要解释。');
  await ta.press('Enter');

  // 生成中：抓按钮（找 stop 按钮的真实 path）+ 输入框状态
  await page.waitForTimeout(1500);
  console.log('=== BUTTONS (generating) ===');
  console.log(JSON.stringify(await page.evaluate(BUTTONS), null, 1));
  // 生成中：composer 作用域内的按钮（stop 按钮契约要看这里）
  console.log('=== COMPOSER BUTTONS (generating) ===');
  console.log(JSON.stringify(await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const ta = [...document.querySelectorAll('textarea')].find(vis);
    if (!ta) return null;
    let box = ta;
    for (let i = 0; i < 3 && box.parentElement; i++) box = box.parentElement;
    return [...box.querySelectorAll('button, [role="button"], [aria-pressed]')].filter(vis).map((el) => ({
      text: (el.textContent || '').trim().slice(0, 20),
      aria: el.getAttribute('aria-label'),
      pressed: el.getAttribute('aria-pressed'),
      cls: String(el.className || '').slice(0, 56),
      paths: [...el.querySelectorAll('path')].map((p) => String(p.getAttribute('d') || '').slice(0, 30)),
    }));
  }), null, 1));
  console.log('=== TURNING ===');
  console.log(JSON.stringify(await page.evaluate(() => ({
    url: location.href,
    textareaDisabled: [...document.querySelectorAll('textarea')].find(e => e.getBoundingClientRect().width > 40)?.disabled ?? null,
  })), null, 1));

  await page.waitForTimeout(25_000);
  console.log('=== POST BODIES ===');
  console.log(JSON.stringify(posts, null, 1));
  console.log('=== FINAL ===');
  const final = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[class*="markdown" i], .ds-markdown')];
    return {
      url: location.href,
      reply: nodes.map((n) => (n.textContent || '').trim()).filter(Boolean).slice(-2),
      thinkPressed: [...document.querySelectorAll('[aria-pressed]')].find(e => (e.textContent || '').trim() === '深度思考')?.getAttribute('aria-pressed') ?? null,
    };
  });
  console.log(JSON.stringify(final, null, 1));
  const vis = (posts.find((b) => b && b.ref_file_ids && b.ref_file_ids.length));
  // --- 深度思考开关是否真的控制 thinking_enabled（驱动把 flash 的思考关掉靠它）---
  console.log('=== THINK TOGGLE TEST ===');
  const toggle = page.locator('[aria-pressed]').filter({ hasText: /^深度思考$/ }).first();
  const before = await toggle.getAttribute('aria-pressed');
  await toggle.click({ timeout: 3000 });
  await page.waitForTimeout(600);
  const after = await toggle.getAttribute('aria-pressed');
  const countBefore = posts.length;
  const ta2 = page.locator('textarea').first();
  await ta2.click();
  await ta2.fill('只回答两个字：好的');
  await ta2.press('Enter');
  await page.waitForTimeout(20_000);
  console.log(JSON.stringify({ before, after, lastPost: posts[posts.length - 1] ?? null, newPosts: posts.length - countBefore }, null, 1));
  console.log('=== VERDICT ===');
  console.log(JSON.stringify({
    visionModelType: vis ? vis.model_type : null,
    visionThinking: vis ? vis.thinking_enabled : null,
    sessionUrlOk: /\/a\/chat\/s\/[0-9a-zA-Z-]{8,}/.test(final.url) || final.url.includes('chat_session_id'),
    replied: final.reply.length > 0,
  }, null, 1));
} catch (err) {
  console.error('PROBE ERR:', err?.message);
  exitCode = 1;
} finally {
  await ctx.close().catch(() => {});
  process.exit(exitCode);
}


