// contract.js — stable runtime contract projection for all website adapters.
//
// Each adapter owns verified website-specific facts. This module maps those facts into the
// shared driver contract while preserving the historical shape of every site's public record.
// Site changes belong in lib/sites/<siteId>.js; shared algorithms stay here and in the driver.
import { DEEPSEEK, SITES, resolveWebModel, getSite, conversationIdFromUrl, conversationUrlFor } from './providers.js';
import { expectedModelType, expectedRequestMetadata } from './metrics.js';


/**
 * Project one adapter into the stable browser-driver contract.
 *
 * Adapters own verified site-specific facts such as search controls and strict request-metadata
 * verification. This module supplies shared defaults and compatibility behavior only; it must
 * never branch on a website ID.
 *
 * Generic adapters retain the historic optional keys (answerSelector and experimental) even
 * when their values are null/false. An adapter may set contract.alwaysOptionals=false only when
 * its established contract intentionally omitted those keys; this preserves DeepSeek's old shape.
 *
 * @param {object} st Site adapter declaration
 * @returns {object} Frozen browser-driver contract
 */
function deriveContractFromSite(st) {
  const siteContract = st.contract || {};
  // Generic adapters preserve the established optional-key shape by default.
  const alwaysOptionals = siteContract.alwaysOptionals !== false;
  // 必填字段：每个站点都有（providers.js 的 SITE 形状保证了这一点）。
  const base = {
    siteOrigin: st.origin,
    completionPath: st.completionPaths[0] ?? null,
    completionPaths: st.completionPaths,
    inputSelector: st.input,
    sendButtonSelector: st.sendButton ?? null,
    stopButtonSelector: st.stopButton ?? null,
    attachSelector: st.attachSelector ?? "input[type='file']",
    // 附件「已进网页」的可见证据。上传后必须看到其中一个才算成功——否则
    // setInputFiles 只改了一个隐藏 input 的 files，网页未必真的收下了
    //（0.12.9 之前固定 waitForTimeout(500) 就当成功，这正是「有图说没图」
    // 的链路：桥以为传完了，网页端其实一个附件都没有）。
    attachPreviewSelector: st.attachPreview ?? null,
    decoder: st.decoder,
    // Verified site-specific request behavior is data on the adapter, not an ID branch.
    searchTogglePattern: siteContract.searchTogglePattern ?? null,
    requestMetadataKeys: siteContract.requestMetadataKeys ?? [],
    strictModelType: siteContract.strictModelType === true,
    expectedModelType: siteContract.strictModelType === true
      ? (modelId, ui = 'classic') => expectedModelType(resolveWebModel(modelId).id, ui)
      : () => null,
    ...(siteContract.strictModelType === true ? {
      expectedRequestMetadata: (modelId, opts) => expectedRequestMetadata(resolveWebModel(modelId).id, opts),
    } : {}),
  };

  // 可选字段（0.19.19 的 answerSelector / 站点 experimental 标记）。
  // 出现规则见函数头「一条必须守住的等价性」——两种历史形状都要逐字保住。
  if (alwaysOptionals || st.answerSelector !== undefined) {
    base.answerSelector = st.answerSelector ?? null;
  }
  if (alwaysOptionals || st.experimental !== undefined) {
    base.experimental = Boolean(st.experimental);
  }

  return Object.freeze(base);
}

/** Retain the named DeepSeek export for existing imports; its facts now live on the adapter. */
export const DEEPSEEK_WEB_CONTRACT = deriveContractFromSite(DEEPSEEK);

export const SITE_CONTRACTS = Object.freeze(
  Object.fromEntries(SITES.map((site) => [site.id, deriveContractFromSite(site)])),
);

/**
 * 取某站点的会话导航契约（三态）。
 *
 * 这是驱动侧**唯一**的会话地址知识入口：驱动不该自己写死「会话 id 在 URL 的哪一段」，
 * 否则站点改版时要改的地方会散落各处。认不出站点返回 `null`（= 没有契约），
 * 由调用方决定回落策略，而不是在这里给一个「差不多」的默认契约——错的契约
 * 比没有契约更难排查（它会静默指向错误会话）。
 *
 * @param {string} siteId 站点 id
 * @returns {object|null} 该站点的契约，未登记时为 null
 */
export function getContract(siteId) {
  return SITE_CONTRACTS[siteId] ?? null;
}

