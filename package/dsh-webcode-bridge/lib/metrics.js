// metrics.js — 纯函数：由一次真实发送的阶段指标推导出"实测生成速率"，
// 供 status()/设置页做「估算 vs 实测」展示。与驱动时序解耦，便于单元断言。
//
// contract: 只要传入形如 lastFinished 的对象，charsPerSec 与各阶段毫秒即确定，
// 不依赖任何全局/时序状态。

/** 派生实测速率快照。input 形如 driver.runTurn 挂在 lastFinished 的 {metrics,chars}。 */
export function deriveLastRate(lastFinished, mode = null) {
  if (!lastFinished || !lastFinished.metrics) return null;
  const m = lastFinished.metrics;
  const chars = Number(lastFinished.chars) || 0;
  return {
    chars,
    responseMs: m.responseMs ?? null,
    firstResponseMs: m.firstResponseMs ?? null,
    thinkingMs: m.thinkingMs ?? null,
    endToEndMs: m.endToEndMs ?? null,
    charsPerSec: m.responseMs && m.responseMs > 0 ? Math.round(chars / (m.responseMs / 1000)) : null,
    mode: mode ?? null,
  };
}

/** 网页模型 id → 其请求上报的 model_type 期望值（真机核验契约）。
 *
 *  桥只暴露一个 DeepSeek 模型（2026-09-11 三合一），差异全在「深度思考」：
 *  classic = 旧三 pill UI（≤0.7.2）：deepseek 走专家模式 → model_type=expert；
 *  unified = 2026-09-10 新版 UI：model_type 恒为 default，差异只剩 thinking_enabled
 *  （带图发送同样是 default + ref_file_ids，由网页自行路由）。 */
export const MODEL_TYPES_BY_UI = Object.freeze({
  classic: Object.freeze({ deepseek: 'expert' }),
  unified: Object.freeze({ deepseek: 'default' }),
});
export function expectedModelType(modelId, ui = 'classic') {
  return (MODEL_TYPES_BY_UI[ui] ?? MODEL_TYPES_BY_UI.classic)[modelId] ?? null;
}

/** 一次发送后对 /api/v0/chat/completion 请求体元数据的期望（strict 核验用）。
 *  返回的键若为 null/undefined 则不校验；unified 下 flash/deepseek 的差异
 *  全在 thinking_enabled，model_type 恒为 default。 */
export function expectedRequestMetadata(modelId, { ui = 'classic', wantThink = null } = {}) {
  const model_type = expectedModelType(modelId, ui);
  // 新版统一 UI 下 model_type 恒为 default，模式差异只剩 thinking_enabled。
  if (ui === 'unified') return { model_type, thinking_enabled: wantThink === true };
  return { model_type };
}

const CJK_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
/**
 * 估算字符串的 token 数（纯函数，供 usage/"估算 vs 实测"展示）。
 * 旧实现按 字符数/4 估算，对中文严重低估（汉字≈0.7–1 token，英文≈0.25 token/字符），
 * 导致中文对话的进度/用量显示与网页真实消费差距很大。改为 CJK 约 0.7 tok、ASCII 约 0.25 tok，
 * 末尾 +10% 安全余量。
 */
export function estimateTokens(s) {
  const str = s ? String(s) : '';
  if (str.length === 0) return 0;
  let cjk = 0;
  for (const ch of str) if (CJK_RE.test(ch)) cjk++;
  const ascii = str.length - cjk;
  const base = cjk * 0.7 + ascii * 0.25;
  return Math.max(1, Math.ceil(base + base * 0.1));
}