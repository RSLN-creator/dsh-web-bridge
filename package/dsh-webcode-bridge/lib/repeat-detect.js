// repeat-detect.js — 思维链「退化重复」的**通用**检测（0.19.26，用户指令）。
//
// ## 用户原话与它排除了什么
//
//   「如果出现类似的：就你可以deepseek单独加上：出现反复一样字段20次以上在思维链时候
//    自动打断重发？然后单纯词语对比度可以做到吗？不是具体词语而是通用适配」
//
// 三个关键词决定了本模块的形状：
//
//   1. **「不是具体词语」** —— 不允许出现任何词表（没有 'Go'、没有 'OK'、
//      没有 'Let me output'）。真机里模型每次卡住时唠叨的那句话都不一样，
//      写词表就是把「已见过的形态」当成「全部形态」——本仓库在协议护栏上已经
//      栽过至少三次（`doc/long-term-issues.md` #15/#18/#25 都记着同一句教训：
//      「检测器不能只覆盖已知形态」）。
//
//   2. **「通用适配」** —— 判据必须对**任何**语言与**任何**内容成立。
//      做法是纯统计：把文本切成 token，找**最小周期**，数它连续重复了几遍。
//      「Go. Go. Go.…」与「继续继续继续…」与「[[[[[[…」在这个判据下是同一件事。
//
//   3. **「反复一样字段 20 次以上」** —— 阈值默认 20，且是**周期重复次数**
//      而不是「某个词出现 20 次」：后者会把正常的枚举（列表里 20 次 `-`）判死，
//      前者要求「一段内容以固定周期自我复制」，那是退化循环的真实形状。
//
// ## 为什么必须独立成纯函数模块
//
// 与本仓库 `metrics.js` / `zero-progress.js` / `wait-stats.js` 同一传统：
// 判据抽成纯函数，才能**离线**用构造输入钉死，也才能反向验证（把判据改坏必须变红）。
// 这个检测一旦误判，代价是**打断一个本来正常的回复**——那比不检测更贵，
// 所以它必须能被逐字地、可复现地检验。

/** 取 tail 时最多回看的字符数：退化循环总在**尾部**，回看整段思考毫无必要。 */
const DEFAULT_TAIL_CHARS = 6000;

/**
 * 把文本切成 token。
 *
 * 切法刻意**粗**，因为判据只需要「同一段东西重复」这件事成立：
 *   · CJK 单字各自成 token（中文没有空格，双字词切分要靠词典，而我们不引词典）；
 *   · ASCII 连续字母/数字/下划线成词（`Let`、`Go`、`OK`）；
 *   · 其余（空白、标点、单个符号）各自成 token。
 *
 * 结果里**保留空白与标点**是刻意的：`Go. Go. Go.` 的周期含空格与句点，
 * 丢掉它们会让 `Go Go Go`（无标点）与 `Go. Go. Go.` 混成同一个形状——
 * 那没关系（两者都是退化），但丢掉空白会让「正常英文句子里重复出现同一个词」
 * 更容易凑出周期，反而提高误判。
 *
 * @param {string} text 任意文本
 * @returns {string[]} token 序列
 */
export function tokenizeForRepeat(text) {
  const s = String(text || '');
  if (!s) return [];
  const re = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[A-Za-z0-9_]+|\s+|[^\s]/gu;
  return s.match(re) || [];
}

/**
 * 在 token 序列里找「最小周期的连续重复」。
 *
 * 算法：对每个候选周期 `p`（1…`maxPeriod`），从序列**末尾**往回数，
 * 看末尾 `p` 个 token 能向前自我复制多少次（要求**逐 token 全等**）。
 * 取重复次数最多的那个 `p`。
 *
 * 为什么要**逐 token 全等**而不是相似度：本函数的唯一职责是「确定无疑地退化」，
 * 宁可漏报（漏了还有既有的整轮续跑兜底）也不能误报（误报会打断正常回复）。
 * 相似度阈值需要一个「多少算像」的数字，而那个数字没有事实依据。
 *
 * @param {string[]} tokens token 序列
 * @param {{minRepeats?: number, maxPeriod?: number, minRunChars?: number}} [opts]
 * @returns {{period: number, repeats: number, runTokens: number, sample: string} | null}
 */
