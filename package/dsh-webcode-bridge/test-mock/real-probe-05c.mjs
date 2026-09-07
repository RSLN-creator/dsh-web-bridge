// real-probe-05c.mjs — recon: (a) dump the composer parent chain (widths/x) to
// learn why chatClipRect misses the sidebar; (b) capture raw SSE of one expert
// turn to see which fields carry THINK content on the live site.
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
  viewport: { width: 900, height: 1100 },
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
await page.waitForSelector('textarea.ds-scroll-area', { timeout: 20_000 });

// (a) composer parent chain
const chain = await page.evaluate(() => {
  const el = [...document.querySelectorAll('textarea.ds-scroll-area, textarea')].find((e) => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 0; });
  if (!el) return null;
  const rows = [];
  for (let n = el, i = 0; n && n !== document.body && i < 12; n = n.parentElement, i++) {
    const r = n.getBoundingClientRect();
    rows.push({ i, tag: n.tagName, cls: String(n.className).slice(0, 40), x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return { vw: window.innerWidth, rows };
});
console.log('CHAIN', JSON.stringify(chain, null, 1));

// (b) raw SSE capture of one expert turn
const sseChunks = [];
page.on('response', async (resp) => {
  if (!resp.url().includes('/api/v0/chat/completion')) return;
  try {
    const body = await resp.text();
    sseChunks.push(body);
  } catch { /* stream already consumed by page */ }
});
const input = page.locator('textarea.ds-scroll-area').first();
await input.fill('1+1等于几？只回答数字。');
await input.press('Enter');
await page.waitForTimeout(9000);
const raw = sseChunks.join('');
// extract interesting event lines: THINK mentions and unknown patch paths
const lines = raw.split('\n').filter((l) => l.startsWith('data:'));
const thinkLines = lines.filter((l) => /think/i.test(l)).slice(0, 6);
const fragPaths = new Set();
for (const l of lines) {
  try {
    const j = JSON.parse(l.slice(5).trim());
    const ops = Array.isArray(j?.v) ? j.v : [j];
    for (const op of ops) if (op?.p) fragPaths.add(String(op.p).replace(/\/-?\d+/, '/N'));
  } catch { /* non-JSON */ }
}
console.log('SSE bytes:', raw.length, 'lines:', lines.length);
console.log('THINK sample:', JSON.stringify(thinkLines).slice(0, 800));
console.log('paths:', JSON.stringify([...fragPaths].slice(0, 30)));

await ctx.close().catch(() => {});
