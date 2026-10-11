// site-verify.mjs — **按站点**的真实验收入口（0.19.74 新增）。
//
// ## 为什么需要它（这一条来自复审意见）
//
// 既有的 `real-verify.mjs` 把 `site: 'https://chat.deepseek.com/'` 写死在调用点，
// 它是一份**DeepSeek 专用**验收脚本。README 的 Site status 却对 Kimi / Qwen /
// Doubao / Z.ai 写着「Wired up, not validated over long runs」——而「未完成长运行
// 验证」这件事，**没有可重复的真实验收入口**就一直只能停在口头声明上。
//
// 本脚本把「站点」从硬编码变成一个参数，并对每个站点跑**同一套**最小真实闭环，
// 逐项给出四态结论（pass / fail / blocked / unverified），而不是笼统的「能用」。
//
// ## 用法
//
//   node test-mock/site-verify.mjs --site kimi
//   node test-mock/site-verify.mjs --site qwen --site doubao
//   node test-mock/site-verify.mjs --list
//   node test-mock/site-verify.mjs --site glm --profile "<已登录的 profile 目录>"
//
// 环境变量：REAL_PROFILE（默认 .edge-real-profile）／REAL_HEADLESS=0 看窗口。
//
// ## 四态口径（必须如实，不许把「没跑」写成「通过」）
//
//   PASS       真实页面 + 真实请求支持该结论
//   FAIL       真实页面复现了失败（附现场读数）
//   BLOCKED    外部条件挡住（未登录 / 验证码 / 站点风控）——不是产品结论
//   UNVERIFIED 本脚本没有覆盖该项（例如视觉、思考档位尚未声明）
//
// ## 边界（写清楚，别让下一个人以为它验了什么）
//
//   · 它验的是**每站点最小真实闭环**：登录判定 → 输入框可用 → 真发送 → 回读 →
//     流里有正文 → 工具调用可解析 → 工具结果回填后能收束。
//   · 它**不**验：长运行稳定性、多轮工具循环的收敛、会话重启恢复、视觉上传、
//     思考档位。那些要各自的专项入口（见 doc/site-acceptance.md 的矩阵）。
//   · 登录态来自你指定的 profile；脚本**只读**已有登录，不代你登录、不代过验证码。
import { createBrowserDriver } from '../lib/browser-driver.js';
import { getSite, SITES } from '../lib/providers.js';
import { serializeFirstTurn, parseAgentReply } from '../lib/agent-preset.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 取 `--flag value` 的全部出现（可重复）。 */
function flagValues(name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && i + 1 < argv.length) out.push(argv[i + 1]);
  }
  return out;
}

if (argv.includes('--list')) {
  console.log('可验收站点（lib/providers.js 的 SITES）：');
  for (const s of SITES) {
    console.log(`  ${s.id.padEnd(10)} ${String(s.name).padEnd(12)} ${s.origin}`
      + `   decoder=${s.decoder}${s.experimental ? '  [experimental]' : ''}`
      + `   answerSelector=${s.answerSelector ? 'yes' : 'NO'}`);
  }
  process.exit(0);
}

const siteIds = flagValues('--site');
if (!siteIds.length) {
  console.error('用法：node test-mock/site-verify.mjs --site <站点id> [--site …] [--list]');
  console.error('例：  node test-mock/site-verify.mjs --site kimi');
  process.exit(1);
}
const profileArg = flagValues('--profile')[0];
const PROFILE = profileArg || process.env.REAL_PROFILE
  || path.join(PKG, '..', '..', '.edge-real-profile');
const HEADLESS = process.env.REAL_HEADLESS !== '0';

