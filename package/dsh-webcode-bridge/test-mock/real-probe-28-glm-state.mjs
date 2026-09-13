// real-probe-28-glm-state.mjs — GLM 站点当前状态诊断（2026-09-14）。
//
// 背景：probe-26/27 反复深链 `?cid=` 之后，GLM 开始对**根路径**也返回风控页，
// 导致 probe-26 第二次重跑在 fresh 分支就 NEED_LOGIN。必须回答：
//   Q1 这是**暂时**的风控（等一会儿就好）还是账号级封禁？
//   Q2 用户既有的登录态（cookie）还在不在？
//   Q3 根路径现在到底是什么页面？
//
// 只读：只导航 + 盘点页面，不发送消息，不改任何状态。会等待若干秒以观察恢复。
import fs from 'node:fs';
import path from 'node:path';
import { createBrowserDriver } from '../lib/browser-driver.js';

const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'out');
const PROFILE = 'C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/glm';

const out = { at: new Date().toISOString(), attempts: [] };
const say = (...a) => { console.log(...a); };

const driver = createBrowserDriver({
  siteId: 'glm', site: 'https://chatglm.cn/', profileDir: PROFILE,
  headless: true, requestTimeoutMs: 60_000, loginTimeoutMs: 300_000, logger: console,
});

async function look(page) {
  return page.evaluate(() => {
    const vis = [...document.querySelectorAll('textarea')].filter((t) => t.offsetWidth || t.offsetHeight || t.getClientRects().length);
    return {
      url: location.href,
      title: document.title,
      textareaTotal: document.querySelectorAll('textarea').length,
      textareaVisible: vis.length,
      waf: /滑动验证|访问验证/.test(document.title + ' ' + (document.body?.innerText || '')).valueOf(),
      body: (document.body?.innerText || '').slice(0, 150).replace(/\s+/g, ' '),
    };
  }).catch((e) => ({ error: String(e?.message || e) }));
}

try {
  await driver.connect();
  const page = driver.page;
  // cookie 检查：GLM 登录态的关键 cookie 还在不在
  const cookies = await driver.profileCookies('https://chatglm.cn').catch(() => []);
  const names = cookies.map((c) => c.name);
  say('cookie 数 = ' + cookies.length + '  含关键键: ' + ['chatglm_token', 'chatglm_refresh_token', 'chatglm_user_id'].filter((n) => names.includes(n)).join(',') || '(无)');
  out.cookies = { count: cookies.length, names: names.slice(0, 25) };

  // 三次尝试，间隔 20s：观察是「稳定风控」还是「限流会退」
  for (let i = 1; i <= 3; i++) {
    say(`\n===== 尝试 ${i}（间隔 20s）=====`);
    try {
      await page.goto('https://chatglm.cn/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(4000);
      const info = await look(page);
      say('  url   = ' + info.url);
      say('  title = ' + JSON.stringify(info.title));
      say('  textarea 总数/可见 = ' + info.textareaTotal + '/' + info.textareaVisible);
      say('  body  = ' + JSON.stringify(info.body));
      out.attempts.push(info);
    } catch (err) {
      say('  导航失败: ' + String(err?.message || err));
      out.attempts.push({ error: String(err?.message || err) });
    }
    if (i < 3) await page.waitForTimeout(20_000);
  }

  const last = out.attempts[out.attempts.length - 1];
  say('\n===== 判定 =====');
  say('  最后一次 title = ' + JSON.stringify(last?.title));
  say('  可见 textarea = ' + last?.textareaVisible);
  out.verdict = {
    lastTitle: last?.title ?? null,
    visibleComposer: last?.textareaVisible ?? null,
    challenged: /验证/.test(String(last?.title || '')),
  };
  say('PROBE RESULT: done');
} catch (err) {
  say('PROBE FAIL: ' + String(err?.message || err));
  out.error = String(err?.message || err);
  process.exitCode = 1;
} finally {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch { /* out dir */ }
  const file = path.join(OUT_DIR, `glm-state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  try { fs.writeFileSync(file, JSON.stringify(out, null, 2)); console.log('证据写入 ' + file); } catch { /* best effort */ }
  try { driver.close?.(); } catch { /* 关不掉就算了 */ }
}