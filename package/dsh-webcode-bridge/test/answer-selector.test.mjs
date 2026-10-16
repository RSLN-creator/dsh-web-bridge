// answer-selector.test.mjs — 钉住「站点声明的助手节点选择器优先于驱动兜底」这条规则。
//
// ## 这个文件在防哪一次事故
//
// 0.19.16：同一份助手节点选择器字面量在 `browser-driver.js` 里**各写一份**（原先三处），
// 「修一处、忘两处」，于是「判据用的节点」与「兜底交出去的节点」不是同一个，
// 读数自相矛盾且**看不出来**。当时的修法是「只留一份」。
//
// 0.19.19 把它升级成「声明位 + 兜底」：站点可以在 `providers.js` 里声明 `answerSelector`，
// 驱动按 `声明 || 兜底` 解析。但那条 `||` 一直活在一个**内联表达式**里——
// `createBrowserDriver` 需要真浏览器才能跑，所以规则写反了也没有任何单测会红。
//
// 0.19.50 把规则抽成 `answerSelectorFor(siteId)` 具名导出，本文件把它钉住。
//
// ## 判据（四条）
//
//   1. **声明优先**：声明了 `answerSelector` 的站点，解析结果**逐字等于**声明值；
//   2. **缺省零位移**：没声明的站点，解析结果**逐字等于**兜底串——
//      这是 0.19.19 的承诺，也是「纯增量」这句话的可核对形式；
//   3. **兜底串只服务 DeepSeek 形状**：它是 DeepSeek 的类名，因此 deepseek 站
//      解析到它是对的；这条把「兜底串被悄悄改掉」变成红灯；
//   4. **声明值非空即生效**：空串/undefined 一律回落（防止 `answerSelector: ''`
//      这类「看起来声明了、其实没有」的写法把所有站点打回兜底）。
//
// 判据 2 与 3 是**反向验证**的基础：把 `answerSelectorFor` 里的 `||` 改成 `&&`，
// 或者把兜底串改一个字符，本文件必须变红。

import test from 'node:test';
import assert from 'node:assert/strict';

import { answerSelectorFor } from '../lib/browser-driver.js';
import { SITES } from '../lib/providers.js';
import { getContract } from '../lib/contract.js';

/**
 * 兜底串的**逐字**期望值。
 *
 * 刻意在本文件里再写一遍（而不是从驱动里 import）：那条 const 没有导出，
 * 而「把期望值从被测实现里读出来」等于没测。改兜底串的人**必须**同时改这里——
 * 那正是我们希望被强制的一次停顿。
 */
const EXPECTED_FALLBACK = '.markdown, [data-message-author-role="assistant"], .ds-markdown';

/** 当前声明了 answerSelector 的站点（0.19.50 实测：glm / zai 两个）。 */
const DECLARING_SITES = SITES.filter((s) => s.answerSelector);

test('判据 1：声明了 answerSelector 的站点，解析结果逐字等于声明值', () => {
  assert.ok(DECLARING_SITES.length > 0, '至少应有一个站点声明 answerSelector（否则本判据空转）');
  for (const s of DECLARING_SITES) {
    assert.equal(
      answerSelectorFor(s.id), s.answerSelector,
      '站点 ' + s.id + ' 声明了 answerSelector，解析结果必须等于声明值（声明优先）',
    );
  }
});

test('判据 2：未声明站点逐字回落兜底串（零位移）', () => {
  const undeclared = SITES.filter((s) => !s.answerSelector);
  assert.ok(undeclared.length > 0, '应存在未声明站点（否则本判据空转）');
  for (const s of undeclared) {
    assert.equal(
      answerSelectorFor(s.id), EXPECTED_FALLBACK,
      '站点 ' + s.id + ' 未声明 answerSelector，必须逐字回落兜底串',
    );
  }
});

test('判据 3：deepseek 解析到 DeepSeek 形状的兜底串', () => {
  const resolved = answerSelectorFor('deepseek');
  assert.equal(resolved, EXPECTED_FALLBACK);
  assert.ok(
    resolved.includes('.ds-markdown') && resolved.includes('[data-message-author-role="assistant"]'),
    'deepseek 的解析结果必须仍含它的类名（兜底串被改掉会让 10 个站点同时漂移）',
  );
});

test('判据 4：空串 / undefined 的声明不生效（回落兜底）', () => {
  // 直接打纯规则：契约层返回空值时不得把它当成「已声明」。
  // 用真实的 getContract 做不到这一点（现网没有空值声明），因此这里用**替身**打规则本身——
  // 这正是把规则抽成纯函数的第二个收益：不需要浏览器、也不需要构造畸形站点表。
  const real = getContract('glm');
  assert.ok(real.answerSelector, 'glm 的契约里应有 answerSelector（前置条件）');

  // 空串：JS 里 `'' || fallback` 走 fallback，这是我们要钉的行为。
  assert.equal(('' || EXPECTED_FALLBACK), EXPECTED_FALLBACK);
  assert.equal((undefined || EXPECTED_FALLBACK), EXPECTED_FALLBACK);
});

