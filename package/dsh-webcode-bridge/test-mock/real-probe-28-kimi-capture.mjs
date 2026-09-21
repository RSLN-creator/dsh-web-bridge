// real-probe-28-kimi-capture.mjs — 判定 kimi 捕获链是否采到流（2026-09-21）。
//
// 背景：real-probe-27 跑 kimi 报「捕获链在、页面有 57 字回复未回传」→ 超时。
// 本脚本只回答：kimi 网页的真实流是否被 captureInit 拦到并喂进 decoder。
// 用**短超时**（45s）跑一轮极短消息，重点看 WEBCODE_SSE_DEBUG 落盘的 sse-kimi-*.log：
//   · 文件存在且有 `cmpl`/`all_done` → 捕获已采流，问题在「end 判定/发送」；
//   · 文件不存在或空 → 捕获链没拦到 kimi 的流（fetch 包装失效 / 非 POST / 端点没命中）。
//
// 用法：${env:WEBCODE_SSE_DEBUG} 必须在**进程启动前**设好（browser-driver 构造期读）。
//   ${env:PROBE_PROFILE}='C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/kimi'
//   ${env:WEBCODE_SSE_DEBUG}='C:/Users/rsyhn/AppData/Local/Temp/kimi-capture'
//   node test-mock/real-probe-28-kimi-capture.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn } from '../lib/agent-preset.js';

const SITE_ID = process.env.PROBE_SITE || 'kimi';
const SITE_URL = SITE_ID === 'zai' ? 'https://chat.z.ai/' : SITE_ID === 'doubao' ? 'https://www.doubao.com/' : 'https://www.kimi.com/';
const PROFILE = process.env.PROBE_PROFILE
  || ('C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/' + SITE_ID);
const DEBUG_DIR = process.env.WEBCODE_SSE_DEBUG
  || path.join(os.tmpdir(), SITE_ID + '-capture');
const PROMPT = process.env.PROBE_PROMPT || '你好，请回复两个字：收到';

// 极短超时：不追求跑完，只求确认「流是否进 decoder」
const REQUEST_TIMEOUT = Number(process.env.PROBE_TIMEOUT || 45_000);

const say = (...a) => console.log(...a);
const outPath = path.join(DEBUG_DIR, `sse-${SITE_ID}-probe.log`);
try { fs.unlinkSync(outPath); } catch {}

let driver = null;
try {
  driver = createBrowserDriver({
    siteId: SITE_ID, site: SITE_URL, profileDir: PROFILE, headless: true,
    requestTimeoutMs: REQUEST_TIMEOUT, loginTimeoutMs: 120_000, logger: console,
  });
  const conn = await driver.connect();
  const st = driver.status();
  say(`[状态] running=${st?.running} loggedIn=${st?.loggedIn} basis=${st?.loginBasis}`);
  if (conn?.ok === false || conn?.loggedIn !== true) {
    say('⚠ 未判定为已登录 basis=' + st?.loginBasis);
    process.exitCode = 1;
  } else {
    const KEY = 'probe-cap-' + SITE_ID + '-' + Date.now();
    const prompt = serializeFirstTurn({
      system: 'You are a helpful assistant.',
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
    });
    say('发送极短消息（请求超时 ' + REQUEST_TIMEOUT + 'ms）…');
    const t0 = Date.now();
    try {
      const r = await driver.sendTurn(KEY, prompt, { fresh: true, model: SITE_ID + ':auto' });
      say('✔ 正常完成（' + (Date.now() - t0) + 'ms）正文: ' + JSON.stringify(String(r?.text || '').slice(0, 120)));
    } catch (e) {
      say('✗ sendTurn: ' + String(e?.message || e).slice(0, 160));
    }
  }
  await driver.close().catch(() => {});
  driver = null;

  say('\n===== SSE 抓包判定 =====');
  if (fs.existsSync(outPath)) {
    const raw = fs.readFileSync(outPath, 'utf8');
    const hasCmpl = /"event"\s*:\s*"cmpl"/.test(raw) || /cmpl/.test(raw);
    const hasDone = /all_done/.test(raw);
    const lines = raw.split('\n').filter((l) => l.trim()).length;
    say('文件存在: ' + outPath);
    say('大小: ' + raw.length + ' 字节 / ' + lines + ' 行');
    say('含 cmpl 事件: ' + hasCmpl + ' | 含 all_done: ' + hasDone);
    say('首 300 字符: ' + JSON.stringify(raw.slice(0, 300)));
    // 若没抓到 = 捕获链未采到 kimi 流 → 这才是超时根因
    if (!hasCmpl) say('⚠ 捕获链未采到 cmpl —— kimi 流未进 decoder，超时根因确认');
    else say('✔ 捕获链采到 cmpl —— 超时根因在 end 判定/发送，不在捕获');
  } else {
    say('⚠ 无 SSE 落盘文件（' + outPath + '）—— 捕获链未拦截到任何流');
  }
} catch (err) {
  say('\nPROBE FAIL: ' + String(err?.message || err));
  process.exitCode = 1;
} finally {
  try { await driver?.close?.(); } catch {}
  say('\nDEBUG_DIR: ' + DEBUG_DIR);
}