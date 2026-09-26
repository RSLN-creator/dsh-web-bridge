// real-glm-e2e.mjs — GLM 真机端到端（用户要求「真实允许测试 glm」），0.19.18。
//
// ## 为什么必须走 adapter.stream 而不是直接调 driver.sendTurn
//
// 首版直接 `driver.sendTurn()` 立刻失败：
//     WEB_SESSION_LOST: 会话槽为空（site=glm，no-stored-session）
// 原因**不是 GLM 坏了**，而是我绕过了会话槽机制——`driver.sendTurn` 期望调用方
// 已经知道该用哪个网页会话；而「会话槽为空时该整段重建（fresh）」这条策略住在
// `lib/index.js` 的适配器层，不在驱动里。绕过它就等于绕过了「首轮自动 fresh」这一支。
//
// 正确路径 = 生产路径：`apply()` 装插件 → `adapter.stream()` 发一轮。
// 这条路会：建会话槽 → 首轮 fresh → 教协议 → 发消息 → 捕获 → 解码 → 回正文。
//
// ## 会用真实额度
//
// 本轮真的往 chatglm.cn 发一条消息。提示词取最小：「只回答一个数字」。
// 不调工具，只验证「能不能拿到正文」——这是 GLM 适配的最小可用判据。
//
// 用法：node test-mock/real-glm-e2e.mjs
import { apply } from '../lib/index.js';

const MODEL = process.env.E2E_MODEL || 'glm:glm-5.3-flash';
const PROMPT = process.env.E2E_PROMPT || '只回答一个数字：1+1 等于几？';
const say = (...a) => console.log(...a);

let adapter;
const dispose = apply(
  { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null },
  { port: 0, requireConsent: false },
);

const t0 = Date.now();
let ok = false;
try {
  say(`[开始] model=${MODEL} ${new Date().toISOString()}`);
  const chunks = [];
  let thinkChars = 0;
  for await (const c of adapter.stream({
    sessionId: 'e2e-glm-' + Date.now(),
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
  })) {
    chunks.push(c);
    if (c.type === 'text-delta') process.stdout.write('.');
    if (c.type === 'reasoning-delta') { thinkChars += (c.text || '').length; process.stdout.write('~'); }
  }
  say('');
  const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  const blocks = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'text').map((c) => c.block.text).join('');
  const think = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('');
  const fin = chunks.at(-1);

  say(`[结果] text-delta=${deltas.length} 字  正文块=${blocks.length} 字  思考=${think.length} 字`);
  say(`[正文] ${JSON.stringify(deltas.slice(0, 400))}`);
  if (think) say(`[思考尾部] ${JSON.stringify(think.slice(-200))}`);
  say(`[收尾] ${JSON.stringify(fin)}`);

  // 判据：拿到非空正文即算「GLM 真机可产出正文」。
  // 不用「内容必须等于 2」——那是在测模型，不是在测桥。
  ok = deltas.trim().length > 0;
  say('\n[判定] ' + (ok ? 'PASS — GLM 真机可产出正文' : 'FAIL — 正文为空'));
} catch (err) {
  say(`\n[异常] code=${err?.code ?? '-'} message=${String(err?.message || err).slice(0, 600)}`);
} finally {
  try { await dispose(); } catch {}
  say(`[耗时] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!ok) process.exitCode = 1;
}
