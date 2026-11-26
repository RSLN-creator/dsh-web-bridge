// providers.js — public provider/model projection over the per-site adapter registry.
// Website facts live in lib/sites/<siteId>.js; this module only applies shared model metadata
// and preserves the established provider/model surface.
//
// 未知模型必须拒绝（resolveWebModel throw），绝不允许静默回退默认模型。
// 网页改版核对入口：`pnpm doctor`（test-mock/real-verify.mjs）。

import { DEFAULT_SLOT, normalizeSlot, parseModelId, formatModelId, accountLabel } from './accounts.js';
import { thinkEffortFor } from './think-effort.js';
// 已迁移站点的声明表（0.19.50 起）：`lib/sites/<siteId>.js` 是站点知识的落点，
// 本模块保留**组装职责**（withEffort 摊平 + 冻结）。迁移是渐进的——
// 未迁移的站点仍内联在本文件里，见 lib/sites/index.js 的文件头。
import { SITE_MODULES } from './sites/index.js';

const site = (s) => Object.freeze(s);

/**
 * 把 think-effort.js 的站点声明摊进站点对象（`efforts` / `effortControl` 两个字段）。
 *
 * 为什么要有这个包装、而不是直接在站点里抄一份等级表：等级 id 是**网页菜单里的逐字文本**
 * （驱动按文本点），抄第二份必然在下次网页改版时漂移——本仓库的「工具协议只有一处定义」
 * 是同一类约束。因此声明只有 think-effort.js 一份，这里只做摊平。
 *
 * 摊平而不是嵌套 `effort: {...}`：驱动与控制面读 `site.effortControl` 时不必知道本模块的
 * 内部形状（与 `st.captchaSelector` / `st.answerSelector` 这些声明位保持一致）。
 *
 * @param {object} s 站点声明（`models` 之后调用）
 * @returns {object} 冻结后的站点对象（含 efforts / effortControl，未声明等级的站点两者都无）
 */
const withEffort = (s) => {
  const def = thinkEffortFor(s.id);
  return site({
    ...s,
    ...(def ? { efforts: def.efforts, ...(def.effortControl ? { effortControl: def.effortControl } : {}) } : {}),
  });
};

/**
 * 网页会话 URL 契约的三态（C-2）。
 *
 * 背景（真机 2026-09-14 取证）：驱动旧实现把「会话 id ↔ 地址」的知识硬编码成
 * DeepSeek 的两种形状（`?chat_session_id=<id>` 与 `/a/chat/s/<id>`），于是
 * **GLM 永远拿不到会话 id**：探针实录
 *   page.url() = https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=6aa6f08454b3a5a4e4f64a77
 *   result.sessionId = null → rememberConversation 从不执行 →
 *   webcode-sessions-glm.json 恒为 "{}"（deepseek 那份 6058 字节）
 * → 每一轮都 WEB_SESSION_LOST → 上层 fresh 重开 → 用户看到「同一会话却每轮新开对话」。
 *
 * 而 GLM 的 SSE 首帧里 `conversation_id` 与 URL 的 `cid` 是**同一个 24 位十六进制
 * 串**（6aa6f08454b3a5a4e4f64a77），即身份一直在，只是没人去读。
 *
 * 三态语义（驱动据此决定导航动作，**不允许静默降级**）：
 *   'fresh'       —— 开新会话（首轮，或上层明确要求重开）
 *   'resume'      —— 该站点声明了地址形状，可以直接导航回既有会话
 *   'unsupported' —— 站点没有可用的地址形状：**必须报错交给上层整段重建**，
 *                    绝不能默默开一个新会话并把增量发进去（那正是历史上
 *                    「跑着跑着变傻」的根因，见 browser-driver 的 WEB_SESSION_LOST）
 */
export const NAVIGATION_STATES = Object.freeze(['fresh', 'resume', 'unsupported']);

