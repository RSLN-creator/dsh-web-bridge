// column-context.test.mjs — 并列多会话的列身份与工作区约定（0.19.21，用户 Q5）。
//
// ## 这个文件要证明什么
//
// 用户原话（2026-09-26，逐字）：
//
//   「……3 者独立，但是**考虑做好沙箱适配**——可能对于同一文件进行思考/修改，
//    怎么做到**选定一个模型进行主要审查**？怎么选定模型进行**同时互不影响的方案探索**」
//
// 本插件的边界（`lib/column-context.js` 文件头已论证）：模型发起的 edit/pwsh 由
// Harness 的工具执行器落地，那条链路上没有本插件的插槽——所以本插件交付的是
// **约定**而不是**拦截**。因此这里钉的不是「文件真的写不进去」，而是：
//
//   ① 列身份**不认识就不认**（绝不猜）——猜错角色比没有角色危险得多；
//   ② 拼出来的文本**不撒谎**（必须写明「这不是强制隔离」）；
//   ③ 三跳齐全：client 发 columnContext → web-control 真的拼进 promptText
//      → 最终送进 sendTurn 的是**拼好的文本**（本项目记过多次「拼了却发原串」）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPLORE_ROOT, normalizeColumnContext, columnGuidance, withColumnGuidance, safePathSegment } from '../lib/column-context.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('列身份：不认识的形状一律返回 null（绝不猜）', () => {
  // 具体形态：字段缺失、角色拼错、根本不是对象。
  assert.equal(normalizeColumnContext(null), null, 'null 必须返回 null');
  assert.equal(normalizeColumnContext(undefined), null, 'undefined 必须返回 null');
  assert.equal(normalizeColumnContext('explore'), null, '字符串不是列身份');
  assert.equal(normalizeColumnContext({}), null, '没有 role 就不认');
  assert.equal(normalizeColumnContext({ role: 'main' }), null,
    'role 不在枚举里就不认 —— 猜错角色会让模型按错误职责行事，而用户看不出来');
  assert.equal(normalizeColumnContext({ role: 'EXPLORE' }), null,
    '角色大小写不匹配也不认（本判据刻意严格：宁可没有身份，不要错的身份）');

  // 正判据：两种合法角色都要认（0.19.23 起必须同时给 key+scope —— 见下条）。
  assert.equal(normalizeColumnContext({ role: 'explore', key: 'c2', scope: 's1' })?.role, 'explore');
  assert.equal(normalizeColumnContext({ role: 'review', key: 'c1', scope: 's1' })?.role, 'review');

  // ★ 0.19.23：有角色但拿不到**可用目录**时返回 null，而不是给一个退化目录。
  //
  // 上一版在 key 为空时返回对象、由 columnGuidance 退化成 `.hwb/cols/` ——
  // 那是**所有列共用的根**，比不给目录更坏：三个探索列会一起往里写，
  // 而界面上还写着「该目录归本列使用」。宁可不给，也不要给一个假承诺。
  assert.equal(normalizeColumnContext({ role: 'explore' }), null, '缺 key/scope 时必须返回 null');
  assert.equal(normalizeColumnContext({ role: 'explore', key: '' }), null, '空 key 同理');
});

test('列身份：index/total 只接受正有限数，其余归零（不写 NaN 进提示词）', () => {
  // 基座必须带 key+scope（0.19.23 起它们决定目录，缺了就返回 null）。
  const base = { role: 'explore', key: 'c2', scope: 's1' };
  const a = normalizeColumnContext({ ...base, index: 2, total: 3 });
  assert.equal(a.index, 2);
  assert.equal(a.total, 3);
  // 病形状：NaN / Infinity / 负数 / 0 / 字符串数字。
  for (const bad of [NaN, Infinity, -1, 0, 'x', null, undefined]) {
    const c = normalizeColumnContext({ ...base, index: bad, total: bad });
    assert.equal(c.index, 0, 'index=' + String(bad) + ' 必须归零');
    assert.equal(c.total, 0, 'total=' + String(bad) + ' 必须归零');
  }
  // 「第 0/0 列」这种话绝不能出现在提示词里。
  assert.ok(!/NaN|Infinity|0\/0/.test(columnGuidance(normalizeColumnContext({ ...base, index: NaN, total: NaN }))));
});

