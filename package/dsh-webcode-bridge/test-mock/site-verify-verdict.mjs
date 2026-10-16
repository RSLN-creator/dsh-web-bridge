// site-verify-verdict.mjs — 站点验收的**判定规则**（纯函数，可离线反向验证）。
//
// ## 为什么把它从 site-verify.mjs 里抽出来
//
// 复审指出的第一个缺陷就是这个**判定形状**：旧收尾只问「有没有一项 FAIL」，
// 有就 FAIL、没有就 PASS（不复述那两行代码，免得它看起来像一段被注掉的实现）。
//
// ⇒ **只要没有明确 FAIL，站点整体就显示 PASS**，哪怕 `tool.callParsed` 与
// `turn.settled` 都是 `UNVERIFIED`（真实后果：一个站点**一条工具调用都没产出**，
// 照样被盖章 PASS）。这正是「验收工具自身假绿」。
//
// 判据必须能被**离线反向验证**（`test/site-verify-verdict.test.mjs`），
// 所以抽成不依赖浏览器、不读时钟的纯函数——与 lib/idle-window.js 同一条纪律。
//
// ## 四态与优先级（确定性，不留解释空间）
//
//   1. 有 `FAIL`              → `FAIL`        （真机复现了产品缺陷）
//   2. 有 `BLOCKED`           → `BLOCKED`     （登录/验证码/限流挡住，**不是**产品结论）
//   3. 有 `UNVERIFIED`        → `UNVERIFIED`  （必要项没验到 ⇒ 绝不当成通过）
//   4. 其余（全 PASS）         → `PASS`
//
// 为什么 `UNVERIFIED` 排在 `BLOCKED` 之后而不是之前：`BLOCKED` 的含义是
// 「这次根本没跑成」（连判定对象都没拿到），此时再报「有项未验证」只会掩盖
// 「外部条件挡住」这个更根本的结论；而两者都**不是** PASS，所以先后不影响安全侧。
//
// 为什么必须有 `required` 概念：一个站点可能**跳过**了整段检查（例如未登录时
// 只跑了 login 一项就返回）。那种情况下 checks 里可能一条 UNVERIFIED 都没有，
// 若只看「有没有 UNVERIFIED」就会因为**缺少**检查项而判 PASS。因此调用方必须
// 声明本次运行**应当出现**的必要检查项 id；缺任何一项 ⇒ `UNVERIFIED`。

/** 四种判定状态（顺序即优先级，前者覆盖后者）。 */
export const VERDICT_ORDER = Object.freeze(['FAIL', 'BLOCKED', 'UNVERIFIED', 'PASS']);

/**
 * 本轮运行**必须出现**的必要检查项。
 *
 * 声明在这里而不是散在调用点：少写一个 id 就等于给该类缺口开了后门，
 * 而这条清单本身有护栏钉住（测试会断言它与 site-verify.mjs 实际产生的 id 对齐）。
 */
export const REQUIRED_CHECKS = Object.freeze([
  'login.loggedIn',        // 登录判定给得出结论
  'login.basis',           // 登录**依据**（probe-fallback = 猜测 ⇒ 不确定，#53 三态）
  'login.verdictConsistent', // 登录判定与真实发送路径不矛盾
  'send.text',             // 真实发送成功
  'stream.fullText',       // 最终全文存在
  'stream.deltaReceived',  // **流式增量**真的到了（与全文分开，见下）
  'stream.consistency',    // 全文与增量一致（不一致要能指向分层定位）
  'tool.callParsed',       // 工具调用可解析
  'tool.resultRoundTrip',  // 工具结果真的回填进同一网页会话并拿到第二轮
  'turn.settled',          // 本轮有收束读数
]);

