// real-probe-26-glm-continuity.mjs — GLM 会话连续性真机复验（2026-09-14，C 修复验收）。
//
// 0.14.2 的 C 修复断言：GLM 的会话身份来自「地址 ?cid= 优先、SSE conversation_id 兜底」，
// 于是**第二轮应该续在同一个网页会话里**，而不是每轮新开。
//
// 本探针直接检验这条断言，三件事：
//   1. 首轮 fresh 之后 result.sessionId 是否非 null（旧实现恒 null）；
//   2. conversationFor(key) 是否真的写进了会话槽（旧实现恒 null）；
//   3. 第二轮 fresh:false 是否**不再抛 WEB_SESSION_LOST**，且页面停在同一个 cid。
//
// 只读语义：用独立会话槽 key，不碰用户既有对话；不修改任何持久状态。
import fs from 'node:fs';
import path from 'node:path';
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn } from '../lib/agent-preset.js';

const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'out');
const PROFILE = 'C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/glm';
const STORE = 'C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/glm/webcode-sessions-glm.json';
const KEY = 'probe-continuity-' + Date.now();

const out = { at: new Date().toISOString(), key: KEY, steps: [] };
const say = (...a) => { console.log(...a); out.steps.push(a.map(String).join(' ')); };
const cidOf = (u) => { try { return new URL(u).searchParams.get('cid'); } catch { return null; } };

const driver = createBrowserDriver({
  siteId: 'glm', site: 'https://chatglm.cn/', profileDir: PROFILE,
  headless: true, requestTimeoutMs: 180_000, loginTimeoutMs: 300_000, logger: console,
});

const firstTurn = () => serializeFirstTurn({
  system: 'You are a helpful assistant.',
  tools: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }],
});

try {
  await driver.connect();
  say('store BEFORE = ' + (fs.existsSync(STORE) ? fs.readFileSync(STORE, 'utf8').slice(0, 200) : '(no file)'));

  // ---- 第一轮：fresh ----
  const r1 = await driver.sendTurn(KEY, firstTurn(), { fresh: true, model: 'glm:auto' });
  const url1 = driver.page?.url?.() || '';
  say('\n=== 第一轮（fresh）===');
  say('  正文前 40 字: ' + JSON.stringify(String(r1?.text || '').slice(0, 40)));
  say('  page.url()       = ' + url1);
  say('  result.sessionId = ' + JSON.stringify(r1?.sessionId ?? null));
  say('  conversationFor  = ' + JSON.stringify(driver.conversationFor?.(KEY) ?? null));
  out.first = { text: String(r1?.text || '').slice(0, 80), url: url1, sessionId: r1?.sessionId ?? null, stored: driver.conversationFor?.(KEY) ?? null };

  // ---- 第二轮：fresh:false，**这是旧实现必抛 WEB_SESSION_LOST 的那一步** ----
  say('\n=== 第二轮（fresh:false，旧实现必抛 WEB_SESSION_LOST）===');
  let r2 = null; let err2 = null;
  try {
    r2 = await driver.sendTurn(KEY, '再说两个字：好的', { fresh: false, model: 'glm:auto' });
  } catch (e) {
    err2 = { message: String(e?.message || e), code: e?.code ?? null, navReason: e?.navReason ?? null };
  }
  const url2 = driver.page?.url?.() || '';
  if (err2) {
    say('  ✖ 抛错：' + err2.message + '  code=' + err2.code + ' navReason=' + err2.navReason);
  } else {
    say('  ✔ 未抛错；正文前 40 字: ' + JSON.stringify(String(r2?.text || '').slice(0, 40)));
  }
  say('  page.url()       = ' + url2);
  say('  result.sessionId = ' + JSON.stringify(r2?.sessionId ?? null));
  say('  conversationFor  = ' + JSON.stringify(driver.conversationFor?.(KEY) ?? null));
  out.second = { error: err2, url: url2, sessionId: r2?.sessionId ?? null, stored: driver.conversationFor?.(KEY) ?? null };

  // ---- 判定 ----
  const cid1 = cidOf(url1); const cid2 = cidOf(url2);
  say('\n=== 判定 ===');
  say('  cid 首轮 = ' + cid1 + ' / 次轮 = ' + cid2 + ' → ' + (cid1 && cid2 && cid1 === cid2 ? '同一会话 ✔' : '不同/缺失 ✖'));
  say('  会话槽已写入 = ' + Boolean(driver.conversationFor?.(KEY)?.webSessionId));
  say('  次轮未抛 WEB_SESSION_LOST = ' + (!err2));
  out.verdict = {
    sameCid: Boolean(cid1 && cid2 && cid1 === cid2),
    storedAfterFirst: Boolean(out.first.stored?.webSessionId),
    secondTurnOk: !err2,
  };
  say('  status.lastTurn = ' + JSON.stringify(driver.status()?.lastTurn));
  say('  status.sessionLostCount = ' + driver.status()?.sessionLostCount);
  out.statusAfter = { lastTurn: driver.status()?.lastTurn ?? null, sessionLostCount: driver.status()?.sessionLostCount ?? null };

  say('\nstore AFTER = ' + (fs.existsSync(STORE) ? fs.readFileSync(STORE, 'utf8').slice(0, 400) : '(no file)'));
  say('PROBE RESULT: done');
} catch (err) {
  say('\nPROBE FAIL: ' + String(err?.message || err));
  out.error = String(err?.message || err);
  process.exitCode = 1;
} finally {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch { /* out dir */ }
  const file = path.join(OUT_DIR, `glm-continuity-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  try { fs.writeFileSync(file, JSON.stringify(out, null, 2)); console.log('证据写入 ' + file); } catch { /* best effort */ }
  try { driver.close?.(); } catch { /* 关不掉就算了 */ }
}
