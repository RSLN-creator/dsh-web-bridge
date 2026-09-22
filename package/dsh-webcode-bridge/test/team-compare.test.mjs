// team-compare.test.mjs — 「本插件并列多会话组成的 team」护栏（0.18.0）。
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
// 即：Team = **若干条各自独立的网页会话并排**，不是官方 AgentTeams 的花名册。
//
// 0.17.3 那版「三列对比视图」有三个真缺陷，本轮全部修掉。三条各一个护栏，
// 任何一条被改回去都会在这里红：
//
//   ① 硬编码三列 → 数组驱动，支持 2~4 列，可加可删；
//   ② `msgs[msgs.length - 1]` 定位回复 → 每条消息带 id，按 id 精确回填；
//   ③ 不带 `sessionKey` → 每列铸稳定会话键并一直复用。

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

/** 取出 MultiModelCompareView 的函数体（到下一个顶层 function 为止）。 */
function compareBody(src) {
  const a = src.indexOf('function MultiModelCompareView(props) {');
  assert.ok(a > 0, '找不到 MultiModelCompareView（改名则本护栏失效，需同步）');
  const b = src.indexOf('\n    function ', a + 10);
  return src.slice(a, b === -1 ? a + 20000 : b);
}

test('★ 0.18.0 Team：列数由数组驱动，支持 2~4 列（不得再硬编码三列）', () => {
  const body = compareBody(clientSrc());

  // ① 硬编码三列的**具体形态**：三个独立 state + 三段复制粘贴的 JSX。
  assert.ok(!/col1Site|col2Site|col3Site/.test(body),
    '不得再有 col1Site/col2Site/col3Site 三个独立 state —— 那正是「加不了第四列」的根源');
  assert.ok(!/columns\[0\]|columns\[1\]|columns\[2\]/.test(body),
    '不得再按下标取列 —— 那是三份复制粘贴的 JSX');

  // ② 必须是数组驱动（正判据：不只看「没写死」，还看「有没有做对」）。
  assert.match(body, /const \[cols, setCols\] = React\.useState/, '列状态必须是数组');
  assert.match(body, /const MIN_COLS = 2;/, '必须有 MIN_COLS');
  assert.match(body, /const MAX_COLS = 4;/, '必须有 MAX_COLS —— 用户要的是 2~4 列');
  assert.match(body, /cols\.map\(/, '渲染必须由 cols.map 驱动');
  assert.match(body, /const addCol = \(\) =>/, '必须有加列操作');
  assert.match(body, /const removeCol = \(key\) =>/, '必须有删列操作');
});

test('★ 0.18.0 Team：CSS 列数必须按实际列数排（写死 repeat(3) 会让第四列换行）', () => {
  const src = clientSrc();
  // 写死的具体形态。
  assert.ok(!/\.hwb-compare-columns\{[^}]*repeat\(3,1fr\)/.test(src),
    'CSS 不得写死 repeat(3,1fr) —— 加出来的第四列会被挤到第二行');
  // 必须按 data-cols 自适应（正判据）。
  //
  // 这里用 indexOf 而不是正则：client.cjs 里的 CSS 是**带反斜杠转义的字符串**
  // （`[data-cols=\"2\"]`），正则里写引号要再过一层转义，极易写成本条第一版那种
  // 「看起来对、实际匹配不到」的判据 —— 那会让护栏变成装饰。
  for (const n of ['2', '3', '4']) {
    assert.ok(src.includes('data-cols=\\"' + n + '\\"]'),
      '必须有 data-cols="' + n + '" 的列布局规则（实际文件里带反斜杠转义）');
  }
});

test('★ 0.18.0 Team：回复必须按消息 id 回填（不得用 msgs[length-1] 定位）', () => {
  const body = compareBody(clientSrc());

  // 竞态的具体形态：用「最后一条」定位要替换的回复。
  assert.ok(!/msgs\[msgs\.length - 1\]\s*=/.test(body),
    '不得用 msgs[msgs.length - 1] 定位回复 —— 并发下用户已发下一轮时，' +
    '后到的回复会把新一轮的用户消息覆盖掉');

  // 正判据：每条消息带 id，按 id 匹配回填。
  assert.match(body, /const botId = /, '占位回复必须带 id');
  assert.match(body, /m\.id !== job\.botId \? m :/, '必须按 id 精确回填');
  // 组件卸载后不许再 setState（并发回来的最后一拍）。
  assert.match(body, /const aliveRef = React\.useRef\(true\)/, '必须有卸载判据');
  assert.match(body, /if \(!aliveRef\.current\) return;/, '卸载后必须提前返回');
});

test('★ 0.18.0 Team：每列必须铸稳定 sessionKey 并复用（否则「多会话」名存实亡）', () => {
  const body = compareBody(clientSrc());

  // 请求必须带上该列的会话键 —— 这是「各自接着聊」的唯一凭据。
  assert.match(body, /api\('chat', \{[^}]*sessionKey: job\.sessionKey/, 'api(chat) 必须带 sessionKey');
  // 首次发送时铸键、之后复用（不是每轮新铸）。
  assert.match(body, /const sessionKey = c\.sessionKey \|\| \(/, '首次发送才铸键，之后复用');
  // 会话身份对用户可见（可核对续在哪条会话上）。
  assert.match(body, /hwb-compare-session/, '会话身份必须可见 —— 用户要能核对');
});

test('★ 0.18.0 Team：一列失败只标那一列，其余列照常', () => {
  const body = compareBody(clientSrc());
  // 具体形态：失败的列单独标 error 状态与原因。
  assert.match(body, /status: ok \? 'done' : 'error'/, '每列必须有独立的成败状态');
  assert.match(body, /c\.status === 'error' && c\.error/, '失败原因只显示在它自己那一列');
  // 不得有「一列失败就整轮中止」的形态。
  assert.ok(!/Promise\.all\(/.test(body),
    '不得用 Promise.all 等全体 —— 用户 §4-Q1 的默认是「单独标红，其余列照常」');
});

// ── 0.19.0：官方花名册 Team 面板必须保持删除 ─────────────────────────────────

test('★ 0.19.0 Team：官方 agentTeams 花名册面板不得复活（用户明确说参考错了）', () => {
  const src = clientSrc();

  // 组件本体不得存在。
  assert.ok(!/function TeamPanel\(/.test(src),
    'TeamPanel 组件复活了 —— 用户 2026-09-22 明确要求删除这份「官方 agentTeams 花名册」呈现：' +
    '「team不是指的官方team那样……参考错误了」（doc/user-voice-log.md:3670）');

  // 右栏标签页注册与正文座位都不得存在。
  assert.ok(!/'dsh-webcode-bridge\/team'/.test(src),
    'TEAM_ID（dsh-webcode-bridge/team）复活了 —— 官方花名册 Team 标签页必须保持删除');
  assert.ok(!/'webcode-team'/.test(src),
    'TEAM_KIND（webcode-team）复活了 —— 官方花名册 Team 标签页必须保持删除');
  assert.ok(!/sidebarRightTabs\.register\(\{[^}]*webcode-team/s.test(src),
    '右栏仍在注册 webcode-team 标签页类型');

  // 正判据：本插件的 Team 必须落在**中央对话区**（conversation.view），
  // 而不是右栏。只删不加 = 用户再也找不到 Team，那是另一种失败。
  assert.match(src, /inject\('conversation\.view'/,
    '并列多会话视图必须注册到 conversation.view（中央对话区）—— 删了旧的却没有新的，用户就找不到 Team 了');
  assert.match(src, /'webcode-compare-view'/,
    'conversation.view 的视图 id 必须是 webcode-compare-view');
  // label 必须与真实能力一致：支持 2~4 列，不得再自称「三列」。
  assert.ok(!/label: \(\) => '三列模型对比'/.test(src),
    'label 仍写「三列模型对比」而实际支持 2~4 列 —— 名称与能力不符即假陈述');
});

test('★ 0.19.0 Team：并列多会话视图必须自述「并列多会话」且列数自适应', () => {
  const src = clientSrc();
  const body = compareBody(src);
  // 标题与 label 都要表达真实语义。
  assert.match(body, /并列多会话 Team/,
    '视图标题必须自述「并列多会话 Team」—— 这是本插件对 Team 的定义');
  // 列数上限必须真的封顶（护栏同时确认 MAX_COLS 被用于禁用加列按钮）。
  assert.match(body, /disabled: cols\.length >= MAX_COLS/,
    '加列按钮必须在达到 MAX_COLS 时禁用 —— 否则用户可以加出布局撑不住的列数');
  // 会话身份可见：用户要能核对「这一列续在哪条网页会话上」。
  assert.match(body, /hwb-compare-session/,
    '每列的会话身份必须可见');
});

/**
 * ★ 0.19.0：发送锁必须**必然解开**（第三轮对抗审查抓到的阻断级真缺陷）。
 *
 * 原写法把 `setSending(false)` 放进一个 `setCols` 的 updater 里，并用微任务延后：
 *
 *     Promise.resolve().then(() => setCols((prev) => {
 *       if (prev.some((c) => c.status === 'streaming')) return prev;
 *       setSending(false); return prev;
 *     }));
 *
 * 它**必然不解锁**：微任务排进队列时，上面刚把每列设成 `streaming`，而 `api('chat')`
 * 的往返还没回来 ⇒ 判定「仍有 streaming」⇒ 提前返回，解锁那行永不执行。
 * 后果：三列都显示「已完成」，而发送按钮永远停在「发送中…」且 disabled——**一次挂载
 * 只能问一句**。而 `conversation.view` 是中央常驻视图、不随交互卸载，不会自愈。
 *
 * 判据三条（缺一即回到旧缺陷）：
 *   ① 必须用**计数**判断全线收尾，而不是事后扫描列状态（扫描必然在往返前跑）；
 *   ② 解锁必须放在 `finally` 里（失败也要减，否则一列异常就永久锁死）；
 *   ③ **不得**在 `setCols` 的 updater 里调 `setSending`——那是不纯 reducer，
 *      StrictMode 双调用下行为未定义。
 */
test('★ 0.19.0 Team：发送锁必须必然解开（不得靠微任务猜列状态）', () => {
  const raw = compareBody(clientSrc());
  // 判据只看**去掉注释的代码**：上面那段说明里逐字引用了旧写法（含
  // `Promise.resolve().then(`），不去注释就会把「解释」当成「缺陷仍在」——
  // 这是本仓库反复踩到的坑（`client-render.test.mjs` 为此立过规矩）。
  // 另注意文件是 **CRLF**：按 `\r?\n` 切分，否则尾部 `\r` 会让 `$` 对不上、整行注释
  // 根本剥不掉（本项目刚记过的「空转」缺陷）。
  const body = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // 旧缺陷的具体形态：微任务里扫 streaming。
  assert.ok(!/Promise\.resolve\(\)\.then\(/.test(body),
    '不得用 `Promise.resolve().then(...)` 去「等一等再猜」列状态 —— 它在网络往返之前就跑了');
  assert.ok(!/setCols\(\(prev\) => \{[\s\S]{0,200}?setSending\(/.test(body),
    '不得在 setCols 的 updater 里调 setSending —— 不纯 reducer，StrictMode 下未定义');

  // ① 计数器。
  assert.match(body, /const pendingRef = React\.useRef\(0\)/, '必须用 pendingRef 计数在途列数');
  assert.match(body, /pendingRef\.current \+= jobs\.length/, '发出时必须按列数累加');
  // ①b **必须声明在组件体顶层**（0.19.0 第四轮自查抓到的阻断级缺陷）。
  //
  // 第一版把它写在 `handleSendAll` 的函数体里 —— 那是**事件处理器**，不是渲染期。
  // 真实 React 在渲染之外调用 `useRef` 会抛 `Invalid hook call`：点一次「同时发送」
  // 整块视图就炸，一列都发不出去。**比它要修的「按钮锁死」更重**。
  //
  // 上面那条 `assert.match(body, /const pendingRef = React\.useRef\(0\)/)` 是**文本存在性**
  // 断言，写在事件处理器里同样满足 —— 这正是它漏网的原因（判据本身建模失真）。
  // 这里改成按**花括号深度**判「位置」：深度 1 = 组件体直接子句；>=2 = 嵌套函数体内。
  // 同一条纪律在 `hooks-order.test.mjs` 已有先例（按结构而不是按文本判定）。
  const depthAt = (needle) => {
    const lines2 = body.split('\n');
    const startIdx = lines2.findIndex((l) => /function MultiModelCompareView/.test(l));
    assert.ok(startIdx >= 0, '找不到 MultiModelCompareView（改名则本判据失效，需同步）');
    let depth = 0;
    let started = false;
    for (let i = startIdx; i < lines2.length; i++) {
      const code = lines2[i].replace(/'(?:\\.|[^'])*'/g, "''").replace(/"(?:\\.|[^"])*"/g, '""');
      if (!started && code.includes('{')) started = true;
      if (needle.test(lines2[i])) return depth;
      for (const ch of code) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      if (started && depth <= 0 && i > startIdx + 5) break; // 组件体已结束
    }
    return -1; // 未找到
  };
  const pendingDepth = depthAt(/const pendingRef = React\.useRef\(0\)/);
  assert.equal(pendingDepth, 1,
    'pendingRef 必须声明在组件体顶层（花括号深度 1）。深度 ' + pendingDepth
    + ' = 写在嵌套函数体内 ⇒ 真实 React 会抛 Invalid hook call，点「同时发送」整块视图报错。'
    + '实测深度 2 就是第一版的写法。');
  // 对照：同组件体的其它 ref 也是深度 1 —— 判据自身必须能区分「顶层」与「嵌套」，
  // 否则它只是一个恒真的装饰品（本项目对护栏的基本要求）。
  assert.equal(depthAt(/const aliveRef = React\.useRef\(true\)/), 1, 'aliveRef 应在组件体顶层（对照）');
  assert.equal(depthAt(/const handleSendAll = /), 1, 'handleSendAll 是组件体顶层的函数定义（对照）');
  assert.equal(depthAt(/pendingRef\.current \+= jobs\.length/), 2,
    '累加语句应在 handleSendAll 体内（深度 2）——若这里也变成 1，说明函数被展开了（对照）');
  // ② 解锁在 finally 里（成功/失败都要减）。
  assert.match(body, /\.finally\(\(\) => \{/, '收尾必须走 finally —— 失败也要减计数');
  assert.match(body, /pendingRef\.current -= 1;/, 'finally 里必须减计数');
  assert.match(body, /if \(pendingRef\.current <= 0 && aliveRef\.current\) \{/,
    '计数归零（且组件仍挂载）时才解锁');
  assert.match(body, /setSending\(false\);/, '必须真的解锁');
  // ③ 解锁只能出现一次（在 finally 块里），不得有第二处散落的解锁。
  const clears = (body.match(/setSending\(false\)/g) || []).length;
  assert.equal(clears, 1, 'setSending(false) 只应在 finally 的收尾处出现一次，实际=' + clears);
});


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
  const body = compareBody(src);
  // 第一跳：新建弹窗必须有原生日期时间控件与三个执行面输入。
  assert.match(src, /type: 'datetime-local'/, '新建弹窗必须有开始时间输入框（datetime-local）');
  assert.match(src, /setStartAt\(/, '开始时间必须有受控状态');
  assert.match(src, /schedule: \{ startAt: startMs, cron: cron\.trim\(\) \}/,
    '提交时必须把排期真的放进请求体（只画输入框不发字段 = 假功能）');
  assert.match(src, /mode: mode\.trim\(\)/, 'mode 必须真的发出');
  assert.match(src, /permission: permission\.trim\(\)/, 'permission 必须真的发出');
  // 详情页也要能改（只在新建时能设 = 半个功能）。
  // 注意这里查的是**整份源码**而不是 `compareBody`：详情页不在 MultiModelCompareView
  // 里，用前者会永远找不到（本判据的第一版就写错了，是它自己红出来的）。
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
