// webcode-preset.test.mjs — 0.19.3 护栏：新增的「WebCode 真实模式」agent preset
// （展示名现为「wecode模式」，用户原话）。
//
// ## 用户指令（原话）
//
// 「我让你新增模式！保留必要webbridge需要调用工具！！以标准模式，ptc模式，简单模式
// 等等平级的！agents预设！适合webcode的真实模式：可以查看长对话里面调用和没调用的
// 真正工具！然后提示词优化懂不懂？真实学习参考已有的工程实践提示词！！」
//
// ## 这条护栏为什么必要
//
// 这个 preset 是**随包发布的 profile patch**（`cordis.patch.yml` 的第二段 insert）。
// patch 里的任何一处结构错误都会让整段 preset 定义激活失败——而失败方式是「模式列表里
// 少一项」，界面上看不出原因、只在启动日志里。所以断言必须钉在**结构**上：
//   ① 声明行的形状（id/name/config.id/order）与官方三个预设同型；
//   ② 删掉的入口确实是那些「真实会话里 0 次命中」的（不是随手删）；
//   ③ 留下的入口一个不少（删多了 = 静默砍能力，比删少了严重）；
//   ④ 引用的插件名**必须全部来自官方预设**——拼错一个包名就等于该模式装不起来；
//   ⑤ persona 的传输事实那句话在（这是本模式相对 standard 唯一的提示词改动）。
//
// ## 证据（本机真机读数，2026-09-23，scripts/session-read.mjs 多帧 zstd 全解）
//
// 303 份会话 / 817 轮 / 23,636 次工具调用；webcode 路由 15,296 次（64.7%）。
// webcode 真实工具目录 35 项，实际被调用 32 项；`workflow` 与 `subagent_fork`
// 在 23,636 次调用里命中 0 次。用桥自己的 buildPreset 差集法现算：
// 首轮教学 30,381 字符 → 26,264 字符（省 4,117，13.6%）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const patch = fs.readFileSync(path.join(repoRoot, 'cordis.patch.yml'), 'utf8');

/** 「真实会话里 0 次命中」的入口行：删它们是本模式存在的理由。 */
const DROPPED_ROWS = [
  'tool-subagent-fork',
  'tool-workflow',
];

/**
 * standard 里**本来就 disabled** 的行：本模式不复制它们。
 *
 * 与 {@link DROPPED_ROWS} 的区别是硬性的：那些是「用读数删掉的启用项」，
 * 这些在 standard 里就是 `disabled: true` ⇒ **不进提示词、不注册工具**，
 * 省略它们不改变能力面，也不需要任何读数背书。
 *
 * 0.19.51 更正：0.19.50 的这份清单曾把 `tool-subagent-codex` /
 * `tool-subagent-claude-code` / `workflow-ptc` / `tool-ralph` /
 * `tool-plugin-manager` 与上面两条混在一起，断言文案是「0 次命中所以删」——
 * 那对后五项**不是真的**（它们从未被本机读数评估过）。分表是为了让断言说的
 * 与事实一致：一个判据如果理由写错，下次就会有人照着错理由删东西。
 */
const DISABLED_IN_STANDARD_ROWS = [
  'tool-subagent-codex',
  'tool-subagent-claude-code',
  'tool-ralph',
  'tool-plugin-manager',
];

/**
 * `workflow-ptc`：随 `tool-workflow` 一起删的**服务提供者**，不是工具。
 *
 * 实测（0.2.0-rc.2）：`dsh-workflow` 定义服务缝 `ctx.workflowEngine`，
 * `workflow-ptc` 是它的执行提供者，消费者只有 `dsh-tool-workflow` /
 * `dsh-tool-ralph` / `workflow-ptc` 自己。前两者本模式都不启用 ⇒ 无消费者。
 * 它不注册模型可见工具，所以删它不改变能力面。
 */
const PROVIDER_ROWS = ['workflow-ptc'];

/** 必须留下的行（删多了就是静默砍能力）。 */
const KEPT_ROWS = [
  'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs',
  'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal',
  'plan-mode', 'compaction-basic', 'command-compact', 'tool-result-pruner',
  'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
  'tool-ask-user', 'tool-todo', 'tool-web', 'present', 'persona', 'agent-instructions',
  // 官方 0.2.1-alpha.1 给 standard 新增的两行，本模式**原样保留**（0.19.68（10-08 轮））：
  // `time-context` 不注册任何工具（只注入当前时间/已用时长），`tool-schedule` 注册的四个
  // 提醒工具是宿主真有的 ⇒ 都不增加「误调不存在工具」的面，没有读数支持删除它们。
  'time-context', 'tool-schedule',
];

