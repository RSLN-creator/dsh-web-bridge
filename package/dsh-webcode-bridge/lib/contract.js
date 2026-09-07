// contract.js — DeepSeek 网页供应商契约集中维护。
// DOM 选择器、模型目录、请求类型期望、SSE 端点等升级点全部收口到这里，
// 网页改版时只需更新本文件，并在发版前运行 `pnpm doctor`（real-verify）。
import { DEEPSEEK, resolveWebModel } from './providers.js';
import { expectedModelType } from './metrics.js';

export const DEEPSEEK_WEB_CONTRACT = Object.freeze({
  siteOrigin: DEEPSEEK.origin,
  completionPath: DEEPSEEK.completionPath,
  inputSelector: DEEPSEEK.input,
  sendButtonSelector: "div[role='button']:has(path[d^='M8.3125'])",
  stopButtonSelector: "div[role='button']:has(path[d^='M2 4.88'])",
  searchTogglePattern: /^(智能搜索|联网搜索|Search)$/,
  requestMetadataKeys: ['model_type', 'thinking_enabled', 'search_enabled'],
  expectedModelType: (modelId) => expectedModelType(resolveWebModel(modelId).id),
});

export { DEEPSEEK, resolveWebModel, expectedModelType };
