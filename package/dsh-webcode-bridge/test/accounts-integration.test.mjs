// accounts-integration.test.mjs — 账户槽与既有子系统的接缝（0.14.7）。
//
// accounts.test.mjs 钉的是**纯函数层**（解析/格式化/回落）；本文件钉的是
// 「把它接进 providers / driver / 发送间隔之后，0.14.6 的行为有没有被改动」。
//
// 本文件最重要的两组断言：
//   ① **默认槽零位移**：`listAllModels()` 不传参时的输出必须与 0.14.6 逐字节相同；
//      `resolveWebModel('glm:auto')` 的 accountKey 必须是 `glm`（不是 `glm#default`）。
//   ② **两个槽不串**：`glm` 与 `glm#2` 必须解析到不同的 profileDir / accountKey，
//      否则「同站多账户」就是假的（第二个号会覆盖第一个号的登录态）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { SITES, listAllModels, resolveWebModel, MODEL_ALIAS_IDS } from '../lib/providers.js';
import { DEFAULT_SLOT, slotProfileDir, formatModelId, sendGapForSlot } from '../lib/accounts.js';

// ---------------------------------------------------------------- 默认槽零位移

test('listAllModels 不传参时：默认槽 id 仍是 site:model（0.14.6 形状）', () => {
  const all = listAllModels();
  for (const m of all) {
    if (MODEL_ALIAS_IDS.has(m.id)) continue;   // 兼容别名没有 ':'
    assert.ok(!m.id.includes('@'), m.id + ' 不应含槽分隔符 @（默认槽不带槽）');
    assert.equal(m.slot, DEFAULT_SLOT, m.id + ' 的 slot 应为 default');
    assert.equal(m.siteId, m.id.split(':')[0], m.id + ' 的站点前缀被改动了');
  }
});

test('listAllModels 不传参时：条目数与 0.14.6 目录一致（每站点每模型一条 + 一条别名）', () => {
  const expected = SITES.reduce((n, st) => n + st.models.length, 0) + 1;
  assert.equal(listAllModels().length, expected);
});

test('resolveWebModel：默认槽的 accountKey 就是 siteId（历史值语义不变）', () => {
  for (const id of ['glm:auto', 'zai:glm-5.3', 'kimi:k3', 'doubao:chat', 'deepseek:deepseek']) {
    const r = resolveWebModel(id);
    assert.equal(r.slot, DEFAULT_SLOT, id + ' 的 slot 应为 default');
    assert.equal(r.accountKey, r.siteId, id + ' 的 accountKey 应等于 siteId');
  }
});

test('resolveWebModel：历史别名全部仍解析到默认槽（升级不改老设置值的含义）', () => {
  for (const alias of ['deepseek-web', 'flash', 'glm-4.6', 'z.ai-glm5.3', 'k3', 'zai', 'gpt-4o']) {
    const r = resolveWebModel(alias);
    assert.equal(r.slot, DEFAULT_SLOT, alias + ' 必须落到默认槽');
    assert.equal(r.accountKey, r.siteId, alias + ' 的 accountKey 应等于 siteId');
  }
});

test('resolveWebModel：默认槽显示名与 0.14.6 逐字相同（无 (账户N) 后缀）', () => {
  assert.equal(resolveWebModel('glm:glm-5.3').name, 'glm/glm-5.3');
  assert.equal(resolveWebModel('zai:glm-5.3').name, 'z.ai/glm-5.3');
  assert.equal(resolveWebModel('deepseek:deepseek').name, 'deepseek/deepseek');
  for (const m of listAllModels()) {
    assert.ok(!m.name.includes('账户'), m.id + ' 默认槽显示名不应含「账户」：' + m.name);
  }
});

// ---------------------------------------------------------------- 槽限定 id

test('resolveWebModel：site@slot:model 解析出槽，且 id 与 accountKey 一致', () => {
  const r = resolveWebModel('glm@2:glm-5.3');
  assert.equal(r.siteId, 'glm');
  assert.equal(r.slot, '2');
  assert.equal(r.id, 'glm-5.3');          // 内部模型 id 不含槽
  assert.equal(r.accountKey, 'glm#2');
  assert.equal(r.webName, 'GLM-5.3');     // 网页侧目标名永远干净
});

test('resolveWebModel：site@1:model 归一到默认槽（`#1` 是默认槽别名）', () => {
  const r = resolveWebModel('glm@1:glm-5.3');
  assert.equal(r.slot, DEFAULT_SLOT);
  assert.equal(r.accountKey, 'glm');
  assert.equal(r.name, 'glm/glm-5.3', '默认槽别名不得带 (账户1) 后缀');
});

