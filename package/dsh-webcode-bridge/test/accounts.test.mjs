// accounts.test.mjs — 「站点 × 账户槽」身份层的护栏（0.14.7）。
//
// 本文件最重要的两组断言不是「功能对不对」，而是两条**兼容性硬约束**：
//   ① 默认槽的 accountKey / 模型 id / profile 目录与 0.14.6 **逐字相同**
//      —— 否则历史设置值与已落盘的登录态全部要迁移。
//   ② `glm` 与 `glm#1` 必须指向同一份登录态
//      —— 否则界面上会出现两个看起来一样、实际不同的槽。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  DEFAULT_SLOT,
  normalizeSlot,
  parseAccountKey,
  formatAccountKey,
  formatModelId,
  parseModelId,
  slotProfileDir,
  accountLabel,
  normalizeAccounts,
  slotsForSite,
  sendGapForSlot,
} from '../lib/accounts.js';

// ---------------------------------------------------------------- 槽名归一化

test('normalizeSlot: 空/缺省一律落到默认槽', () => {
  for (const v of [undefined, null, '', '  ']) assert.equal(normalizeSlot(v), DEFAULT_SLOT);
});

test('normalizeSlot: `1` 是默认槽的别名（不是独立的槽）', () => {
  assert.equal(normalizeSlot('1'), DEFAULT_SLOT);
  assert.equal(normalizeSlot(1), DEFAULT_SLOT);
});

test('normalizeSlot: 非法槽名返回 null 而不是猜', () => {
  for (const v of ['2#3', 'a@b', '有中文', 'x'.repeat(33), '#', '@']) {
    assert.equal(normalizeSlot(v), null, '应判非法: ' + JSON.stringify(v));
  }
});

test('normalizeSlot: 合法槽名原样保留（含大小写与连字符）', () => {
  for (const v of ['2', '3', 'work', 'work-2', 'Work_2']) assert.equal(normalizeSlot(v), v);
});

// ---------------------------------------------------------------- accountKey

test('parseAccountKey: 无 `#` 即默认槽', () => {
  assert.deepEqual(parseAccountKey('glm'), { siteId: 'glm', slot: DEFAULT_SLOT });
});

test('parseAccountKey: `#N` 解析出槽', () => {
  assert.deepEqual(parseAccountKey('glm#2'), { siteId: 'glm', slot: '2' });
  assert.deepEqual(parseAccountKey('glm#work'), { siteId: 'glm', slot: 'work' });
});

test('parseAccountKey: `#1` 归一到默认槽（与 `glm` 同一份登录态）', () => {
  assert.deepEqual(parseAccountKey('glm#1'), parseAccountKey('glm'));
  assert.deepEqual(parseAccountKey('glm#1'), { siteId: 'glm', slot: DEFAULT_SLOT });
});

test('parseAccountKey: 非法输入必须抛错，不得静默回落默认槽', () => {
  // 静默回落会让用户以为「账户2 没登录」，实际是拼错了读了默认槽。
  for (const v of ['', '   ', '#2', 'glm#', 'glm#2#3', 'glm#有中文', '#']) {
    assert.throws(() => parseAccountKey(v), '应抛错: ' + JSON.stringify(v));
  }
});

test('formatAccountKey: 默认槽不带后缀（与 0.14.6 手写值逐字相同）', () => {
  assert.equal(formatAccountKey('glm', DEFAULT_SLOT), 'glm');
  assert.equal(formatAccountKey('glm', '1'), 'glm');
  assert.equal(formatAccountKey('glm'), 'glm');
});

test('formatAccountKey: 非默认槽带 `#slot`', () => {
  assert.equal(formatAccountKey('glm', '2'), 'glm#2');
  assert.equal(formatAccountKey('deepseek', 'work'), 'deepseek#work');
});

test('formatAccountKey ↔ parseAccountKey 往返恒等', () => {
  for (const [site, slot] of [['glm', DEFAULT_SLOT], ['glm', '2'], ['zai', 'work-2']]) {
    const key = formatAccountKey(site, slot);
    assert.deepEqual(parseAccountKey(key), { siteId: site, slot });
  }
});

// ---------------------------------------------------------------- 模型 id

test('formatModelId: 默认槽仍是 `site:model`（0.14.6 形状不变）', () => {
  assert.equal(formatModelId('glm', DEFAULT_SLOT, 'glm-5.3'), 'glm:glm-5.3');
  assert.equal(formatModelId('deepseek', '1', 'deepseek'), 'deepseek:deepseek');
});

