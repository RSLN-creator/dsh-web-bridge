#!/usr/bin/env node
// real-compact-ladder.mjs — 定位今天网页输入框的真实上限（compact 病因的尺寸参数）。
// 从 88k（已验证可通过）向上阶梯，首个 PROMPT_TRUNCATED 即停。每档一次发送。
import path from 'node:path';
import os from 'node:os';
import { createBrowserDriver } from '../lib/browser-driver.js';

const PROFILE = process.env.REAL_PROFILE
  || path.join(os.homedir(), '.dsh', 'webcode-edge-profile');
const SIZES = (process.env.LADDER_SIZES || '160000,320000').split(',').map(Number);

const INSTRUCTION = 'You are now acting as a compaction engine. Condense the conversation ABOVE into a structured checkpoint. Output only the checkpoint text.';
const pad = '（历史轮回放占位：工具结果与文件内容快照，含函数签名 processChunk(seq: number, buf: Uint8Array): Promise<void> 与日志行 warn retryable=true backoff=2000ms。）\n';

function promptOf(size) {
  let body = '[整段历史回放开始] 用户目标：为并发下载器实现断点续传。\n';
  let round = 0;
  while (body.length < size) {
    round += 1;
    body += `第 ${round} 轮：用户追问实现细节，助手调用了 read_file 与 run_tests，` + pad.repeat(3);
  }
  return body.slice(0, size - INSTRUCTION.length - 32) + '\n[历史结束]\n\n' + INSTRUCTION;
}

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/', profileDir: PROFILE, headless: true,
  requestTimeoutMs: 300_000, logger: console,
});

try {
  const conn = await driver.connect();
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }
  for (const size of SIZES) {
    const key = 'compact-ladder-' + size + '-' + Date.now();
    const t0 = Date.now();
    let acc = '';
    let err = null;
    try {
      await driver.sendTurn(key, promptOf(size), {
        model: 'deepseek',
        fresh: true,
        onDelta: (d) => { acc += d; },
      });
    } catch (e) { err = e; }
    console.log('\n=== size=' + size + ' ===');
    console.log(JSON.stringify({
      size, ms: Date.now() - t0, replyChars: acc.length,
      errCode: err?.code ?? null, accepted: err?.accepted ?? null,
      errHead: err ? String(err.message).slice(0, 200) : null,
      replyHead: acc.slice(0, 120).replace(/\s+/g, ' '),
    }, null, 2));
    await driver.resetConversation(key).catch(() => {});
    if (err) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
} catch (e) {
  console.log('ERR: ' + (e?.message || e));
} finally {
  try { await driver.close(); } catch {}
}
