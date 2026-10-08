// team-compare.test.mjs — 「本插件并列多会话组成的 team」护栏。
//
// ## 这个文件要证明什么
//
// 用户原话（2026-09-22，逐字）：
//
//   「team不是指的官方team那样，我想更多指的是能够充分发挥本多站点（如果实现）的优势，
//    能够做到中心对话区域做到：并列不同模型对话进行回复」
//   「3.删除参考官方用的team面板，和我设想的team不同，参考错误了...重构team功能，
//    本插件的并列多会话组成的team」
//
// 即：Team = **若干条各自独立的会话并排**，不是官方 AgentTeams 的花名册。
//
// ## 0.19.55：从「自绘的假会话」改成「每列一条真官方会话」
//
// 用户原话（2026-10-02，逐字）：
//
//   「并发必须能够保留真实会话！能够查看！」
//   「然后是中间区域，将原本在会话中的『并发』删除，改为对齐新会话的『对话』
//    和『轨迹』--变为『并发对话』和『并发轨迹』」
//   「我要一摸一样，确保每一列都有完整的官方会话所有能力」
//
// 因此本轮换掉了实现路线：列里装的**不再是自绘的对话**，而是官方自己的会话体
// （`conversation.content` factory），每列绑定一条真会话（`ctx.sessions.create()`
// + `retain()`）。判据也跟着换：从前那些「按 id 回填消息 / 稳定 sessionKey / 复刻
// composer 刻度」的断言**验证的对象已经不存在了**（那是自绘层的内部细节），留着它们
// 只会证明一份已经不存在的代码。新判据钉的是**真会话那条链**：
//
//   ① 真会话：`sessions.create()` 造、`retain()` 拿引用、`release()` 成对释放；
//   ② 官方会话体：`SessionProvider` 显式绑定 + `renderFactorySlot('conversation.content')`；
//   ③ 两个页签「并发对话 / 并发轨迹」对齐普通会话的「对话 / 轨迹」；
//   ④ 位置：左栏「并发会话」行 + 同名中央 `main` 面板（会话语义上不可能，见下）。
//
// 任何一条被改回去都会在这里红。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 0.19.0：排期字段的「第三跳」要在**真台账**上验（不是文本断言）——
// 「存得住」这件事只有真调 applyCreate 才算证明。
import { applyCreate, emptyLedger, rowsOf } from '../lib/task-ledger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 包根（`lib/` 与 `test/` 的父目录），供跨文件读源码用。 */
const root = path.join(here, '..');

/** 读 client.cjs 的源码（本文件只看结构，不渲染）。 */
function clientSrc() {
  return fs.readFileSync(path.join(here, '..', 'lib', 'client.cjs'), 'utf8');
}

/** 取出并发面板正文（`ConcurrentColumns`）的函数体，到下一个顶层 function 为止。 */
function compareBody(src) {
  const a = src.indexOf('function ConcurrentColumns(props) {');
  assert.ok(a > 0, '找不到 ConcurrentColumns（改名则本护栏失效，需同步）');
  const b = src.indexOf('\n    function ', a + 10);
  return src.slice(a, b === -1 ? a + 20000 : b);
}

/**
 * 剥掉注释后的**代码**（CRLF 先归一成 LF）。
 *
 * 为什么每条「某机制必须删除」的判据都要先过这一层：本文件的注释里**逐字写着**被删机制的
 * 名字与形状（那是留给读者的「为什么删」说明），直接对全文做 `!/name/.test(src)` 会被自己的
 * 注释判红——本仓库踩过两次（见 ⑩ 段旧判据的 ⚠ 注记）。剥注释后匹配的才是代码。
 *
 * ⚠ CRLF 必须先归一：行注释正则用 `$` 收尾，在 `\r\n` 上 `$` 匹配不到 `\r` 之前的位置，
 * 整条注释就剥不掉（同一个坑的第二种形态）。
 */
function stripComments(src) {
  return src
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, ''))
    .join('\n');
}

// ── ① 真会话：造、拿引用、成对释放 ──────────────────────────────────────────────

