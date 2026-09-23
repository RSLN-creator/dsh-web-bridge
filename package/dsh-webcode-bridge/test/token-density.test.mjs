// token-density.test.mjs — 0.19.4 护栏：token 估算**绝不低估**（用户指令「保险往高报」）。
//
// ## 为什么这条护栏必须拿真实数据当判据
//
// 用户原话：「计费token的问题--关于真实计费，做不到就保险往高报」「你拿着官方的真实数据
// 验证增加」。因此这里不做「系数等于某个数」这种自证式断言（改代码时随手改断言就绿了），
// 而是把**官方端点实测出来的 token 数**写进判据：同一段文本，桥的估算必须 ≥ 实测。
// 这是「绝不低估」唯一可失败的形状。
//
// 实测（2026-09-23，`https://api.deepseek.com/anthropic/v1/messages`，model=deepseek-chat，
// max_tokens=1，带随机 nonce 前缀并取 input+cache_read；方法与陷阱见
// doc/research/2026-09-23-token-density-calibration.md）：
//
// | 样本 | 实测 input_tokens |
// | --- | --- |
// | 纯中文技术散文 | 104 |
// | 纯英文技术散文 | 96 |
// | 中英混排 | 76 |
// | 源码 JS | 283 |
// | JSON 协议 | 117 |
// | 数字与符号 | 120 |
//
// 注意：实测值里含那枚 ~10 字符 nonce 的开销，所以判据比「纯样本」更严一档。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens, TOKEN_DENSITY } from '../lib/metrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/** 与标定探针逐字相同的六类样本（改这里就必须重跑标定，否则判据失去意义）。 */
const MEASURED = [
  { name: '纯中文技术散文', tokens: 104, text: '网页桥接的核心问题不是把请求发出去，而是让模型在长会话里持续守住工具调用的形状。一旦形状漂移，桥会把整段协议原文扣住，界面只留一行进度说明。'.repeat(2) },
  { name: '纯英文技术散文', tokens: 96, text: 'The core problem of a web bridge is not sending the request but keeping the model on the taught tool-call shape across a long session. When the shape drifts, the bridge withholds the whole protocol region.'.repeat(2) },
  { name: '中英混排', tokens: 76, text: '桥 relay.js 的 busy flag 是 single-slot executor，所以 queue 会 serialize 所有 requests；这解释了为什么 two accounts cannot run concurrently。'.repeat(2) },
  { name: '源码 JS', tokens: 283, text: 'export function estimateTokens(s) {\n  const str = s ? String(s) : \'\';\n  if (str.length === 0) return 0;\n  let cjk = 0;\n  for (const ch of str) if (CJK_RE.test(ch)) cjk++;\n  const ascii = str.length - cjk;\n  return Math.ceil(cjk * 0.7 + ascii * 0.25);\n}\n'.repeat(3) },
  { name: 'JSON 协议', tokens: 117, text: JSON.stringify({ mcp_action: 'call', name: 'pwsh', arguments: { command: 'Get-Process', description: 'List running processes' } }).repeat(4) },
  { name: '数字与符号', tokens: 120, text: '1234567890 !@#$%^&*()_+-=[]{};:\'",.<>/?\\|`~ '.repeat(4) },
];

test('① 绝不低估：六类实测样本上，估算必须 ≥ 官方实测 token 数', () => {
  for (const s of MEASURED) {
    const est = estimateTokens(s.text);
    assert.ok(est >= s.tokens,
      `${s.name}：估 ${est} < 实测 ${s.tokens}（${(est / s.tokens).toFixed(2)}×）——` +
      '低估就是与用户口径「保险往高报」相反，必须提高对应类别的系数');
  }
});

test('② 旧口径的具体漏口被钉住：代码/JSON/标点不得再按「英文散文」单价算', () => {
  // 旧实现把非 CJK 一律按 0.25：源码与标点因此被低估 33%–63%（见标定文档 §4）。
  // 这里用「同一段标点文本的估算必须明显高于旧口径」把那个漏洞钉成可失败的判据。
  const punct = '!@#$%^&*()_+-=[]{};:\'",.<>/?'.repeat(8);
  const oldStyle = Math.ceil(punct.length * 0.25 * 1.1);
  const now = estimateTokens(punct);
  assert.ok(now > oldStyle * 1.5,
    `标点类估算 ${now} 必须显著高于旧口径 ${oldStyle}（否则第三类单价形同没加）`);
  // 反向也要钉：散文不该被第三类误伤成高单价。
  const prose = 'The quick brown fox jumps over the lazy dog and keeps running across the field. '.repeat(4);
  assert.ok(estimateTokens(prose) < Math.ceil(prose.length * 0.45),
    '英文散文不得被按符号单价计（否则读数虚高、压缩被提前触发）');
});

test('③ 系数是一份可核对的公开常量（不是散在代码里的字面量）', () => {
  assert.deepEqual({ ...TOKEN_DENSITY }, { cjk: 0.75, word: 0.3, other: 0.7, margin: 0.1 });
  assert.ok(TOKEN_DENSITY.other > TOKEN_DENSITY.word, '符号类单价必须高于散文类（实测差 2.9 倍）');
  assert.ok(TOKEN_DENSITY.cjk >= 0.74, 'CJK 系数不得低于实测 0.74');
});

test('④ 基本性质：空串 0、非空至少 1、单调不减', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens('a'), 1);
  const base = '桥 bridge 123 !@#';
  let prev = 0;
  for (let i = 1; i <= base.length; i += 1) {
    const n = estimateTokens(base.slice(0, i));
    assert.ok(n >= prev, '更长的前缀不得估出更少的 token');
    prev = n;
  }
});

test('⑤ 固定开销接在四个出口上（口径只能有一份）', () => {
  const idx = fs.readFileSync(path.join(repoRoot, 'lib', 'index.js'), 'utf8');
  const front = fs.readFileSync(path.join(repoRoot, 'lib', 'openai.js'), 'utf8');
  assert.match(idx, /usageFixedOverheadTokens: 2048/, 'DEFAULTS 必须声明这笔开销（否则「可配置」只对了一半）');
  assert.match(idx, /function usageOverheadTokens\(\)/, '适配器侧取值必须收在唯一一处');
  assert.equal((idx.match(/usageOverheadTokens\(\)/g) || []).length >= 3, true,
    '会话累计与无会话键单轮两条路径都要计入');
  assert.match(front, /const usageOverhead = \(\) =>/, 'OpenAI 前端必须有同源取值');
  assert.equal((front.match(/\+ usageOverhead\(\)/g) || []).length, 4,
    'OpenAI 前端两处 usage（流式/非流式）各含 prompt 与 total 两项');
});