/**
 * 从**地址**解析既有网页会话（'resume' 那一态的地址形状），解析不到返回 null。
 *
 * 每个站点只声明**自己的**形状，驱动不再写死 DeepSeek 的两种。新增站点若地址栏
 * 里带会话 id，就在这里加一条；不带（例如只把 id 放在 SSE 帧里）就声明
 * `conversationIdFromStream: true` 并**不**在这里编一个形状出来——
 * 编形状的代价是导航到一个不存在的地址，比不支持更糟。
 */
/**
 * Read or rebuild a website conversation URL from that site's own adapter.
 * Sites without a verified URL shape return null and retain the explicit unsupported state.
 */
export function conversationIdFromUrl(siteId, url) {
  const parse = getSite(siteId)?.navigation?.fromUrl;
  if (typeof parse !== 'function') return null;
  let value;
  try { value = parse(new URL(url)); } catch { return null; }
  return value ? String(value) : null;
}

/**
 * Build a remote conversation URL only when the site adapter declares a verified URL shape.
 * @param {string} siteId - Registered site identifier.
 * @param {string} origin - Website origin.
 * @param {string} sessionId - Remote conversation identifier.
 * @returns {string|null} The verified URL, or null when the site cannot build one.
 */
export function conversationUrlFor(siteId, origin, sessionId) {
  const build = getSite(siteId)?.navigation?.toUrl;
  if (typeof build !== 'function' || !sessionId) return null;
  try { return build(String(origin).replace(/\/$/, ''), String(sessionId)); } catch { return null; }
}

export const DEEPSEEK = withEffort(SITE_MODULES.deepseek);
export const GLM = withEffort(SITE_MODULES.glm);
export const CHATGPT = withEffort(SITE_MODULES.chatgpt);
export const KIMI = withEffort(SITE_MODULES.kimi);
export const QWEN = withEffort(SITE_MODULES.qwen);
export const DOUBAO = withEffort(SITE_MODULES.doubao);
export const GROK = withEffort(SITE_MODULES.grok);
export const CLAUDE = withEffort(SITE_MODULES.claude);
export const GEMINI = withEffort(SITE_MODULES.gemini);
export const ZAI = withEffort(SITE_MODULES.zai);
export const ZAI_CN = withEffort(SITE_MODULES['zai-cn']);
export const SITES = Object.freeze([DEEPSEEK, GLM, CHATGPT, KIMI, QWEN, DOUBAO, GROK, CLAUDE, GEMINI, ZAI, ZAI_CN]);

/**
 * 选择器里显示的模型名 = `站点短键/模型 id`（0.14.0）。
 *
 * 为什么不是只写模型名：DSH 的模型选择器**只渲染 model.name**，不拼 provider
 * （见 dsh-client-ui-model-selection 的 option 渲染）。旧目录里 8 个站点都叫
 * `auto`，选择器上就是一串分不清出处的「ChatGPT / Qwen / Grok」；而 `glm-5.3`
 * 这种名字同样看不出是 chatglm.cn 还是 z.ai。带上站点短键后，每一行都自带
 * 出处，且与 id 一一对应（`z.ai/glm-5.3` ↔ id `zai:glm-5.3`）。
 *
 * 注意这**只是显示名**：id 仍是 `site:model`，别名表、历史设置值、会话游标、
 * 路由全部不动。
 *
 * 0.14.7（同站多账户）追加一条：显示名后面可能跟 `(账户N)`。
 * **默认槽不跟** —— 见 accounts.accountLabel 的注释，默认槽的显示名必须与 0.14.6
 * 逐字相同，否则既有用户的下拉里会凭空多出他们没配置过的东西。
 */
export function modelDisplayName(st, m, slot) {
  return accountLabel(st.shortKey || st.id, slot) + '/' + m.id;
}

