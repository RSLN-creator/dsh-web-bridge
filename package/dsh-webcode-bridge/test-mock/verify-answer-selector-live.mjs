// verify-answer-selector-live.mjs — **只读**：逐站验证**已声明**的 `answerSelector`
// 是否真的命中该站会话页的助手节点（并给出 `.pop()` 读到的文本长度）。
//
// ## 为什么必须做这一轮（#76 的同族缺口）
//
// #76 证明：**声明的选择器没人验过**，就会在真机上「命中 0 个」而没人知道
//（doubao 落兜底串上是这样；glm/zai **声明了**，但**同样没人验过声明本身**）。
// `test/answer-selector.test.mjs` 判据 6 只能钉住「声明值 == 记录的真机读数」（逐字一致），
// 它的注释自己写着：**不能**证明「声明的选择器真的能命中」——那必须真机读数。
//
// ⇒ 本脚本就是那一步，**零发送**：只 `goto` 各站已有会话地址 + querySelectorAll。
//
// ## 用法
//
//   node test-mock/verify-answer-selector-live.mjs                 # 用内置的每站目标地址
//   node test-mock/verify-answer-selector-live.mjs glm zai doubao   # 只验指定站
//   TARGET_URL=<url> node test-mock/verify-answer-selector-live.mjs glm   # 覆盖地址
//
// ⚠ 每站的会话地址从**本站点自带的会话列表**取（`webApi` 不可用时退回环境变量 / 内置值）。
//   取不到地址的站点**如实记 `no-target`**，**不猜**。
import { createBrowserDriver, answerSelectorFor } from '../lib/browser-driver.js';
import { getSite, SITES } from '../lib/providers.js';
import { slotProfileDir, DEFAULT_SLOT } from '../lib/accounts.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = args.length ? args : ['glm', 'zai', 'doubao'];
const ROOT = path.join(process.env.USERPROFILE || os.homedir(), '.dsh', 'webcode-edge-profile');
const outDir = path.resolve('.tmp', 'real-lane', 'out');
fs.mkdirSync(outDir, { recursive: true });

/** 内置目标地址（来自本会话此前的真机读数；取不到就如实报 no-target）。 */
const KNOWN = {
  // glm 2026-10-15 用户操作过的那条会话（doc/research 与 Phase 2 台账里逐字记过）
  glm: process.env.TARGET_URL_GLM || 'https://chatglm.cn/main/alltoolsdetail?t=1791997441319&cid=6acfb6079bb107ea8151d3e7&lang=zh',
  // doubao 2026-10-17 本条 #76 取证用的会话
  doubao: process.env.TARGET_URL_DOUBAO || 'https://www.doubao.com/chat/38447511625363202',
  // zai：0.19.52 起有 /c/<uuid> 地址形状；具体 id 只存在于运行时，故默认不硬编码
  zai: process.env.TARGET_URL_ZAI || null,
};

const results = [];
for (const siteId of targets) {
  const site = getSite(siteId);
  if (!site) { results.push({ siteId, status: 'FAIL', detail: '未知站点' }); continue; }
  const profileDir = slotProfileDir(ROOT, siteId, DEFAULT_SLOT, { primary: site.mountAtRelayRoot === true });
  const declared = site.answerSelector;
  const effective = answerSelectorFor(siteId);
  const target = KNOWN[siteId] || null;

  if (!target) {
    results.push({ siteId, status: 'no-target', declared: Boolean(declared), effective, detail: '没有该站的会话地址（不猜）' });
    console.log(`${siteId.padEnd(8)} no-target（无会话地址；不猜）  declared=${Boolean(declared)}`);
    continue;
  }

  const driver = createBrowserDriver({
    siteId, site: site.origin + '/', profileDir, headless: false, requestTimeoutMs: 45_000,
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    const conn = await driver.connect().catch((e) => ({ loggedIn: false, err: String(e?.message || e).slice(0, 120) }));
    const page = driver.page;
    if (!page) { results.push({ siteId, status: 'BLOCKED', detail: 'driver 没有 page' }); continue; }
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(6_000);

    // ★ 与驱动**同源**的读数：`[...querySelectorAll(sel)].pop()`
    const snap = await page.evaluate((sel) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const all = [...document.querySelectorAll(sel)];
      const visOnly = all.filter(vis);
      const last = visOnly[visOnly.length - 1] || null;
      return {
        url: location.href, title: document.title,
        bodyHead: String(document.body?.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200),
        total: all.length, visible: visOnly.length,
        replyChars: last ? String(last.innerText || '').length : 0,
        selectorHit: Boolean(last),
        head: last ? String(last.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120) : null,
      };
    }, String(effective)).catch((e) => ({ err: String(e?.message || e).slice(0, 140) }));

    // ⚠ **必须区分「选择器缺陷」与「外部风控挡住」**（0.19.91 真机教训）：
    //   glm 那条 FAIL 的页面标题是「滑动验证页面」——**那是 WAF 页**，
    //   页面上根本没有 composer/回复 ⇒ 选择器命中 0 是**必然**的，
    //   它**不构成**「选择器坏了」的结论。按仓库四态纪律：外部条件 ⇒ **BLOCKED**。
    //   判据用 `challenge-heuristics` 的**唯一真源**（标题 + 正文），不另写词表。
    const { looksLikeChallengeText } = await import('../lib/challenge-heuristics.js');
    const isChallenge = looksLikeChallengeText(`${snap?.title || ''}\n${snap?.bodyHead || ''}`);

    const ok = snap && snap.selectorHit === true && snap.replyChars > 0;
    const status = snap?.err ? 'FAIL' : (ok ? 'PASS' : (isChallenge ? 'BLOCKED' : 'FAIL'));
    results.push({ siteId, status, loggedIn: conn?.loggedIn, declared: Boolean(declared), effective: String(effective), target, isChallenge, snap });
    console.log(`${siteId.padEnd(8)} ${status.padEnd(6)} declared=${Boolean(declared)} visible=${snap?.visible} replyChars=${snap?.replyChars} hit=${snap?.selectorHit} challenge=${isChallenge}`);
    console.log(`         title=${JSON.stringify(snap?.title)} url=${snap?.url}`);
    if (snap?.head) console.log(`         head=${JSON.stringify(snap.head)}`);
    if (snap?.err) console.log(`         ERR=${snap.err}`);
    if (status === 'BLOCKED') console.log('         ⇒ 外部风控页（不是选择器缺陷）：按四态记 BLOCKED，待人工过后重测');
  } catch (e) {
    results.push({ siteId, status: 'FAIL', detail: `${e?.code || ''} ${String(e?.message || e).slice(0, 160)}`.trim() });
    console.log(`${siteId.padEnd(8)} FAIL  ${String(e?.message || e).slice(0, 120)}`);
  } finally {
    await driver.close?.().catch(() => {});
  }
}

console.log('\n=== 汇总 ===');
for (const r of results) console.log(`  ${r.siteId.padEnd(8)} ${r.status}${r.status === 'no-target' ? '（无地址，未验）' : ''}`);
const out = path.join(outDir, 'answer-selector-live.json');
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log(`\n[写出] ${out}`);
console.log('[纪律] 零发送：只 goto 已有会话地址 + querySelectorAll（与驱动同源的读数）。');