/**
 * 汇总一次站点验收的最终状态。
 *
 * @param {Array<{name:string, status:string, detail?:string}>} checks 逐项检查结果
 * @param {{required?:string[]}} [opts] 本轮应当出现的必要检查项 id（默认 REQUIRED_CHECKS）
 * @returns {{status:string, counts:object, missing:string[], reasons:string[]}}
 *          status 取 VERDICT_ORDER 中第一个成立的；missing = 声明了但没出现的必要项
 */
export function verdictOf(checks, opts = {}) {
  const list = Array.isArray(checks) ? checks : [];
  const required = Array.isArray(opts.required) ? opts.required : REQUIRED_CHECKS;
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, UNVERIFIED: 0 };
  const KNOWN = new Set(['PASS', 'FAIL', 'BLOCKED', 'UNVERIFIED']);
  for (const c of list) {
    const raw = String(c?.status || 'UNVERIFIED');
    // 未知状态码**折算**成 UNVERIFIED：宁可判「不确定」，也不让一个拼错的状态码
    // 悄悄落进「全 PASS」那一桶（这是本函数唯一允许的宽松方向）。
    //
    // ⚠ 首版只把 `counts[s]` 加一（于是出现 `TYPO_STATUS: 1` 这种桶），而下方
    // 只按 VERDICT_ORDER 里那四个键判 ⇒ **未知状态对判定完全不可见**、站点照样 PASS。
    // 护栏 ④ 当场抓出：`{7×PASS, 1×TYPO_STATUS}` 得到 `status: PASS`。
    const s = KNOWN.has(raw) ? raw : 'UNVERIFIED';
    counts[s] += 1;
  }
  const present = new Set(list.map((c) => String(c?.name || '')));
  const missing = required.filter((id) => !present.has(id));

  const reasons = [];
  if (counts.FAIL > 0) reasons.push(`有 ${counts.FAIL} 项 FAIL`);
  if (counts.BLOCKED > 0) reasons.push(`有 ${counts.BLOCKED} 项被外部条件挡住`);
  if (counts.UNVERIFIED > 0) reasons.push(`有 ${counts.UNVERIFIED} 项无法确定`);
  if (missing.length) reasons.push(`缺少必要检查项：${missing.join(', ')}`);

  // 缺项本身也算「不确定」——绝不能因为「没检查」而判 PASS。
  const effective = missing.length ? { ...counts, UNVERIFIED: (counts.UNVERIFIED || 0) + missing.length } : counts;
  let status = 'PASS';
  for (const s of VERDICT_ORDER) {
    if (s === 'PASS') { status = 'PASS'; break; }
    if ((effective[s] || 0) > 0) { status = s; break; }
  }
  return { status, counts: effective, missing, reasons };
}

/**
 * 「这两轮是不是同一个会话」——**两个判据取其一成立即算成立**（纯函数）。
 *
 * ## 为什么需要第二个判据（真机读数逼出来的）
 *
 * `sendTurn` 返回的 `sessionId` 来自 `turnSessionId(url) = conversationIdFromUrl(...)`，
 * 而**没有地址形状的站点**（zai / doubao / qwen…）地址里解不出 id ⇒ **恒为 `null`**。
 * 2026-10-16 真机（zai，三轮全程同一会话、工具闭环成立）实测三个 `sessionId` 全是
 * `null` ⇒ 若只认 `sessionId`，就会把「明明停在同一个网页会话上」记成 UNVERIFIED。
 * 上一轮 Phase 2 里 qwen 的 `tool.resultRoundTrip` 记 UNVERIFIED 正是同型成因。
 *
 * 0.19.52 起驱动为这类站点维护**落地地址锚**（槽里的 `landedUrl`），`sendTurn` 的
 * `conversationStay` 判据用的就是它，且**换会话会被判 `WEB_SESSION_LOST`**（红线 2）
 * ⇒ 它是可信的第二身份。
 *
 * ⚠ 两个判据**都拿不到**时才记 UNVERIFIED —— 那时确实没有证据，不许猜成通过；
 * 也**不许**因为「同一个 key 复用」就判成立：key 是 DSH 侧的槽名，网页会话是否真
 * 停在那一个，正是要验的东西（用 key 当证据等于把假设当结论）。
 *
 * @param {{kind:string, value:string|null}} a 第 N 轮的槽锚（来自 `driver.status().sessionSlot`）
 * @param {{kind:string, value:string|null}} b 第 N+1 轮的槽锚
 * @param {string|null} sidA 第 N 轮 `sendTurn` 返回的 sessionId
 * @param {string|null} sidB 第 N+1 轮 `sendTurn` 返回的 sessionId
 * @returns {{ok:boolean, basis:'sessionId'|'slot-anchor'|null, detail:string}}
 */