/**
 * 兼容别名 id 集合（0.14.0）。
 *
 * `deepseek-web` 是不带站点前缀的历史 id（旧版 OpenAI 前端与旧会话用它），
 * 它与 `deepseek:deepseek` 指向**同一个**模型，因此显示名逐字相同。若把它照
 * 单渲染，选择器上会出现两行一模一样的 `deepseek/deepseek`——用户看到的就是
 * 「下拉里有重复项」。
 *
 * 因此：**列表接口仍返回它**（历史会话、`agent-default-model` 的旧值、OpenAI
 * 前端的 `model: 'deepseek-web'` 都依赖它解析），但**选择器下拉过滤掉它**。
 * 这份集合是「哪些是别名」的唯一定义处：UI（client.cjs）、适配器
 * （index.js listModels）与测试都必须从这里取，不许各自再写一份字面量。
 */
export const MODEL_ALIAS_IDS = Object.freeze(new Set(['deepseek-web']));

/**
 * **唯一注册的 provider id = `webcode`**（0.19.53，用户指令：「放一起、不要按站点隔开」）。
 *
 * ## 为什么是「一个 provider 装全部站点」
 *
 * DSH 模型选择器的分组**唯一来源**是 `ctx.llm.listProviders()`：**一个 provider
 * 就是一组**（实读 `dsh-api-session-controller/lib/types/catalog.js:38`
 * `{ id: provider.id, name: provider.name, models: entries }`）。
 *
 * 0.19.28 曾反其道而行——给每个站点注册一个 `webcode-<siteId>`，让下拉里出现
 * 「一个网站一层」。2026-10-02 用户明确要求反转：站点不再各占一层，全部模型
 * 归到**一个组**下。
 *
 * ## ⚠ 目录契约**不支持**「组内再分子组」——这一条决定了行名必须带站点
 *
 * 宿主模型行只有 `{ id, name, description?, inputModalities? }` 五个字段
 *（`dsh-llm/lib/types/types.d.ts:304` 的 `LlmModelInfo`），运行时还过一道
 * 白名单重建（`dsh-llm/lib/index.js:2076-2087`）。**没有** `group` / `category`
 * / `family` / `tag` 任何一项（宿主全树检索均无消费方）；「思考等级」是模型行
 * 上**自带的** `reasoning`，渲染成另一条独立 pane 而非子组
 *（`dsh-client-ui-model-selection/lib/client.js:899`、:1031）。
 *
 * 因此合并成一组后，区分「这行属于哪个网站」**只能靠行名本身**。这不只是美观
 * 问题：glm 与 z.ai **有同名模型**（`glm-5.3`），同组平铺下裸名 `GLM-5.3` 会
 * 出现两次且无法分辨——那正是 `modelDisplayName` 当初把站点短键塞进名字里的
 * 原因（见其注释）。所以组内行名回退到带站点的形态，见 `modelGroupEntryName`。
 *
 * ## 站点 id 不再注册（用户明确接受代价）
 *
 * `webcode-<siteId>` 这 10 个 id **不再注册**。它们曾经写进过每个会话的
 * `subagentModelSelectionPolicy`（真机读数：`~/.dsh/storages/session_projcache/`
 * 里 kimi 94 / zai 90 / glm 67 / doubao 60 次…）。
 *
 * ⚠ **代价必须说清，且与旧注释口径不同**：宿主里**没有** `routeServed` 这个函数
 *（全树 0 命中）。发消息前的真判据是 `requireModel` → `modelAvailable`
 *（`dsh-api-session-controller/lib/index.js:900` + `lib/types/catalog.js:67`），
 * 它要求 `listProviders().some(id)` **且** `listModels().some(model)`。
 * 所以「注册了但 listModels 为空」只保证**不抛 NO_ADAPTER**，**不能**保证继续
 * 发消息——旧注释里「旧会话照旧可跑」那句是错的，本次一并修正。
 *
 * 不注册站点 id ⇒ 存量里那批 `webcode-kimi` 等值**会**失效。这是用户明确接受的
 *（「我不需要旧，我只要新版的」），配套动作是把 profile 配置里的白名单改写为
 * `webcode`，让源头不再写回旧值。解析侧仍保留 `siteIdForProvider()`：它是
 * **纯函数**，用于诊断与模型归属判定——不注册不等于不认识。
 */
