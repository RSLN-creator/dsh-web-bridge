// prompt-variants.test.mjs — 首轮提示词变体清单的护栏（0.14.0）。
//
// 用户诉求：「设置界面提示词应该默认就显示……有多的适配就可选择框选择列出」。
// 这条需求最容易做坏的地方是**协议漂移**：设置页为了显示而自己拼一份模板，
// 于是「设置里看到的」和「真正发出去的」变成两份会各自演化的文本。
// 本文件钉住三件事：
//   ① 变体的 text 必须来自 serializeFirstTurn 本身（改 extraPrompt 必须反映）；
//   ② glm 变体不得出现 <tool_call>，默认变体必须出现（否则教学立场就反了）；
//   ③ 两个变体必须真的不同，且站点 → 变体的映射与 agent-preset 的分支一致。
//
// 0.14.8 追加第四组（本文件此前对 experiments / EXPERIMENT_SPECS / trainExtraFor /
// slim **零覆盖**，见 prompt-variants.js:53-74 新增的实验变体表）：
//   ④ **默认路径零位移**——不传 experiments 时返回的变体文本必须与 0.14.7 逐字相同。
//      这是 agent-preset.js:30 与 :96-98 写下的声明（「默认路径（''）返回值与 0.14.7
//      逐字相同」「默认路径必须与 0.14.7 逐字相同」），但在此前**无人钉住**：注释里的
//      承诺没有断言托底，等于只是一个愿望。
//   ⑤ 实验变体必须带 experimental 标记、必须只出现在 experiments: true 时。
//   ⑥ slim 必须严格更短、reinstruct 的 trainNote 必须真的多出「关键约束重述」段。
//      这两条钉的是「实验变体不是空壳」：只声明 id 却没有实际作用的变体，会让基准实验
//      得出「两者没有差别」的**假结论**——那比没有这个变体更糟。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPromptVariants, buildSitePromptRows, variantIdForSite, VARIANT_SPECS, EXPERIMENT_SPECS } from '../lib/prompt-variants.js';
import { serializeFirstTurn, trainNoteFor, trainExtraFor } from '../lib/agent-preset.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.resolve(here, '..', p), 'utf8');

const TOOLS = [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];

test('三个适配分支都存在，且文本来自 serializeFirstTurn（不是另抄一份）', () => {
  const { variants } = buildPromptVariants({ tools: TOOLS });
  assert.deepEqual(variants.map((v) => v.id).sort(), ['default', 'glm', 'official']);
  const dflt = variants.find((v) => v.id === 'default');
  const glm = variants.find((v) => v.id === 'glm');
  const official = variants.find((v) => v.id === 'official');
  // 与真函数逐字一致：这是「设置里看到的 = 真正发出去的」的唯一保证。
  assert.equal(dflt.text, serializeFirstTurn({ messages: [], tools: TOOLS, siteId: undefined }));
  assert.equal(glm.text, serializeFirstTurn({ messages: [], tools: TOOLS, siteId: 'glm' }));
  // 0.16.25：official 分支的存在就是为了让 deepseek 显示**它真正会收到的**模板。
  assert.equal(official.text, serializeFirstTurn({ messages: [], tools: TOOLS, siteId: 'deepseek' }));
  assert.notEqual(dflt.text, glm.text, '两个分支的模板必须不同（否则下拉没有意义）');
  assert.notEqual(official.text, dflt.text, 'official 与 default 必须是两份文本（deepseek 不走标签形状）');
});

