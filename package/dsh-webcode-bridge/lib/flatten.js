// flatten.js — turn upstream conversation state into a single web-chat prompt.
//
// The web AI (chat.deepseek.com) has no system role and no native tool-calls;
// v1 uses contextMode=fresh: every model call opens a new web chat and sends
// one flattened user message containing the whole transcript.

const TOOL_NOTE = '[This session may have local tools, but they are handled outside this chat. Do not ask to run anything; just answer in text.]';

function textOfBlocks(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

function roleLabel(role) {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Assistant';
  if (role === 'system') return 'System';
  return role || 'Unknown';
}

function toolSection(tools) {
  const lines = [];
  for (const t of tools) {
    if (!t || typeof t.name !== 'string') continue;
    const desc = typeof t.description === 'string' ? t.description.slice(0, 300) : '';
    let params = '';
    try { params = JSON.stringify(t.parameters ?? {}); } catch { params = '{}'; }
    lines.push(`- ${t.name}: ${desc} | 参数schema: ${params}`);
  }
  return [
    '[Available local tools]',
    ...lines,
    '[Tool call protocol]',
    '当且仅当需要调用上述工具时，你的整条回复必须只有一个 JSON 对象、不得有任何其它文字或代码块围栏：',
    '{"tool": "工具名", "arguments": {<参数对象>}}',
    '不需要调用工具时，直接用正常文字回复，禁止提到本协议。',
  ].join('\n');
}

/** Flatten DSH GenerateOptions (host message vocabulary) into one prompt. */
export function flattenGenerateOptions(options = {}) {
  const segs = [];
  if (typeof options.system === 'string' && options.system.trim()) {
    segs.push('[System instructions]\n' + options.system.trim());
  }
  const tools = Array.isArray(options.tools) ? options.tools : [];
  if (tools.length) {
    segs.push(toolSection(tools));
  }
  const messages = Array.isArray(options.messages) ? options.messages : [];
  if (messages.some((m) => m && Array.isArray(m.content) && m.content.some((b) => b && (b.type === 'tool-call' || b.type === 'tool-result')))) {
    segs.push(TOOL_NOTE);
  }
  segs.push('[Conversation so far]');
  for (const msg of messages) {
    if (!msg || !msg.role) continue;
    const label = roleLabel(msg.role);
    const text = textOfBlocks(msg.content);
    const extras = [];
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!b) continue;
        if (b.type === 'tool-call') extras.push(`${label} requested tool call ${b.name}(${b.arguments ?? ''})`);
        if (b.type === 'tool-result') extras.push(`Tool result ${b.toolCallId ?? ''}: ${textOfBlocks(b.content)}`);
      }
    }
    if (text) segs.push(`${label}: ${text}`);
    for (const e of extras) segs.push(`[${e}]`);
  }
  segs.push('Respond now as the Assistant: reply only with your next reply text to the latest User message.');
  return segs.join('\n\n');
}

/** Parse a strict {"tool": name, "arguments": {...}} reply per the tool protocol.
 *  Deliberately strict: the WHOLE reply (or a fenced block as the whole reply)
 *  must be a single JSON object. A per-line fallback scan would let injected
 *  example JSON inside ordinary prose trigger real local tool calls. */
export function parseToolCall(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const inner = fence[1].trim();
    const rest = (s.slice(0, fence.index) + s.slice(fence.index + fence[0].length)).trim();
    if (rest) return null; // prose around the fence → not a tool call
    s = inner;
  }
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj.tool === 'string') return { name: obj.tool, arguments: obj.arguments ?? {} };
  } catch {}
  return null;
}

export { textOfBlocks };

/** Flatten an OpenAI chat.messages array into one prompt (HTTP front path). */
export function flattenOpenAiMessages(messages = []) {
  const segs = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    const content = typeof m.content === 'string' ? m.content : textOfBlocks(m.content);
    if (!content) continue;
    segs.push(`${roleLabel(m.role)}: ${content}`);
  }
  segs.push('Respond now as the Assistant: reply only with your next reply text to the latest User message.');
  return segs.join('\n\n');
}