export const MODEL_PROVIDER_COMPAT_ID = 'webcode';

/**
 * 站点 id → 历史 provider id（`webcode-glm` 这类）。
 *
 * ⚠ **这些 id 已不再注册**（见 MODEL_PROVIDER_COMPAT_ID 的说明）。本函数仅供
 * 诊断、报错文案与存量识别使用——它回答「这个字符串指的是哪个站点」，
 * **不**承诺该 provider 仍被服务。
 */
export function providerIdForSite(siteId) {
  return MODEL_PROVIDER_COMPAT_ID + '-' + String(siteId);
}

/** provider id → 站点 id；不属于本站点的 provider 一律 null（不猜、不回落）。 */
export function siteIdForProvider(providerId) {
  const prefix = MODEL_PROVIDER_COMPAT_ID + '-';
  const id = String(providerId ?? '');
  if (!id.startsWith(prefix)) return null;
  const siteId = id.slice(prefix.length);
  return SITES.some((s) => s.id === siteId) ? siteId : null;
}

/** 组名覆盖表（见 providerGroupName 注释）。值必须是用户可读的真实站点域名。 */
const PROVIDER_GROUP_NAME_OVERRIDES = Object.freeze({ glm: 'chatglm' });

/**
 * 站点在其**唯一组**里的可读键（`glm` / `z.ai` / `chatglm`…）。
 *
 * 与旧 `providerGroupName` 的唯一区别是**不再带 `webcode-` 前缀**：那个前缀的
 * 作用是「在多组并列时标明这些组都来自网页桥」，而现在只有一组，前缀就是噪音。
 *
 * GLM 走覆盖表给 `chatglm`：它的站点 id 是 `glm`，而真实域名是 chatglm.cn；
 * z.ai 的 shortKey 本来就是域名，直接可用。
 *
 * ⚠ **为什么不动 shortKey**：那个字段同时决定模型 id 前缀、历史设置值、
 * 设置页站点名与 `test/model-labels.test.mjs` 的一批断言。只有「组标题/
 * 组键」这一处需要覆盖，改 shortKey 会让上面几样一起漂移。
 */
export function providerGroupName(siteId) {
  const st = SITES.find((s) => s.id === siteId);
  if (!st) return String(siteId);
  const override = PROVIDER_GROUP_NAME_OVERRIDES[siteId];
  return override || st.shortKey || st.id;
}

/** 注册给 `llm.registerAdapter` 的 provider id —— **只有一个真路由**。 */
export function providerIdsForRegistration() {
  return [MODEL_PROVIDER_COMPAT_ID];
}

/**
 * 模型在**选择器组内**的显示名：`站点键/裸模型名`（`glm/GLM-5.3` / `z.ai/glm-5.3`）。
 *
 * ## 0.19.53：为什么从「裸模型名」改回带站点键
 *
 * 裸名（`GLM-5.3`）是 0.19.28 的产物——那时**每站点一个 provider = 一组**，
 * 组标题已经写明站点，行内再带一次确实是重复。
 *
 * 2026-10-02 合并成**唯一一组**后，组标题不再区分站点，而宿主模型行
 * **没有任何子组字段**（见 MODEL_PROVIDER_COMPAT_ID 的说明）。于是裸名会
 * 直接撞车：**glm 与 z.ai 都有 `glm-5.3`**，同组平铺下会出现两行逐字相同的
 * `GLM-5.3`，用户无法分辨、也无法选中想要的那一个。
 *
 * 所以行名退回带站点键的形态——这与 `modelDisplayName` 当初把站点键塞进名字
 * 里的**原因完全相同**（见其注释：分不清 glm-5.3 是 chatglm.cn 还是 z.ai），
 * 只是现在站点键用的是 `providerGroupName` 的口径（`glm` / `z.ai` / `chatglm`）。
 *
 * 注意这**只是显示名**：模型 id 仍是 `glm:glm-5.3`，别名表、历史设置值、
 * 会话游标、路由全部不动。
 */
