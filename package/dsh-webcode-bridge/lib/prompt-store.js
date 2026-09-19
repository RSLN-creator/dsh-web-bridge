// prompt-store.js — 提示词/上下文的每站点、每会话落盘（0.16.28）。
//
// ## 为什么存在（用户指令 + dsh-drop-caret 模式）
//
// 用户原话：「将提示词保存为本地的单独文件-每个网址一个，然后每轮发送过去，
// 然后是每轮会话单独本地地址——如果新开会话-web 端，就一样把这个当上下文通过
// 文件发送」。此前发给网页的提示词只活在内存与 reply-log 的混流里：站点教学
// 没有一份「此刻真实在教什么」的可读文件，会话整段重建时几十万字符只存在于
// 一次性的内存字符串。落盘后：
//   · **每站点一份**（prompts/<site>.md）：该站点真实在教的教学/协议全文
//     （preset + 传输协议段），逐轮覆盖——排障与「再教」附件的直接来源；
//   · **每会话一份**（sessions/<sessionKey>.md）：该会话最近一次首轮/整段重建
//     的完整文本——网页会话丢失时「把上下文通过文件发送」的直接来源。
//
// 模式对照 dsh-drop-caret（reference 外的已装插件）：它把上传文件按会话隔离
// 落盘（`.dsh-drop/session-<id>/`），文件名消毒 + 会话 id 约束到安全字母表；
// 本模块把同一套纪律用在桥自己的提示词上（siteId 与 sessionKey 同为透明 token）。
//
// ## 边界
//
//   · 写失败**必须静默**（返回 null）：落盘是取证/投递手段，绝不许影响回合交付
//     （与 reply-log.js 同一纪律）。
//   · 内容含用户对话，属本地数据：默认落 `~/.dsh/webcode/`，不进会话、不外发。
//   · 测试进程守卫与 reply-log 同款：node --test 下不显式传 dir 就不写。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PROMPT_STORE_DIR = path.join(os.homedir(), '.dsh', 'webcode');

/** 站点 id 是透明 token，仍约束到安全字母表（与 dsh-drop-caret 同款纪律）。 */
function sanitizeToken(raw, { max = 80 } = {}) {
  const cleaned = String(raw || '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, max);
  return cleaned === '' ? 'anonymous' : cleaned;
}

/**
 * 每站点提示词文件路径：`<dir>/prompts/<siteId>.md`。
 *
 * @param {string} dir 存储根目录
 * @param {string} siteId 站点 id（deepseek / glm / …）
 * @returns {string}
 */
export function sitePromptPath(dir, siteId) {
  return path.join(dir, 'prompts', `${sanitizeToken(siteId, { max: 40 })}.md`);
}

/**
 * 每会话上下文文件路径：`<dir>/sessions/<sessionKey>.md`。
 *
 * sessionKey 形如 `<sessionId>` 或 `<sessionId>::<agentId>`，整体消毒成单段
 * 安全 token（`::` 折叠为 `__`）——路径段里不保留分隔符，杜绝逃出 sessions/。
 *
 * @param {string} dir 存储根目录
 * @param {string} sessionKey 会话键
 * @returns {string}
 */
export function sessionPromptPath(dir, sessionKey) {
  const token = sanitizeToken(String(sessionKey || '').replace(/::/g, '__'));
  return path.join(dir, 'sessions', `${token}.md`);
}

/**
 * 写一份提示词文件（逐轮覆盖）。任何失败返回 null，绝不抛出。
 *
 * @param {string} file 目标路径（sitePromptPath / sessionPromptPath 的返回值）
 * @param {string} text 文件全文
 * @param {{note?: string}} [meta] 头部元信息行
 * @returns {string|null}
 */
export function writePromptFile(file, text, meta = {}) {
  try {
    const body = String(text ?? '');
    if (!body.trim()) return null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const header = [
      `> dsh-webcode-bridge 提示词落盘（0.16.28）`,
      `> 更新时间：${new Date().toISOString()}`,
      meta.note ? `> 说明：${meta.note}` : null,
      '',
    ].filter(Boolean).join('\n');
    fs.writeFileSync(file, header + body + '\n');
    return file;
  } catch {
    return null;
  }
}

/**
 * 一轮的落盘入口：站点文件 +（有会话键时）会话文件。
 *
 * @param {{dir?: string, siteId: string, sessionKey?: string|null, siteText?: string|null, sessionText?: string|null}} args
 *   `siteText` 是该站点的稳定教学全文（preset + 传输协议段，fresh 首轮传）；
 *   `sessionText` 是本轮的首轮/整段重建全文（增量轮不传——上下文没变，落盘
 *   只会制造 IO 噪音；整段重建点也只传它，教学部分与首轮相同无需重写）。
 * @returns {{siteFile: string|null, sessionFile: string|null}}
 */
export function writePromptFiles(args) {
  const requested = args.dir || process.env.WEBCODE_PROMPT_STORE_DIR;
  // 'off' = 显式关闭；测试进程（node --test）在无显式目录时一律不写——
  // 与 reply-log 同款守卫，行为测试显式传 args.dir 不受影响。
  if (requested === 'off') return { siteFile: null, sessionFile: null };
  if (!requested && process.env.NODE_TEST_CONTEXT) return { siteFile: null, sessionFile: null };
  const dir = requested || DEFAULT_PROMPT_STORE_DIR;
  const siteFile = args.siteText
    ? writePromptFile(sitePromptPath(dir, args.siteId), args.siteText, { note: `站点 ${args.siteId} 的教学/协议全文（逐轮覆盖）` })
    : null;
  const sessionFile = args.sessionKey && args.sessionText
    ? writePromptFile(sessionPromptPath(dir, args.sessionKey), args.sessionText, { note: `会话 ${args.sessionKey} 最近一次首轮/整段重建全文` })
    : null;
  return { siteFile, sessionFile };
}
