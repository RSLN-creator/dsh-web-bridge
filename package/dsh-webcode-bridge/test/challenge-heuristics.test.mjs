// challenge-heuristics.test.mjs — 人机验证词表真源的可执行护栏（0.19.83）。
//
// ## 为什么必须给「一份词表」单独写测试
//
// 词表本身是**自然语言指纹**，它最典型的失效形态不是「报错」，而是**悄悄不再匹配**
// ——那时它会一路 PASS，看起来比谁都干净（本仓库对
// `check-long-term-issues.mjs` 的 `--self-test` 记过同一条立场）。
//
// 而且 #63 的教训正是「词表写在内联 `page.evaluate` 里」：那样它**无法被驱动**，
// 护栏只能查「源码里有没有某个字符串」。本文件直接 `import` 真源并断言行为，
// 因此改坏词表（删掉 doubao 那句、或给正则加上 `g`）都会当场变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHALLENGE_BODY_PATTERN,
  CHALLENGE_TITLE_PATTERN,
  CHALLENGE_HTML_PATTERN,
  CHALLENGE_PATTERN_SOURCES,
  looksLikeChallengeText,
} from '../lib/challenge-heuristics.js';

const PKG = path.join(import.meta.dirname, '..');

// ── ① doubao 图片选择式（#63 的修复靶子，真机原文逐字）──────────────────────

test('① doubao 真机原文必须命中（#63 的靶子，逐字取自真机截图）', () => {
  // 真机 doubao 页面文案（doc/long-term-issues.md #63 逐字）
  const doubao = '常见于森林的生态元素\n请选择所有符合上文描述的图片，并拖拽到下方\n提交';
  assert.equal(looksLikeChallengeText(doubao), true,
    'doubao 图片选择式验证的原文必须命中——这正是 #63 修复要拦的形态');
  // 拆开成两个片段也各自要命中（页面上它们可能分两行渲染）
  assert.equal(looksLikeChallengeText('请选择所有符合上文描述的图片'), true);
  assert.equal(looksLikeChallengeText('并拖拽到下方'), true);
});

test('①b 反向：正常正文绝不命中（否则每轮都会误报「需要人机验证」）', () => {
  for (const normal of [
    '你好，请介绍一下你自己。',
    '这是一段普通回复，讲了几个要点：第一……第二……',
    '请选择所有你喜欢的颜色，然后告诉我。',   // ★ 含「请选择所有」但**不含**「符合」⇒ 不得命中
    '谢谢，我会按你说的做。',
    '',
  ]) {
    assert.equal(looksLikeChallengeText(normal), false, `正常正文被误判：${JSON.stringify(normal)}`);
  }
});

// ── ② 合并前的两条清单逐条核对（不许合并时丢条）───────────────────────────────

test('② 合并前 detectChallenge 的 body 词表逐条仍在（不许合并时丢条）', () => {
  // 这些是 0.19.83 合并**之前** `browser-driver.js` 内联 body 正则里的条目，
  // 合并到唯一真源时逐条核对过。少一条就等于那一类风控页又变成「超时」。
  const before = [
    '访问验证', '请按住滑块', '拖动到最右边', '向右拖动滑块', '拖动滑块完成验证',
    '请完成下方验证', '请点击下方图形', '请依次点击', '操作过于频繁',
    '系统繁忙，请稍后再试', '访问受限', '请求过于频繁', '验证码错误',
  ];
  for (const w of before) {
    assert.ok(CHALLENGE_BODY_PATTERN.test(w), `合并时丢了词条「${w}」——那一类页面会退回「超时」报错`);
  }
  // 合并**新增**的（#63 的靶子）
  for (const w of ['请选择所有符合', '请选择符合', '并拖拽到下方', '请按顺序点击', '完成验证后继续']) {
    assert.ok(CHALLENGE_BODY_PATTERN.test(w), `#63 新增词条「${w}」缺失`);
  }
});

test('②b 标题与脚本指纹也必须保留（导航期 detectChallenge 用它们）', () => {
  for (const t of ['滑动验证页面', '访问验证', '安全验证', '人机验证', '系统安全验证']) {
    assert.ok(CHALLENGE_TITLE_PATTERN.test(t), `标题词条「${t}」缺失`);
  }
  for (const h of ['CF_APP_WAF', 'aliyun_waf', '_waf_abc123', 'baxia-punish', 'geetest',
    'TencentCaptcha', 'sec_def_pc', 'cf-turnstile']) {
    assert.ok(CHALLENGE_HTML_PATTERN.test(h), `脚本指纹「${h}」缺失（那一类风控页会漏）`);
  }
});

// ── ③ 正则不得带 g/y —— 这条是「会交替返回真假」的硬约束 ──────────────────────

test('③ ★ 三条正则都不得带 g / y 标志（page.evaluate 里会被多次 test）', () => {
  // 依据：本仓库记过同型缺陷——同一个正则对象在页面上下文里被多次 `test()` 时，
  // 带 `g` 会因 `lastIndex` 递进而**交替返回真假**，于是「第一拍命中、第二拍不命中」。
  // 词表要在同一个 evaluate 里被 `test` 多次（body 一次、title 一次），
  // 且驱动会跨调用复用这两个 source ⇒ 必须无状态。
  for (const [name, re] of [['body', CHALLENGE_BODY_PATTERN], ['title', CHALLENGE_TITLE_PATTERN], ['html', CHALLENGE_HTML_PATTERN]]) {
    assert.ok(!re.global, `${name} 模式带了 g 标志：多次 test 会因 lastIndex 交替返回真假`);
    assert.ok(!re.sticky, `${name} 模式带了 y 标志：同上`);
  }
  // 直接行为断言：同一个正则连测 8 次，结果必须**恒定**
  const text = '请选择所有符合上文描述的图片';
  for (let i = 0; i < 8; i++) {
    assert.equal(looksLikeChallengeText(text), true, `第 ${i + 1} 次调用结果变了 ⇒ 正则有状态`);
  }
});