/**
 * 会话导航契约的三态（C-2）—— 驱动**唯一**的会话地址知识入口。
 *
 * 旧实现把 DeepSeek 的两种地址形状写死在浏览器驱动里，GLM/Z.ai 因此永远拿不到
 * 会话 id（真机 2026-09-14：`?cid=` 就在地址栏里，却没人读）。现在形状收口在
 * providers.js 的两张表，这里只负责把「这一轮该怎么走」判成三态：
 *
 *   fresh        — 开新会话（首轮，或上层明确要求重开）
 *   resume       — 站点声明了地址形状，导航回既有会话
 *   unsupported  — 站点没有可用形状：**必须报错**，绝不默默开新会话发增量
 *
 * @param {object} o
 * @param {string} o.siteId
 * @param {string} o.origin          站点根（如 https://chatglm.cn）
 * @param {boolean} o.fresh           上层是否要求新会话
 * @param {string|null} o.sessionId   会话槽里记着的网页会话 id
 * @returns {{state:'fresh'|'resume'|'unsupported', url:string|null, reason:string|null}}
 */
export function conversationNav({ siteId, origin, fresh, sessionId } = {}) {
  if (fresh) return { state: 'fresh', url: null, reason: 'caller-requested-fresh' };
  if (!sessionId) return { state: 'unsupported', url: null, reason: 'no-stored-session' };
  const url = conversationUrlFor(siteId, origin, sessionId);
  if (!url) return { state: 'unsupported', url: null, reason: 'site-has-no-conversation-url-shape' };
  return { state: 'resume', url, reason: null };
}

/**
 * 「落地 URL 会话锚」：没有地址形状的站点，页面**此刻**是否还停在上一轮落地的
 * 那条会话上（0.19.52，任务书「一 DSH 会话 = 一网页会话，后续也保证同一会话」）。
 *
 * ## 为什么需要它（真机读数，2026-09-30）
 *
 * `CONVERSATION_URL_SHAPES/BUILDERS` 只有 deepseek/glm/kimi 三家。其余七站
 * （zai/doubao/qwen/chatgpt/grok/claude/gemini）没有「由 id 构造地址」的能力 ⇒
 * `conversationNav` 对它们恒回 `unsupported` ⇒ 每一轮非 fresh 都 WEB_SESSION_LOST
 * → 上层整段重放 → **每轮新开一个网页对话**（真机读数：`webcode-sessions-zai.json`
 * 与 `-doubao.json` 均为 2 字节的空对象——从未存下过任何映射）。用户报的
 * 「所有网站切换新会话、对话条目每天异常多」正是这一族。
 *
 * 修法不是给它们编形状（z.ai 的 `/c/<uuid>` 实测 goto 会被弹回根地址——导航
 * 不回去），而是**锚住页面本身**：只要页面从上一轮落地起就没被导航走，它就
 * 仍在那条会话上——不需要导航，直接续聊即可。
 *
 * ## 判据（全部来自入参，纯函数可离线断言）
 *
 *   · `origin` 相同（同源才可能是同一会话）；
 *   · `currentUrl` 与 `landedUrl` 的 **pathname 相同**（query 漂移容忍：kimi 会
 *     自己补 `?chat_enter_method=…`，glm 会补 `?lang=zh`——按整串比会误判离开）；
 *   · 该 pathname **不是站点根**（`freshPath`，即 `new URL(cfg.site).pathname`）：
 *     根路径不携带会话身份，把根当锚会让「手动回了首页」被误判成「还在原会话」，
 *     把增量发进一个新开的空对话——正是三条不可越界约束里「绝不静默丢上下文」
 *     要防的那件事。
 *
 * @param {object} o
 * @param {string} o.origin          站点根（如 https://chat.z.ai）
 * @param {string} o.freshPath       开新会话的 pathname（cfg.site 的 pathname）
 * @param {string} o.currentUrl      页面此刻的地址
 * @param {string|null} o.landedUrl  上一轮落地时记录的地址（无记录为 null）
 * @returns {boolean} 页面仍停在那条会话上（true = 可以原地续聊，不导航）
 */
export function conversationStay({ origin, freshPath, currentUrl, landedUrl } = {}) {
  if (!origin || !currentUrl || !landedUrl) return false;
  let cur, landed;
  try { cur = new URL(currentUrl); landed = new URL(landedUrl); } catch { return false; }
  let root;
  try { root = new URL(origin); } catch { return false; }
  if (cur.origin !== root.origin || landed.origin !== root.origin) return false;
  if (cur.pathname !== landed.pathname) return false;
  const fresh = String(freshPath || '/');
  return landed.pathname !== fresh && landed.pathname !== '/';
}

export { DEEPSEEK, SITES, resolveWebModel, getSite, expectedModelType, expectedRequestMetadata, conversationIdFromUrl, conversationUrlFor };
