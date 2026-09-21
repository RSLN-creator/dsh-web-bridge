// real-probe-29-kimi-cdp.mjs — CDP 网络层确证 kimi 真实流通道（2026-09-21）。
//
// 为什么不用 probe-kimi-network 的页内 hook：headless 下 kimi 反自动化，消息
// 根本没发出去（那版连 /api/chat 都没有）。本脚本用 Playwright 的 **CDP 网络层
// 监听（page.on('request'))**——它不受页内 fetch/XHR 覆盖影响，任何真实发出的
// HTTP 请求都会露出来。复用真实登录 profile，发一条极短消息，把**所有**含
// /api 或 /apiv2 或 /completion 或 stream 字样的请求 URL + method + POST body
// 前缀打出来，确证 kimi 网页走的真实流端点（是不是 Connect-RPC/SSE/别的）。
//
// 若 headless 下点按钮仍发不出去，退而求其次：已登录 profile 打开后，去会话
// 列表点开一个旧会话，等页面自动拉历史时看它打到哪个端点——同样能暴露
// 「网页与后端对话的真实 HTTP 通道」，不消耗新一次发送。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SITE_ID = process.env.PROBE_SITE || 'kimi';
const SITE_URL = 'https://www.kimi.com/';
const profileDir = process.env.PROBE_PROFILE || ('C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/' + SITE_ID);
const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const want = (u) => /\/api\/|\/apiv2\/|completion|stream|chat|gpt|sse|connect/i.test(String(u || ''))
  // 过滤纯遥测/埋点
  && !/gator\.|apmplus|abtest|cn-fp\.|feedback|statics\.|unpkg|\.riv|\.wasm|\.js\?/i.test(String(u || ''));

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: true, executablePath: edge, channel: undefined,
});
const page = (await ctx.pages())[0] || await ctx.newPage();

const seen = [];
// 记录 ChatService/Chat 的**响应体**（Connect RPC 二进制帧），用于解码器取证。
let chatRespBody = null;
let chatRespErr = null;
let lastReqBody = '';
page.on('request', async (req) => {
  const u = req.url();
  if (want(u)) {
    let body = '';
    try {
      if (req.method() === 'POST') {
        const p = req.postData();
        body = p ? String(p).slice(0, 400) : '';
      }
    } catch {}
    seen.push({ m: req.method(), ct: (await req.headers()['content-type']) || '',
      url: u.slice(0, 160), body: body.replace(/\s+/g, ' ').slice(0, 200) });
    console.log(`  [req] ${req.method()} ct=${(await req.headers()['content-type'] || '').slice(0, 30)} ${u.slice(0, 150)}`);
    if (body) console.log(`        body: ${body}`);
    if (/ChatService\/Chat/.test(u)) lastReqBody = body;
  }
});
page.on('response', async (resp) => {
  const u = resp.url();
  if (!/ChatService\/Chat/.test(u)) return;
  try {
    const buf = await resp.body();
    chatRespBody = buf;
    console.log(`  [resp ChatService/Chat] status=${resp.status()} ct=${resp.headers()['content-type']} bytes=${buf.length}`);
  } catch (e) { chatRespErr = String(e?.message || e); }
});

await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(9000);
console.log('[已打开] 页面 URL:', page.url());

// 登录态判定
const loginProbeBad = await page.evaluate(() => {
  const sels = 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")';
  for (const s of sels.split(', ')) {
    const els = [...document.querySelectorAll(s)];
    if (els.some((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }))
      return { hasBad: true, sel: s };
  }
  return { hasBad: false };
}).catch(() => ({ hasBad: 'probe-err' }));
console.log('[登录探针] bad 特征命中:', loginProbeBad);

// 发送
const inputSel = 'div.chat-input-editor, div[contenteditable="true"], textarea';
const input = page.locator(inputSel).first();
await input.click().catch(() => {});
await input.focus().catch(() => {});
await page.keyboard.type('你好，请回复两个字：收到', { delay: 10 }).catch(() => {});
await page.waitForTimeout(500);
const sendBtn = page.locator('div.send-button-container, button[type="submit"], [aria-label*="发送"], [aria-label*="Send"], [class*="-send"]').last();
if (await sendBtn.isVisible().catch(() => false)) {
  await sendBtn.click({ timeout: 5000 }).catch(async () => { await input.press('Enter'); });
} else { await input.press('Enter'); }
console.log('[已发送] 等待回复产生网络请求…');
await page.waitForTimeout(15000);

console.log('\n=== 网络层捕获（CDP，含 body）===');
if (!seen.length) console.log('  （无任何匹配请求 —— 消息未发出或 kimi 走的是被过滤掉的内嵌通道）');
for (const s of seen) console.log(`  ${s.m} ct=${s.ct} ${s.url}`);
console.log('匹配请求数:', seen.length);

console.log('\n=== ChatService/Chat 响应体取证 ===');
if (chatRespBody) {
  const out = path.join(os.tmpdir(), 'kimi-connect-response.bin');
  fs.writeFileSync(out, chatRespBody);
  console.log('[req body]', JSON.stringify(lastReqBody));
  console.log('[已落盘]', out, chatRespBody.length, 'bytes');
  // 分析 Connect 帧：结构 [flags(1)][len(4BE)][json]。每 5 字节一个头部。
  const buf = Buffer.from(chatRespBody);
  console.log('  -- Connect 帧解析 --');
  let off = 0; let idx = 0;
  while (off + 5 <= buf.length) {
    const flags = buf.readUInt8(off);
    const len = buf.readUInt32BE(off + 1);
    if (off + 5 + len > buf.length) { break; }
    const json = buf.slice(off + 5, off + 5 + len).toString('utf8');
    console.log(`  [帧${idx}] flags=${flags} len=${len} json=${json.slice(0, 260).replace(/\s+/g, ' ')}`);
    off += 5 + len; idx++;
    if (idx > 25) { console.log(`  …（截断，共 ${off} 字节已解析）`); break; }
  }
} else {
  console.log('  （未捕获到 ChatService/Chat 响应体：' + (chatRespErr || '可能走 DOM 终态或未触发') + '）');
}
await ctx.close();