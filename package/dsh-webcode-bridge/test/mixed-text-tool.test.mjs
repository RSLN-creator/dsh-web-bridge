import { apply } from '../lib/index.js';

let adapter;
const driver = {
  status: () => ({}), close: async () => {},
  sendPrompt: async (prompt, opts) => {
    opts.onDelta('我先读一下。\n<tool_call>');
    opts.onDelta('{"mcp_action":"call","name":"read","purpose":"x","arguments":{"path":"PLAN.md"}}');
    opts.onDelta('</tool_call>');
    return { text: '我先读一下。\n<tool_call>{"mcp_action":"call","name":"read","purpose":"x","arguments":{"path":"PLAN.md"}}</tool_call>' };
  },
};
const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
try {
  const chunks = [];
  for await (const c of adapter.stream({ model: 'deepseek', tools: [{ name: 'read', parameters: {} }], messages: [{ role: 'user', content: '读 PLAN' }] })) chunks.push(c);
  console.log('types=', chunks.map(c => c.type).join(','));
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
  console.log('text=', JSON.stringify(text));
  const tool = chunks.find(c => c.type === 'tool-call-delta');
  console.log('tool=', tool?.name, tool?.argumentsDelta);
  const blockEnds = chunks.filter(c => c.type === 'block-end').map(c => c.block?.type);
  console.log('blockEnds=', blockEnds.join(','));
} finally { dispose(); }
