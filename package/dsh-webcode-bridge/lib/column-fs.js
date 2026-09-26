// column-fs.js — 并列三列的**产物围栏**（0.19.29）。
//
// ## 这个模块为什么存在（先读两轮思考，再读这里）
//
// 用户 2026-09-26 要求「做好沙箱适配」。两轮零代码思考的结论在
// `doc/research/2026-09-26-column-sandbox-round1-thinking.md` 与
// `...-round2-thinking.md`，三句话概括：
//
//   1. 并列三列走的是**控制面通路**（`web-control.js` 的 `POST chat`），
//      那条路只回文本、**不执行工具**，所以三列今天对工作区没有文件效果；
//   2. 因此「按列改写 workdir / 拦截模型越界写」是为**不存在的问题**造机器 ——
//      没有可拦截的写入方；
//   3. 真正能设围栏的地方只有一处：**本插件自己写文件的地方**。本模块就是那处围栏。
//
// ## 围栏的口径照抄官方（不是自己发明的）
//
// 官方的文件围栏是 `@deepseek-ai/dsh-fs-sandbox` 的 `SandboxedFileSystem.checkedTarget()`，
// 它的类型文档把口径写得很清楚，这里逐条对应：
//
//   · **canonicalize-then-contain**：先把目标规范化，再判它是否落在允许的根下；
//   · **认文件系统身份**：Windows 的 8.3 短名与大小写别名不能被当成「两个不同的路径」
//     （官方 `containment.ts` 的 `isPathUnder` 就是这么做的）；
//   · **委托前再规范化一次**：把「先判后写」之间的符号链接掉包窗口收窄；
//   · **拒绝时给结构化错误**：官方抛 `FS_SANDBOX_DENIED`，这里抛 `COLUMN_FS_DENIED`；
//   · **它是 containment，不是内核边界**：官方文档原文「This is containment, not a
//     security boundary」——本模块同样**不声称**自己是安全边界。
//
// 官方还如实标注了接受的残留风险（含 TOCTOU），本模块照同一口径：
// 「先判后写」之间的祖先符号链接掉包风险被「委托前再规范化」收窄，**但被接受**——
// 因为这里的威胁模型是「插件自己写错路径」，不是「攻击者构造路径」。

import fs from 'node:fs';
import path from 'node:path';
import { EXPLORE_ROOT, safePathSegment } from './column-context.js';

/** 围栏拒绝的结构化错误码（与官方 `FS_SANDBOX_DENIED` 同形，便于上层统一识别）。 */
export const COLUMN_FS_DENIED = 'COLUMN_FS_DENIED';

/** 围栏拒绝。带 `code` 让调用方不必去匹配错误文案（文案会改，码不会）。 */
export class ColumnFsDenied extends Error {
  /**
   * @param {string} target 被拒绝的目标路径
   * @param {string} root 允许的根
   */
  constructor(target, root) {
    super(`${COLUMN_FS_DENIED}: 目标不在本列目录内（target=${target} root=${root}）`);
    this.name = 'ColumnFsDenied';
    this.code = COLUMN_FS_DENIED;
    this.target = target;
    this.root = root;
  }
}

/** 本机路径比较是否区分大小写：Windows 不区分，其它平台区分。 */
const CASE_INSENSITIVE = process.platform === 'win32';

/**
 * 规范化一条**可能还不存在**的路径：对「最深的已存在祖先」取真实路径，
 * 再把尚不存在的尾段接回去。
 *
 * 为什么不能直接 `path.resolve`：那只做词法折叠，**不解析符号链接**，
 * 于是 `link -> /etc` 这种目标会被判成「在工作区内」。为什么也不能只
 * `realpathSync`：目标文件在写入前**本来就不存在**，`realpathSync` 会直接抛。
 *
 * @param {string} target 待规范化的路径
 * @returns {string} 规范化后的绝对路径
 */
