#!/usr/bin/env node
// real-attach-ingest.mjs — 0.19.11 真机判定（二）：附件到底**被不被读**。
//
// 上一支 real-attach-adjudicate.mjs 已证：附件轮里完成请求真的带上了 ref_file_ids，
// 网页对话框只留 80 字符的问题（正是用户要的形态）。剩下唯一没答的问题是
// 「模型读不读附件正文」——2026-09-20 真机曾出现 62,596 字符附件上传成功、
// 240s 零回复（doc/progress.md:1120）。本支把那个变量单独隔离出来：**尺寸**。
//
// 判定手法（内容级，不可伪证）：把标记**只写进附件正文**，随附指令只说
// 「把附件里那一行的值回给我」。模型若没读附件，就不可能知道那个值。
import path from 'node:path';
import { createBrowserDriver } from '../lib/browser-driver.js';

const PROFILE = process.env.REAL_PROFILE || path.join(process.cwd(), '.tmp', 'real-profile-probe');
const MARK = 'ZQ42';
const sizes = (process.env.ATTACH_SIZES || '3500,62000').split(',').map(Number);

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/', profileDir: PROFILE, headless: true,
  requestTimeoutMs: 200_000, attachInlineLimitChars: 500, logger: console,
});

function bodyOf(size) {
  const head = '以下是本地工程的上下文快照。\n';
  const marker = `ATTACH_MARKER_7f3a=${MARK}\n`;
  const pad = '填充行：本地上下文占位内容，用于把附件推到目标尺寸。\n';
  let s = head + marker;
  while (s.length < size) s += pad;
  return s.slice(0, size);
}

const rows = [];
try {
  const conn = await driver.connect();
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }
  for (const size of sizes) {
    const body = bodyOf(size);
    const instruction = '附件里有一行以 ATTACH_MARKER_7f3a= 开头的记录，请只回那个等号后面的值（不要解释）。';
    const key = 'real-ingest-' + size;
    const t0 = Date.now();
    let acc = '';
    let err = null;
    try {
      const r = await driver.sendTurn(key, body + '\n\n' + instruction, { fresh: true, model: 'deepseek', onDelta: (d) => { acc += d; } });
      if (!acc) acc = r?.text || '';
    } catch (e) { err = e?.message || String(e); }
    const st = (() => { try { return driver.status(); } catch { return null; } })();
    const text = String(acc).trim();
    rows.push({
      size,
      ms: Date.now() - t0,
      replyChars: text.length,
      markerEchoed: text.includes(MARK),
      promptChars: st?.driver?.attachTransport?.chars ?? null,
      attachTransport: st?.driver?.attachTransport ?? null,
      attachBlocked: st?.driver?.attachBlocked ?? null,
      lastEndReason: st?.driver?.lastEndReason ?? null,
      lastTimeoutScene: st?.driver?.lastTimeoutScene ?? null,
      error: err,
      replyHead: text.slice(0, 100),
    });
    console.log('\n--- size=' + size + ' ---');
    console.log(JSON.stringify(rows.at(-1), null, 2));
    await driver.resetConversation(key).catch(() => {});
  }
} catch (e) {
  console.log('ERR: ' + (e?.message || e));
} finally {
  try { await driver.close(); } catch {}
}
console.log('\n===== 汇总 =====');
for (const r of rows) console.log(`size=${r.size} ms=${r.ms} replyChars=${r.replyChars} markerEchoed=${r.markerEchoed} endReason=${r.lastEndReason} err=${r.error || '-'}`);
const allRead = rows.length > 0 && rows.every((r) => r.markerEchoed);
console.log(`\nRESULT(附件被读): ${allRead ? 'PASS（每个尺寸都回出了只在附件里的值）' : 'PARTIAL/FAIL'}`);
