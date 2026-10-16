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
//   · 0.19.30：按**站点**分文件。meta.siteId（deepseek/glm/kimi…）时落
//     `webcode-bridge-replies.<site>.log`，未标识站点保持默认名。多站点/多账号
//     并跑时各站原文交错在同一文件里，归因要靠头行二次过滤；分文件让「只看
//     某站点」成为一次文件级选择。站点段只保留 [a-z0-9-]（防文件名注入），
//     显式 opts.basename 仍是测试通道、胜过站点分文件。
//   · 0.19.30：头行记**插件版本**（v=0.19.x）。取证时「这条记录是哪个版本的桥
//     写下的」直接从头行读，不必拿时间戳去比对 git 历史——跨版本对比归因
//     （协议漂移在某版本前后是否变样）不再需要交叉查证。读不到 package.json
//     时落 v=?（打包目录被裁剪等场景），绝不因版本读取失败影响落盘本身。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_REPLY_LOG_DIR = path.join(os.homedir(), '.dsh', 'logs');

// 0.19.30：插件版本，懒读一次。回复日志的取证人常常在另一个工作树/另一台机
// 器上读文件——「哪个版本的桥写的」必须能从文件自身读出。读失败（打包目录裁
// 剪、node_modules 安装形态）落 '?'，不影响落盘主路径。
let pluginVersionCache = null;
const pluginVersion = () => {
  if (pluginVersionCache !== null) return pluginVersionCache;
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    pluginVersionCache = typeof pkg?.version === 'string' && pkg.version ? pkg.version : '?';
  } catch { pluginVersionCache = '?'; }
  return pluginVersionCache;
};
export const DEFAULT_REPLY_LOG_BASENAME = 'webcode-bridge-replies.log';
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** 头尾定界行。文本里逐字出现这个串的概率可以忽略，且尾行让截取区间肉眼可辨。 */
const BOUND = '=== webcode-bridge raw reply ===';

/**
 * 把一轮的原始回复全文追加进日志，返回写入的文件路径；任何失败返回 null。
 *
 * @param {string} text 原始回复全文（调用方保证是收到的原样，不做归一化）
 * @param {{sessionId?: string|null, siteId?: string|null, chars?: number, calls?: number, note?: string}} [meta]
 *   头行元信息；一行管道分隔，供 grep 定位（正文里不写元信息）。
 * @param {object} [opts]
 *   目录 / 文件名 / 轮转阈值 / 时钟，测试用；默认见上。
 * @returns {string|null}
 */
export function appendReplyLog(text, meta = {}, opts = {}) {
  try {
    // ── 测试进程守卫（0.19.83 加固；long-term-issues #73）─────────────────────
    //
    // 旧判据只有 `process.env.NODE_TEST_CONTEXT`，而它**只在 `node --test` 下由 runner
    // 设置**。本仓库因为「本机 `spawnSync` 调外部程序 EPERM」而**文档化要求逐文件跑**
    // （`node test/xxx.test.mjs`）——**那种跑法根本不设这个变量** ⇒ 守卫不生效。
    //
    // 真机后果（2026-10-16 实测，逐条可复核）：
    //   · 跑一次 `node test/auto-continue.test.mjs` ⇒ 真实取证日志
    //     `~/.dsh/logs/webcode-bridge-replies.deepseek.log` 里
    //     `session=auto-cont-1` 的条目 **34 → 36（+2）**；
    //   · 全量统计：**3644 条里 2065 条来自非真机会话**（`auto-*`、`fence-tail`、
    //     `headless-tail`…），真机会话（`session-<uuid>`）只有 1579 条。
    //
    // 为什么这不是「测试自己的小毛病」：这份日志是**真机取证的唯一原始记录**，
    // 而本轮的 ④ 项审计**真的**先被它误导了一次——把一条**测试合成形状**（`D:/x.js`
    // 占位值、9 个 `auto-*` 会话、201 条只有 4 个逐字片段）当成「deepseek 真机的
    // 反复失败形态」，差点照它去改解析器。**假读数比没有读数更贵。**
    //
    // 新判据（三条任一命中即拒写，**宁可少写也不污染**）：
    //   ① `NODE_TEST_CONTEXT`（原判据，`node --test` 下由 runner 设置）；
    //   ② `WEBCODE_REPLY_LOG_TEST_DIR` **未显式给目录**——本仓库的测试要写日志时
    //      一律显式传 `opts.dir`（模块行为测试就是这么做的），因此「测试上下文出现在
    //      命令行上、又没给目录」这个组合可以判；
    //   ③ **调用栈里出现本仓库自己的测试文件**（`test/` 或 `test-mock/` 路径）——
    //      这是**与跑法无关**的判据，逐文件跑同样命中。
    // ⚠ ③ 用调用栈判，代价是**慢一点**（只在真要写盘时算一次），收益是**不依赖环境变量**。
    const explicit = opts.dir || process.env.WEBCODE_REPLY_LOG_DIR;
    if (!explicit) {
      if (process.env.NODE_TEST_CONTEXT) return null;
      // ③ 调用栈判定：只在没有显式目录时才算（有显式目录 = 测试自己要写临时目录，放行）
      try {
        const stack = new Error().stack || '';
        // 本仓库的测试与探针目录名；用路径分隔符两种形状都覆盖（Windows `\` 与 POSIX `/`）
        if (/[\\/](test|test-mock)[\\/][^\\/\s]+\.mjs/.test(stack)) return null;
      } catch { /* 取不到栈就当没有这条判据（保守放行，与原行为一致） */ }
    }
    const dir = explicit || DEFAULT_REPLY_LOG_DIR;
    // 0.19.30：站点段。站点 id 是小写 slug（getSite 校验），这里再收一道
    // [a-z0-9-] 并截 24 字符，防调用方传入任意字符串拼进文件名。
    const siteSeg = String(meta.siteId || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
    const basename = opts.basename || (siteSeg
      ? `webcode-bridge-replies.${siteSeg}.log`
      : DEFAULT_REPLY_LOG_BASENAME);
    const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : DEFAULT_MAX_BYTES;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, basename);
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
      fs.rmSync(file + '.1', { force: true });
      fs.renameSync(file, file + '.1');
    }
    const bits = [
      opts.now instanceof Date ? opts.now.toISOString() : new Date().toISOString(),
      `v=${pluginVersion()}`,
      ...(siteSeg ? [`site=${siteSeg}`] : []),
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
