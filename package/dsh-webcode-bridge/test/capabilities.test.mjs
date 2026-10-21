// capabilities.test.mjs — 钉住「站点能力由声明决定，驱动不再点名站点」这条规则。
//
// ## 这个文件在防哪一次事故
//
// `browser-driver.js` 里曾有 **6 处 `siteId === 'deepseek'`** 的硬编码分支：
//
//   · 模型选择走 selectModelDeepSeek 还是通用 picker；
//   · 是否去跑 UI 代际侦测（classic / unified）；
//   · localStorage 里网页 API 令牌的键名（两处：getToken 与 webApi）；
//   · listSessions / fetchHistory 是不是支持。
//
// 它们表达的是同一件事——**DeepSeek 是唯一拥有完整网页 API 能力的站点**，
// 其余 9 站全靠 DOM 抓取——但写成了 6 段散落的 if。代价是可预期的：
// 新增一个「也带会话 API」的站点时，得在 6000 行的驱动里找齐这 6 处逐处判断。
//
// 0.22.0 续把它们降为 `lib/sites/<id>.js` 的 `capabilities` 声明，
// 驱动只经 `capabilitiesOf()` 读（唯一入口）。本文件钉住那条路。
//
// ## 判据（五条）
//
//   1. **未声明 = 没有这项能力**：未知站点 / 无 capabilities 的站点，读到的都是 falsy；
//   2. **不猜**：`tokenKey` 未声明时必须是 null，不许回落到 `userToken` 这类「大概是它」的名字
//      （猜错会让抓取静默失败——本仓库记过同型事故）；
//   3. **deepseek 的声明逐项在场**：5 项能力一个不少（防止有人手滑删掉一项 → 静默降级）；
//   4. **其余 9 站一个都不声明**：这是「只动 DeepSeek」这条试点纪律的可核形状；
//   5. **源码级：驱动里不再有 `siteId === 'deepseek'` 的代码分支**（注释不算）。
//
// 判据 5 是**反向验证**的基础：把某一处改回 `siteId === 'deepseek'`，本文件必须变红。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilitiesOf } from '../lib/browser-driver.js';
import { SITES, getSite } from '../lib/providers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.resolve(here, '../lib/browser-driver.js');

test('① 未声明 = 没有这项能力（未知站点 / 无 capabilities 的站点都读到 falsy）', () => {
  // 未知站点：不抛错，给空对象（契约 1：不抛，让调用方按 falsy 走既有稳健路径）
  const unknown = capabilitiesOf('no-such-site');
  assert.equal(unknown.modelSelect, undefined, '未知站点不该凭空有 modelSelect');
  assert.equal(unknown.tokenKey, undefined, '未知站点不该凭空有 tokenKey');
  assert.equal(unknown.sessionApi, undefined);

  // 无 capabilities 的真实站点（glm）：同样读不到任何能力
  const glm = capabilitiesOf('glm');
  assert.equal(glm.sessionApi, undefined, 'glm 未声明 sessionApi，就不该读到它');
  assert.equal(glm.tokenKey, undefined, 'glm 未声明 tokenKey，就不该读到它');
});

test('② 不猜：tokenKey 未声明时是 null，不回落任何「大概是它」的名字', () => {
  // 驱动侧用法是 `capabilitiesOf(siteId).tokenKey || null`；
  // 这里钉住「未声明就是 undefined/null」，保证那个 `|| null` 不会兜到一个猜测值。
  for (const id of ['glm', 'kimi', 'qwen', 'doubao', 'grok', 'claude', 'gemini', 'zai', 'zai-cn']) {
    const tk = capabilitiesOf(id).tokenKey;
    assert.ok(tk === undefined || tk === null,
      `${id} 的 tokenKey 必须是 undefined/null，实得 ${JSON.stringify(tk)}——不许猜`);
  }
});

test('③ deepseek 的五项能力逐项在场（少一项就是静默降级）', () => {
  const c = capabilitiesOf('deepseek');
  assert.equal(c.modelSelect, 'pill', '模型选择路径：pill');
  assert.equal(c.uiGenerations, true, 'UI 代际侦测：开');
  assert.equal(c.tokenKey, 'userToken', '令牌键：userToken（真机 2026-09-13 实测）');
  assert.equal(c.sessionApi, true, '会话目录 API：有');
  assert.equal(c.historyApi, true, '历史消息 API：有');
});

test('④ 其余 9 站一个都不声明能力 —— 「只动 DeepSeek」的可核形状', () => {
  const others = SITES.filter((s) => s.id !== 'deepseek');
  assert.equal(others.length, 10, `预期 10 个非 deepseek 站点，实得 ${others.length}`);
  for (const s of others) {
    assert.equal(s.capabilities, undefined,
      `${s.id} 不该有 capabilities 声明（本轮只动 DeepSeek；要给它加能力，先有真机读数）`);
  }
});

test('⑤ 源码级：驱动里不再有用站点名判能力分支的代码（注释不算）', () => {
  const src = readFileSync(DRIVER, 'utf8');
  const offenders = [];
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return; // 注释放行
    if (/siteId\s*(===|!==|==|!=)\s*'deepseek'/.test(line)) offenders.push(`${i + 1}: ${t.slice(0, 90)}`);
  });
  assert.deepEqual(offenders, [],
    '驱动里仍有按站点名判能力的代码分支，应改为 capabilitiesOf(siteId).xxx：\n  ' + offenders.join('\n  '));
});

test('⑥ 能力读取的入口唯一：驱动只经 capabilitiesOf 读 capabilities', () => {
  const src = readFileSync(DRIVER, 'utf8');
  const lines = src.split(/\r?\n/);
  const direct = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*')) return;
    // 直接读 site.capabilities / getSite(...).capabilities 都算绕过唯一入口
    if (/\.capabilities\b/.test(line) && !/capabilitiesOf|EMPTY_CAPABILITIES/.test(line)) {
      direct.push(`${i + 1}: ${t.slice(0, 90)}`);
    }
  });
  assert.deepEqual(direct, [],
    '有绕过 capabilitiesOf 直接读 .capabilities 的地方：\n  ' + direct.join('\n  '));
});

test('⑦ getSite 与 capabilitiesOf 对同一站点给同一份声明（两条取法不许漂移）', () => {
  const ds = getSite('deepseek');
  assert.equal(capabilitiesOf('deepseek'), capabilitiesOf(ds),
    '传 siteId 与传站点对象必须读到同一份 capabilities');
});
