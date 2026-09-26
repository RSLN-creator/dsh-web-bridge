// 确定性离线复现：GLM codeblock 传输下**连续多个调用**之间，上一个调用的
// **闭合围栏**被当正文外发，形成 `\n```\n\n` 这种纯围栏文本块（用户报的「正文有空白还有乱码」）。
//
// 必须用 deepseek 模型：只有 deepseek 槽会用 config.driver 注入的桩驱动；
// 其它站点（glm/zai/...）会真的去开浏览器打真机（第一次跑就踩到了，已记）。
import { apply } from '../package/dsh-webcode-bridge/lib/index.js';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const TOOLS = [
  { name: 'todo_write', description: 't', parameters: { type: 'object', properties: { todos: { type: 'array' } }, required: ['todos'] } },
  { name: 'pwsh', description: 'p', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command', 'description'] } },
];

// 网页形态：散文 + 三个各自带围栏的调用。每个调用形如
//   ```json\n{...}\n```\n\n
const CALL = (name, args) => '```json\n' + JSON.stringify({ mcp_action: 'call', name, arguments: args }) + '\n```\n\n';
const REPLY =
  '收到。这是一个组合任务，我先建立任务清单。\n\n'
  + CALL('todo_write', { todos: [{ content: 'a', status: 'in_progress' }] })
  + CALL('pwsh', { command: 'git status --short', description: 'Show git status' })
  + CALL('pwsh', { command: 'git log --oneline -5', description: 'Show log' });

let adapter;
const dispose = apply(
  { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null },
  {
    port: 0, requireConsent: false,
    driver: {
      status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
      // 逐字符喂增量：最坏的切分，逼出全部边界情形。
      sendTurn: async (key, prompt, opts) => { for (const ch of REPLY) opts.onDelta?.(ch); return { text: null }; },
      sendPrompt: async (prompt, opts) => { for (const ch of REPLY) opts.onDelta?.(ch); return { text: null }; },
    },
  },
);

const say = console.log;
try {
  const chunks = [];
  for await (const c of adapter.stream({
    sessionId: 'probe-fence-leak2', model: 'deepseek:deepseek', tools: TOOLS,
    messages: [user('做事')],
  })) chunks.push(c);

  const deltas = chunks.filter((c) => c.type === 'text-delta').map((d) => d.text);
  const joined = deltas.join('');
  say('=== text-delta 条数: ' + deltas.length + ' ===');
  deltas.forEach((t, i) => say(`  [${i}] ${JSON.stringify(t)}`));
  say('\n=== 拼接后的正文 ===');
  say(JSON.stringify(joined));
  say('\n=== 是否含围栏残渣 ===');
  say('  含 "```": ' + joined.includes('```'));
  const fenceOnlyChunks = deltas.filter((t) => /^[\s`]*$/.test(t) && t.includes('`'));
  say('  纯围栏/空白 delta 条数: ' + fenceOnlyChunks.length + ' → ' + JSON.stringify(fenceOnlyChunks));
  say('\n=== text 块 ===');
  chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'text').forEach((c, i) => say(`  [${i}] ${JSON.stringify(c.block.text)}`));
  say('\n=== 工具调用 ===');
  chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').forEach((c, i) => say(`  [${i}] ${c.block.name}`));
  say('\nfinish: ' + JSON.stringify(chunks.at(-1)));
} finally { await dispose(); }
