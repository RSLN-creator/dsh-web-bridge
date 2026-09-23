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

/**
 * 把一个透明 token 消毒成单段安全路径名（与 dsh-drop-caret 同款纪律）。
 *
 * 为什么导出：本模块之外还有第二处需要同一套规则——`continue-budget.js` 的
 * 会话累计文件（`continuations/<token>.json`）。两处各写一份消毒正则必然会漂移，
 * 而漂移的后果是同一会话在两个文件名下有两份状态（或更糟：路径逃逸）。
 *
 * @param {unknown} raw 原始 token（站点 id / 会话键）。
 * @param {{max?: number}} [options] 截断上限，默认 80。
 * @returns {string} 只含 `[A-Za-z0-9_-]` 的单段路径名；清洗后为空时返回 `anonymous`。
 */
export function sanitizeToken(raw, { max = 80 } = {}) {
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
    // 0.16.29 修正：旧写法是 `[..., ''].filter(Boolean).join('\n')` —— filter 把那个
    // 空串**删掉**了，于是头部最后一行与正文之间**没有换行**，两者粘成一行：
    //   `> 更新时间：2026-...871Z教学全文 ABC`
    // 真机后果（本版实测）：正文第一行被吞掉，readPromptFile 读回只剩第二行之后。
    // 落盘从副本升格为投递源后，这个粘行就是「投递出去的上下文缺一行」——
    // 静默丢上下文，正是本仓库三条不可越界约束之一。改成显式空行分隔。
    const lines = [
      '> dsh-webcode-bridge 提示词落盘（0.16.29）',
      `> 更新时间：${new Date().toISOString()}`,
    ];
    if (meta.note) lines.push(`> 说明：${meta.note}`);
    const header = lines.join('\n') + '\n\n';
    fs.writeFileSync(file, header + body + '\n');
    return file;
  } catch {
    return null;
  }
}

/**
 * 读回一份提示词文件（0.16.29）。任何失败返回 null，绝不抛出。
 *
 * 存在的理由：用户要求「把上下文通过文件发送」——文件不能只是**副本**，
 * 必须是**投递源**。整段重建（WEB_SESSION_LOST / 新开会话）时优先读它：
 * 磁盘上那一份就是上一轮真实发出去的正本，读回即重放，落盘与投递从此同源。
 * 读不到（首次运行 / 写入曾静默失败 / 'off'）时调用方回落内存序列化——
 * 两条路都保住上下文，没有静默丢弃。
 *
 * @param {string|null} file 目标路径
 * @returns {string|null} 去掉头部元信息块之后的正文，读不到返回 null
 */
export function readPromptFile(file) {
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    // 剥掉 writePromptFile 写的头部（以 '> ' 开头的元信息行 + 随后的空行）。
    // 正文里的引用块（同样以 '> ' 开头）不受影响：只跳过**开头连续**的那几行。
    const lines = raw.split('\n');
    let i = 0;
    while (i < lines.length && lines[i].startsWith('> ')) i += 1;
    // 0.16.29 兼容：0.16.28 写的旧文件头部与正文**粘在一行**
    //（`> 更新时间：<ISO>正文首行`，见 writePromptFile 的修正注释）。
    // 新写入已修好，但磁盘上已有的旧文件必须仍能读回完整正文——否则升级后
    // 第一次重建会静默丢掉正文第一行。判据：被跳过的那一行里，ISO 时间戳
    // 之后**还有内容** ⇒ 那一段就是正文的开头，补回 body 前面。
    let legacyTail = '';
    if (i > 0) {
      const lastHeader = lines[i - 1];
      // 情形 1：无 note（头部末行是「更新时间」）——正文首行粘在 ISO 时间戳之后。
      const m = lastHeader.match(/^> 更新时间：\d{4}-\d{2}-\d{2}T[\d:.]+Z(.*)$/);
      if (m && m[1]) legacyTail = m[1];
      // 情形 2：有 note（头部末行是「说明」）——正文首行粘在说明之后。
      // 真机实测（`~/.dsh/webcode/prompts/deepseek.md`，0.16.28 写的）就是这一种：
      //   `> 说明：站点 deepseek 的教学/协议全文（逐轮覆盖）# 可用本地工具`
      // note 文本由本模块自己生成、**恒以 '）' 收尾**，因此最后一个 '）' 之后
      // 剩下的内容就是被粘走的正文首行；没有粘连时该捕获组为空串。
      const n = lastHeader.match(/^> 说明：.*）(.*)$/);
      if (n && n[1]) legacyTail = n[1];
    }
    while (i < lines.length && lines[i].trim() === '') i += 1;
    // legacyTail 与后面的行之间必须补回换行：它们本来就是两行，只是头部末行
    // 把正文首行粘走了。不加这一条会读成「教学全文 ABC第二行」（少一个换行），
    // 投递出去的上下文与原文不一致——同样是静默改变内容。
    const rest = lines.slice(i).join('\n');
    const body = (legacyTail ? (rest ? `${legacyTail}\n${rest}` : legacyTail) : rest).trim();
    return body === '' ? null : body;
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
