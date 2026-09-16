// real-probe-22-glm-session.mjs — GLM 会话身份探针（2026-09-14）。
//
// 背景（用户真机报的问题②）：GLM 作为子代理时「同一会话却每轮新开对话」。
// 已取证到的机制：lib/browser-driver.js 的 sessionIdFromUrl() 只认两种 URL 形状
//   ?chat_session_id=<id>  与  /a/chat/s/<id>
// ——两者都是 DeepSeek 专有；GLM 地址栏不是这个形状 → sessionId 恒为 null →
// rememberConversation 永不执行 → 下一轮 conversationFor 为空 → 抛
// WEB_SESSION_LOST → 上层以 fresh:true 重开新会话。磁盘侧证据：
//   webcode-sessions-glm.json = "{}"（2 字节），而 deepseek 那份 5917 字节。
//
// 本探针回答两个问题，直接决定修法：
//   Q1 发一轮之后 page.url() 到底是什么形状？（有没有可用的会话 id）
//   Q2 GLM 的 SSE 帧里 conversation_id 是否真的存在、字段名逐字为何？
//      （lib/decoder.js:490 的注释写了该字段，但从未被取用）
//
// 只读探针：发一轮，打印现场，不改任何持久状态。用独立会话槽，不碰用户网页对话。
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn } from '../lib/agent-preset.js';

const driver = createBrowserDriver({
  siteId: 'glm', site: 'https://chatglm.cn/',
  profileDir: 'C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/glm',
  headless: true, requestTimeoutMs: 240_000, loginTimeoutMs: 300_000, logger: console,
});

const PROBE_KEY = 'probe-glm-session-' + Date.now();

// 从页面的 network 层捞出 assistant/stream 的原始响应体：driver 内部已有捕获链，
// 但那是给解码器用的。这里改从 performance/资源侧拿不到 body，所以退一步——
// 用 driver 暴露的 webApi 拿会话列表，确认会话是否真的建出来了、id 形状如何。
function shape(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname + (x.search ? x.search : '');
  } catch { return String(u); }
}

try {
  const prompt = serializeFirstTurn({
    system: 'You are a helpful assistant.',
    tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }],
  });

  const r = await driver.sendTurn(PROBE_KEY, prompt, { fresh: true, model: 'glm:auto' });

  console.log('\n===== Q1: 页面 URL 形状 =====');
  console.log('page.url()      = ' + shape(driver.page?.url?.() || '(no page)'));
  console.log('result.sessionId = ' + JSON.stringify(r?.sessionId ?? null));
  console.log('   ↑ 为 null 即证实「GLM 拿不到会话 id」= 每轮重开的直接原因');

  console.log('\n===== 正文前 200 字 =====');
  console.log(String(r?.text || '').slice(0, 200));

  console.log('\n===== Q2: 会话槽是否写进去了 =====');
  const stored = driver.conversationFor?.(PROBE_KEY);
  console.log('conversationFor(key) = ' + JSON.stringify(stored));
  console.log('   ↑ 为 null 即证实 rememberConversation 从未执行');

  console.log('\n===== 站点会话列表（取前 3 条看 id 形状）=====');
  try {
    const list = await driver.listSessions(3);
    const rows = Array.isArray(list) ? list : (list?.sessions || list?.data || []);
    for (const s of rows.slice(0, 3)) console.log('  ' + JSON.stringify(s));
  } catch (e) {
    console.log('  listSessions failed: ' + e.message);
  }

  console.log('\nPROBE RESULT: done');
} catch (e) {
  console.error('PROBE FAIL: ' + e.message);
  process.exitCode = 1;
} finally {
  try { driver.close?.(); } catch {}
}
