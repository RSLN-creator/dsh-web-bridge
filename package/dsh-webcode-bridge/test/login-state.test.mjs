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

// ── ⑦ 三态不得再被「登录进度变量」同名覆盖（#60 真机缺陷）────────────────────
//
// ## 缺陷现场（真机）
//
// `status()` 里先算出三态 `loginState: (() => {...})()`，随后对象字面量里又写了
// 一句**简写** `loginState,` —— 那是模块级登录**进度**变量（idle / launching /
// waiting-for-login / …）的同名简写。JS 对象字面量后写者胜 ⇒ 三态被整个丢弃，
// 面板拿到的 `loginState` 恒为进度值（默认 'idle'），`verified-*` 从未到达界面。
//
// ## 判据（源码级，因为这个函数需要真浏览器才能实例化）
//
//   ① status() 里**不得**再出现 `loginState,` 简写（后写者覆盖三态的入口）；
//   ② status() 里 `loginState:` 属性必须**恰好一个**（三态 IIFE）；
//   ③ 进度变量改名 `loginPhase` 并在 status() 里透出；
//   ④ 三态 IIFE 的返回值只允许 verified-in / verified-out / uncertain。
function statusBody() {
  const start = SRC.indexOf('function status() {');
  const end = SRC.indexOf('async function profileCookies', start);
  assert.ok(start > 0 && end > start, '必须能定位 status() 的函数体（后续判据都依赖它）');
  return SRC.slice(start, end);
}
/** 剥掉整行 `//` 注释：判据只认代码，不把注释里提到的名字当成实现。 */
function stripLineComments(src) {
  return src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

test('⑦ status() 的 loginState 不得被登录进度变量覆盖（#60 根因）', () => {
  const code = stripLineComments(statusBody());
  // ① 简写 `loginState,` 是把三态覆盖掉的唯一入口——必须不存在。
  assert.ok(!/^\s*loginState,\s*$/m.test(code),
    'status() 里不得再出现对象简写 `loginState,`：那会把三态 IIFE 整个覆盖成进度值（#60）');
  // ② 三态属性必须恰好一个：多一个就说明又写了第二份口径。
  const stateKeys = (code.match(/(?:^|[,{\s])loginState\s*:/g) || []).length;
  assert.equal(stateKeys, 1, `status() 里 loginState: 属性必须恰好一个（实际 ${stateKeys} 个）`);
  // ③ 进度变量改名 loginPhase 并在 status() 里透出（面板/CLI 仍可读流程阶段）。
  assert.match(code, /^\s*loginPhase,\s*$/m,
    'status() 必须透出 loginPhase（登录流程阶段）；它与三态 loginState 是两个概念');
});

test('⑦b 登录进度变量必须是 loginPhase（全文件引用一起改）', () => {
  assert.match(SRC, /let loginPhase = 'idle'/, '模块级登录进度变量必须声明为 loginPhase');
  assert.ok(!/let loginState\b/.test(SRC), '不得再存在名为 loginState 的进度变量（会与三态同名）');
  assert.match(SRC, /loginPhase = s;/, 'openLogin 的进度上报必须写 loginPhase');
});

test('⑦c 三态 IIFE 的返回值只允许 verified-in / verified-out / uncertain', () => {
  const start = SRC.indexOf('loginState: (() => {');
  assert.ok(start > 0);
  const end = SRC.indexOf('})(),', start);
  const body = SRC.slice(start, end);
  const returns = [...body.matchAll(/return\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(returns)].sort(), ['uncertain', 'verified-in', 'verified-out'],
    `loginState 只可能是三种已验证/不确定结论，实际 return 值：${JSON.stringify(returns)}`);
});

// ── ⑧ index.js 必须转发 loginVerified（#60 修法的另一半）──────────────────
//
// browser-driver 算对了、index.js 中途丢掉，前端就永远拿不到「结论是否已核验」。
// 这与 accountName/avatarUrl 那次「后端算好、中间层丢掉、前端显示默认值」是同一
// 条老路，判据同样是源码级接线（驱动实例需要真浏览器才能跑）。
test('⑧ index.js 的站点状态行必须转发 loginVerified + loginPhase', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const indexSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8');
  assert.match(indexSrc, /loginVerified: s\.loginVerified === true/,
    'index.js 的已初始化站点状态行必须转发 loginVerified（否则 #60 的结论可信度到不了前端）');
  assert.match(indexSrc, /loginState: normalizeLoginState\(s\.loginState\), loginVerified: s\.loginVerified === true/,
    'loginVerified 必须紧跟 loginState 同一行转发：两者是同一份登录结论的「值」与「可信度」；'
    + 'loginState 必须经三态白名单归一（非法值 → uncertain，#60）');
  assert.match(indexSrc, /loginPhase: s\.loginPhase \?\? 'idle'/,
    '登录流程阶段 loginPhase 也要转发（与三态 loginState 是不同概念，缺了进度显示就没了）');
});

test('⑧b 全部站点状态行（index/web-control/bin）都必须是三态口径（F10/F11/F12）', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (rel) => readFileSync(join(here, '..', rel), 'utf8');
  const indexSrc = read('lib/index.js');
  const webSrc = read('lib/web-control.js');
  const binSrc = read('bin/bridge-standalone.js');
  // 未初始化槽（没有 driver 状态）只能如实「不确定」；'idle' 不是三态合法值。
  assert.match(indexSrc, /loginState: 'uncertain', loginVerified: false, loginPhase: 'idle'/,
    'index.js 未初始化槽行必须写 loginState:\'uncertain\' + loginVerified:false（#60 的合法三态值）');
  // F11：bin/bridge-standalone.js 是**第三份手写站点状态行**，#60 曾漏掉它。
  assert.match(binSrc, /loginState: 'uncertain', loginVerified: false, loginPhase: 'idle'/,
    'bin 未初始化槽行必须三态口径（F11）');
  assert.match(binSrc, /loginState: normalizeLoginState\(s\.loginState\), loginVerified: s\.loginVerified === true, loginPhase: s\.loginPhase \?\? 'idle'/,
    'bin 已初始化槽行必须转发三态 + 可信度 + 流程阶段（F11）');
  // F12：任何站点状态行的 loginState fallback 都不得写成 'idle'。
  for (const [name, src] of [['index.js', indexSrc], ['web-control.js', webSrc], ['bin/bridge-standalone.js', binSrc]]) {
    assert.ok(!/loginState: 'idle'/.test(src), `${name} 不得把 loginState fallback 写成 'idle'（F12）`);
    assert.ok(!/loginState: s\.?[\w?.]*\s*\?\?\s*'idle'/.test(src), `${name} 不得使用 \?\? 'idle' fallback（F12）`);
    assert.ok(!/loginState: s\.?loginState \|\| 'idle'/.test(src), `${name} 不得使用 || 'idle' fallback（F12）`);
  }
  // GET login-sites 两个分支都要转发三态 + 可信度 + 流程阶段（且经白名单归一）。
  assert.equal((webSrc.match(/loginState: normalizeLoginState\(s\?\.loginState\)/g) || []).length, 1,
    'login-sites 默认槽分支的 loginState 必须经白名单归一');
  assert.equal((webSrc.match(/loginState: normalizeLoginState\(s\.loginState\)/g) || []).length, 1,
    'login-sites 非默认槽分支的 loginState 必须经白名单归一');
  assert.equal((webSrc.match(/loginVerified: s\?\.loginVerified === true/g) || []).length, 1,
    'login-sites 默认槽分支必须转发 loginVerified');
  assert.equal((webSrc.match(/loginVerified: s\.loginVerified === true/g) || []).length, 1,
    'login-sites 非默认槽分支必须转发 loginVerified');
  assert.ok((webSrc.match(/loginPhase: s\??\.loginPhase \|\| 'idle'/g) || []).length === 2,
    'login-sites 两个分支都必须转发 loginPhase');
});