test('formatModelId: 非默认槽是 `site@slot:model`', () => {
  assert.equal(formatModelId('glm', '2', 'glm-5.3'), 'glm@2:glm-5.3');
});

test('parseModelId: 限定形状逐条解析', () => {
  assert.deepEqual(parseModelId('glm:glm-5.3'), { siteId: 'glm', slot: DEFAULT_SLOT, modelId: 'glm-5.3' });
  assert.deepEqual(parseModelId('glm@2:glm-5.3'), { siteId: 'glm', slot: '2', modelId: 'glm-5.3' });
  assert.deepEqual(parseModelId('glm@1:glm-5.3'), { siteId: 'glm', slot: DEFAULT_SLOT, modelId: 'glm-5.3' });
});

test('parseModelId: 别名与裸 id 返回 null（交给 providers 解析）', () => {
  for (const v of ['deepseek-web', 'glm-4.6', 'flash', '', 'glm', ':x', 'glm:']) {
    assert.equal(parseModelId(v), null, '应为 null: ' + JSON.stringify(v));
  }
});

test('parseModelId: 非法槽形状返回 null（不抛错）', () => {
  for (const v of ['glm@:x', 'glm@2#3:x', 'glm@有中文:x']) {
    assert.equal(parseModelId(v), null, '应为 null: ' + JSON.stringify(v));
  }
});

test('formatModelId ↔ parseModelId 往返恒等', () => {
  for (const [site, slot, mid] of [['glm', DEFAULT_SLOT, 'glm-5.3'], ['glm', '2', 'glm-5.3'], ['zai', 'work', 'auto']]) {
    const id = formatModelId(site, slot, mid);
    assert.deepEqual(parseModelId(id), { siteId: site, slot, modelId: mid });
  }
});

// ---------------------------------------------------------------- profile 目录

test('slotProfileDir: 默认槽与 0.14.6 的目录逐字相同', () => {
  const root = path.join('C:', 'tmp', 'webcode-edge-profile');
  // deepseek 把 driver 直接挂在根上（前端校验宿主名）
  assert.equal(slotProfileDir(root, 'deepseek', DEFAULT_SLOT, { primary: true }), root);
  // 其余站点挂 sites/<siteId>
  assert.equal(slotProfileDir(root, 'glm', DEFAULT_SLOT), path.join(root, 'sites', 'glm'));
});

test('slotProfileDir: 非默认槽一律落 sites/<siteId>/<slot>', () => {
  const root = path.join('C:', 'tmp', 'webcode-edge-profile');
  assert.equal(slotProfileDir(root, 'glm', '2'), path.join(root, 'sites', 'glm', '2'));
  // primary 站点（deepseek）的非默认槽也走 sites/，不污染根目录
  assert.equal(slotProfileDir(root, 'deepseek', '2', { primary: true }), path.join(root, 'sites', 'deepseek', '2'));
});

test('slotProfileDir: 两个槽的目录必须不同（否则会串登录态）', () => {
  const root = path.join('C:', 'tmp', 'webcode-edge-profile');
  assert.notEqual(slotProfileDir(root, 'glm', DEFAULT_SLOT), slotProfileDir(root, 'glm', '2'));
});

test('slotProfileDir: 非法槽名抛错', () => {
  assert.throws(() => slotProfileDir('C:/x', 'glm', '2#3'));
});

// ---------------------------------------------------------------- 显示名

test('accountLabel: 默认槽不加后缀（既有下拉逐字不变）', () => {
  assert.equal(accountLabel('智谱清言 (GLM)', DEFAULT_SLOT), '智谱清言 (GLM)');
  assert.equal(accountLabel('智谱清言 (GLM)', '1'), '智谱清言 (GLM)');
  assert.equal(accountLabel('智谱清言 (GLM)'), '智谱清言 (GLM)');
});

test('accountLabel: 非默认槽追加 (账户N)', () => {
  assert.equal(accountLabel('智谱清言 (GLM)', '2'), '智谱清言 (GLM) (账户2)');
  assert.equal(accountLabel('智谱清言 (GLM)', 'work'), '智谱清言 (GLM) (账户work)');
});

// ---------------------------------------------------------------- 设置归一化

test('normalizeAccounts: 合法条目保留并补 key/enabled', () => {
  const out = normalizeAccounts([
    { siteId: 'glm', slot: '2' },
    { siteId: 'zai', slot: 'work', enabled: false },
  ]);
  assert.deepEqual(out, [
    { siteId: 'glm', slot: '2', key: 'glm#2', enabled: true },
    { siteId: 'zai', slot: 'work', key: 'zai#work', enabled: false },
  ]);
});

