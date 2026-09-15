// contract.js — 各内容服务的网页契约集中维护。
//
// DOM 选择器、模型目录、SSE 端点、解码器种类、请求元数据键等升级点全部收口到这里。
// 网页改版时只需更新 providers.js / 本文件，并在发版前运行 `pnpm doctor`。
// DeepSeek 契约：strictModelType 仍为真，核验口径按 UI 代际取值——旧三 pill UI 看
// model_type，2026-09-10 新版统一 UI 看 thinking_enabled（见 expectedRequestMetadata）；
// 其余站点为通用契约（标签点击选模型 + 通用解码器），实验性站点标记 experimental。
import { DEEPSEEK, SITES, resolveWebModel, getSite, conversationIdFromUrl, conversationUrlFor } from './providers.js';
import { expectedModelType, expectedRequestMetadata } from './metrics.js';

export const DEEPSEEK_WEB_CONTRACT = Object.freeze({
  siteOrigin: DEEPSEEK.origin,
  completionPath: DEEPSEEK.completionPaths[0],
  completionPaths: DEEPSEEK.completionPaths,
  inputSelector: DEEPSEEK.input,
  sendButtonSelector: DEEPSEEK.sendButton,
  stopButtonSelector: DEEPSEEK.stopButton,
  attachSelector: DEEPSEEK.attachSelector,
  attachPreviewSelector: DEEPSEEK.attachPreview,
  decoder: DEEPSEEK.decoder,
  searchTogglePattern: /^(智能搜索|联网搜索|Search)$/,
  requestMetadataKeys: ['model_type', 'thinking_enabled', 'search_enabled'],
  strictModelType: true,
  expectedModelType: (modelId, ui = 'classic') => expectedModelType(resolveWebModel(modelId).id, ui),
  // 发送后核验「网页真的用了所选模式」：classic 看 model_type（default/expert/vision），
  // unified 看 thinking_enabled（model_type 恒为 default，probe-19/20 实测）。
  expectedRequestMetadata: (modelId, opts) => expectedRequestMetadata(resolveWebModel(modelId).id, opts),
});

function genericContract(st) {
  return Object.freeze({
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
    searchTogglePattern: null,
    requestMetadataKeys: [],
    strictModelType: false,
    expectedModelType: () => null,
    experimental: Boolean(st.experimental),
  });
}

export const SITE_CONTRACTS = Object.freeze(
  Object.fromEntries(SITES.map((s) => [s.id, s.id === 'deepseek' ? DEEPSEEK_WEB_CONTRACT : genericContract(s)])),
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

export { DEEPSEEK, SITES, resolveWebModel, getSite, expectedModelType, expectedRequestMetadata, conversationIdFromUrl, conversationUrlFor };
