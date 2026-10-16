// comparison-view.test.mjs — 对比视图 XSS 防护护栏（0.19.92）。
//
// 0.19.92 之前：`renderComparisonView` 产出的页内 `createColumn()` 把账号 `label`
// （用户可影响的站点昵称）与 `key` **直接**拼进 `<option>` 的 `innerHTML` 模板，
// 未做 HTML 转义 ⇒ 含 `<`/`>` 的昵称会被浏览器当标签解析，构成存储型 XSS 面
// （该 HTML 经 `/__webcode/comparison` 原样返回）。见 doc/security-review.md §6.3.1。
//
// 判据口径（与 `captcha-gate.test.mjs` ④b 同款「源码级」护栏）：
// `escapeHtml` 是页内函数（模板字符串里），无法直接 import，因此这里只钉**可观测
// 的源码事实**——`createColumn` 拼 `<option>` 的模板必须经过 `escapeHtml(...)`，
// 不得出现把 `label`/`key` 裸拼进 innerHTML 的形态。这种护栏只能证明「转义在场」，
// 不能证明「转义在浏览器里真的执行」——后者是本仓库一贯承认的边界，不在此冒充。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderComparisonView } from '../lib/comparison-view.js';

/** 造一个含 HTML 元字符的昵称，模拟恶意 label。 */
function hostileSlots() {
  const m = new Map();
  m.set('evil', [{ slot: '1', label: '<img src=x onerror=alert(1)>"Bob&' }]);
  return m;
}

test('createColumn 的 <option> 拼接必须经过 escapeHtml（label 与 key 都转义）', () => {
  const html = renderComparisonView({ allSlots: hostileSlots() });
  // 页内模板里 `<option>` 的两个变量都必须是 escapeHtml(...) 包装后的形态。
  assert.match(html, /escapeHtml\(a\.key\)/);
  assert.match(html, /escapeHtml\(a\.label\)/);
});

test('不得存在把 label/key 裸拼进 innerHTML 的旧形态', () => {
  const html = renderComparisonView({ allSlots: hostileSlots() });
  // 旧缺陷形态：`>${a.label}<`（label 前有 `>` 且后无转义）。修复后该处是 `>${escapeHtml(a.label)}<`。
  assert.doesNotMatch(html, />\$\{a\.label\}</);
  assert.doesNotMatch(html, /value="\$\{a\.key\}"/);
});

test('renderComparisonView：无账号时不抛错、仍产出完整 HTML 骨架', () => {
  const html = renderComparisonView({ allSlots: new Map() });
  assert.equal(typeof html, 'string');
  assert.ok(html.includes('对比视图'));
  assert.ok(html.includes('allAccounts'));
});