test('⑧c loginState 三态白名单归一：非法值一律 uncertain（N4）', async () => {
  const { normalizeLoginState } = await import('../lib/accounts.js');
  assert.equal(normalizeLoginState('verified-in'), 'verified-in');
  assert.equal(normalizeLoginState('verified-out'), 'verified-out');
  assert.equal(normalizeLoginState('uncertain'), 'uncertain');
  // 旧语义值（回归测试替身里还在用 'ready'）与任何未知值都只能落成不确定。
  for (const v of ['idle', 'ready', 'launching', '', null, undefined, 'PROBE-OK', 0, {}]) {
    assert.equal(normalizeLoginState(v), 'uncertain',
      `非法/旧语义值 ${JSON.stringify(v)} 必须归一成 uncertain（宽松方向只能是更不确定）`);
  }
});

// ── ⑩ ok 特征的**水合窗口**：judgeLoggedIn 不得只查一次 ok（F14 真机）────────
//
// ## 缺陷现场（kimi，2026-10-19 Wave2，零发送真机读数）
//
// 证据：`.tmp/live-2026-10-19/raw/wave2probe-2026-10-19T14-12-39.json`。
// kimi 落地页从 domcontentloaded 起 +1.16s/+1.58s/+1.61s：`span.user-name` 与
// `img.user-avatar` **count=0 visible=0**，而 composer 已可见；到 **+4.2s** 才
// `span.user-name` count1/visible1 text=TYZ0712、`img.user-avatar` 1/1。
// 旧实现只查一次 ok ⇒ 水合前必然 `probe-fallback`（= uncertain；Wave2 kimi 正是
// 此现场，**不是**声明错——#59 doubao 已 probe-ok 证明声明-同源没白做）。
//
// 判据（源码级；judgeLoggedIn 在 createBrowserDriver 闭包里，需要真浏览器才能跑）：
//   ① ok 分支必须存在**有界等待** `waitFor({state:'visible', timeout: 5_000})`；
//   ② 等待前提是 `visibleComposerCount(p) > 0`（SPA 壳已渲染、只是头部未水合）；
//   ③ 等待必须在一次 count() 快速路径**之后**（已登录常见路径零等待）；
//   ④ 窗口耗尽不得写成 `probe-bad`（那会把「没等到」谎报成「确认未登录」）。
test('⑩ judgeLoggedIn 的 ok 特征必须有水合窗口（F14：kimi +4.2s 才出现）', () => {
  const start = SRC.indexOf('async function judgeLoggedIn(p) {');
  const end = SRC.indexOf('async function captureChainAlive', start);
  assert.ok(start > 0 && end > start, '必须能定位 judgeLoggedIn 的函数体');
  const judge = SRC.slice(start, end).split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const okStart = judge.indexOf('if (probe?.ok) {');
  assert.ok(okStart > 0, 'judgeLoggedIn 必须有 probe.ok 分支');
  // ok 分支的边界：下一个顶层分支是「SPA 水合重探（bad）」，用它做右界。
  const okEnd = judge.indexOf('if (declared && probe?.bad', okStart);
  assert.ok(okEnd > okStart, 'ok 分支必须能定位到结尾（后面应有 bad 水合重探）');
  const okBlock = judge.slice(okStart, okEnd);
  assert.match(okBlock, /waitFor\(\{ state: 'visible', timeout: 5_000 \}\)/,
    'ok 分支必须有界等待账号特征出现（timeout 5_000ms；真机水合落在 1.6–4.2s）——'
    + '只查一次 count() 会让水合前的已登录页落到 probe-fallback（F14）');
  assert.match(okBlock, /visibleComposerCount\(p\) > 0/,
    '等待必须前置「composer 已可见」：否则每个未登录页都要白等 5s');
  const countIdx = okBlock.indexOf('.count()');
  const waitIdx = okBlock.indexOf('waitFor({ state: ');
  assert.ok(countIdx >= 0 && waitIdx > countIdx,
    '必须先走 count() 快速路径（已登录常见路径零等待），再进水合等待');
  assert.ok(!/probe-bad/.test(okBlock),
    '水合等待耗尽不得写成 probe-bad——「没等到」不等于「确认未登录」');
});