export function modelGroupEntryName(m, siteId) {
  const bare = String(m?.name ?? m?.id ?? '');
  if (!siteId) return bare;
  return providerGroupName(siteId) + '/' + bare;
}

/**
 * 全站点模型目录（限定 id + 能力元数据）——DSH 模型选择器与
 * OpenAI /v1/models 共用这一份，保证两边模型列表一致。
 *
 * `accounts`（0.14.7，可选）：设置里的账户槽数组。传了就把每个启用槽展开成一组条目：
 *
 *   不传 / 传空             → 与 0.14.6 **逐字节相同**的输出（默认槽）
 *   [{siteId:'glm',slot:'2'}] → glm 的默认槽与 `glm@2` 各出一组
 *
 * **兼容性硬约束**：不传参数时，本函数必须与 0.14.6 的输出完全一致。
 * `test/model-labels.test.mjs` 与 `test/multi-site-decoder.test.mjs` 的既有断言
 * 就是这条约束的执行者——它们**不传参数**，因此任何默认槽形状的漂移都会立刻失败。
 */
export function listAllModels(accounts) {
  const out = [];
  const slotsBySite = new Map();
  for (const a of normalizeAccountsList(accounts)) {
    if (!slotsBySite.has(a.siteId)) slotsBySite.set(a.siteId, []);
    slotsBySite.get(a.siteId).push(a.slot);
  }
  for (const st of SITES) {
    // 默认槽永远在第一位：不传 accounts 时它就是唯一的一项，输出因此与 0.14.6 相同。
    const slots = [DEFAULT_SLOT, ...(slotsBySite.get(st.id) || [])];
    for (const slot of slots) {
      for (const m of st.models) {
        out.push({
          id: formatModelId(st.id, slot, m.id),
          siteId: st.id,
          slot,
          siteName: st.name,
          name: modelDisplayName(st, m, slot),
          labels: m.labels,
          context: m.context || null,
          budget: m.budget || m.context || null,
          thinking: m.thinking === true,
          vision: m.vision === true,
          // acceptsImages = 该模型的**网页端**能收下图片附件（与 vision 不同：
          // vision 是 DeepSeek 那种必须带图的独立「识图模式」；这里只是「可以
          // 带图发」，不带图也能正常用）。宿主据此声明 inputModalities。
          acceptsImages: m.acceptsImages === true,
          imageOut: m.imageOut === true,
          experimental: st.experimental === true,
        });
      }
    }
  }
  // 兼容别名条目：它指向默认槽（历史值语义），槽信息不参与。
  // 显示名刻意写死为「无槽后缀」——它与 `deepseek:deepseek` 同名是**过滤的前提**
  // （见 MODEL_ALIAS_IDS 注释），一旦带上槽后缀这个前提就没了。
  //
  // ⚠ 0.19.86 修缺陷：**别名条目漏了 `acceptsImages`**（本条原为 `vision: false` 起、
  //   **没有** `acceptsImages` 字段）。而 `deepseek-web` 是 `DEFAULT_MODEL_ID`
  //   （`providers.js:1024`），并且被**消费**：`web-control.js` 的
  //   `GET models`（`:968`）与 `GET context-windows`（`:999`）都原样返回
  //   `listAllModels()` 的条目 ⇒ 界面上这个 id 的 `acceptsImages` 是 `undefined`
  //   （= 假），而 `resolveWebModel('deepseek-web')` 解析到的**同一个模型**是 `true`
  //   ⇒ **同一个模型的两条路径给出相反答案**。
  //   修法：别名条目与真条目**同源取值**，不手写第二份（照抄 `DEEPSEEK.models[0]`
  //   的字段，包含 `acceptsImages`）。新增字段时不会再漏——两者从此同一处投影。
  //   护栏：`test/provider-surface.test.mjs` 的「别名与真条目字段同源」一条。
  const dsMain = DEEPSEEK.models[0];
  out.push({
    id: 'deepseek-web', siteId: 'deepseek', slot: DEFAULT_SLOT, siteName: DEEPSEEK.name,
    name: modelDisplayName(DEEPSEEK, dsMain), labels: [],
    context: dsMain.context || null, budget: dsMain.budget || dsMain.context || null,
    thinking: true, vision: false, imageOut: false,
    // 与真条目同源（0.19.86）：漏了这一格就是「别名说不能带图、真 id 说能带图」。
    acceptsImages: dsMain.acceptsImages === true,
    experimental: false,
  });
  return out;
}

