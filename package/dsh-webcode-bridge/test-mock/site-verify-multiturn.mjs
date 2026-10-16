// site-verify-multiturn.mjs — **同一会话多轮 + 调用本地工具**的真机闭环（0.19.82）。
//
// ## 用户第 ③ 项的准确形态
//
// 用户原话：「这一轮最基础的 4 站完成完整同一会话对话完整和调用本地工具：注意每句话的
// 延时！回填。风控时间！按照本插件已有预计真实安排做！！」
// 加后续节奏指令：「每站 1 发、间隔 60s，同一会话最低 3 次来回，回复间隔 30s」。
//
// 与既有 `site-verify.mjs` 的差别（为什么不能直接复用它）：
//
//   | | `site-verify` | 本脚本 |
//   | --- | --- | --- |
//   | 会话 | 第 3 轮**新开一个会话**（`site-verify-loop` + `fresh:true`）| **全程同一个会话**（`fresh:true` 只用在第 1 轮）|
//   | 轮数 | 2 轮有效对话 | **≥3 轮来回** |
//   | 间隔 | 由 `site-verify-pacing` 的 ≥20s 地板 | **同一闸门**，但是按「回复间隔 30s」口径复核 |
//
// ⇒ `site-verify` 证明的是「工具结果能回填同一会话并拿到第二轮」；本脚本证明的是
// 用户要的那件事：**一个会话里连着 3 轮**，其中至少一轮真的调了本地工具、
// 结果回填后模型接着答，且**全程会话 id 不变**。
//
// ## 判据（任一条不成立即该轮 UNVERIFIED / FAIL，不许写成通过）
//
//   ① 第 1 轮：登录判定 + 发送成功（正文非空）；
//   ② 第 2 轮：**同一会话**（sessionId 与前一轮逐字相同），且模型产出可解析的
//      本地工具调用（`read`）；
//   ③ 本地真的执行该调用（只读、限定包内路径），结果以 `mcp_action:"result"`
//      回填**同一会话**；
//   ④ 第 3 轮：**同一会话**，且模型读到了工具结果（回复提到被读文件里的可核对串）；
//   ⑤ 全程 `turn.settled` 有读数。
//
// ⑤ 里那条「可核对串」是本脚本的**关键设计**：不满足于「有回复」，而是让工具读一个
// **只可能来自真实执行**的标记（`SITE-VERIFY-MARK-<随机>` 写进临时文件），
// 再断言模型回复里出现它 ⇒ 这样「模型是读了工具结果」与「模型在瞎编」才区分得开。
//
// ## 用法
//
//   node test-mock/site-verify-multiturn.mjs --site glm --profile-root "<root>"
//   node test-mock/site-verify-multiturn.mjs --site glm --profile-root "<root>" --dry-run
//
// ⚠ **真机发送脚本**：`--dry-run` 只打印将要说的话与将等待的秒数，**零发送**。
//   真实发送必须由 Lead 主裁判按 `.tmp/real-lane/GATE.md` 串行放行。
import { createBrowserDriver } from '../lib/browser-driver.js';
import { getSite, SITES } from '../lib/providers.js';
import { slotProfileDir, DEFAULT_SLOT } from '../lib/accounts.js';
import { serializeFirstTurn, parseAgentReply } from '../lib/agent-preset.js';
import { planSendGap, sleepMs, MIN_SEND_GAP_MS } from './site-verify-pacing.mjs';
import { sameSessionVerdict } from './site-verify-verdict.mjs';import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flagValues(name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && i + 1 < argv.length) out.push(argv[i + 1]);
  }
  return out;
}

const siteIds = flagValues('--site');
const DRY = argv.includes('--dry-run');
if (!siteIds.length) {
  console.error('用法：node test-mock/site-verify-multiturn.mjs --site <站点id> --profile-root "<root>" [--dry-run]');
  process.exit(1);
}
const profileArg = flagValues('--profile-root')[0] || flagValues('--profile')[0];
const PROFILE = profileArg || process.env.REAL_PROFILE
  || path.join(os.homedir(), '.dsh', 'webcode-edge-profile');
const HEADLESS = process.env.REAL_HEADLESS !== '0';
/** 回复间隔下限（用户指令「回复间隔 30s」）——比质控地板更严，取较大者。 */
const REPLY_GAP_MS = Number(process.env.REPLY_GAP_MS || 30_000);