// ── ⑨ 登录特征选择器必须与账号身份探针**同源**（#59 / #65）───────────────
//
// ## 缺陷形状（真机）
//
//   · doubao：`loginProbe.ok` 是 `[class*="avatar"], .user-avatar, img[class*="avatar"]`
//     —— 真机命中 **0**（真实头像 class 不含 avatar 语义）；而同文件
//     `accountProbe.avatar` 的真机选择器命中 1 ⇒ 已登录豆包只能落到
//     `probe-fallback` = uncertain。
//   · kimi：`loginProbe` **只有 bad 没有 ok** ⇒ 已登录也永远是 uncertain。
//
// 判据是「同源」而不是「碰巧相等」：断言 `loginProbe.ok` 逐字等于 accountProbe
// 那一组字符串的拼接，并且源码里那份字面量只出现一次——手写第二份必红。
test('⑨ doubao loginProbe.ok 与 accountProbe.avatar 同源（#59）', async () => {
  const { DOUBAO } = await import('../lib/providers.js');
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const providersSrc = readFileSync(join(here, '..', 'lib', 'providers.js'), 'utf8');
  assert.ok(DOUBAO.loginProbe?.ok, 'doubao 必须声明 loginProbe.ok（否则已登录也判不确定）');
  assert.equal(DOUBAO.loginProbe.ok, DOUBAO.accountProbe.avatar.join(', '),
    'doubao loginProbe.ok 必须与 accountProbe.avatar 逐字同源（同一组真机选择器）');
  // **同一常量**引用（不只是碰巧相等）：源码里必须是 `avatar: DOUBAO_AVATAR_SELECTORS`
  // 与 `ok: DOUBAO_AVATAR_SELECTORS.join(', ')`——各写一份字面量迟早漂移。
  assert.match(providersSrc, /avatar: DOUBAO_AVATAR_SELECTORS\b/,
    'accountProbe.avatar 必须直接引用 DOUBAO_AVATAR_SELECTORS 常量（不得再抄一份字面量）');
  assert.match(providersSrc, /ok: DOUBAO_AVATAR_SELECTORS\.join\(', '\)/,
    'loginProbe.ok 必须由 DOUBAO_AVATAR_SELECTORS 派生（与 accountProbe 同一常量）');
  assert.ok(DOUBAO.loginProbe.ok.includes('img[src*="passport.byteacctimg.com/img/user-avatar"]'),
    'loginProbe.ok 必须含真机命中的头像 CDN 选择器（live c1v1）');
  assert.ok(!/class\*="avatar"/.test(DOUBAO.loginProbe.ok),
    '不得再退回真机命中 0 的 `[class*="avatar"]` 一族（#59 的原始缺陷）');
});

