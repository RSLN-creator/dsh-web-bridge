// model-picker.test.mjs — 模型选择匹配规则的护栏（0.13.0）。
//
// 真机事实（test-mock/out/model-dropdown-zai-*.json，2026-09-13）：
// z.ai 的模型弹层里有三个选项，逐字为
//     GLM-5.3-Flash / GLM-5.3 / GLM-5.2
//
// **"GLM-5.3" 是 "GLM-5.3-Flash" 的前缀**。任何前缀匹配（includes /
// startsWith / getByText 的宽松模式）都会在用户选 GLM-5.3 时选到 Flash，
// 或反过来。0.12.9 的 selectModelGeneric 正是用 Playwright 的 getByText
// 启发式做这件事 —— 这是一个真实存在、且已经在真机上可复现的选错模型路径。
//
// 本文件把匹配规则钉死，任何放松都会在这里红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickExactOption, normalizeModelName, pickerUsable } from '../lib/model-picker.js';
import { listAllModels, resolveWebModel, getSite } from '../lib/providers.js';

const zaiOptions = [
  { name: 'GLM-5.3-Flash', text: 'GLM-5.3-Flash NEW 轻量旗舰模型，高质量极速响应' },
  { name: 'GLM-5.3', text: 'GLM-5.3 旗舰模型，擅长编程与长程任务' },
  { name: 'GLM-5.2', text: 'GLM-5.2 上一代旗舰模型' },
];

test('前缀陷阱：选 GLM-5.3 绝不能落到 GLM-5.3-Flash', () => {
  // 这是本轮最重要的一条：z.ai 上两者共存，且前者是后者的前缀。
  assert.equal(pickExactOption(zaiOptions, 'GLM-5.3'), 1, 'GLM-5.3 必须命中下标 1，而不是 0');
  assert.equal(pickExactOption(zaiOptions, 'GLM-5.3-Flash'), 0, 'GLM-5.3-Flash 必须命中下标 0');
  assert.equal(pickExactOption(zaiOptions, 'GLM-5.2'), 2);
});

test('精确匹配：名字节点混进描述文本时仍能命中', () => {
  // GLM 网页上选项的名字节点是 .item-model-box，但整项文本是「GLM-5.3极致…」。
  // 契约把名字节点单独取出来，所以这里模拟「只有名字」的情形。
  const glmOptions = [{ name: 'GLM-5.3' }, { name: 'GLM-Flash' }];
  assert.equal(pickExactOption(glmOptions, 'GLM-5.3'), 0);
  assert.equal(pickExactOption(glmOptions, 'GLM-Flash'), 1);
  // 描述混在名字里的形态：以分隔符接续才算命中
  const withDesc = [{ name: 'GLM-5.3 旗舰模型，擅长编程' }];
  assert.equal(pickExactOption(withDesc, 'GLM-5.3'), 0);
  // 但「紧接着是字母」的绝不能算命中（GLM-5.3X 不是 GLM-5.3）
  assert.equal(pickExactOption([{ name: 'GLM-5.3X' }], 'GLM-5.3'), -1);
});

test('匹配要容忍大小写与空白差异，但不做模糊猜测', () => {
  assert.equal(normalizeModelName('  GLM-5.3  '), 'glm-5.3');
  assert.equal(normalizeModelName('K3  集群'), 'k3 集群');
  assert.equal(pickExactOption([{ name: 'glm-5.3' }], 'GLM-5.3'), 0);
  assert.equal(pickExactOption([{ name: 'GLM-5.3' }], 'K3'), -1, '不存在的模型必须返回 -1，不得回落到第一个选项');
  assert.equal(pickExactOption([], 'GLM-5.3'), -1);
  assert.equal(pickExactOption(zaiOptions, ''), -1);
});

test('候选名比目标短时（目标带后缀）也能命中', () => {
  // 反向容忍：目标写成 "GLM-5.3-Flash NEW" 而节点只给 "GLM-5.3-Flash"
  assert.equal(pickExactOption([{ name: 'GLM-5.3-Flash' }], 'GLM-5.3-Flash NEW'), 0);
});

test('picker 契约可用性：弹层式必须有 trigger，分段式故意不需要', () => {
  // 弹层式（z.ai/GLM/Kimi）：点触发 → 枚举弹层 → 点选项
  assert.equal(pickerUsable({ trigger: '.a', option: '.b' }), true);
  assert.equal(pickerUsable({ trigger: '.a' }), false, '没有 option 无从选择');
  assert.equal(pickerUsable({ option: '.b' }), false, '弹层式缺 trigger 无法开弹层');
  // 分段式（豆包「对话/工作」）：选项常驻页面、点击即切换。
  // 这里 trigger **故意缺失**——分段控件的"触发"就是选项本身，点它会先把模式切走。
  assert.equal(pickerUsable({ segmented: true, option: '.b' }), true, '分段式不需要 trigger');
  assert.equal(pickerUsable({ segmented: true }), false, '分段式仍必须有 option');
  assert.equal(pickerUsable(null), false);
  assert.equal(pickerUsable({}), false);
});

test('已校准站点的契约与目录一致：labels 必须能在契约里找到', () => {
  // 契约（选择器）与目录（labels）是两处独立声明，容易各改一半。这里做一次
  // 一致性检查：声明了 modelPicker 的站点，其每个非 auto 模型的 labels[0]
  // 都必须是非空字符串（那是精确匹配的目标）。
  for (const st of ['zai', 'glm', 'kimi', 'doubao']) {
    const site = getSite(st);
    assert.ok(pickerUsable(site.modelPicker), st + ' 应声明可用的 modelPicker 契约');
    for (const m of site.models) {
      if (m.id === 'auto') continue;
      assert.equal(typeof m.labels?.[0], 'string');
      assert.ok(m.labels[0].trim().length > 0, st + ':' + m.id + ' 的 labels[0] 不得为空');
    }
  }
  // 豆包：模式是「对话 / 工作」，本地默认取**对话**（目录第一条即首选）
  const doubao = getSite('doubao');
  assert.equal(doubao.modelPicker.segmented, true);
  assert.equal(doubao.modelPicker.trigger, undefined, '分段式不得声明 trigger');
  assert.equal(doubao.models[0].id, 'chat', '本地默认应为对话模式');
  assert.deepEqual(doubao.models.filter((m) => m.id !== 'auto').map((m) => m.labels[0]), ['对话', '工作']);
});

test('目录与别名：真实条目可解析，旧设置值仍可用', () => {
  const all = listAllModels();
  const ids = new Set(all.map((m) => m.id));
  for (const id of ['zai:glm-5.3', 'zai:glm-5.3-flash', 'zai:glm-5.2',
    'glm:glm-5.3', 'glm:glm-5.3-flash', 'kimi:k3', 'kimi:k3-cluster', 'kimi:quick']) {
    assert.ok(ids.has(id), '目录必须包含 ' + id);
  }
  // 0.12.9 的旧值
  assert.equal(resolveWebModel('zai:auto').id, 'auto');
  assert.equal(resolveWebModel('glm:auto').id, 'auto');
  assert.equal(resolveWebModel('glm-4.6').id, 'glm-5.3', '旧的 glm-4.6 设置值要收敛到当前版本');
  // 用户的写法
  assert.equal(resolveWebModel('z.ai-glm5.3').id, 'glm-5.3');
  assert.equal(resolveWebModel('zai-glm-5.3-flash').id, 'glm-5.3-flash');
  // 未知模型必须抛，不得静默回落
  assert.throws(() => resolveWebModel('zai:definitely-not-a-model'), /不支持的网页模型/);
});