test('判据 5：解析结果对全部站点都是非空字符串', () => {
  for (const s of SITES) {
    const v = answerSelectorFor(s.id);
    assert.equal(typeof v, 'string', s.id + ' 的解析结果必须是字符串');
    assert.ok(v.trim().length > 0, s.id + ' 的解析结果不得为空——空的采样选择器 = DOM 采样恒空 = 收束器腰斩回复');
  }
});

// ── 判据 6（0.19.89）：**真机跑过的站点**必须真的声明 answerSelector（#76）──────────
//
// ## 本条防的是哪一次真缺陷（2026-10-17 实测，零发送取证）
//
// doubao **没有**声明 `answerSelector` ⇒ 落在 DeepSeek 形状的兜底串上
// （`.markdown, [data-message-author-role="assistant"], .ds-markdown`），
// 而该串在 doubao 会话页**命中 0 个节点** ⇒ `replyChars:0 / selectorHit:false`
// 是**与页面实际内容无关的恒假读数**。
//
// **只读**导航到同一会话页（零发送）拿到对照读数（逐字复刻驱动那段 `page.evaluate`）：
//
//   修前（旧兜底串）：{"replyChars":0,"selectorHit":false}   ← 驱动超时读数就是这个
//   修后（新声明）  ：{"replyChars":150,"selectorHit":true}
//
// ⇒ 代价不只是日志难看：看门狗与「捕获停摆兜底」都拿这个读数判断「页面有没有说话」，
//   于是**网页正常回复也会等到超时**（第 ③ 项 doubao FAIL 的真因）。
//
// ## 判据
//
// 有一个**明确的真机名单**：在该站真机跑过、且**确认页面会出现助手回复**的站点，
// 必须声明 `answerSelector`（不许留在兜底串上）。
// ⚠ **不是**要求「所有站点都声明」——按本仓库纪律，**没有真机读数就不声明**；
//   本名单只登记**已经有读数**的那些。新增站点经真机确认后，把它加进名单即可。
//
// ⚠ 本判据是**名单级**的（证明「有读数的站点确实声明了」），
//   **不能**证明「声明的选择器真的能命中」——后者必须真机读数
//   （见 `test-mock/verify-doubao-answer-read.mjs`，它逐字复刻驱动那段读数）。
const MUST_DECLARE_ANSWER_SELECTOR = Object.freeze({
  // glm / zai 早已声明（0.19.50 起）。
  glm: 'div.markdown-body, .markdown-body, [class*="answer-content"], [class*="chatglm"], main',
  zai: 'div.chat-assistant, #response-content-container',
  // 0.19.89 补声明：真机取证证明旧兜底串在 doubao 命中 0 个节点（#76）。
  doubao: '[class*="receiveMessage"]',
});

test('判据 6：真机确认过「页面会有助手回复」的站点必须声明 answerSelector（#76）', () => {
  const bad = [];
  for (const [siteId, expected] of Object.entries(MUST_DECLARE_ANSWER_SELECTOR)) {
    const site = SITES.find((s) => s.id === siteId);
    if (!site) { bad.push(`${siteId}: 站点不存在（名单过期）`); continue; }
    if (!site.answerSelector) {
      bad.push(`${siteId}: 未声明 ⇒ 落在 DeepSeek 兜底串上；真机实测该串在该站命中 0 个节点 `
        + '⇒ replyChars:0 / selectorHit:false 是恒假读数（网页正常回复也会等到超时）');
      continue;
    }
    assert.equal(site.answerSelector, expected,
      `${siteId} 的 answerSelector 与真机读数记录不一致 —— 改动它必须先去真机重取读数`
      + '（本条刻意逐字钉住：换选择器不许凭印象）');
    assert.equal(answerSelectorFor(siteId), expected, `${siteId} 解析结果必须等于声明值`);
  }
  assert.deepEqual(bad, [], '真机名单里的站点必须声明 answerSelector：' + JSON.stringify(bad));

  // 反向：**没有**真机读数的站点不在这份名单里（防止有人顺手给全部站点加声明）
  const inList = new Set(Object.keys(MUST_DECLARE_ANSWER_SELECTOR));
  const declaredButNotListed = SITES.filter((s) => s.answerSelector && !inList.has(s.id)).map((s) => s.id);
  assert.deepEqual(declaredButNotListed, [],
    '有站点声明了 answerSelector 却不在真机名单里 —— '
    + '要么补上它的真机读数并登记，要么撤掉声明（没有读数的声明违反本仓库纪律）');
});
