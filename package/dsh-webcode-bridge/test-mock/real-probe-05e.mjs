// real-probe-05e.mjs — ground-truth recon at 1400×1000 on a CONVERSATION page:
//   (a) composer parent chain + what elementFromPoint finds in the left gutter
//   (b) raw SSE of an expert reasoning turn: thinking_enabled value + every
//       distinct patch path (looking for where THINK content actually flows)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const profileDir = path.join(os.homedir(), '.dsh', 'webcode-edge-profile');
const exe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((c) => fs.existsSync(c));

const ctx = await chromium.launchPersistentContext(profileDir, {
  executablePath: exe,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
  viewport: { width: 1400, height: 1000 },
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
await page.waitForSelector('textarea.ds-scroll-area', { timeout: 20_000 });

// start a conversation so the sidebar is in "conversation page" state
const input = page.locator('textarea.ds-scroll-area').first();
await input.fill('只回答：好');
await input.press('Enter');
await page.waitForTimeout(6000);

const recon = await page.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 120; };
  const el = [...document.querySelectorAll('textarea.ds-scroll-area, textarea')].find(vis);
  if (!el) return { error: 'no textarea' };
  const ir = el.getBoundingClientRect();
  const chain = [];
  for (let n = el, i = 0; n && n !== document.body && i < 10; n = n.parentElement, i++) {
    const r = n.getBoundingClientRect();
    chain.push({ i, tag: n.tagName, x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) });
  }
  const gutter = [];
  for (const y of [120, 300, 500, 700]) {
    const p = document.elementFromPoint(12, y);
    if (p) {
      const r = p.getBoundingClientRect();
      gutter.push({ y, tag: p.tagName, cls: String(p.className).slice(0, 30), x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right), text: (p.textContent || '').trim().slice(0, 24) });
    }
  }
  return { vw: window.innerWidth, ir: { x: Math.round(ir.x), y: Math.round(ir.y) }, chain, gutter };
});
console.log('RECON', JSON.stringify(recon, null, 1));

// raw SSE of a reasoning turn
const sseChunks = [];
page.on('response', async (resp) => {
  if (!resp.url().includes('/api/v0/chat/completion')) return;
  try { sseChunks.push(await resp.text()); } catch { /* consumed */ }
});
await input.fill('一个农场有鸡和兔共35个头94只脚，问鸡兔各几只？请仔细推理。');
await input.press('Enter');
await page.waitForTimeout(15000);
const raw = sseChunks.join('');
const lines = raw.split('\n').filter((l) => l.startsWith('data:'));
let thinkingEnabled = null;
const paths = new Map();
for (const l of lines) {
  try {
    const j = JSON.parse(l.slice(5).trim());
    const ops = Array.isArray(j?.v) ? j.v : [j];
    for (const op of ops) {
      if (op?.p === undefined && op?.v?.response) thinkingEnabled = op.v.response.thinking_enabled ?? thinkingEnabled;
      if (op?.p) {
        const key = String(op.p).replace(/\/-?\d+/g, '/N');
        paths.set(key, (paths.get(key) || 0) + 1);
      }
    }
  } catch { /* non-JSON line */ }
}
console.log('SSE bytes:', raw.length, 'thinking_enabled:', thinkingEnabled);
console.log('paths:', JSON.stringify(Object.fromEntries([...paths.entries()].slice(0, 40))));

await ctx.close().catch(() => {});
