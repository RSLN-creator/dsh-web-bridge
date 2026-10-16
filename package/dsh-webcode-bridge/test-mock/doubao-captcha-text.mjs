// doubao-captcha-text.mjs — 读**在超时那一刻没能识别的**验证码文案（**只读，零发送**）。
//
// ## 为什么只读就能拿到（不需要再发一条消息）
//
// 2026-10-16 在 #75 修好后重跑 doubao，`probe` 行**第一次真的打出来了**（证明那段判据终于会跑）：
//
//     captcha probe at timeout (no hit):
//       frames:[{url:…/chat/38447511625363202, basis:null,
//                probe:{bodyLen:2355, kws:["图片","安全"], titleLen:12}},
//               {url:…/drive-iframe/…, probe:{bodyLen:21, kws:[]}}]
//
// ⇒ **页面有 2355 字正文、含「图片」「安全」**，却**不命中词表** ⇒ 验证码在，
//   但**措辞与词表不同**。而那次验证**从未被通过**（用户没去点），
//   所以那条会话页**很可能仍然停在同一画面上** ⇒ **导航过去只读**就能读到真实文案。
//
// ## 纪律
//
//   · **零发送**：只 `goto` 一个已有会话地址 + 读 DOM，**不写输入框、不点任何按钮**；
//   · **有头**：让人能看见（若真弹验证码，也便于用户后续手动处理）；
//   · **只落关键词上下文与片段**，不落整页正文（页面可能含账号信息）。
import { createBrowserDriver } from '../lib/browser-driver.js';
import { getSite } from '../lib/providers.js';
import { slotProfileDir, DEFAULT_SLOT } from '../lib/accounts.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TARGET = process.env.DOUBAO_TARGET_URL || 'https://www.doubao.com/chat/38447511625363202';
const site = getSite('doubao');
const ROOT = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, '.dsh', 'webcode-edge-profile')
  : path.join(os.homedir(), '.dsh', 'webcode-edge-profile');
const profileDir = slotProfileDir(ROOT, 'doubao', DEFAULT_SLOT, { primary: site.mountAtRelayRoot === true });
const outDir = path.resolve('.tmp', 'real-lane', 'out');
fs.mkdirSync(outDir, { recursive: true });

// 与真源同源：从 challenge-heuristics 取**当前**词表，对比「什么命中了、什么没命中」。
const heur = await import('../lib/challenge-heuristics.js');

const driver = createBrowserDriver({
  siteId: 'doubao', site: site.origin + '/', profileDir, headless: false,
  requestTimeoutMs: 45_000,
  logger: { log() {}, warn(...a) { console.log('[warn]', ...a); }, error(...a) { console.log('[err]', ...a); } },
});

const report = { target: TARGET, at: new Date().toISOString() };
try {
  await driver.connect();
  const page = driver.page;
  console.log('connected; 导航到目标会话（只读）…');
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((e) => console.log('goto warn:', String(e?.message || e).slice(0, 120)));
  // 给它一点渲染时间（验证码是异步挂载的）
  await page.waitForTimeout(6_000);

  const dom = await page.evaluate((o) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (el) => (el?.innerText || '').trim().replace(/\s+/g, ' ');
    const body = String(document.body?.innerText || '');
    const WORD = new RegExp(o.body);
    // 找出「明显像验证容器」的可见节点（含验证类关键词的最深层节点）
    const KWS = ['验证', '请选择', '拖拽', '图片', '滑块', '拖动', '人机', '安全', '提交', '确认', '完成'];
    const cands = [];
    for (const el of document.querySelectorAll('div,section,form,dialog')) {
      if (!vis(el)) continue;
      const t = txt(el);
      if (!t || t.length > 800) continue;
      const hit = KWS.filter((k) => t.includes(k));
      if (hit.length >= 2) cands.push({ cls: String(el.className || '').slice(0, 120), hit, t: t.slice(0, 300) });
      if (cands.length >= 8) break;
    }
    return {
      url: location.href,
      title: document.title,
      bodyLen: body.length,
      wordHit: WORD.test(body),
      kws: KWS.filter((k) => body.includes(k)),
      // 只落**片段**（前后各 120 字），避免整页正文（可能含账号信息）
      around: (() => {
        const i = body.search(/验证|请选择|拖拽|安全|人机/);
        return i < 0 ? null : body.slice(Math.max(0, i - 120), i + 260);
      })(),
      cands,
    };
  }, { body: heur.CHALLENGE_PATTERN_SOURCES.body }).catch((e) => ({ err: String(e?.message || e).slice(0, 160) }));

  report.dom = dom;
  console.log('url =', dom.url);
  console.log('title =', JSON.stringify(dom.title));
  console.log('bodyLen =', dom.bodyLen, ' 词表命中 =', dom.wordHit);
  console.log('关键词命中 =', JSON.stringify(dom.kws));
  console.log('正文片段（验证措辞附近，前后各 120 字）=', JSON.stringify(dom.around));
  console.log('候选验证容器 =');
  for (const c of dom.cands || []) console.log('   hit=' + JSON.stringify(c.hit) + ' cls=' + c.cls + '\n     t=' + JSON.stringify(c.t));

  const shot = await driver.screenshotBase64?.().catch(() => null);
  if (shot) {
    const p = path.join(outDir, `doubao-captcha-text-${Date.now()}.jpg`);
    fs.writeFileSync(p, Buffer.from(shot, 'base64'));
    report.screenshot = p;
    console.log('screenshot:', p);
  }
} catch (e) {
  report.err = `${e?.code || ''} ${String(e?.message || e).slice(0, 200)}`.trim();
  console.log('ERR:', report.err);
} finally {
  await driver.close?.().catch(() => {});
}
fs.writeFileSync(path.join(outDir, 'doubao-captcha-text.json'), JSON.stringify(report, null, 2));
console.log('\n[纪律] 本脚本零发送：只 goto 一个已有会话地址 + 读 DOM，未写输入框、未点任何按钮。');
