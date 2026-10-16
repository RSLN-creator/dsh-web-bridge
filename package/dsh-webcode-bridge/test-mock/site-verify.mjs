// site-verify.mjs — **按站点**的真实验收入口（0.19.74 新增；0.19.75 按复审意见收紧）。
//
// ## 为什么需要它（这一条来自复审意见）
//
// 既有的 `real-verify.mjs` 把 `site: 'https://chat.deepseek.com/'` 写死在调用点，
// 它是一份**DeepSeek 专用**验收脚本。README 的 Site status 却对 Kimi / Qwen /
// Doubao / Z.ai 写着「Wired up, not validated over long runs」——而「未完成长运行
// 验证」这件事，**没有可重复的真实验收入口**就一直只能停在口头声明上。
//
// 本脚本把「站点」从硬编码变成一个参数，并对每个站点跑**同一套**最小真实闭环，
// 逐项给出四态结论，而不是笼统的「能用」。
//
// ## 0.19.75：修掉三个「工具自己制造假结论」的缺陷（复审指出）
//
//   ① **最终状态把 UNVERIFIED 汇总成 PASS** —— 收尾原写作
//      `failed ? 'FAIL' : 'PASS'` ⇒ 只要没有 FAIL，站点整体就 PASS，哪怕一条工具
//      调用都没产出。现在判定完全交给 `site-verify-verdict.mjs` 的 `verdictOf()`
//      （四态优先级 + 必要检查项缺失也算不确定），且该纯函数本身有反向护栏
//      `test/site-verify-verdict.test.mjs`。
//   ② **从未真正做工具结果往返** —— 旧实现只「发送 → 解析调用」就收尾，却在注释里
//      写成「工具结果回填后能收束」（描述超出实现）。现在**真的**执行 `read`、
//      把结果作为 `mcp_action:"result"` 回填进**同一个**网页会话、再解析第二轮，
//      产生 `tool.resultRoundTrip` 这一项。
//   ③ **全文回读掩盖流式交付失败** —— 旧写法 `String(text || sent?.text || '')`
//      在没有增量时只要全文非空就判「流有正文」，**恰好掩盖 Issue #1 的症状**。
//      现在 `stream.fullText` / `stream.deltaReceived` / `stream.consistency`
//      三项分开判（判据见 `streamDeliveryVerdict()`）。
//
// ## 用法
//
//   node test-mock/site-verify.mjs --site kimi
//   node test-mock/site-verify.mjs --site qwen --site doubao
//   node test-mock/site-verify.mjs --list
//   node test-mock/site-verify.mjs --site glm --profile-root "<profile 根目录>"
//
// 环境变量：REAL_PROFILE（默认 .edge-real-profile）／REAL_HEADLESS=0 看窗口。
//
// ## `--profile-root` 的语义（0.19.75 明确，旧名 `--profile` 有歧义）
//
// 它收的是**profile 根目录**：脚本会在其下按站点取子目录（deepseek 用根本身，
// 其余用 `<root>/<siteId>`），与产品的「登录态按站点各自持久」一致。
// 旧名 `--profile` 的注释写着「已登录的 profile 目录」，但代码仍会拼 `/<siteId>`
// ⇒ 传一个已登录的 kimi 目录时实际读的是它下面的 `kimi` 子目录（复审指出的歧义）。
// 旧名仍接受（向后兼容），但会打印一行提示说明它按**根目录**解释。
//
// ## 四态口径（必须如实，不许把「没跑」写成「通过」）
//
//   PASS       真实页面 + 真实请求支持该结论
//   FAIL       真实页面复现了失败（附现场读数）
//   BLOCKED    外部条件挡住（未登录 / 验证码 / 站点风控）——不是产品结论
//   UNVERIFIED 该项没有验到（缺读数、缺调用、缺回填）——**绝不是通过**
//
// 汇总优先级：`FAIL` > `BLOCKED` > `UNVERIFIED` > `PASS`；**缺必要检查项也算
// UNVERIFIED**（防止「没跑那一段」被读成「那一段没问题」）。
//
// ## 边界（写清楚，别让下一个人以为它验了什么）
//
//   · 它验的是**每站点最小真实闭环**：登录判定 → 真发送 → 最终全文与**流式增量**
//     分别到位且一致 → 工具调用可解析 → **工具真的执行并把结果回填同一网页会话**
//     → 第二轮能继续 → 本轮有收束读数。
//   · 它**不**验：长运行稳定性（>120s 单轮）、多轮工具循环的收敛、会话重启恢复、
//     视觉上传、思考档位。那些要各自的专项入口。
//   · 登录态来自你指定的 profile 根；脚本**只读**已有登录，不代你登录、不代过验证码。
//   · `tool.resultRoundTrip` 验的是**驱动层**的往返（同一网页会话里的第二轮）。
//     它**不**等于 DSH 适配器层的完整工具闭环（那要 `real-verify.mjs` 那条链路）。
import { createBrowserDriver } from '../lib/browser-driver.js';
import { getSite, SITES } from '../lib/providers.js';
// 槽目录必须与产品**同源**取（见下方 profileDir 的注释：手写一份 `<root>/<siteId>`
// 会与产品真实的 `sites/<siteId>` 布局分叉，登录态读不到）。
import { slotProfileDir, DEFAULT_SLOT } from '../lib/accounts.js';
import { serializeFirstTurn, parseAgentReply } from '../lib/agent-preset.js';
import { verdictOf, streamDeliveryVerdict } from './site-verify-verdict.mjs';
import { planSendGap, sleepMs, MIN_SEND_GAP_MS } from './site-verify-pacing.mjs';
import fs from 'node:fs';
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

