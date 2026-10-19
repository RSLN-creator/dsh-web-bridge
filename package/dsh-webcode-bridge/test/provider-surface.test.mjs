// provider-surface.test.mjs — 钉住「对外的 provider / 模型目录面」逐字不变。
//
// ## 这个文件在防什么
//
// 0.19.50 起本项目要把散落的「站点知识」收成 `lib/sites/<siteId>.js`（每站点一个文件、
// 导出同一形状的对象），**逐站点迁移、DeepSeek 先行**。这类重构最危险的不是写错新代码，
// 而是**在搬家的过程中悄悄改变了对外可观测的形状**——比如少了一个 provider、
// 模型 id 变了一个字符、分组名多了一个前缀。它们都不会让任何现有单测变红，
// 却会让**历史设置值、旧会话、OpenAI 前端**同时失配。
//
// 因此本文件先于迁移存在（test-first）：它把「迁移前的对外面」逐字记下来，
// 之后每一次搬家都必须证明自己没有动它。
//
// ## 判据
//
//   1. **站点表**：id 列表与顺序逐字不变（顺序即 /models 列表顺序）；
//   2. **provider id 表**：`providerIdsForRegistration()` 逐字不变（含兼容空壳 `webcode`）；
//   3. **模型目录**：`listAllModels()` 的 (provider, id) 对逐字不变；
//   4. **分组名**：每站点的分组名逐字不变（GLM → `chatglm` 这条覆盖不能被吞掉）；
//   5. **可逆**：`siteIdForProvider(providerIdForSite(s)) === s` 对全部站点成立。
//
// ⚠ **改这些期望值时必须停下来问一句「这是有意的对外变更吗」**——
// 本文件的全部价值就在于改它需要一次停顿。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SITES, providerIdsForRegistration, providerIdForSite, siteIdForProvider,
  providerGroupName, listAllModels, resolveWebModel,
} from '../lib/providers.js';

/** 站点 id 与顺序（顺序即 OpenAI /models 的列表顺序）。 */
const EXPECTED_SITE_IDS = [
  'deepseek', 'glm', 'chatgpt', 'kimi', 'qwen', 'doubao', 'grok', 'claude', 'gemini', 'zai',
  // 0.21.0 有意新增：z.ai 国内站（zchat.z.ai）与海外站是两个站点（用户 2026-10-20 明令区分）
  'zai-cn',
];

/**
 * 注册的 provider id。**只有 1 个**（0.19.53）。
 *
 * 0.19.28–0.19.52 是「十个站点各一个 + 一个兼容空壳」共 11 个；2026-10-02 用户
 * 指令反转：**全部站点放进同一个组**，且明确「不要旧兼容路由」——
 * `webcode-<siteId>` 因此不再注册。
 *
 * ⚠ 真 provider 必须是 `webcode` 这个 id：它是存量里压倒性的主力（会话日志
 * 15021 次、会话状态缓存 6093 次）。换个新 id 会让这批存量全部失配。
 *
 * ⚠ 与之配套的**语义反转**：旧实现里 `webcode` 是「空壳」（listModels 返回空、
 * 靠 `group.models.length > 0` 不生成组）。现在它是唯一真路由，
 * **listModels 必须返回模型**，否则宿主 `modelAvailable` 的第二道判据失败
 * ⇒「插件装了但一个模型都选不了」。
 */
const EXPECTED_PROVIDER_IDS = ['webcode'];

/**
 * 每站点的组键（0.19.53：不再带 `webcode-` 前缀）。
 *
 * 只有一组时那个前缀是噪音——它原本的作用是「在多组并列时标明这些组来自网页桥」。
 * 现在站点键只用于**行名前缀**（`glm/GLM-5.3` vs `z.ai/glm-5.3`）。
 *
 * `glm → chatglm` 是 `PROVIDER_GROUP_NAME_OVERRIDES` 给出的覆盖，**不能被吞掉**：
 * GLM 的 `shortKey` 故意没改成 `chatglm`（它同时被 `modelDisplayName` 用，
 * 改了会变成 `glmglm-5.3`），组键因此必须走覆盖表。
 *
 * `zai → z.ai` 必须保留：z.ai 与 glm **有同名模型**（`glm-5.3`），
 * 合并成唯一一组后，行名若不带这个键就会出现两行逐字相同的 `GLM-5.3`。
 */
const EXPECTED_GROUP_NAMES = {
  deepseek: 'deepseek', glm: 'chatglm', chatgpt: 'chatgpt',
  kimi: 'kimi', qwen: 'qwen', doubao: 'doubao',
  grok: 'grok', claude: 'claude', gemini: 'gemini', zai: 'z.ai',
  'zai-cn': 'zchat.z.ai',
};