/**
 * ★ 0.19.23：路径片段必须净化 —— 这是上一版**真的漏掉的一个缺陷**。
 *
 * `key` 与 `scope` 都来自客户端请求体，而它们会被拼进**发给模型的路径字符串**。
 * 上一版直接 `String(raw.key).trim()` 就拼进 `.hwb/cols/<key>/`，于是：
 *
 *   · `../..` 这类键能把「产出写这里」指到**工作区之外**，而模型会照做 ——
 *     那不是「约定不严」，那是把路径穿越写进了提示词；
 *   · 列键是固定的 `c1/c2/c3`，**两个不同的 DSH 会话**里的第 2 列都会写
 *     `.hwb/cols/c2/`，草稿互相覆盖 —— 而「互不影响」正是并列探索的全部意义。
 *
 * 判据用**白名单**而不是黑名单：黑名单永远漏（`..`、`\\`、`%2e%2e`、全角斜杠…），
 * 而这里根本不需要那些字符。
 */
test('★ 0.19.23 路径片段：白名单净化（挡住 `../` 这类路径穿越）', () => {
  // 具体形态：路径穿越、分隔符、编码逃逸、全角斜杠 —— 一个都不能原样留下。
  const dangerous = ['../../etc', '..', '.', 'a/b', 'a\\b', '%2e%2e', '..／..', 'c1/../..', '..\\..\\x'];
  for (const bad of dangerous) {
    const out = safePathSegment(bad);
    assert.ok(!out.includes('..'), `safePathSegment(${JSON.stringify(bad)}) 不得保留 ..（实际 ${JSON.stringify(out)}）`);
    assert.ok(!/[\\/]/.test(out), `safePathSegment(${JSON.stringify(bad)}) 不得保留路径分隔符`);
    assert.ok(!/%/.test(out), `safePathSegment(${JSON.stringify(bad)}) 不得保留百分号`);
  }
  // 正判据：正常列键与会话作用域**必须逐字保留**（净化不能把好值改坏）。
  assert.equal(safePathSegment('c2'), 'c2', '正常列键必须逐字保留');
  assert.equal(safePathSegment('c1-2'), 'c1-2', '连字符必须保留');
  assert.equal(safePathSegment('session-e7056e8c-4161-42f6'), 'session-e7056e8c-4161-42f6',
    '真实会话 id 形状必须逐字保留（否则目录名与用户看到的会话对不上）');
  // 超长必须截断（不能靠一段超长 key 把路径撑爆）。
  assert.ok(safePathSegment('x'.repeat(500), 40).length <= 40, '超长片段必须截断');
  // 空值归空串，不返回 'null'/'undefined' 这类字面量。
  for (const empty of [null, undefined, '', '   ']) {
    assert.equal(safePathSegment(empty), '', `safePathSegment(${String(empty)}) 必须返回空串`);
  }
});

test('★ 0.19.23 目录隔离：不同 DSH 会话的第 2 列不得撞同一个目录', () => {
  // 同一个列键、两个会话作用域 ⇒ 目录必须不同（这是修复的核心）。
  const a = normalizeColumnContext({ role: 'explore', key: 'c2', scope: 'session-aaa' });
  const b = normalizeColumnContext({ role: 'explore', key: 'c2', scope: 'session-bbb' });
  assert.notEqual(a.key, b.key, '不同会话的同名列必须落进不同目录 —— 否则草稿互相覆盖');
  assert.ok(a.key.includes('session-aaa'), '目录名必须含会话作用域，用户才核得出来');
  // 同一会话内不同列也必须不同。
  const c1 = normalizeColumnContext({ role: 'review', key: 'c1', scope: 'session-aaa' });
  assert.notEqual(a.key, c1.key, '同一会话内不同列必须落进不同目录');
  // 净化后为空 ⇒ 宁可不给目录，也不给所有列共用的根。
  assert.equal(normalizeColumnContext({ role: 'explore', key: '..', scope: '..' }), null,
    '键与作用域都被净化成空时必须返回 null，绝不退回共用的 .hwb/cols/');
});