const toolSchema = [
  { name: 'read', description: '读取本地文件文本内容。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

function readSettingsQuiet(profileRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(profileRoot, 'webcode-settings.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 真机原始回复留档（**opt-in**：`SV_CAPTURE_REPLIES=1`）。
 *
 * ## 为什么需要它（2026-10-16 新发现的取证缺口，long-term-issues #66）
 *
 * `appendReplyLog` 的调用点**只在 `lib/index.js`**（产品适配器路径：
 * `:1944` / `:2235` / `:2247`），而本脚本走的是 **driver 直连**
 * （`createBrowserDriver` + `sendTurn`）⇒ **不经过那条路径**。
 * 后果：本轮 item ③ 已在 glm/zai 跑出完整工具闭环，但 `~/.dsh/logs/` 里
 * **glm 的最后真机条目停在 2026-09-28、kimi 停在 09-27、zai 零条**。
 * ⇒ 第 ④ 项（按厂家适配工具调用）要的「各站原生形状」，**取证通道里根本没有**。
 *
 * ## 两条硬约束（写清楚，别让下一个人以为它会污染取证数据）
 *
 *   ① **只写 `.tmp/real-lane/out/`**，**绝不**碰 `~/.dsh/logs/`——那份目录是真机
 *      取证的唯一原始记录，而它**已经被测试合成数据污染过一次**（#73，2065/3644 条）。
 *      再往里写脚本自己的产物，等于把同一个坑挖第二次。
 *   ② **默认关闭**：真机跑只在需要取形状时开（加了写盘就有 IO 与体积成本）。
 *
 * 落盘形状**刻意与 `reply-log.js` 的头行同构**（`=== webcode-bridge raw reply === | …`），
 * 这样第 ④ 项的审计脚本可以**同一套解析逻辑**读它——不另写一份格式。
 *
 * @param {string} dir 输出目录（本脚本固定传 `.tmp/real-lane/out`）
 * @param {object} o `{ site, round, sessionId, note, text, chars, calls }`
 * @returns {string|null} 落盘路径；未开启或失败时 null
 */
function captureReply(dir, o = {}) {
  if (process.env.SV_CAPTURE_REPLIES !== '1') return null;
  try {
    const text = String(o.text ?? '');
    if (!text.trim()) return null;              // 空回复没有形状价值，不落
    const bits = [
      new Date().toISOString(),
      `v=${o.version || 'site-verify-multiturn'}`,
      `site=${o.site}`,
      `session=${o.sessionId ?? '-'}`,
      `chars=${Number(o.chars ?? text.length)}`,
      `calls=${Number(o.calls ?? 0)}`,
      `note=${o.note || 'raw reply, verbatim'}`,
      `round=${o.round ?? '-'}`,
    ];
    const file = path.join(dir, `multiturn-replies.${o.site}.log`);
    fs.appendFileSync(file, `=== webcode-bridge raw reply === | ${bits.join(' | ')}\n${text}\n=== webcode-bridge raw reply === end\n`);
    return file;
  } catch { return null; }
}

/**
 * 「这两轮是不是同一个会话」——判定在 `site-verify-verdict.mjs`（纯函数，可离线反向验证）。
 * 本文件只负责取两份身份（`sessionId` 与槽锚），**不另写一份判定**（与
 * `site-verify-pacing.mjs` 只调产品真函数同一条纪律）。
 */
function readSlotAnchor(driver) {
  try {
    const slot = driver.status?.()?.sessionSlot || {};
    if (slot.webSessionId) return { kind: 'webSessionId', value: String(slot.webSessionId), source: slot.source || null };
    if (slot.landedUrl) return { kind: 'landedUrl', value: String(slot.landedUrl), source: slot.source || null };
    return { kind: 'none', value: null, source: slot.source || null };
  } catch {
    return { kind: 'none', value: null, source: null };
  }
}

function pickModel(site) {
  const m = Array.isArray(site.models) ? site.models[0] : null;
  if (!m?.id) return null;
  return `${site.id}:${m.id}`;
}

/**
 * 造一个**只可能来自真实工具执行**的标记文件，返回 { abs, mark, rel }。
 *
 * 为什么不用 README.md 这种公共文件：模型见过太多 README 内容，回复里出现「读到」
 * 无法区分「真读了」与「猜的」。标记是随机串，**只存在于本机临时文件**。
 */
function makeMarkFile() {
  const mark = 'SV-MARK-' + Math.random().toString(36).slice(2, 10).toUpperCase();
  const rel = '.tmp/sv-multiturn-mark.txt';
  const abs = path.resolve(PKG, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `站点验收标记：${mark}\n（本文件由 test-mock/site-verify-multiturn.mjs 生成，仅用于真机闭环取证）\n`, 'utf8');
  return { abs, mark, rel };
}

async function runSite(siteId) {
  const site = getSite(siteId);
  if (!site) return { siteId, status: 'FAIL', checks: [{ name: 'site.registered', status: 'FAIL', detail: '未知站点 id' }], verdict: { counts: { PASS: 0, FAIL: 1, BLOCKED: 0, UNVERIFIED: 0 }, missing: [], reasons: [] } };
  const checks = [];
  const add = (name, status, detail = '') => {
    checks.push({ name, status, detail });
    console.log(`  ${status.padEnd(10)} ${name}${detail ? '  — ' + detail : ''}`);
  };
  const profileDir = slotProfileDir(PROFILE, siteId, DEFAULT_SLOT, { primary: site.mountAtRelayRoot === true });
  const settings = readSettingsQuiet(PROFILE);
  const modelId = pickModel(site);
  const markFile = makeMarkFile();

  // 三轮将要说的话（**逐字可核对**；清一色是长句，避免用户点名的「太短触发风控」）。
  const TURNS = [
    '请你先用一句话说明你是什么模型，然后用三到五句话简单介绍一下你自己能做什么、'
      + '以及你在回答问题时的一般步骤。请正常展开写，不要只回一两个字。',
    '现在请你调用 read 工具读取这个文件：' + markFile.rel
      + '，把文件里出现的那一行标记原样告诉我。读完之后先用一句话确认你已经读到了，再简要说明你从文件里看到了什么。',
    '很好。请把你刚才从文件里读到的那一行标记**逐字**再写一遍，并说明它是通过本地工具读取得到的。'
      + '请给出完整的一小段话，不要只回两个字。',
  ];

  console.log(`\n=== 同一会话多轮闭环：${siteId} ===`);
  console.log(`  profile=${profileDir}`);
  console.log(`  模型=${modelId}  标记=${markFile.mark}  间隔地板=${MIN_SEND_GAP_MS / 1000}s  回复间隔=${REPLY_GAP_MS / 1000}s`);
  console.log('  将发送的三轮（逐字）：');
  TURNS.forEach((t, i) => console.log(`    ${i + 1}) ${t}`));

  if (DRY) {
    console.log('\n  --dry-run：零发送。以下是按当前设置会等待的间隔计划：');
    let lastEnd = null;
    let lastSend = null;
    for (let i = 0; i < TURNS.length; i++) {
      const plan = planSendGap({
        settings, accountKey: siteId, siteId,
        now: Date.now(), lastSendAt: lastSend, lastEndAt: lastEnd,
        floorMs: Math.max(MIN_SEND_GAP_MS, REPLY_GAP_MS),
      });
      console.log(`    第 ${i + 1} 轮前等待 ${Math.round(plan.waitMs / 1000)}s `
        + `（采用 ${Math.round(plan.gapMs / 1000)}s = max(设置 ${Math.round(plan.configuredMs / 1000)}s, 下限 ${Math.round(plan.floorMs / 1000)}s)，基准 ${plan.basis}）`);
      lastSend = Date.now(); lastEnd = Date.now() + 5000;   // 假想一轮 5s
    }
    return { siteId, status: 'DRY', checks, verdict: { counts: { PASS: 0, FAIL: 0, BLOCKED: 0, UNVERIFIED: 0 }, missing: [], reasons: [] }, dryRun: true };
  }

  const driver = createBrowserDriver({
    siteId,
    site: site.origin + '/',
    profileDir,
    headless: HEADLESS,
    requestTimeoutMs: 110_000,
    // 诊断开关（`SV_DEBUG=1`）：驱动的 `log()` 默认静音（正常跑只要四态读数），
    // 但发送失败时**唯一**能回答「到底点没点、ready 没有、输入框多少字」的就是
    // 它那行 `send path:` 日志——而它是在任何点击**之前**发出的，所以打开它
    // 不会多发一条消息。
    logger: {
      log: process.env.SV_DEBUG === '1' ? (...a) => console.log('    [log]', ...a) : () => {},
      warn(...a) { console.log('    [warn]', ...a); },
      error(...a) { console.log('    [err]', ...a); },
    },
  });

  const gapState = { send: null, end: null };
  const waitGap = async (label) => {
    const plan = planSendGap({
      settings, accountKey: siteId, siteId,
      now: Date.now(), lastSendAt: gapState.send, lastEndAt: gapState.end,
      // 用户指令「回复间隔 30s」比质控地板更严 ⇒ 取较大者
      floorMs: Math.max(MIN_SEND_GAP_MS, REPLY_GAP_MS),
    });
    add('gap.' + label, 'PASS',
      `间等待 ${Math.round(plan.waitMs / 1000)}s（采用 ${Math.round(plan.gapMs / 1000)}s = max(设置 ${Math.round(plan.configuredMs / 1000)}s, 下限 ${Math.round(plan.floorMs / 1000)}s)，基准 ${plan.basis}）`);
    if (plan.waitMs > 0) {
      console.log(`    [gap] ${label}：等待 ${Math.round(plan.waitMs / 1000)}s`);
      await sleepMs(plan.waitMs);
    }
    gapState.send = Date.now();
  };

  try {
    const conn = await driver.connect();
    if (!conn?.loggedIn) {
      add('login.loggedIn', 'BLOCKED', `未登录（${profileDir}）`);
      return { siteId, status: 'BLOCKED', checks, verdict: { counts: { PASS: 0, FAIL: 0, BLOCKED: 1, UNVERIFIED: 0 }, missing: [], reasons: [] } };
    }
    add('login.loggedIn', 'PASS', profileDir);
    const st = driver.status?.() || {};
    add('login.basis', st.loginBasis === 'probe-fallback' ? 'UNVERIFIED' : 'PASS',
      st.loginBasis === 'probe-fallback' ? '登录靠输入框兜底 ⇒ 不确定' : `basis=${st.loginBasis}`);

    // ---- 第 1 轮：同一会话的**起点**（fresh:true 只此一次）----
    let text1 = '';
    await waitGap('1/3');
    const r1 = await driver.sendTurn('sv-multi',
      serializeFirstTurn({ messages: [{ role: 'user', content: TURNS[0] }], tools: toolSchema, model: { id: modelId } }),
      { fresh: true, model: modelId, onDelta: (d) => { text1 += d; } });
    gapState.end = Date.now();
    const body1 = String(r1?.text || text1 || '');
    captureReply(outDir, { site: siteId, round: 1, sessionId: r1?.sessionId, text: body1, note: 'raw reply, verbatim' });
    add('turn1.text', body1.trim().length > 0 ? 'PASS' : 'FAIL', `${body1.trim().length} 字`);
    const sid1 = r1?.sessionId ?? null;
    const anchor1 = readSlotAnchor(driver);

    // ---- 第 2 轮：要求调工具；**同一会话**（fresh:false）----
    let text2 = '';
    await waitGap('2/3');
    const r2 = await driver.sendTurn('sv-multi', TURNS[1],
      { fresh: false, model: modelId, onDelta: (d) => { text2 += d; } });
    gapState.end = Date.now();
    const body2 = String(r2?.text || text2 || '');
    const parsed = parseAgentReply(body2, { tools: toolSchema });
    const calls = parsed?.calls || [];
    captureReply(outDir, { site: siteId, round: 2, sessionId: r2?.sessionId, text: body2, calls: calls.length, note: 'raw reply, verbatim' });
    const sid2 = r2?.sessionId ?? null;
    const anchor2 = readSlotAnchor(driver);
    add('turn2.text', body2.trim().length > 0 ? 'PASS' : 'FAIL', `${body2.trim().length} 字`);
    const same12 = sameSessionVerdict(anchor1, anchor2, sid1, sid2);
    add('session.same.1-2', same12.ok ? 'PASS' : 'UNVERIFIED',
      `第 1 轮 → 第 2 轮：${same12.detail}`);
    add('turn2.callParsed', calls.length > 0 ? 'PASS' : 'UNVERIFIED',
      calls.length ? `${calls.map((c) => c.name).join(', ')}` : '第 2 轮没有可解析调用（需人工判读原文）');

    // ---- 工具真的执行 + 回填同一会话；第 3 轮读回标记 ----
    if (calls.length > 0) {
      const call = calls.find((c) => c.name === 'read') || calls[0];
      const rel = String(call?.arguments?.path ?? markFile.rel);
      let output = '';
      let errText = '';
      const abs = path.resolve(PKG, rel);
      if (!(abs.startsWith(PKG + path.sep) || abs === PKG)) errText = `拒绝包外路径：${rel}`;
      else { try { output = fs.readFileSync(abs, 'utf8'); } catch (e) { errText = String(e?.message || e); } }
      const resultMsg = '```json\n' + JSON.stringify(errText
        ? { mcp_action: 'result', name: call.name, status: 'error', error: errText }
        : { mcp_action: 'result', name: call.name, status: 'success', output }) + '\n```';
      add('tool.executed', (!errText && output.includes(markFile.mark)) ? 'PASS' : 'FAIL',
        errText ? errText : `读到标记 ${markFile.mark}（${output.length} 字符）`);

      let text3 = '';
      await waitGap('3/3（回填工具结果）');
      const r3 = await driver.sendTurn('sv-multi', resultMsg + '\n' + TURNS[2],
        { fresh: false, model: modelId, onDelta: (d) => { text3 += d; } });
      gapState.end = Date.now();
      const body3 = String(r3?.text || text3 || '');
      captureReply(outDir, { site: siteId, round: 3, sessionId: r3?.sessionId, text: body3, note: 'raw reply, verbatim' });
      const sid3 = r3?.sessionId ?? null;
      const anchor3 = readSlotAnchor(driver);
      add('turn3.text', body3.trim().length > 0 ? 'PASS' : 'FAIL', `${body3.trim().length} 字`);
      const same23 = sameSessionVerdict(anchor2, anchor3, sid2, sid3);
      add('session.same.2-3', same23.ok ? 'PASS' : 'UNVERIFIED',
        `第 2 轮 → 第 3 轮：${same23.detail}`);
      // ★ 决定性判据：第 3 轮回复里出现**只存在于本机临时文件**的随机标记
      const gotMark = body3.toUpperCase().includes(markFile.mark.toUpperCase());
      add('turn3.readsToolResult', gotMark ? 'PASS' : 'UNVERIFIED',
        gotMark ? `第 3 轮回复里出现真实标记 ${markFile.mark}（证明读过工具结果）`
          : `第 3 轮回复里**没有**出现标记 ${markFile.mark} ⇒ 无法证明它读了工具结果（不是「通过」）`);
    } else {
      add('tool.executed', 'UNVERIFIED', '第 2 轮没有可解析调用，无从执行');
      add('turn3.readsToolResult', 'UNVERIFIED', '没有工具往返，第 3 轮无从验');
    }

    const diag = await driver.diagnostics?.().catch(() => null);
    add('turn.settled', diag?.lastEndReason ? 'PASS' : 'UNVERIFIED', `收束原因=${diag?.lastEndReason ?? '(无)'}`);
  } catch (err) {
    const code = err?.code || '';
    add('send', /CAPTCHA|RATE_LIMIT|NEED_LOGIN/.test(code) ? 'BLOCKED' : 'FAIL',
      `${code || '(no code)'}: ${String(err?.message || err).slice(0, 160)}`);
  } finally {
    await driver.close?.().catch(() => {});
  }

  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, UNVERIFIED: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  const status = counts.FAIL > 0 ? 'FAIL' : counts.BLOCKED > 0 ? 'BLOCKED' : counts.UNVERIFIED > 0 ? 'UNVERIFIED' : 'PASS';
  return { siteId, status, counts, checks };
}

for (const siteId of siteIds) {
  // eslint-disable-next-line no-await-in-loop
  const r = await runSite(siteId);
  console.log(`\n  ⇒ ${r.siteId} 四态=${r.status} `
    + `PASS=${r.counts?.PASS ?? 0} FAIL=${r.counts?.FAIL ?? 0} BLOCKED=${r.counts?.BLOCKED ?? 0} UNVERIFIED=${r.counts?.UNVERIFIED ?? 0}`);
  if (r.dryRun) console.log('    （--dry-run：以上为计划，未发送任何消息）');
}
console.log('\n判读纪律：只有真实页面 + 真实请求支持的才是 PASS；'
  + 'UNVERIFIED 表示该项没验到 —— **不是通过**。');
