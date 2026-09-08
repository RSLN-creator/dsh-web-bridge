// 精确复刻 DSH GUI 路径:serializeFirstTurn 的真实格式(系统提示+工具+上下文)
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
console.log('prompt 长度:', prompt.length);
console.log('=== 前 400 字 ===');
console.log(prompt.slice(0, 400));
console.log('=== 后 400 字 ===');
console.log(prompt.slice(-400));