/**
 * 每站点的**显示名**（2026-10-03 用户指令：「全部统一成网站原名」，例：豆包 → Doubao）。
 *
 * 这一样为什么算「对外面」：它就是用户在**右栏标签页标题 / 工具条 / 站点目录卡片 /
 * 设置页站点 tab / 账户行**上读到的字。它此前散成两份且互不相同——
 *   · `lib/providers.js` 的 `name`：`DeepSeek 网页版` / `智谱清言 (GLM)` / `通义千问 (Qwen)` / `豆包`
 *   · `lib/client.cjs` 的 `SITE_NAMES`：`DeepSeek` / `智谱清言` / `通义千问` / `豆包`
 * 于是**同一个站点在两处是两个名字**，用户报的「右侧网页界面单个账户（豆包）不显示
 * 原来网站名称」正是这一处。改判据前请停下来问一句：这是有意的对外变更吗？
 */
const EXPECTED_SITE_NAMES = {
  deepseek: 'DeepSeek', glm: 'GLM', chatgpt: 'ChatGPT',
  kimi: 'Kimi', qwen: 'Qwen', doubao: 'Doubao',
  grok: 'Grok', claude: 'Claude', gemini: 'Gemini', zai: 'Z.ai',
  'zai-cn': 'Z.ai 中国站',
};

test('判据 1：站点 id 与顺序逐字不变', () => {
  assert.deepEqual(SITES.map((s) => s.id), EXPECTED_SITE_IDS);
});

test('判据 2：注册的 provider id 逐字不变（唯一真路由 webcode）', () => {
  assert.deepEqual(providerIdsForRegistration(), EXPECTED_PROVIDER_IDS);
  assert.ok(
    providerIdsForRegistration().includes('webcode'),
    '真 provider 必须是 `webcode`——存量里压倒性主力（会话日志 15021 次）依赖这个 id',
  );
  // 站点 provider **不得**再注册（用户明确「不要旧兼容路由」）。
  for (const s of SITES) {
    assert.ok(
      !providerIdsForRegistration().includes(providerIdForSite(s.id)),
      `站点 provider ${providerIdForSite(s.id)} 不应再注册`,
    );
  }
});

test('判据 3：分组名逐字不变（GLM 的 chatglm 覆盖不能被吞掉）', () => {
  const got = {};
  for (const s of SITES) got[s.id] = providerGroupName(s.id);
  assert.deepEqual(got, EXPECTED_GROUP_NAMES);
});

test('判据 4：provider id ↔ siteId 可逆', () => {
  for (const s of SITES) {
    assert.equal(siteIdForProvider(providerIdForSite(s.id)), s.id,
      '站点 ' + s.id + ' 的 provider id 必须能解析回它自己');
  }
  // 空壳不是任何站点，必须解析不出来（或解析成 null），不能凭空造一个站点。
  assert.ok(!EXPECTED_SITE_IDS.includes(siteIdForProvider('webcode')),
    '兼容空壳 webcode 不得被解析成某个站点');
});

test('判据 5：模型目录非空，且每行都带得出站点与 id', () => {
  const models = listAllModels();
  assert.ok(Array.isArray(models), 'listAllModels 返回数组');
  assert.ok(models.length > 0, '模型目录不得为空');
  for (const m of models) {
    assert.equal(typeof m.id, 'string', '模型行的 id 必须是字符串');
    assert.ok(m.id.length > 0, '模型行的 id 不得为空');
    assert.ok(EXPECTED_SITE_IDS.includes(m.siteId), `模型行 ${m.id} 的 siteId 必须是已知站点`);
  }
});

test('判据 6：模型目录的形状快照（防「少了一行」这类静默缩水）', () => {
  const models = listAllModels();
  // 17 行是 0.19.50 迁移前的实测读数；0.21.0 有意 +3（新站点 zai-cn 的三个模型）。
  // 这是**对外面**的一部分：少一行意味着某个模型从选择器里消失。
  assert.equal(models.length, 20,
    '模型目录共 20 行（17 + 0.21.0 zai-cn 的 3 个模型）。实际：' + models.length + ' 行 —— 若这是有意的变更，请同时更新本期望值并说明理由');
  // 兼容别名必须仍在（历史会话与 OpenAI 前端的 `model: 'deepseek-web'` 依赖它）。
  assert.ok(models.some((m) => m.id === 'deepseek-web'),
    '兼容别名 `deepseek-web` 必须仍在目录里——历史设置值与 OpenAI 前端依赖它解析');
});

/**
 * 从 `lib/client.cjs` 的源码里抽出 `SITE_NAMES` 字面量。
 *
 * 为什么要抽源码而不是渲染后读文本：客户端半边是单文件 bundle（`window.__ModuleLoader__`
 * 注册、只能 `require`，**不能 import lib/**），因此服务端拿不到它、它也拿不到服务端；
 * 两边唯一的对齐方式就是**静态比对**。渲染后比对只能覆盖「渲染过的那些站点」，
 * 而漂移恰恰可以先出现在没人渲染的那一个上。
 */