/** 内部：只取合法的 `{ siteId, slot }` 对，非法条目静默丢弃（设置文件可手改）。 */
function normalizeAccountsList(accounts) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(accounts) ? accounts : []) {
    if (!entry || typeof entry !== 'object' || entry.enabled === false) continue;
    const siteId = String(entry.siteId ?? '').trim();
    if (!SITES.some((s) => s.id === siteId)) continue;
    const slot = normalizeSlot(entry.slot);
    if (!slot || slot === DEFAULT_SLOT) continue;   // 默认槽已无条件包含，不重复
    const key = siteId + '#' + slot;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ siteId, slot });
  }
  return out;
}

/** 兼容别名 → 'site:model' 限定 id。 */
const ALIASES = Object.freeze({
  // 历史 id / 兼容别名 → 唯一 DeepSeek 模型（升级后旧设置值仍可用）。
  'deepseek-web': 'deepseek:deepseek',
  'deepseek-reasoner': 'deepseek:deepseek',
  flash: 'deepseek:deepseek',
  vision: 'deepseek:deepseek',
  'gpt-4o': 'chatgpt:auto', chatgpt: 'chatgpt:auto',
  // ⚠ 0.19.43：glm / kimi / doubao / zai 四个站点的 auto 已从模型表里**真删**
  //（用户判据：网页给了真实档位，就不该再有一个桥自己发明的「不切换」档）。
  // 但历史值必须仍解析得开——真机 `~/.dsh/settings.yaml` 的
  // `subagent-model-selection.allowedModels` 里就写着 `glm:auto` / `kimi:auto` /
  // `doubao:auto`；只删模型表不改别名，这些白名单会当场变成不可解析值。
  // 因此下面的别名**同时**覆盖两种写法：裸站点名（`glm`）与已限定的历史 id
  //（`glm:auto`）。落点各自收敛到**本站点**的档位，绝不互相串站点。
  glm: 'glm:glm-5.3', 'glm:auto': 'glm:glm-5.3',
  'glm-4.5': 'glm:glm-5.3', 'glm-4.6': 'glm:glm-5.3',
  // GLM 版本别名（0.13.0 起 glm 站点有真实版本条目；旧设置值必须仍解析得开）
  'glm-5.3': 'glm:glm-5.3', 'glm-5.3-flash': 'glm:glm-5.3-flash',
  // 用户口头/历史写法（点号、连字符、大小写混用）统一收敛到 z.ai 的真实条目
  'z.ai-glm5.3': 'zai:glm-5.3', 'z.ai-glm5.3-flash': 'zai:glm-5.3-flash',
  'zai-glm-5.3': 'zai:glm-5.3', 'zai-glm-5.3-flash': 'zai:glm-5.3-flash',
  'glm-zai-5.3': 'zai:glm-5.3',
  kimi: 'kimi:k3', 'kimi:auto': 'kimi:k3', 'kimi-k3': 'kimi:k3', k3: 'kimi:k3',
  // K3 集群（2026-09-28 起从模型表真删，见 KIMI.models 注释）：历史值必须仍解析得开，
  // 收敛到同一站点的旗舰档 K3——留着它们指向一个不存在的 modelId 会让旧会话直接
  // 「不支持的网页模型」而断链（与 `glm:auto` 那条同一条纪律）。
  'k3-cluster': 'kimi:k3', 'kimi:k3-cluster': 'kimi:k3',
  'kimi-k2.8-preview': 'kimi:k2.8-preview', 'k2.8-preview': 'kimi:k2.8-preview',
  // qwen / doubao / grok / claude / gemini 的 auto **保持不动**：桥没有它们的
  // modelPicker 契约，切不动网页模型，auto 是那里唯一可用的条目（用户 2026-09-28：
  //「如果你不知道的话，就先空着不用改」）。doubao 是例外的一半：它有 segmented
  // 契约，模型表里的 auto 已真删，所以这里额外把历史 id 收敛到「对话」。
  qwen: 'qwen:auto', doubao: 'doubao:chat', 'doubao:auto': 'doubao:chat',
  grok: 'grok:auto', claude: 'claude:auto', gemini: 'gemini:auto',
  zai: 'zai:glm-5.3', 'zai:auto': 'zai:glm-5.3',
  'z-ai': 'zai:glm-5.3', 'chat.z.ai': 'zai:glm-5.3', 'glm-zai': 'zai:glm-5.3',
  'zai-cn': 'zai-cn:glm-5.3', 'zchat.z.ai': 'zai-cn:glm-5.3',
});

