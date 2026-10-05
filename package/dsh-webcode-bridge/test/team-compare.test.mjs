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
  assert.match(src, /const inject = \['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'layout'\];/,
    'inject 必须含 sessions（每列 create/retain）与 layout（守卫要读 ctx.layout.panelInfo）');

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
  assert.match(body, /cols\.map\(/, '渲染必须由 cols.map 驱动');
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
  assert.match(body, /Math\.min\(colWidthMax, Math\.max\(colWidthMin, officialDefault\)\)/,
    '夹取顺序必须是 min(上限, max(下限, 默认))');
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

test('★ 0.19.65 并发：点「并发会话」= 点「新会话」——每次打开都新建一组（0.19.55 的「恢复旧组」按用户口径反转）', () => {
  const src = clientSrc();
  // 用户 2026-10-06 原话：「7.点击并发会话不会每次左侧出现一行记录会话让点击后回到原来选择
  // 工作区/模式/模型/对话」「8.没有做到点击并发会话和点击新会话一样的新建会话」。
  // ⇒ 口径**反转**：每次打开都新建一组真会话；旧组那几条会话仍在左栏清单里，可单独打开继续。
  assert.match(src, /const CONCURRENT_STORE_PREFIX = 'dsh-webcode-bridge\.concurrent\.';/,
    '组必须有稳定的存储键前缀');
  assert.match(src, /function writeConcurrentGroup\(key, ids\)/, '必须有写回函数（留痕）');
  assert.ok(!/function readConcurrentGroup\(/.test(src),
    '读回**函数**已按用户新口径撤销：不得再恢复旧组（每次打开都新建一组；注释里提它是允许的）');
  const body = compareBody(src);
  assert.match(body, /createdRef\.current = true;[\s\S]{0,80}?createColumns\(CONCURRENT_DEFAULT_COLS\)/,
    '挂载后必须自动新建一组（点入口 = 点新会话）');
  assert.match(body, /writeConcurrentGroup\(groupKey, cols\.map\(c => c\.sessionId\)\)/,
    '组变化仍要落盘留痕（排障时可核对上一次那一组是哪几条会话）');
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
  assert.match(src, /\.hwb-concurrent-gap:hover \.hwb-concurrent-gap-line\{opacity:1\}/,
    '鼠标移到间隔上才画出那条 1px 竖线');
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

test('★ 0.19.62 并发：新建列必须尝试绑定当前工作区（「选择工作区」卡不该在列里出现）', () => {
  const src = clientSrc();
  const body = compareBody(src);
  // 建列取工作区 id，且 create 的参数随有无 workspaceId 分叉（缺工作区时保持旧行为）。
  assert.match(body, /const workspaceId = currentWorkspaceId\(\);/,
    'createColumns 必须先取 currentWorkspaceId()');
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
  const PANEL_FNS = ['function ConcurrentPanel(', 'function ConcurrentColumns(', 'function ConcurrentColumn(',
    'function createPanelGuard(', 'function ConcurrentPanelIcon(', 'const HwbBoundary'];
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

test('★ 0.19.64 并发：每列必须能一键取到「独立工作区」指令（git 分支 + 收尾轮转）', () => {
  const body = compareBody(clientSrc());
  assert.match(body, /const columnBrief = \(col, index\) =>/, '必须有可复制的开工指令生成器');
  assert.match(body, /git worktree add -b ' \+ branch \+ ' ' \+ wt \+ ' HEAD/,
    '指令必须给出 `git worktree add -b <分支> <目录> HEAD`（每列一个工作区）');
  assert.match(body, /merge --no-ff ' \+ branch/, '必须给出收尾「轮转」：把该列分支合并回主线');
  assert.match(body, /'⧉ 开工'/, '每列列头必须有一键复制入口');
  // 口径不许漂：必须写明「官方沙箱按会话解析工作区根」「官方 Team 是 one shared checkout、不带 worktree」，
  // 否则读者会以为官方自带这套隔离（真机取证见 doc/research/2026-10-05-…-hot-swap.md §10）。
  assert.match(body, /SessionHeader\.cwd|dsh-sandbox-policy/, '指令里必须引官方沙箱口径（按会话解析工作区根）');
  assert.match(body, /one shared checkout/i, '指令里必须写明官方 Agent Team 是一个共享检出、不带 worktree');
});

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
