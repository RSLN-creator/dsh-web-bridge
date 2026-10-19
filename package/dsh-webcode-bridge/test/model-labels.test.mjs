// model-labels.test.mjs — 模型显示名必须是「站点短键/模型 id」（0.14.0）。
//
// 为什么需要这个护栏：DSH 的模型选择器**只渲染 model.name**，不拼 provider
// （dsh-client-ui-model-selection 的 option 渲染只读 model.name）。
//
// 2026-09-28 更新：分组标题来自 providerInfo(provider).name，而它**不再**是整包
// 共用的「Harness Web Bridge」——模型目录已按站点拆成多个 provider，每组标题
// 取站点短键/域（chatglm / deepseek / z.ai …）。本文件末尾那三条测试钉住拆分
// 本身：组名、组内裸名、以及旧 provider 兼容空壳仍然可解析。
// 旧目录里 8 个站点都叫 `auto`、GLM 有两个站点都叫 `glm-5.3`，选择器上根本
// 分不出这一行是哪个网站——用户的原话就是「不能只有模型名不知道哪个网站的」。
//
// 本文件同时钉住两件容易一起改坏的事：
//   ① 显示名与 id 必须一一对应（`z.ai/glm-5.3` ↔ `zai:glm-5.3`），
//      否则 UI 上选的和实际路由到的不是同一个东西；
//   ② 带站点前缀的名字**绝不能**回流到网页（model-picker 的目标名必须仍是
//      网页上的原始名字）——网页上永远不会出现 `z.ai/` 这个前缀。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITES, listAllModels, resolveWebModel, MODEL_ALIAS_IDS, MODEL_PROVIDER_COMPAT_ID, providerIdForSite, siteIdForProvider, providerGroupName, providerIdsForRegistration } from '../lib/providers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.resolve(here, '..', p), 'utf8');

/** 兼容别名条目：与 deepseek:deepseek 指向同一个模型，故意同名同形。
 *  集合来自 providers 的唯一定义处——这里**不再**本地写一份字面量（两处定义
 *  必然漂移，而漂移的后果是别名条目要么漏过滤、要么被误删）。 */
const ALIAS_IDS = MODEL_ALIAS_IDS;

test('每个模型名都是「站点短键/模型 id」，且与 id 一一对应', () => {
  const all = listAllModels();
  assert.ok(all.length >= 10, '目录不应为空');
  for (const m of all) {
    // 形态：小写站点键 + '/' + 模型 id（模型 id 本身可含点/连字符）
    assert.match(m.name, /^[a-z0-9.-]+\/[a-z0-9.-]+$/, `${m.id} 名字不是「站点/模型」形态: ${m.name}`);
    const [key, modelPart] = m.name.split('/');
    // 别名条目没有 ':'（它是不带站点前缀的历史 id），名字仍指向同一个模型。
    const wantModel = ALIAS_IDS.has(m.id) ? 'deepseek' : m.id.split(':')[1];
    assert.equal(modelPart, wantModel, `${m.id} 的名字后段必须逐字等于模型 id: ${m.name}`);
    // 站点键默认等于站点 id；zai 是唯一例外（真实身份是 z.ai 这个域名）。
    const st = SITES.find((s) => s.id === m.siteId);
    assert.equal(key, st.shortKey || st.id, `${m.id} 的站点键不对: ${m.name}`);
  }
});

test('DeepSeek 只有一个模型，显示名就是 deepseek/deepseek', () => {
  const all = listAllModels();
  const ds = all.filter((m) => m.siteId === 'deepseek');
  // deepseek-web 是兼容别名条目，与 deepseek:deepseek 指向同一个模型。
  assert.deepEqual(ds.map((m) => m.id).sort(), ['deepseek-web', 'deepseek:deepseek']);
  assert.equal(all.find((m) => m.id === 'deepseek:deepseek').name, 'deepseek/deepseek');
  assert.equal(all.find((m) => m.id === 'deepseek-web').name, 'deepseek/deepseek');
});

test('显示名全局唯一（选择器上不可能出现两行同名）', () => {
  const seen = new Map();
  for (const m of listAllModels()) {
    if (ALIAS_IDS.has(m.id)) continue;   // 兼容别名与本体同形，是设计如此
    assert.ok(!seen.has(m.name), `${m.id} 与 ${seen.get(m.name)} 同名: ${m.name}`);
    seen.set(m.name, m.id);
  }
});

