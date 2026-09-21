// real-probe-26-glm-frames.mjs — Task 0.2 GLM 正文残留真机抓帧（2026-09-21）。
//
// 只回答一个问题：GLM 网页在内置工具调用（code / quote_result / execution_output
// 等 content[].type）发生时，原始 SSE 帧里 **哪些 type 携带用户可见正文**、当前
// GlmDecoder 是否把该正文跳过/漏吐——把用户「支付宝 GLN 产品真实对话有正文残留」
// 这个观感钉成「哪个 type 在哪些帧里带字节」的第一手证据。
//
// 做法：复用真实登录态 profile（PROBE_PROFILE，默认 glm 已登录目录），headless
// 打开，发一条**会触发网页端内置工具/代码执行**的短指令，`WEBCODE_SSE_DEBUG`
// 落盘全部原始 SSE 帧；随后把 `.tmp/glm-replay/raw-frames.jsonl` 逐行解析，
// 统计每帧 content[].type 分布，标定哪些 type 带 text 正文。
//
// 铁律：这是**真实发送**（消耗一次 GLM web 额度、登录对话列表会多一条），
// 且只在已登录 profile 下才有效。触发语句用「写代码并执行 / 搜索」这类会让
// GLM 走内置工具而不是只回文字的话。
//
// 用法：
//   $env:PROBE_PROFILE='C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/glm'
//   node test-mock/real-probe-26-glm-frames.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn } from '../lib/agent-preset.js';

const SITE_ID = 'glm';
const SITE_URL = 'https://chatglm.cn/';
const PROFILE = process.env.PROBE_PROFILE
  || 'C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/glm';
// 真机抓包目录（相对本文件，跨平台用 os 基准避免 URL 路径的盘符问题）
const REPLAY_DIR = path.join(process.env.PROBE_DIR
  || path.join(os.tmpdir(), 'glm-replay'));

// 触发工具调用的指令。GLM 网页端有原生「写代码/执行/搜索」工具；给一句明确的
// 「写一段 python 求 3 的 12 次方并执行」是为了让网页走 code 工具而不是纯文字。
const PROMPT = process.env.PROBE_PROMPT
  || '请你写一段 Python 代码计算 3 的 12 次方并执行它，把结果告诉我。';

const say = (...a) => console.log(...a);

fs.mkdirSync(REPLAY_DIR, { recursive: true });
const outPath = path.join(REPLAY_DIR, 'raw-frames.jsonl');
try { fs.unlinkSync(outPath); } catch { /* 首次 */ }

// browser-driver 在**模块加载时**读 SSE_DEBUG_DIR（构造期），因此必须在 import
// browser-driver **之前**设好。静态 import 在求值前已完成，故探针运行前由调用方
// 设 WEBCODE_SSE_DEBUG（本文件的 REPLAY_DIR 只是扫盘目录兜底）。
say('[抓包目录] WEBCODE_SSE_DEBUG=' + (process.env.WEBCODE_SSE_DEBUG || '(未设置)'));
say('           实际扫盘目录=' + REPLAY_DIR);

