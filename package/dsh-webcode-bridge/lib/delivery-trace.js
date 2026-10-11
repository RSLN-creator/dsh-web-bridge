// delivery-trace.js — 交付链**逐层**取证：网页捕获 → 解码器 → 驱动 → relay → 适配器。
//
// ## 为什么需要它（复审意见，0.19.75）
//
// 0.19.74 修掉了两个看门狗缺陷（相位冻结、deadline 锚错起点），但**没有**回答
// Issue #1 的另一半：现场里「页面已有 2172 字回复未回传」，那 2172 字究竟丢在哪一层？
//
// 关键区分（复审明确指出）：
//   · `lastEventAt` 只在**适配器收到流事件**时推进；它变新 ⇒ 链路是活的；
//   · 而读取 `domReplyChars` / `lastActivityAt` 只是**诊断读数**——它们**不会**
//     把页面 DOM 里的正文重新送进流。所以看门狗计时修好，也不会把卡在 DOM 里的
//     正文补回来。
//
// 也就是说「看门狗不再误杀」与「内容是否完整交付」是**两件事**，必须分别取证。
// 本模块给前者之外的后者提供可复核读数：沿链路各层记
// **事件数 / 字符数 / 首末时刻 / 内容哈希**，于是分叉能被**定位到层**，而不是
// 只看到「适配器零事件」这一个末梢症状。
//
// ## 为什么记哈希而不是留原文
//
// 原文是用户对话内容，不该为了排障默认落盘（本仓库对「不默认持久化敏感原文」有纪律）。
// 所以每层只累计：长度 + 增量哈希（`crypto` 流式 update，不保留全文）。
// 需要看原文时由调用方显式打开 sample 模式，且只留前 N 字符。
//
// ## 判据是纯函数
//
// `compareStages()` 不读时钟、不碰浏览器 ⇒ 可离线反向验证
//（护栏 `test/delivery-trace.test.mjs`）。**关键**：它能区分
//   「某层根本没有事件」（事件数为 0 ⇒ 丢在**这一层或它之前**）
// 与「某层有事件但内容更短」（长度对不上 ⇒ 丢在**这一层**）。
// 只报「适配器 0 事件」是末梢症状，分不出这两者。
import { createHash } from 'node:crypto';

/** 链路的五个阶段，**顺序即数据流方向**（前者是后者的上游）。 */
export const STAGES = Object.freeze(['capture', 'decoder', 'driver', 'relay', 'adapter']);

/**
 * **哪些阶段的字符数可以逐层相比**。
 *
 * `capture` 是**原始上线帧**（SSE / Connect-RPC 的 JSON 原文，含字段名、转义、
 * 分帧头），而 `decoder` 之后才是**解出来的正文**。两者的字符数**本来就不该相等**：
 * 原始帧必然比正文长得多。
 *
 * 因此 `capture → decoder` 这一段**不能**套用「下游更短 ⇒ 丢在本层」的判据——
 * 那会让每一轮正常生成都被报成分叉（工具天天喊狼来了，很快就会没人看它）。
 * 这一段唯一有意义的判据是：**捕获有帧、解码器却零正文** ⇒ 解码器没解出东西
 * （真机形态：站点换帧格式，捕获链活着但正文一个字符都出不来）。
 *
 * `decoder → driver → relay → adapter` 四层承载的是**同一份正文文本**，
 * 长度必须一致，可以逐层比。
 */
export const TEXT_STAGES = Object.freeze(['decoder', 'driver', 'relay', 'adapter']);

/** 每个阶段的中文名（报错/读数用，避免下游各写一份）。 */
export const STAGE_LABEL = Object.freeze({
  capture: '网页捕获',
  decoder: '解码器',
  driver: '驱动',
  relay: 'relay',
  adapter: '适配器流',
});

/** 一条最小可读的「交付链读数」：计数 + 长度 + 时刻 + 哈希，不含原文。 */
function emptyStage() {
  return { events: 0, chars: 0, firstAt: null, lastAt: null, hash: null, sha: createHash('sha256'), sampled: '' };
}

/**
 * 交付链取证器。一轮一个实例（**不要**跨轮复用：跨轮复用正是本仓库记过的
 * 「旧读数冒充本轮」那一类缺陷的来源）。
 *
 * @param {{sampleChars?:number, enabled?:boolean}} [opts] sampleChars>0 时额外保留
 *   每层前 N 字符（默认 0 = 不留原文）
 */
export function createDeliveryTrace(opts = {}) {
  const sampleChars = Math.max(0, Number(opts.sampleChars) || 0);
  const enabled = opts.enabled !== false;
  const stages = {};
  for (const s of STAGES) stages[s] = emptyStage();

  /**
   * 记一次事件。`text` 是**该阶段**看到的内容（没有内容的事件，如 status 帧，
   * 传空串——它仍会 +1 事件数，但不加字符）。
   *
   * @param {string} stage STAGES 之一
   * @param {string} [text]
   * @param {number} [at] 事件时刻（epoch ms）；缺省取 Date.now()
   */
  function note(stage, text = '', at = null) {
    if (!enabled) return;
    const st = stages[stage];
    if (!st) return;                        // 未知阶段：静默忽略，绝不猜一个新桶
    const s = String(text ?? '');
    const t = Number.isFinite(Number(at)) ? Number(at) : Date.now();
    st.events += 1;
    st.chars += s.length;
    if (st.firstAt == null) st.firstAt = t;
    st.lastAt = t;
    if (s) {
      st.sha.update(s, 'utf8');
      if (sampleChars > 0 && st.sampled.length < sampleChars) {
        st.sampled += s.slice(0, sampleChars - st.sampled.length);
      }
    }
  }

  /** 冻结读数（哈希在**这一刻**定值；之后再 note 也不会改变已返回的快照）。 */
  function snapshot() {
    const out = {};
    for (const s of STAGES) {
      const st = stages[s];
      out[s] = {
        events: st.events,
        chars: st.chars,
        firstAt: st.firstAt,
        lastAt: st.lastAt,
        // 没有事件时哈希为 null（**不是**空串的哈希）：空串哈希会被误读成
        // 「这一层确实送来了一个空内容」，两者含义完全不同。
        hash: st.events > 0 ? st.sha.copy().digest('hex').slice(0, 16) : null,
        ...(sampleChars > 0 ? { sample: st.sampled } : {}),
      };
    }
    return out;
  }

  return { note, snapshot, enabled, sampleChars };
}