function clientSiteNames() {
  const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/client.cjs'), 'utf8');
  const m = src.match(/const SITE_NAMES = \{([\s\S]*?)\};/);
  assert.ok(m, 'client.cjs 里找不到 `const SITE_NAMES = {…};` 字面量——先修本测试的解析');
  const out = {};
  // 0.21.0：站点键可能带连字符（如 'zai-cn'），必须允许引号键，否则解析器会静默漏行。
  for (const kv of m[1].matchAll(/(?:'([a-z][a-z0-9.-]*)'|([a-z][a-z0-9.]*))\s*:\s*'([^']*)'/g)) out[kv[1] || kv[2]] = kv[3];
  return out;
}

test('判据 7：站点显示名 = 网站原名，且客户端 `SITE_NAMES` 与服务端 `name` 逐字一致', () => {
  const server = {};
  for (const s of SITES) server[s.id] = s.name;
  assert.deepEqual(server, EXPECTED_SITE_NAMES,
    'providers.js 的站点显示名必须逐字等于网站原名（豆包 → Doubao，不是中文译名、不带括号注解）');
  const client = clientSiteNames();
  assert.deepEqual(client, EXPECTED_SITE_NAMES,
    'client.cjs 的 SITE_NAMES 与 providers.js 的 name 漂移了——同一个站点会在右栏与设置页显示成两个名字，'
    + '而任何只渲染一侧的单测都不会红（这正是用户报过的症状）');
});

// ── 判据 8（0.19.86）：目录条目与 resolveWebModel 的**带图能力**必须同值 ──────────
//
// ## 本条防的是哪一次真缺陷（2026-10-16 实测）
//
// 同一个模型有**两条取数路径**，而它们对「能不能带图」给出了**相反**的答案：
//   · **目录路径**：`listAllModels()` 的条目 → 被 `web-control.js` 的
//     `GET models`（`:968`）与 `GET context-windows`（`:999`）**原样返回**；
//   · **解析路径**：`resolveWebModel(id)` → `index.js:1270` 的
//     `inputModalities`（**护栏**：宿主只在它不含 'image' 时把图片换成文字占位）。
//
// 冲突实例：兼容别名 `deepseek-web`（**且它就是 `DEFAULT_MODEL_ID`**）的目录条目
// **漏了 `acceptsImages` 字段**（显式为 undefined ⇒ 假），而
// `resolveWebModel('deepseek-web')` 解析到**同一个** DeepSeek 模型是 `true`。
//
// 为什么它危险（不是「差一个字段」）：`index.js:1263-1266` 的注释写得很清楚——
// `inputModalities` 声明错方向时，**harness 截图会在到达桥之前就被剥离**，
// 症状是「网页端说没图」，而**桥这边看不到任何异常**。⇒ 一个漏掉的字段
// 会让那条护栏在**默认模型**上静默失效。
//
// ⚠ 本判据只查「两条路径同值」，不查「该值是否符合真机事实」——后者要真机读数
//   （见 `.tmp/image-verify/IMAGE-VERIFY-RESULTS.md` 的四态）。
test('判据 8：每个目录条目的 acceptsImages 必须等于 resolveWebModel 的解析值', () => {
  const items = listAllModels();
  const bad = [];
  for (const m of items) {
    const viaCatalog = m.acceptsImages === true;
    const resolved = resolveWebModel(m.id);
    const viaResolve = resolved?.acceptsImages === true;
    if (viaCatalog !== viaResolve) bad.push({ id: m.id, catalog: viaCatalog, resolve: viaResolve });
  }
  assert.deepEqual(bad, [],
    '目录条目与 resolveWebModel 对「能不能带图」给出了不同答案 —— 同一个模型两条取数路径自相矛盾：'
    + JSON.stringify(bad)
    + '。\n目录条目会被 web-control 的 GET models / GET context-windows 原样返回，'
    + '而 resolveModel 的 inputModalities 是**护栏**（声明错方向 ⇒ harness 在到达桥之前就把图剥掉）。');

  // 正向对照：`deepseek-web`（默认模型）也必须一致 —— 它曾正是这条判据抓到的那个洞。
  const alias = items.find((m) => m.id === 'deepseek-web');
  assert.ok(alias, 'deepseek-web 别名条目必须仍在目录里（历史设置值依赖它解析）');
  assert.equal(alias.acceptsImages, resolveWebModel('deepseek-web').acceptsImages === true,
    'deepseek-web 是 DEFAULT_MODEL_ID，它的目录条目必须与解析值同源'
    + '（修前这个字段整个漏掉 ⇒ 目录说 false、解析说 true）');
});