export function canonicalWithMissingTail(target) {
  let cur = path.resolve(target);
  /** @type {string[]} */
  const missing = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(cur);
      // 到根了还不存在：退回词法绝对路径（调用方随后会因「不在根下」被拒）。
      if (parent === cur) return path.resolve(target);
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * 判断目标是否**就是**根或落在根之下。
 *
 * 用「根 + 分隔符」前缀比而不是裸 `startsWith`：否则 `/w/.hwb/cols/c1-evil`
 * 会被判成在 `/w/.hwb/cols/c1` 之下 —— 这是路径包含判据最经典的一个洞。
 *
 * @param {string} target 已规范化的目标
 * @param {string} root 已规范化的根
 * @returns {boolean} 是否在根下
 */
export function isPathUnder(target, root) {
  const a = CASE_INSENSITIVE ? target.toLowerCase() : target;
  const b = CASE_INSENSITIVE ? root.toLowerCase() : root;
  if (a === b) return true;
  const withSep = b.endsWith(path.sep) ? b : b + path.sep;
  return a.startsWith(withSep);
}

/**
 * 本列的产物根：`<workspace>/.hwb/cols/<scope>-<key>/`。
 *
 * 目录名与 `column-context.js` 的 `exploreRoot`、`key` **同源**——那里已经做过
 * 路径片段白名单净化，并被 `test/column-context.test.mjs` 钉住。这里刻意**不**再
 * 净化一遍：两处各净化一次，判据就会有两套，而漂移必然发生。
 *
 * @param {string} workspaceRoot 工作区根（绝对路径）
 * @param {{key?: string}|null} ctx 已归一化的列身份
 * @returns {string} 本列产物根（绝对路径）
 */
export function columnRootOf(workspaceRoot, ctx) {
  const key = safePathSegment(ctx?.key, 64);
  if (!key) throw new ColumnFsDenied(String(workspaceRoot), '(缺列身份，无法确定本列目录)');
  return path.join(path.resolve(workspaceRoot), EXPLORE_ROOT, key);
}

/**
 * 围栏：目标必须在 `root` 之下，否则抛 `ColumnFsDenied`。
 *
 * **返回的是刚刚重新规范化过的那个目标**，调用方必须用它去写 —— 这是官方
 * `checkedTarget` 的关键设计（「the checked identity is the mutated one」），
 * 它把「先判后写」之间的掉包窗口收到最小。返回原路径就等于把这道防线废掉。
 *
 * @param {string} target 期望写入的目标
 * @param {string} root 允许的根
 * @returns {string} 重新规范化后的目标（**必须用它写**）
 * @throws {ColumnFsDenied} 目标越界时
 */
export function assertUnderColumnRoot(target, root) {
  const realRoot = canonicalWithMissingTail(root);
  const realTarget = canonicalWithMissingTail(target);
  if (!isPathUnder(realTarget, realRoot)) throw new ColumnFsDenied(realTarget, realRoot);
  return realTarget;
}

/**
 * 把一段文本写成本列的产物文件（**唯一**受围栏保护的写入口）。
 *
 * 三道防线，缺一不可：
 *   ① `name` 过白名单净化（挡住 `../`、分隔符、编码逃逸）；
 *   ② 目标经 `assertUnderColumnRoot` 判定，越界即拒；
 *   ③ 写的是围栏**返回的**那个重新规范化过的路径。
 *
 * @param {string} workspaceRoot 工作区根
 * @param {{key?: string}|null} ctx 已归一化的列身份
 * @param {string} name 期望的文件名（会被净化）
 * @param {string} text 内容
 * @returns {string} 实际写入的绝对路径
 * @throws {ColumnFsDenied} 越界或缺列身份时
 */
export function writeColumnArtifact(workspaceRoot, ctx, name, text) {
  const root = columnRootOf(workspaceRoot, ctx);
  const safeName = safePathSegment(name, 80) || 'artifact';
  // 先建目录：`canonicalWithMissingTail` 要能解析到真实路径，目录得先存在。
  // 目录本身也必须在工作区内 —— 所以先判它一次。
  assertUnderColumnRoot(root, path.resolve(workspaceRoot));
  fs.mkdirSync(root, { recursive: true });
  const target = assertUnderColumnRoot(path.join(root, safeName), root);
  fs.writeFileSync(target, String(text ?? ''), 'utf8');
  return target;
}

/** 语言标签 → 文件扩展名。认不出的一律 `.txt`（不猜、也不丢内容）。 */
const EXT_BY_LANG = Object.freeze({
  js: 'js', javascript: 'js', mjs: 'mjs', cjs: 'cjs', ts: 'ts', tsx: 'tsx', jsx: 'jsx',
  json: 'json', css: 'css', html: 'html', md: 'md', markdown: 'md', py: 'py', python: 'py',
  sh: 'sh', bash: 'sh', ps1: 'ps1', yml: 'yml', yaml: 'yaml', sql: 'sql', go: 'go', rs: 'rs',
  java: 'java', c: 'c', h: 'h', cpp: 'cpp', diff: 'diff', patch: 'patch', toml: 'toml',
});

/**
 * 抽出回复里的**围栏代码块**（```lang … ```）。
 *
 * 为什么要单独抽：探索列的价值就是「方案」，而方案的可打开、可 diff 形态就是
 * 代码块。把它落成真文件，主审列的「统一审查」才终于有实物可吃，而不是只有
 * 引用通道里的一段文本。认不出语言时仍落盘（`.txt`）——内容比扩展名重要。
 *
 * @param {string} text 模型回复原文
 * @returns {{lang: string, ext: string, code: string}[]} 抽到的块（保序）
 */
export function fencedBlocks(text) {
  const out = [];
  const re = /```([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    const lang = String(m[1] || '').toLowerCase();
    out.push({ lang: lang || 'text', ext: EXT_BY_LANG[lang] || 'txt', code: m[2] });
  }
  return out;
}