test('探索列：必须给出产出目录，且**不得**要求模型自己去写文件（0.19.29 修的真缺陷）', () => {
  const g = columnGuidance(normalizeColumnContext({ role: 'explore', key: 'c2', index: 2, total: 3 }));
  // 产出目录仍然要给：用户要能按列找到产出。
  assert.match(g, new RegExp(EXPLORE_ROOT + '/c2/'), '探索列必须拿到本列的产出目录');
  assert.match(g, /探索/, '必须自述角色');
  // ★ 0.19.29：**旧文案是一条做不到的指令**。并列列走控制面通路（POST chat），
  // 那条路只回文本、不执行工具，网页聊天模型根本没有文件工具。旧文案却要求它
  // 「你的产出请写入 <dir>，不要直接修改主工作树」—— 模型最好的结果是无视它，
  // 最坏的结果是声称写了文件而磁盘上没有。这一条判据钉住那谎话不再回来。
  assert.ok(!/你的产出请写入/.test(g), '不得再要求模型自己把产出写入目录（它没有文件工具，做不到）');
  assert.ok(!/不要直接修改主工作树/.test(g),
    '不得再出现「不要直接修改主工作树」—— 模型没有改文件的能力，这句话是对能力的错误暗示');
  // 正判据：改成**事实陈述**（产出由插件落盘）+ 明确的「你没有文件工具」。
  assert.match(g, /会被自动保存到/, '必须说明产出**由插件**落盘（这才是真的）');
  assert.match(g, /没有文件读写工具/, '必须明说模型没有文件工具 —— 否则它会编造「我已写入」');
  assert.match(g, /不要[\s\S]{0,4}声称自己创建或修改了任何文件/, '必须明确禁止编造「我已写入文件」');
  // 不撒谎：约定不是强制。
  assert.match(g, /不是强制隔离/, '必须写明这是约定、不是强制隔离 —— 本项目不许把约定说成隔离');
  assert.match(g, /工具权限与审批/, '必须指出真正的权限由 Harness 决定');
  // 不重复工具协议教学（那是首轮教学的事，两者会打架）。
  assert.ok(!/tool_call|mcp_action|calls▁begin/.test(g), '列身份文本不得夹带工具协议教学');
});

test('主审列：职责是汇总与裁决，且必须指出冲突', () => {
  const g = columnGuidance(normalizeColumnContext({ role: 'review', key: 'c1', index: 1, total: 3 }));
  assert.match(g, /主审/, '必须自述角色');
  assert.match(g, /汇总/, '主审的职责必须写出来（否则「主要审查」没有落点）');
  assert.match(g, /冲突/, '必须要求指出彼此冲突之处 —— 三份并列意见的差异正是主审的价值');
  assert.match(g, /不要替它臆测|不要臆测|缺少哪一列的证据/, '缺证据时必须说缺，不得替别的列臆测');
  // 主审列**不该**被要求把产出写进列目录（它的活是裁决，不是躲开）。
  assert.ok(!/不要直接修改主工作树/.test(g), '主审列不该被要求回避主工作树');
});

test('withColumnGuidance：无有效列身份时逐字返回原文（零位移）', () => {
  const p = '请看一下 lib/index.js';
  assert.equal(withColumnGuidance(p, null), p, '没有列身份时必须逐字返回原文');
  assert.equal(withColumnGuidance(p, {}), p, '形状不合法时同样逐字返回');
  assert.equal(withColumnGuidance(p, { role: 'bogus' }), p, '角色不认识时同样逐字返回');
  // 有身份时才拼，且原文必须在最后（任务放最后是提示词组装的一贯顺序）。
  const out = withColumnGuidance(p, { role: 'explore', key: 'c3', index: 3, total: 3 });
  assert.ok(out.endsWith(p), '用户原话必须在最后 —— 模型读到的最后一句就是它要回答的');
  assert.ok(out.length > p.length, '有身份时必须真的拼进东西');
});

test('三跳齐全：client 发 columnContext → 路由拼进 promptText → sendTurn 收到拼好的文本', () => {
  // 第一跳：客户端必须真的把列身份放进请求体。
  const client = read('lib/client.cjs');
  const sendFn = client.slice(client.indexOf('const sendCol = '));
  const chatCall = sendFn.slice(sendFn.indexOf("api('chat', {"));
  assert.ok(chatCall.length > 0, 'sendCol 内必须真的调 api(chat)');
  assert.match(chatCall.slice(0, 1200), /columnContext: \{/, 'api(chat) 必须带上 columnContext（不带 = 界面知道列、模型不知道）');
  assert.match(chatCall.slice(0, 1200), /role: col\.role === 'review' \? 'review' : 'explore'/,
    'role 必须逐字取自列状态，且非法值回落 explore');

  // 第二跳：路由必须真的拼（不是只读不拼）。
  const wc = read('lib/web-control.js');
  const chatBlock = wc.slice(wc.indexOf("'POST chat'"), wc.indexOf('  };\n\n  // ── `status`'));
  assert.ok(chatBlock.length > 0, '找不到 POST chat 的动作体（改名则本判据失效，需同步）');
  assert.match(chatBlock, /withColumnGuidance\(prompt, body\?\.columnContext\)/,
    'POST chat 必须调用 withColumnGuidance 拼装列身份');

  // 第三跳：送进驱动的必须是**拼好的**文本（本项目记过多次「拼了却发原串」）。
  assert.match(chatBlock, /sendTurn\(sessionKey, promptText,/, '必须把拼装后的 promptText 发出去');
});