/** 官方预设目录（找不到就跳过「包名必须来自官方」那一条，并在输出里说明）。 */
function officialPresetDir() {
  const dir = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules',
    '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets');
  return fs.existsSync(dir) ? dir : null;
}

/** 本模式里是否出现了某一行 `- id: <id>`。 */
function hasRow(id) {
  return new RegExp(`- id: ${id}\\b`).test(patch);
}

/**
 * 读出**装机版**官方 `standard.patch.yml` 的 `config.plugins` 行 id（含 disabled 行）。
 *
 * 为什么读 patch 文件而不是 `dsh --dump-config`：后者要 spawn 一个 dsh 进程，
 * 而本机 Node 里 `spawnSync` 调外部程序一律 `EPERM`（见 `doc/progress.md`
 * 「已知环境约束」）。测试里**绝不能**引入一个在本机恒失败的探测方式——
 * 那会让这条闸门变成永久 skip，看起来比谁都干净。读文件在两侧都成立。
 *
 * 解析刻意只从 `plugins:` 那一行**之后**开始：文件顶层还有一个 `- id: preset-standard`
 * 声明（缩进更浅），把它算进来会让差集里凭空多出一项「官方有而我们没有」
 * ——那正是本脚本第一版的样子（自测时抓到）。深度判据就是「缩进 ≥ plugins 的子项」。
 *
 * 找不到文件时返回 null，调用方据此 skip 并**在测试名里说明**（不静默假绿）。
 */
function officialStandardPluginIds() {
  return officialStandardBlocks().map((b) => b.id);
}

/** 同上，但返回每个 plugin 块的行 id + 是否 disabled（②c 要区分启用/停用）。 */
function officialStandardBlocks() {
  const dir = officialPresetDir();
  if (!dir) return null;
  const f = path.join(dir, 'standard.patch.yml');
  if (!fs.existsSync(f)) return null;
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*plugins:\s*$/.test(l));
  if (start === -1) return null;
  const blocks = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^(\s*)-\s*id:\s*(\S+)\s*$/);
    if (m) {
      if (current) blocks.push(current);
      current = { id: m[2], disabled: false };
      continue;
    }
    if (current && /^\s*disabled:\s*(true|!!js\b)/.test(line)) current.disabled = true;
  }
  if (current) blocks.push(current);
  return blocks;
}

test('① 声明行形状与官方预设同型（id/name/config.id/order）', () => {
  assert.match(patch, /- id: preset-webcode\b/, '声明行 id 必须稳定（它是 Loader 编辑地址）');
  assert.match(patch, /name: '@deepseek-ai\/dsh-agent-preset'/, '必须由官方 preset 插件声明');
  assert.match(patch, /^\s+id: webcode$/m, 'config.id 是会话保存的模式标识（与用户可见的模式名对应）');
  // `order` 必须是 5：官方 preset-cordis 占的是 4（0.2.0-rc.2 实测 standard=1 /
  // ptc=2 / minimal=3 / cordis=4），而 `order` 的语义是「Roster order」，同号两行
  // 的排序官方没有定义 ⇒ 撞号 = 花名册位置不确定。
  //
  // 这条断言 0.19.50 及以前写的是 `order: 4` 并配文案「平级第四项」——它把
  // **自己的一厢情愿**当成了事实：官方从来只有三个「标准族」预设，第四个位置
  // 早被 cordis 占了。断言必须钉住「不与任何官方预设撞号」，不是钉住某个字面数字。
  assert.match(patch, /^\s+order: 5$/m, '必须避开官方占用的 order（standard=1/ptc=2/minimal=3/cordis=4）');
  assert.match(patch, /^\s+name: wecode模式$/m, '展示名必须存在且逐字是「wecode模式」（用户原话），否则选择器里看不出它是什么');
});

test('①b 展示名与描述是面向用户的短声明（不是解释文档、不带统计数字）', () => {
  // 用户原话：「改为简短声明，而且非情况解释文档！面向用户的！！！」——旧描述把
  // 303 份会话 / 23,636 次调用这类台账写进了用户可见的一行，读起来像内部报告。
  const m = patch.match(/^\s+description: (.+)$/m);
  assert.ok(m, '描述必须存在——模式选择器里要有一句话说明它是干什么的');
  const desc = m[1].trim();
  assert.ok(!/\d/.test(desc), `描述里不得出现统计数字（台账属于注释，不属于用户文案）：${desc}`);
  assert.ok(desc.length <= 40, `描述要短到一眼读完（当前 ${desc.length} 字）：${desc}`);
});

