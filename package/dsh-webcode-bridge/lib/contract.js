// contract.js — 各内容服务的网页契约集中维护。
//
// DOM 选择器、模型目录、SSE 端点、解码器种类、请求元数据键等升级点全部收口到这里。
// 网页改版时只需更新 providers.js / 本文件，并在发版前运行 `pnpm doctor`。
// DeepSeek 契约保持既有字段不变（strictModelType 仍按 model_type 真机核验）；
// 其余站点为通用契约（标签点击选模型 + 通用解码器），实验性站点标记 experimental。
import { DEEPSEEK, SITES, resolveWebModel, getSite } from './providers.js';
import { expectedModelType } from './metrics.js';

export const DEEPSEEK_WEB_CONTRACT = Object.freeze({
  siteOrigin: DEEPSEEK.origin,
  completionPath: DEEPSEEK.completionPaths[0],
  completionPaths: DEEPSEEK.completionPaths,
  inputSelector: DEEPSEEK.input,
  sendButtonSelector: DEEPSEEK.sendButton,
  stopButtonSelector: DEEPSEEK.stopButton,
  attachSelector: DEEPSEEK.attachSelector,
  decoder: DEEPSEEK.decoder,
  searchTogglePattern: /^(智能搜索|联网搜索|Search)$/,
  requestMetadataKeys: ['model_type', 'thinking_enabled', 'search_enabled'],
  strictModelType: true,
  expectedModelType: (modelId) => expectedModelType(resolveWebModel(modelId).id),
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

export function getContract(siteId) {
  return SITE_CONTRACTS[siteId] ?? null;
}

export { DEEPSEEK, SITES, resolveWebModel, getSite, expectedModelType };
