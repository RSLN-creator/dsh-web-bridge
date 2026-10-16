// evaluate-argc.test.mjs — 护栏：**不许给 `page/frame.evaluate` 传超过一个 arg**（0.19.87）。
//
// ## 本条防的是哪一次真缺陷（#75，2026-10-16 实测）
//
// Playwright 的契约是 `evaluate(pageFunction, arg)`——**pageFunction 之外只许再有一个 arg**。
// 传多了它**同步抛**（离线实证，用仓库自带 chromium；原文断言见用例②，此处不复写代码形状）。
//
// ⚠ **危险在于它抛得早、又几乎总被 `.catch` 吞掉**：
//   表达式一抛，异常就变成 `null`，调用方看到的是「没命中 / 没读到」，
//   而真相是**那段判据从来没跑过**。
//
// 真机后果（#63 / #75 串联）：0.19.83 给「doubao 图片式验证」加的**超时点归因**，
// 给同一个 `evaluate` 传了**四个顶层实参**（一个回调 + 三个值）⇒ 每次都在回调第一行之前抛
// ⇒ 被紧随其后的 `.catch` 吞掉。
// **0.19.83 的真机复验因此「既没命中验证码、也没打出 probe 诊断行」**——
// 那是「代码改了、护栏也加了（护栏只查源码里有这个字符串），但那段代码**从未运行**」。
//
// ## 判据（两条，互相独立）
//
//   ① **源码级**：`lib/` 与 `test-mock/` 里，任何 `X.evaluate(...)` 的**顶层实参不得 ≥3**
//      （2 个 = `fn + 1 arg`，是契约内的正确用法；首版阈值写成 >1 时把 32 处正确写法报成缺陷
//      —— 一次**假红**，已改正并写在这里）。
//   ② **行为级**：真的起一个浏览器，断言「传 3 个实参」确实抛
//      `Too many arguments`，且「传 1 个对象」不抛。
//      ⇒ ① 是防回归的网，② 是**判据自身的真伪**（否则 ① 可能锚在一个过时的说法上）。
//
// ⚠ ①② 都必需：只有 ①，判据可能基于一条过时的 Playwright 契约；
//   只有 ②，新写的违规调用不会被抓。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PKG = path.join(import.meta.dirname, '..');

/** 去掉注释（保留行号）；理由是「护栏判代码、不判注释」——修缺陷时注释里会逐字引用反例。 */
function stripComments(src) {
  return src.split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** 从一个 `(` 起找配平的 `)`（跳过字符串/模板/正则/注释）。 */
function balancedEnd(src, open) {
  let i = open + 1; let depth = 1; let prev = '';
  while (i < src.length && depth > 0) {
    const c = src[i]; const n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); i = e === -1 ? src.length : e + 1; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') { let d = 1; i += 2; while (i < src.length && d > 0) { if (src[i] === '{') d += 1; else if (src[i] === '}') d -= 1; i += 1; } continue; }
        if (src[i] === q) { i += 1; break; }
        i += 1;
      }
      prev = q; continue;
    }
    if (c === '/' && ['', '=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return'].includes(prev)) {
      i += 1; let inClass = false;
      while (i < src.length) { const d = src[i]; if (d === '\\') { i += 2; continue; } if (inClass) { if (d === ']') inClass = false; } else if (d === '[') inClass = true; else if (d === '/') { i += 1; break; } i += 1; }
      prev = '/'; continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') { depth -= 1; if (depth === 0) return i; }
    if (c.trim() !== '') prev = c;
    i += 1;
  }
  return -1;
}

/** 按顶层逗号切分实参文本。 */
function splitTopLevel(argsSrc) {
  const parts = []; let depth = 0; let cur = ''; let i = 0; let prev = '';
  while (i < argsSrc.length) {
    const c = argsSrc[i]; const n = argsSrc[i + 1];
    if (c === '/' && n === '/') { const e = argsSrc.indexOf('\n', i); i = e === -1 ? argsSrc.length : e + 1; continue; }
    if (c === '/' && n === '*') { const e = argsSrc.indexOf('*/', i + 2); i = e === -1 ? argsSrc.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; cur += c; i += 1;
      while (i < argsSrc.length) { cur += argsSrc[i]; if (argsSrc[i] === '\\') { i += 1; cur += argsSrc[i] ?? ''; i += 1; continue; } if (argsSrc[i] === q) { i += 1; break; } i += 1; }
      prev = q; continue;
    }
    if (c === '/' && ['', '=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return'].includes(prev)) {
      cur += c; i += 1; let inClass = false;
      while (i < argsSrc.length) { cur += argsSrc[i]; const d = argsSrc[i]; if (d === '\\') { i += 1; cur += argsSrc[i] ?? ''; i += 1; continue; } if (inClass) { if (d === ']') inClass = false; } else if (d === '[') inClass = true; else if (d === '/') { i += 1; break; } i += 1; }
      prev = '/'; continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; i += 1; prev = ','; continue; }
    cur += c;
    if (c.trim() !== '') prev = c;
    i += 1;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length);
}