test('resolveWebModel：非默认槽显示名带 (账户N)（同一模型两行可区分）', () => {
  const a = resolveWebModel('glm:glm-5.3');
  const b = resolveWebModel('glm@2:glm-5.3');
  assert.notEqual(a.name, b.name, '两个槽的显示名必须不同，否则下拉里是两行同名');
  assert.equal(b.name, 'glm (账户2)/glm-5.3');
});

test('resolveWebModel：未知槽限定 id 必须抛错（不得静默回落默认槽）', () => {
  assert.throws(() => resolveWebModel('glm@2:definitely-not-a-model'), /不支持的网页模型/);
  assert.throws(() => resolveWebModel('nosuchsite@2:auto'), /不支持的网页模型/);
});

// ---------------------------------------------------------------- 目录展开

test('listAllModels(accounts)：非默认槽各出一组，默认槽仍在且在最前', () => {
  const all = listAllModels([{ siteId: 'glm', slot: '2' }]);
  const glm = all.filter((m) => m.siteId === 'glm');
  const slots = [...new Set(glm.map((m) => m.slot))];
  assert.deepEqual(slots, [DEFAULT_SLOT, '2'], '默认槽必须在首位');
  // 槽限定 id 形态
  assert.ok(glm.some((m) => m.id === 'glm:glm-5.3'));
  assert.ok(glm.some((m) => m.id === 'glm@2:glm-5.3'));
  // 其它站点不受影响（只展开被配置的那一个）
  assert.ok(all.filter((m) => m.siteId === 'kimi').every((m) => m.slot === DEFAULT_SLOT));
});

test('listAllModels(accounts)：disabled 的槽不展开', () => {
  const all = listAllModels([{ siteId: 'glm', slot: '2', enabled: false }]);
  assert.ok(all.every((m) => m.slot === DEFAULT_SLOT));
});

test('listAllModels(accounts)：非法/未知站点槽被丢弃（设置文件可手改）', () => {
  const all = listAllModels([
    null, 'x',
    { siteId: 'nosuchsite', slot: '2' },
    { siteId: 'glm', slot: '2#3' },
    { siteId: 'glm', slot: '3' },
  ]);
  const slots = [...new Set(all.filter((m) => m.siteId === 'glm').map((m) => m.slot))];
  assert.deepEqual(slots, [DEFAULT_SLOT, '3']);
});

test('listAllModels(accounts)：展开后仍无重复显示名（下拉不会出现两行同名）', () => {
  const all = listAllModels([{ siteId: 'glm', slot: '2' }, { siteId: 'zai', slot: 'work' }]);
  const seen = new Map();
  for (const m of all) {
    if (MODEL_ALIAS_IDS.has(m.id)) continue;
    assert.ok(!seen.has(m.name), `${m.id} 与 ${seen.get(m.name)} 同名: ${m.name}`);
    seen.set(m.name, m.id);
  }
});

// ---------------------------------------------------------------- 两槽不串

test('两个槽的 profileDir 必须不同（否则第二个号覆盖第一个号的登录态）', () => {
  const root = 'C:/tmp/webcode-edge-profile';
  const d1 = slotProfileDir(root, 'glm', DEFAULT_SLOT);
  const d2 = slotProfileDir(root, 'glm', '2');
  assert.notEqual(d1, d2);
  // 且默认槽路径逐字保持 0.14.6 形状
  assert.ok(d1.endsWith('sites/glm') || d1.endsWith('sites\\glm'), '默认槽路径被改动了: ' + d1);
});

test('formatModelId 与 resolveWebModel 往返：槽信息不丢也不串', () => {
  for (const [site, slot, mid] of [['glm', DEFAULT_SLOT, 'glm-5.3'], ['glm', '2', 'glm-5.3'], ['zai', 'work', 'auto']]) {
    const id = formatModelId(site, slot, mid);
    const r = resolveWebModel(id);
    assert.equal(r.siteId, site);
    assert.equal(r.slot, slot);
    assert.equal(r.id, mid);
  }
});

// ---------------------------------------------------------------- 槽级发送间隔接缝

test('sendGapForSlot 与 computeSendGap 的接缝：两个槽各自独立计时', () => {
  const settings = { sendGapMs: 30000, sendGapMsBySlot: { 'glm#2': 60000 } };
  const gapA = sendGapForSlot(settings, 'glm', 'glm');
  const gapB = sendGapForSlot(settings, 'glm#2', 'glm');
  assert.equal(gapA, 30000, '默认槽回落全局值');
  assert.equal(gapB, 60000, '账户2 用自己的槽级值');
  assert.notEqual(gapA, gapB, '两个槽的间隔必须可独立配置');
});