test('② 用读数删掉的启用项确实不在本模式里', () => {
  for (const id of DROPPED_ROWS) {
    assert.ok(!new RegExp(`- id: ${id}\\b`).test(patch),
      `${id} 在 23,636 次真实调用里 0 次命中，不该再出现在本模式的工具面里`);
  }
});

test('②b standard 里 disabled 的行与随之删的提供者也不在本模式里', () => {
  for (const id of [...DISABLED_IN_STANDARD_ROWS, ...PROVIDER_ROWS]) {
    assert.ok(!new RegExp(`- id: ${id}\\b`).test(patch),
      `${id} 在 standard 里就是 disabled（或只是 tool-workflow 的服务提供者），省略它不改变能力面`);
  }
});

test('②c 官方 standard 的每一行都必须被交代：在本模式里，或在一份差集清单里（漂移闸门）', { skip: officialStandardBlocks() ? false : '找不到官方 standard 预设，跳过差集核对' }, () => {
  // 这条是本轮补的**机制**，补的正是 F2 暴露的那个洞。
  //
  // 0.19.50 及以前，本模式的注释写着「从 standard 逐字复制」但**没写版本**，
  // 也没有任何断言去读**当前装机的** standard。于是 0.2.0-rc.2 给 standard 加了
  // `workflow-ptc` / `tool-subagent-codex` / `tool-subagent-claude-code` /
  // `tool-plugin-manager` 之后：本模式既没有报错，也没有任何地方记录这件事，
  // 只有一条注释在说一句**当时为真、现在不完整**的话。
  //
  // 判据的形状刻意是「**每一行都必须被交代**」而不是「差集必须为空」：本模式
  // 存在的意义就是做减法。要钉的不是「一样」，而是「**每一处不一样都有名字**」。
  //
  // 遍历面刻意是**全部**官方行（含 disabled），不是只遍历启用的那些——只遍历启用项
  // 会让「本该在 disabled 清单里的一项被悄悄拿掉」变成无人判定（反向验证实测：
  // 那种改法在只遍历启用项的版本里是**全绿**的，见 ②e 的注释）。
  const blocks = officialStandardBlocks();
  const knownDelta = new Set([...DROPPED_ROWS, ...PROVIDER_ROWS, ...DISABLED_IN_STANDARD_ROWS]);
  const undocumented = blocks
    .map((b) => b.id)
    .filter((id) => !hasRow(id) && !knownDelta.has(id));
  assert.deepEqual(undocumented, [],
    `官方 standard 有这些行，而它们既不在本模式里、也不在「有意删/随之删/本就 disabled」`
    + ` 三份清单的任何一份里 ⇒ 本模式与 shipped standard 静默漂移了：${undocumented.join(', ')}`
    + `\n处置方式：要么把它按 standard 原样加进 cordis.patch.yml，要么给出本机读数并加进清单（连同理由）。`);
});

test('②d 三份差集清单里的每一项都真的不在本模式里（反向：清单不得虚报）', () => {
  // ②/②b 判的是「清单里的项确实删了」；这条判 ②c 用的清单本身**没有腐烂**：
  // 一项如果被重新加回本模式，②c 就会把它当成「已在册」而放过 ⇒ 必须在这里红。
  for (const id of [...DROPPED_ROWS, ...DISABLED_IN_STANDARD_ROWS, ...PROVIDER_ROWS]) {
    assert.ok(!hasRow(id), `差集清单声明 ${id} 不在本模式里，但它出现在 cordis.patch.yml 中——清单与事实不符`);
  }
});

