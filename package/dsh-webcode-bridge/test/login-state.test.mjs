// login-state.test.mjs — 登录状态三态的护栏（0.19.75，#53 窄口径）。
//
// ## 本条针对的真机缺陷
//
// 全新空 profile 上跑 `site-verify.mjs --site kimi`：
//   PASS login.loggedIn（basis=probe-fallback）+ BLOCKED send.text（NEED_LOGIN）
// 即「登录判定说已登录、真实发送路径说要登录」。真机 DOM 读数（Playwright locator）：
//   声明的 negative 特征命中 **0**、页面「登录」可见数 **0**、输入框**可见 1**
// ⇒ `judgeLoggedIn` 退回「有输入框 ⇒ 已登录」，把**没登录**显示成「已登录」。
//
// ## 为什么修法是「加第三态」而不是「收紧判定」
//
// 复审明确指出不必二选一。若改成「声明了 negative 特征却没命中 ⇒ 判未登录」，
// 那么站点改版导致特征失效时，**所有已登录用户**都会被判成未登录——把谎报换成误报。
// 第三态（uncertain）的意义正是两边都不说。
//
// ## 窄口径：只动 probe-fallback（不碰 input-fallback）
//
// DeepSeek 没有 loginProbe，其 basis 恒为 `input-fallback`（靠输入框回退是设计如此）。
// 若连这一档也降为不确定，主站点会长期显示「不确定」——那是可见的行为退化，
// 且与「DeepSeek 是唯一可整天长跑的站点」这一既有结论冲突。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'lib', 'browser-driver.js'), 'utf8');

/** 把 status() 里那段三态判定逐字取出来，在测试里**原样求值**（不是另写一份判据）。 */
function loginStateFn() {
  const start = SRC.indexOf('loginState: (() => {');
  assert.ok(start > 0, 'status() 里必须有 loginState 三态判定');
  const end = SRC.indexOf('})(),', start);
  assert.ok(end > start, 'loginState 的 IIFE 必须能定位到结尾');
  const body = SRC.slice(SRC.indexOf('{', start) + 1, end);
  // eslint-disable-next-line no-new-func
  return new Function('lastLoginBasis', 'cachedTrusted', 'cachedLogin', 'effectiveLoggedIn', body);
}

const fn = loginStateFn();
const state = (basis, loggedIn) => fn(basis, false, null, loggedIn);

test('① probe-fallback ⇒ 不确定（**不是**已验证登录）——这是 #53 的核心', () => {
  // 真机：声明了特征却一个都没命中，退回「有输入框」兜底 ⇒ 那是猜测。
  assert.equal(state('probe-fallback', true), 'uncertain',
    'probe-fallback 是猜测，不得报成 verified-in');
});

test('② probe-ok / probe-bad ⇒ 已核验（正向特征命中就是核验结果）', () => {
  assert.equal(state('probe-ok', true), 'verified-in');
  assert.equal(state('probe-bad', false), 'verified-out');
});

test('③ input-fallback **保持原语义**（DeepSeek 的路径，不得被本修改变成不确定）', () => {
  // 窄口径的关键：DeepSeek 没有 loginProbe，basis 恒为 input-fallback。
  // 若这一档也降为 uncertain，主站点面板会长期显示「不确定」。
  assert.equal(state('input-fallback', true), 'verified-in',
    'DeepSeek 的 input-fallback 路径必须保持「已验证登录」');
  assert.equal(state('input-fallback', false), 'verified-out');
});

test('④ 未知 basis 与 stale/null 一律落进 uncertain（不得落进「已验证」）', () => {
  // 宽松方向只能是「更不确定」——未知值绝不能被当成核验通过。
  for (const b of ['stale', null, '', 'typo-basis', 'PROBE-OK']) {
    assert.equal(state(b, true), 'uncertain', `basis=${JSON.stringify(b)} 必须是不确定`);
  }
});

test('⑤ 不确定时 loggedIn 本身**不**被改成 false（避免把已登录用户误判为未登录）', () => {
  // 这是「三态」而不是「收紧判定」的判据：第三态只影响**呈现**，不改发送行为。
  // 驱动层仍按原样把 loggedIn 交给 status()，needLogin 仍由 loggedIn===false 决定。
  assert.match(SRC, /needLogin: effectiveLoggedIn === false,/,
    'needLogin 必须仍然只看 loggedIn，不得被三态改写（否则会拦下本来能用的会话）');
});

test('⑥ loginVerified 与 loginState 必须自洽（verified-* ⇔ loginVerified=true）', () => {
  const start = SRC.indexOf('loginVerified: (() => {');
  assert.ok(start > 0, 'status() 里必须有 loginVerified');
  const end = SRC.indexOf('})(),', start);
  const body = SRC.slice(SRC.indexOf('{', start) + 1, end);
  // eslint-disable-next-line no-new-func
  const verifiedFn = new Function('lastLoginBasis', 'cachedTrusted', 'cachedLogin', 'effectiveLoggedIn', body);
  for (const [basis, loggedIn] of [
    ['probe-ok', true], ['probe-bad', false], ['input-fallback', true], ['input-fallback', false],
    ['probe-fallback', true], ['stale', true], [null, true],
  ]) {
    const st = state(basis, loggedIn);
    const vf = verifiedFn(basis, false, null, loggedIn);
    assert.equal(vf, st !== 'uncertain',
      `basis=${basis} loggedIn=${loggedIn}：loginVerified=${vf} 与 loginState=${st} 不自洽`);
  }
});