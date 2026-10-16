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
import { pickExactOption, normalizeModelName, pickerUsable, readbackConfirms, currentModelIsTarget } from '../lib/model-picker.js';
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

test('回读确认：选项带营销后缀时不得误判为「没切换成功」（真机 z.ai 2026-10-14）', () => {
  // ## 这条护栏是照真机日志写的（逐字）
  //
  // 现场：`模型回读不一致：目标 GLM-5.3-Flash，回读 GLM-5.3-Flash`
  // —— 两个字符串**看起来一样**，却判了不一致。真因是判据拿
  // **已点击那一项的整行文本**当右侧：
  //   选项行（真机逐字）= 'GLM-5.3-Flash NEW 轻量旗舰模型，高质量极速响应'
  //   触发回读           = 'GLM-5.3-Flash'
  // 于是 `'GLM-5.3-Flash'.includes('GLM-5.3-Flash NEW …')` 恒为 false。
  //
  // 代价不只是难听：`selectModelGeneric` 会把 `confirmed:false` 降级成
  // `strict:false` ⇒ 该站点的「严格模式」**静默失效**，而用户以为桥在校验。
  const ROW = 'GLM-5.3-Flash NEW 轻量旗舰模型，高质量极速响应';
  assert.equal(readbackConfirms('GLM-5.3-Flash', ROW, 'GLM-5.3-Flash'), true,
    '选项行带营销后缀时，回读到模型名必须算确认成功');

  // 正向：常规形态
  assert.equal(readbackConfirms('GLM-5.3-Flash', 'GLM-5.3-Flash', 'GLM-5.3-Flash'), true);
  assert.equal(readbackConfirms('GLM-5.3-Flash ▾', 'GLM-5.3-Flash', 'GLM-5.3-Flash'), true, '触发按钮带装饰也算');
  assert.equal(readbackConfirms('GLM-5.3-Flash NEW', 'GLM-5.3-Flash', 'GLM-5.3-Flash'), true, '回读更完整也算');

  // 反向（**这半条不能丢**）：真的不一致必须仍判 false，否则判据就成了「恒真」
  assert.equal(readbackConfirms('GLM-5.2', 'GLM-5.3-Flash', 'GLM-5.3-Flash'), false, '回读到别的模型必须 false');
  assert.equal(readbackConfirms(null, 'GLM-5.3-Flash', 'GLM-5.3-Flash'), false, '读不到必须 false');
  assert.equal(readbackConfirms('', 'GLM-5.3-Flash', 'GLM-5.3-Flash'), false);
  assert.equal(readbackConfirms('GLM-5.2', 'GLM-5.2-Flash', 'GLM-5.3-Flash'), false, '两边都不是目标名时不得放行');
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
    'glm:glm-5.3', 'glm:glm-5.3-flash', 'kimi:k3', 'kimi:k2.8-preview', 'kimi:quick']) {
    assert.ok(ids.has(id), '目录必须包含 ' + id);
  }
  // 0.19.43：glm / kimi / doubao / zai 四站点的 `auto` 已从**模型表**里真删
  //（桥自己发明的「不切换」档，不是网页档位），但历史设置值必须仍可解析 ——
  // 用户的 settings / `subagent-model-selection.allowedModels` 里可能还写着 `*:auto`，
  // 直接抛错会让那些配置当场变成不可解析值。
  // 落点各自收敛到**本站点**的档位（glm/zai → glm-5.3，kimi → k3，doubao → chat）。
  assert.equal(resolveWebModel('zai:auto').id, 'glm-5.3', 'zai:auto 收敛到本站点旗舰档');
  assert.equal(resolveWebModel('glm:auto').id, 'glm-5.3', 'glm:auto 收敛到本站点旗舰档');
  assert.equal(resolveWebModel('kimi:auto').id, 'k3', 'kimi:auto 收敛到本站点旗舰档');
  assert.equal(resolveWebModel('doubao:auto').id, 'chat', 'doubao:auto 收敛到「对话」');
  // `auto` 不再是**目录条目**（选择器里不该出现桥自造的档），但仍是可解析的别名
  assert.ok(!ids.has('zai:auto'), 'zai:auto 不该再出现在模型目录里（0.19.43 真删）');
  assert.ok(!ids.has('glm:auto'), 'glm:auto 不该再出现在模型目录里（0.19.43 真删）');
  // kimi 的 `k3-cluster` 同理：真机模型菜单里**已经没有**这一条
  //（think-effort.js 的注释记着「K3 集群已从菜单消失」），故不在目录里；
  // 但历史 id 仍走别名解析，落到本站点旗舰档 —— 旧设置值不会变成不可解析。
  assert.ok(!ids.has('kimi:k3-cluster'), 'kimi:k3-cluster 不该再出现在目录里（真机菜单已无此档）');
  assert.equal(resolveWebModel('kimi:k3-cluster').id, 'k3', 'kimi:k3-cluster 作为历史别名仍要能解析');
  assert.equal(resolveWebModel('glm-4.6').id, 'glm-5.3', '旧的 glm-4.6 设置值要收敛到当前版本');
  // 用户的写法
  assert.equal(resolveWebModel('z.ai-glm5.3').id, 'glm-5.3');
  assert.equal(resolveWebModel('zai-glm-5.3-flash').id, 'glm-5.3-flash');
  // 未知模型必须抛，不得静默回落
  assert.throws(() => resolveWebModel('zai:definitely-not-a-model'), /不支持的网页模型/);
});

