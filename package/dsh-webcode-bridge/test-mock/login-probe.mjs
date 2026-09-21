// login-probe.mjs — 国内五站登录探针（plan Task 0.1 的工具化交付）
//
// 目的：把登录探针从「设置页/右栏手动看」提成可重复断言。对每个站点分别在
// 指定 profile 下无头打开页面，回读 judgeLoggedIn 的**判定结论**（不弹登录窗、
// 不改页面），输出真值矩阵所需的一行：站点 × 判定 × 判定依据 × 页面与异常。
//
// 铁律：
//   · 这只是**回读判定**，不产生也不知道「真实是否登录」——真实态由使用者标注，
//     矩阵的「空/已登录」两态回填就是要拿真实态跟本探针输出的判定对账（漏报/误报）；
//   · 网络不可达/超时如实报 UNREACHABLE，绝不谎报「未登录」（那是部分性假阴性）。
//
// 用法：
//   node test-mock/login-probe.mjs                 # 五站 × 空(临时) profile
//   node test-mock/login-probe.mjs --site glm      # 只探 glm
//   REAL_PROFILE=D:\...\sites\glm node test-mock/login-probe.mjs --site glm  # 探已登录 profile
import { createBrowserDriver } from '../lib/browser-driver.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const SITES = [
  { siteId: 'glm',    origin: 'https://chatglm.cn/' },
  { siteId: 'qwen',   origin: 'https://chat.qwen.ai/' },
  { siteId: 'doubao', origin: 'https://www.doubao.com/' },
  { siteId: 'kimi',   origin: 'https://www.kimi.com/' },
  { siteId: 'zai',    origin: 'https://chat.z.ai/' },
];

const only = process.argv.includes('--site')
  ? process.argv[process.argv.indexOf('--site') + 1]
  : null;
const givenProfile = process.env.REAL_PROFILE ? path.resolve(process.env.REAL_PROFILE) : null;
const SITE_TIMEOUT_MS = 75_000;

const rows = [];
const now = new Date().toISOString();
const runFor = (s) => only == null || s.siteId === only;

(async () => {
  for (const s of SITES) {
    if (!runFor(s)) continue;
    // 指定 profile 用「给定完整路径」；否则用一次性空 profile（os.tmpdir 下的独立目录）
    const profileDir = givenProfile ?? path.join(os.tmpdir(), 'login-probe-empty', s.siteId);
    if (!givenProfile && !fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

    let driver = null;
    const t0 = Date.now();
    try {
      driver = createBrowserDriver({
        siteId: s.siteId, site: s.origin, profileDir, headless: true,
        requestTimeoutMs: SITE_TIMEOUT_MS, logger: { log() {}, warn() {}, error() {}, info() {} },
      });
      const result = await Promise.race([
        (async () => { const conn = await driver.connect(); return conn; })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), SITE_TIMEOUT_MS)),
      ]);
      let basis = 'n/a'; let msg = '';
      try { const st = await driver.status(); basis = st?.loginBasis ?? 'n/a'; msg = st?.loginStatusLabel ?? st?.message ?? ''; } catch {}
      const ms = Date.now() - t0;
      const verdict = result?.ok === false ? 'ERROR' : result?.loggedIn === true ? 'LOGGED_IN' : 'NOT_LOGGED_IN';
      rows.push({ site: s.siteId, profile: givenProfile ? 'given' : 'empty', verdict, basis, ms, detail: msg });
      console.log(`${verdict.padEnd(12)} ${s.siteId}  profile=${givenProfile ? 'GIVEN' : 'empty'}  basis=${basis}  ${ms}ms${msg ? '  ' + msg : ''}`);
    } catch (e) {
      const ms = Date.now() - t0;
      const reason = String(e?.message || e);
      // 网络错误/挑战页 —— 如实报 unreachable，不算「未登录」
      rows.push({ site: s.siteId, profile: givenProfile ? 'given' : 'empty', verdict: 'UNREACHABLE', basis: 'err', ms, detail: reason.slice(0, 90) });
      console.log(`UNREACHABLE  ${s.siteId}  profile=${givenProfile ? 'GIVEN' : 'empty'}  ${ms}ms  ${reason.slice(0, 90)}`);
    } finally {
      try { await driver?.close(); } catch {}
    }
  }

  console.log('\n===== 登录探针矩阵（需使用者标注真实登录态对账） =====');
  for (const r of rows) console.log(`  ${r.profile.padEnd(6)} ${r.site.padEnd(7)} → ${r.verdict}  basis=${r.basis}  ${r.detail}`);
  console.log(`\n探测于 ${now}`);
  process.exit(rows.some((r) => r.verdict === 'UNREACHABLE' || r.verdict === 'ERROR') ? 0 : 0);
})();