test('★ 0.19.55 并发：每列必须是一条**真官方会话**（create + retain，不是自绘消息）', () => {
  const body = compareBody(clientSrc());

  // 正面判据：真的调了官方的会话控制面。
  assert.match(body, /sessions\.create\(/, '每列必须由 ctx.sessions.create() 造一条 Host 上的真会话');
  assert.match(body, /sessions\.retain\(id, \{ source: 'webcodeConcurrent' \}\)/,
    '真会话必须 retain 出引用对象（SessionProvider 只认真引用，不认 sessionId 字符串）');

  // 反面判据：自绘层不得复活。它的每一个形态都在这里被点名，防止「顺手加回来」。
  assert.ok(!/api\('chat'/.test(body), '不得再走 /__webcode/chat 把网页正文抄进自绘消息里');
  assert.ok(!/sessionKey/.test(body), '不得再有自铸的 sessionKey —— 真会话的身份是 Host 给的 sessionId');
  assert.ok(!/messages: \[/.test(body), '不得再把消息存在 React state 里（那正是「假会话」的定义）');
});

test('★ 0.19.63 并发：inject 必须声明**每一个**被读的服务（真机空白根因的判据）', () => {
  const src = clientSrc();
  // 0.19.68（10-08 轮）：`workspaces` 与 `conversation` 两个 inject **已移除**（自建 worktree
  // 工作区与跨列引用「⇥ 引用」都按用户口径删除），新增 `configForms`——列顶栏的「对话 / 轨迹」
  // 页签要与官方同条件显示「轨迹」（官方 `viewTabs()` 读
  // `ctx.configForms.developerTools.enabled.getSnapshot()`，ui-conversation:22803）。
  assert.match(src, /const inject = \['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'layout', 'uiWorkspace', 'jobs', 'configForms'\];/,
    'inject 必须含 sessions / layout / uiWorkspace / jobs / configForms：会话（每列 create/retain）、'
    + '布局（守卫）、uiWorkspace（更多操作菜单里的「在官方视图打开」）、jobs（列顶栏后台任务 chip 的数据面）、'
    + 'configForms（0.19.68（10-08 轮）：开发者工具开关决定「轨迹」页签是否出现，与官方逐字同条件）');

  // 这一类缺陷的**通用判据**（0.19.63 真机事故后补，取而代之的是原来只钉死那一串字面量的写法）。
  //
  // 事故形状：cordis 的 reflect 代理对**未声明 inject 的服务读取是直接抛错**
  // （`cannot get property "layout" without inject`），而不是给 undefined。0.19.62 把
  // `ctx.layout` 写在 `main` 条目的组件函数里 ⇒ 组件一渲染就抛 ⇒ 官方
  // SlotErrorBoundary 把它兜成 `<div data-slot-error>` 的**空 div** ⇒ 真机现象是
  // 「并发界面一片空白、连页签都没有」，而当时三处源码正则护栏**全绿**。
  // 只钉字面量的护栏锁住的是当时的形状（连缺陷一起锁死）；这里改成把两边对起来：
  // 源码里出现的每个 `ctx.<名>` 读取，要么在 inject 列表里，要么是 cordis 自带成员。
  const declared = new Set(
    (/const inject = \[([^\]]*)\];/.exec(src)[1].match(/'[^']+'/g) || []).map(s => s.slice(1, -1)),
  );
  /** cordis 自带的上下文成员（不是服务，不需要 inject 声明）。 */
  const BUILTIN = new Set([
    'effect', 'reflect', 'on', 'get', 'set', 'inject', 'plugin', 'logger', 'scope', 'provide', 'evaluate', 'root',
  ]);
  const read = new Set(Array.from(src.matchAll(/ctx\.([A-Za-z_$][A-Za-z0-9_$]*)/g)).map(m => m[1]));
  const missing = Array.from(read).filter(name => !declared.has(name) && !BUILTIN.has(name));
  assert.deepEqual(missing, [],
    '这些服务在源码里被读、却不在 inject 里：' + JSON.stringify(missing)
    + '（未声明即抛错；抛在渲染期 = 官方空盒 = 面板全白）');
});

test('★ 0.19.63 并发：warn 必须声明在工厂作用域（apply() 之外的面板代码要看得见）', () => {
  const src = clientSrc();
  const decl = src.indexOf('const warn =');
  const apply = src.indexOf('function apply(ctx) {');
  assert.ok(decl > 0 && apply > 0, '找不到 warn 声明或 apply()（改名/移动则本判据失效，需同步）');
  assert.ok(decl < apply,
    'const warn 必须声明在 `function apply(ctx)` **之前**：ConcurrentPanel / createPanelGuard 定义在 '
    + 'apply() 之外，warn 声明在 apply() 里面 ⇒ 真机 `ReferenceError: warn is not defined`，'
    + '而它抛在挂载 effect/渲染提交期会被官方边界吞成空盒（又一次「面板全白且看不到原因」）');
  assert.equal((src.match(/const warn =/g) || []).length, 1,
    'warn 全文件只能有一处声明（两份会分叉：修了一处另一处照旧）');
});

test('★ 0.19.55 并发：引用必须成对释放（retain 不 release 会让会话作用域永远驻留）', () => {
  const body = compareBody(clientSrc());
  // 两处 release：卸载时清空全部引用，移出某一列时只释放那一列。
  assert.ok((body.match(/\.release\(\)/g) || []).length >= 2,
    '必须有 ≥2 处 release（整组卸载 + 单列移出），实际='
    + (body.match(/\.release\(\)/g) || []).length);
  assert.match(body, /delete refs\[id\]|delete refsRef\.current\[col\.sessionId\]/,
    '释放之后必须把引用从表里删掉，否则会二次释放');
  // 卸载 effect 的清理函数必须真的释放，而不是「只把 alive 置 false」。
  const mountEffect = body.slice(body.indexOf('aliveRef.current = true;'), body.indexOf('}, []);'));
  assert.match(mountEffect, /\.release\(\)/, '卸载路径（effect 清理）必须释放引用');
});

test('★ 0.19.55 并发：移出某一列**不得删掉那条会话**（用户要「保留真实会话！」）', () => {
  const src = clientSrc();
  const body = compareBody(src);
  const release = body.slice(body.indexOf('const releaseColumn ='), body.indexOf('const titleOf ='));
  assert.ok(release.length > 0, '必须存在 releaseColumn（改名则本判据失效，需同步）');
  assert.ok(!/sessions\.delete|deleteSession|sessions\.remove/.test(src),
    '不得出现删除会话的调用 —— 用户要的是「保留真实会话」，移出面板只是移出面板');
  assert.match(src, /只移出面板，不删会话/, '这条语义必须写在注释里（后人改之前先读到它）');
});

// ── ② 官方会话体：SessionProvider + conversation.content factory ───────────────

test('★ 0.19.55 并发：每列必须渲染**官方**会话体（SessionProvider + conversation.content）', () => {
  const src = clientSrc();
  const body = compareBody(src);

  // `SessionProvider` 必须拿到**引用对象**（官方 ui-session 的 bindingSource 会校验世代）。
  assert.match(body, /h\(SessionProvider, \{ session: refsRef\.current\[col\.sessionId\] \}/,
    '每列必须用官方 SessionProvider 显式绑定该列的会话引用');

  // 官方会话体：conversation.content factory，embedded 变体。它在列正文组件里。
  assert.match(src, /renderFactorySlot\('conversation\.content'/,
    '必须渲染官方 conversation.content factory —— 那就是「完整官方会话能力」的来源');
  assert.match(src, /variant: 'embedded'/, '嵌入形态必须逐字是官方那个 variant 值');
});

test('★ 0.19.65 并发：不得再覆盖官方 `views` 局部槽（视图交给会话自己记住的那一个）', () => {
  const src = clientSrc();
  // 用户 2026-10-06 原话：「移除顶部的并发对话和并发轨迹——反正都是界面内自行切换；
  // 每列直接贯通一列」。⇒ 不再钉死视图：官方默认路径就是 `renderSlot("conversation.session", {})`
  //（dsh-client-ui-conversation:16202），由**会话自己记住的视图**决定，正是官方的位置关系。
  assert.ok(!/slots: \{ views \}/.test(src),
    '不得再向官方 factory 覆盖 views 局部槽（那正是「面板级页签」的实现基础）');
  assert.ok(!/const (ChatOnly|TrajectoryOnly)SessionView =/.test(src),
    '两个「钉死视图」的替身必须删除（注释里提它们的历史是允许的）');
  assert.ok(!/view: 'trajectory'/.test(src), '不得再把视图钉死为 trajectory');
});

test('★ 0.19.55 并发：会话体不是自绘 —— 不得再复刻 composer / 消息渲染', () => {
  const src = clientSrc();
  // 反面：自绘 composer 的那一整套刻度随对象一起删（样式规则也不许留）。
  // 注意这里查的是**规则本身**而不是「名字出现过」：源码注释里会提到这些名字
  //（说明「为什么删掉它们」），那正是我们要保留的解释，不该被判红。
  for (const dead of ['.hwb-col-composer{', '.hwb-compare-view{', '.hwb-compare-col{', '.hwb-quote-bar{']) {
    assert.ok(!src.includes(dead), '自绘层的样式规则必须随对象一起删除：' + dead);
  }
  assert.ok(!/className: 'hwb-(col-composer|compare-)/.test(src),
    '自绘层的类名不得再出现在渲染代码里');
  assert.ok(!/hwb-col-composer-select/.test(src), '自绘的站点/模型选择器不得复活（模型由官方 composer 选）');
});

// ── ③ 面板级页签：**已按用户要求移除**（0.19.65）────────────────────────────────

test('★ 0.19.65 并发：顶部「并发对话 / 并发轨迹」页签必须删掉（每列贯通一列）', () => {
  const src = clientSrc();
  assert.ok(!/name: '并发对话'/.test(src), '面板级页签「并发对话」必须删除');
  assert.ok(!/name: '并发轨迹'/.test(src), '面板级页签「并发轨迹」必须删除');
  // 注意：`role: 'tab'` 在**设置页**里是合法的另一处（与本面板无关），所以这里只判
  // 并发面板自己的那段渲染代码里不再有 tablist。
  const panelBody = src.slice(src.indexOf('function ConcurrentPanel(props)'), src.indexOf('function createPanelGuard'));
  assert.ok(!/role: 'tab'|tablist/.test(panelBody), '并发面板的渲染路径里不得再有自绘 tablist');
  assert.ok(!/hwb-concurrent-tabs\{/.test(src), '页签的样式规则必须随对象一起删除');
  assert.ok(!/const \[view, setView\]/.test(src), '页签的受控状态必须删除');
});

// ── ④ 位置：左栏行 + 中央 main 面板（会话语义上做不到，见下）───────────────────

test('★ 0.19.55 并发：必须由左栏 `sidebar.panellist` 行 + 同名 `main` 面板成对提供', () => {
  const src = clientSrc();
  assert.match(src, /const CONCURRENT_PANEL_ID = 'webcode-concurrent-panel';/, '侧栏行与 main 的 id/key 必须同名');
  assert.match(src, /inject\('sidebar\.panellist'/, '必须有左栏入口');
  assert.match(src, /label: \(\) => '并发会话'/, '左栏那一行必须逐字叫「并发会话」（用户点名的词）');
  assert.match(src, /inject\('main'/, '必须有中央面板（只注册侧栏一半，用户点一下就会被 layout 拒）');
});

test('★ 0.19.55 并发：会话内的「并发」页签必须**删除**（技术上也不可能，见下）', () => {
  const src = clientSrc();
  // 反面断言：这是本轮的核心动作之一，改回去即变红。
  assert.ok(!/'webcode-compare-view'/.test(src), '会话内那个「并发」视图注册必须已删除');
  assert.ok(!/inject\('conversation\.view'/.test(src),
    '不得再往 conversation.view 注册并发 —— 在那里渲染官方会话体会抛 recursive render of factory');

  // 正面：那条「为什么不可能」的理由必须留在源码里（它是这次搬迁的全部依据）。
  assert.match(src, /recursive render of factory/, '必须写明「会递归渲染」这条官方约束');
});

test('★ 0.19.55 并发：子槽必须自有 + session 作用域（官方 conversation.session 不可重复声明）', () => {
  const src = clientSrc();
  assert.match(src, /const CONCURRENT_COLUMN_SLOT = 'webcode-concurrent\.column';/, '子槽必须用自有名字');
  assert.match(src, /children: \{ \[CONCURRENT_COLUMN_SLOT\]: \{ kind: 'single', scope: 'session' \} \}/,
    '必须声明一个 session 作用域子槽 —— 这是拿到 SessionProvider / renderSlot 的唯一途径');
  assert.ok(!/children: \{ 'conversation\.session'/.test(src),
    '不得重复声明 conversation.session（官方 conversation.content factory 已声明它，重复声明会抛 already declared）');
});

test('★ 0.19.55 并发：列正文必须注册进自有的 session 子槽（不是自绘节点）', () => {
  const src = clientSrc();
  assert.match(src, /inject\(CONCURRENT_COLUMN_SLOT/, '列正文必须注册进自有子槽');
  assert.match(src, /function ConcurrentColumn\(props\)/, '必须存在列正文组件 ConcurrentColumn');
  // 0.19.65：列正文只调官方 factory，**不覆盖 views**（视图由会话自己记住的那个决定），
  // 三个相位参数仍是官方 ui-subagent 的同源算法。
  assert.match(src, /renderFactorySlot\('conversation\.content', \{[\s\S]{0,300}?variant: 'embedded'/,
    '列正文必须渲染官方 conversation.content factory（embedded 形态）');
  // 顺序必须是**结构性**的：子槽注册嵌在 `main` 的 inject 回调里（先声明、后注册）。
  // 靠两条并列 inject 的调度顺序会在宿主换实现时静默炸（SlotCore 拒绝向未声明的槽注册）。
  const mainInject = src.slice(src.indexOf("ctx.slots.inject('main'"));
  const childrenAt = mainInject.indexOf('children: {');
  const colRegisterAt = mainInject.indexOf('inject(CONCURRENT_COLUMN_SLOT');
  assert.ok(childrenAt > 0 && colRegisterAt > childrenAt,
    '子槽注册必须嵌在 main 注册之后（先声明后注册），不得靠两条并列 inject 的调度顺序');
});

// ── ⑤ 版式：列数、宽度、平移（用户 0.19.29 第 3 点，已验收，逐字保留）────────

test('★ 0.19.55 并发：列数由数组驱动，上限 4（不得再硬编码三列）', () => {
  const src = clientSrc();
  const body = compareBody(src);
  assert.ok(!/col1Site|col2Site|col3Site/.test(body),
    '不得再有 col1Site/col2Site/col3Site 三个独立 state —— 那正是「加不了第四列」的根源');
  assert.ok(!/columns\[0\]|columns\[1\]|columns\[2\]/.test(body), '不得再按下标取列');
  assert.match(body, /const \[cols, setCols\] = React\.useState/, '列状态必须是数组');
  assert.match(src, /const CONCURRENT_MAX_COLS = 4;/, '必须有上限常量 —— 用户要的是 2~4 列');
  assert.match(body, /cols\.reduce\(/, '渲染必须由 cols 数组驱动（reduce 是为了在列之间插入拖拽把手）');
  assert.match(body, /const createColumns = \(n\) =>/, '必须有加列操作');
  assert.match(body, /const releaseColumn = \(key\) =>/, '必须有移出列操作');
});

test('★ 0.19.55 并发：新建一组默认 3 列（用户点名的「3 个重叠标签页」）', () => {
  const src = clientSrc();
  const body = compareBody(src);
  assert.match(src, /const CONCURRENT_DEFAULT_COLS = 3;/, '默认列数必须常量化为 3');
  assert.match(body, /createColumns\(cols\.length === 0 \? CONCURRENT_DEFAULT_COLS : 1\)/,
    '首次建组用默认 3 列，之后每次加 1 列');
});

test('★ 0.19.55 并发：列宽上下限取自官方常量，放不下时左右切换（三列同步）', () => {
  const src = clientSrc();
  const body = compareBody(src);
  for (const [name, value] of [['SIDEBAR_MAX', 420], ['SIDEBAR_MIN', 264], ['RIGHTBAR_MIN', 300],
    ['OFFICIAL_CONTENT_MAX', 920], ['OFFICIAL_CARD_PAD', 32], ['COL_GAP', 16]]) {
    assert.ok(new RegExp('const ' + name + ' = ' + String(value).replace('.', '\\.') + ';').test(body),
      '列宽常量必须逐字保留（用户 0.19.29 已验收）：' + name + '=' + value);
  }
  assert.ok(/const RIGHTBAR_MAX_RATIO = 0\.7;/.test(body), '右栏上限比例必须逐字保留');
  assert.match(body, /viewportW - SIDEBAR_MAX - Math\.round\(viewportW \* RIGHTBAR_MAX_RATIO\)/,
    '下限 = 中间区最窄（左右栏都拉到最宽）');
  assert.match(body, /viewportW - SIDEBAR_MIN - RIGHTBAR_MIN/, '上限不得超过中间区最宽');
  // 0.19.68（10-08 轮）：夹取顺序不变，但**被夹的值**多了一层「用户拖出来的偏好优先」
  // （用户第 5 条「像官方那样调整会话宽度」）。官方 `resolveContentWidth` 同口径：
  // 有偏好就夹偏好，没偏好就用默认公式（ui-conversation:20682-20686）。
  // 0.19.68（10-08 轮）真机修正：上限分**两层**——默认值受可视宽度约束（不拖时不该宽到看不见），
  // 用户拖出来的偏好只受**绝对上限**（官方内容最宽 920 + 卡片余量 32）约束。旧写法把偏好也夹进
  // 可视宽度 ⇒ 1320px 视口默认已顶到 756px，向右拖 +90px 列宽与偏好都不动（真机读数），
  // 用户第 5 条要的「像官方那样调整宽度」直接失效。可平移设计下，列比可视区宽是合法形态。
  assert.match(body, /const colWidthAbsoluteMax = OFFICIAL_CONTENT_MAX \+ OFFICIAL_CARD_PAD;/,
    '必须有绝对上限（官方会话自身的完整最宽，与视口无关）');
  assert.match(body, /const colWidth = Math\.round\(colWidthPref === null\s*\n?\s*\? Math\.min\(colWidthMax, Math\.max\(colWidthMin, officialDefault\)\)\s*\n?\s*: Math\.min\(colWidthAbsoluteMax, Math\.max\(colWidthMin, colWidthPref\)\)\)/,
    '偏好必须走绝对上限、默认值走可视上限（两层，缺一不可）');
  assert.match(body, /Math\.min\(OFFICIAL_CONTENT_MAX, Math\.max\(680, Math\.round\(viewportW \* 0\.64\)\)\)/,
    '默认列宽必须用官方那条 clamp(680, column*0.64, 920)');
  assert.match(src, /\.hwb-concurrent-col\{[^}]*flex:0 0 var\(--hwb-col-width/,
    '列宽必须由 --hwb-col-width 统一给（三列同一个值 ⇒ 宽度同步）');
  assert.match(body, /'--hwb-col-width': colWidth \+ 'px'/, '列宽是算出来的像素值，挂在 style 上');
  assert.match(body, /cols\.length > visible && h\('button'/, '放不下才出现切换按钮');
  assert.match(body, /const visible = Math\.max\(1, Math\.floor\(\(viewportW \+ COL_GAP\) \/ \(colWidth \+ COL_GAP\)\)\)/,
    '可见列数按整数列算，不出现半列');
  assert.ok(body.includes("transform: 'translateX(' + (-first * (colWidth + COL_GAP)) + 'px)'"),
    '平移量必须是整列宽 + 列间距（永远整列对齐）');
  assert.match(body, /const maxFirst = Math\.max\(0, cols\.length - visible\)/, '必须有平移上界');
  assert.match(body, /disabled: !canPanLeft/, '到最左时左按钮必须置灰');
  assert.match(body, /disabled: !canPanRight/, '到最右时右按钮必须置灰');
  assert.match(src, /\.hwb-concurrent-pan\{position:absolute;top:50%;transform:translateY\(-50%\)/,
    '左右按钮必须绝对定位在中间区左右边缘、垂直居中');
  assert.match(src, /\.hwb-concurrent-pan\{[^}]*background:var\(--dsw-specific-menu\)/,
    '按钮底色必须是官方胶囊那一支 specific-menu');
  assert.match(src, /\.hwb-concurrent-pan\{[^}]*backdrop-filter:var\(--dsw-menu-backdrop-filter\)/,
    '毛玻璃必须与官方胶囊同源');
});

test('★ 0.19.55 并发：列的可见边界 = 官方那套「隐形 + hover 光」（用户 0.19.29 第 1 点）', () => {
  const src = clientSrc();
  assert.ok(!/\.hwb-concurrent-col\{[^}]*background:var\(--dsw-alias-bg-layer-1/.test(src),
    '列不得有常驻卡片底 —— 那就是用户说的「分界」');
  assert.ok(!/\.hwb-concurrent-col\{[^}]*border:\.5px solid/.test(src), '列不得有常驻边框');
  assert.match(src, /\.hwb-concurrent-col\{[^}]*background:transparent[^}]*border:0/, '平时必须透明、无边框');
  assert.match(src, /\.hwb-concurrent-col:hover[^{]*\{[^}]*var\(--dsw-alias-interactive-bg-hover/, 'hover 才浮起交互底色');
  assert.match(src, /\.hwb-concurrent-col:focus-within/, 'focus-within 也要给（键盘用户必须看得见落点）');
});

test('★ 0.19.55 并发：面板高度必须确定（min-height:0 + overflow，否则长会话把列撑破）', () => {
  const src = clientSrc();
  assert.match(src, /\.hwb-concurrent\{[^}]*flex:1 1 auto[^}]*min-height:0[^}]*overflow:hidden/,
    '.hwb-concurrent 必须 flex:1 1 auto + min-height:0 + overflow:hidden');
  assert.match(src, /\.hwb-concurrent-col-body\{[^}]*min-height:0/, '.hwb-concurrent-col-body 必须有 min-height:0');
  assert.match(src, /\.hwb-concurrent-body\{[^}]*min-height:0/, '.hwb-concurrent-body 必须有 min-height:0');
});

// ── ⑥ 入口图标：三个重叠的标签页 ───────────────────────────────────────────────

test('★ 0.19.55 并发：左栏那一行必须画「3 个重叠标签页」（用户点名的识别特征）', () => {
  const src = clientSrc();
  const icon = src.slice(src.indexOf('function ConcurrentPanelIcon'), src.indexOf('function ConcurrentPanelIcon') + 900);
  assert.ok(icon.length > 0, '找不到 ConcurrentPanelIcon（改名则本判据失效，需同步）');
  assert.equal((icon.match(/h\('rect'/g) || []).length, 3, '必须是三个矩形（三个重叠的标签页）');
  assert.match(icon, /currentColor/, '必须用 currentColor —— 明暗主题与选中态由宿主继承');
  assert.ok(!/fill: '#|fill: "rgb/.test(icon), '不得写死颜色');
});

// ── ⑦ 组的持久化（「能够查看」：重开面板要能看到同一组会话）───────────────────

test('★ 0.19.68（10-08 轮） 并发：点「并发会话」= 点「新会话」——每次打开都新建一组，且不再留组痕', () => {
  const src = clientSrc();
  // 用户 2026-10-06 原话：「8.没有做到点击并发会话和点击新会话一样的新建会话」。
  // 用户 2026-10-08 原话：「『并发会话』在插件栏目怎么会出现什么『并发会话.3列』？？？？？？？？
  // 不要这个」⇒ 左栏只剩**一条**入口，组留痕存储族整套删除。
  const body = compareBody(src);
  assert.match(body, /createdRef\.current = true;[\s\S]{0,80}?createColumns\(CONCURRENT_DEFAULT_COLS\)/,
    '挂载后必须自动新建一组（点入口 = 点新会话）');
  // 组留痕存储族必须**整套不在**（不是留着不用）：留着就等于「左栏会长出 N 行」这件事
  // 只差一次调用就复活。判据钉在源码全文上，注释里提名字是允许的。
  const code = stripComments(src);
  for (const dead of ['CONCURRENT_STORE_PREFIX', 'CONCURRENT_GROUPS_KEY', 'CONCURRENT_MAX_GROUPS',
    'CONCURRENT_GROUP_PREFIX', 'readConcurrentGroups', 'createConcurrentGroup',
    'appendToConcurrentGroup', 'writeConcurrentGroup', 'newConcurrentGroupId', 'latestGroup']) {
    assert.ok(!new RegExp('\\b' + dead + '\\b').test(code),
      '组留痕机制必须整体删除（' + dead + ' 仍在代码里 ⇒ 「并发会话 · N 列」那些左栏行会复活）');
  }
  assert.ok(!/syncGroupRows|groupRows/.test(code),
    '左栏「历史组目录」的注册机制必须删除（用户点名不要「并发会话.3列」那些行）');
  assert.ok(!/'并发会话 · '/.test(code) && !/并发会话 · " /.test(code),
    '左栏不得再出现「并发会话 · N 列」行标签');
  // 左栏入口必须**只有一条**（order 30 那条主入口）。
  const rows = (src.match(/name: 'sidebar\.panellist'/g) || []).length;
  assert.equal(rows, 2, 'sidebar.panellist 只剩「并发会话」与「任务板」两条（实际 ' + rows + ' 处）');
});

test('★ 0.19.65 并发：删掉顶部工具条 + 悬浮加列钮 + 列间 16px「hover 才画线」', () => {
  const src = clientSrc();
  // 用户 2026-10-06 第 3/4 条：① 顶部「N 列 / + 加一列」那行不占高度；② 加列钮悬浮右上角；
  // ③ 列与列只留左右间隔、上下不画框；④ 间隔线平时隐藏、鼠标移上去才画出来。
  assert.ok(!/hwb-concurrent-bar/.test(src), '顶部工具条（.hwb-concurrent-bar）必须删掉，不再占高度');
  assert.ok(!/hwb-concurrent-action/.test(src), '旧的内联加列按钮必须删掉（改成悬浮钮）');
  assert.match(src, /className: 'hwb-concurrent-fab'/, '「+ 加一列」必须是悬浮置顶按钮');
  assert.match(src, /\.hwb-concurrent-fab\{position:absolute;top:\d+px;right:\d+px/,
    '悬浮钮必须绝对定位在右上角');
  assert.match(src, /className: 'hwb-concurrent-gap'/, '列间必须有独立的间隔元素（可 hover）');
  assert.match(src, /\.hwb-concurrent-gap\{flex:0 0 16px/, '间隔必须是 16px（与平移步长 COL_GAP 一致）');
  assert.match(src, /\.hwb-concurrent-gap-line\{[^}]*opacity:0/, '间隔线平时必须完全隐藏');
  // 0.19.68（10-08 轮）：间隔升级成拖拽把手后，竖线在 **hover 与拖动中**都要现形
  // （官方 widthHandle 的 `:hover:after` 与 `[data-dragging]:after` 同款反馈）。
  assert.match(src, /\.hwb-concurrent-gap:hover \.hwb-concurrent-gap-line,\.hwb-concurrent-gap\[data-dragging\] \.hwb-concurrent-gap-line\{opacity:1\}/,
    '鼠标移到间隔上**或拖动中**才画出那条 1px 竖线（平时完全隐藏）');
  assert.ok(!/\.hwb-concurrent-col\{[^}]*border:[^0]/.test(src), '列本身不得画框（用户：上下不用框）');
});

// ── ⑧ 官方花名册 Team 面板不得复活（0.19.0 的用户裁定）───────────────────────

test('★ 0.19.0 Team：官方 agentTeams 花名册面板不得复活（用户明确说参考错了）', () => {
  const src = clientSrc();
  assert.ok(!/function TeamPanel\(/.test(src), '官方花名册 TeamPanel 不得复活');
  assert.ok(!/'dsh-webcode-bridge\/team'/.test(src), '右栏 Team 面板正文座位不得复活');
  assert.ok(!/'webcode-team'/.test(src), '右栏 webcode-team 标签页类型不得复活');
  assert.ok(!/label: \(\) => '三列模型对比'/.test(src), '旧名字不得复活');
});

// ── ⑨ 0.19.62 防跳走：建列绑工作区 + 面板意图守卫（官方 replaceMain→selectPanel(null) 链）──

// 用户 2026-10-04 报「一点击选择范围就会跳成单独那里对话」。官方机理（实读
// 0.2.0-rc.2 bundle）：uiWorkspace.openSession/openWorkspace → replaceMain(…, "reveal")
// → ctx.layout.selectPanel(null) —— main 面板与单个会话互斥，于是整个并发面板被换掉。
// 列内触发点：未绑工作区的会话渲染「虚线选择工作区」composer 卡，点击即走
// selectWorkspace → openWorkspace 那条链。修法两半：①建列带 workspaceId（治本）；
// ②panelInfo 订阅 + 面板内 pointerdown 意图判别（兜住其余官方导航入口）。

test('★ 0.19.68（10-08 轮） 并发：新建列必须绑**当前工作区**（不再自建 worktree 工作区）', () => {
  const src = clientSrc();
  const body = compareBody(src);
  // 用户 2026-10-08 原话：「请你看好官方怎么管理工作区的！！文件夹内一个会话一行！！
  // 不是每个会话一个文件夹！」⇒ 建列不再有「本组专属工作区」那一层（provisionGroupWorkspace
  // 已删），直接绑**当前工作区**：新会话于是作为当前文件夹下的一行出现在官方左栏，
  // 与官方「新会话」完全同路径。
  assert.match(body, /const workspaceId = currentWorkspaceId\(\);/,
    '绑定来源必须只有「当前工作区」一级（本组专属 worktree 那级已按用户口径删除）');
  assert.ok(!/provisionGroupWorkspace/.test(stripComments(body)),
    'provisionGroupWorkspace 必须整体删除（留着就等于「每组一个文件夹」只差一次调用就复活）');
  assert.match(body, /workspaceId\s*\?\s*sessions\.create\(\{ workspaceId \}\)\.catch\(\(\) => sessions\.create\(\{\}\)\)\s*:\s*sessions\.create\(\{\}\)/,
    '有 workspaceId 必须传给 sessions.create（官方 reuseOrCreateBlank 同款参数）；'
    + '被宿主拒时必须回落不绑重试（最坏退回 0.19.61 行为），而不是整组建不出来');
  // 取值回落链：当前会话所在工作区 → 最近更新 → null（不绑，交守卫兜底）。
  assert.match(body, /currentWorkspaceId = \(\) =>/, '必须有 currentWorkspaceId 助手');
  assert.match(body, /w\.sessionIds\.includes\(currentSessionId\)/,
    '第一回落：当前会话所在的工作区');
  assert.match(body, /Number\(w\.updatedAt\)/, '第二回落：最近更新的工作区（官方 recentWorkspace 语义）');
  assert.match(body, /return null;/, '取不到时明确返回 null（不绑），不得编造 id');
  // useWorkspaces 必须进面板（root 作用域标准 hook，官方 materializeStandardBinding 提供）。
  assert.match(body, /const useWorkspaces = typeof props\.useWorkspaces === 'function' \? props\.useWorkspaces : noSessions;/,
    'useWorkspaces 必须经标准 prop 取、缺席降级为 noSessions（绝不条件调用 hook）');
  // workspaces 服务面不再经 inject 声明（数据面 create/rename 已不需要）。
  assert.ok(!/'workspaces'/.test(src.slice(src.indexOf('const inject = ['), src.indexOf('];', src.indexOf('const inject = [')))),
    'inject 列表不得再含 \'workspaces\'（并发不再注册工作区；useWorkspaces 走 root 标准 prop）');
  assert.ok(!/hwbWorkspaces/.test(stripComments(src)),
    '三处挂载点的 hwbWorkspaces prop 必须删除（provisionGroupWorkspace 已删，传下去没人用）');
});

// ── ⑩ 0.19.68（10-08 轮）：不得再为并发组自建 git worktree 工作区 ──────────────────
//
// 用户 2026-10-08 原话：「请你看好官方怎么管理工作区的！！文件夹内一个会话一行！！不是每个
// 会话一个文件夹！删除多出来web的dwb+并行会话文件夹」。
//
// 旧实现（0.19.68 的 10-06/10-07 两轮）为**每一组并发**在仓库旁 `git worktree add` 一个
// `<repo>-hwb-<组id>` 完整检出、注册成「并发会话组 N」工作区。真机后果（本轮实测）：
//   · 磁盘上 41 个重复 worktree 目录（dsh-webcode-bridge 37 个 + A0-Robocup 4 个）；
//   · 官方左栏把它们当**独立工作区**各占一行（用户要的恰恰相反：一个文件夹内一条会话一行）；
//   · 会话标题被 worktree 目录名污染（真机读数 `A0-Robocup-hwb-muym5osw00v6`）。
// ⇒ 机制整体删除：客户端 `provisionGroupWorkspace`、服务端两条路由、`lib/concurrent-workspace.js`
//   模块本身，以及 `inject` 里的 `'workspaces'`。判据全部取**反向**（存在即红）。
test('★ 0.19.68（10-08 轮） 并发：不得再自建 git worktree 工作区（模块 / 路由 / 客户端助手全删）', () => {
  const src = clientSrc();
  const code = stripComments(src);

  // ① 模块文件必须不存在（不是「存在但没人用」——留着就会被下一次改动顺手接回去）。
  assert.ok(!fs.existsSync(path.join(root, 'lib', 'concurrent-workspace.js')),
    'lib/concurrent-workspace.js 必须删除（并发不再自建工作区目录）');

  // ② 服务端两条路由必须不在（客户端没有 fs/子进程，建目录那一半在服务端）。
  const wc = fs.readFileSync(path.join(root, 'lib', 'web-control.js'), 'utf8');
  const wcCode = stripComments(wc);
  assert.ok(!/concurrent-workspace/.test(wcCode),
    "'POST concurrent-workspace' 路由必须删除");
  assert.ok(!/concurrent-worktrees/.test(wcCode),
    "'GET concurrent-worktrees' 只读诊断路由必须删除（诊断对象已不存在）");
  assert.ok(!/prepareConcurrentWorkspace|listConcurrentWorkspaces/.test(wcCode),
    '服务端不得再 import worktree 助手（导入未用 = 死代码）');
  assert.ok(!/worktree/.test(wcCode), '服务端不得再出现任何 worktree 动作');

  // ③ 客户端：不得再建目录、不得再注册/改名工作区。
  // ⚠ 判据钉的是**并发那套** worktree 形状，不是「worktree」这个词——任务板里有一句
  // 如实说明「官方 Agent Team 没有 worktree、成员共享同一个 checkout」（那是**事实陈述**，
  // 与并发供地无关，删掉它反而丢了口径）。所以这里钉分支前缀 / git 命令 / 目录名后缀。
  assert.ok(!/hwb\/concurrent/.test(code), '客户端不得再出现并发 worktree 的分支前缀 hwb/concurrent/*');
  assert.ok(!/git worktree/.test(code), '客户端不得再产 git worktree 指令');
  assert.ok(!/'-hwb-'|"-hwb-"/.test(code), '客户端不得再拼 worktree 目录名后缀 -hwb-');
  assert.ok(!/wsFace\.(create|rename|list)\(/.test(code),
    '客户端不得再调 workspaces 数据面（create/rename/list）——那正是「并发会话组 N」的来源');
  assert.ok(!/并发会话组/.test(code), '不得再生成「并发会话组 N」标题（用户点名不要的那种行）');

  // ④ 「开工指令」那一行（用户第 2 条：「并发会话的『开工』那一行去除！！！」）。
  assert.ok(!/columnBrief|copyColumnBrief/.test(code),
    'columnBrief / copyColumnBrief 必须删除（它们产的就是 worktree 开工指令）');
  assert.ok(!/'⧉ 开工'/.test(src), '列头不得再有「⧉ 开工」按钮');
  // ⚠ 这三条查**代码**（stripComments）而不是全文：client.cjs 的注释里逐字写着这些类名
  // 作为「为什么删」的说明（`briefCopied` 状态与 `.hwb-concurrent-brief*` 样式全部删除），
  // 查全文会被自己的注释判红——与本文件其余「必须删除」判据同一个坑。
  assert.ok(!/hwb-concurrent-brief/.test(code), '「开工指令」摊开面板的类名与样式必须删除');
  assert.ok(!/setBrief\(|briefCopied/.test(code), '开工指令的 React 状态必须删除（不留死状态）');

  // ⑤ 跨列引用「⇥ 引用」（用户第 3 条点名的非官方 UI）整套删除，但**能力说明**保留在注释里。
  assert.ok(!/'⇥ 引用'/.test(src), '列头不得再有「⇥ 引用」按钮');
  for (const dead of ['sessionMentionOf', 'sessionMentionLabelEscape', 'appendToSessionDraft',
    'copySessionMention', 'conversationFaceOf', 'SESSION_MENTION']) {
    assert.ok(!new RegExp('\\b' + dead + '\\b').test(code),
      '跨列引用工具 ' + dead + ' 必须删除（按钮已删，工具留着就是死代码）');
  }
  assert.ok(!/'conversation'/.test(src.slice(src.indexOf('const inject = ['), src.indexOf('];', src.indexOf('const inject = [')))),
    "inject 列表不得再含 'conversation'（跨列引用已删，不再需要那个服务面）");
  assert.ok(!/hwbConversation/.test(code), '三处挂载点的 hwbConversation prop 必须删除');

  // ⑥ 用户点名的其余非官方 UI 一律不在（「↗ 官方视图」改由「更多操作」菜单承担）。
  assert.ok(!/'↗ 官方视图'/.test(src), '列头不得再有「↗ 官方视图」按钮（改由更多操作菜单承担）');
  assert.ok(!/hwb-concurrent-mini/.test(src), '自绘小按钮的类名与样式必须删除（已无使用者）');
  assert.ok(!/hwb-concurrent-col-head|hwb-concurrent-col-title/.test(src),
    '自绘列头（标题 + 一排小按钮）必须删除，改成官方 header 复刻');
  assert.ok(!/hwb-concurrent-chip/.test(src),
    '自绘 chips 胶囊必须删除（改成官方 CSS module 类名的复刻 chips）');
});

test('★ 0.19.68（10-08 轮） 并发：列顶栏必须是官方 header 的复刻（结构/类名/数据/文案四条口径）', () => {
  const src = clientSrc();
  const a = src.indexOf('function ColumnHeader(p)');
  const b = src.indexOf('function ConcurrentColumn(props)');
  assert.ok(a > 0 && b > a, '找不到 ColumnHeader / ConcurrentColumn 边界（改名则本判据失效，需同步）');
  const head = src.slice(a, b);

  // ① 结构：官方 ConversationHeader / ConversationSessionHeader 的同一棵 DOM 树。
  for (const cls of ['header', 'headerLeading', 'titleRow', 'titleCluster', 'crumbs', 'crumbSeg',
    'crumb', 'crumbCurrent', 'headerActions', 'headerUtilities', 'headerCorner', 'tabs', 'tab', 'tabActive']) {
    assert.ok(head.includes("oc('conversation', '" + cls + "')"),
      '列顶栏必须挂官方类名 ' + cls + '（wSkVaW_' + cls + '，结构逐字照官方）');
  }
  assert.match(head, /'data-conversation-header-leading': ''/, '必须保留官方的 data 属性（官方 CSS/脚本按它定位）');
  assert.match(head, /'data-conversation-header-corner': ''/, '同上：headerCorner 的 data 属性');
  assert.match(head, /role: 'tablist'/, '页签行必须是 role=tablist（官方同款）');
  assert.match(head, /role: 'tab'/, '每个页签必须是 role=tab（官方同款）');
  assert.match(head, /'aria-selected': tab\.id === viewId/, '页签必须报 aria-selected（官方同款）');

  // ② 样式不自己写：类名哈希前缀**运行时发现**，官方改哈希自动跟上；解不出才用 fallback。
  assert.match(src, /function officialCssPrefix\(key\)/, '必须有 officialCssPrefix（运行时发现官方 CSS module 前缀）');
  assert.match(src, /style\[data-plugin-css=/, '发现方式必须是查官方注入的 <style data-plugin-css=…>');
  assert.match(src, /const CSS_PREFIX_CACHE = new Map\(\);/, '发现结果要缓存（每列每帧都做正则太贵）');
  assert.match(src, /if \(prefix\) CSS_PREFIX_CACHE\.set\(key, resolved\);/,
    '只在**发现成功**时缓存：style 可能晚于插件注入，缓存 fallback 会把「暂时没找到」钉成永久错误');
  for (const key of ['conversation', 'team', 'subagent', 'jobs', 'presetLabel', 'openTarget', 'headerAction']) {
    assert.ok(src.includes("OFFICIAL_CSS") && new RegExp(key + ": \\{ tag: '@deepseek-ai/").test(src),
      'OFFICIAL_CSS 必须登记 ' + key + ' 的官方 tagId（fallback 哈希由漂移闸门盯着）');
  }
  assert.ok(!/\.hwb-col-header|\.hwb-header-/.test(src),
    '列顶栏不得自带一套视觉类（视觉必须来自官方 CSS module；本地只允许两条布局适配）');

  // ③ 数据面照官方投影键（拿不到就不渲染那一块，绝不摆假壳）。
  assert.match(head, /projectionValues\.agentPreset/, '模式必须读官方投影键 agentPreset（ui-agent-preset 同键）');
  assert.match(head, /projectionsBySession\[leadId\]/, '团队必须读官方 projectionsBySession[lead].values.agentTeam');
  assert.match(head, /values\.agentTeam/, '同上：agentTeam 投影键');
  assert.match(head, /projectionValues\.subagentCatalog/, '子智能体必须读官方 subagentCatalog 投影');
  assert.match(head, /s\.rows\[sessionId\]/, '后台任务必须读官方 jobs store 的 rows[sessionId]（ui-jobs:312 同键）');
  assert.match(head, /r\.status === 'running' \|\| r\.status === 'stopping'/,
    '「运行中」判据必须与官方 isLive 同义（running/stopping）');
  assert.match(head, /if \(subCount > 0 && !isSubagentChild\)/,
    '子智能体块的可见性必须与官方一致（无子会话不渲染；子会话自己那块由 lineage 槽负责）');
  assert.match(head, /if \(jobsAll\.length > 0\)/, '后台任务块必须在无任务时不渲染（官方 visibleCount===0 同款）');
  assert.match(head, /if \(presetLabel\)/, '模式块必须在投影缺席时不渲染（官方 preset===undefined → null 同款）');

  // ④ 文案逐字抄官方 zh 词典（漂移闸门盯官方原文，官方改字这里先红）。
  assert.match(src, /teamTrigger: '智能体团队'/, '团队文案必须逐字抄官方 agent-team zh `trigger`');
  assert.match(src, /jobsLive: '\{count\} 个后台任务运行中'/, '后台任务文案必须逐字抄官方 job zh `count.live.one`');
  assert.match(src, /jobsIdle: '\{count\} 个后台任务'/, '同上：`count.idle.one`');
  assert.match(src, /subagents: '\{count\} 个子智能体'/, '子智能体文案必须逐字抄官方 subagent zh `count.total.one`');
  assert.match(src, /presetStandard: '标准模式'/, '模式文案必须逐字抄官方 settings.agentPreset zh `presetStandardName`');
  assert.match(src, /moreActions: '更多操作'/, '「更多操作」必须逐字抄官方 session-log-export zh `header.more`');
  assert.match(src, /downloadLog: '下载 Session 日志'/, '菜单项必须逐字抄官方 zh `menu.download`');
  assert.match(src, /moreWaysToOpen: '更多打开方式'/, '必须逐字抄官方 open-in-app zh `path.more`');
  assert.match(src, /appExplorer: '文件资源管理器'/, '必须逐字抄官方 open-in-app zh `app.explorer`');

  // ⑤ 能点的地方都是真功能：官方公开路由，不是摆设。
  assert.match(src, /apps: 'open-in-app\/apps'/, '「用 X 打开」必须走官方 open-in-app 的 apps 路由');
  assert.match(src, /open: 'open-in-app\/open'/, '启动必须走官方 open-in-app 的 open 路由（POST {app,path}）');
  assert.match(src, /method: 'POST'/, '同上：open 是 POST');
  assert.match(src, /body: JSON\.stringify\(\{ app: appId, path \}\)/, '请求体形状必须与官方 launch 逐字一致');
  assert.match(src, /SESSION_EXPORT_ROUTE = 'api\/session\.export'/,
    '「下载 Session 日志」必须走官方 session-log-export 的路由');
  assert.match(src, /method: 'HEAD'/, '下载前必须先 HEAD 探路（官方 controller.run 同款，失败如实报错不假装下载）');
  assert.match(src, /includeDescendants: 'true'/, '导出参数必须与官方一致（含子会话）');
  assert.match(src, /'dsh-session-' \+ String\(sessionId\)\.replace\(\/\[\^A-Za-z0-9_-\]\/g, '_'\)/,
    'zip 文件名必须逐字照官方 sessionLogZipFilename');
  assert.match(head, /if \(preferredApp && cwd\)/,
    '「用 X 打开」必须只在**桌面宿主给了应用清单且会话有 cwd** 时渲染（web profile 上路由 404 ⇒ 不渲染，官方同款 null）');

  // ⑥ 页签必须真的切官方视图（经 conversation.session 的 view owner prop），不是画着好看。
  assert.match(src, /props\.hwbSlots\.entries\('conversation\.view'\)/,
    '页签清单必须读官方 conversation.view 注册表（不许写死「对话/轨迹」两项）');
  assert.match(src, /if \(!devTools && id === 'trajectory'\) continue;/,
    '「轨迹」页签必须与官方同条件隐藏（开发者工具关闭时不出现，ui-conversation:22803）');
  assert.match(src, /function devToolsFaceOf\(ctx\)/, '必须有 devToolsFaceOf（读官方 configForms.developerTools.enabled）');
  assert.match(src, /return ctx\.configForms\.developerTools\.enabled;/, '同上：取值路径逐字照官方');
  assert.match(src, /props\.renderSlot\('conversation\.session', \{ view: key \}\)/,
    '切视图必须经官方 conversation.session 的 view owner prop（官方 DefaultConversationViews 认它）');
  assert.match(src, /const SESSION_VIEWS_BY_ID = new Map\(\);/,
    'views 局部槽组件必须按 viewId 缓存（每次新建函数会让整棵会话子树重挂载：滚动位置与焦点全丢）');
  assert.match(src, /renderSlot\(slotName, \{ hwbView: viewsByCol\[col\.key\] \|\| '' \}\)/,
    '选中的视图必须由外层经 owner prop 传进会话作用域的列正文');

  // ⑦ 两道闸的反向判据仍然有效（0.19.68（10-07 轮）真机取证，0.2.1-alpha.1 复核仍成立）。
  assert.ok(!/children: \{ 'conversation\.session\.header'/.test(src),
    '不得把 conversation.session.header 声明为任何条目的 child（官方已声明 ⇒ 重复声明 = 列条目注册整体失败 = 列体全空）');
  assert.ok(!/renderSlot\('conversation\.session\.header'/.test(src),
    '不得 renderSlot 官方 session header（没有授权会抛 SlotOwnershipError）');

  // ⑧ 列宽可拖拽（用户第 5 条）：把手 + 持久化 + 双击复位 + 官方同口径的上下限。
  const colsBody = compareBody(src);
  assert.match(colsBody, /const onGapPointerDown = \(e\) =>/, '列间把手必须有 pointerdown 处理');
  assert.match(colsBody, /setPointerCapture\(e\.pointerId\)/, '必须用 pointer capture（官方 WidthHandle 同款，拖出元素也不丢事件）');
  assert.match(colsBody, /requestAnimationFrame\(apply\)/, '拖动必须 rAF 节流（官方同款）');
  assert.match(colsBody, /root\.style\.setProperty\('--hwb-col-width', clamp\(startW \+ dx\) \+ 'px'\)/,
    '拖动期直接写 CSS 变量、不触发 React 重排，且夹到绝对上限（clamp 见 ⑤ 段的两层上限）');
  assert.match(colsBody, /window\.localStorage\.setItem\(HWB_COL_WIDTH_KEY, String\(next\)\)/,
    '抬手才 commit 并持久化（官方 onCommit 同款）');
  // ⚠ 三个 pointer 监听器必须**具名注册 + 具名注销**：`removeEventListener` 只认同一个函数引用。
  // 旧写法把 pointerup 注册成匿名箭头、却去注销 `finish` ⇒ 引用不匹配，每拖一次泄漏一个
  // pointerup 监听器（旧闭包下次仍会跑，读到过期的 latest/startW）。
  assert.match(colsBody, /el\.addEventListener\('pointerup', onUp\);/, 'pointerup 必须具名注册');
  assert.match(colsBody, /el\.removeEventListener\('pointerup', onUp\);/, 'pointerup 必须注销同一个引用');
  assert.match(colsBody, /el\.addEventListener\('pointercancel', onCancel\);/, 'pointercancel 必须具名注册');
  assert.match(colsBody, /el\.removeEventListener\('pointercancel', onCancel\);/, 'pointercancel 必须注销同一个引用');
  assert.match(colsBody, /const resetColWidth = \(\) =>/, '必须有双击复位');
  assert.match(colsBody, /window\.localStorage\.removeItem\(HWB_COL_WIDTH_KEY\)/, '复位必须清掉持久化偏好');
  assert.match(colsBody, /onDoubleClick: resetColWidth/, '把手必须接上双击复位');
  assert.match(src, /\.hwb-concurrent-gap\{[^}]*cursor:col-resize/, '把手光标必须与官方 widthHandle 同值（col-resize）');
  assert.match(src, /\.hwb-concurrent-gap\{[^}]*touch-action:none/, '把手必须 touch-action:none（否则触屏上拖动会被滚动手势抢走）');
  assert.match(src, /\.hwb-concurrent-gap\[data-dragging\] \.hwb-concurrent-gap-line\{opacity:1\}/,
    '拖动中那条竖线必须常亮（官方 widthHandle[data-dragging]:after 同款反馈）');
});

test('★ 0.19.62 并发：面板意图守卫必须存在（panelInfo 订阅 + 面板内 pointerdown 判别）', () => {
  const src = clientSrc();
  // 守卫三件套：服务面可用性探测、时间窗、回拉。
  assert.match(src, /const PANEL_GUARD_MS = \d+;/, '回拉判别必须有明确的时间窗常量');
  assert.match(src, /function panelGuardAvailable\(layout\)/, '必须先探测 ctx.layout 服务面（缺席降级，不是崩溃）');
  assert.match(src, /function createPanelGuard\(layout, panelId, probe\)/, '必须有守卫运行体（0.19.64 起带事实面参数）');
  const guard = src.slice(src.indexOf('function createPanelGuard'), src.indexOf('function ConcurrentPanelIcon'));
  assert.ok(guard.length > 0, '找不到 createPanelGuard 函数体（改名/移动需同步本判据）');
  assert.match(guard, /layout\.panelInfo\.subscribe\(/, '必须订阅 panelInfo（官方裸 observable：getSnapshot + subscribe）');
  // 0.19.62 真机教训（「面板全空」）：守卫绝不能在渲染期同步建——subscribe 同步抛
  // 会把整个 main 条目炸成官方边界下的空 div。两道防线都必须在位：
  //   ① createPanelGuard 内部 subscribe 自带 try/catch（订阅失败只损失守卫）；
  //   ② ConcurrentPanel 的守卫只存在于挂载 effect 里（渲染路径零守卫），
  //      且 effect 体对 create/监听/清理全部 try/catch。
  assert.match(guard, /try \{[\s\S]*?unsubscribe = layout\.panelInfo\.subscribe\(/,
    'createPanelGuard 内部必须把 subscribe 包进 try/catch（订阅失败降级，不外抛）');
  const panel = src.slice(src.indexOf('function ConcurrentPanel(props)'), src.indexOf('function createPanelGuard'));
  assert.ok(panel.length > 0, '找不到 ConcurrentPanel 函数体（改名/移动需同步本判据）');
  assert.ok(!/onPointerDown: guardRef/.test(panel),
    '渲染路径不得再同步建守卫/挂 onPointerDown prop（0.19.62 首版正是这个形态炸出空白面板）');
  assert.match(panel, /createPanelGuard\(props\.layout, CONCURRENT_PANEL_ID, factsRef\.current\)/,
    '守卫必须在挂载 effect 里创建，并把面板根事实面传进去（0.19.64：判落点要用 rootEl）');
  assert.match(panel, /addEventListener\('pointerdown', onDown, true\)/,
    'pointerdown 指纹必须用 DOM addEventListener 接（渲染路径零守卫）');
  assert.match(panel, /createPanelGuard\(props\.layout, CONCURRENT_PANEL_ID, factsRef\.current\); \} catch/,
    'effect 里 createPanelGuard 必须 try/catch（任何失败降级成没有守卫）');
  assert.match(panel, /removeEventListener\('pointerdown', onDown, true\)/,
    '卸载必须 removeEventListener（与 addEventListener 成对）');
  assert.match(guard, /layout\.selectPanel\(panelId\)/, '回拉必须走官方 layout.selectPanel（不绕过宿主）');
  // ctx.layout 必须从注册处传进面板（reflect 服务面，与 sessions 同口径），且必须
  // **经 layoutFaceOf 读**——0.19.63 真机空白根因：直接写 `layout: ctx.layout` 时，
  // inject 漏声明会让 cordis 在**渲染期**抛 `cannot get property "layout" without inject`，
  // 组件还没构造出来就被官方 SlotErrorBoundary 兜成空 div。
  assert.match(src, /layout: layoutFaceOf\(ctx\)/,
    '注册处必须经 layoutFaceOf 把 layout 服务面传给 ConcurrentPanel（直接读 ctx.layout 会渲染期抛错）');
  assert.ok(!/layout: ctx\.layout/.test(src),
    '不得再直接读 ctx.layout：未声明 inject 时它是**抛错**而不是 undefined ⇒ 官方空盒 ⇒ 面板全白');
  // 条目级边界（0.19.63）：`ConcurrentPanel` 元素**构造本身**抛错时，0.19.62 那两层
  // 内部边界够不着，所以注册处还要再包一层 HwbBoundary。
  assert.match(src, /\(props\) => h\(HwbBoundary, \{ label: '并发会话面板' \},\s*\n\s*h\(ConcurrentPanel,/,
    'main 条目注册处必须再包一层 HwbBoundary（面板级崩溃要变成可读文本，不是空盒）');
});

test('★ 0.19.64 并发：面板路径用到的标识符必须在工厂作用域可见（跨作用域接线断裂族）', () => {
  const src = clientSrc();
  // 这一族到 0.19.64 已经咬过两次：
  //   ① `warn` 声明在 apply() 里，而 ConcurrentPanel/createPanelGuard 在 apply() 之外
  //      ⇒ `ReferenceError: warn is not defined`（0.19.63 修）；
  //   ② `CONCURRENT_PANEL_ID` 同样声明在 apply() 里 ⇒ 挂载 effect 里
  //      `ReferenceError: CONCURRENT_PANEL_ID is not defined`，被 effect 的 try/catch
  //      吞成一句 warn ⇒ **守卫从来没生效过**（用户 2026-10-05 报的「还是会切回到官方工作区」）。
  // 正则判据看不见作用域，所以这里做一次**真扫描**：把面板路径那几个函数体里的标识符用法，
  // 与「只在 apply() 内部声明过的名字」取交集；交集非空即红。
  const applyAt = src.indexOf('function apply(ctx) {');
  assert.ok(applyAt > 0, '找不到 function apply(ctx)（改名则本判据失效，需同步）');
  const outer = src.slice(0, applyAt);
  const inner = src.slice(applyAt);
  const declared = (text) => new Set(Array.from(text.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)).map(m => m[1]));
  const outerNames = declared(outer);
  const onlyInApply = new Set(Array.from(declared(inner)).filter(n => !outerNames.has(n)));
  // 面板路径：定义在 apply() 之外的那几个函数（它们只能用工厂作用域里的名字）。
  // 0.19.68（10-08 轮）补 `ColumnHeader`：它是列顶栏（官方 header 复刻），由 ConcurrentColumns
  // 渲染，用到的 oc / HEADER_TEXT / headerMenu / downloadSessionLog / PRESET_LABELS 等全部
  // 声明在工厂作用域（apply() 之前）——纳入扫描，防的是「顺手引用了只在 apply() 里的名字」
  // 这一族真机 ReferenceError（warn / CONCURRENT_PANEL_ID 各咬过一次）。
  const PANEL_FNS = ['function ConcurrentPanel(', 'function ConcurrentColumns(', 'function ConcurrentColumn(',
    'function ColumnHeader(', 'function createPanelGuard(', 'function ConcurrentPanelIcon(', 'const HwbBoundary'];
  const used = new Set();
  for (const marker of PANEL_FNS) {
    const at = src.indexOf(marker);
    if (at < 0) { assert.fail('找不到面板路径函数（改名则本判据失效，需同步）：' + marker); }
    // 只取**这个函数自己**的函数体：到下一处顶层 `\n    function ` 为止，找不到就截 6000 字符。
    const end = src.indexOf('\n    function ', at + 10);
    const body = src.slice(at, end > at ? end : at + 6000);
    // 只看「当值用」的标识符：排除属性访问（`.` 前导）、字符串/模板里的、以及对象字面量的
    // 键（`style:` / `label:` 这种是键名，不是作用域引用——第一版扫描把它们误报成泄漏）。
    for (const m of body.matchAll(/(?<![.\w$'"])([A-Za-z_$][A-Za-z0-9_$]*)(?!\s*:)/g)) used.add(m[1]);
  }
  const leaks = Array.from(used).filter(n => onlyInApply.has(n));
  assert.deepEqual(leaks, [],
    '这些名字只在 apply() 里声明，却被 apply() 之外的面板代码使用 ⇒ 真机 ReferenceError：'
    + JSON.stringify(leaks) + '（照 `warn` / `CONCURRENT_PANEL_ID` 的先例提到工厂作用域）');
});

test('★ 0.19.64 并发：守卫必须覆盖门户浮层（document 捕获 + 面板内/左栏分类）', () => {
  const src = clientSrc();
  const guard = src.slice(src.indexOf('function createPanelGuard'), src.indexOf('function ConcurrentPanelIcon'));
  assert.ok(guard.length > 0, '找不到 createPanelGuard 函数体（改名/移动需同步本判据）');
  // 真机取证：官方工作区胶囊的浮层开在**门户**里，DOM 不在面板子树内，挂在面板根上的
  // pointerdown 永远看不到那一下 ⇒ 必须用 document 捕获。
  assert.match(guard, /document\.addEventListener\('pointerdown', onDocumentPointerDown, true\)/,
    '守卫必须在 document 上捕获 pointerdown（门户浮层里的点击也要看见）');
  assert.match(guard, /document\.removeEventListener\('pointerdown', onDocumentPointerDown, true\)/,
    'document 监听必须与 addEventListener 成对注销');
  assert.match(guard, /const inSidebar = \(target\) =>/, '必须有「落点在官方左栏子树」的判定');
  assert.match(guard, /const inPanel = \(target\) =>/, '必须有「落点在面板内」的判定');
  assert.match(guard, /popupOwnedAt = now/, '必须记「面板外 + 刚点过面板内」的门户链指纹');
  assert.match(guard, /const popupWindow = !!popupOwnedAt && now - popupOwnedAt <= POPUP_CHAIN_MS/,
    '门户链窗口必须独立于 PANEL_GUARD_MS（用户挑工作区可能超过 900ms）');
  assert.match(src, /const POPUP_CHAIN_MS = \d+;/, '门户链窗口必须是具名常量');
  assert.match(src, /'data-hwb-nav-entry': '1'/, '左栏入口必须自打 data-hwb-nav-entry 标记');
  assert.match(guard, /data-hwb-nav-entry/, '左栏子树必须由该标记推算（官方类名是哈希的，钉不住）');
  assert.match(guard, /if \(!node\.contains\(root\)\) last = node; else break;/,
    '左栏子树 = 从入口往上**最后**一个不含面板根的祖先（第一个常是 0×0 包裹层：真机实测，'
    + '拿它当左栏会让「点左栏单会话」被误判成门户链而拉回 —— 报障第 6 条）');
  assert.match(guard, /sidebarRoot = last;/, '左栏子树必须由 last（而非第一个命中）赋值');
  assert.match(guard, /window\.__hwbPanelGuard = forensics/, '守卫必须暴露真机取证读数');
});

// 「每列一键取到独立工作区指令（⧉ 开工）」的判据**已删除**（0.19.68（10-08 轮））：
// 用户第 2 条「并发会话的『开工』那一行去除！！！」+ 第 1 条「不是每个会话一个文件夹！」
// ⇒ 那套 git worktree 隔离流程整体撤掉，判据随之撤销（改由上面 ⑩ 段的反向判据钉住
// 「columnBrief / copyColumnBrief / ⧉ 开工 / hwb-concurrent-brief 都不得复活」）。
// 官方口径的事实陈述仍保留在任务板那句提示里（「官方 Agent Team 是 one shared checkout、
// 不带 worktree」），由 ⑩ 段的 worktree 判据**刻意放行**（见其 ⚠ 注记）。

// ── ⑩ 官方 agentTeams 读取本身保留（它仍是任务板的来源）──────────────────────
/**
 * ★ 0.19.0：用户要的「设置开始时间 / 模式 / 权限」必须**三跳齐全**。
 *
 * 用户 2026-09-22 原话：「功能我要能够实现 graph 布置任务，设置接任务智能体和**时间**，
 * 以及**模式，权限**等等等详细的」。参考实现 `dsh-task-board` 的 NewTaskModal 有
 * schedule/mode/permission/reuseSession 一整套，本桥移植任务板时**整块漏掉了** ——
 * 用户问的「为什么任务板没有设置开始时间等功能」就是它。
 *
 * 这条链路有三跳，缺任何一跳都会变成「填了没用」：
 *
 *   client.cjs（表单有输入框 + 真的发出字段）
 *     → web-control.js `POST task-create`（真的透传）
 *       → task-ledger.js `applyCreate`（真的存住、且经 rowsOf 真的读回来）
 *
 * **为什么必须三跳一起钉**：本仓库记过多次「说做了、其实没做」——尤其是
 * 「服务端算、前端不读」和「前端发、服务端丢」这一对。只钉其中一跳的话，
 * 另外两跳断掉时判据照样全绿（这正是 0.19.0 第二轮 `teamSource` 断链的形态）。
 */
test('★ 0.19.0 任务排期：开始时间/模式/权限必须「界面 → 路由 → 台账」三跳齐全', () => {
  const src = clientSrc();
  // 第一跳：新建弹窗必须有原生日期时间控件与三个执行面输入。
  assert.match(src, /type: 'datetime-local'/, '新建弹窗必须有开始时间输入框（datetime-local）');
  assert.match(src, /setStartAt\(/, '开始时间必须有受控状态');
  assert.match(src, /schedule: \{ startAt: startMs, cron: cron\.trim\(\) \}/,
    '提交时必须把排期真的放进请求体（只画输入框不发字段 = 假功能）');
  assert.match(src, /mode: mode\.trim\(\)/, 'mode 必须真的发出');
  assert.match(src, /permission: permission\.trim\(\)/, 'permission 必须真的发出');
  // 详情页也要能改（只在新建时能设 = 半个功能）。
  // 注意这里查的是**整份源码**：详情页不在并发面板里，用 `compareBody` 会永远找不到
  //（本判据的第一版就写错了，是它自己红出来的）。
  assert.match(src, /toLocalInputValue\(schedule\.startAt\)/, '详情页必须以本地时间回显开始时间');
  assert.match(src, /schedule: \{[\s\S]{0,160}?cron: cronExpr\.trim\(\)/, '详情页保存必须带上排期');

  // 第二跳：路由必须透传（否则前端发了、服务端丢掉，静默失败）。
  const wc = fs.readFileSync(path.join(root, 'lib', 'web-control.js'), 'utf8');
  const createBlock = wc.slice(wc.indexOf("'POST task-create'"), wc.indexOf("'POST task-update'"));
  for (const key of ['schedule', 'mode', 'permission', 'reuseSession']) {
    assert.ok(new RegExp('\\b' + key + ':').test(createBlock),
      '`POST task-create` 必须透传 ' + key + '（不透传 = 界面填了没用）');
  }

  // 第三跳：台账必须存住并经 rowsOf 读回来。
  const led = applyCreate(emptyLedger(), {
    subject: 'x', mode: 'm', permission: 'p', reuseSession: true, schedule: { startAt: 1_700_000_000_000 },
  }, 1_700_000_000_000);
  assert.equal(led.error, null);
  const row = rowsOf(led.ledger)[0];
  assert.equal(row.schedule.startAt, 1_700_000_000_000, '开始时间必须经 rowsOf 读得回来');
  assert.equal(row.mode, 'm');
  assert.equal(row.permission, 'p');
  assert.equal(row.reuseSession, true);
});

test('★ 0.19.0 排期：本地时间回显不得用 toISOString（会把时间漂 8 小时）', () => {
  const src = clientSrc();
  // `toISOString()` 是 UTC：东八区用户会看到差 8 小时的时间，而且「读出来再存回去」
  // 会每次打开漂一次——界面上完全看不出来（数字看着都合理）。
  const helper = src.slice(src.indexOf('function toLocalInputValue'), src.indexOf('function formatStamp'));
  assert.ok(helper.length > 0, 'toLocalInputValue 必须存在');
  assert.ok(!/toISOString/.test(helper), '本地时间字符串不得由 toISOString 派生（那是 UTC）');
  assert.ok(/getFullYear\(\)/.test(helper) && /getMonth\(\)/.test(helper), '必须按本地时区字段手工拼');
});

// ── ⑪ 0.19.68（10-07 轮）：官方视图放行时序（10-08 轮保留）────────────────────────────────
//
// 本段原有三条判据，10-08 轮按用户口径处置如下：
//   · 「官方 session header 不可在列内渲染（两道闸）」→ **保留**，但它的正面部分（自绘 chips
//     必须存在）已随「列顶栏改成官方 header 复刻」撤销；两道闸的反向判据移到上面 ⑩ 段第 ⑦ 组，
//     与复刻判据放在一起（同一段代码、同一个理由，读者不必跨段拼）。
//   · 「跨列引用必须走官方 mention + 官方草稿通道」→ **删除**：用户第 3 条把「⇥ 引用」列为
//     要去除的非官方 UI，整套机制（sessionMentionOf / appendToSessionDraft / conversationFaceOf /
//     inject 'conversation' / hwbConversation）已删，反向判据在 ⑩ 段第 ⑤ 组。
//     能力本身没有丢：`@[标题](dsh-session:<base64url(JSON(id))>)` 是**宿主原生语法**，
//     手打即生效（dsh-session-reference/lib/index.js）。
//   · 「↗ 官方视图」的放行时序 → **保留**（下面这条）：按钮本身已收进「更多操作」菜单，
//     但「先放行再交回官方视图」这个时序要求一字不变，守卫的两个消费点缺一不可。

test('★ 0.19.68（10-07 轮） 并发：「↗ 官方视图」的放行必须同时存在于 pointerdown 与订阅回调两个消费点', () => {
  const src = clientSrc();
  const guard = src.slice(src.indexOf('function createPanelGuard'), src.indexOf('function ConcurrentPanelIcon'));
  assert.ok(guard.length > 0, '找不到 createPanelGuard 函数体（改名/移动需同步本判据）');
  // 0.19.68（10-07 轮） 根因（#47④ knownGap）：allowLeave 由按钮 onClick 置位，而 onClick 发生在
  // pointerdown **之后**——pointerdown 捕获期那个消费点永远读到 false。订阅回调才是
  // 「跳走那一刻」做决策的地方，两个消费点缺一不可。
  const consumption = guard.match(/if \(probe && probe\.allowLeave\) \{/g) || [];
  assert.equal(consumption.length, 2,
    'allowLeave 必须有两个消费点（pointerdown 捕获期 + panelInfo 订阅回调）——'
    + '只有 pointerdown 一个时，onClick 置位永远赶不上，官方视图必被拉回（#47④ 真机两轮实测）');
  assert.match(guard, /forensics\.lastDecision = 'allow:leave'/,
    '订阅回调里的放行必须记入取证读数（探针可查，不再是无从验证的 knownGap）');
});