// ── 幂等快路判据（0.19.81，z.ai 真机修出）──────────────────────────────────
//
// ## 真机背景（为什么会有这个判据）
//
// z.ai 在**发过一条消息之后**把模型按钮 `disabled=true`（60/60 采样、持续 ≥47s），
// 而 `selectModel` 每轮都调 ⇒ 第二轮点禁用按钮 → 菜单不开 → 0 选项
// ⇒ 报 `MODEL_UNAVAILABLE …（no-options）`（**误导**：真因是按钮不可用）。
//
// 修法：**页面已经是目标模型时不动 UI**（幂等快路）。但这条快路有个**方向性风险**，
// 必须被护栏钉住 —— 见下面第 ② 条。

test('幂等快路 ①：页面已是目标模型（含营销后缀）⇒ 判为「无需动作」', () => {
  assert.equal(currentModelIsTarget('GLM-5.3-Flash', 'GLM-5.3-Flash'), true, '逐字相等');
  assert.equal(currentModelIsTarget('GLM-5.3-Flash NEW', 'GLM-5.3-Flash'), true, '带 NEW 徽章');
  assert.equal(currentModelIsTarget('glm-5.3-flash', 'GLM-5.3-Flash'), true, '大小写不敏感');
  assert.equal(currentModelIsTarget(' GLM-5.3-Flash ', 'GLM-5.3-Flash'), true, '前后空白');
});

test('幂等快路 ②：★ 页面是更短的前缀（GLM-5.3 vs 目标 GLM-5.3-Flash）⇒ **必须判否**', () => {
  // 这条是**红线 1「绝不静默降级模型」**的护栏：
  // 若这里判成 true，快路就会跳过本该发生的切换 ⇒ 用户选了 Flash、网页停在 5.3，
  // 而界面上完全看不出来。`pickExactOption` 的规则③（候选是目标前缀）正是这样判的，
  // 所以快路**刻意不复用**它，改用只允许「候选 ≥ 目标」的 currentModelIsTarget。
  assert.equal(currentModelIsTarget('GLM-5.3', 'GLM-5.3-Flash'), false,
    '页面比目标更短 ⇒ 必须去点，不许跳过（否则就是静默降级）');
  assert.equal(currentModelIsTarget('GLM-5.2', 'GLM-5.3-Flash'), false, '完全不同的模型');
  assert.equal(currentModelIsTarget('GLM-5.3-Flas', 'GLM-5.3-Flash'), false, '目标的前缀但不是完整名');
});

