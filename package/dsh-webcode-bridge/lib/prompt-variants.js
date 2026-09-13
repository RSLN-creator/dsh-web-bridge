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

import { serializeFirstTurn, trainNoteFor } from './agent-preset.js';

/** 适配分支表：id → { label, siteIds, siteId }（siteId 是喂给 serializeFirstTurn 的） */
export const VARIANT_SPECS = Object.freeze([
  {
    id: 'default',
    label: '默认（<tool_call> 标签形状）',
    // 除 glm 外的全部站点都走这一支（含 z.ai——它的前端不吃调用标签的问题
    // 与 chatglm.cn 不同，仍按标签教学）。
    siteId: undefined,
    excludes: ['glm'],
    note: '以 <tool_call>{…}</tool_call> 发起调用；网页不会拦截该标签。',
  },
  {
    id: 'glm',
    label: 'GLM 专用（```json 代码块形状）',
    siteId: 'glm',
    only: ['glm'],
    note: 'chatglm.cn 对正文里的调用标签有原生执行器（只认它内置的 search/open/click/find），'
      + '标签形状会被它抢走执行并回灌 unknown tool call，因此该站点只教代码块形状。',
  },
]);

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
export function buildPromptVariants({ tools, extraPrompt, system, lastPreset } = {}) {
  const real = Array.isArray(tools) && tools.length > 0;
  const toolList = real ? tools : PLACEHOLDER_TOOLS;
  const variants = VARIANT_SPECS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    note: spec.note,
    // 该变体实际服务的站点：有的站点是「除它之外」，有的是「只有它」。
    // 从 SITES 现算，避免这里再维护一份站点清单。
    siteIds: spec.only ? [...spec.only] : null,   // null = 除 excludes 外全部
    excludes: spec.excludes ? [...spec.excludes] : [],
    // 现算：与真正发出去的那一份走同一个函数。
    text: serializeFirstTurn({ messages: [], tools: toolList, extraPrompt, system, siteId: spec.siteId }),
    // 再教学提示也一并露出——增量轮第 5 个工具结果会重贴它，立场必须与首轮一致。
    trainNote: trainNoteFor(spec.siteId || 'default'),
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