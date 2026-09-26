// 逐字符复演 lib/index.js 流式循环里的「正文外发边界」判定，打印每一步的
// boundary / markerAt / proseLimit / safeEnd，定位**闭合围栏与围栏开头**是
// 在哪一步被当正文放出去的。
import { findProtocolStart, partialProtocolAt, normalizeOfficialToolCalls } from '../package/dsh-webcode-bridge/lib/agent-preset.js';

const PROSE_TAIL_CHARS = 8;
const CALL = (name, args) => '```json\n' + JSON.stringify({ mcp_action: 'call', name, arguments: args }) + '\n```\n\n';
const REPLY =
  '收到。这是一个组合任务，我先建立任务清单。\n\n'
  + CALL('todo_write', { todos: [{ content: 'a', status: 'in_progress' }] })
  + CALL('pwsh', { command: 'git status --short', description: 'Show git status' });

let acc = '';
let textSent = '';
let protocolFrom = 0;
let lastBoundary = -1;
const TOOLS = new Set(['todo_write', 'pwsh']);
const events = [];

for (const ch of REPLY) {
  acc += ch;
  const rest = findProtocolStart(acc, protocolFrom);
  const boundary = rest.index < 0 ? -1 : Math.max(rest.index, lastBoundary);
  const markerAt = partialProtocolAt(acc);
  const from = Math.max(textSent.length, protocolFrom);
  const tagAhead = rest.index >= 0 && /[<\uFF5C|]/.test(acc[rest.index]);
  const proseLimit = (rest.index >= 0 && rest.transport) ? boundary
    : (rest.index >= 0 && tagAhead) ? boundary
    : (markerAt >= 0 ? markerAt : Math.max(0, acc.length - PROSE_TAIL_CHARS));
  const safeEnd = Math.max(from, proseLimit);
  const chunk = safeEnd > from ? acc.slice(from, safeEnd) : '';
  const tagOnly = /^[\s<>\/|\uFF5C]+$/.test(chunk);
  const hasTagChar = /[<>\/\uFF5C]/.test(chunk);
  const tagDebris = tagOnly && hasTagChar && chunk !== '<';
  let released = '';
  if (chunk && !tagDebris) { textSent = acc.slice(0, safeEnd); released = chunk; }
  else if (chunk) { textSent = acc.slice(0, safeEnd); released = `<debris:${JSON.stringify(chunk)}>`; }

  const suspicious = /`/.test(released) || (chunk && tagDebris);
  if (suspicious || events.length < 3) {
    events.push({ ch, accTail: JSON.stringify(acc.slice(-28)), index: rest.index, transport: rest.transport, markerAt, proseLimit, safeEnd, from, released });
  }
  if (rest.index >= 0 && /"arguments"\s*:/.test(acc.slice(rest.index, rest.index + 600))) lastBoundary = boundary;
}

console.log('=== 可疑步骤（release 里含反引号 / 被判残渣） ===');
for (const e of events) {
  console.log(`ch=${JSON.stringify(e.ch)} index=${e.index} transport=${e.transport} markerAt=${e.markerAt} proseLimit=${e.proseLimit} safeEnd=${e.safeEnd} from=${e.from}`);
  console.log(`    accTail=${e.accTail}`);
  console.log(`    released=${JSON.stringify(e.released)}`);
}

console.log('\n=== 最终正文 ===');
console.log(JSON.stringify(textSent));