test('normalizeAccounts: 非法条目丢弃且不猜（手改设置文件不该让桥起不来）', () => {
  const out = normalizeAccounts([
    null, 'glm', 42,
    { slot: '2' },                 // 缺 siteId
    { siteId: '', slot: '2' },     // 空 siteId
    { siteId: 'glm', slot: '2#3' }, // 非法槽名
    { siteId: 'glm', slot: '3' },  // 合法
  ]);
  assert.deepEqual(out.map((a) => a.key), ['glm#3']);
});

test('normalizeAccounts: 重复 key 先到先得', () => {
  const out = normalizeAccounts([
    { siteId: 'glm', slot: '2', enabled: true },
    { siteId: 'glm', slot: '2', enabled: false },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].enabled, true);
});

test('normalizeAccounts: 非数组一律空（不抛错）', () => {
  for (const v of [undefined, null, 'glm', 42, {}]) assert.deepEqual(normalizeAccounts(v), []);
});

test('slotsForSite: 默认槽总是存在（即使用户没写）', () => {
  const slots = slotsForSite([], 'glm');
  assert.deepEqual(slots.map((s) => s.key), ['glm']);
});

test('slotsForSite: 配置了槽则与默认槽一起返回，且默认槽在首位', () => {
  const slots = slotsForSite([{ siteId: 'glm', slot: '2' }], 'glm');
  assert.deepEqual(slots.map((s) => s.key), ['glm', 'glm#2']);
});

test('slotsForSite: disabled 的槽不出现，但默认槽仍在', () => {
  const slots = slotsForSite([{ siteId: 'glm', slot: '2', enabled: false }], 'glm');
  assert.deepEqual(slots.map((s) => s.key), ['glm']);
});

test('slotsForSite: 不串站点', () => {
  const slots = slotsForSite([{ siteId: 'zai', slot: '2' }], 'glm');
  assert.deepEqual(slots.map((s) => s.key), ['glm']);
});

// ---------------------------------------------------------------- 槽级发送间隔

test('sendGapForSlot: 槽显式值优先', () => {
  const settings = { sendGapMs: 30000, sendGapMsBySlot: { 'glm#2': 60000 } };
  assert.equal(sendGapForSlot(settings, 'glm#2', 'glm'), 60000);
});

test('sendGapForSlot: 槽缺省回落到站点级键（默认槽的 key 就是 siteId）', () => {
  const settings = { sendGapMs: 30000, sendGapMsBySlot: { glm: 45000 } };
  assert.equal(sendGapForSlot(settings, 'glm#2', 'glm'), 45000);
  assert.equal(sendGapForSlot(settings, 'glm', 'glm'), 45000);
});

test('sendGapForSlot: 都没有则回落全局值（0.14.6 的唯一一档）', () => {
  assert.equal(sendGapForSlot({ sendGapMs: 30000 }, 'glm#2', 'glm'), 30000);
  assert.equal(sendGapForSlot({ sendGapMs: 0 }, 'glm', 'glm'), 0);
});

test('sendGapForSlot: 0 是合法值，不得被当成「没配」', () => {
  const settings = { sendGapMs: 30000, sendGapMsBySlot: { 'glm#2': 0 } };
  assert.equal(sendGapForSlot(settings, 'glm#2', 'glm'), 0);
});

test('sendGapForSlot: 空字符串/null 视同没配（设置文件手改的常见形态）', () => {
  const settings = { sendGapMs: 30000, sendGapMsBySlot: { 'glm#2': '', glm: null } };
  assert.equal(sendGapForSlot(settings, 'glm#2', 'glm'), 30000);
});

test('sendGapForSlot: 两个槽互不影响（不同登录态风控独立）', () => {
  const settings = { sendGapMs: 30000, sendGapMsBySlot: { 'glm#2': 60000, 'glm#3': 90000 } };
  assert.equal(sendGapForSlot(settings, 'glm#2', 'glm'), 60000);
  assert.equal(sendGapForSlot(settings, 'glm#3', 'glm'), 90000);
  assert.equal(sendGapForSlot(settings, 'glm', 'glm'), 30000);
});

test('sendGapForSlot: 设置损坏时不抛错', () => {
  for (const v of [undefined, null, 'x', 42, { sendGapMsBySlot: 'x' }]) {
    assert.doesNotThrow(() => sendGapForSlot(v, 'glm#2', 'glm'));
  }
});
