import { serializeFirstTurn } from '../lib/agent-preset.js';
const tools = Array.from({ length: 27 }, (_, i) => ({ name: `tool_${i}`, description: `测试工具 ${i}`, parameters: { type: 'object', properties: { path: { type: 'string' } } } }));
const prompt = serializeFirstTurn({
  system: '你是一个编码智能体。',
  tools,
  messages: [
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'text', text: '你好！有什么可以帮你？' }] },
    { role: 'user', content: [{ type: 'text', text: '请用工具读取 package.json 告诉我版本号。' }] },
  ],
});
const body = JSON.stringify({ model: 'deepseek:deepseek', stream: false, messages: [{ role: 'user', content: prompt }] });
const t0 = Date.now();
const resp = await fetch('http://127.0.0.1:8931/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(200_000) });
const j = await resp.json();
console.log(`HTTP ${resp.status} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
console.log('text:', JSON.stringify(j?.choices?.[0]?.message?.content).slice(0, 300));
console.log('reasoning:', JSON.stringify(j?.choices?.[0]?.message?.reasoning_content).slice(0, 200));