test('按网站逐行：每行的 text 必须是**该站点**实际会用的那一支（0.16.25）', () => {
  // 用户原话：「改为以网站为导向列出，每行一个网站，然后后面选择框选择已有协议
  // 中的一个」。这条钉的是「每行显示的是它自己的模板」——若前端拿同一份文本
  // 填所有行（或后端不按 siteId 现算），deepseek 行就会显示标签形状。
  const { sites, variants, toolsSource } = buildSitePromptRows({ tools: TOOLS });
  assert.equal(toolsSource, 'session');
  // 每个站点一行，站点集合与 providers 的 SITES 同源（不另维护一份清单）。
  assert.ok(sites.length >= 10, '应按站点逐行列出（实得 ' + sites.length + ' 行）');
  const ids = sites.map((s) => s.siteId);
  for (const sid of ['deepseek', 'glm', 'chatgpt', 'kimi', 'qwen', 'doubao', 'grok', 'claude', 'gemini', 'zai']) {
    assert.ok(ids.includes(sid), '缺少站点行 ' + sid);
  }
  const byId = new Map(variants.map((v) => [v.id, v]));
  for (const row of sites) {
    const expected = byId.get(row.variantId);
    assert.ok(expected, row.siteId + ' 的 variantId 不在协议清单里：' + row.variantId);
    // 关键：行的 text 必须与「该协议自己的 text」逐字相同，而不是复制别人的。
    assert.equal(row.text, expected.text, row.siteId + ' 行渲染的不是它自己那一支的模板');
    // 且必须与 serializeFirstTurn 按该站点现算的结果一致。
    assert.equal(row.text, serializeFirstTurn({ messages: [], tools: TOOLS, siteId: row.variantId === 'official' ? 'deepseek' : (row.variantId === 'glm' ? 'glm' : undefined) }),
      row.siteId + ' 行的模板与按站点现算的结果不一致');
  }
  // 三个立场各自落在正确的站点上。
  assert.equal(sites.find((s) => s.siteId === 'deepseek').variantId, 'official');
  assert.equal(sites.find((s) => s.siteId === 'glm').variantId, 'glm');
  assert.equal(sites.find((s) => s.siteId === 'kimi').variantId, 'default');
});

