// measure-deepseek-prompt.mjs — 量化 DeepSeek 首轮文本构成（2026-09-21 只读诊断）。
// 人为构造一套真实工具清单，序列化 DeepSeek 首轮，输出各部分字节数，定位长度瓶颈。
import { serializeFirstTurn, buildPreset, transportNoteFor, officialToolCallSkeletonFor } from '../lib/agent-preset.js';

const tools = [
  { name: 'read', description: 'Read files from the workspace into the conversation as text.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to read' } }, required: ['path'] } },
  { name: 'write', description: 'Create or overwrite a file at the given absolute path with the provided content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'shell', description: 'Run a system shell command and capture its output.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'search', description: 'Search the codebase for a keyword or symbol.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'present', description: 'Present a produced file to the user as a clickable artifact.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

const sys = 'You are a helpful assistant.';
const messages = [{ role: 'user', content: [{ type: 'text', text: '你好，请列出当前目录结构。' }] }];

const opts = { system: sys, tools, messages, siteId: 'deepseek' };
const full = serializeFirstTurn(opts);
const preset = buildPreset(opts);
const skeleton = officialToolCallSkeletonFor(tools);
const transport = transportNoteFor('deepseek', tools);

const seg = textOfBlocks(messages[0].content);
function textOfBlocks(b) { return (Array.isArray(b) ? b.map(x => x && x.text || '').join('') : String(b || '')); }

console.log('=== DeepSeek 首轮构成（字节数）===');
console.log('buildPreset(preset) length  :', preset.length);
console.log('  其中 工具调用格式+使用准则 段（tools 非空时并入 preset）');
console.log('transportNoteFor(length)    :', transport.length);
console.log('officialToolCallSkeleton    :', skeleton.length);
console.log('user 会话段                  :', seg.length);
console.log('---');
console.log('serializeFirstTurn 总长      :', full.length);
console.log('目标上限参考 49,284          :', '（49248/49284 报错现场）');
console.log('\n=== transport 里的语义句是否与 preset 重复（冗余候选）===');
// deepseekTransport 与 buildPreset deepseek 分支都讲了「竖线/▁/begin/end 逐字」，
// 以及「sep 之后完整 JSON」「不要 ```json 围栏」。这是候选重复。
console.log('transport 含 "标记必须逐字" :', transport.includes('标记必须逐字'));
console.log('transport 含 "不要加 ```json" :', transport.includes('不要加'));
console.log('preset   含 "标记必须逐字" :', preset.includes('标记必须逐字'));
console.log('preset   含 "不要加 ```json" :', preset.includes('不要加'));