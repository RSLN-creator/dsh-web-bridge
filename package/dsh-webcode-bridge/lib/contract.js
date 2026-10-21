// contract.js — 各内容服务的网页契约集中维护。
//
// DOM 选择器、模型目录、SSE 端点、解码器种类、请求元数据键等升级点全部收口到这里。
// 网页改版时只需更新 providers.js / 本文件，并在发版前运行 `pnpm doctor`。
// DeepSeek 契约：strictModelType 仍为真，核验口径按 UI 代际取值——旧三 pill UI 看
// model_type，2026-09-10 新版统一 UI 看 thinking_enabled（见 expectedRequestMetadata）；
// 其余站点为通用契约（标签点击选模型 + 通用解码器），实验性站点标记 experimental。
import { DEEPSEEK, SITES, resolveWebModel, getSite, conversationIdFromUrl, conversationUrlFor } from './providers.js';
import { expectedModelType, expectedRequestMetadata } from './metrics.js';

/**
 * DeepSeek 的网页契约。
 *
 * ## 0.22.2（DeepSeek 试点第一步）：这里只写「独有知识」，不再手抄第二份选择器
 *
 * 本对象此前是 **14 个键手写一遍**，其中 **9 个是 `DEEPSEEK.*` 的逐字照抄**
 * （`siteOrigin←origin` / `completionPath←completionPaths[0]` / `inputSelector←input` /
 *  `sendButtonSelector←sendButton` / `stopButtonSelector←stopButton` /
 *  `attachSelector` / `attachPreviewSelector←attachPreview` / `completionPaths` / `decoder`）。
 *
 * 那不是「集中维护」，那是**同一份信息写两遍**——`doc/CODE-STRUCTURE.md` 里记的
 * 「修一处忘两处」正是这一类；`browser-driver.js` 里曾有三份逐字相同的
 * `ANSWER_SELECTOR` 字面量，代价是判据用的节点与兜底交出去的节点不是同一个。
 *
 * 现在改成：**`providers.js` 的站点声明是唯一真源**，本对象只保留
 * 「站点声明里没有、又确实只有 DeepSeek 有」的 5 类知识：
 *
 * | 键 | 为什么必须留在这里（不能从 site 派生） |
 * | --- | --- |
 * | `searchTogglePattern` | 网页控件**文本**的匹配式（`智能搜索/联网搜索/Search`），不是选择器 |
 * | `requestMetadataKeys` | 发送后要核验的请求体元数据键，属于「怎么验」而非「站点长什么样」 |
 * | `strictModelType` | 本仓库红线 1 的开关：站点元数据与所选模式不符必须报错 |
 * | `expectedModelType` / `expectedRequestMetadata` | 两个判据函数，按 UI 代际取期望值 |
 *
 * 判据（改这里的唯一标准）：**凡是能从 `DEEPSEEK` 读到的，就不要在这里再写一份**。
 * 派生关系见下方 `deriveContractFromSite`，它对 10 个站点一视同仁。
 */
const DEEPSEEK_ONLY = Object.freeze({
  searchTogglePattern: /^(智能搜索|联网搜索|Search)$/,
  requestMetadataKeys: ['model_type', 'thinking_enabled', 'search_enabled'],
  strictModelType: true,
  expectedModelType: (modelId, ui = 'classic') => expectedModelType(resolveWebModel(modelId).id, ui),
  // 发送后核验「网页真的用了所选模式」：classic 看 model_type（default/expert/vision），
  // unified 看 thinking_enabled（model_type 恒为 default，probe-19/20 实测）。
  expectedRequestMetadata: (modelId, opts) => expectedRequestMetadata(resolveWebModel(modelId).id, opts),
});

/**
 * 从站点声明派生契约里那 9 个「形状」字段——**单一取法，各站点共用**。
 *
 * 这是 0.22.2 试点要验的那件事：站点之间的差异应该只有**数据**（声明里有什么），
 * 而不是**又一段代码**（再手写一遍同名字段）。派生是纯字段改名，没有逻辑分支，
 * 因此 `provider-surface.test.mjs` 钉住的对外面逐字不变。
 *
 * ## 一条必须守住的等价性（本轮踩到的真问题，写下来免得下一个人重踩）
 *
 * 「键存在但值为 undefined」与「键根本不存在」**在 `Object.keys()` 上不同**；
 * 更麻烦的是：**同一个派生函数不能同时服务两种历史形状**。
 *
 * 实测（0.22.2 第一版）：把「可选字段只在声明时出现」这条规则套到**所有站点**上，
 * DeepSeek 完全等价，但**其余 8 站不等价** —— 通用契约历来**无条件**带
 * `answerSelector` 与 `experimental`（哪怕值是 null/false），收窄它们等于改变了
 * 对外面。`provider-surface.test.mjs` 存在的意义正是钉住这个面。
 *
 * 因此本函数带一个开关：
 *   · `alwaysOptionals: true`（通用契约，即历史行为）→ 可选键**恒在**；
 *   · `alwaysOptionals: false`（DeepSeek）→ 可选键**只在声明里有时才出现**
 *     （DeepSeek 契约历史上就没有这两键，多出来就是漂移）。
 *
 * 这就是「只动 DeepSeek」这条试点纪律在代码里的落点：**没有顺手动别人的形状**。
 *
 * @param {object} st 站点声明（`providers.js` 的 SITE 或 `lib/sites/<id>.js` 的导出）
 * @param {object} [extra] 该站点独有的其余契约字段（DeepSeek 用 DEEPSEEK_ONLY）
 * @param {object} [opts]
 * @param {boolean} [opts.alwaysOptionals=false] 可选键是否恒在（默认否，按声明）
 * @returns {object} 冻结后的契约
 */
function deriveContractFromSite(st, extra = {}, { alwaysOptionals = false } = {}) {
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
    // 默认值：通用契约的基线；DeepSeek 这类站点在 extra 里覆盖。
    searchTogglePattern: null,
    requestMetadataKeys: [],
    strictModelType: false,
    expectedModelType: () => null,
  };

  // 可选字段（0.19.19 的 answerSelector / 站点 experimental 标记）。
  // 出现规则见函数头「一条必须守住的等价性」——两种历史形状都要逐字保住。
  if (alwaysOptionals || st.answerSelector !== undefined) {
    base.answerSelector = st.answerSelector ?? null;
  }
  if (alwaysOptionals || st.experimental !== undefined) {
    base.experimental = Boolean(st.experimental);
  }

  // 站点独有知识（最后铺开，允许覆盖上面的默认值）。
  return Object.freeze({ ...base, ...extra });
}

/** DeepSeek 契约：9 项形状字段派生自 `DEEPSEEK`，5 项独有知识在这里声明。 */
export const DEEPSEEK_WEB_CONTRACT = deriveContractFromSite(DEEPSEEK, DEEPSEEK_ONLY);

/**
 * 通用契约：**保持历史形状**（可选键恒在）。
 *
 * 0.22.2 没有改动任何一个非 DeepSeek 站点的对外形状——这是「只动 DeepSeek」
 * 这条试点纪律的直接后果，也是 `provider-surface.test.mjs` 能继续绿的原因。
 */
function genericContract(st) {
  return deriveContractFromSite(st, {}, { alwaysOptionals: true });
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