test('每个显示名都能被 resolveWebModel 解析回同一个模型（显示名不是死文字）', () => {
  for (const m of listAllModels()) {
    const r = resolveWebModel(m.id);
    assert.equal(r.siteId, m.siteId, m.id + ' 解析出的站点不对');
    // 带站点短键的显示名**不得**作为 id 反查（它不是 id，只是标签）
    assert.equal(r.name, m.name, m.id + ' 解析回来的显示名应一致');
    // 兼容别名条目（deepseek-web）没有 ':'，它指向 DeepSeek 的唯一模型。
    const modelPart = m.id.includes(':') ? m.id.split(':')[1] : 'deepseek';
    assert.equal(r.id, modelPart, m.id + ' 解析出的模型 id 不对');
  }
});

test('网页侧目标名（webName / labels）永远不含站点前缀', () => {
  // 这是 model-picker 的成败线：网页上只认 GLM-5.3 / GLM-Flash / K3 这些名字，
  // 拿 `z.ai/glm-5.3` 去比对必然 option-not-in-list。
  for (const st of SITES) {
    for (const m of st.models) {
      if (m.labels) for (const l of m.labels) assert.ok(!l.includes('/'), `${st.id}:${m.id} 的 label 含 '/'：${l}`);
    }
  }
  for (const id of ['zai:glm-5.3', 'glm:glm-5.3', 'kimi:k3', 'doubao:chat']) {
    const r = resolveWebModel(id);
    assert.ok(r.webName && !r.webName.includes('/'), id + ' 缺少干净的 webName');
    assert.notEqual(r.name, r.webName, id + ' 的显示名与网页名不应该相同（那说明站点前缀丢了）');
  }
});

test('别名 deepseek-web 仍可解析，但不作为选择器里的第二行', () => {
  // 别名的存在意义是「历史值仍可解析」：旧会话、旧设置的 agent-default-model、
  // 以及 OpenAI 前端的 model:'deepseek-web' 都依赖它。
  assert.equal(resolveWebModel('deepseek-web').id, 'deepseek');
  // 但它与 deepseek:deepseek 显示名逐字相同 → 下拉里必须过滤掉（否则两行同名）。
  const alias = listAllModels().find((m) => m.id === 'deepseek-web');
  const primary = listAllModels().find((m) => m.id === 'deepseek:deepseek');
  assert.equal(alias.name, primary.name, '别名与本体同名是过滤的前提，不是 bug');
  assert.ok(ALIAS_IDS.has('deepseek-web'), 'MODEL_ALIAS_IDS 必须包含 deepseek-web');
});

test('选择器去重落在三处，且前端字面量与 providers 集合一致', () => {
  // 后端适配器：listModels 必须过滤别名。
  const indexSrc = read('lib/index.js');
  assert.match(indexSrc, /MODEL_ALIAS_IDS\.has\(m\.id\)/,
    'lib/index.js 的 listModels 必须用 MODEL_ALIAS_IDS 过滤别名');
  // 前端（浏览器侧 bundle）：无法 import providers，只能重复一份字面量——
  // 这里把它与 providers 的集合**钉在一起**，任何一边改了另一边没改就失败。
  const clientSrc = read('lib/client.cjs');
  const m = /const aliasIds = new Set\(\[([^\]]*)\]\)/.exec(clientSrc);
  assert.ok(m, 'lib/client.cjs 的 ModelSelect 必须有 aliasIds 过滤（否则下拉出现重复行）');
  const frontendIds = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.deepEqual(new Set(frontendIds), new Set([...ALIAS_IDS]),
    '前端别名字面量与 providers.MODEL_ALIAS_IDS 必须一致: ' + frontendIds.join(','));
});

test('z.ai 的显示名用域名短键，内部路由 id 不变（历史设置值仍解析）', () => {
  assert.equal(resolveWebModel('zai:glm-5.3').name, 'z.ai/glm-5.3');
  // 别名与历史写法全部仍解析到同一个模型（内部 id 不变）
  for (const alias of ['z.ai-glm5.3', 'zai-glm-5.3', 'glm-zai-5.3']) {
    const r = resolveWebModel(alias);
    assert.equal(r.siteId, 'zai', alias + ' 必须解析到 zai（内部 id 不变）');
    assert.equal(r.id, 'glm-5.3', alias + ' 必须解析到 glm-5.3');
  }
  // glm-4.x 是**国内站点**的历史写法，收敛到 chatglm.cn 而不是 z.ai
  assert.equal(resolveWebModel('glm-4.6').siteId, 'glm');
  assert.equal(resolveWebModel('glm-4.6').name, 'glm/glm-5.3');
});

// ---------------------------------------------------------------------------
// 分组（2026-09-28）：模型选择器「一个网站一层」
//
// DSH 侧机制（实读 dsh-api-session-controller 的 buildModelCatalog）：
//   一个 provider = 一组；组标题取 providerInfo(provider).name；组 id 必须逐字
//   等于 provider id；且 `group.models.length > 0` 的组才会出现在目录里。
// 因此本文件的判据就是那三条的直接推论。
// ---------------------------------------------------------------------------