export function sameSessionVerdict(a, b, sidA, sidB) {
  if (sidA && sidB && String(sidA) === String(sidB)) {
    return { ok: true, basis: 'sessionId', detail: `sessionId 逐字相同（${String(sidA).slice(0, 24)}）` };
  }
  const ka = a && a.kind && a.kind !== 'none' ? String(a.value || '') : '';
  const kb = b && b.kind && b.kind !== 'none' ? String(b.value || '') : '';
  if (ka && kb && ka === kb) {
    return { ok: true, basis: 'slot-anchor', detail: `槽锚（${a.kind}）逐字相同（${ka.slice(0, 60)}）` };
  }
  return {
    ok: false, basis: null,
    detail: `两个判据都拿不到：sessionId ${sidA ?? 'null'} / ${sidB ?? 'null'}；`
      + `槽锚 ${a?.kind ?? '(无)'}=${ka ? ka.slice(0, 40) : '(空)'} → ${b?.kind ?? '(无)'}=${kb ? kb.slice(0, 40) : '(空)'}`,
  };
}

/**
 * 「全文」与「流式增量」必须**分开**判——这是复审指出的第三个缺陷。
 *
 * 旧写法是 `String(text || sent?.text || '')`：没有收到任何增量时，只要
 * `sendTurn` 返回对象里带正文，`body` 就非空 ⇒ `stream.body` 判 PASS。
 * 那会**掩盖 Issue #1 的核心症状**（页面有正文、流式交付链没送到）。
 *
 * 本函数把三件事拆开：
 *   ① 最终全文存在吗（`fullText`）
 *   ② 增量真的收到过吗（`deltaText`）
 *   ③ 两者是否一致（不一致要能说出「差在哪一层」）
 *
 * @param {{fullText?:string, deltaText?:string}} o
 * @returns {{fullTextOk:boolean, deltaOk:boolean, consistent:boolean,
 *            fullChars:number, deltaChars:number, note:string}}
 */
export function streamDeliveryVerdict({ fullText, deltaText } = {}) {
  const full = String(fullText ?? '');
  const delta = String(deltaText ?? '');
  const fullOk = full.trim().length > 0;
  const deltaOk = delta.trim().length > 0;
  const consistent = fullOk && deltaOk && full.trim() === delta.trim();
  let note;
  if (!fullOk && !deltaOk) note = '全文与增量都为空——网页没有产出正文';
  else if (!fullOk && deltaOk) note = '有增量但没有全文——权威回读缺失';
  else if (fullOk && !deltaOk) {
    // 这一格就是 Issue #1 的形状：页面/回读有正文，**流式链一个字都没送到**。
    note = `只有全文（${full.trim().length} 字）、流式增量为 0 —— 交付链没把正文送进适配器流`
      + '（页面有内容 ≠ 桥交付了内容）';
  } else if (!consistent) {
    note = `全文 ${full.trim().length} 字 / 增量 ${delta.trim().length} 字，两者不一致`
      + '——需按 capture → decoder → driver → relay → adapter 逐层比对，才能定位是哪一层丢的';
  } else note = `全文与增量一致（${full.trim().length} 字）`;
  return { fullTextOk: fullOk, deltaOk, consistent, fullChars: full.trim().length, deltaChars: delta.trim().length, note };
}