// real-probe-23-glm-budget.mjs — GLM 会话身份 + composer 容量探针（2026-09-14）。
//
// 回答两个直接决定修法的问题（B-0 / C-0）：
//
//   Q1【会话 id 形状】发一轮之后 page.url() 是什么形状？桥的 sessionIdFromUrl()
//      只认 ?chat_session_id=<id> 与 /a/chat/s/<id>（两者都是 DeepSeek 专有），
//      GLM 拿不到 → rememberConversation 永不执行 → webcode-sessions-glm.json 恒为
//      "{}"（真机取证：glm 2 字节，deepseek 5918 字节）→ 每轮 WEB_SESSION_LOST →
//      上层 fresh 重开。**若 SSE 帧里真的有 conversation_id，就不该依赖 URL。**
//   Q2【composer 长度上限】网页输入框到底能收多少字符？现在的声明值全是猜的
//      （glm/zai 目录写 1_000_000），而浏览器侧实测往往低一个数量级。
//
// 只读探针：Q1 发一条「只回答两个字：收到」的极短消息；Q2 **只填输入框、不按发送**，
// 逐档回读长度后清空。不修改任何持久状态（除站点自己的对话列表多一条短对话）。
//
// 用法：
//   $env:WEBCODE_SSE_DEBUG='<dir>'   # 可选：把原始 SSE 帧落到文件，Q1 的第一手证据
//   node test-mock/real-probe-23-glm-budget.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn } from '../lib/agent-preset.js';

const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'out');
const SITE_ID = process.env.PROBE_SITE || 'glm';
const PROFILE = process.env.PROBE_PROFILE
  || 'C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/' + SITE_ID;
const SITE_URL = SITE_ID === 'glm' ? 'https://chatglm.cn/' : 'https://chat.z.ai/';
const COMPOSER = process.env.PROBE_COMPOSER
  || 'textarea#chat-input, textarea[placeholder], textarea';
// 逐档递增（字符数）。只填不发送，因此每档的代价只是键盘输入 + 一次回读。
const RAMP = [1_000, 4_000, 16_000, 32_000, 64_000, 128_000, 200_000];

const out = { at: new Date().toISOString(), siteId: SITE_ID, profile: PROFILE, steps: [] };
const say = (...a) => { console.log(...a); out.steps.push(a.map(String).join(' ')); };

const driver = createBrowserDriver({
  siteId: SITE_ID,
  site: SITE_URL,
  profileDir: PROFILE,
  headless: true,
  requestTimeoutMs: 120_000,
  loginTimeoutMs: 300_000,
  logger: console,
});

function shape(u) { try { const x = new URL(u); return x.origin + x.pathname + (x.search || ''); } catch { return String(u); } }

/** Q2：把 n 个字符填进 composer 再回读，比较长度。不按发送键。 */
async function composerAccepts(page, n) {
  const loc = page.locator(COMPOSER).first();
  if (!await loc.count()) return { ok: false, reason: 'composer-not-found' };
  const text = 'a'.repeat(n);
  const t0 = Date.now();
  try {
    await loc.fill(text, { timeout: 60_000 });
  } catch (err) {
    return { ok: false, reason: 'fill-error: ' + String(err?.message || err).slice(0, 120), ms: Date.now() - t0 };
  }
  let back = '';
  try { back = await loc.inputValue({ timeout: 10_000 }); }
  catch (err) { return { ok: false, reason: 'readback-error: ' + String(err?.message || err).slice(0, 120), ms: Date.now() - t0 }; }
  // 清空，别给下一档或用户留一坨文本
  try { await loc.fill('', { timeout: 10_000 }); } catch { /* 清不掉也不影响结论 */ }
  return { ok: true, asked: n, back: back.length, ms: Date.now() - t0 };
}

try {
  await driver.connect();
  const st = driver.status();
  say('[状态] running=' + st.running + ' loggedIn=' + st.loggedIn + ' basis=' + st.loginBasis);

  // ---------- Q2：composer 容量（先做，不产生网页对话） ----------
  say('\n===== Q2: composer 长度上限（只填不发） =====');
  const page = driver.page;
  const results = [];
  for (const n of RAMP) {
    const r = await composerAccepts(page, n);
    results.push({ n, ...r });
    say(`  ${String(n).padStart(7)} 字符 → ` + (r.ok ? `回读 ${r.back}（${r.ms}ms）${r.back === n ? ' OK' : ' 截断!'}` : `失败: ${r.reason}`));
    // 一旦出现截断或失败就停：再往上只会更糟，且每档都要几十秒
    if (!r.ok || r.back !== n) break;
  }
  const lastOk = [...results].reverse().find((r) => r.ok && r.back === r.n);
  const firstBad = results.find((r) => !r.ok || r.back !== r.n);
  out.composer = { ramp: results, acceptedAtLeast: lastOk?.n ?? 0, firstFailure: firstBad ?? null };
  say(`  ⇒ 稳定接受 ≥ ${lastOk?.n ?? 0} 字符` + (firstBad ? `；首个失败档 = ${firstBad.n}（${firstBad.reason || '截断到 ' + firstBad.back}）` : '（斜坡未触顶）'));

  // ---------- Q1：会话 id 形状 ----------
  say('\n===== Q1: 一轮之后的会话身份 =====');
  const KEY = 'probe-glm-budget-' + Date.now();
  const prompt = serializeFirstTurn({
    system: 'You are a helpful assistant.',
    tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }],
  });
  const t0 = Date.now();
  const r = await driver.sendTurn(KEY, prompt, { fresh: true, model: SITE_ID + ':auto' });
  say(`  sendTurn 完成（${Date.now() - t0}ms），正文前 60 字: ` + JSON.stringify(String(r?.text || '').slice(0, 60)));
  say('  page.url()      = ' + shape(driver.page?.url?.() || '(no page)'));
  say('  result.sessionId = ' + JSON.stringify(r?.sessionId ?? null) + '   ← null 即 URL 里没有可用会话 id');
  say('  conversationFor(key) = ' + JSON.stringify(driver.conversationFor?.(KEY) ?? null));
  const st2 = driver.status();
  say('  status.lastTurn = ' + JSON.stringify(st2.lastTurn));
  say('  落盘 store = ' + JSON.stringify(st2.conversations));
  out.conversation = {
    url: shape(driver.page?.url?.() || ''),
    sessionId: r?.sessionId ?? null,
    stored: driver.conversationFor?.(KEY) ?? null,
    lastTurn: st2.lastTurn ?? null,
    store: st2.conversations ?? null,
  };

  const diag = await driver.diagnostics().catch((e) => ({ error: String(e?.message || e) }));
  say('\n===== diagnostics（剪裁） =====');
  say('  url=' + shape(diag?.url || '') + '  uiGen=' + JSON.stringify(diag?.uiGeneration ?? diag?.ui ?? null));
  out.diagnostics = { url: diag?.url ?? null, keys: Object.keys(diag || {}) };

  say('\nPROBE RESULT: done');
} catch (err) {
  say('\nPROBE FAIL: ' + String(err?.message || err));
  out.error = String(err?.message || err);
  process.exitCode = 1;
} finally {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch { /* out dir */ }
  const file = path.join(OUT_DIR, `glm-budget-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  try { fs.writeFileSync(file, JSON.stringify(out, null, 2)); console.log('\n证据写入 ' + file); } catch { /* best effort */ }
  try { driver.close?.(); } catch { /* 关不掉就算了 */ }
}