/**
 * 读产品的 settings（`<profile 根>/webcode-settings.json`），失败就返回 null。
 *
 * 为什么要读它而不是写死 30s：发送间隔是**用户设置**（回落链
 * 「槽 → 站点 → 全局」，见 `lib/accounts.js` 的 `sendGapForSlot`）。验收脚本
 * 必须按用户当前设置来发，否则读数与产品行为不可比；同时它另有 ≥20s 地板
 * （见 `site-verify-pacing.mjs`）。读不到文件时退回 null ⇒ 走地板值，**不会**零等待。
 */
function readSettingsQuiet(profileRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(profileRoot, 'webcode-settings.json'), 'utf8'));
  } catch {
    return null;
  }
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
const profileArg = flagValues('--profile-root')[0] || flagValues('--profile')[0];
if (!flagValues('--profile-root')[0] && flagValues('--profile')[0]) {
  console.log('[note] `--profile` 按**根目录**解释（与 `--profile-root` 同义）：'
    + '脚本会在其下按站点取子目录。旧名保留仅为向后兼容。');
}
const PROFILE = profileArg || process.env.REAL_PROFILE
  || path.join(PKG, '..', '..', '.edge-real-profile');
const HEADLESS = process.env.REAL_HEADLESS !== '0';

const toolSchema = [
  { name: 'read', description: '读取本地文件文本内容。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

/**
 * 选一个**本站点真实声明过**的模型 id，并返回**站点限定**形式 `<siteId>:<modelId>`。
 *
 * 为什么不能写死 `'auto'`：那是桥早期自己发明的「不切换」档，**各站点的模型表并不
 * 都有它**。真机实测（`--site kimi`，空 profile）第一版就是这么错的：
 * `driver.sendTurn(…, model:'auto')` 直接回 `不支持的网页模型：auto` —— 而 kimi 的
 * `auto` 已在 0.19.43 **刻意真删**（原因写在 providers.js：`modelPicker` 已声明，
 * 网页真实档位是 快速 / K3 / K2.8 Preview 三条，留一个桥发明的档位只会让人以为切了）。
 *
 * ⚠ **为什么要加站点前缀（2026-10-14 真机踩到）**：不同站点可以声明**同名的模型 id**。
 * 实测 z.ai 的模型表是 `glm-5.3-flash` / `glm-5.3` / `glm-5.2`，而 GLM 站点也有
 * `glm-5.3` / `glm-5.3-flash`。只传裸 id 时 `resolveWebModel('glm-5.3-flash')` 解析成
 * **glm 站点的模型**，驱动随即抛
 * `MODEL_SITE_MISMATCH: 模型 glm-5.3-flash 属于站点glm，当前驱动为 zai`
 * ⇒ 工具报 FAIL，而**真实链路根本没被验到**（那是工具的假红，不是产品缺陷）。
 * 传 `<siteId>:<modelId>` 才是桥产品路径实际使用的形状（见 index.js 的 resolveWebModel 调用点）。
 *
 * 取第一项而不是「最便宜的那项」：本脚本验的是**链路能不能通**（发送 → 回读 → 流 →
 * 解析），不是模型能力对比。模型选谁不影响这个结论，但选错会直接假红。
 */
function pickModel(site) {
  const m = Array.isArray(site.models) ? site.models[0] : null;
  if (!m?.id) return null;
  return `${site.id}:${m.id}`;
}

/** 单站验收。返回 { siteId, status, checks[] }。 */
async function verifySite(siteId) {
  const site = getSite(siteId);
  if (!site) {
    const checks = [{ name: 'site.registered', status: 'FAIL', detail: '未知站点 id（--list 看可用站点）' }];
    return { siteId, ...verdictOf(checks), checks };
  }
  const checks = [];
  const add = (name, status, detail = '') => {
    checks.push({ name, status, detail });
    console.log(`  ${status.padEnd(10)} ${name}${detail ? '  — ' + detail : ''}`);
  };
  /**
   * 统一的收尾判定：**所有**返回路径都走它。
   *
   * 为什么连「已经明确 FAIL/BLOCKED」的提前返回也要走纯函数：只要有一条路径自己拼
   * 状态字符串，判定规则就有第二个真源，迟早与 `verdictOf` 漂移（本项目对「两处
   * 口径漂移」记过多次）。这里宁可多绕一次函数调用。
   */
  const finalize = () => {
    const v = verdictOf(checks);
    if (v.reasons.length) console.log(`    ⇒ 判定依据：${v.reasons.join('；')}`);
    return { siteId, status: v.status, checks, verdict: v };
  };
  const modelId = pickModel(site);
  if (!modelId) {
    add('site.models', 'FAIL', '该站点没有声明任何模型（providers.js 的 models 为空）');
    return finalize();
  }

  // 每个站点一份独立 profile 子目录（登录态按站点各自持久，与产品行为一致）。
  //
  // ⚠ **0.19.82 修缺陷**：旧实现在这里手写了 `path.join(PROFILE, siteId)`，而产品
  //   （`index.js` 的三处调用点）用的是 `slotProfileDir(...)`，非 primary 站点的默认槽
  //   落在 **`<root>/sites/<siteId>`**（多一层 `sites/`）。两者的差集恰好是**全部非
  //   deepseek 站点** ⇒ 验收工具一直在读一个不存在的空目录，只会得到一堆假的
  //   `BLOCKED 未登录`（deepseek 因为 primary=true 恰好相同，所以这个错误只会在
  //   其余站点上显形，容易漏过）。
  //   ⇒ 现在**复用产品那一个真源**（`lib/accounts.js` 的 slotProfileDir），不再手写第二份。
  const profileDir = slotProfileDir(PROFILE, siteId, DEFAULT_SLOT, { primary: site.mountAtRelayRoot === true });

  // ---- 发送间隔闸门（0.19.82 修出的第二个「验收工具自己违规」）------------------
  //
  // 修前：三轮发送**背靠背连发**（本文件连一处 `setTimeout`/`sleep` 都没有），
  // 而 `.tmp/real-lane/PHASE2-RUNBOOK.md` §3 却写着「本脚本内部三轮间隔由
  // `sendGapMs` 控制」——**文档比实现多了一条不存在的护栏**。真实后果是验收脚本
  // 用比产品严苛得多的节奏打站点 ⇒ 自造风控 ⇒ 四态记成 `BLOCKED`，
  // **外部原因掩盖工具自己的违规**。
  //
  // 现在：每一轮真实发送前都过一次 `planSendGap`（设置值与 ≥20s 地板取较大者），
  // 读取上一次发出/结束时刻由**本进程内存**记录（`sendState`），与
  // `lib/metrics.js` 的 `computeSendGap` 同一口径，不另写一份判定。
  const settings = readSettingsQuiet(PROFILE);
  const gapState = { send: null, end: null };
  /** 距离上一轮结束/发出的实际毫秒（本次运行内自行记账）。 */
  const mark = (kind) => { gapState[kind] = Date.now(); };
  const waitForSendGap = async (label) => {
    const plan = planSendGap({
      settings, accountKey: siteId, siteId,
      now: Date.now(), lastSendAt: gapState.send, lastEndAt: gapState.end,
    });
    add('send.gap', 'PASS',
      `第 ${label} 次发送前间隔闸门：等待 ${Math.round(plan.waitMs / 1000)}s`
      + `（设置 ${Math.round(plan.configuredMs / 1000)}s / 地板 ${Math.round(plan.floorMs / 1000)}s，`
      + `基准 ${plan.basis}）`
      + (plan.sincePrevMs == null ? '（本次运行首轮，无基准）' : `，距上次 ${Math.round(plan.sincePrevMs / 1000)}s`));
    if (plan.waitMs > 0) {
      console.log(`    [gap] 等待 ${Math.round(plan.waitMs / 1000)}s（防自造风控：不是赶进度能压缩的）`);
      await sleepMs(plan.waitMs);
    }
    mark('send');
    return plan;
  };

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
      return finalize();
    }
    if (!conn?.loggedIn) {
      // 未登录**不是产品结论**：它说明这台机器的该站点 profile 没有登录态。
      add('login.loggedIn', 'BLOCKED',
        `profile 未登录（${profileDir}）——请在设置页为该站点点「登录」后重跑`);
      await driver.close?.().catch(() => {});
      return finalize();
    }
    add('login.loggedIn', 'PASS', profileDir);
    const st = driver.status?.() || {};
    if (st.needLogin === true) add('login.needLogin', 'FAIL', '已判定登录却同时报 needLogin=true');
    else add('login.needLogin', 'PASS', '未同时报 needLogin=true');
    // ⚠ `basis=probe-fallback` 的含义是「声明了登录特征却一个都没命中，退回按
    // 「有输入框」兜底」——那是**猜测**，不是核验结果。0.19.75 起不许把它记成 PASS：
    // 与 #53 同一口径（登录状态分「已验证登录 / 已验证未登录 / 不确定」三态），
    // 这里如实记 UNVERIFIED，最终状态因此不会是 PASS。
    // 只收窄 probe-fallback（用户选定的窄口径）：DeepSeek 没有 loginProbe，
    // basis 恒为 input-fallback，其显示与判定保持不变。
    add('login.basis', st.loginBasis === 'probe-fallback' ? 'UNVERIFIED' : 'PASS',
      st.loginBasis === 'probe-fallback'
        ? '登录特征一个都没命中，退回「有输入框」兜底 ⇒ 登录状态不确定（不是已验证登录）'
        : (st.loginBasis ? `basis=${st.loginBasis}` : 'basis 未报告'));

    // ---- ② 模型与发送：真实发送一轮纯文本并回读 ----
    //
    // ⚠ 这里刻意**不**先信 `loggedIn`：真机实测（空 profile、kimi）出现过
    // 「`loggedIn===true`（basis=probe-fallback，靠「有输入框」兜底）+ 发送路径
    // 回 NEED_LOGIN」的**自相矛盾**读数。验收脚本必须把这种矛盾暴露出来，而不是
    // 因为第一步返回 true 就记一个 PASS——那正是「把猜测当成核验结果」。
    let text = '';
    let sent = null;
    try {
      await waitForSendGap('1/3');
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
        return finalize();
      }
      add('send.text', 'FAIL', `${code || '(no code)'}: ${String(err?.message || err).slice(0, 160)}`);
      return finalize();
    }
    add('login.verdictConsistent', 'PASS', '登录判定与真实发送路径一致');
    // 「发出去了」= 驱动返回了结果对象（回读成功）；正文是否非空单独判。
    add('send.text', 'PASS', '已投递并回读（驱动返回了结果对象）');
    mark('end');   // 本轮收束：end-to-start 基准的锚点

    // ---- ②b 交付形状：**全文**与**流式增量**必须分开判（复审指出的第三个缺陷）----
    //
    // 旧写法 `String(text || sent?.text || '')` 会在「没收到任何增量、但回读对象带正文」
    // 时得到一个非空 body 并判 PASS —— **那恰好掩盖 Issue #1 的症状**（页面有正文、
    // 流式交付链没送到）。这里拆成三项：全文存在 / 增量真的到了 / 两者一致。
    const delivery = streamDeliveryVerdict({ fullText: sent?.text, deltaText: text });
    add('stream.fullText', delivery.fullTextOk ? 'PASS' : 'FAIL',
      delivery.fullTextOk ? `${delivery.fullChars} 字` : '最终回读里没有正文——网页没给出内容');
    // 增量没到**不等于**网页没生成（可能就是交付链断在页面→流这一段），所以它不是
    // FAIL 而是 UNVERIFIED：本机这一次没验到「增量能到」，不能据此断言产品坏了。
    add('stream.deltaReceived', delivery.deltaOk ? 'PASS' : 'UNVERIFIED', delivery.note);
    add('stream.consistency', delivery.consistent ? 'PASS' : 'UNVERIFIED',
      delivery.consistent ? '全文与增量逐字一致' : delivery.note);

    // ---- ③ 工具调用 + **真实结果往返**（复审指出的第二个缺陷）----
    //
    // 旧实现只「发送 → 解析调用」就收尾，注释却写成「工具结果回填后能收束」。
    // 现在真的做往返：解析出调用 → 本地执行 read → 把结果作为 mcp_action:"result"
    // 回填进**同一个**网页会话（fresh:false）→ 解析第二轮。
    let loopText = '';
    let loopResult = null;
    try {
      await waitForSendGap('2/3');
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
      return finalize();
    }
    const authoritative = String(loopResult?.text || loopText || '');
    mark('end');   // 第二轮收束：下一次调用的 end-to-start 锚点
    const parsed = parseAgentReply(authoritative, { tools: toolSchema });
    const calls = parsed?.calls || [];
    add('tool.callParsed', calls.length > 0 ? 'PASS' : 'UNVERIFIED',
      calls.length > 0
        ? `解析出 ${calls.length} 条：${calls.map((c) => c.name).join(', ')}`
        : '本轮没有产出可解析的调用（模型可能直接回答了，也可能是漂移——需要人工判读原始回复）');

    if (calls.length > 0) {
      // 真的执行 read（路径限定在包内，且只读），再把结果回填进同一网页会话。
      const call = calls.find((c) => c.name === 'read') || calls[0];
      const rel = String(call?.arguments?.path ?? 'README.md');
      const abs = path.resolve(PKG, rel);
      // 安全线：只允许读包内文件，不把任意路径交给网页模型指定的参数。
      const inside = abs.startsWith(PKG + path.sep) || abs === PKG;
      let toolOutput = '';
      let toolError = '';
      if (!inside) { toolError = `拒绝读取包外路径：${rel}`; }
      else {
        try { toolOutput = fs.readFileSync(abs, 'utf8').slice(0, 1500); }
        catch (e) { toolError = String(e?.message || e); }
      }
      const resultMsg = '```json\n' + JSON.stringify(toolError
        ? { mcp_action: 'result', name: call.name, status: 'error', error: toolError }
        : { mcp_action: 'result', name: call.name, status: 'success', output: toolOutput }) + '\n```';

      // 回填进**同一个**网页会话：fresh:false（不新开会话，否则往返无意义）。
      let secondText = '';
      let secondResult = null;
      try {
        await waitForSendGap('3/3（回填工具结果）');
        secondResult = await driver.sendTurn(
          'site-verify-loop',
          resultMsg + '\n请基于以上真实工具结果给一行结论并收束，不要再调用工具。',
          { fresh: false, model: modelId, onDelta: (d) => { secondText += d; } },
        );
      } catch (err) {
        const code = err?.code || '';
        add('tool.resultRoundTrip', /CAPTCHA|RATE_LIMIT/.test(code) ? 'BLOCKED' : 'FAIL',
          `第二轮（回填结果）失败：${code || '(no code)'}: ${String(err?.message || err).slice(0, 120)}`);
        return finalize();
      }
      const secondBody = String(secondResult?.text || secondText || '');
      // 判据分两层，缺一不可：
      //   ① 第二轮**真的收到回复**（往返闭环成立）；
      //   ② **同一个会话**（驱动回话里带 sessionId，且与首轮一致）——否则「回填」
      //      可能进了一个新会话，那不是往返而是两次独立提问。
      const firstSid = loopResult?.sessionId ?? null;
      const secondSid = secondResult?.sessionId ?? null;
      const sameSession = Boolean(firstSid && secondSid && firstSid === secondSid);
      const gotReply = secondBody.trim().length > 0;
      add('tool.resultRoundTrip', (gotReply && sameSession) ? 'PASS' : 'UNVERIFIED',
        gotReply
          ? (sameSession
            ? `第二轮收到 ${secondBody.trim().length} 字，会话一致（${String(secondSid).slice(0, 24)}）`
            : `第二轮收到回复但**会话 id 不一致**（首轮 ${firstSid ?? 'null'} / 次轮 ${secondSid ?? 'null'}）`
              + '——这更像两次独立提问，不算往返闭环')
          : '第二轮没有任何回复——工具结果可能没被网页受理');
    } else {
      add('tool.resultRoundTrip', 'UNVERIFIED', '首轮没有可解析的调用，无从做结果往返');
    }

    // ---- ④ 会话连续性/收束：驱动报告了收束原因才谈得上「收得住」----
    const diag = await driver.diagnostics?.().catch(() => null);
    const endReason = diag?.lastEndReason ?? st.lastEndReason ?? null;
    add('turn.settled', endReason ? 'PASS' : 'UNVERIFIED', endReason ? `收束原因=${endReason}` : '没有收束读数');

    // 最终状态**完全交给纯函数判定**（四态优先级 + 缺必要项也算不确定）。
    return finalize();
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
  // 计数**直接用纯函数给的那一份**（它已经把未知状态折算进 UNVERIFIED），
  // 不再在这里按原始 status 字符串重数一遍——那会引入第二个真源。
  const c = r.verdict?.counts || {};
  const missing = r.verdict?.missing || [];
  console.log(`  ${r.siteId.padEnd(10)} ${r.status.padEnd(10)} `
    + `PASS=${c.PASS || 0} FAIL=${c.FAIL || 0} BLOCKED=${c.BLOCKED || 0} UNVERIFIED=${c.UNVERIFIED || 0}`
    + (missing.length ? `  缺必要项=${missing.length}` : ''));
}
console.log('\n判读纪律：只有真实页面 + 真实请求支持的才是 PASS；'
  + 'BLOCKED 说明外部条件挡住（未登录/验证码），**不是**产品结论；'
  + 'UNVERIFIED 表示该项没验到（或必要项缺失）——**同样不是通过**。');
console.log('四态优先级：FAIL > BLOCKED > UNVERIFIED > PASS（判定规则见 site-verify-verdict.mjs，'
  + '反向护栏 test/site-verify-verdict.test.mjs）。');