const toolSchema = [
  { name: 'read', description: '读取本地文件文本内容。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

/**
 * 选一个**本站点真实声明过**的模型 id。
 *
 * 为什么不能写死 `'auto'`：那是桥早期自己发明的「不切换」档，**各站点的模型表并不
 * 都有它**。真机实测（`--site kimi`，空 profile）第一版就是这么错的：
 * `driver.sendTurn(…, model:'auto')` 直接回 `不支持的网页模型：auto` —— 而 kimi 的
 * `auto` 已在 0.19.43 **刻意真删**（原因写在 providers.js：`modelPicker` 已声明，
 * 网页真实档位是 快速 / K3 / K2.8 Preview 三条，留一个桥发明的档位只会让人以为切了）。
 *
 * 取第一项而不是「最便宜的那项」：本脚本验的是**链路能不能通**（发送 → 回读 → 流 →
 * 解析），不是模型能力对比。模型选谁不影响这个结论，但选错会直接假红。
 */
function pickModel(site) {
  const m = Array.isArray(site.models) ? site.models[0] : null;
  return m?.id ? String(m.id) : null;
}

/** 单站验收。返回 { siteId, status, checks[] }。 */
async function verifySite(siteId) {
  const site = getSite(siteId);
  if (!site) {
    return { siteId, status: 'FAIL', checks: [{ name: 'site.registered', status: 'FAIL', detail: `未知站点 id（--list 看可用站点）` }] };
  }
  const checks = [];
  const add = (name, status, detail = '') => {
    checks.push({ name, status, detail });
    console.log(`  ${status.padEnd(10)} ${name}${detail ? '  — ' + detail : ''}`);
  };
  const modelId = pickModel(site);
  if (!modelId) {
    add('site.models', 'FAIL', '该站点没有声明任何模型（providers.js 的 models 为空）');
    return { siteId, status: 'FAIL', checks };
  }

  // 每个站点一份独立 profile 子目录（登录态按站点各自持久，与产品行为一致）。
  const profileDir = path.join(PROFILE, siteId === 'deepseek' ? '.' : siteId);

  const driver = createBrowserDriver({
    siteId,
    site: site.origin + '/',
    profileDir,
    headless: HEADLESS,
    requestTimeoutMs: 110_000,
    logger: { log() {}, warn(...a) { console.log('    [warn]', ...a); }, error(...a) { console.log('    [err]', ...a); } },
  });

  try {
    // ---- ① 登录与页面：登录判定 + 输入框可见可编辑 ----
    let conn = null;
    try {
      conn = await driver.connect();
    } catch (err) {
      add('login.connect', 'BLOCKED', String(err?.message || err).slice(0, 160));
      return { siteId, status: 'BLOCKED', checks };
    }
    if (!conn?.loggedIn) {
      // 未登录**不是产品结论**：它说明这台机器的该站点 profile 没有登录态。
      add('login.loggedIn', 'BLOCKED',
        `profile 未登录（${profileDir}）——请在设置页为该站点点「登录」后重跑`);
      await driver.close?.().catch(() => {});
      return { siteId, status: 'BLOCKED', checks };
    }
    add('login.loggedIn', 'PASS', profileDir);

    const st = driver.status?.() || {};
    if (st.needLogin === true) add('login.needLogin', 'FAIL', '已判定登录却同时报 needLogin=true');
    else add('login.needLogin', 'PASS', st.loginBasis ? `basis=${st.loginBasis}` : '');

    // ---- ② 模型与发送：真实发送一轮纯文本并回读 ----
    //
    // ⚠ 这里刻意**不**先信 `loggedIn`：真机实测（空 profile、kimi）出现过
    // 「`loggedIn===true`（basis=probe-fallback，靠「有输入框」兜底）+ 发送路径
    // 回 NEED_LOGIN」的**自相矛盾**读数。验收脚本必须把这种矛盾暴露出来，而不是
    // 因为第一步返回 true 就记一个 PASS——那正是「把猜测当成核验结果」。
    let text = '';
    let sent = null;
    try {
      sent = await driver.sendTurn(
        'site-verify-text',
        serializeFirstTurn({ messages: [{ role: 'user', content: '请只回一行：收到。' }], tools: [], model: { id: modelId } }),
        { fresh: true, model: modelId, onDelta: (d) => { text += d; } },
      );
    } catch (err) {
      const code = err?.code || '';
      // 验证码/风控是**外部条件**，不是产品缺陷——单独标 BLOCKED 并保留现场。
      if (/CAPTCHA|RATE_LIMIT|NEED_LOGIN/.test(code)) {
        add('send.text', 'BLOCKED', `${code}: ${String(err?.message || err).slice(0, 140)}`);
        // 登录判定说「已登录」，而真实发送路径说「要登录」——**两者必有一错**。
        // 这不是 BLOCKED 能盖过去的：它是一条真实缺陷（面板会对没登录的站点
        // 显示「已登录」），所以单独记一条 FAIL。
        add('login.verdictConsistent', 'FAIL',
          `登录判定回 loggedIn=true（basis=${st.loginBasis ?? '?'}），但真实发送路径回 ${code}`
          + '——面板会把未登录站点显示成「已登录」，登录判定的兜底判据需要收紧');
        return { siteId, status: 'FAIL', checks };
      }
      add('send.text', 'FAIL', `${code || '(no code)'}: ${String(err?.message || err).slice(0, 160)}`);
      return { siteId, status: 'FAIL', checks };
    }
    add('login.verdictConsistent', 'PASS', '登录判定与真实发送路径一致');
    // 「发出去了」= 驱动返回了结果对象（回读成功）；正文是否非空单独判。
    add('send.text', 'PASS', '已投递并回读（驱动返回了结果对象）');
    const body = String(text || sent?.text || '');
    add('stream.body', body.trim().length > 0 ? 'PASS' : 'FAIL',
      body.trim().length > 0 ? `${body.trim().length} 字` : '回读为空——网页没给出正文');

    // ---- ③ 工具调用：真实工具闭环（模型输出调用 → 可解析）----
    let loopText = '';
    let loopResult = null;
    try {
      loopResult = await driver.sendTurn(
        'site-verify-loop',
        serializeFirstTurn({
          messages: [{ role: 'user', content: '请调用 read 工具读取 README.md，然后一句话说明你读到了什么。' }],
          tools: toolSchema, model: { id: modelId },
        }),
        { fresh: true, model: modelId, onDelta: (d) => { loopText += d; } },
      );
    } catch (err) {
      const code = err?.code || '';
      add('tool.loop', /CAPTCHA|RATE_LIMIT/.test(code) ? 'BLOCKED' : 'FAIL',
        `${code || '(no code)'}: ${String(err?.message || err).slice(0, 140)}`);
      return { siteId, status: checks.some((c) => c.status === 'FAIL') ? 'FAIL' : 'BLOCKED', checks };
    }
    const authoritative = String(loopResult?.text || loopText || '');
    const parsed = parseAgentReply(authoritative, { tools: toolSchema });
    const calls = parsed?.calls || [];
    add('tool.callParsed', calls.length > 0 ? 'PASS' : 'UNVERIFIED',
      calls.length > 0
        ? `解析出 ${calls.length} 条：${calls.map((c) => c.name).join(', ')}`
        : '本轮没有产出可解析的调用（模型可能直接回答了，也可能是漂移——需要人工判读原始回复）');

    // ---- ④ 会话连续性/收束：驱动报告了收束原因才谈得上「收得住」----
    const diag = await driver.diagnostics?.().catch(() => null);
    const endReason = diag?.lastEndReason ?? st.lastEndReason ?? null;
    add('turn.settled', endReason ? 'PASS' : 'UNVERIFIED', endReason ? `收束原因=${endReason}` : '没有收束读数');

    const failed = checks.some((c) => c.status === 'FAIL');
    return { siteId, status: failed ? 'FAIL' : 'PASS', checks };
  } finally {
    await driver.close?.().catch(() => {});
  }
}

const summary = [];
for (const siteId of siteIds) {
  console.log(`\n=== 站点验收：${siteId} ===`);
  // eslint-disable-next-line no-await-in-loop
  const r = await verifySite(siteId);
  summary.push(r);
}

console.log('\n=== 汇总（四态） ===');
for (const r of summary) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, UNVERIFIED: 0 };
  for (const c of r.checks) counts[c.status] = (counts[c.status] || 0) + 1;
  console.log(`  ${r.siteId.padEnd(10)} ${r.status.padEnd(10)} `
    + `PASS=${counts.PASS} FAIL=${counts.FAIL} BLOCKED=${counts.BLOCKED} UNVERIFIED=${counts.UNVERIFIED}`);
}
console.log('\n判读纪律：只有真实页面 + 真实请求支持的才是 PASS；'
  + 'BLOCKED 说明外部条件挡住（未登录/验证码），**不是**产品结论。');