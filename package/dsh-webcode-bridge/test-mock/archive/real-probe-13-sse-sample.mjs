// real-probe-13-sse-sample.mjs — 真机采集并用捕获层外的原始 SSE 帧脱敏沉淀契约样本
// 产出 doc/research/sse-samples/<model>.md：只保留 SSE 结构骨架（event/前缀 + 帧类型 +
// 片段类型 + 计数字数），内容一律脱敏 —— 供 DeepSeek 页面升级前回归比对格式是否变化。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\.edge-real-profile';
const OUT_DIR = 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\doc\\research\\sse-samples';

const LABELS = { flash: '快速模式', deepseek: '专家模式' };

const CAPTURE = `
(function () {
  if (window.__sseCap) return; window.__sseCap = { chunks: [] };
  const TARGET = '/api/v0/chat/completion';
  const emit = (txt) => { try { window.__sseCap.chunks.push(txt || ''); } catch {} };
  const drain = (xhr) => { const t = typeof xhr.responseText === 'string' ? xhr.responseText : ''; emit(t); };
  const wrap = (ctx, xhr) => { const i = null; return ctx; };
  // XHR
  const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { try { this.__t = { m: String(m||'').toUpperCase(), u: String(u||'') }; } catch {} return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    const t = this.__t; let last = 0; let timer = null;
    if (t && t.m === 'POST' && t.u.includes(TARGET)) {
      const origState = this.onreadystatechange; let fired = false;
      const step = () => { try { const txt = typeof this.responseText === 'string' ? this.responseText : ''; if (txt.length > last) { emit(txt.slice(last)); last = txt.length; } } catch {} };
      timer = setInterval(step, 40);
      const done = () => { clearInterval(timer); step(); };
      try { this.addEventListener('loadend', done, true); } catch {}
      // note: on older XHR two handlers trick is fragile; interval fallback covers it
      const wrapEvt = (evt, code) => { const superEvt = code; return evt; };
    }
    return oSend.apply(this, arguments);
  };
  // fetch
  const of = window.fetch ? window.fetch.bind(window) : null;
  if (of) window.fetch = async function (input, init) {
    const resp = await of(input, init);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const m = String((init && init.method) || 'GET').toUpperCase();
      if (m === 'POST' && url.includes(TARGET) && resp.ok && resp.body) {
        const reader = resp.body.getReader(); const dec = new TextDecoder();
        (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; emit(dec.decode(value, { stream: true })); } } catch {} })();
      }
    } catch {}
    return resp;
  };
})();
`;

function fillAndSend(page, prompt, label) {
  return page.evaluate(async ({ prompt, label }) => {
    const pick = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const q = document.querySelectorAll('textarea');
    let input = [...q].find(pick) || q[0];
    if (!input) return 'input-not-found';
    if (label) {
      // click the mode label to open menu + pick
      const els = [...document.querySelectorAll('*')].filter(n => (n.textContent || '').trim() === label && n.children.length === 0);
      const t = els.find(e => pick(e));
      if (t) { t.click(); await new Promise(r => setTimeout(r, 300)); }
    }
    const proto = HTMLTextAreaElement.prototype || HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, prompt);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    const base = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    input.dispatchEvent(new KeyboardEvent('keydown', base));
    input.dispatchEvent(new KeyboardEvent('keypress', base));
    input.dispatchEvent(new KeyboardEvent('keyup', base));
    return 'sent';
  }, { prompt, label });
}

function sanitize(raw) {
  const lines = (raw || '').split(/\r?\n/).filter(l => l.trim() !== '');
  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (s.startsWith('event:')) { out.push(s); continue; }
    if (s.startsWith('data:')) {
      const payload = s.slice(5).trim();
      let body = payload;
      try { body = JSON.stringify(JSON.parse(payload)); } catch {}
      // collapse content-bearing fields to placeholders
      body = body
        .replace(/("(?:content|payload|text|answer|title)")\s*:\s*".*?"/g, '$1:"<redacted:n>')
        .replace(/"content"\s*:\s*\[[^\]]*\]/g, '"content":[<redacted>]')
        .replace(/"fragments"\s*:\s*\[[^\]]*\]/g, '"fragments":[<redacted>]');
      out.push('data: ' + body.slice(0, 400));
      continue;
    }
    out.push('raw:' + s.slice(0, 200));
  }
  return out;
}

function summarize(raw) {
  const lines = (raw || '').split(/\r?\n/).filter(l => l.trim() !== '');
  const stats = { events: 0, data: 0, types: {}, longestData: 0 };
  for (const l of lines) {
    const s = l.trim();
    if (s.startsWith('event:')) { stats.events++; const t = s.slice(6).trim(); stats.types[t] = (stats.types[t] || 0) + 1; }
    else if (s.startsWith('data:')) { stats.data++; stats.longestData = Math.max(stats.longestData, s.length); }
  }
  return stats;
}

const models = process.argv.slice(2).length ? process.argv.slice(2) : ['flash', 'deepseek'];
fs.mkdirSync(OUT_DIR, { recursive: true });
let ctx = null;
let timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); process.exit(2); }, 160_000);
try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true,
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 640, height: 900 },
  });
  for (const model of models) {
    const page = await ctx.newPage();
    await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    await page.addInitScript(CAPTURE).catch(() => {});
    // re-run capture on the already-loaded page too
    await page.evaluate(CAPTURE).catch(() => {});
    await page.waitForTimeout(400);
    const sent = await fillAndSend(page, '请只回复两个字：收到', LABELS[model]);
    console.log(model, 'send=', sent);
    // poll until capture got a stop event or timeout
    let raw = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      await page.waitForTimeout(1200);
      const chunks = await page.evaluate(() => window.__sseCap ? window.__sseCap.chunks : []);
      raw = chunks.join('');
      const st = summarize(raw);
      if (st.data > 0 && st.types['finish'] || (st.data > 4 && raw.includes('OPENAI')) || st.data > 20) {
        // heuristics: enough frames streamed; give it a beat then break
        if (raw.includes('finish') || st.data > 25) break;
      }
      if (/finish/.test(raw)) break;
    }
    const st = summarize(raw);
    const lines = sanitize(raw);
    const md = [
      '# DeepSeek Web · ' + model + ' · SSE 结构样本（脱敏）',
      '',
      '- 采集时间: ' + new Date().toISOString(),
      '- 来源: chat.deepseek.com /api/v0/chat/completion（真机 ' + model + ' 模式）',
      '- 用途: 供应商契约回归样本，页面升级前比对格式是否变化',
      '',
      '## 概要',
      '```json',
      JSON.stringify(st, null, 2),
      '```',
      '',
      '## 帧骨架（内容已脱敏）',
      '```',
      ...lines.slice(0, 240),
      '```',
      '',
    ].join('\n');
    const f = path.join(OUT_DIR, model + '.md');
    fs.writeFileSync(f, md);
    console.log('  wrote', f, '| dataFrames=', st.data, 'eventTypes=', JSON.stringify(st.types), 'sampleLines=', lines.length);
    await page.close().catch(() => {});
  }
} catch (e) {
  console.error('ERR:', e?.message);
} finally {
  clearTimeout(timer);
  try { await ctx?.close(); } catch {}
}
console.log('DONE');