test('协议立场：glm 变体只教代码块并警告标签，默认变体教标签', () => {
  const { variants } = buildPromptVariants({ tools: TOOLS });
  const dflt = variants.find((v) => v.id === 'default');
  const glm = variants.find((v) => v.id === 'glm');
  assert.ok(dflt.text.includes('<tool_call>'), '默认分支必须教标签形状');
  assert.match(dflt.text, /必须使用 <tool_call>\{"mcp_action":"call"/);
  // glm：只教代码块，并把「标签会被网页抢走执行」说破。注意它**必须**提到
  // <tool_call> 这个词——那正是警告的内容；因此判据是「不得教标签形状」，
  // 而不是「不得出现该字符串」（present-preset.test.mjs 有同一口径）。
  assert.match(glm.text, /必须使用 ```json 代码块/);
  assert.match(glm.text, /unknown tool call/);
  assert.doesNotMatch(glm.text, /必须使用 <tool_call>\{"mcp_action"/);
  assert.ok(!/^\s*<tool_call>/m.test(glm.text), 'glm 变体不得把标签形状作为示例块给出');
  // 再教学提示（增量轮每 5 个工具结果重贴）也必须同立场，否则模型被来回拉。
  assert.equal(dflt.trainNote, trainNoteFor('default'));
  assert.equal(glm.trainNote, trainNoteFor('glm'));
  assert.doesNotMatch(glm.trainNote, /^\[系统提示\] 请保持工具调用格式：以 <tool_call>/);
  // 0.16.25：official（deepseek）立场 —— 教官方模板，且**不得**把它教成标签形状。
  // 这条是本版顺手修掉的那个错误的护栏：此前 deepseek 在设置页显示的是 default
  // （标签形状），而它真正收到的是官方模板。
  const official = variants.find((v) => v.id === 'official');
  assert.match(official.text, /官方工具调用格式/, 'official 分支必须教官方模板');
  assert.doesNotMatch(official.text, /必须使用 <tool_call>\{"mcp_action"/, 'official 分支不得教标签形状');
  assert.match(official.text, /必须逐字完整/, 'official 分支必须带上「标记逐字完整」的约束');
  // official 的再教学提示必须也走**官方**立场（trainNoteFor 按 siteId 分派：
  // 'deepseek' → trainNoteOfficialFor）。若这里退回 'default' 的标签形状再教学，
  // 模型每 5 个工具结果就会被拉回标签形状——首轮与再教学必须同立场。
  // 注意必须把 TOOLS 传进去：trainNoteFor 的官方分支用**会话真实工具名**做示例，
  // 不传工具表就退回占位符「工具名」——那样比较的是两份不同的东西。
  assert.equal(official.trainNote, trainNoteFor('deepseek', '', TOOLS), 'official 的再教学提示必须是官方立场');
  assert.notEqual(official.trainNote, trainNoteFor('default', '', TOOLS), 'official 不得复用标签形状的再教学提示');
});

test('全局指令体现在每个变体里，且保存后重新拉取即变', () => {
  const before = buildPromptVariants({ tools: TOOLS, extraPrompt: '' });
  const after = buildPromptVariants({ tools: TOOLS, extraPrompt: '始终用中文回答' });
  for (const v of after.variants) {
    assert.ok(v.text.includes('始终用中文回答'), v.id + ' 的模板必须包含全局指令');
  }
  for (const v of before.variants) {
    assert.ok(!v.text.includes('始终用中文回答'), v.id + ' 未设置时不得凭空出现');
  }
});

test('没有真实工具清单时用占位集并如实标注（不假装这是本会话的模板）', () => {
  const placeholder = buildPromptVariants({});
  assert.equal(placeholder.toolsSource, 'placeholder');
  assert.ok(placeholder.variants[0].text.includes('read'), '占位集也应当能渲染出工具段');
  const real = buildPromptVariants({ tools: TOOLS });
  assert.equal(real.toolsSource, 'session');
});

test('未注册 present 时不提 present；注册了才教（与预设同一护栏）', () => {
  const without = buildPromptVariants({ tools: TOOLS });
  for (const v of without.variants) assert.ok(!v.text.includes('present 让文件'), v.id + ' 未注册 present 却教了它');
  const withPresent = buildPromptVariants({ tools: [...TOOLS, { name: 'present', description: '声明交付物', parameters: { type: 'object' } }] });
  assert.ok(withPresent.variants.every((v) => v.text.includes('present')), '注册了 present 就必须教');
});

test('站点 → 变体的映射与 agent-preset 的分支一致（glm 代码块、deepseek 官方模板、其余标签）', () => {
  assert.equal(variantIdForSite('glm'), 'glm');
  // 0.16.25：deepseek 走官方模板。此前它被映射到 'default'（标签形状），
  // 而 agent-preset 的 serializeFirstTurn 里 siteId === 'deepseek' 走的是官方分支
  // ——设置页于是给 deepseek 显示了一份**它根本不会收到**的模板。
  assert.equal(variantIdForSite('deepseek'), 'official', 'deepseek 必须映射到官方模板分支');
  for (const sid of ['zai', 'kimi', 'qwen', 'doubao', 'chatgpt', 'claude', 'gemini', 'grok']) {
    assert.equal(variantIdForSite(sid), 'default', sid + ' 必须走默认（标签）分支');
  }
  // 变体表自身的立场声明不能自相矛盾
  for (const spec of VARIANT_SPECS) {
    assert.ok(spec.id && spec.label && spec.note, spec.id + ' 缺少展示字段');
    if (spec.only) assert.ok(!spec.excludes, spec.id + ' 不能同时用 only 与 excludes');
  }
});

test('prompt-variants.js 不得自己再写一份协议文本（工具协议只有一处定义）', () => {
  // doc/review-guide.md 的不可越界约束 #3：工具协议只有 lib/agent-preset.js 一处。
  // 本模块的职责只是「挑参数、调真函数」，因此它不得包含任何**教学文本**——
  // 一旦有人在这里另抄一份「必须使用 …」的格式说明，两份就会各自演化。
  //
  // 注意口径：模块里的 `note` 字段**允许**提到 <tool_call>（那是给用户看的
  // 行为说明，例如「该站点会抢走标签执行」），它是解释而不是第二份定义。
  // 判据因此是「不得出现教学句式」，而不是「不得出现这个词」。
  const src = read('lib/prompt-variants.js');
  assert.doesNotMatch(src, /必须使用 <tool_call>\{/, '出现了标签形状的教学文本（应在 agent-preset）');
  assert.doesNotMatch(src, /必须使用 ```json 代码块/, '出现了代码块形状的教学文本（应在 agent-preset）');
  assert.doesNotMatch(src, /\[本地工具传输协议\]/, '出现了协议段落标题（应在 agent-preset）');
  // 唯一真相必须被真正调用（而不是把 serializeFirstTurn 抄进来）。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  assert.match(code, /serializeFirstTurn\(/, '必须调用 agent-preset 的 serializeFirstTurn');
});

// ---------------------------------------------------------------------------
// 0.14.8：默认路径零位移 + 实验变体的有效性
// ---------------------------------------------------------------------------

/**
 * 零位移基线（**取自 0.14.7 工作树在下面这份输入上的实际输出**）。
 *
 * 输入：`{ messages: [], tools: [read], extraPrompt: 'BASE-EXTRA', system: 'BASE-SYS' }`
 * 取法：0.14.8 改 prompt-variants.js **之前**，在 package/dsh-webcode-bridge 下跑
 *   `serializeFirstTurn({messages:[], tools:TOOLS, extraPrompt:'BASE-EXTRA', system:'BASE-SYS'})`
 * 得到 1517 字符、sha256 2d97a53c9c6bba0877eb1342d7657247cdebd96022e735fd4b9c00a59d124cb4，
 * 原文逐字抄录如下。基线来自 **本机 Windows / Node v24.18.0** 的运行。
 *
 * 为什么整段逐字抄而不是只断言长度或哈希：这一层要防的是**任何**字符的位移
 * （多一个空格、少一个换行、准则由 4 条变 2 条），而长度与哈希只会在读断言失败时
 * 告诉你「变了」，不会告诉你「哪里变了」——那时改动者还得回滚重跑才能定位。
 * 逐字抄录让失败直接指出差异行。
 *
 * 注意这几件事**按设计不属于位移**，因此不出现在基线里：
 *   · platformNote 的 Node 版本号（agent-preset.js:71 用 process.version）随宿主 Node 变；
 *   · 工具清单本身的内容（基线固定用同一个 TOOLS）。
 * 基线体是 read 工具的固定文本，不含版本号。
 */
const ZERO_DRIFT_BASELINE = '[系统指令]\nBASE-SYS\n\n[全局指令]\nBASE-EXTRA\n\n# 可用本地工具\n'
  + '本次会话已为你接入 DeepSeek Harness (DSH) 本地工具网关。以下工具在你的运行环境之外真实执行：\n'
  + '运行环境：Windows（Node v24.18.0）。请按该平台的原生命令与路径书写习惯调用工具（如 Windows 用 PowerShell 语法与反斜杠路径），不要照搬其它平台的命令。\n'
  + '- read: 读文件\n  参数 schema: {"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}\n\n'
  + '# 工具调用格式\n需要调用工具时，任选下面一种格式输出（两种都能被识别，推荐格式 A）：\n'
  + '格式 A（推荐，以标签包裹）：\n<tool_call>\n{"mcp_action": "call", "name": "工具名", "purpose": "执行此操作的简要原因", "arguments": {"参数名": "值"}}\n</tool_call>\n'
  + '格式 B（```json 代码块）：\n```json\n{"mcp_action": "call", "name": "工具名", "purpose": "执行此操作的简要原因", "arguments": {"参数名": "值"}}\n```\n'
  + 'arguments 必须包含对应工具 schema 里 required 列出的每一个字段（例如 pwsh 必须同时给 command 和 description——description 是 5-10 词英文主动语态的命令概述）；purpose 只是执行原因备注，不能替代任何必填参数。\n'
  + '一次回复可以包含多个工具调用代码块，会按顺序执行；有依赖的调用请分多轮等待结果。\n'
  + '工具执行结果会作为用户消息自动回填给你，格式：{"mcp_action":"result","name":"…","status":"success","output":"…"}（失败为 "status":"error","error":"…"）。\n'
  + '重要：如果上一次工具调用因参数无效而失败，收到了 status:"error" 的结果，请在下一轮把参数修正后重新调用，不要因为失败而放弃工具改用猜测。\n'
  + '回填结果中的每一轮调用（含失败）都会编号出现；继续任务时请基于真实结果，不要虚构文件内容。\n'
  + '# 使用准则\n本会话的最终目标由用户的最新消息决定。除非用户只是闲聊/要观点，否则默认应优先通过真实工具获取数据，而不是凭记忆或设想作答。\n'
  + '判断是否需要调用工具，应看"这个回答是否依赖本机真实文件、目录或命令执行结果"——依赖就用，不依赖就不用；能用一次调用覆盖就不用多次。\n'
  + '没有真实依据时不要编造文件内容、命令输出或执行结果；卡住就明确说明缺什么信息。\n'
  + '不要为了显得勤快而堆砌无用调用，也不要为了省事而把本可使用真实工具解决的事强行用文字搪塞。\n\n'
  + '[会话开始]\n\n（用户未提供文字）\n\n\n[本地工具传输协议]\n'
  + '必须使用 <tool_call>{"mcp_action":"call","name":"实际工具名","arguments":{}}</tool_call> 发起工具调用。工具名和参数必须严格匹配上面的 schema。Calling:、伪代码、描述将要读取，都不会执行工具。一旦判定需要真实数据，就立即发起调用，输出调用后立即停止，等待真实工具结果，不得虚构文件内容；拿到全部所需结果后，直接给出简洁的最终答复收束本回合，不要继续无谓思考或重复推测。';

// 基线里**随宿主而变**的字段有两项，不是一项（见上）：
//   · platformNote 的 **OS 名**（agent-preset.js:70 按 process.platform 取 Windows/macOS/Linux）；
//   · platformNote 的 **Node 版本号**（agent-preset.js:71 用 process.version）。
//
// 这两项都不是模板契约，而是**同一份模板在不同宿主上的取值**。基线抄自 Windows/Node v24，
// 因此在 Linux/macOS 的 runner 上必须先把它们换成当前宿主的实际值，否则断言会在一个
// 与模板无关的地方红——这正是 2026-09-17 CI 上真实发生的事（Linux 腿报「文本发生了位移」，
// 差异行只有 `运行环境：Linux` vs `运行环境：Windows`）。
//
// **OS 名映射必须在这里独立写一份**，不能去调 lib 里的 platformNote()：那会让断言变成
// 「函数等于它自己」，模板被改坏也不会红。这是刻意的重复。
const BASELINE_INPUT = { extraPrompt: 'BASE-EXTRA', system: 'BASE-SYS' };

const hostOsName = process.platform === 'win32' ? 'Windows'
  : process.platform === 'darwin' ? 'macOS' : 'Linux';

/**
 * 把基线里随宿主变的两项换成当前宿主的实际值。
 * 只替换 `运行环境：<OS>（Node <ver>）` 这一处——其余每一个字符仍逐字比对。
 */
function baselineForThisHost() {
  const pattern = /运行环境：[^（]+（Node v[\d.]+）/;
  // 先确认模式**命中**：模式若因文案改动而失配，这里立刻报出来，
  // 而不是让下面那条断言在一个「根本没被归一化」的基线上给出难以理解的差异。
  //
  // 注意断言的是「命中了」，**不是**「替换后变了」——在 Windows + Node v24.18.0 上
  // 归一化结果与基线逐字相同（基线本来就是在这个宿主上抄的），那正是预期情形。
  assert.match(ZERO_DRIFT_BASELINE, pattern,
    '基线里的 platformNote 形状变了，本条测试的归一化模式已失配——先修模式，再谈模板位移');
  return ZERO_DRIFT_BASELINE.replace(pattern, `运行环境：${hostOsName}（Node ${process.version}）`);
}

/** 去掉随宿主变的两项，只留模板本身：用来把「宿主环境换了」与「模板被改了」分开。 */
const stripHost = (s) => s.replace(/运行环境：[^（]+（Node v[\d.]+）/, '运行环境：<OS>（Node vX）');

test('默认路径零位移：不传 experiments 时 default 变体文本与 0.14.7 逐字相同', () => {
  const { variants } = buildPromptVariants({ tools: TOOLS, ...BASELINE_INPUT });
  const dflt = variants.find((v) => v.id === 'default');
  // 逐字断言（整段）。失败时 assert.equal 会把差异直接摊在输出里。
  assert.equal(dflt.text, baselineForThisHost(), '默认变体文本发生了位移——这与 agent-preset.js:30/96-98 的声明冲突');
  // 去掉宿主相关的两项（OS 名 + Node 版本号）后再断言一次：
  // 这条把「宿主环境换了」与「模板被改了」分开——前者是预期的，后者才是回归。
  assert.equal(stripHost(dflt.text), stripHost(ZERO_DRIFT_BASELINE));
});

test('默认路径变体集合：三个生产分支，且都不带 experimental 标记', () => {
  const { variants } = buildPromptVariants({ tools: TOOLS });
  // 0.16.25：新增 official（deepseek 官方模板）。这不是「多加了一个候选」，
  // 而是把 deepseek 一直在用、却从没被列出的那一支补进清单——它本来就是生产分支。
  assert.deepEqual(variants.map((v) => v.id), ['default', 'glm', 'official']);
  for (const v of variants) assert.equal(v.experimental, false, v.id + ' 是生产分支，不得带 experimental 标记');
});

test('实验变体不得出现在默认返回里（反向断言）', () => {
  const { variants } = buildPromptVariants({ tools: TOOLS });
  const ids = variants.map((v) => v.id);
  for (const spec of EXPERIMENT_SPECS) {
    assert.ok(!ids.includes(spec.id), spec.id + ' 未转正就出现在默认路径了——这会悄悄改变真实会话的选路');
  }
});

test('experiments: true 时 reinstruct 与 slim 必须出现，且带 experimental: true', () => {
  const { variants } = buildPromptVariants({ tools: TOOLS, experiments: true });
  assert.deepEqual(variants.map((v) => v.id), ['default', 'glm', 'official', 'reinstruct', 'slim'], '实验变体附在生产分支之后，顺序固定');
  for (const v of variants) {
    const shouldBeExperimental = EXPERIMENT_SPECS.some((s) => s.id === v.id);
    assert.equal(v.experimental, shouldBeExperimental, v.id + ' 的 experimental 标记不对');
  }
  // 实验变体也必须走真函数（与生产分支同一口径，不允许另拼一份文本）。
  const slim = variants.find((v) => v.id === 'slim');
  assert.equal(slim.text, serializeFirstTurn({ messages: [], tools: TOOLS, slim: true, toolDescLimit: 800 }));
});

test('reinstruct 的 trainNote 必须真的多出「关键约束重述」段（不是空壳变体）', () => {
  // 空壳变体比没有变体更糟：基准实验会得出「两者没有差别」的假结论。
  const one = buildPromptVariants({ tools: TOOLS, experiments: true }).variants.find((v) => v.id === 'reinstruct');
  const base = buildPromptVariants({ tools: TOOLS }).variants.find((v) => v.id === 'default');
  assert.ok(one.trainNote.startsWith(base.trainNote), 'reinstruct 的 trainNote 必须是在默认再教学提示之后的**追加**');
  assert.ok(one.trainNote.length > base.trainNote.length, 'reinstruct 的 trainNote 必须严格更长');
  assert.ok(one.trainNote.includes('[关键约束重述]'), 'reinstruct 必须真的带上重述段落标题');
  // 与 trainExtraFor 的输出逐字一致 —— 「变体表声明的」与「实际发出去的」同源。
  assert.equal(one.trainNote, trainNoteFor('default', trainExtraFor('reinstruct', { hasPresent: TOOLS.some((t) => t && t.name === 'present') })));
  // 四条约束的关键片段：平台、必填、不得虚构。present 那条只在注册了 present 时才附。
  assert.ok(one.trainNote.includes('Windows'), 'reinstruct 必须重述平台约束');
  assert.ok(one.trainNote.includes('required'), 'reinstruct 必须重述必填字段约束');
  assert.ok(one.trainNote.includes('不得虚构'), 'reinstruct 必须重述不得虚构约束');
  assert.ok(!one.trainNote.includes('必须调 present'), '未注册 present 时不得重述 present 约束（会教模型调不存在的工具）');
  // 注册了 present 才附第 ④ 条。
  const withPresent = buildPromptVariants({ tools: [...TOOLS, { name: 'present', description: '声明交付物', parameters: { type: 'object' } }], experiments: true })
    .variants.find((v) => v.id === 'reinstruct');
  assert.ok(withPresent.trainNote.includes('必须调 present'), '注册了 present 就必须重述它');
  // trainExtraFor 本身：非 reinstruct 变体不得返回任何后缀（否则 slim 会被顺手改到）。
  assert.equal(trainExtraFor('slim'), '', 'slim 不得有 trainNote 后缀');
  assert.equal(trainExtraFor(undefined), '', '默认路径不得有 trainNote 后缀');
});

test('slim 变体首轮文本必须严格更短（对比同输入下的 default）', () => {
  const ex = buildPromptVariants({ tools: TOOLS, experiments: true }).variants;
  const dflt = ex.find((v) => v.id === 'default');
  const slim = ex.find((v) => v.id === 'slim');
  assert.ok(slim.text.length < dflt.text.length, `slim 必须严格更短（default=${dflt.text.length}, slim=${slim.text.length}）`);
  // 只短不够——还得确实是「砍掉了准则与工具描述上限」，不是把正文截断。
  assert.ok(!slim.text.includes('没有真实依据时不要编造'), 'slim 必须真的砍掉那两条使用准则');
  assert.ok(slim.text.includes('# 使用准则'), 'slim 不得把整段使用准则删空（那是截断不是精简）');
  assert.ok(slim.text.includes('<tool_call>'), 'slim 仍必须教调用协议（精简不等于不教协议）');
  // 工具描述上限 800：构造一条超长描述，确认 default 保留到 1200、slim 只保留到 800。
  const long = 'X'.repeat(1500);
  const withLong = (slimFlag) => buildPromptVariants({
    tools: [{ name: 'read', description: long, parameters: { type: 'object' } }],
    experiments: slimFlag,
  }).variants.find((v) => v.id === (slimFlag ? 'slim' : 'default')).text;
  assert.ok(withLong(false).includes('X'.repeat(1200)), '默认路径的工具描述上限仍是 1200');
  assert.ok(!withLong(false).includes('X'.repeat(1201)), '默认路径不得保留第 1201 个字符');
  assert.ok(withLong(true).includes('X'.repeat(800)), 'slim 的工具描述上限是 800');
  assert.ok(!withLong(true).includes('X'.repeat(801)), 'slim 不得保留第 801 个字符');
});
