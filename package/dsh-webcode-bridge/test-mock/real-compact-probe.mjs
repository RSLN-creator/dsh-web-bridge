#!/usr/bin/env node
// real-compact-probe.mjs — 0.19.14 前置真机取证：手动 /compact 为什么不行。
//
// 代码层诊断（本探针要验证的两个命题）：
//   · 命题 A（修复可行性）：压缩调用若只把 COMPACTION_INSTRUCTION 作为**增量**
//     发进既有网页会话（历史已在网页侧），模型能否产出引用了历史事实的结构化
//     摘要 —— 能，则「游标匹配 + 只发增量」的修法成立。
//   · 命题 B（病因复现）：现状是无键首轮 —— 整段历史 + 指令压成**一条**消息
//     发给全新网页会话。会话历史一旦超过网页输入框上限（0a62dbb8 实测 ≈ 72,969
//     字符），就 PROMPT_TRUNCATED，且无键分支没有 rebuild → 无重试硬失败。
//     本相发一条 ≈ 88k 的整包，实测真实网页今天还收不收得下。
//
// 风控纪律：真实登录 profile，共 3 次发送（A 相 2 次 + B 相 1 次），结束后
// forget 映射；不重试循环、不加并发。
import path from 'node:path';
import os from 'node:os';
import { createBrowserDriver } from '../lib/browser-driver.js';

const PROFILE = process.env.REAL_PROFILE
  || path.join(os.homedir(), '.dsh', 'webcode-edge-profile');
const BIG_CHARS = Number(process.env.COMPACT_BIG_CHARS || 88_000);

// 与 @deepseek-ai/dsh-compaction-basic/lib/index.js 的 COMPACTION_INSTRUCTION 逐字一致
// （compact 摘要调用的最后一条 user 消息就是它）。
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  '- [the user\'s original and evolving goals; quote verbatim where the exact wording matters]',
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
].join('\n');

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/', profileDir: PROFILE, headless: true,
  requestTimeoutMs: 300_000, logger: console,
});

/** A 相的历史正文：含 3 个必须在摘要里复现的事实标记。 */
function historyTurn() {
  return [
    '[工程上下文快照] 以下是一次真实工作会话的回放，请记住其中的事实。',
    '用户目标：为并发下载器实现断点续传，并修复两个崩溃。',
    '决策记录：鉴权方案 AUTH_DECISION=use-pkce-flow-K7QX（用户拍板，不采用 basic auth）。',
    '崩溃一：文件 src/adapter/loop-guard.ts 在重连计数溢出时抛 ERR_SIGNATURE=STREAM_STALL_0x51，'
      + '修复方式是把计数器改为饱和比较（不再自增到溢出）。',
    '崩溃二：上传分片时 offset 计算用了分片序号而非字节偏移，导致 416 Range Not Satisfiable；'
      + '修复点在 src/uploader/chunker.ts 第 88 行，改为 seq * chunkBytes。',
    '用户特别强调：回归测试必须先红后绿；提交信息用 Conventional Commits。',
    '当前进度：两处修复都已落地，还差把重试上限从 3 提到 5（Pending）。请先不要执行任何修改，'
      + '这份快照只是上下文。收到后请只回复「上下文已就绪」。',
  ].join('\n');
}

/** B 相的整包：模拟「无键首轮」压出来的 88k 消息（历史回放 + 末尾压缩指令）。 */
function fullReplayPrompt() {
  const pad = '（历史轮回放占位：工具结果与文件内容快照，含函数签名 processChunk(seq: number, buf: Uint8Array): Promise<void> 与日志行 warn retryable=true backoff=2000ms。）\n';
  let body = '[整段历史回放开始]\n' + historyTurn() + '\n';
  let round = 0;
  while (body.length < BIG_CHARS) {
    round += 1;
    body += `\n第 ${round} 轮：用户追问实现细节，助手调用了 read_file 与 run_tests，` + pad.repeat(3);
  }
  body = body.slice(0, BIG_CHARS - COMPACTION_INSTRUCTION.length - 64)
    + '\n[整段历史回放结束]\n\n' + COMPACTION_INSTRUCTION;
  return body;
}

const rows = [];
async function timedSend(label, key, text, opts) {
  const t0 = Date.now();
  let acc = '';
  let err = null;
  try {
    await driver.sendTurn(key, text, {
      model: 'deepseek',
      onDelta: (d) => { acc += d; },
      ...opts,
    });
  } catch (e) { err = e; }
  const row = {
    label,
    promptChars: text.length,
    ms: Date.now() - t0,
    replyChars: acc.length,
    errCode: err?.code ?? null,
    errHead: err ? String(err.message).slice(0, 220) : null,
    accepted: err?.accepted ?? null,
    replyHead: acc.slice(0, 160).replace(/\s+/g, ' '),
  };
  rows.push(row);
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(row, null, 2));
  return { acc, err };
}

try {
  const conn = await driver.connect();
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }

  // A 相：历史先落进网页会话，再**只发指令**。
  const keyA = 'compact-probe-delta-' + Date.now();
  await timedSend('A1 历史落会话', keyA, historyTurn(), { fresh: true });
  await new Promise((r) => setTimeout(r, 4000));
  const a2 = await timedSend('A2 只发压缩指令', keyA, COMPACTION_INSTRUCTION, { fresh: false });
  const textA = a2.acc;
  console.log('\nA 相判定：');
  console.log('  摘要含 AUTH 标记 K7QX :', textA.includes('K7QX'));
  console.log('  摘要含崩溃文件 loop-guard:', textA.includes('loop-guard'));
  console.log('  摘要含错误码 STREAM_STALL_0x51:', textA.includes('STREAM_STALL_0x51'));
  console.log('  摘要含 Pending 提到 retry 上限 5:', /retry|重试|上限/.test(textA));

  // B 相：整包 88k（现状行为的真实网页表现）。
  const keyB = 'compact-probe-full-' + Date.now();
  const b = await timedSend('B1 整包重放（现状）', keyB, fullReplayPrompt(), { fresh: true });
  console.log('\nB 相判定：');
  console.log('  PROMPT_TRUNCATED 复现:', b.err?.code === 'PROMPT_TRUNCATED', b.err?.accepted ? `(accepted=${b.err.accepted})` : '');

  await driver.resetConversation(keyA).catch(() => {});
  await driver.resetConversation(keyB).catch(() => {});
} catch (e) {
  console.log('ERR: ' + (e?.message || e));
} finally {
  try { await driver.close(); } catch {}
}