test('②e 三份清单与官方 standard 的实际状态逐项相符（清单自身受检）', { skip: officialStandardBlocks() ? false : '找不到官方 standard 预设，跳过清单核对' }, () => {
  // 这条是反向验证逼出来的。②c 只遍历「官方**启用**的行」，所以
  // `DISABLED_IN_STANDARD_ROWS` 里的名字**从不参与** ②c 的判定——
  // 那份清单是一句**不受检的声明**：从里面删掉一项，②c 照样全绿。
  //
  // 实测做过这个反向验证（把 `tool-ralph` 从清单里移掉）：**11 项全绿**，
  // 闸门没有变红。那正是本仓库反复记过的失效形状——**一句没人验证的声明**
  // （同型案例见 `official-contract-audit.md` §4 的 token 存在性推断）。
  //
  // 因此这里把三份清单钉回官方 standard 的事实上：
  //   · DROPPED_ROWS / PROVIDER_ROWS —— 官方有，且是**启用**的（否则「有意删」这个理由不成立）；
  //   · DISABLED_IN_STANDARD_ROWS   —— 官方有，且**确实 disabled**（否则省略它就是砍能力）；
  //   · 三份都必须**真的存在于**官方 standard（名字写错 = 断言在判一个不存在的东西）。
  const byId = new Map(officialStandardBlocks().map((b) => [b.id, b]));

  for (const id of [...DROPPED_ROWS, ...PROVIDER_ROWS]) {
    const b = byId.get(id);
    assert.ok(b, `清单称 ${id} 是「官方 standard 里被有意删掉的入口」，但官方 standard 里没有这一项——清单在判一个不存在的东西`);
    assert.ok(!b.disabled, `${id} 在官方 standard 里其实是 disabled 的，那么「按读数有意删除」这个理由不成立（它本就不进提示词）`);
  }
  for (const id of DISABLED_IN_STANDARD_ROWS) {
    const b = byId.get(id);
    assert.ok(b, `清单称 ${id}「在 standard 里本就 disabled」，但官方 standard 里没有这一项`);
    assert.ok(b.disabled, `${id} 在官方 standard 里其实是**启用**的 ⇒ 省略它等于静默砍能力，必须改为按读数有意删除（并写明理由）`);
  }
});

test('③ 留下的行一个不少（删多了是静默砍能力）', () => {
  for (const id of KEPT_ROWS) {
    assert.ok(new RegExp(`- id: ${id}\\b`).test(patch), `${id} 必须留在 webcode 模式里`);
  }
});

test('④ 引用到的插件名必须全部出现在官方预设里（拼错包名 = 模式装不起来）', { skip: officialPresetDir() ? false : '找不到官方预设目录，跳过包名交叉核对' }, () => {
  const dir = officialPresetDir();
  const official = ['standard.patch.yml', 'ptc.patch.yml', 'minimal.patch.yml']
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const officialNames = new Set([...official.matchAll(/name: '([^']+)'/g)].map((m) => m[1]).filter((n) => n !== '@deepseek-ai/dsh-agent-preset'));
  const mine = [...patch.matchAll(/name: '([^']+)'/g)].map((m) => m[1])
    .filter((n) => n !== '@deepseek-ai/dsh-agent-preset' && n !== 'dsh-webcode-bridge');
  const unknown = mine.filter((n) => !officialNames.has(n) && n !== 'cordis:group');
  assert.deepEqual(unknown, [], `这些插件名不在官方三个预设里，包名很可能拼错：${unknown.join(', ')}`);
});

test('⑤ persona 的「传输事实」在，且 standard 的两行仍在（不是替换掉官方措辞）', () => {
  assert.match(patch, /You are a coding agent powered by the \{\{model\}\} model\./, 'standard 的第一句必须保留');
  assert.match(patch, /Your working directory is \{\{cwd\}\}\./, 'suffix 必须保留 standard 的原文');
  assert.match(patch, /parsed out of your visible reply text/, '必须写明工具调用是从正文文本里解析的');
  assert.match(patch, /never executed/, '必须写明「只存在于思考里的调用不会被执行」——这是真机最顽固的失效形状');
});

test('⑤b `!!js` 平台守卫与 plan-mode 官方 section 逐字保留（不得顺手丢配置）', () => {
  assert.match(patch, /disabled: !!js process\.platform === 'win32'/, 'bash 行必须保留 win32 守卫');
  assert.match(patch, /disabled: !!js process\.platform !== 'win32'/, 'pwsh 行必须保留非 win32 守卫');
  assert.match(patch, /You are in plan mode\. Stay in plan mode until exit_plan_mode succeeds/, 'plan-mode 的官方 section 必须逐字保留（丢掉它等于把计划模式规则换成默认）');
});

test('⑥ 桥自己的挂载行没被这次新增动过', () => {
  for (const needle of ['port: 8931', 'providerId: webcode', 'settingsNs: webcode', 'requireConsent: true']) {
    assert.ok(patch.includes(needle), `桥自身的挂载配置不得被预设改动波及：缺 ${needle}`);
  }
});
