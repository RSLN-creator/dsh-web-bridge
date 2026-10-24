// settings-page-i18n.test.mjs — 设置页双语（0.22.2，GitHub Issue #2）的护栏。
//
// ## 用户原话与它对应的需求
//
// Issue #2（krischimk）：「No english translation」——设置页从标签、提示到按钮、
// 状态文案全是中文，英文用户无从下手。
//
// ## 冻结契约（护栏按它写）
//
//   · **静态文本中英成对、就地相邻**（同一模板行内的 .i18n-zh / .i18n-en）——
//     不允许出现「只有一种语言」的静态文案；翻译与原文永不分离，就没有第二份
//     字典可漂移（本项目反复记过的「第二套判据」一族）。
//   · **zh 是正本、en 是覆盖**：默认 CSS 只显中文（无 JS 行为与旧版一致）；
//     body.lang-en 时藏 zh 显 en。脚本必须带检测（localStorage 优先、
//     navigator.language 兜底）与重载式切换（location.reload）。
//   · **option / placeholder / title 三个属性位**走 data-en 覆盖（option 内容
//     按解析规则只许文本，span 会被剥掉——成对 span 在那里不成立）。
//   · **教学文本是协议真源（红线 3），永不翻译**：teaching 传入什么就原样进 <pre>。
//   · **动态文案字典 MSG**：zh 与 en 的条目数必须相等——一侧多一侧少就是漂移。
//
// ## 怎么跑这个文件
//
//   node --test test/settings-page-i18n.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSettingsPage } from '../lib/settings-page.js';

const MODELS = [
  { id: 'deepseek:deepseek', name: 'DeepSeek', siteName: 'DeepSeek' },
  { id: 'glm:glm', name: 'GLM', siteName: 'GLM', experimental: true },
];
const TEACHING = { default: 'DEFAULT-SHAPE', glm: 'GLM-SHAPE', trainDefault: 'TRAIN-DEFAULT', trainGlm: 'TRAIN-GLM' };
const html = renderSettingsPage(MODELS, TEACHING);

test('静态文本中英成对出现（关键标签不允许单语言）', () => {
  const pairs = [
    ['默认模型', 'Default model'],
    ['深度思考', 'Deep thinking'],
    ['全局指令（首轮注入）', 'Global instruction (first-turn injection)'],
    ['发送间隔（防频控限制）', 'Send gap (rate-limit guard)'],
    ['间隔基准', 'Gap basis'],
    ['并发车道上限', 'Concurrent lane cap'],
    ['子代理网页会话分配', 'Sub-agent web session assignment'],
    ['保存设置', 'Save settings'],
    ['下载浏览器', 'Download browser'],
    ['登录窗口', 'Login window'],
  ];
  for (const [zh, en] of pairs) {
    assert.ok(html.includes(zh), '缺少中文文案: ' + zh);
    assert.ok(html.includes(en), '缺少英文文案: ' + en);
  }
});

test('默认只显中文（.i18n-en 预设 display:none），body.lang-en 时反转', () => {
  assert.match(html, /\.i18n-en\s*\{\s*display:\s*none/);
  assert.match(html, /body\.lang-en \.i18n-zh\s*\{\s*display:\s*none/);
  assert.match(html, /body\.lang-en \.i18n-en\s*\{\s*display:\s*inline/);
});

test('语言检测与切换脚本存在（localStorage 优先 + navigator.language 兜底 + 重载式切换）', () => {
  assert.ok(html.includes("'webcode-settings-lang'"), '缺 localStorage 键');
  assert.ok(html.includes('navigator.language'), '缺浏览器语言兜底');
  assert.ok(html.includes('id="langToggle"'), '缺切换按钮');
  assert.ok(html.includes('location.reload()'), '缺重载式切换');
  assert.ok(html.includes('body.classList.add'), '缺 lang-en 挂类');
});

test('data-en 覆盖层覆盖 option / placeholder / title 三个属性位', () => {
  const n = (html.match(/data-en="/g) || []).length;
  assert.ok(n >= 20, 'data-en 数量不足: ' + n);
  assert.ok(html.includes('data-en-title='), '缺 data-en-title');
  // option 是成对 span 唯一不成立的地方（解析器剥标签）：深度思考三档必须走 data-en
  assert.ok(html.includes('data-en="Auto (follow the model'), 'thinkMode auto 未走 data-en');
  assert.ok(html.includes('data-en="Always on (force'), 'thinkMode on 未走 data-en');
});

test('实验后缀双语（服务端按模型渲染）', () => {
  assert.ok(html.includes('（实验）'), '缺中文实验后缀');
  assert.ok(html.includes('GLM (experimental)'), '缺英文实验后缀');
});

test('教学文本（协议真源，红线 3）原样进 <pre>，不被翻译', () => {
  for (const piece of ['DEFAULT-SHAPE', 'GLM-SHAPE', 'TRAIN-DEFAULT', 'TRAIN-GLM']) {
    assert.ok(html.includes('>' + piece + '</pre>'), '教学文本不是原样展示: ' + piece);
  }
});

test('模型目录照常渲染（value 是站点限定 id）', () => {
  assert.ok(html.includes('value="deepseek:deepseek"'));
  assert.ok(html.includes('value="glm:glm"'));
});

test('MSG 动态字典 zh/en 条目数相等（一侧多一侧少就是漂移）', () => {
  const m = html.match(/const MSG = \{[\s\S]*?\n  \};/);
  assert.ok(m, 'MSG 字典存在');
  // 计数必须带词边界：键名本身可能以 en 结尾（basisWhen: / promptNotWritten:），
  // 裸 /en:/g 会把键名误计成 en 条目。
  const zhKeys = (m[0].match(/(?<![A-Za-z])zh:/g) || []).length;
  const enKeys = (m[0].match(/(?<![A-Za-z])en:/g) || []).length;
  assert.equal(zhKeys, enKeys, 'zh 条目 ' + zhKeys + ' != en 条目 ' + enKeys);
  assert.ok(zhKeys >= 50, '字典规模可疑（应 ≥50 条）: ' + zhKeys);
});
