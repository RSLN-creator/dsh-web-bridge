// reply-log.js — 网页**原始回复全文**的落盘日志（0.16.17）。
//
// ## 为什么必须存在（真机取证第三次断链，2026-09-19）
//
// 「网页原话」此前只有三条去路，条条有缺口：
//   · UNPARSED 提示只带被扣原文头 200 字符（0.16.11），会话存档里就只有这么多——
//     夹具 15/16 因此只存到头；
//   · 0.16.13 的「扣留全文进日志」走 console.warn（lib/index.js 的 `warn`），
//     只到 DSH 进程的 stderr——DSH 运行时**不持久化** stderr，磁盘上什么都没有；
//   · `POST /__webcode/history` 要活体探针，受风控纪律约束（台账 §3），不能指望它。
// 0.16.16 真机验收（run-8）里 UNPARSED 扣留 1474 字符，磁盘上只剩 200 字符头——
// 归因第三次断链，用户明确要求「保留原接收内容日志」。本模块把每轮收到的
// **原始回复全文**（未归一化、未截断）追加到磁盘，任何一次漂移都能离线逐字取证。
//
// ## 边界
//
//   · 写失败**必须静默**（返回 null）：日志是取证手段，绝不许影响回合交付。
//   · 超过 maxBytes 轮转一代（`.1`，直接覆盖上一代）：不无限膨胀，也保留
//     「正在写的这份」之外的最近历史。
//   · 内容含用户对话，属本地取证数据：默认落 `~/.dsh/logs/`，不进会话、不外发；
//     这是它与「只进日志、不进会话」既有纪律（0.15.6 诊断文本同款）的一致延伸。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_REPLY_LOG_DIR = path.join(os.homedir(), '.dsh', 'logs');
export const DEFAULT_REPLY_LOG_BASENAME = 'webcode-bridge-replies.log';
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** 头尾定界行。文本里逐字出现这个串的概率可以忽略，且尾行让截取区间肉眼可辨。 */
const BOUND = '=== webcode-bridge raw reply ===';

/**
 * 把一轮的原始回复全文追加进日志，返回写入的文件路径；任何失败返回 null。
 *
 * @param {string} text 原始回复全文（调用方保证是收到的原样，不做归一化）
 * @param {{sessionId?: string|null, chars?: number, calls?: number, note?: string}} [meta]
 *   头行元信息；一行管道分隔，供 grep 定位（正文里不写元信息）。
 * @param {{dir?: string, basename?: string, maxBytes?: number, now?: Date}} [opts]
 *   目录 / 文件名 / 轮转阈值 / 时钟，测试用；默认见上。
 * @returns {string|null}
 */
export function appendReplyLog(text, meta = {}, opts = {}) {
  try {
    // 测试进程守卫：node --test 会跑大量驱动 index.js 生成器的用例（glm-session-replay、
    // empty-response 等真接线测试），没有这条它们会把测试回复写进真实
    // `~/.dsh/logs/`，污染取证数据。模块自身的行为测试显式传 opts.dir，不受影响。
    const explicit = opts.dir || process.env.WEBCODE_REPLY_LOG_DIR;
    if (!explicit && process.env.NODE_TEST_CONTEXT) return null;
    const dir = explicit || DEFAULT_REPLY_LOG_DIR;
    const basename = opts.basename || DEFAULT_REPLY_LOG_BASENAME;
    const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : DEFAULT_MAX_BYTES;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, basename);
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
      fs.rmSync(file + '.1', { force: true });
      fs.renameSync(file, file + '.1');
    }
    const bits = [
      opts.now instanceof Date ? opts.now.toISOString() : new Date().toISOString(),
      `session=${meta.sessionId ?? '-'}`,
      `chars=${Number(meta.chars ?? String(text ?? '').length)}`,
      `calls=${Number(meta.calls ?? 0)}`,
    ];
    if (meta.note) bits.push(`note=${meta.note}`);
    const body = String(text ?? '');
    const record = `${BOUND} | ${bits.join(' | ')}\n${body}\n${BOUND} end\n`;
    fs.appendFileSync(file, record);
    return file;
  } catch {
    return null;
  }
}
