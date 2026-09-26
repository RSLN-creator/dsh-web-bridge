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
  // 0.19.20：回填的对照物从 `job.botId` 变成了本列的 `botId` 闭包变量 ——
  // 「按 id 精确回填」这条判据本身不变，变的只是它长在哪个函数里。
  assert.match(body, /m\.id !== botId \? m :/, '必须按 id 精确回填');
  // 组件卸载后不许再 setState（并发回来的最后一拍）。
  assert.match(body, /const aliveRef = React\.useRef\(true\)/, '必须有卸载判据');
  assert.match(body, /if \(!aliveRef\.current\) return;/, '卸载后必须提前返回');
});

test('★ 0.18.0 Team：每列必须铸稳定 sessionKey 并复用（否则「多会话」名存实亡）', () => {
  const body = compareBody(clientSrc());

  // 请求必须带上该列的会话键 —— 这是「各自接着聊」的唯一凭据。
  //
  // 0.19.20：`POST chat` 的调用点从「按 job 循环发」变成「每列各发一次」，
  // 所以判据改为「在 sendCol 体内、且 api('chat') 的参数对象里真的出现 sessionKey」。
  // 只看「源码里出现过 sessionKey」是不够的——那在字段名上也会命中。
  const sendFn = body.slice(body.indexOf('const sendCol = '));
  assert.ok(sendFn.length > 0, '必须存在按列发送的函数 sendCol（改名则本判据失效，需同步）');
  const chatCall = sendFn.slice(sendFn.indexOf("api('chat', {"));
  assert.ok(chatCall.length > 0, 'sendCol 内必须真的调 api(chat)');
  assert.match(chatCall.slice(0, 400), /\bsessionKey,/, 'api(chat) 必须带 sessionKey');
  // 首次发送时铸键、之后复用（不是每轮新铸）。
  assert.match(body, /const sessionKey = col\.sessionKey \|\| \(/, '首次发送才铸键，之后复用');
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

test('★ 0.19.29 Team：标题必须自述「并列」，且上方不得再占位置', () => {
  const raw = clientSrc();
  const body = compareBody(raw);
  // 判据只看**去掉注释的代码**：本文件的注释会逐字引用用户原话（含「并列多会话 Team」），
  // 不去注释就会把「解释」当成「旧标题还在」——本仓库反复踩到这个坑
  //（team-compare 与 client-render 都为此立过规矩）。
  // 另注意文件是 **CRLF**：按 `\r?\n` 切分，否则尾部 `\r` 会让 `$` 对不上、整行注释剥不掉。
  const code = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // 标题：用户 2026-09-26 原话「将『并列多会话』改为『并列』」。
  assert.match(code, /h\('h3', \{ className: 'hwb-compare-title' \}, '并列'\)/,
    '视图标题必须是「并列」（用户要求把「并列多会话」改为「并列」）');
  assert.ok(!/并列多会话/.test(code),
    '「并列多会话」必须从渲染代码里消失 —— 用户要求改名为「并列」并删掉说明');
  // 那两行说明文字必须删除（用户：「上方不必要占用位置……说明去除」）。
  assert.ok(!/每列一条独立网页会话/.test(code),
    '标题下的说明文字必须删除 —— 用户说它「上方不必要占用位置」');
  assert.ok(!/把某列设为「主审」后/.test(code), '说明文字第二句也必须删除');
  assert.ok(!/hwb-compare-tools/.test(code),
    '顶部工具行（3 列／主审：X／+ 加一列）必须移走 —— 它也是「上方占位置」的一部分');
  // 加列能力**没有丢**（用户第 2 点：能力不能少）。列数上限必须真的封顶。
  assert.match(code, /disabled: cols\.length >= MAX_COLS/,
    '加列按钮必须在达到 MAX_COLS 时禁用 —— 否则用户可以加出布局撑不住的列数');
  // 会话身份可见：用户要能核对「这一列续在哪条网页会话上」。
  assert.match(code, /hwb-compare-session/,
    '每列的会话身份必须可见');
});

/**
 * ★ 0.19.29：**去除列的分界**，改成官方那套「隐形 + hover 一点光」（用户第 1 点）。
 *
 * 用户原话（逐字）：「然后去除每列对话的对话框分界，用官方现在的隐形加上鼠标移到后
 * 显示一点光线的结构，完全照抄 dsh」。
 *
 * 判据成对：既要有「旧的可见分界确实没了」，也要有「新的 hover 光确实在」——
 * 只测前者能过掉「把样式全删了」，只测后者能过掉「旧边框还在」。
 */
test('★ 0.19.29 Team：列分界必须改为「隐形 + hover 光」（照抄官方）', () => {
  const raw = clientSrc();
  const body = compareBody(raw);
  // 同前：剥掉注释再判 —— 渲染处的注释会逐字解释「旧的列头长什么样」。
  const code = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // ── 负判据：常驻可见的分界必须整体消失 ──────────────────────────────────
  // 列头那一行（站点下拉 / 状态 / 设为主审 / ✕）就是用户说的「分界」。
  assert.ok(!/hwb-compare-col-head/.test(code),
    '列头整行必须删除（用户：「去除每列对话的对话框分界」）');
  // 旧写法：常驻的卡片底色 + 边框 —— 那是「分界」的本体。
  assert.ok(!/\.hwb-compare-col\{[^}]*background:var\(--dsw-alias-bg-layer-1/.test(raw),
    '列不得再有常驻的卡片底色（那就是用户看到的分界）');
  assert.ok(!/\.hwb-compare-col\{[^}]*border:\.5px solid/.test(raw),
    '列不得再有常驻边框（那就是用户看到的分界）');

  // ── 正判据：官方那套 hover 光线必须在 ──────────────────────────────────
  assert.match(raw, /\.hwb-compare-col\{[^}]*background:transparent[^}]*border:0/,
    '列必须隐形：底色透明、无边框');
  assert.match(raw, /\.hwb-compare-col:hover[^{]*\{[^}]*var\(--dsw-alias-interactive-bg-hover/,
    '鼠标移到列上必须浮起官方那档交互底色（用户要的「一点光线」）');
  // 键盘用户也要能看到落点，否则光线只在鼠标下存在。
  assert.match(raw, /\.hwb-compare-col:focus-within/,
    'focus-within 必须同样给光 —— 否则键盘用户永远看不到自己的落点在哪一列');

  // ── 控件没有丢：四个都搬进了每列对话框工具栏 ────────────────────────────
  const mapBody = body.slice(body.indexOf('cols.map('));
  assert.match(mapBody, /className: 'hwb-col-composer-select'/, '站点选择必须搬进对话框工具栏');
  assert.match(mapBody, /onChange: \(e\) => setColSite\(c\.key, e\.target\.value\)/,
    '站点选择必须仍然改得动本列的站点');
  assert.match(mapBody, /onClick: \(\) => setReviewCol\(c\.key\)/, '「设为主审」必须搬进工具栏');
  assert.match(mapBody, /onClick: \(\) => removeCol\(c\.key\)/, '「移除列」必须搬进工具栏');
  assert.match(mapBody, /hwb-col-composer-badge review/, '主审标记必须是极小徽标（用户要求）');
});

/**
 * ★ 0.19.29（用户第 2 点）：每列对话框必须**照抄官方**，且带完整的模型选择。
 *
 * 用户原话（逐字）：「『并列』中每列的对话框改为：官方原生的对话框：保留完整的
 * 切换模式，模型显示项目等完整能力/UI！直接照抄！」
 *
 * 这条要防的是「把类名改了、能力没接上」这种假修复，因此判据**四跳齐全**：
 *   ① 选择器在渲染里存在且受控（改得动）；
 *   ② 选项**真的来自桥的模型清单**，不是写死一份（写死的清单会随桥端新增模型静默过期）；
 *   ③ 选中的模型**真的随请求下发**（选了不发 = 假功能，本项目记过多次）；
 *   ④ 后端**本来就有**这个形参（不新增后端路径 —— 用户要求别动真实桥接 web 端）。
 */
test('★ 0.19.29 Team：每列的模型选择必须四跳齐全（渲染 → 清单 → 下发 → 后端已有）', () => {
  const raw = clientSrc();
  const body = compareBody(raw);

  // ① 渲染：工具栏里必须有受控的模型选择器。
  assert.match(body, /className: 'hwb-col-composer-select'[\s\S]{0,400}?onChange: \(e\) => setColModel\(c\.key, e\.target\.value\)/,
    '每列对话框工具栏必须有模型选择器，且改写的是**本列**的 modelId');

  // ② 清单来自桥，不写死。
  assert.match(body, /api\('models'\)/, '模型清单必须来自桥的 GET models（写死的清单会静默过期）');
  assert.match(body, /const modelsForSite = \(siteId\) => modelCatalog\.filter\(\(m\) => m\.siteId === siteId\)/,
    '必须按该列的站点过滤模型（跨站点的模型 id 发过去会发不动）');
  // 写死清单的具体形态：组件里出现一个字面量模型数组。
  assert.ok(!/modelCatalog: \[|modelOptions = \[\s*\{/.test(body),
    '不得在组件里写死一份模型清单 —— 那会在桥端新增/改名模型时静默过期');

  // ③ 下发：选了模型必须真的随请求发出（只在选了具体模型时才带，空串=该站默认）。
  assert.match(body, /\.\.\.\(col\.modelId \? \{ model: col\.modelId \} : \{\}\)/,
    '选中的模型必须随 api(chat) 下发 —— 选了不发就是假功能');

  // ④ 后端已有该形参：本改动**不新增后端路径**（用户要求别动真实桥接 web 端）。
  const wc = fs.readFileSync(path.join(root, 'lib', 'web-control.js'), 'utf8');
  assert.match(wc, /sendTurn\(sessionKey, promptText, \{ fresh, model: body\?\.model \}\)/,
    'POST chat 必须本来就把 body.model 交给 sendTurn（本改动只接线，不改后端）');

  // 换站点必须清掉模型（模型清单按站点分组，留着旧 id 会发不动）。
  assert.match(body, /const setColSite = \(key, siteId\) => \{[\s\S]{0,200}?modelId: ''/,
    '换站点必须一并清空 modelId —— 否则会把 A 站的模型发给 B 站');
  // 换模型**不清会话**：同一会话里切模型是合理用法，且「同上下文比较两个模型」正需要它。
  const setModel = body.slice(body.indexOf('const setColModel = '), body.indexOf('const setColModel = ') + 400);
  assert.ok(!/sessionKey: ''|messages: \[\]/.test(setModel),
    '换模型不得清空会话或消息 —— 否则「同一段上下文下比较两个模型」这个用法就没了');
});

/**
 * ★ 0.19.29（round2 的第三条「披露」）：产出落盘必须**用户看得见**。
 *
 * 两轮思考的结论是：本插件把每列产出写进 `.hwb/cols/<键>/`（围栏见 `column-fs.js`），
 * 而那个目录**在磁盘上、界面上看不见**。只说「不撒谎」不够 —— 一个用户无从核对的
 * 事实，与没有这个事实几乎等价。因此披露必须三跳齐全：
 *
 *   ① 服务端 `POST chat` 把落盘读数放进响应（`artifacts`）；
 *   ② 客户端 `sendCol` 把它记到**本列**（不是全局、不是丢掉）；
 *   ③ 渲染处把它透出（`title` 给完整路径，行内给「已存」标记）。
 *
 * 只钉其中一跳的话，另外两跳断掉照样全绿（本仓库记过多次的「三跳只钉一跳」）。
 */
test('★ 0.19.29 Team：产出落盘必须「服务端返回 → 客户端记录 → 用户看得见」三跳齐全', () => {
  const raw = clientSrc();
  const body = compareBody(raw);

  // 第一跳：服务端必须把落盘读数放进响应。
  const wc = fs.readFileSync(path.join(root, 'lib', 'web-control.js'), 'utf8');
  const chatBlock = wc.slice(wc.indexOf("'POST chat'"), wc.indexOf('  };\n\n  // ── `status`'));
  assert.match(chatBlock, /saveColumnReply\(body\?\.columnContext, taskRootOf\(body\), reply, sessionKey\)/,
    'POST chat 必须真的落盘并拿到读数');
  assert.match(chatBlock, /\.\.\.\(artifacts \? \{ artifacts \} : \{\}\)/,
    '落盘读数必须随响应透出（不透出 ⇒ 用户永远不知道产出在哪）');

  // 第二跳：客户端必须把读数记到**本列**。
  const sendFn = body.slice(body.indexOf('const sendCol = '));
  assert.match(sendFn, /const artifactDir = ok \? String\(res\?\.artifacts\?\.dir \|\| ''\) : ''/,
    'sendCol 必须读取 res.artifacts.dir（读到却不用 = 白读）');
  assert.match(sendFn, /artifactDir: artifactDir \|\| c\.artifactDir \|\| ''/,
    '必须把落盘目录记进本列，且失败轮不清掉上一轮已知的目录');

  // 第三跳：渲染处必须真的透出（否则「记录了」等于没记录）。
  const mapBody = body.slice(body.indexOf('cols.map('));
  assert.match(mapBody, /title: c\.artifactDir/, '必须把完整目录放进 title（hover 与读屏都能读到）');
  assert.match(mapBody, /c\.artifactDir \? ' · 已存' : ''/, '行内必须有「已存」标记（用户扫一眼就知道）');

  // 列对象形状一致：初始三列与 addCol 都必须带 artifactDir，
  // 否则「加了列才发现读到 undefined」。
  const initCount = (body.match(/artifactDir: ''/g) || []).length;
  assert.ok(initCount >= 4, '初始三列 + 加列路径都必须带 artifactDir，实际=' + initCount);
});

/**
 * ★ 0.19.29（用户第 3 点）：列宽上下限必须来自官方常量，且放不下时用左右按钮切换。
 *
 * 用户原话（逐字）：「然后会话框最小就是右侧和左侧栏目拉到最小距离，多出来的别的列框
 * 通过点击居中中心左右的左右按钮进行切换视角--注意适配官方UI，然后最大一样最多是左右
 * tab 最大距离，不够显示就显示左右框点击左右切换--然后 3 个会话宽度同步」
 *
 * 以及他对「自适应」的明确否认：「我没有让你随着左右栏自适应啊！我只让你看左右栏导致
 * 切换按钮的位置以及上下限」—— 因此这里同时钉住「上下限取自官方常量」与
 * 「列宽不是左右栏的实时函数」两件事。
 */
test('★ 0.19.29 Team：列宽上下限取自官方常量，放不下时左右切换（三条同步）', () => {
  const raw = clientSrc();
  const body = compareBody(raw);

  // ── 上下限（用户 0.19.29 澄清后的方向）──────────────────────────────────
  //
  // 用户原话：「下限 = 中间区**最窄**，上限 = 官方会话的默认完整最宽」。
  // 我第一版把上限写成「左栏最窄 + 右栏最宽」，实测**站不住**：官方右栏上限是
  // viewport×0.7（1440 下右栏最宽 1008），中间区只剩 168px，比下限还小 ⇒ 上下限
  // 整体翻转、列宽被夹成恒定小值、切换按钮永不出现。这条判据就是那次修正的钉子。
  for (const [name, value] of [
    ['SIDEBAR_MAX', 420], ['RIGHTBAR_MIN', 300],
    ['OFFICIAL_CONTENT_MAX', 920], ['OFFICIAL_CARD_PAD', 32],
  ]) {
    assert.ok(new RegExp('const ' + name + ' = ' + String(value).replace('.', '\\.') + ';').test(body),
      name + ' 必须逐字等于官方常量 ' + value + '（来自 ui-layout 与 ConversationRoot）');
  }
  // 下限 = 左栏拉最宽 + 右栏拉最窄 ⇒ 中间区最窄。
  assert.match(body, /viewportW - SIDEBAR_MAX - RIGHTBAR_MIN/,
    '列宽下限必须由「左栏最宽 + 右栏最窄」推出（= 中间区最窄）');
  // 上限 = 官方完整最宽 = 内容 920 + 卡片余量 32。
  assert.match(body, /OFFICIAL_CONTENT_MAX \+ OFFICIAL_CARD_PAD/,
    '列宽上限必须是官方完整最宽（内容 920 + 卡片余量 32）');
  // 旧的反向公式必须消失 —— 留着它就是把那次修正退回去。
  assert.ok(!/SIDEBAR_MIN|RIGHTBAR_MAX_RATIO/.test(body),
    '不得再出现「左栏最窄 + 右栏最宽」那套反向常量（那是被实测否掉的第一版）');
  // 夹取顺序：上限赢（视口很大时下限会超过上限，此时「不超过官方最宽」是硬约束）。
  assert.match(body, /Math\.min\(colWidthMax, Math\.max\(colWidthMin, officialDefault\)\)/,
    '夹取顺序必须是 min(上限, max(下限, 默认)) —— 让上限在冲突时赢');

  // ── 默认值 = 官方对话的默认内容宽（用户答「官方对话的默认值！」）──────────────
  assert.match(body, /Math\.min\(OFFICIAL_CONTENT_MAX, Math\.max\(680, Math\.round\(viewportW \* 0\.64\)\)\)/,
    '默认列宽必须用官方 ConversationRoot 的默认内容宽公式 clamp(680, column*0.64, 920)');

  // ── 三条同步：宽度是**一个值**给到每一列（结构上不可能某列比别列宽）──────────
  assert.match(raw, /\.hwb-compare-columns\{[^}]*grid-auto-columns:var\(--hwb-col-width/,
    '列宽必须由同一个 --hwb-col-width 统一给 —— 「3 个会话宽度同步」的落点');
  assert.match(body, /'--hwb-col-width': colWidth \+ 'px'/,
    '视图必须把这个算出**一个**宽度发到 CSS（而不是每列各算一个）');

  // ── 放不下时出现左右按钮，且整列平移（永不半列）────────────────────────────
  assert.match(body, /cols\.length > visible && h\('button'/, '放不下时才出现切换按钮（放得下画两个点不动的箭头是噪音）');
  assert.match(body, /const visible = Math\.max\(1, Math\.floor\(\(viewportW \+ COL_GAP\) \/ \(colWidth \+ COL_GAP\)\)\)/,
    '一屏放得下几列必须按**整数列**算（否则会出现半列）');
  // 用 indexOf 而不是正则：这段字面量里括号与加号密集，正则要过两层转义，
  // 极易写成本仓库反复记过的「看起来对、实际匹配不到」的空转判据。
  assert.ok(body.includes("transform: 'translateX(' + (-first * (colWidth + COL_GAP)) + 'px)'"),
    '平移量必须是整列宽 + 列间距（用户：「优先跳转下一列让列左边对齐左端」）');
  // 末列贴右端放不下时退到「刚好全放下」，两个方向都要能到头。
  assert.match(body, /const maxFirst = Math\.max\(0, cols\.length - visible\)/, '必须有平移上界（末列贴边时退化到刚好全放下）');
  assert.match(body, /disabled: !canPanLeft/, '到最左时左按钮必须置灰');
  assert.match(body, /disabled: !canPanRight/, '到最右时右按钮必须置灰');
  // 按钮位置按用户要求贴中间区左右边缘、垂直居中。
  assert.match(raw, /\.hwb-compare-pan\{position:absolute;top:50%;transform:translateY\(-50%\)/,
    '左右按钮必须绝对定位在中间区左右边缘并垂直居中');
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
test('★ 0.19.20 Team：每列一个独立对话框，不得再有「同时发送」（用户 Q5）', () => {
  const raw = compareBody(clientSrc());
  // 判据只看**去掉注释的代码**：下面这些说明里会逐字提到旧写法（含
  // `handleSendAll` / `pendingRef`），不去注释就会把「解释」当成「缺陷仍在」——
  // 这是本仓库反复踩到的坑（`client-render.test.mjs` 为此立过规矩）。
  // 另注意文件是 **CRLF**：按 `\r?\n` 切分，否则尾部 `\r` 会让 `$` 对不上、整行注释
  // 根本剥不掉（本项目记过的「空转」缺陷）。
  const body = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // ── 负判据：旧形态必须**整体**消失 ────────────────────────────────────────
  //
  // 用户 2026-09-26 原话（逐字）：「移除『并列多会话』里面的同时发送功能，
  // 然后尽可能将底部对话框变为三个，按照 dsh 风格分隔会话，3 者独立」。
  // 因此下面四样东西一个都不能留下——留任何一个，用户就会看到「还能同时发」。
  assert.ok(!/handleSendAll/.test(body), '不得再有 handleSendAll（那就是「同时发送」的本体）');
  assert.ok(!/同时发送/.test(body), '界面上不得再出现「同时发送」字样（措词也是契约）');
  // 共享的全局在途锁与全局发送态：它们正是「一列在跑、全体发不出去」的机制。
  assert.ok(!/const pendingRef = React\.useRef\(0\)/.test(body),
    '不得再有全局 pendingRef 在途计数器 —— 它的唯一职责是解锁那个共享按钮，共享按钮已删');
  assert.ok(!/const \[sending, setSending\]/.test(body),
    '不得再有全局 sending 态 —— 每列的锁必须由那一列自己的 status 派生');

  // ── 正判据①：每列一个对话框（三列 = 三个）──────────────────────────────
  //
  // 判据落在**渲染结构**上而不是「出现过 input」上：`hwb-col-composer` 是列内
  // 对话框的外层锚点。0.19.22 把它从「自绘 input + 按钮」换成**官方 composer 的
  // 复刻**（用户：「每个列上下宽度都全长，和官方一样……直接抄 dsh」），
  // 因此类名变了，但「每列一个、提交到本列、位置在列体之后」三条一字未改。
  const mapIdx = body.indexOf('cols.map(');
  assert.ok(mapIdx > 0, '渲染必须仍由 cols.map 驱动');
  const mapBody = body.slice(mapIdx);
  assert.match(mapBody, /className: 'hwb-col-composer'/, '每列内部必须有自己的对话框');
  assert.match(mapBody, /className: 'hwb-col-composer-input'/, '每列的对话框必须有文本面');
  assert.match(mapBody, /onSubmit: \(e\) => \{ e\.preventDefault\(\); sendCol\(c\.key\); \}/,
    '每列的 form 必须提交到**本列**（sendCol(c.key)）—— 提交到全局函数就是共享输入条的回潮');
  // 输入区的位置：必须在列体**之后**（底部），否则「底部对话框」这个名字就不成立。
  const bodyIdx = mapBody.indexOf("className: 'hwb-compare-col-body'");
  const inputIdx = mapBody.indexOf("className: 'hwb-col-composer'");
  assert.ok(bodyIdx > 0 && inputIdx > bodyIdx,
    '每列的对话框必须渲染在列体之后（= 视觉上的底部）');

  // ── 正判据②：锁是**逐列**的 ────────────────────────────────────────────
  //
  // 这一条是 0.19.0 那个「按钮永久锁死」缺陷的结构性解药：只要锁由列自己的
  // status 派生，就不存在「忘了减计数器」这种可能。
  assert.match(body, /const isColSending = \(c\) => c\.status === 'streaming';/,
    '必须有按列判在途的谓词（单一事实来源 = 列自己的 status）');
  assert.match(body, /disabled: isColSending\(c\) \|\| !String\(c\.input \|\| ''\)\.trim\(\)/,
    '发送按钮的 disabled 必须只看本列：在途 或 输入为空');

  // ── 正判据③：hooks 仍在组件体顶层 ──────────────────────────────────────
  //
  // 0.19.0 第四轮自查抓到过的阻断级缺陷（hooks 写进事件处理器 → Invalid hook call）
  // 与本次改动无关但同样是这块代码的地雷，因此保留按**位置**的判据。
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
  assert.equal(depthAt(/const \[quote, setQuote\] = React\.useState/), 1,
    'quote 必须声明在组件体顶层（花括号深度 1）');
  assert.equal(depthAt(/const sendCol = \(colKey\) =>/), 1,
    'sendCol 是组件体顶层的函数定义（对照）');
  assert.equal(depthAt(/const chatCall = /), -1, '不得再出现 chatCall 之类的中转变量（对照，防判据漂移）');
});

/**
 * ★ 0.19.20：引用是**跨列**的（用户 Q2 + Q5 的交汇点）。
 *
 * 用户要的两件事在这里合流：
 *   · Q2「完整实现引用会话内容」——引用要能把一段已有回复带进下一轮提问；
 *   · Q5「选定一个模型进行主要审查」——探索列的产出要能喂给主审列。
 *
 * 没有这条通路，三框就只是三个并排的聊天窗口，而不是「互不影响的方案探索 +
 * 统一审查」。判据因此落在**引用槽是全局的**这一点上：挂在某一列里的引用
 * 传不到别的列，功能等于没做。
 */
/**
 * ★ 0.19.22：并列多会话的**布局与对话框照抄官方**（用户 2026-09-26 原话）。
 *
 * 用户原话（逐字）：
 *   「参考原生的对话框完成并列会话的设计而不是现在单独画三个框还被下面原生的挤了，
 *     直接抄 dsh」「每个列都能够做到上下宽度都全长和对话中的官方一样」
 *
 * 拆成两条可验证的判据，缺一即回到用户报的那个画面：
 *
 *   ① **不再被下面原生的挤** —— 视图根节点必须声明官方协议
 *      `data-conversation-composer-overlay`（官方轨迹视图用的同一条属性），
 *      并**且**在本视图挂载期间让官方那个属于主会话的对话框座位让位
 *      （`:has(.hwb-compare-view)`）。旧版 `.hwb-compare-view{height:100%}` 在
 *      滚动容器里 = 「占满一屏」＋「官方对话框再加一截」，三列因此被挤掉一截。
 *   ② **对话框是官方的复刻，不是自绘** —— 卡片必须是 radius 22px +
 *      `--dsw-specific-input-major` + `--dsw-elevation-soft`（逐字取自官方
 *      `.uV2eYG_card`），发送按钮必须是 34px 圆形 + `--dsw-alias-button-info-fill`。
 *      这一条防的是「把类名改了、样式没抄」这种假修复。
 *
 * 反向验证：把根节点那条属性删掉 → ①红；把卡片圆角改回 8px → ②红。
 */
test('★ 0.19.22 Team：布局与对话框必须照抄官方（不被原生挤 + 复刻 composer）', () => {
  const raw = clientSrc();
  const body = compareBody(raw);

  // ── ① 布局：官方整屏协议 + 官方对话框让位 ────────────────────────────────
  assert.match(body, /'data-conversation-composer-overlay': ''/,
    '视图根节点必须声明官方的 data-conversation-composer-overlay，否则 .viewArea 拿不到确定高度');
  const css = raw;   // CSS 是 client.cjs 里的字符串字面量：直接在源码上断言
                     // （与 0.18.0 那条「列数不得写死」判据同一手法；本组规则
                     //   里没有转义引号，因此逐字可匹配）
  assert.match(css, /\[data-conversation-scroll\]:has\(\.hwb-compare-view\)>\[data-composer-seat\]\{display:none\}/,
    '本视图挂载期间必须让官方对话框座位让位（否则最底部会再叠第四个框 = 用户说的「被挤了」）');
  // 让位规则必须是**局部**的：只在本视图存在时命中，切回官方 Chat 视图立即失效。
  assert.ok(!/^\[data-composer-seat\]\{display:none\}/m.test(css),
    '不得无条件隐藏官方对话框（那会连主会话都发不出消息）');
  // 旧写法必须消失：`height:100%` 在滚动容器里正是「占满一屏还要再加一截」的来源。
  assert.match(css, /\.hwb-compare-view\{[^}]*flex:1 1 auto[^}]*min-height:0[^}]*overflow:hidden/,
    '.hwb-compare-view 必须是 flex:1 1 auto + min-height:0 + overflow:hidden（确定高度、内部滚动）');
  assert.ok(!/\.hwb-compare-view\{[^}]*height:100%/.test(css),
    '不得再用 height:100%（在滚动容器里它会和官方对话框的高度相加，导致三列被挤）');
  // 列体要能真正滚动：flex 子项缺 min-height:0 时 overflow-y:auto 永不触发。
  assert.match(css, /\.hwb-compare-col-body\{[^}]*min-height:0[^}]*overflow-y:auto/,
    '.hwb-compare-col-body 必须 min-height:0 + overflow-y:auto（否则长回复把列撑破）');

  // ── ② 对话框：官方 composer 的刻度逐条对上 ──────────────────────────────
  assert.match(css, /\.hwb-col-composer-card\{[^}]*border-radius:22px/,
    '卡片圆角必须 22px（官方 .uV2eYG_card）');
  assert.match(css, /\.hwb-col-composer-card\{[^}]*background:var\(--dsw-specific-input-major/,
    '卡片底色必须用官方的 --dsw-specific-input-major');
  assert.match(css, /\.hwb-col-composer-card\{[^}]*box-shadow:var\(--dsw-elevation-soft/,
    '卡片投影必须用官方的 --dsw-elevation-soft');
  assert.match(css, /\.hwb-col-composer-input\{[^}]*min-height:36px[^}]*max-height:var\(--dsh-composer-text-max-height/,
    '文本面必须 36px 起、以官方的 --dsh-composer-text-max-height 封顶');
  assert.match(css, /\.hwb-col-composer-send\{[^}]*width:34px;height:34px[^}]*border-radius:999px[^}]*background:var\(--dsw-alias-button-info-fill/,
    '发送按钮必须是官方那枚 34px 圆形主按钮');
  // 三列的对话框必须**各一个**（用户要的 3 者独立不变），而不是合成一个。
  const mapBody = body.slice(body.indexOf('cols.map('));
  assert.equal((mapBody.match(/className: 'hwb-col-composer'/g) || []).length, 1,
    '对话框必须渲染在 cols.map 内部（一次渲染 × 每列一份 = 三份）');
  assert.ok(!/hw[b]-compare-input-bar/.test(body), '不得复活共享底栏');
});

test('★ 0.19.20 Team：引用槽必须跨列（探索列 → 主审列的那条通路）', () => {
  const body = compareBody(clientSrc());
  // 全局引用槽（组件体 state，不是列对象的字段）。
  assert.match(body, /const \[quote, setQuote\] = React\.useState\(null\)/,
    '引用槽必须是全局 state（挂在列对象里就传不到别的列）');
  // 每列每一条助手回复都有引用入口。
  assert.match(body, /const quoteFrom = \(col, msg\) =>/, '必须有「引用这条回复」的动作');
  assert.match(body, /m\.role === 'assistant' && c\.status !== 'streaming' && h\('button'/,
    '引用按钮只应出现在已完成的助手回复上（引用自己的提问或半截回复都没有意义）');
  // 引用随请求下发（第二跳：路由侧拼装，见下一条断言）。
  assert.match(body, /quote: q\.text, quoteFrom: q\.from/, '发送时必须把引用一起下发');
  // 引用是一次性的：用掉即清（隐式延续的状态最难排查）。
  assert.match(body, /const q = quote;[\s\S]{0,80}?setQuote\(null\);/,
    '引用必须在发出时清空 —— 否则下一轮会莫名其妙又带上同一段');

  // 第二跳：`POST chat` 必须真的把它拼进 prompt。
  const wc = fs.readFileSync(path.join(root, 'lib', 'web-control.js'), 'utf8');
  const chatBlock = wc.slice(wc.indexOf("'POST chat'"), wc.indexOf('  };\n\n  // ── `status`'));
  assert.ok(chatBlock.length > 0, '找不到 POST chat 的动作体（改名则本判据失效，需同步）');
  assert.match(chatBlock, /const quoteText = String\(body\?\.quote \|\| ''\)\.trim\(\)/,
    'POST chat 必须读取 quote 参数');
  assert.match(chatBlock, /promptText/, '拼装后的 promptText 必须真的存在');
  assert.match(chatBlock, /sendTurn\(sessionKey, promptText,/,
    '必须把**拼装后**的文本发出去 —— 拼了却发原串就是假功能');
  // 截断规则：引用长回复会吃掉上下文预算，必须有上限。
  assert.match(chatBlock, /QUOTE_LIMIT = 4000/, '引用必须有长度上限（否则一次引用就顶掉大半预算）');
});

/**
 * ★ 0.19.20：主审列必须**全局唯一**，且可改选。
 *
 * 用户原话（2026-09-26）：「怎么做到选定一个模型进行主要审查？」
 * 答案是一个唯一的主审位 + 一个显式的「设为主审」动作。若允许多个主审，
 * 「主要审查」就没有出口；若不可改选，用户第一列选错了就再也没有退路。
 */
test('★ 0.19.20 Team：主审列全局唯一且可改选', () => {
  const body = compareBody(clientSrc());
  // 唯一性：设某列为主审时，其余列一律降为 explore。
  assert.match(body, /const setReviewCol = \(key\) => \{[\s\S]{0,160}?role: c\.key === key \? 'review' : 'explore'/,
    '设为主审必须把其余列降为 explore —— 否则会出现多个主审，「主要审查」没有出口');
  // 初始态必须**恰好有一个**主审（否则用户一进来就没有审查出口）。
  const initialReview = (body.match(/role: 'review'/g) || []).length;
  assert.equal(initialReview, 1,
    '初始列状态里必须恰好有一个 role 为 review 的列，实际=' + initialReview);
  // 可改选：非主审列上必须有「设为主审」入口。
  assert.match(body, /onClick: \(\) => setReviewCol\(c\.key\)/, '非主审列必须能一键改选为主审');
  // 可见性：主审身份要看得见（用户要能一眼看出审查落在哪个模型上）。
  //
  // 0.19.29：头部那行「主审：X」随列头一起删除（用户第 1 点「上方不必要占用位置」），
  // 主审身份改由**每列工具栏里的极小徽标** + 该列自己的站点下拉共同表达 ——
  // 徽标说「这列是主审」，下拉说「主审落在哪个站点」。判据因此跟着能力搬家，
  // 而不是把这条护栏删掉（删掉它 = 主审变成不可见，那是功能倒退）。
  assert.match(body, /const reviewCol = cols\.find\(\(c\) => c\.role === 'review'\)/, '必须能取出当前主审列');
  assert.match(body, /className: 'hwb-col-composer-badge review'/,
    '主审列的徽标必须可见 —— 用户要能一眼看出审查落在哪一列');
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
