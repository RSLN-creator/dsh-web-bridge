// prompt-variants.js — 「首轮提示词」的只读变体清单（0.14.0）。
//
// 为什么需要它：首轮模板由桥按当前会话的**工具清单**现算（agent-preset.js 的
// serializeFirstTurn），因此它不是一个固定字符串——用户此前只能在设置里看到
// 「最后一次真实发送过的那一份」（还得先展开 <details>，且全新会话永远是空的）。
// 本模块把模板按**适配分支**枚举出来：默认（标签形状）与 glm（代码块形状），
// 每一条都用真函数现算，所以「设置里看到的」与「实际发出去的」永远同源。
//
// 唯一真相仍是 agent-preset.js：本模块只负责挑参数并调用它，**不得**自己拼
// 协议文本——两处各写一份协议必然漂移（见 doc/review-guide.md 的不可越界约束）。
//
// 变体表与 agent-preset.js 的分支一一对应，且由 test/prompt-variants.test.mjs
// 钉住：glm 变体不得出现 <tool_call>，默认变体必须出现；两者必须互不相同。

import { serializeFirstTurn, trainNoteFor, trainExtraFor } from './agent-preset.js';
// 站点清单与显示名从 providers.js 现算（唯一真相），本模块不另维护一份。
import { SITES } from './providers.js';

/** 适配分支表：id → { label, siteIds, siteId }（siteId 是喂给 serializeFirstTurn 的）
 *
 * 0.16.25：补上 **official**（DeepSeek 官方训练模板）一支，并纠正 default 的
 * excludes。此前 `variantIdForSite('deepseek')` 返回 'default'，可 deepseek 在
 * serializeFirstTurn 里走的是**官方模板**分支（agent-preset.js 的 siteId === 'deepseek'
 * 那一段）——于是设置页给 deepseek 显示的模板与真正发出去的**不是同一份**。
 * 加 official 之前这个错误不可见：下拉只有两支，用户不会去比对「deepseek 到底
 * 选没选对」。改成「每行一个网站 + 该网站实际用的协议」之后，它立刻就是错的。
 * 因此这是修正，不是扩展：站点 → 分支的映射现在与 agent-preset 的真实分支一一对应。 */
export const VARIANT_SPECS = Object.freeze([
  {
    id: 'default',
    label: '标签形状（<tool_call> 标签）',
    // 除 glm（代码块）与 deepseek（官方模板）外的全部站点都走这一支（含 z.ai——
    // 它的前端不吃调用标签的问题与 chatglm.cn 不同，仍按标签教学）。
    siteId: undefined,
    excludes: ['glm', 'deepseek'],
    note: '以 <tool_call>{…}</tool_call> 发起调用；网页不会拦截该标签。',
  },
  {
    id: 'glm',
    label: 'GLM 代码块（```json 代码块）',
    siteId: 'glm',
    only: ['glm'],
    note: 'chatglm.cn 对正文里的调用标签有原生执行器（只认它内置的 search/open/click/find），'
      + '标签形状会被它抢走执行并回灌 unknown tool call，因此该站点只教代码块形状。',
  },
  {
    id: 'official',
    label: 'DeepSeek 官方模板（原生工具调用格式）',
    siteId: 'deepseek',
    only: ['deepseek'],
    note: 'DeepSeek 网页走官方训练模板（模型被训练时见过的形状）。DSML 已于 0.16.23 退役，'
      + '不再作为教学或解析形状。',
  },
]);

/**
 * 实验变体（**默认不返回**，只有 `buildPromptVariants({ experiments: true })` 才附上）。
 *
 * 为什么与 VARIANT_SPECS 分开：前者是**已生效的生产分支**（站点 → 分支的映射，
 * 由 variantIdForSite 决定，测试钉死只有 glm 例外）；后者是**尚未转正的候选**，
 * 只能被基准实验显式拉出来跑，绝不能悄悄进入真实会话的选路。
 * 这个分离本身就是纪律：提示词改动在拿到配对数据之前不进默认路径。
 *
 * 两个候选各自的文献依据见 doc/research/prompt-engineering-evidence-2026-09-14.md：
 *   · reinstruct ← ACL Findings《Improving Long Context Instruction Following》
 *     实测「周期性重述指令」显著优于「只靠一次系统提示」；而现有 TRAIN_NOTE 只
 *     重述格式、不重述约束，正是缺口。
 *   · slim ← arXiv 2510.05381《Context Length Alone Hurts...》：即使检索完美，
 *     长上下文本身也导致性能下降 → 首轮不是越长越好。
 */
