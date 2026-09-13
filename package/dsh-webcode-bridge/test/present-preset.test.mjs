// present-preset.test.mjs — 「交付物必须以 present 呈现」的提示词护栏（0.13.0）。
//
// 症状（真机 2026-09-13）：一轮里写了 8 个文件、正文里把路径列成一串
// （`lib/a.js、lib/b.js…`），却**一次 present 都没调**。用户界面上那串路径是
// 纯文本、点不动；用户实际想看的是可点开的文件面板。
//
// 根因：预设提示词里从来没有教过「写完文件要调 present」。DSH 自己的系统提示词
// 会带这句，但网页桥走的是**自建预设**（agent-preset.js），DSH 的 persona 不一定
// 在场（极简模式只有一句「You are a helpful software engineer assistant.」），
// 于是这条行为要求整条丢失。
//
// 本文件锁三件事：
//   1. 本会话**注册了** present 时，预设必须教它（含「只在正文写路径不算交付」
//      这条关键澄清，以及「必须在最终答复之前调用」的时机约束）。
//   2. 本会话**没注册** present 时，一个字都不许提——否则模型会去调一个不存在的
//      工具，白费一轮并撞 TOOL_UNKNOWN。
//   3. 首轮的[本地工具传输协议]尾部也要提醒（收尾那一刻最容易忘），且两个站点
//      分支（glm 代码块形状 / 其它站点标签形状）都要带上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreset, serializeFirstTurn } from '../lib/agent-preset.js';

const pwshTool = { name: 'pwsh', description: 'Run a PowerShell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } };
const presentTool = { name: 'present', description: 'Declare existing files as final deliverables', parameters: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] } };

test('注册了 present：预设必须教「写完文件要 present，正文写路径不算交付」', () => {
  const preset = buildPreset({ system: 'sys', tools: [pwshTool, presentTool] });
  assert.match(preset, /# 交付物呈现（present）/, '必须有专门的交付物章节');
  assert.match(preset, /必须\*\*调用 present/, '必须写明这是强制动作');
  // 这条是整件事的**关键澄清**：模型普遍以为「我在回复里写了路径」就是交付了。
  assert.match(preset, /只在回复正文里写出文件路径\*\*不算\*\*交付/);
  // 可点开的面板 —— 用户能感知的差别
  assert.match(preset, /可点开的面板\/窗口/);
  assert.match(preset, /点不动/, '要说清不调 present 的后果是点不动的纯文本');
  // 时机：必须在最终答复之前
  assert.match(preset, /最终答复之前/);
  // 边界：别把只读参考文件也 present 了
  assert.match(preset, /只是读来当参考的文件/);
  // 落点：总结里那串「主要产物」路径必须对应 present 调用
  assert.match(preset, /主要产物/);
});

test('没注册 present：预设一个字都不许提（否则白调一轮撞 TOOL_UNKNOWN）', () => {
  const preset = buildPreset({ system: 'sys', tools: [pwshTool] });
  assert.doesNotMatch(preset, /# 交付物呈现/);
  assert.doesNotMatch(preset, /present/);
  assert.doesNotMatch(preset, /交付物/);
});

test('首轮协议尾部带 present 提醒，且两个站点分支都带', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: '做个东西' }] }];
  for (const siteId of ['deepseek', 'glm']) {
    const text = serializeFirstTurn({ siteId, tools: [pwshTool, presentTool], messages });
    assert.match(text, /\[本地工具传输协议\]/, siteId + ' 应有传输协议段');
    assert.match(text, /本会话可调 present/, siteId + ' 的协议尾部必须有 present 提醒');
    assert.match(text, /可点开的面板/, siteId + ' 要说清 present 的效果');
  }
  // 没注册时同样不许出现
  const without = serializeFirstTurn({ siteId: 'deepseek', tools: [pwshTool], messages });
  assert.doesNotMatch(without, /本会话可调 present/);
  // 一个工具都没有的会话也不该冒出 present 字样
  const noTools = serializeFirstTurn({ siteId: 'deepseek', tools: [], messages });
  assert.doesNotMatch(noTools, /present/);
});

test('present 提示不得破坏既有协议立场（glm 仍只教代码块、其它站点仍教标签）', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
  const glmText = serializeFirstTurn({ siteId: 'glm', tools: [pwshTool, presentTool], messages });
  // glm：只允许代码块形状，且必须警告标签会被网页抢走
  assert.match(glmText, /必须使用 ```json 代码块/);
  assert.match(glmText, /unknown tool call/);
  assert.doesNotMatch(glmText, /必须使用 <tool_call>\{"mcp_action"/);
  // 其它站点：主推标签形状
  const dsText = serializeFirstTurn({ siteId: 'deepseek', tools: [pwshTool, presentTool], messages });
  assert.match(dsText, /必须使用 <tool_call>\{"mcp_action":"call"/);
  // 两个分支都必须仍然讲清 required 字段（既有约束不能被挤掉）
  for (const t of [glmText, dsText]) assert.match(t, /required/);
});