/**
 * 逐层比对，找出**内容在哪一层开始变少**（纯函数，可离线反向验证）。
 *
 * 判定顺序（每一层与它的**上游**比）：
 *   1. 上游有事件、本层 0 事件              ⇒ 丢在「上游→本层」这一段（本层没收到）
 *   2. 上游有事件、本层事件>0 但字符更少      ⇒ 丢在**本层**（收到了但少）
 *   3. 上游 0 事件、本层 0 事件              ⇒ 这一段无数据，**不算分叉**（未验证）
 *
 * 为什么必须区分 1 与 2：两者的下一步完全不同——(1) 要查上游的发送/绑定，
 * (2) 要查本层的解析/过滤。只报一句「适配器零事件」等于把这两种混成一种。
 *
 * @param {object} snap `snapshot()` 的返回值
 * @returns {{diverged:boolean, firstLossAt:string|null, detail:string, stages:object}}
 */
export function compareStages(snap) {
  const stages = snap || {};
  const order = STAGES;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  let firstLossAt = null;
  const notes = [];

  // ── 先单独判 capture→decoder：原始帧与正文长度**不可比**（见 TEXT_STAGES）──
  {
    const cap = stages.capture || {};
    const dec = stages.decoder || {};
    const capEvents = num(cap.events);
    const capChars = num(cap.chars);
    const decEvents = num(dec.events);
    const decChars = num(dec.chars);
    if (capEvents > 0 && decEvents === 0) {
      // 这一格是真缺陷：捕获链有帧，解码器一个正文字符都没吐出来。
      firstLossAt = 'decoder';
      notes.push(`${STAGE_LABEL.capture}有 ${capEvents} 帧（${capChars} 字原始帧），`
        + `但${STAGE_LABEL.decoder}**零正文** ⇒ 帧没被解成正文（不是「长度对不上」）`);
    } else if (capEvents > 0 && decEvents > 0) {
      notes.push(`${STAGE_LABEL.capture} ${capEvents} 帧（${capChars} 字原始帧）→ `
        + `${STAGE_LABEL.decoder} ${decChars} 字正文`
        + '（原始帧含字段名与转义，长度与正文不可比——只比「有没有解出正文」）');
    } else if (capEvents === 0 && decEvents > 0) {
      notes.push(`${STAGE_LABEL.capture}零帧，但${STAGE_LABEL.decoder}有 ${decChars} 字正文`
        + '（正文来自这一层自己的收尾路径，不是增量通道）');
    } else {
      notes.push(`${STAGE_LABEL.capture}→${STAGE_LABEL.decoder}：两侧都无事件（这一段未验证）`);
    }
  }

  // ── 正文四层（decoder→driver→relay→adapter）：逐层比长度 ──────────────────
  const textOrder = TEXT_STAGES;
  for (let i = 1; i < textOrder.length; i += 1) {
    const up = textOrder[i - 1];
    const cur = textOrder[i];
    const u = stages[up] || {};
    const c = stages[cur] || {};
    const ue = num(u.events);
    const ce = num(c.events);
    const uc = num(u.chars);
    const cc = num(c.chars);
    if (ue === 0 && ce === 0) {
      notes.push(`${STAGE_LABEL[up]}→${STAGE_LABEL[cur]}：两侧都无事件（这一段未验证）`);
      continue;
    }
    if (ue > 0 && ce === 0) {
      if (!firstLossAt) firstLossAt = cur;
      notes.push(`${STAGE_LABEL[up]}有 ${ue} 事件 / ${uc} 字，但${STAGE_LABEL[cur]}**零事件**`
        + ` ⇒ 丢在「${STAGE_LABEL[up]}→${STAGE_LABEL[cur]}」这一段`);
      continue;
    }
    if (ue > 0 && cc < uc) {
      if (!firstLossAt) firstLossAt = cur;
      notes.push(`${STAGE_LABEL[up]} ${uc} 字 → ${STAGE_LABEL[cur]} ${cc} 字`
        + ` ⇒ 丢在${STAGE_LABEL[cur]}（收到了但更少）`);
      continue;
    }
    notes.push(`${STAGE_LABEL[up]}→${STAGE_LABEL[cur]}：${uc} 字 → ${cc} 字，无分叉`);
  }

  // 正文层里「上游 0、本层 >0」也记一笔（同上：内容不是经增量通道来的）。
  for (let i = 1; i < textOrder.length; i += 1) {
    const up = textOrder[i - 1];
    const cur = textOrder[i];
    const u = stages[up] || {};
    const c = stages[cur] || {};
    if (num(u.events) === 0 && num(c.events) > 0) {
      notes.push(`${STAGE_LABEL[up]}零事件，但${STAGE_LABEL[cur]}有 ${num(c.events)} 事件`
        + ` / ${num(c.chars)} 字（内容来自这一层自己的收尾路径，不是增量通道）`);
    }
  }

  return {
    diverged: Boolean(firstLossAt),
    firstLossAt,
    detail: notes.join('；'),
    stages,
  };
}