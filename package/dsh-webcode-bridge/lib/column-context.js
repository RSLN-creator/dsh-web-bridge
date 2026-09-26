// column-context.js — 并列多会话的**列身份**与**沙箱约定**（0.19.21，用户 Q5 的后半问）。
//
// ## 这个模块解决什么
//
// 用户 2026-09-26 原话（逐字）：
//
//   「……3 者独立，但是**考虑做好沙箱适配**——可能对于同一文件进行思考/修改，
//    怎么做到**选定一个模型进行主要审查**？怎么选定模型进行**同时互不影响的方案探索**」
//
// ## 为什么这里只做「约定」而不做「拦截」——必须写清楚
//
// 本插件的**能写的地方只有控制面与提示词**：模型发起的 `edit` / `pwsh` 工具调用由
// **DSH Harness 的工具执行器**落地，那条链路上没有本插件的插槽。要在文件系统层
// 真的拦截「探索列不许写主工作树」，必须在 `provider → adapter → 工具调用元数据`
// 全链把列身份带下去，再由工具执行器按列改写 `workdir` / 拒绝越界写——
// 那是跨层改造，不属于本插件单方面能完成的事。
//
// 因此本模块交付的是**可执行、可验证的那一半**：给每一列一段明确的**工作区约定**，
// 写进它收到的第一条消息。这带来三件真实的东西：
//
//   1. **探索列有地方可去**：`<workspace>/.hwb/cols/<列键>/` 是它的产出目录，
//      而不是「什么都不许做」——后者会让探索列退化成只会说话；
//   2. **主审列知道自己的职责**：汇总是它的活，它因此会去看别的列的产出
//      而不是各自为战；
//   3. **约定是可见的**：这段文本会出现在那一列的会话里，用户能核对它到底被告知了什么
//      （本项目对「隐式行为」一贯的立场：看得见的才可排查）。
//
// **不夸大成「沙箱」**：本模块不阻止任何一次写入。要真拦截，看上面那段跨层改造。
// 文档里也照这个口径写（`doc/research/2026-09-26-glm-goal-round2-implementation.md` §2.4）。

/** 探索列的产出根（相对工作区）。`.hwb/` 已被 `.gitignore` 覆盖。 */
export const EXPLORE_ROOT = '.hwb/cols';

/**
 * 路径片段白名单（0.19.23）：只留字母、数字、`_`、`-`，其余一律换成 `_`，
 * 折叠连续 `_`、去掉首尾 `_`，最后按 `max` 截断。
 *
 * 为什么必须做（这是我上一版**真的漏掉的**）：`key` 与 `scope` 都来自客户端
 * 请求体，而它们会被拼进**发给模型的路径字符串**。一个 `../` 就能把「产出写
 * 这里」指到工作区之外，而模型会照做——那不是「约定不严」，那是
 * **把路径穿越写进了提示词**。
 *
 * 判据用白名单而不是黑名单：黑名单永远漏（`..`、`\`、`%2e%2e`、全角斜杠…），
 * 而这里根本不需要那些字符——列键是 `c1`/`c2`，会话作用域是十六进制与短横。
 *
 * @param {unknown} raw 原始片段
 * @param {number} max 截断长度上限
 * @returns {string} 净化后的片段（可能为空串）
 */
export function safePathSegment(raw, max = 40) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const cleaned = s
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.slice(0, max);
}

/** 列的两种角色。取值刻意与 client.cjs 的 `role` 字段逐字一致。 */
export const COLUMN_ROLES = Object.freeze(['explore', 'review']);

/**
 * 归一化调用方给的列身份。**不认识的一律返回 null**，绝不猜。
 *
 * 为什么宁可不认：这段文本会被拼进**发给网页模型的真实提示词**。
 * 猜错角色（把探索列说成主审）会让模型按错误的职责行事，而用户从界面上
 * 看不出这一轮到底告诉它什么——错的身份比没有身份危险得多。
 *
 * @param {unknown} raw 调用方给的 columnContext
 * @returns {{role:'explore'|'review', index:number, total:number, key:string, exploreRoot:string}|null}
 */
