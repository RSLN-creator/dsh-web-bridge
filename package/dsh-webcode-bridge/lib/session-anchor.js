// session-anchor.js — 会话游标的内容锚定（0.16.28，修「每轮整段重建」风暴）。
//
// ## 为什么旧游标会失效（真机取证 session-4f236a51，2026-09-20 01:31）
//
// 旧实现把会话连续性押在一条**整段前缀指纹**上：fingerprint(sent) 对
// messages.slice(0, sent) 整体哈希。宿主（DSH）的 goal 自动化 / 信箱机制每个
// turn 开始把 `<goal_round>` 提示拼进数组**头部**（agent/inbox/spliced:
// start=0, inserted=1）、turn 结束再从头部移除（removed=1）——头部一有增删，
// 已发前缀的窗口内容整体位移，指纹必然失配 → 判 fresh → 每轮整段重建 +
// 新开网页对话（本会话 52 次 SESSION_SWITCHED、重建 245k→251k 字符逐轮膨胀）。
//
// ## 修法：锚定尾部，不锚定整体
//
// 网页会话里的真实前文只会**追加**，头部槽位是宿主内部的瞬态簿记。因此把
// 「已发前缀」的判定拆成两层：
//   · **契约指纹**（contractFingerprintOf）：模型 / 系统提示词 / 工具名集合 /
//     全局指令——任何一项变了，教学形态就变了，必须整段重建（与旧整体指纹
//     对这四项的语义逐字相同）；
//   · **内容锚**（tailHashes）：已发尾部 K 条消息的逐条哈希。指纹失配时不再
//     立刻判死，而是拿锚点序列在**新数组里从后往前**找一段连续匹配——找到
//     就把游标重定位到匹配段末尾（reanchorSent），照常在同一网页会话发增量；
//     找不到（尾部真被改写，如压缩摘要替换了尾部）才回落整段重建。
//
// 匹配段取「记录尾部的后缀」逐级缩短（s = K → 2）：头槽瞬态消息只占已发尾部
// 的**最后一两条**，短后缀匹配自然跳过它们。要求 s ≥ 2 并取**最后一次**出现，
// 把重复内容（同名工具结果等）误配到更旧位置的风险压到最低；即便误配到更旧
// 位置，增量只会把网页侧**已有**的内容再发一遍，语义无害。

import { createHash } from 'node:crypto';

/** 已发尾部保留锚点的条数。覆盖「头槽 1 条 + 最近一轮 assistant/tool 若干条」。 */
export const ANCHOR_LEN = 6;

/** 单条消息的稳定哈希（内容身份；键序变化即视为不同——与旧整体指纹同口径）。 */
export function messageHash(m) {
  return createHash('sha256').update(JSON.stringify(m)).digest('hex');
}

/**
 * 契约指纹：只锁「决定网页侧教学/协议形态」的四项。
 *
 * 从旧整体指纹里拆出来的部分。messages **不**参与——消息内容的变化归内容锚管，
 * 契约变化（换模型、系统提示词改写、工具集增减、全局指令修改）才要求整段重建。
 *
 * @param {{model?: string, system?: unknown, toolNameKey?: string, extraPrompt?: string, sitePrompt?: string}} parts
 * @returns {string} sha256 hex
 */
export function contractFingerprintOf(parts) {
  return createHash('sha256').update(JSON.stringify({
    model: parts.model ?? null,
    system: parts.system ?? null,
    tools: parts.toolNameKey ?? '',
    extraPrompt: parts.extraPrompt ?? '',
    // 站点专属指令（0.16.38）：与全局指令同一性质——它进的是网页侧的首轮正文，
    // 改了就必须整段重建（否则旧首轮里那一句永远留着，新的永远送不进去）。
    sitePrompt: parts.sitePrompt ?? '',
  })).digest('hex');
}

/**
 * 在新消息数组里重定位已发游标。
 *
 * @param {Array} msgs 本轮请求的完整消息数组
 * @param {string[]|undefined} tailHashes commit 时记录的已发尾部哈希（时间正序）
 * @param {(m: unknown) => string} [hash] 哈希函数（测试可注入等价实现）
 * @returns {{sent: number}|null} 重定位后的游标（= 匹配段末尾的下一位）；锚不
 *   可用或匹配不到 ≥2 的连续段时返回 null（调用方回落整段重建）。
 */
export function reanchorSent(msgs, tailHashes, hash = messageHash) {
  const tails = Array.isArray(tailHashes) ? tailHashes : [];
  if (tails.length < 2 || !Array.isArray(msgs) || msgs.length < 2) return null;
  const H = msgs.map(hash);
  // 逐条**丢弃尾部**再匹配（d = 0..len-2，段长 len-d ≥ 2）：瞬态头槽消息（goal
  // 提示等）恰好坐在已发尾部的**最后一条**，后缀匹配永远带着它、必然落空；
  // 从尾丢弃才能跳过它们、用剩余的持久段对齐。匹配取**最后一次**出现：
  // 重复内容场景下最新对齐才是真对齐。
  for (let d = 0; d <= tails.length - 2; d++) {
    const len = tails.length - d;
    for (let i = H.length - len; i >= 0; i--) {
      let ok = true;
      for (let k = 0; k < len; k++) {
        if (H[i + k] !== tails[k]) { ok = false; break; }
      }
      if (ok) return { sent: i + len };
    }
  }
  // len-2 锚的窄域救援：会话第 2 轮时锚只有 [持久, 瞬态] 两条，上面 ≥2 的连续段
  // 匹配必然落空。此时退到**单条**匹配持久那条（tails[0]，即首条消息）的最后
  // 一次出现——首条消息（任务指令）内容重复概率极低；即便错位，delta 顶多在
  // 一个 2 条消息的会话里少发/重发一条，代价有界。len ≥ 3 的会话不走这条路。
  if (tails.length === 2) {
    for (let i = H.length - 1; i >= 0; i--) {
      if (H[i] !== tails[0]) continue;
      if (i + 1 < H.length) return { sent: i + 1 };
      return null;
    }
  }
  return null;
}
