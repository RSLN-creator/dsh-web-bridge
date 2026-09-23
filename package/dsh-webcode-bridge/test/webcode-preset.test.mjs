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
  'tool-subagent-codex',
  'tool-subagent-claude-code',
  'workflow-ptc',
  'tool-workflow',
  'tool-ralph',
  'tool-plugin-manager',
];

/** 必须留下的行（删多了就是静默砍能力）。 */
const KEPT_ROWS = [
  'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs',
  'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal',
  'plan-mode', 'compaction-basic', 'command-compact', 'tool-result-pruner',
  'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
  'tool-ask-user', 'tool-todo', 'tool-web', 'present', 'persona', 'agent-instructions',
];

/** 官方预设目录（找不到就跳过「包名必须来自官方」那一条，并在输出里说明）。 */
function officialPresetDir() {
  const dir = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules',
    '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets');
  return fs.existsSync(dir) ? dir : null;
}

test('① 声明行形状与官方三个预设同型（id/name/config.id/order）', () => {
  assert.match(patch, /- id: preset-webcode\b/, '声明行 id 必须稳定（它是 Loader 编辑地址）');
  assert.match(patch, /name: '@deepseek-ai\/dsh-agent-preset'/, '必须由官方 preset 插件声明');
  assert.match(patch, /^\s+id: webcode$/m, 'config.id 是会话保存的模式标识（与用户可见的模式名对应）');
  assert.match(patch, /^\s+order: 4$/m, '必须排在 standard(1)/ptc(2)/minimal(3) 之后，平级第四项');
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

test('② 删掉的行正是「真实会话 0 次命中」的那些', () => {
  for (const id of DROPPED_ROWS) {
    assert.ok(!new RegExp(`- id: ${id}\\b`).test(patch),
      `${id} 在 23,636 次真实调用里 0 次命中，不该再出现在本模式的工具面里`);
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