export const EXPERIMENT_SPECS = Object.freeze([
  {
    id: 'reinstruct',
    label: '实验 A：增量轮重述关键约束（格式 + 平台/必填/present）',
    siteId: undefined,
    excludes: ['glm'],
    trainExtra: 'reinstruct',
    slim: false,
    note: '在既有的「每 5 个工具结果重贴格式」之上，追加平台、必填字段、不得虚构、'
      + 'present 四条关键约束的重述。依据 ACL Reinstruct；默认路径不变，需实测数据才转正。',
  },
  {
    id: 'slim',
    label: '实验 B：首轮精简（准则 4→2 条、工具描述上限 1200→800）',
    siteId: undefined,
    excludes: ['glm'],
    trainExtra: '',
    slim: true,
    note: '首轮提示词更短。依据 arXiv 2510.05381「长上下文本身有害」。'
      + '注意这是**双向**候选：精简可能减少干扰，也可能丢掉必要约束，必须由判据说话。',
  },
]);

/** slim 实验变体的工具描述上限（默认路径是 agent-preset 的 1200）。 */
const SLIM_TOOL_DESC_LIMIT = 800;

/** 预览用的占位工具集：真实工具清单拿不到时用它，并在 note 里说明是占位。 */
const PLACEHOLDER_TOOLS = [
  { name: 'read', description: '读取本地文件文本内容。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'pwsh', description: 'Execute a PowerShell command and return its output.', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command', 'description'] } },
];

/**
 * 列出全部首轮提示词变体，并标注「本会话最近一次真实用的是哪一支」。
 *
 * @param {object} options
 * @param {Array}  [options.tools]      真实工具清单（缺省用占位集）
 * @param {string} [options.extraPrompt] 设置页的「全局指令」
 * @param {string} [options.system]     宿主系统提示词（会话级，设置页拿不到时省略）
 * @param {object} [options.lastPreset] 最近一次真实首轮（index.js 的 lastPresetInfo）
 * @returns {{variants: Array, toolsSource: string, active: object|null}}
 */
export function buildPromptVariants({ tools, extraPrompt, sitePromptOf, system, lastPreset, experiments = false } = {}) {
  const real = Array.isArray(tools) && tools.length > 0;
  const toolList = real ? tools : PLACEHOLDER_TOOLS;
  // 站点专属指令（0.16.38）：按变体**实际服务的站点**取那一段，没有站点归属的
  // （default，服务除 glm/deepseek 外的全部站点）传空——那一段属于具体站点，
  // 不属于「除某站之外的全部站点」这一支。
  const sitePrompt = (sid) => (typeof sitePromptOf === 'function' ? sitePromptOf(sid) : '');
  const specs = experiments ? [...VARIANT_SPECS, ...EXPERIMENT_SPECS] : VARIANT_SPECS;
  const variants = specs.map((spec) => ({
    id: spec.id,
    label: spec.label,
    note: spec.note,
    // 该变体实际服务的站点：有的站点是「除它之外」，有的是「只有它」。
    // 从 SITES 现算，避免这里再维护一份站点清单。
    siteIds: spec.only ? [...spec.only] : null,   // null = 除 excludes 外全部
    excludes: spec.excludes ? [...spec.excludes] : [],
    // 实验变体标记：只供基准实验（test-mock/prompt-bench.mjs）显式拉取时区分。
    // 旧注释写的是「前端据此把它们与生产分支分开渲染」，但客户端从来没有这个分支
    // （lib/client.cjs 里没有任何 experimental 感知的渲染），是一句失效注释。
    // 现状是**更保守**的：实验变体不接进 GUI 下拉——它们还没转正，接进去会让用户
    // 以为选了就生效，而真实会话的选路仍只由 variantIdForSite 决定。
    experimental: Boolean(spec.trainExtra || spec.slim),
    // 现算：与真正发出去的那一份走同一个函数。
    text: serializeFirstTurn({
      messages: [], tools: toolList, extraPrompt, system, siteId: spec.siteId,
      sitePrompt: sitePrompt(spec.siteId),
      ...(spec.slim ? { slim: true, toolDescLimit: SLIM_TOOL_DESC_LIMIT } : {}),
    }),
    // 再教学提示也一并露出——增量轮第 5 个工具结果会重贴它，立场必须与首轮一致。
    trainNote: trainNoteFor(spec.siteId || 'default', trainExtraFor(spec.trainExtra, { hasPresent: toolList.some((t) => t && t.name === 'present') }), toolList),
  }));
  const active = lastPreset
    ? {
      variantId: variantIdForSite(lastPreset.siteId),
      model: lastPreset.model || null,
      siteId: lastPreset.siteId || null,
      tools: Array.isArray(lastPreset.tools) ? lastPreset.tools : [],
      at: lastPreset.at || null,
    }
    : null;
  return { variants, toolsSource: real ? 'session' : 'placeholder', active };
}