export function normalizeColumnContext(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const role = String(raw.role ?? '').trim();
  if (!COLUMN_ROLES.includes(role)) return null;
  // 0.19.23：**两个**路径片段都净化后再拼目录。
  //
  // `scope` 是会话作用域（客户端传 `sessionId`）。加它的原因是一个**真缺陷**：
  // 上一版的目录只用 `col.key`，而列键是固定的 `c1`/`c2`/`c3`（见 client.cjs 的
  // 初始列状态）——于是**两个不同的 DSH 会话**里，第 2 列都会写
  // `.hwb/cols/c2/`，彼此的方案草稿互相覆盖。而并列探索的整个意义就是
  // 「互不影响」，目录撞车正好把它破坏掉。
  //
  // 用 `scope` 而不是 `sessionKey`：sessionKey 里含站点名，会随「用户改了这一列
  // 的站点」而变；而改站点时该列的 messages 本就被清空（见 setColSite），
  // 所以产物目录跟着换是**正确**语义。scope 只在换 DSH 会话时变，正是我们要的粒度。
  const scope = safePathSegment(raw.scope, 24);
  const bare = safePathSegment(raw.key, 24);
  // 两个片段都拿不到就退回 null：宁可不给目录，也不要给一个所有列共用的 `.hwb/cols/`。
  const key = [scope, bare].filter(Boolean).join('-');
  if (!key) return null;
  const index = Number(raw.index);
  const total = Number(raw.total);
  return {
    role,
    key,
    index: Number.isFinite(index) && index > 0 ? Math.trunc(index) : 0,
    total: Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0,
    exploreRoot: EXPLORE_ROOT,
  };
}

/**
 * 把列身份渲染成**一段提示词**（纯函数，可离线逐字断言）。
 *
 * 三条写作纪律：
 *   · **短**：这段文本**每一轮**都随请求下发（客户端 `sendCol` 每轮带
 *     `columnContext`；理由是「这一列是哪一列」每轮都成立，只在首轮发会让模型
 *     在长会话里逐渐忘记角色，那正是三列开始互相踩的起点）。
 *     实测 explore 220 字符 / review 225 字符，因此控制在十来行以内，
 *     且**不复述工具协议**（那是首轮教学的事，两者会打架）；
 *   · **可执行**：给的是路径与动作，不是「请注意隔离」这类无法落地的要求；
 *   · **不撒谎**：明确写出「这是约定不是强制」——模型与用户都不该以为
 *     主工作树真的写不进去。
 *
 * @param {object|null} ctx 已归一化的列身份（`normalizeColumnContext` 的返回值）
 * @returns {string} 待拼进提示词的文本；ctx 为 null 时返回空串
 */
export function columnGuidance(ctx) {
  if (!ctx) return '';
  const head = '【并列多会话' + (ctx.total > 0 && ctx.index > 0 ? ` 第 ${ctx.index}/${ctx.total} 列` : '')
    + ' · 角色：' + (ctx.role === 'review' ? '主审' : '探索') + '】';
  const dir = ctx.key ? `${ctx.exploreRoot}/${ctx.key}/` : `${ctx.exploreRoot}/`;
  const body = ctx.role === 'review'
    ? [
      '你是本组并列会话的**主审列**：其余列是各自独立的探索列。',
      '你的职责是汇总与审查它们的产出，给出统一结论、指出彼此冲突之处，并说明你采信哪一条、为什么。',
      '探索列的结论会以「引用会话内容」的形式交给你；若某列尚未交来，就说缺少哪一列的证据，不要替它臆测。',
    ]
    : [
      '你是本组并列会话的**探索列**：与其它列各自独立、互不等待。',
      `你的产出请写入 \`${dir}\`（工作区内该目录归本列使用），**不要直接修改主工作树**。`,
      '需要引用别的列的结论时，请明确写出它来自哪一列；你不需要与它们保持一致。',
    ];
  const tail = '（说明：以上是并列会话之间的**工作区约定**，用于让各列互不踩踏；'
    + '它不是强制隔离——真正的文件权限仍由 Harness 的工具权限与审批决定。）';
  return [head, ...body, tail].join('\n');
}

/**
 * 把列身份拼进本轮提示词。
 *
 * 与 `web-control.js` 里引用片段的拼装**同形**（都返回「可直接发送的字符串」），
 * 理由一致：拼装只写一处，`sendTurn` 只收最终文本。
 *
 * @param {string} prompt 用户本轮的原文
 * @param {unknown} rawCtx 调用方给的 columnContext（未归一化）
 * @returns {string} 拼好的提示词；无有效列身份时**逐字返回原文**
 */
export function withColumnGuidance(prompt, rawCtx) {
  const g = columnGuidance(normalizeColumnContext(rawCtx));
  if (!g) return prompt;
  return g + '\n\n' + prompt;
}