export const DEFAULT_MODEL_ID = 'deepseek-web';

function resolved(st, m, slot = DEFAULT_SLOT) {
  const s = normalizeSlot(slot) || DEFAULT_SLOT;
  return Object.freeze({
    site: st, siteId: st.id, siteName: st.name, origin: st.origin,
    // 账户槽（0.14.7）：默认槽恒为 DEFAULT_SLOT，调用方据此决定 profile 目录。
    slot: s, accountKey: s === DEFAULT_SLOT ? st.id : st.id + '#' + s,
    decoder: st.decoder, stream: st.stream !== false, experimental: Boolean(st.experimental),
    id: m.id, name: modelDisplayName(st, m, s), labels: m.labels,
    // 网页上的原始名字（不含站点短键）。model-picker 的兜底目标名用它——
    // 网页上从来不会写 `z.ai/glm-5.3`，拿显示名去比对必然 option-not-in-list。
    webName: m.name,
    thinking: m.thinking === true, vision: m.vision === true, imageOut: m.imageOut === true,
    acceptsImages: m.acceptsImages === true,
    // 展示口径（声明窗口）与预算口径（发送前预算闸 B-2 比对的数）字段级分开：
    // context = 站点声明 / 实测的窗口，展示给用户看的数；
    // budget  = 预算闸真正对比的数，无声明时回落 context（值一致，语义可选）。
    context: m.context ?? null,
    budget: m.budget ?? m.context ?? null,
  });
}

/**
 * 解析任意模型 id（裸 id / `site:model` / `site@slot:model` / 别名 / `{id}`）
 * → 站点 + 模型 + 账户槽。未知必须 throw。
 *
 * 0.14.7 的解析顺序刻意是**别名优先于槽解析**：
 *
 *   别名表里的值（`flash`、`glm-4.6`、`zai`…）全部指向**默认槽**——
 *   它们代表历史设置值，历史值是在「一个站点一份登录态」的年代写下的，
 *   指到默认槽才是它们的原意。所以先查别名，再解析 `@slot`。
 *   若顺序反过来，一个恰好含 `:` 的别名会被误当成槽限定 id。
 */