test('幂等快路 ③：读不到当前模型 ⇒ 判否（不猜、照常走原路径）', () => {
  assert.equal(currentModelIsTarget(null, 'GLM-5.3-Flash'), false, 'null 不得当成命中');
  assert.equal(currentModelIsTarget('', 'GLM-5.3-Flash'), false, '空串不得当成命中');
  assert.equal(currentModelIsTarget('GLM-5.3-Flash', ''), false, '目标为空不得命中');
});

test('幂等快路 ④：分隔符边界 —— 更长的名字必须是**分隔符**衔接，不是字母', () => {
  // 防止 `GLM-5.3X` 被当成 `GLM-5.3` 的合法「带后缀」形态
  assert.equal(currentModelIsTarget('GLM-5.3X', 'GLM-5.3'), false, '字母直接相接 ⇒ 不是同族后缀');
  assert.equal(currentModelIsTarget('GLM-5.3 旗舰', 'GLM-5.3'), true, '空格分隔 ⇒ 允许');
  assert.equal(currentModelIsTarget('GLM-5.3-Flash', 'GLM-5.3'), true, '连字符分隔 ⇒ 允许');
});

// ── ★ 红线 1 洞（长期问题 #67）已在 0.19.82 修掉：readbackConfirms 不再是双向包含 ──
//
// 这条原先是个 `todo`（不阻断 CI），把洞钉成可复现用例。**0.19.82 已修**，所以它现在
// 是正式断言：判据删掉了「基准是回读的超串」那半个方向（理由与误判代价的不对称性
// 写在 `readbackConfirms` 的 JSDoc 里）。同文件下面还有一条「修法必须仍然容忍更完整的
// 回读」的对照——两半都不能丢。
test('#67 页面名比目标短 ⇒ 切换没生效，readbackConfirms 必须 false（修前是 true＝静默降级）', () => {
  // 真机场景：用户选 GLM-5.3-Flash，切换没生效，页面仍停在 GLM-5.3
  assert.equal(readbackConfirms('GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.3-Flash'), false,
    '页面比目标短 ⇒ 切换没生效，不得判 confirmed（旧双向包含在这里给 true）');
  // 同族的第二条：被点中项比目标短（选项名就是更笼统的那个）时，也不得因为
  // 「基准取短的」而把更短的页面名放行。
  assert.equal(readbackConfirms('GLM-5.3', 'GLM-5.3', 'GLM-5.3-Flash'), false,
    '点了 GLM-5.3（目标是 Flash）却回读到 GLM-5.3 ⇒ 不得 confirmed');
  // z.ai 真实模型表上的同一形态（三条档位：Flash / 5.3 / 5.2）
  assert.equal(readbackConfirms('GLM-5.2', 'GLM-5.3-Flash', 'GLM-5.3-Flash'), false,
    '回读到更低档必须 false');
});

test('★ 对照 #67：修法是**收窄**不是变严——装饰与「回读更完整」必须继续放行', () => {
  // 这半条是 readbackConfirms 存在的理由（真机 z.ai 曾因它误判「切换失败」，
  // 把 strict 静默降级成 false）。修 #67 时若把这半条一起删掉，就是从一个错
  // 换到另一个错。
  assert.equal(readbackConfirms('GLM-5.3-Flash NEW', 'GLM-5.3-Flash', 'GLM-5.3-Flash'), true,
    '回读更完整（选项行带营销后缀）必须继续放行');
  assert.equal(readbackConfirms('GLM-5.3-Flash ▾', 'GLM-5.3-Flash', 'GLM-5.3-Flash'), true,
    '触发按钮带装饰（回读更长）必须继续放行');
  // 与 currentModelIsTarget 的关系：两者现在同方向（候选 ≥ 目标），但用途不同——
  // 后者问「要不要动手」，前者问「动完手有没有生效」。
  assert.equal(currentModelIsTarget('GLM-5.3', 'GLM-5.3-Flash'), false);
  assert.equal(currentModelIsTarget('GLM-5.3-Flash', 'GLM-5.3-Flash'), true);
});