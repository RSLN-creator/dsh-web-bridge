// flatten.js — turn upstream conversation state into a single web-chat prompt.
//
// 本文件现在只服务 OpenAI 兼容前端（openai.js）：把 chat.messages 拍平成一条
// 网页消息。DSH 会话路径走的是 agent-preset.js 的「首轮 + 增量」协议，
// 两者不要混用。
//
// 这里曾有 flattenGenerateOptions / parseToolCall 与配套的 [Available local
// tools] 协议——那是 v1 的整段重发方案，早已被 agent-preset.js 取代，
// 且没有任何调用点（index.js 只 import 未使用）。已删除，避免出现第二套
// 工具协议定义（见 doc/review-guide.md 的不可越界约束 3）。

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

/** Pull image attachments out of OpenAI chat.messages (HTTP front path).
 *  data: URL 内联解码；https URL 原样透出（由驱动侧决定是否抓取）。 */
const OPENAI_IMAGE_DATA = /^data:(image\/[\w.+-]+);base64,(.+)$/s;
export function imagesOfOpenAiMessages(messages = []) {
  const out = [];
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b) continue;
      let url = null;
      if (typeof b.image_url === 'string') url = b.image_url;
      else if (b.image_url && typeof b.image_url.url === 'string') url = b.image_url.url;
      else if (typeof b.imageUrl === 'string') url = b.imageUrl;
      else if (b.imageUrl && typeof b.imageUrl.url === 'string') url = b.imageUrl.url;
      else if (b.type === 'input_image' && typeof b.image_url === 'string') url = b.image_url;
      if (typeof url !== 'string' || !url) continue;
      const dm = OPENAI_IMAGE_DATA.exec(url);
      if (dm) out.push({ name: b.name || 'image.png', contentType: dm[1], data: dm[2] });
      else if (/^https:\/\//.test(url)) out.push({ name: b.name || 'image.png', contentType: b.mediaType || b.image_url?.media_type || 'image/png', url });
    }
  }
  return out;
}