/** 站点 → 适配分支 id（与 VARIANT_SPECS 的 only/excludes 同源）。 */
export function variantIdForSite(siteId) {
  const sid = String(siteId || '').trim();
  for (const spec of VARIANT_SPECS) if (spec.only && spec.only.includes(sid)) return spec.id;
  return 'default';
}

/**
 * 「按站点」的提示词视图（0.16.25）：每个站点一行，附该站点**实际会用**的协议。
 *
 * 用户诉求（原话）：「设置界面的提示词选择：改为以网站为导向列出，每行一个网站，
 * 然后后面选择框选择已有协议中的一个」。
 *
 * 为什么由后端算这行数据，而不是让前端自己组合：每行的 `text` 必须是**真正会
 * 发给该站点的那一份**（按它的 siteId 调 serializeFirstTurn 现算）。前端若自己
 * 拿「默认变体的文本」去填每一行，deepseek 那行就会显示标签形状——那正是本版
 * 顺手修掉的那个错误（见 VARIANT_SPECS 的注释）。
 *
 * `variantId` 是该站点当前实际使用的协议（选中项）；`text` 是它的模板全文；
 * `variants` 是可选协议清单（供下拉切换**预览**——只读，不改变真实选路，
 * 与「模板只读」的既定立场一致）。
 *
 * @param {object} options
 * @param {Array}  [options.tools]       真实工具清单（缺省用占位集）
 * @param {string} [options.extraPrompt] 设置页的「全局指令」
 * @param {string} [options.system]      宿主系统提示词
 * @param {object} [options.lastPreset]  最近一次真实首轮
 * @returns {{sites: Array, variants: Array, toolsSource: string, active: object|null}}
 */
export function buildSitePromptRows({ tools, extraPrompt, sitePromptOf, system, lastPreset } = {}) {
  const real = Array.isArray(tools) && tools.length > 0;
  const toolList = real ? tools : PLACEHOLDER_TOOLS;
  const sitePrompt = (sid) => (typeof sitePromptOf === 'function' ? sitePromptOf(sid) : '');
  // 协议清单：id + label + 该协议在「本会话工具清单」下的完整文本。
  const variants = VARIANT_SPECS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    note: spec.note,
    text: serializeFirstTurn({
      messages: [], tools: toolList, extraPrompt, system, siteId: spec.siteId,
      sitePrompt: sitePrompt(spec.siteId),
    }),
  }));
  const byId = new Map(variants.map((v) => [v.id, v]));
  const sites = SITES.map((st) => {
    const variantId = variantIdForSite(st.id);
    const chosen = byId.get(variantId) || variants[0];
    return {
      siteId: st.id,
      // 显示名直接用 providers 的那份（与右栏站点栏、模型下拉同一串字）。
      siteName: st.name || st.id,
      variantId,
      variantLabel: chosen.label,
      // 该站点真正会发出去的模板（按它自己的 siteId 现算）。
      text: chosen.text,
      // 该站点自己的那一段指令（0.16.38）：设置页的站点页只编辑它。
      sitePrompt: sitePrompt(st.id),
    };
  });
  const active = lastPreset
    ? {
      variantId: variantIdForSite(lastPreset.siteId),
      model: lastPreset.model || null,
      siteId: lastPreset.siteId || null,
      tools: Array.isArray(lastPreset.tools) ? lastPreset.tools : [],
      at: lastPreset.at || null,
    }
    : null;
  return { sites, variants, toolsSource: real ? 'session' : 'placeholder', active };
}