export function resolveWebModel(value = DEFAULT_MODEL_ID) {
  const id = typeof value === 'object' ? value?.id : value;
  const raw = String(id ?? '').trim();
  if (!raw) throw new Error('不支持的网页模型：' + id);
  const qualified = ALIASES[raw] || raw;
  // 限定形状：`site:model` 与 `site@slot:model` 都由 parseModelId 统一解析。
  //
  // **必须连同默认槽一起处理**（这是 0.14.7 首版的一个真 bug）：
  // `glm@1:glm-5.3` 里的 `1` 是默认槽的别名，parseModelId 会把它归一成
  // `slot: 'default'`；首版只处理「slot !== default」的分支，于是这个 id 掉进
  // 下面的 `split(':')` 兜底，被切成站点 `glm@1` → 查不到 → 抛「不支持的网页模型」。
  // 用户看到的是「填了账户1 反而报错」，而账户1 本该与默认槽完全等价。
  const withSlot = parseModelId(qualified);
  if (withSlot) {
    const st = SITES.find((s) => s.id === withSlot.siteId);
    const m = st?.models.find((m) => m.id === withSlot.modelId);
    if (st && m) return resolved(st, m, withSlot.slot);
    // ## 带槽的**兼容别名**（0.19.49 修的真 bug）
    //
    // `ALIASES` 的键是「站点:模型」形状（`'zai:auto'`、`'kimi:auto'`…），而上面那次查表
    // 发生在**槽解析之前**、用的是整串原文：原文是 `zai@work:auto` 时表里当然没有这个键，
    // 于是走到这里、`models.find(id === 'auto')` 也找不到（auto 已从模型表真删）⇒ 抛错。
    //
    // 真机症状：单账户用户写 `zai:auto` 正常（原文直接命中 ALIASES），
    // **一旦启用第二个账户**（id 变成 `zai@work:auto`）就报「不支持的网页模型」——
    // 而这两者本该等价。历史 settings 与 `subagent-model-selection.allowedModels` 里
    // 写的都是不带槽的形式，用户在面板上给模型挑一个账户后就撞上它。
    //
    // 修法：把「站点:模型」这一段单独再查一次别名表，命中后按**原本的槽**解析
    //（槽信息绝不能因为别名而丢失，否则「账户2」会静默写回默认槽的登录态）。
    const viaAlias = ALIASES[withSlot.siteId + ':' + withSlot.modelId];
    if (viaAlias) {
      const q2 = parseModelId(viaAlias);
      if (q2) {
        const st2 = SITES.find((s) => s.id === q2.siteId);
        const m2 = st2?.models.find((m) => m.id === q2.modelId);
        if (st2 && m2) return resolved(st2, m2, withSlot.slot);
      }
    }
    throw new Error('不支持的网页模型：' + id);
  }
  if (qualified.includes(':')) {
    const [sid, mid] = qualified.split(':', 2);
    const st = SITES.find((s) => s.id === sid);
    const m = st?.models.find((m) => m.id === mid);
    if (st && m) return resolved(st, m);
    throw new Error('不支持的网页模型：' + id);
  }
  // 裸 id：DeepSeek 的历史 id 保持原语义；其余要求全站点唯一
  const ds = DEEPSEEK.models.find((m) => m.id === raw);
  if (ds) return resolved(DEEPSEEK, ds);
  const hits = [];
  for (const st of SITES) for (const m of st.models) if (m.id === raw) hits.push([st, m]);
  if (hits.length === 1) return resolved(hits[0][0], hits[0][1]);
  throw new Error('不支持的网页模型：' + id);
}

/**
 * 按站点 id 取站点定义（模型目录、源站、静态域、契约）。
 *
 * 返回 `null` 而不是抛错或回落默认站点：调用方几乎都处在一个「用户给了个
 * 拼错的 siteId」的路径上，抛错会让整个面板 500，回落默认站点则会**静默操作
 * 另一个站点**（比报错危险得多）。所以这里如实说「没有这个站点」，让调用方
 * 决定是报错还是给默认值。
 *
 * @param {string} siteId 站点 id
 * @returns {object|null} 站点定义，未登记时为 null
 */
export function getSite(siteId) {
  return SITES.find((s) => s.id === siteId) ?? null;
}

/** 归一化模型 id：裸 id 补站点前缀（'glm-4.6' + 'glm' → 'glm:glm-4.6'），
 *  已限定或空值原样返回。executor / OpenAI 前端共用，保证路由唯一。
 *
 *  0.14.7：`glm@2:glm-5.3` 这类**已带槽**的限定 id 原样返回——它有 `:`，
 *  天然满足下面的短路条件；槽信息因此不会在这一层被剥掉。 */
export function qualifyModelId(model, siteId) {
  if (model === undefined || model === null) return model;
  const s = String(model);
  if (siteId && !s.includes(':')) return siteId + ':' + s;
  return s;
}