export function findPeriodicRun(tokens, opts = {}) {
  const minRepeats = Math.max(2, Math.floor(Number(opts.minRepeats) || 20));
  const maxPeriod = Math.max(1, Math.floor(Number(opts.maxPeriod) || 40));
  const minRunChars = Math.max(1, Math.floor(Number(opts.minRunChars) || 30));
  const n = tokens.length;
  if (n < 2) return null;

  let best = null;
  for (let p = 1; p <= Math.min(maxPeriod, Math.floor(n / minRepeats)); p += 1) {
    const head = n - p;
    // 周期内容：末尾 p 个 token。全空白/全空的周期不算（不是「内容」在重复）。
    const sampleTokens = tokens.slice(head);
    const sample = sampleTokens.join('');
    if (!sample.trim()) continue;
    // 周期里必须含**实词字符**（字母/数字/CJK）。
    //
    // 这条是探针实测逼出来的（0.19.26）：没有它，两类**正常**写法会被判成退化——
    //   · 尾部长横线 `-`×40（markdown 分隔线 / 签名线）；
    //   · 重复的表格分隔行 `| --- | --- |`（模型在思考里画表，分隔行逐字相同）。
    // 两者都是「装饰/骨架在重复」，不是「内容在自我复制」。判据要求周期里至少有一个
    // 实词字符，就把「装饰重复」与「内容退化」分开了——而且它**不是词表**：
    // 任何语言的字母与汉字都算，只有纯标点/空白被排除。
    //
    // 代价（如实记）：纯符号退化（`[[[[[[…`）不再被本判据抓到。那是有意的取舍——
    // 纯符号长串更常见的成因是协议/JSON 被截断，由协议层与既有整轮续跑兜底；
    // 在这里抓它会把「一行长分隔线」一起抓进来，代价是打断正常回复。
    if (!/[A-Za-z0-9\u3400-\u4dbf\u4e00-\u9fff]/.test(sample)) continue;
    let repeats = 1;
    let i = head;
    while (i - p >= 0) {
      let same = true;
      for (let k = 0; k < p; k += 1) {
        if (tokens[i - p + k] !== tokens[i + k]) { same = false; break; }
      }
      if (!same) break;
      repeats += 1;
      i -= p;
    }
    if (repeats < minRepeats) continue;
    const runTokens = repeats * p;
    // 重复段总字符数下限：挡住「单个标点重复 20 次」这类噪声
    //（`----------` 分隔线、`=====` 标题线都是**正常**写法）。
    if (sample.length * repeats < minRunChars) continue;
    // 同样长度时取**周期更小**的那个：「继续继续继续」应以周期 2 报出，而不是 4。
    if (!best || runTokens > best.runTokens || (runTokens === best.runTokens && p < best.period)) {
      best = { period: p, repeats, runTokens, sample };
    }
  }
  return best;
}

/**
 * 检测思维链里的退化重复（**通用**：无词表、无语言假设）。
 *
 * 返回值刻意带上 `sample` 与 `repeats`：调用方要能把「检测到了什么」写进日志与
 * 再教学提示——只说「检测到循环」而不说循环的是什么，下一个人无法复核。
 *
 * 只看文本**尾部** `tailChars` 个字符：退化循环的特征是「一直重复到被截断」，
 * 回看整段既慢又会把「早先正常出现过一次的短语」算进来。
 *
 * @param {string} text 思考链全文（或任意文本）
 * @param {{minRepeats?: number, maxPeriod?: number, minRunChars?: number, tailChars?: number}} [opts]
 * @returns {{period: number, repeats: number, runTokens: number, sample: string, runChars: number} | null}
 *   检测到退化重复时返回读数；否则 null。
 */
export function findDegenerateRepeat(text, opts = {}) {
  const tailChars = Math.max(200, Math.floor(Number(opts.tailChars) || DEFAULT_TAIL_CHARS));
  const s = String(text || '');
  const tail = s.length > tailChars ? s.slice(-tailChars) : s;
  const hit = findPeriodicRun(tokenizeForRepeat(tail), opts);
  if (!hit) return null;
  return { ...hit, runChars: hit.sample.length * hit.repeats };
}