/** 收集某个源文件里所有 `X.evaluate(` 的顶层实参数。 */
function evaluateArgCounts(abs) {
  const src = stripComments(fs.readFileSync(abs, 'utf8'));
  const out = [];
  const re = /([A-Za-z_$][\w$]*)\s*\.\s*evaluate\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('(', m.index + m[0].length - 1);
    const end = balancedEnd(src, open);
    if (end < 0) continue;
    out.push({ receiver: m[1], line: src.slice(0, m.index).split('\n').length, argc: splitTopLevel(src.slice(open + 1, end)).length });
  }
  return out;
}

test('① 源码级：lib/ 与 test-mock/ 里不许出现 `evaluate(fn, a, b)`（≥3 顶层实参）', () => {
  const bad = [];
  for (const root of ['lib', 'test-mock']) {
    const dir = path.join(PKG, root);
    if (!fs.existsSync(dir)) continue;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(mjs|cjs|js)$/.test(e.name)) continue;
        for (const hit of evaluateArgCounts(p)) {
          if (hit.argc >= 3) bad.push(`${path.relative(PKG, p)}:${hit.line} ${hit.receiver}.evaluate argc=${hit.argc}`);
        }
      }
    };
    walk(dir);
  }
  assert.deepEqual(bad, [], '给 evaluate 传了超过一个 arg —— Playwright 会**同步抛** '
    + '`Too many arguments…`，而这类调用几乎总带 `.catch` ⇒ **异常被吞成「没命中」**，'
    + '那段判据从来没跑过（#75 真机教训）。正确写法：把参数收进**一个对象**。\n'
    + JSON.stringify(bad));
});

test('② 行为级：真的起浏览器，钉住「3 个实参会抛 / 1 个对象不抛」', async () => {
  const { chromium } = await import('playwright-core');
  const runtime = await import('../lib/browser-runtime.js');
  const exe = runtime.resolveBrowserExecutable();
  assert.ok(exe?.path && fs.existsSync(exe.path), '找不到可用 chromium（②需要真实浏览器）');
  const browser = await chromium.launch({ headless: true, executablePath: exe.path });
  try {
    const page = await browser.newPage();
    await page.setContent('<html><head><title>t</title></head><body>hello</body></html>');

    // ① 3 个实参 ⇒ 必须抛（这就是 #75 的形状）
    let threw = null;
    try {
      // eslint-disable-next-line no-unused-vars
      await page.evaluate((a, b) => a + b, 1, 2);
    } catch (e) { threw = String(e?.message || e); }
    // ⚠ 若将来 Playwright 改了契约（不再抛），这条会红 —— 那时**先查契据，再改护栏**，
    //   但 ① 的源码级判据仍要保留（下游 dsh 也可能依赖同一契约）。
    assert.ok(threw && /Too many arguments/i.test(threw),
      '「传 3 个实参必须抛 Too many arguments」这条契约不再成立 —— '
      + '先核对 Playwright 版本与文档，不要顺手删掉 ① 的源码级判据。实测：' + JSON.stringify(threw));

    // ② 1 个对象 ⇒ 正常返回值（契约内的多值形态）
    const ok = await page.evaluate((o) => ({ sum: o.a + o.b, keys: Object.keys(o).length }), { a: 1, b: 2 });
    assert.deepEqual(ok, { sum: 3, keys: 2 }, '单对象传参必须正常（这是正确写法）');

    // ③ 复刻 #63 的靶子：把 doubao 真机原文放进页面，用**正确写法**必须命中
    await page.setContent('<html><head><title>x</title></head><body>常见于森林的生态元素\n请选择所有符合上文描述的图片，并拖拽到下方\n提交</body></html>');
    const heur = await import('../lib/challenge-heuristics.js');
    const hit = await page.evaluate((o) => {
      const txt = String(document.body?.innerText || '');
      return { basis: new RegExp(o.body).test(txt) ? 'body-text' : null };
    }, { body: heur.CHALLENGE_PATTERN_SOURCES.body });
    assert.equal(hit.basis, 'body-text',
      '#63 的靶子（doubao 图片选择式验证原文）在**正确传参**下必须命中 —— '
      + '这条同时证明「修 #75 之后，那段判据真的跑得起来了」');
  } finally {
    await browser.close();
  }
});