test('⑨b kimi loginProbe.ok 取 accountProbe 证据的**精确子集**（#65 live 读数）', async () => {
  const { KIMI } = await import('../lib/providers.js');
  assert.ok(KIMI.loginProbe?.ok, 'kimi 必须声明 loginProbe.ok（旧实现只有 bad）');
  // live 真机读数：ok 必须是精确子集 span.user-name + img.user-avatar（两者 c1v1）。
  const expected = [...KIMI.accountProbe.name, 'img.user-avatar'].join(', ');
  assert.equal(KIMI.loginProbe.ok, expected,
    'kimi loginProbe.ok 必须是 span.user-name, img.user-avatar 的精确子集');
  // ⚠ 宽串 avatar.moonshot.cn（live c3v3，命中侧栏插件图标）**不得**进登录判定；
  //   它只用于身份打分（accountProbe.avatar），这里同时钉住两件事。
  assert.ok(!KIMI.loginProbe.ok.includes('avatar.moonshot.cn'),
    'loginProbe.ok 不得含 img[src*="avatar.moonshot.cn"]：live c3v3 会命中侧栏插件图标 ⇒ 误判已登录');
  assert.ok(KIMI.accountProbe.avatar.includes('img[src*="avatar.moonshot.cn"]'),
    'accountProbe.avatar 应保留宽集合（live c3v3 仅用于身份打分，不用于登录判定）');
  for (const sel of ['span.user-name', 'img.user-avatar']) {
    assert.ok(KIMI.loginProbe.ok.includes(sel), `loginProbe.ok 必须含 live c1v1 选择器 ${sel}`);
  }
});

test('⑨c 同源选择器在 providers.js 源码里只允许有一份字面量（禁止第二份手写）', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const providersSrc = readFileSync(join(here, '..', 'lib', 'providers.js'), 'utf8');
  // 带引号的**代码字面量**计数（注释里用反引号，不算）。
  for (const literal of [
    "'img[src*=\"passport.byteacctimg.com/img/user-avatar\"]'",
    "'img.rounded-full.object-cover.select-none'",
    "'span.user-name'",
    "'img.user-avatar'",
    "'img[src*=\"avatar.moonshot.cn\"]'",
  ]) {
    const count = providersSrc.split(literal).length - 1;
    assert.equal(count, 1,
      `选择器字面量 ${literal} 在 providers.js 里出现了 ${count} 次——`
      + 'loginProbe 与 accountProbe 必须引用同一份常量，禁止各写一份（会漂移）');
  }
});