// ── ④ 接线：驱动必须吃这个真源，而不是自己再内联一份 ──────────────────────────

test('④ 驱动必须接线到本真源（不许再内联第二份词表）', () => {
  const DRIVER = fs.readFileSync(path.join(PKG, 'lib', 'browser-driver.js'), 'utf8');
  assert.match(DRIVER, /from '\.\/challenge-heuristics\.js'/,
    '驱动没有 import challenge-heuristics：词表真源是死的');
  assert.match(DRIVER, /CHALLENGE_PATTERN_SOURCES/,
    '驱动必须用 CHALLENGE_PATTERN_SOURCES（把 source 传进页面侧重建）');
  // 反向：驱动的**代码**里不得再出现这些词条的字面量（出现即意味着有人又内联了一份
  // → 两处必然漂移，正是 #63 的成因）。
  // ⚠ 必须剥掉**注释**（`//` 行与 `/* … */` 块）再判：驱动的注释里逐字引用了 doubao
  //   真机原文与 GLM 滑块页文案来解释为什么要修（本仓库的注释纪律要求如此），
  //   对原文匹配会把那些**证据引用**当成违规。护栏判**代码**，不判注释里的证据。
  const DRIVER_CODE = DRIVER
    .replace(/\/\*[\s\S]*?\*\//g, '')                       // 块注释（含 JSDoc）
    .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const w of ['请选择所有符合', '并拖拽到下方', '请按住滑块', '拖动滑块完成验证']) {
    assert.ok(!DRIVER_CODE.includes(w),
      `驱动的**代码**里又内联了词条「${w}」——词表只能有一份（challenge-heuristics.js）`);
  }
});

test('④b 传参必须是**单对象**，且页面侧用局部变量而非 `PAT.body`（driver-scope 边界）', () => {
  const DRIVER = fs.readFileSync(path.join(PKG, 'lib', 'browser-driver.js'), 'utf8');
  // ⚠ **0.19.87 后本条的形状变了，原因必须读**（#75）：
  //   原先页面侧是**多个裸形参**（`(sel, patBody, patTitle)`），调用点按位置传三个值——
  //   而那正是 #75：Playwright 的 `evaluate` **只接受一个 arg**，传 3 个值**同步抛**
  //   ⇒ 被 `.catch` 吞 ⇒ **那段判据从未运行**（真机复验因此既没命中、也没打 probe）。
  //   ⇒ 现在改为**单对象**传参（契约内唯一的多值形态），页面侧从那个对象取字段转成**局部变量**
  //   （转局部变量是为了不触发 `driver-scope` 扫描器对 `X.prop` 的自由标识符判定——见 #72）。
  //
  // 本条现在判两件事（都在**对象形态**下）：
  //   ① 页面侧不得直接写 `o.patBody` 当**构造正则的基对象**——用局部变量更清楚，也避开扫描器；
  //   ② 调用点必须是**单个对象**（不是三个按位置传的值）——这条才是 #75 的防回归核心。
  const cbStart = DRIVER.indexOf('return frame.evaluate((o) => {');
  assert.ok(cbStart > 0, '找不到超时点那个页面侧回调（应形如 `frame.evaluate((o) => {`，单对象实参）');
  const cbEnd = DRIVER.indexOf('}, {', cbStart);
  assert.ok(cbEnd > cbStart, '找不到回调体结束位置（应紧跟单对象实参 `}, {`）');
  const cbSeg = DRIVER.slice(cbStart, cbEnd);
  // 剥掉注释再判（注释里会逐字提到这些名字，不剥会把解释当违规——记过 4 次）
  const cbCode = cbSeg.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  // ① 回调体里必须**先用局部变量**接住字段，再用裸名构造正则
  assert.match(cbCode, /const patBody = o\.patBody;/, '页面侧必须先把 o.patBody 接成局部变量');
  assert.match(cbCode, /const patTitle = o\.patTitle;/, '页面侧必须先把 o.patTitle 接成局部变量');
  assert.match(cbCode, /new RegExp\(patBody\)/, '必须用局部变量 patBody 构造正则');
  assert.match(cbCode, /new RegExp\(patTitle\)/, '必须用局部变量 patTitle 构造正则');

  // ② ★ #75 防回归：调用点的实参必须是**一个对象**，不得是按位置传的多个值。
  //    判据：`frame.evaluate(fn, { … })` 里那个对象的**起始花括号**紧跟回调的 `},`。
  const callSeg = DRIVER.slice(cbEnd, cbEnd + 200);
  assert.match(callSeg, /^\},\s*\{/, '调用点必须紧跟一个**对象字面量**（`}, {`）——'
    + '按位置传多个值就是 #75（Playwright 只接受一个 arg，传多了同步抛、再被 .catch 吞成「没命中」）');
  assert.match(DRIVER, /sel:\s*site\.captchaSelector/, '对象里必须带站点声明位 sel');
  assert.match(DRIVER, /patBody:\s*CHALLENGE_PATTERN_SOURCES\.body/, '对象里必须带词表真源的 body');
  assert.match(DRIVER, /patTitle:\s*CHALLENGE_PATTERN_SOURCES\.title/, '对象里必须带词表真源的 title');
});