/** 期望的站点键（0.19.53：不再带 `webcode-` 前缀，只有一组时它是噪音）。
 *  手写对照表，见下方断言注释。 */
const EXPECTED_GROUP_NAMES = Object.freeze({
  deepseek: 'deepseek',
  glm: 'chatglm',  // 站点 id 是 glm，但真实域名是 chatglm.cn
  chatgpt: 'chatgpt',
  kimi: 'kimi',
  qwen: 'qwen',
  doubao: 'doubao',
  grok: 'grok',
  claude: 'claude',
  zai: 'z.ai',     // 短键即真实域名
  // 0.21.0 有意新增：z.ai 国内站（用户明令「国内国外是两个站点」）
  'zai-cn': 'zchat.z.ai',
  gemini: 'gemini',
});

test('注册表里只有唯一真 provider `webcode`，站点键仍可反查', () => {
  const ids = providerIdsForRegistration();
  // 0.19.53：全部站点放进一个组，站点 provider **不再注册**（用户：不要旧兼容路由）。
  assert.deepEqual(ids, [MODEL_PROVIDER_COMPAT_ID], '必须只注册 webcode 一个 provider');
  assert.equal(new Set(ids).size, ids.length, 'provider id 不得重复（重复 = 插件无法加载）');
  for (const st of SITES) {
    const pid = providerIdForSite(st.id);
    // 站点 id **不注册**——它只是历史形状，服务侧不再提供
    assert.ok(!ids.includes(pid), `${st.id} 的 provider 不应再注册`);
    // 但仍必须**认得**：存量会话/配置里存着这些字面值，解析它们用于诊断与报错。
    assert.equal(siteIdForProvider(pid), st.id, pid + ' 反查不回原站点');
    // 站点键 = 短键/域。写成**显式对照表**而不是复用实现里的 shortKey||id：
    // 复用实现等于用实现验证实现，覆盖表改了它也跟着改，等于没护栏。
    assert.equal(providerGroupName(st.id), EXPECTED_GROUP_NAMES[st.id], st.id + ' 的组名不对');
  }
  // 反向：不认识的 provider 一律 null，不许猜站点
  assert.equal(siteIdForProvider('webcode-nope'), null);
  assert.equal(siteIdForProvider('deepseek-official'), null);
});

test('GLM 与 Z.ai 的站点键可分辨（同名模型靠行名区分）', () => {
  // 0.19.53 反转：用户原话「放一起、不要按站点隔开」。二者不再各占一组，
  // 但仍必须**可分辨**——z.ai 是另一个网站，两个站点都有一个 `glm-5.3`。
  //
  // 分组消失后，区分的责任从「组标题」转移到「行名前缀」（`modelGroupEntryName`
  // 拼的 `chatglm/GLM-5.3` vs `z.ai/GLM-5.3`）。这里钉住键本身可分辨，
  // 「行名真的带上了它」由 regression.test.mjs 钉住。
  assert.equal(providerGroupName('glm'), 'chatglm');
  assert.equal(providerGroupName('zai'), 'z.ai');
  assert.notEqual(providerGroupName('glm'), providerGroupName('zai'));
  // 两个站点确实各有一个 glm-5.3（同名），这正是行名必须带站点键的原因
  const g = resolveWebModel('glm:glm-5.3');
  const z = resolveWebModel('zai:glm-5.3');
  assert.equal(g.id, z.id, '两个站点的模型 id 同名，是行名要解决的问题');
  assert.notEqual(g.siteId, z.siteId);
});

test('站点键不再带 webcode- 前缀（只有一组时它是噪音）', () => {
  // 0.19.53：前缀原本的作用是「在多组并列时标明这些组来自网页桥」
  //（用户 2026-09-28 原话「可见组名改为 wecode-xxx 的名字好区分」）。
  // 现在只有一组，前缀既不提供区分度、又会污染**行名**（`webcode-glm/GLM-5.3`）。
  for (const st of SITES) {
    const name = providerGroupName(st.id);
    assert.ok(!name.startsWith('webcode-'), `${st.id} 的站点键不应再带前缀: ${name}`);
    assert.ok(name.length > 0, `${st.id} 的站点键不得为空`);
  }
});

test('真 provider `webcode` 承载全站点语义', () => {
  // 存量证据（真机读数）：会话日志里 `webcode` 出现 15021 次、会话状态缓存
  // 6093 次，是压倒性主力 —— 真 provider 必须沿用这个 id，换名会让存量全失配。
  assert.ok(providerIdsForRegistration().includes('webcode'), '真 provider 必须是 webcode');
  // 它承载的是**全站点**语义：不限定站点，所以反查刻意返回 null（哨兵）
  assert.equal(siteIdForProvider('webcode'), null);
});