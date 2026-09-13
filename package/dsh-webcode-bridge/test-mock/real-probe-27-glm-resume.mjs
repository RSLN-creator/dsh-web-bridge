// real-probe-27-glm-resume.mjs — GLM「导航回既有会话」可行性取证（2026-09-14）。
//
// 动机：probe-26 证明 C 修复的**身份**部分完全正确（result.sessionId 非 null、
// 会话槽写进去了、两轮 cid 相同、sessionLostCount=0），但**第二轮仍然失败**，
// 且失败形态换了：
//
//   ✖ locator.fill: Timeout 30000ms exceeded
//     - locator resolved to <textarea>appkey: "CF_APP_WAF", // 应用标识var AC_Opt = {userUs…</textarea>
//     - element is not visible
//
// 即：导航到 `?cid=<id>` 之后，页面上的 textarea 不是 composer，而是一个**隐藏的
// WAF 页面内联脚本模板**。驱动的 resume 分支会：
//   waitForSelector(SEL.input)  ← 匹配到这个隐藏 textarea（.catch 吞掉超时）
//   judgeLoggedIn(page)         ← bad 特征（「登录」）不命中 → 回退判定说「已登录」
//   → 继续往下走 → fill 必然超时 30s
//
// 三个必须回答的问题：
//   Q1 深链 `?cid=` 是否稳定触发 WAF 页？（还是偶发）
//   Q2 带上站点自己用的 `lang=zh` 是否就能避开？（probe-26 首轮的真实 URL 是
//      `?lang=zh&cid=…`，而 conversationUrlFor('glm') 只拼了 `?cid=…`）
//   Q3 若两条都进 WAF，那么 GLM 的 `resume` 态是否**本来就不成立**——即应当
//      如实退回 `unsupported`，让上层整段重建，而不是导航到一个假页面。
//
// 只读：使用既有 cid 导航，不发送任何消息，不改持久状态。
import fs from 'node:fs';
import path from 'node:path';
import { createBrowserDriver } from '../lib/browser-driver.js';

const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'out');
const PROFILE = 'C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/glm';
const ORIGIN = 'https://chatglm.cn';
// probe-26 刚建出来的真实会话（首轮 fresh 的产物）
const CID = process.env.PROBE_CID || '6aa6fdf16112d633ae83e59a';
const COMPOSER = 'textarea#chat-input, textarea[placeholder], textarea';

const out = { at: new Date().toISOString(), cid: CID, cases: [] };
const say = (...a) => { console.log(...a); out.steps = [...(out.steps || []), a.map(String).join(' ')]; };

const driver = createBrowserDriver({
  siteId: 'glm', site: ORIGIN + '/', profileDir: PROFILE,
  headless: true, requestTimeoutMs: 60_000, loginTimeoutMs: 300_000, logger: console,
});

/** 在**当前页**上盘点：所有 textarea 的可见性与内容前 60 字，以及 WAF 指纹。 */
async function inspect(page) {
  return page.evaluate((sel) => {
    const all = [...document.querySelectorAll('textarea')].map((t) => ({
      id: t.id || null,
      placeholder: t.getAttribute('placeholder') || null,
      visible: Boolean(t.offsetWidth || t.offsetHeight || t.getClientRects().length),
      editable: !t.disabled && !t.readOnly,
      head: (t.value || t.textContent || '').slice(0, 60),
    }));
    const html = document.documentElement.outerHTML;
    return {
      url: location.href,
      title: document.title,
      textareas: all,
      // WAF 指纹：应用标识出现在页面源码里就是 WAF 页（不是真正的对话页）
      wafHit: /CF_APP_WAF|AC_Opt|appkey/.test(html),
      // 真正的对话页应该有的东西
      composerVisible: [...document.querySelectorAll(sel.split(',')[0])].some((e) => e.offsetWidth || e.offsetHeight),
      bodyHead: (document.body?.innerText || '').slice(0, 120).replace(/\s+/g, ' '),
    };
  }, COMPOSER).catch((e) => ({ error: String(e?.message || e) }));
}

try {
  await driver.connect();
  const page = driver.page;

  const cases = [
    { name: 'fresh 根（对照）', url: ORIGIN + '/' },
    { name: '?cid=（桥当前拼法）', url: ORIGIN + '/main/alltoolsdetail?cid=' + encodeURIComponent(CID) },
    { name: '?lang=zh&cid=（站点自己的形状）', url: ORIGIN + '/main/alltoolsdetail?lang=zh&cid=' + encodeURIComponent(CID) },
  ];

  for (const c of cases) {
    say('\n===== ' + c.name + ' =====');
    say('  goto ' + c.url);
    try {
      await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      // 给 SPA/风控页一点渲染时间，否则会误判成「什么都没有」
      await page.waitForTimeout(3500);
      const info = await inspect(page);
      out.cases.push({ ...c, info });
      say('  落点 url   = ' + info.url);
      say('  title      = ' + JSON.stringify(info.title));
      say('  WAF 指纹   = ' + info.wafHit + '   composer 可见 = ' + info.composerVisible);
      say('  textarea 数 = ' + (info.textareas || []).length);
      for (const t of (info.textareas || [])) {
        say(`    - id=${t.id} placeholder=${JSON.stringify(t.placeholder)} visible=${t.visible} editable=${t.editable} head=${JSON.stringify(t.head)}`);
      }
      say('  body 前 120 = ' + JSON.stringify(info.bodyHead));
    } catch (err) {
      out.cases.push({ ...c, error: String(err?.message || err) });
      say('  导航失败: ' + String(err?.message || err));
    }
  }

  say('\n===== 判定 =====');
  const byName = (n) => out.cases.find((c) => c.name === n);
  const cidCase = byName('?lang=zh&cid=（站点自己的形状）');
  const noLang = byName('?cid=（桥当前拼法）');
  say('  ?cid= 进 WAF         = ' + Boolean(noLang?.info?.wafHit));
  say('  ?lang=zh&cid= 进 WAF = ' + Boolean(cidCase?.info?.wafHit));
  say('  ?lang=zh&cid= composer 可见 = ' + Boolean(cidCase?.info?.composerVisible));
  out.verdict = {
    cidAloneWaf: Boolean(noLang?.info?.wafHit),
    cidWithLangWaf: Boolean(cidCase?.info?.wafHit),
    cidWithLangComposerVisible: Boolean(cidCase?.info?.composerVisible),
  };

  say('PROBE RESULT: done');
} catch (err) {
  say('\nPROBE FAIL: ' + String(err?.message || err));
  out.error = String(err?.message || err);
  process.exitCode = 1;
} finally {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch { /* out dir */ }
  const file = path.join(OUT_DIR, `glm-resume-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  try { fs.writeFileSync(file, JSON.stringify(out, null, 2)); console.log('证据写入 ' + file); } catch { /* best effort */ }
  try { driver.close?.(); } catch { /* 关不掉就算了 */ }
}