let driver = null;
try {
  driver = createBrowserDriver({
    siteId: SITE_ID, site: SITE_URL, profileDir: PROFILE, headless: true,
    requestTimeoutMs: 180_000, loginTimeoutMs: 300_000, logger: console,
  });
  const conn = await driver.connect();
  const st = driver.status();
  say(`[状态] running=${st?.running} loggedIn=${st?.loggedIn} basis=${st?.loginBasis}`);
  if (!conn?.ok || conn?.loggedIn !== true) {
    say('⚠ 未判定为已登录（basis=' + st?.loginBasis + '）。本探针只在已登录 profile 下有效。');
    say('   若确认已登录却仍判未登录，那本身就是 Task 2.2 要修的登录探针误判。');
  }

  const KEY = 'probe-glm-frames-' + Date.now();
  const prompt = serializeFirstTurn({
    system: 'You are a helpful assistant.',
    tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
  });

  say('\n===== 发送触发指令 =====');
  say('PROMPT: ' + PROMPT);
  const t0 = Date.now();
  const r = await driver.sendTurn(KEY, prompt, { fresh: true, model: SITE_ID + ':auto' });
  const ms = Date.now() - t0;
  const txt = String(r?.text || '');
  say(`\n完成（${ms}ms）`);
  say('正文前 400 字: ' + JSON.stringify(txt.slice(0, 400)));
  say('正文长度: ' + txt.length);
  say('thinking 前 120: ' + JSON.stringify(String(r?.thinking || '').slice(0, 120)));
  say('result.reason: ' + JSON.stringify(r?.reason ?? null));

  // 关掉浏览器后，等待抓包 flush（追加写是同步 appendFileSync，应该已落盘）。
  await driver.close().catch(() => {});
  driver = null;

  // ---------- 分析落盘帧 ----------
  say('\n===== 原始 SSE 帧 type 分布 =====');
  if (!fs.existsSync(outPath)) outPath; // 抓包是分类文件名，未必叫 raw-frames
  // WEBCODE_SSE_DEBUG 生成的是 sse-<siteId>-<ts>.log，扫描整个目录。
  const sseFiles = fs.readdirSync(REPLAY_DIR).filter((f) => f.startsWith('sse-') || f.endsWith('.log'));
  if (!sseFiles.length) {
    say('⚠ 未抓到任何 SSE 帧文件（目录: ' + REPLAY_DIR + '）——可能没触发工具或该轮走非 streaming 流。');
    process.exitCode = 0;
  }
  for (const fName of sseFiles) {
    const fPath = path.join(REPLAY_DIR, fName);
    say('-- 文件: ' + fName + ' (' + fs.statSync(fPath).size + ' 字节)');
    const lines = fs.readFileSync(fPath, 'utf8').split('\n').filter((x) => x.trim());
    // 每行可能是 data: 前缀；兼容 SSE 原始带注释行
    const typeCount = new Map();          // type -> {n, textTotal, hasTextFrames}
    const typeWithText = new Map();       // type -> {frames, sample}
    for (const raw of lines) {
      let payload = raw;
      if (payload.startsWith('data:')) payload = payload.slice(5).trim();
      // 跳过纯注释/事件行
      if (!payload.startsWith('{')) continue;
      let j; try { j = JSON.parse(payload); } catch { continue; }
      if (!j || typeof j !== 'object' || !Array.isArray(j.parts)) continue;
      for (const part of j.parts) {
        if (!part || !Array.isArray(part.content)) continue;
        for (const c of part.content) {
          if (!c || typeof c !== 'object') continue;
          const type = String(c.type || '');
          const record = typeCount.get(type) || { n: 0, textTotal: 0, hasTextFrames: 0, hasImage: false };
          record.n++;
          const t = (typeof c.text === 'string' ? c.text : '')
            || (typeof c.think === 'string' ? '[think]' : '');
          if (t) { record.textTotal += t.length; record.hasTextFrames++; }
          if (type === 'image' || Array.isArray(c.image)) record.hasImage = true;
          typeCount.set(type, record);
          if (t && t.length > 40 && !typeWithText.has(type)) {
            typeWithText.set(type, { frames: record.n, sample: t.slice(0, 120) });
          }
        }
      }
    }
    say('  帧数: ' + lines.length);
    for (const [type, rec] of typeCount) {
      say('  type=' + (type || '(empty)').padEnd(18)
        + ' 帧=' + String(rec.n).padStart(5)
        + ' 带text帧=' + String(rec.hasTextFrames).padStart(5)
        + ' text字符=' + String(rec.textTotal).padStart(7)
        + (rec.hasImage ? ' [含图]' : ''));
    }
    if (typeWithText.size) {
      say('  --- 带正文的 type（potential 残留源） ---');
      for (const [type, info] of typeWithText) {
        say('  type=' + type + '  样例: ' + JSON.stringify(info.sample));
      }
    }
  }
  say('\nPROBE RESULT: done（原始帧在 ' + REPLAY_DIR + '）');
} catch (err) {
  say('\nPROBE FAIL: ' + String(err?.message || err));
  process.exitCode = 1;
} finally {
  try { driver?.close?.(); } catch { /* 已关 */ }
}