// real-probe-25-zai-url.mjs — z.ai 会话地址形状取证（2026-09-14）。
//
// 动机：C-2 要把「会话 id ↔ 地址」的知识从驱动里抽成每站点声明。GLM 已经有真机
// 实录（`?cid=<24 位十六进制>`，且与 SSE 的 conversation_id 逐字相同）。z.ai 是
// **另一个站点**（chat.z.ai），不能照抄 GLM 的形状——探针 23 在 zai 上跑 Q1 时
// 整轮 120s 超时（captureAlive=true 但 replyChars=0，见
// test-mock/out/glm-budget-2026-09-13T18-57-34-509Z.json），拿不到地址。
//
// 本探针绕开「必须跑完一轮」：只打开站点，然后**从页面本身**找会话链接
//（侧栏历史里的 <a href>）与当前地址。不发送任何消息、不改持久状态。
//
// 结论会直接决定 providers.js 里 zai 有没有 CONVERSATION_URL_BUILDERS 条目：
// 声明一个编出来的形状比声明「不支持」更糟——导航到不存在的地址会静默失败。
import fs from 'node:fs';
import path from 'node:path';
import { createBrowserDriver } from '../lib/browser-driver.js';

const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'out');
const driver = createBrowserDriver({
  siteId: 'zai',
  site: 'https://chat.z.ai/',
  profileDir: 'C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/zai',
  headless: true, requestTimeoutMs: 120_000, loginTimeoutMs: 300_000, logger: console,
});

const out = { at: new Date().toISOString(), siteId: 'zai' };
const say = (...a) => { console.log(...a); out.steps = [...(out.steps || []), a.map(String).join(' ')]; };

try {
  await driver.connect();
  await driver.page.waitForTimeout(3000);
  const url = driver.page.url();
  say('page.url() = ' + url);
  out.url = url;

  // 侧栏/页面里所有像「会话」的链接（含路径与查询串），去重后打印。
  const links = await driver.page.evaluate(() => {
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href') || '';
      if (!h || h === '/' || h.startsWith('http') && !h.includes(location.host)) continue;
      seen.add(h);
    }
    return [...seen].slice(0, 60);
  }).catch(() => []);
  say('--- 页面内链接（前 60，去重） ---');
  for (const l of links) say('  ' + l);
  out.links = links;

  // 当前地址的 query 键（判断用的是 cid 还是别的键名）
  try {
    const u = new URL(url);
    out.queryKeys = [...u.searchParams.keys()];
    out.pathname = u.pathname;
    say('query keys = ' + JSON.stringify(out.queryKeys) + '  pathname=' + out.pathname);
  } catch { /* 地址解析失败就只留原文 */ }

  // 会话 id 可能的载体：location 之外的 localStorage / 页面全局里有没有 current conversation
  const probe = await driver.page.evaluate(() => {
    const keys = Object.keys(localStorage).slice(0, 40);
    const hit = {};
    for (const k of keys) if (/chat|conv|session/i.test(k)) hit[k] = String(localStorage.getItem(k) || '').slice(0, 120);
    return { storageKeys: keys, interesting: hit };
  }).catch(() => null);
  out.storage = probe;
  say('--- localStorage 里会话相关的键 ---');
  say('  ' + JSON.stringify(probe?.interesting || {}));

  say('PROBE RESULT: done');
} catch (err) {
  say('PROBE FAIL: ' + String(err?.message || err));
  out.error = String(err?.message || err);
  process.exitCode = 1;
} finally {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch { /* out dir */ }
  const file = path.join(OUT_DIR, `zai-url-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  try { fs.writeFileSync(file, JSON.stringify(out, null, 2)); console.log('证据写入 ' + file); } catch { /* best effort */ }
  try { driver.close?.(); } catch { /* 关不掉就算了 */ }
}