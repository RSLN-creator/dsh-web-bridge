// web-control.js — control-plane routes for the web side of the bridge.
//
// Mounted twice on purpose:
//   • on the DSH webServer as same-origin /__webcode/* routes (primary; the
//     client panel uses these, no CORS and no cross-site exposure), and
//   • on the local relay (127.0.0.1) as /bridge/web/* fallbacks for standalone
//     use — guarded by the anti-CSRF filter below.
//
// Security posture (mirrors deepseek-web-import's, tightened):
//   • Host header must be loopback — kills DNS-rebinding entirely.
//   • `Sec-Fetch-Site: cross-site` (any public-website browser context) is
//     rejected; non-browser clients (curl) send no such header and pass.
//   • An explicit Origin is only accepted when it points at the same host or
//     sits on the configured allowlist.
//   • The DeepSeek userToken never leaves the driver page: list/history run
//     `fetch` inside the logged-in tab and only distilled JSON comes back.
//   • Responses never echo tokens; errors are fixed-text; bodies are bounded.

import { listAllModels, resolveWebModel, SITES, getSite } from './providers.js';
import { DEFAULT_SLOT, normalizeSlot, formatAccountKey, parseAccountKey, normalizeAccounts } from './accounts.js';
import { buildPromptVariants, buildSitePromptRows } from './prompt-variants.js';
// 站点提示词文件的**唯一路径来源**（0.16.38）：设置页要「指向本地提示词文件」，
// 路径就必须与真正落盘/读回用的是同一个函数——前端自己拼路径，迟早与落盘分叉。
import { sitePromptPath, DEFAULT_PROMPT_STORE_DIR } from './prompt-store.js';
import { composerWaitLine, composerWaitPillLabel, waitStatDetailRows, waitStatRows, waitStatBlocks, formatDuration, formatElapsed, sanitizeWaitStats } from './wait-stats.js';
import { isLoopbackHost, originMatchesHost } from './loopback.js';
import { httpFetch } from './upstream.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BODY_BYTES = 256 * 1024;

/**
 * 「导入登录态」允许的源 profile 根目录（0.14.4）。
 *
 * 与 `openai.js` 的 `/bridge/import-session` 同一口径：只允许 DSH home、桥自己的
 * 驱动 profile、以及本包树内。旧实现（本文件的 `POST session-import`）只校验
 * 「目录存在」，于是任意 `sourceProfileDir` 都能让调用方在磁盘任意位置创建
 * Chromium profile 文件——两条入口敏感度相同（都会把真实登录态复制进桥 profile），
 * 防护强度却一个有一个没有。现在两处共用同一套判定。
 *
 * @param {object} config 插件配置（含 profileDir）
 * @returns {string[]} 解析后的绝对路径清单
 */
export function permittedImportRoots(config = {}) {
  const pkgRoot = path.resolve(import.meta.dirname, '..');
  return [config.profileDir, process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), pkgRoot]
    .filter(Boolean)
    .map((p) => { try { return path.resolve(p); } catch { return null; } })
    .filter(Boolean);
}

/** 目标目录是否落在任一允许根之内（含根本身）。 */
export function isWithinRoots(target, roots = []) {
  let resolved = null;
  try { resolved = path.resolve(String(target)); } catch { return false; }
  return roots.some((b) => {
    const rel = path.relative(b, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/** "GET status" → ['GET', 'status']. */
function splitActionKey(key) {
  const i = String(key).indexOf(' ');
  if (i <= 0) return [String(key), ''];
  return [key.slice(0, i), key.slice(i + 1)];
}

/** Index one action table as suffix → Set(methods).
 *
 * 这是控制面的**唯一真相**：进程内分派器（handle）与宿主路由挂载
 *（lib/index.js 的 webServer.register）都从它派生。
 *
 * 动机（真机 2026-09-13 取证）：index.js 曾手写一份 routes 数组，
 * verify-login / site-probe / session-import 三个 action 加进了本文件的表、
 * 却忘了加进那份数组 —— 设置面板的「检测 / 独立窗口 / 导入登录态」按钮
 * 全部落到 DSH webServer 的未知 POST 兜底（405 + 空 body），客户端
 * response.json() 于是抛 “unexpected end of JSON data”。
 * 让挂载清单从 action 表派生，这类「加了 action 忘了挂载」不可能再发生。 */
export function routeIndex(actions) {
  const index = new Map();
  for (const key of Object.keys(actions)) {
    const [method, suffix] = splitActionKey(key);
    if (!suffix) continue;
    if (!index.has(suffix)) index.set(suffix, new Set());
    index.get(suffix).add(method);
  }
  return index;
}

/** 挂载清单（index.js 用）：全部 action 的 suffix，去重后按首次出现顺序。 */
export function controlRoutes(actions) {
  return [...routeIndex(actions).keys()];
}

/** 本机 Edge 的默认 User Data 目录（导入登录态时的默认源）。 */
function defaultEdgeUserDataDir() {
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Microsoft', 'Edge', 'User Data'),
      path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
    ]
    : process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support', 'Microsoft Edge')]
      : [path.join(home, '.config', 'microsoft-edge')];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* next */ } }
  return candidates[0] || '';
}

/** Fixed CORS headers for the relay fallback mount (OpenAI-front parity). */


export function createWebControl(deps = {}) {
  const {
    driver,
    relay,
    config = {},
    host = {},          // { listWorkspaces?, importToWorkspace? } — DSH-side, optional
    logger = console,
    presetInfo = null,  // () → { prompt, model, tools, at } — last first-turn text
    settingsStore = null, // { get: () => ({extraPrompt}), set: (value) => ({extraPrompt}) }
    contextWindowOf = null, // (model) → number — 与 resolveModel/预算闸同一个取值函数
    waitStatsOf = null,     // (sessionId?) → { total, session } — 等待发送时长累计账本
    // (sessionId?) → { team, subAgents, teamError, subAgentsError } — 真实花名册
    // 的取值函数（0.15.0）。由 lib/index.js 注入，内部走 lib/roster.js。
    // 缺省 null 时 /status 给空数组 + 'roster-not-wired'，独立启动的桥
    // （无 DSH 上下文，也就没有 agents/sessionProjections 服务）因此仍然可用。
    rosterOf = null,
    // (absPath) → Promise<{ok:boolean, error?:string}>：用**系统默认程序**打开一个
    // 本机文件（0.16.38）。由宿主侧注入（argv 调用，不经 shell）；缺省 null 时
    // 「打开文件」这条路如实回 unavailable，而不是假装成功。
    openPath = null,
  } = deps;
  const log = (...a) => logger.log?.('[webcode-web]', ...a);
  const warn = (...a) => logger.warn?.('[webcode-web]', ...a);
  const allowedOrigins = new Set((config.allowedOrigins || []).map((s) => String(s).toLowerCase()));

  /**
   * 站点提示词文件的存储根目录（0.16.38）——与 prompt-store 的写入侧同一条判据。
   *
   * 环境变量 `WEBCODE_PROMPT_STORE_DIR` 优先（运维/测试用），`'off'` 表示显式关闭
   * 落盘；否则用 prompt-store 自己的默认目录（`~/.dsh/webcode`）。
   *
   * 为什么在本文件里也读一次环境变量：设置面要**如实显示**文件会落在哪里，而
   * prompt-store 的 writePromptFiles 只在真正落盘时才解析目录。两处若各写一份
   * 判据就会分叉（界面指向 A、文件落在 B），因此这里复用同一个常量与同一套语义，
   * 只有「读环境变量」这一步是重复的，且它读的就是同一个变量名。
   *
   * @returns {string} 绝对目录，或字符串 'off'
   */
  function promptStoreDir() {
    const requested = process.env.WEBCODE_PROMPT_STORE_DIR;
    if (requested === 'off') return 'off';
    return requested || DEFAULT_PROMPT_STORE_DIR;
  }

  /**
   * 从请求体里取出 **accountKey**（0.14.7 账户槽）。
   *
   * 请求体有两条历史形态，必须同时支持：
   *   • `{ siteId: 'glm' }`            —— 0.14.6 及以前的全部调用方
   *   • `{ siteId: 'glm', slot: '2' }` —— 0.14.7 新增
   *
   * 返回 `glm` / `glm#2`。`fallback` 用于 login 这种「空值要留给调用方兜底默认站点」
   * 的场景（它自己会 `|| 'deepseek'`），其余调用方传默认 `'deepseek'`。
   *
   * 非法 slot 一律**当作默认槽**而不是抛错：这是控制面入口，一个拼错的槽不该让
   * 整个面板报 500；用户看到的是「没切过去」，而不是一片红色错误。
   */
  function accountKeyOf(body, { fallback = 'deepseek' } = {}) {
    const siteId = String(body?.siteId || '').trim() || fallback;
    if (!siteId) return '';
    const slot = normalizeSlot(body?.slot);
    if (!slot || slot === DEFAULT_SLOT) return siteId;
    return formatAccountKey(siteId, slot);
  }

  /**
   * CORS headers for one request: reflect ONLY allowlisted origins. A wildcard
   * here would turn any simple POST from a hostile local page into a
   * cross-origin READ of conversation data — never send `*`.
   * Same-origin mounts (DSH webServer) get no CORS headers at all.
   */
  function corsHeaders(req) {
    const origin = String(req.headers.origin || '');
    if (origin && allowedOrigins.has(origin.toLowerCase())) {
      return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        Vary: 'Origin',
      };
    }
    return {};
  }

  /** True when this request cannot come from a hostile web page. */
  function csrfSafe(req) {
    const hostHeader = String(req.headers.host || '');
    // DNS 重绑定防护：Host 必须是回环名称族。**包含 <site>.localhost 子域**——
    // 右栏的站点 iframe 就住在那些源上，控制面必须在那上面照常可用（真机
    // 2026-09-13：旧正则只认裸 localhost，子域上的 /__webcode/* 全被 403）。
    if (!isLoopbackHost(hostHeader)) return false;
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (site === 'cross-site') return false;                        // public-website browser
    const origin = String(req.headers.origin || '');
    if (origin) {
      // Only exact same-origin (scheme+host+port of THIS server) or the
      // explicit allowlist may carry an Origin. Any other loopback port is a
      // different (potentially hostile) application, not "us".
      if (allowedOrigins.has(origin.toLowerCase())) return true;
      return originMatchesHost(origin, hostHeader);
    }
    return true; // curl / same-origin GET img — no Origin header
  }

  function sendJson(req, res, data, status = 200) {
    const text = JSON.stringify(data);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...corsHeaders(req),
    });
    res.end(text);
  }

  function readBody(req, limit = MAX_BODY_BYTES) {
    return new Promise((resolve) => {
      const chunks = [];
      let total = 0;
      let tooLarge = false;
      req.on('data', (c) => {
        total += c.length;
        if (total > limit) { tooLarge = true; req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooLarge) return resolve({ __tooLarge: true });
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch { resolve({}); }
      });
      req.on('error', () => resolve({}));
    });
  }

  /**
   * 等待发送时长的**唯一**展示载荷（0.14.4）。
   *
   * 为什么在服务端算文案：client.cjs 是单文件 bundle，import 不到 lib/ 的模块。
   * 若在浏览器侧再写一份时长格式化，输入框底下那条与设置页那条迟早会长得不一样，
   * 用户就无法信任任何一个数。这里一次算清，两边都读同一份结果。
   *
   * @param {string} [sessionId] 要附带的会话账本（缺省只回累计）
   * @param {object} [metrics] 本轮 relay.metrics，用于「距上次发送」注解
   */
  function waitStatsPayload(sessionId, metrics) {
    const snap = waitStatsOf ? waitStatsOf(sessionId) : { total: null, session: null };
    const total = snap?.total || null;
    const session = snap?.session || null;
    // 0.16.24：在途等待（正在等的那一段）。服务端每次现算文案（`live` 分支），
    // 客户端只管渲染——这样 13px 单行药丸与点击面板给出的仍是同一个数。
    const live = snap?.live || null;
    const now = Number(snap?.now) || Date.now();
    return {
      ok: true,
      total,
      session,
      // 客户端据此判断「还要不要更快地回来问」：在途 = 数字每秒都在变。
      live: live ? { startedAt: live.startedAt, endsAt: live.endsAt, baseMs: live.baseMs, kind: live.kind } : null,
      now,
      // 设置页「累计」区块直接渲染这些行（0.15.10 起该区块已从设置页移除，
      // 字段保留：它是累计账本的公开只读面，curl 与旧前端仍可核对）。
      rows: total ? waitStatRows(total) : [],
      // 0.16.39：设置页「速度与等待」卡里那块只读统计区直接渲染这两块。
      // 与药丸同一份账本、同一个 formatDuration——两处各算一套的话，用户在设置页
      // 与输入框底下会读到两个数（这条纪律在 wait-stats.js 开头写着）。
      statBlocks: waitStatBlocks({ session, total, metrics }),
      // 输入框底下那一条速览（数据不足时为 null，前端据此不渲染）。
      line: composerWaitLine({ session, metrics }) || (total && total.totalWaitMs > 0
        ? '累计等待发送 ' + formatDuration(total.totalWaitMs)
        : null),
      // 0.15.10：药丸用的短文案（与官方 StatsPills 同为单行 13px），以及点击
      // 面板的详情行。三者同源同口径，避免「药丸一个数、面板另一个数」。
      //
      // 0.16.24：`now` 显式传入而不是让纯函数各取各的时钟——同一份载荷里
      // 药丸、速览、详情行必须基于**同一个时刻**，否则三条路径会差出几十毫秒，
      // 在秒级取整下就足以让两个数不同（「3 s」与「4 s」并存）。
      label: composerWaitPillLabel({ session, metrics, live, now }),
      sessionValue: session ? formatDuration(sanitizeWaitStats(session).totalWaitMs) : '',
      // 面板里的「正在等待」行：与药丸同一套边界（liveElapsedMs），只在在途时有。
      liveValue: live ? formatElapsed(liveElapsedMs(live, now)) : null,
      detailRows: waitStatDetailRows({ session, total, metrics, live, now }),
    };
  }

  /** 在途等待已过的毫秒数（与 liveWaitLabel 同一套边界，供面板显示）。 */
  function liveElapsedMs(live, now) {
    const startedAt = Number(live?.startedAt);
    if (!Number.isFinite(startedAt)) return 0;
    const baseMs = Math.max(0, Math.round(Number(live?.baseMs) || 0));
    const endsAt = Number(live?.endsAt);
    const ceiling = Number.isFinite(endsAt) ? endsAt : Math.max(now, startedAt);
    return baseMs + Math.max(0, Math.min(now, ceiling) - startedAt);
  }

  /** One route table keyed by "METHOD path-suffix". */
  const actions = {
    'POST connect': async (body) => {
      // 侧栏视图按站点连接：未指定时保持 DeepSeek 兼容行为。
      // 0.14.7：body 可带 slot（账户槽）；缺省 = 默认槽，旧调用方零改动。
      const target = relay?.config?.siteConnect?.(accountKeyOf(body));
      if (target) return target.connect();
      return driver.connect();
    },
    // 展示窗口（真实有头 Edge 窗口）：open/close 两个动作 + 状态查询。
    // 与 login/consent 同级敏感度：窗口里是已登录网页会话，因此只接受
    // csrfSafe 的本地请求（同源挂载 / allowlisted origin），不新增暴露面。
    'POST window': async (body) => {
      const opener = relay?.config?.windowOpener;
      if (!opener) return { ok: false, error: 'no driver' };
      // accountKey 而不是裸 siteId（0.14.7）：`glm#2` 的独立窗口开的是账户2
      // 那份 profile，窗口里看到的登录态与自动化轮次用的是同一个。
      const accountKey = accountKeyOf(body);
      const action = body?.action === 'close' ? 'close' : 'open';
      const width = Number(body?.width) || undefined;
      const height = Number(body?.height) || undefined;
      if (action === 'close') return opener(accountKey, 'close');
      return opener(accountKey, 'open', { width, height });
    },
    'GET window': async () => {
      const state = relay?.config?.driverStatus?.();
      const sid = String(state?.siteId || 'deepseek');
      // 顶层 window 字段来自 deepseek 主驱动;聚合 sites 里各站点窗口各自带
      const siteWindow = state?.window ?? state?.sites?.find((s) => s.siteId === sid)?.window ?? null;
      // 聚合各站点窗口：面板按站点行各自显示「已开独立窗口」，不再只认 deepseek。
      const windows = {};
      // 键用 accountKey（0.14.7）：两个账户各自可能开着独立窗口，用 siteId
      // 做键会让「账户2 开了窗口」显示在账户1 那一行。
      for (const s of state?.sites || []) if (s?.window?.open) windows[s.accountKey || s.siteId] = s.window;
      return { ok: true, siteId: sid, window: siteWindow, windows };
    },
    'POST interact': async body => {
      if (!relay?.status().consent) return { ok: false, error: '请在设置中启用网页自动化' };
      return driver.interact(body);
    },
    'GET diagnostics': async () => ({ ok: true, ...(await driver.diagnostics()) }),
    // 附件投递**入口**的只读读数（0.16.3）。
    //
    // 为什么不能让调用方自己去 GET diagnostics 里翻：设置页与排障脚本要的是
    // 一个能直接下结论的答案——「这个站点的页面此刻有没有可用的上传入口」。
    // 把判据留在服务端（与真实投递路径同源），调用方只读结论，不复制形态知识。
    // 这个动作**不上传、不写入、不发送**任何东西，因此可以在真机随时跑。
    'GET attach-entry': async () => {
      const d = await driver.diagnostics();
      const entry = d?.attachEntry ?? null;
      return {
        ok: true,
        siteId: d?.siteId ?? null,
        preview: d?.preview === true,
        // available = 页面上真的存在文件 input。**刻意不用 visible 判定**：
        // 上传入口在各站点几乎都是隐藏 input（由按钮转发点击），按可见性判定
        // 会把「有入口」误报成「没有入口」，那比没有读数更坏。
        available: Boolean(entry && entry.inputs > 0),
        entry,
      };
    },
    // 附件投递**探针**：只上传、**绝不发送**（0.16.3，M5）。
    //
    // 与上面那条只读读数的分工：`GET attach-entry` 回答「入口在不在」（真机读数
    // available:true、accept 含 .md/.txt/.json/.log），本动作回答**下一个问题**：
    // 「上传之后网页到底有没有渲染出附件」。真机失败读数
    // `attachTransport = {fallback:true, code:'ATTACH_NOT_CONFIRMED', total:417276}`
    // 正好卡在这一步，而没有探针时只能「发一条真消息看模型读没读到附件」——
    // 那是拿一次真实会话换一个读数。
    //
    // 为什么必须是 POST（不能做成 GET）：它有副作用（一次真实上传）。
    // GET 会被面板刷新/预取重复触发，同一个上传连发三次就是一次站点风控风险。
    //
    // 返回**平铺**的 `{ ok, evidence, selector, domSnippet, cleaned, chars }`：
    //   · `ok` 的语义是「上传被页面确认」，**不是** HTTP 成功——没确认时同样回
    //     200 并带 `{ ok:false, code:'ATTACH_NOT_CONFIRMED', cleaned, … }` 与现场
    //     （候选选择器 × 命中数 × DOM 片段）。调用方按 ok 判断，不要只看状态码。
    //   · `cleaned` 如实反映清理结果（false = 附件可能仍留在这个输入框里，
    //     下一条消息会带上它，面板必须能说出来）。
    //
    // 副作用纪律：探针会把默认槽驱动所在站点的浏览器拉起来（如果它还没起）；
    // **跨站点探测暂不自动做**——那会顺带启动另一个站点的浏览器 profile，
    // 是调用方看不见的额外副作用，因此显式要求时回一条明确错误。
    'POST attach-probe': async (body) => {
      if (!relay?.status().consent) return { ok: false, error: '请在设置中启用网页自动化' };
      if (typeof driver.probeAttachment !== 'function') {
        return { ok: false, error: 'driver 不支持 attach-probe（注入的测试桩或旧驱动）' };
      }
      const wantSite = String(body?.siteId || '').trim();
      const runningSite = String(driver.status?.()?.siteId || 'deepseek');
      if (wantSite && wantSite !== runningSite) {
        return { ok: false, error: 'attach-probe 只对默认槽站点（' + runningSite + '）生效：'
          + '探测 ' + wantSite + ' 会顺带启动该站点的浏览器 profile，属于看不见的额外副作用，请先连上该站点再探' };
      }
      // 探针是**结构确认**，不是投递：默认正文带时间戳（便于在页面 DOM 里认出这一次），
      // 并硬性截到 20_000 字符——真机最长一轮 417,276 字符（attachTransport.total），
      // 探针不需要那么大，上传越大越可能撞站点限制而把结论污染成「探针本身失败」。
      const PROBE_MAX = 20_000;
      const raw = String(body?.text ?? ('# webcode attach probe\n' + new Date().toISOString() + '\n'));
      const text = raw.slice(0, PROBE_MAX);
      const name = String(body?.name || 'webcode-probe.md').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'webcode-probe.md';
      const r = await driver.probeAttachment(text, { name });
      return {
        ...r,
        // 请求侧读数与结论分开列：一眼能看出「探针收到多少字符 / 真正传了多少」，
        // 以及「是否因为上限被截」（截了就必须说，否则读数会被当成原文长度）。
        requestedChars: raw.length,
        truncated: raw.length > PROBE_MAX,
        cleanupRequested: body?.cleanup !== false,
        siteId: runningSite,
      };
    },
    // 会话槽只读读数（T1）。
    //
    // 回答的问题只有一个，但它是用户报的那条症状的第一现场：「这个会话此刻到底
    // 有没有落在同一个网页会话上，这条记录是怎么来的」。
    //
    // 为什么不能靠 `GET status` 的 conversations 代替：槽为空时那张映射只能回
    // `{}`，而 2026-09-17 20:52 那次事故的现场恰恰是「槽为空 + 页面正停在该网页
    // 会话上」——两者必须能分开读，`source:'url-heal'` 就是把这一态如实说出来
    //（判据在 browser-driver 的 sessionSlotFor，与 status().sessionSlot 同源）。
    //
    // 纯读：不导航、不落盘、不发送。调用方（面板 / curl）可以随时跑：
    //   curl -X POST .../__webcode/session-slot -d '{"sessionKey":"…"}'
    // 省略 sessionKey 时问的是「最近一次 sendTurn 的那个 key」。
    'GET session-slot': async (body) => {
      const key = String(body?.sessionKey || body?.sessionId || '') || null;
      // 三个来源按**具体到笼统**的顺序取，先取到就用：
      //   ① `driver.sessionSlot(key)` —— 驱动自带的按 key 投影，只有它认得
      //      `'url-heal'`（槽为空但页面此刻正停在某个会话上）这一态；
      //   ② `driver.status().sessionSlot` —— 冻结接口里的那一枚读数，旧驱动与
      //      测试替身都是这个形态；
      //   ③ relay 聚合 status 上的同名投影（默认槽驱动）。
      // 控制面**绝不自作主张**去读地址或猜会话 id：那层形态知识归驱动所有。
      const readers = [
        () => (typeof driver?.sessionSlot === 'function' ? driver.sessionSlot(key || undefined) : null),
        () => driver?.status?.()?.sessionSlot ?? null,
        () => relay?.config?.driverStatus?.()?.sessionSlot ?? null,
      ];
      let slot = null;
      for (const read of readers) {
        try { slot = read(); } catch { slot = null; }
        if (slot && typeof slot === 'object') break;
        slot = null;
      }
      const view = slot && typeof slot === 'object'
        ? {
          webSessionId: slot.webSessionId ?? null,
          at: slot.at ?? null,
          source: slot.source === 'url-heal' ? 'url-heal' : (slot.source === 'store' ? 'store' : 'none'),
        }
        : { webSessionId: null, at: null, source: 'none' };
      return {
        ok: true,
        // 'current' = 调用方没给 key，读的是「最近一次 sendTurn 的那个 key」
        //（与 status().sessionSlot 同口径）；给了 key 就原样回显，便于并发核对。
        key: key || 'current',
        siteId: (() => { try { return driver?.status?.()?.siteId ?? null; } catch { return null; } })(),
        sessionSlot: view,
        // 平铺这三个字段：面板与排障脚本可以直接取用，不必再往下钻一层。
        //（同一动作给两种形状是本文件的既有做法，见 'GET status' 同时给
        //  `team` 与 `members`——两端改名不会让另一端读到 undefined。）
        webSessionId: view.webSessionId,
        at: view.at,
        source: view.source,
      };
    },
    'GET status': async (body) => ({
      ok: true,
      build: { hash: config.buildHash || null, version: config.version || null },
      // 花名册的两个分区（用户要求「子代理和team效果需要单独区分」）。
      //
      // 为什么**分两个字段**而不是一个带 type 的数组：两者的信息结构本来就不同
      //（子代理从属于发起它的会话，Team 成员平级、带任务板归属），前端要按不同
      // 缩进与分组渲染（doc/research/agent-ui-design-references.md §4.5）。
      // 合成一个数组会把「谁从属于谁」这个结构丢掉。
      //
      // 0.15.0 起这两个字段接的是**真实数据源**（lib/roster.js）：
      //   • team ← 官方 agentTeams 服务的 listMembers（Team 花名册，带 role/status）；
      //   • subAgents ← 本会话 subagentCatalog 持久化投影（父会话记下的直接子代理目录）。
      // 两个 `*Error` 字段是这次一并加上的：旧实现恒给空数组，于是面板上的
      // 「当前没有正在运行的子代理或 Team 成员」既可能是**确实没有**，也可能是
      // **读不到**（官方包没装、服务未注册、凭据解析失败）——两者长得一模一样。
      // 现在读不到时 `*Error` 非空，面板照实说「读不到花名册」并给出原因，
      // 仍然坚持「不得造假状态」：宁可为空 + 带原因，也不编一个 roster。
      ...(typeof config.rosterOf === 'function' || typeof rosterOf === 'function'
        ? (() => {
          try {
            const r = (rosterOf || config.rosterOf)(body?.sessionId || null) || {};
            const fail = (m) => {
              const msg = `roster-threw: ${String(m).slice(0, 160)}`;
              return { subAgents: [], team: [], tasks: [], subAgentsError: msg, teamError: msg, tasksError: msg };
            };
            try {
              return {
                subAgents: Array.isArray(r.subAgents) ? r.subAgents : [],
                // Team 成员（平级）。`members` 是官方 TeamView 的词，`team` 是
                // 0.15.0 起的旧名——**两个都给**，任何一端的改名都不会让另一端
                // 读到 undefined（本文件顶部记的那一族缺陷正是「一端改了、
                // 另一端不存在」，不值得在同一个字段上再犯一次）。
                team: Array.isArray(r.team) ? r.team : (Array.isArray(r.members) ? r.members : []),
                members: Array.isArray(r.members) ? r.members : (Array.isArray(r.team) ? r.team : []),
                // 任务板是**团队级**事实（官方 TeamView.tasks）：状态、被谁卡住、
                // 写哪些文件、是否就绪。没有它，「Team 成员平级」只剩一个名字。
                tasks: Array.isArray(r.tasks) ? r.tasks : [],
                // 图诊断（0.15.12）：官方逐行事实之外的**图级**视角——就绪集、
                // 当前阻塞点、关键路径、环/自环/悬空边。官方数据里没有这一层，
                // 而任务板面板要回答的正是「为什么整块板没动 / 在等谁 / 还要多久」
                //（对照研究 doc/research/task-board-vs-agentteams-graph.md §3⑧）。
                // 拿不到时为 null，面板如实说「图诊断不可用」，不编造。
                graph: r.graph && typeof r.graph === 'object' ? r.graph : null,
                // 执行语义（0.16.2）：可派发集 / 等依赖 / 等资源 / 可重试 / 终止性 /
                // 结构校验 / 写范围冲突。与 graph 同一性质——是 tasks 的补充视角，
                // 算不出来时为 null 并带 `planError`，**不连坐** tasks 与 graph。
                // 为什么由服务端算：两条轴（依赖 / 资源）的判据必须与成员状态同源，
                // 浏览器侧重算会立刻产生「面板说能开工、服务端说不能」两份真相。
                plan: r.plan && typeof r.plan === 'object' ? r.plan : null,
                planError: r.planError ?? null,
                subAgentsError: r.subAgentsError ?? null,
                teamError: r.teamError ?? r.membersError ?? null,
                tasksError: r.tasksError ?? null,
                // 来源标注（0.16.1）：`service` = 官方 agentTeams 服务，`disk` = 磁盘
                // 回落，`null` = 两边都没读到。卸载 AgentTeams 之后用户看到的应当是
                // `disk`——把这层透出去，用户才能判断「面板空了」是没团队还是没数据源。
                teamSource: r.teamSource ?? null,
                tasksSource: r.tasksSource ?? null,
              };
            } catch (e) {
              return fail(e?.message || e);
            }
          } catch (e) {
            // 花名册读失败**不能**让整个 /status 挂掉：状态页还有登录、
            // 限流、恢复轮次等一堆更要紧的信息，那些与花名册无关。
            const msg = `roster-threw: ${String(e?.message || e).slice(0, 160)}`;
            return {
              subAgents: [], team: [], members: [], tasks: [],
              subAgentsError: msg, teamError: msg, tasksError: msg,
            };
          }
        })()
        : {
          subAgents: [], team: [], members: [], tasks: [],
          subAgentsError: 'roster-not-wired', teamError: 'roster-not-wired', tasksError: 'roster-not-wired',
        }),
      relay: relay ? (({ running, consent, consentPersistent, requireConsent, busy, queueLength, activeRequests, lastError, metrics }) => ({
        running, consent, consentPersistent, requireConsent, busy, queueLength, activeRequests, lastError, metrics,
      }))(relay.status()) : null,
      driver: relay?.config?.driverStatus?.() ?? (driver ? (({ running, busy, loggedIn, needLogin, selectedModel, lastTurn, profileDir, conversations, recoveredTurns, lastRecovered, lastEndReason, lastTimeoutScene, sessionLostCount, lastSessionLost, sessionSlot, sessionCursorInvalidations, sessionSwitchNotices, freshReasons, attachTransport, attachProbe, promptTransport }) => ({
        running, busy, loggedIn, needLogin, selectedModel, profileDir,
        conversationCount: conversations ? Object.keys(conversations).length : 0,
        lastTurn: lastTurn ? { sessionId: lastTurn.sessionId, at: lastTurn.at } : null,
        // T1（0.16.4）：会话连续性的两枚只读读数也必须在**两个入口**上都在——
        // 面板要回答「这个会话有没有落到同一个网页会话上 / 是谁把游标清了」，
        // 缺一枚就会把「读不到」显示成「没发生」（本文件反复吃过这个亏）。
        sessionSlot: sessionSlot ?? { webSessionId: null, at: null, source: 'none' },
        sessionCursorInvalidations: sessionCursorInvalidations ?? 0,
        // 0.16.6：节流改口成「网页会话已切换」提示的次数。同上一条纪律——两个入口
        // 都要带着它，否则「读不到」会被面板显示成「一次都没提示过」。
        sessionSwitchNotices: sessionSwitchNotices ?? 0,
        // 0.16.29：「为什么又新开了一个网页对话」的逐因计数。同上一条纪律——两个
        // 入口都要带着它，否则独立启动时这个问题会重新变成只能靠读日志猜。
        freshReasons: freshReasons ?? {},
        // 0.14.0：这条兜底分支（无 relay 的独立启动）此前把这几个字段丢了，
        // 而 relay 分支的 driverStatus 一直带着它们——于是「网页已回复但桥卡住」
        // 在独立运行时完全没有任何线索。补齐后两个入口的字段集一致。
        recoveredTurns: recoveredTurns ?? 0,
        lastRecovered: lastRecovered ?? null,
        lastEndReason: lastEndReason ?? null,
        lastTimeoutScene: lastTimeoutScene ?? null,
        // C-3：会话槽丢失不再静默（glm 每轮新开对话的根因就是它恒丢）
        sessionLostCount: sessionLostCount ?? 0,
        lastSessionLost: lastSessionLost ?? null,
        // 0.16.3：同一条「两个入口字段集一致」的纪律，投递形态三件套也要在
        // 这条兜底分支上带着——否则独立启动时设置面板会显示「最近一次投递：
        // 无读数」，而真相只是这条分支漏了字段（面板读不到 ≠ 没发生过）。
        attachTransport: attachTransport ?? null,
        attachProbe: attachProbe ?? null,
        promptTransport: promptTransport ?? 'attach',
      }))(driver.status()) : null),
    }),
    // 投递形态与「最近一次投递」的**现成文案**（0.16.3）。
    //
    // 为什么文案在服务端算：原生设置面板（client.cjs）是单文件 bundle，import
    // 不到 lib/ 里的模块——同一条读数在浏览器侧再写一份格式化就是两份真相，
    // 而本项目的既定做法是服务端算好（见 composerWaitLine / waitStatRows 的注释）。
    // 独立设置页（settings-page.js）与原生面板共用这一条路由，因此两边显示逐字
    // 相同，不会出现「面板说成功了、独立页说回落了」。
    //
    // 只读、无副作用：不上传、不发送、不写设置。
    'GET attach-status': async () => {
      const settings = settingsStore ? (settingsStore.get() || {}) : {};
      // 与 browser-driver 的 promptTransportNow 同一判据（只有逐字 'inline' 算纯文本）：
      // 设置面优先于插件 config，两者都没有才落到『attach』默认值。
      const chosen = settings.promptTransport === 'inline' ? 'inline'
        : (config.promptTransport === 'inline' ? 'inline' : 'attach');
      const limit = Number(config.attachInlineLimitChars) > 0 ? Math.floor(Number(config.attachInlineLimitChars)) : 0;
      const st = (relay?.config?.driverStatus?.() ?? (typeof driver?.status === 'function' ? driver.status() : null)) || {};
      const last = st.attachTransport || null;
      const probe = st.attachProbe || null;
      // 0.16.9：站点禁令必须在这里**说清楚**。0.16.7 让 DeepSeek 永不走附件，但本行
      // 与 lastLine 都还在按全局开关描述，于是面板对一个已经不再走附件的站点继续承诺
      // 「超过 60000 字符改走附件」——用户只能看到「附件怎么不好使了」，看不到「这里
      // 就不再走附件了」。判据取自驱动的实际站点，不重复写死站点名单。
      const siteId = st.siteId || null;
      const attachForbidden = st.attachForbidden === true;
      const transportLine = attachForbidden
        ? '纯文本：本站点（' + siteId + '）**永不使用附件投递**——网页收得下附件但读不到内容'
          + '（真机证据：零回复、页面退回根地址），所以无论多长都写输入框。'
          + '附件阈值 ' + limit + ' 在本站点不适用。'
        : (chosen === 'inline'
          ? '纯文本：永远把正文写进输入框（附件投递已关闭）'
          : (limit > 0
            ? '附件投递（默认）：正文超过 ' + limit + ' 字符时改走附件，失败自动回落纯文本'
            : '纯文本：附件阈值 0（附件投递已关闭）'));
      let lastLine;
      if (!last) lastLine = '本会话还没触发过附件投递（正文未超过阈值）。';
      else if (last.code === 'SITE_NO_ATTACH') {
        lastLine = '纯文本（站点禁令：' + (last.siteId || siteId) + ' 不走附件，原始 ' + last.total + ' 字符全量写入输入框）。';
      } else if (last.code === 'TRANSPORT_INLINE') {
        lastLine = '纯文本（设置面选择「纯文本」，原始 ' + last.total + ' 字符）。';
      } else if (last.fallback) {
        // 回落原因必须打到面板（0.16.3 要求）：命中数与 DOM 片段是用户唯一能拿到的现场，
        // 只给一个错误码等于让用户无法判断下一步该改配置还是该等站点修复。
        //
        // 「零命中」与「根本没扫」必须分开说：ATTACH_UNAVAILABLE 是在 setInputFiles
        // **之前**就失败的（页面没有上传入口），那时一次候选扫描都没发生——把它写成
        // 「候选节点全部零命中」会把下一个会话引去改证据选择器，而真因是入口没了。
        const cands = last.diag?.candidates || [];
        const hitCands = cands.filter((c) => c.count > 0);
        const detail = !last.diag
          ? '；未做候选扫描（上传之前就失败了）'
          : (hitCands.length
            ? '；候选节点命中 ' + hitCands.map((c) => c.sel + ' × ' + c.count).join('、')
            : '；候选节点全部零命中')
            + (last.diag.domSnippet ? '；现场 ' + last.diag.domSnippet : '');
        lastLine = '回落纯文本 —— 原因 ' + (last.code || '未知') + '（原始 ' + last.total + ' 字符）' + detail;
      } else {
        lastLine = '附件投递成功 —— ' + last.name + '（原始 ' + last.total + ' 字符 / 上传 '
          + last.payloadChars + ' 字符' + (last.truncated ? '，已省略前 ' + (last.total - last.payloadChars) + ' 字符' : '')
          + ' / 证据 ' + last.evidence + '）。';
      }
      const probeLine = !probe ? '尚未运行探针。'
        : ((probe.ok ? '上传已确认 —— 证据 ' + probe.evidence + '（' + probe.chars + ' 字符）'
          : '未确认 —— ' + (probe.code || '未知') + '（' + probe.chars + ' 字符）')
          + '；清理 ' + (probe.cleaned ? '成功（' + probe.cleanedBy + '）' : '未完成（' + (probe.cleanupNote || probe.cleanedBy) + '）'));
      return { ok: true, effective: chosen, limit, last, probe, transportLine, lastLine, probeLine };
    },
    'POST consent': async (body) => {
      if (!relay) return { ok: false, error: 'no relay' };
      relay.setConsent(body?.accepted === true);
      return { ok: true, consent: relay.status().consent };
    },
    'GET models': async () => ({ ok: true, models: listAllModels() }),
    // 等待发送时长（0.14.4）：累计（设置页）与本会话（输入框底下速览）同源。
    //
    // 展示文案由**服务端**算好（composerWaitLine / waitStatRows）：client.cjs 是单
    // 文件 bundle，import 不到 lib/ 的模块，若在浏览器侧再写一份 formatDuration，
    // 两个数字迟早会长得不一样——用户就无法信任任何一个。这里一次算清。
    // 走 POST 是因为要带 sessionId（本会话读数必需）。**只注册 POST**：
    // GET 形态一度存在（注释写的是「便于 curl 核对累计值」），但它没有任何
    // 真实消费方，而 POST 的空 body 形态本来就给出逐字相同的累计视图——
    //     curl -X POST .../__webcode/wait-stats -d '{}'
    // 于是那条 GET 是纯粹的死路由。它被 `test/client-server-contract.test.mjs`
    // 的第二条判据抓到（「同名动作存在但方法对不上」）：客户端只用 POST，
    // GET 永不抵达。多一条永不抵达的同名路由，只会让「哪个方法是对的」重新
    // 变成需要猜的事——那正是 0.15.3 那次 405 的同族病根。
    'POST wait-stats': async (body) => waitStatsPayload(body?.sessionId, body?.metrics || null),
    // 窗口声明可见性（B-3）——「桥向 DSH 声明的上下文窗口」此前只存在于代码里，
    // 用户在 GUI 上看到的占用百分比是相对一个**看不见**的数，越界报错也说不清
    // 比的是哪个值。这里把每个站点的声明值 + 它的**来源**（实测 / 配置覆盖 /
    // 保守兜底）如实列出，于是「为什么这次被 CONTEXT_WINDOW_EXCEEDED 拦了」
    // 可以在面板上直接核对。
    'GET context-windows': async () => {
      // B-3 → Task 2.3：把「展示口径」与「发送预算」分开投影。二者值上当前一致
      //（providers 各站点 budget 初值 = context），但语义不同且都可能被将来证据改写：
      //   displayContext = 站点/模型**声明**的窗口（如实反映、展示给用户看的数）
      //   sendBudget     = 发送前预算闸(B-2)真正比对、决定是否 CONTEXT_WINDOW_EXCEEDED 的数
      // contextWindow 保留为 sendBudget 的别名（旧字段，跨版本兼容），站点聚合用它。
      const rows = listAllModels().map((m) => {
        const displayContext = m.context ?? null;
        const sendBudget = contextWindowOf ? contextWindowOf(m) : (m.budget ?? m.context ?? null);
        return {
          id: m.id, siteId: m.siteId, name: m.name,
          displayContext,
          sendBudget,
          contextWindow: sendBudget,
          source: m.context ? 'declared' : (contextWindowOf ? 'fallback-or-config' : 'unknown'),
        };
      });
      const bySite = {};
      for (const r of rows) {
        if (!bySite[r.siteId]) bySite[r.siteId] = { siteId: r.siteId, siteName: r.name, windows: [], sources: new Set() };
        if (r.contextWindow != null) bySite[r.siteId].windows.push(r.contextWindow);
        bySite[r.siteId].sources.add(r.source);
      }
      const sites = Object.values(bySite).map((s) => ({
        siteId: s.siteId,
        siteName: s.siteName,
        // 同站点各模型声明值必须一致；不一致本身就是个信号，如实列出。
        window: s.windows.length ? Math.min(...s.windows) : null,
        consistent: new Set(s.windows).size <= 1,
        sources: [...s.sources],
      }));
      return { ok: true, sites, models: rows };
    },
    // 站点探活：右栏在挂载 iframe 之前先问一次「这个站点本机现在能不能直连」。
    // 动机（2026-09-13 真机）：chatgpt 403 / claude 403 / 部分网络环境下的
    // gemini 502，旧面板仍会为每个 tab 挂一个注定失败的 iframe（还常驻保活），
    // 用户看到的是裸错误页而不是「为什么打不开」。探活结果由前端按站点缓存。
    // 只发一个 GET，不落盘、不带凭据出进程；判定口径与镜像上游一致（httpFetch）。
    'POST site-probe': async (body) => {
      const siteId = String(body?.siteId || 'deepseek').trim();
      const st = getSite(siteId);
      if (!st) return { ok: false, error: 'unknown site: ' + siteId };
      const t0 = Date.now();
      try {
        const r = await httpFetch(st.origin + '/', {
          method: 'GET',
          headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
          timeoutMs: 12_000,
          redirect: 'follow',
        });
        // 上游 4xx/5xx 也算「可达」——那是站点自己的风控/地区策略，右栏会显示
        // 镜像的说明页；这里只区分「网络层根本连不上」。
        return {
          ok: true, siteId, origin: st.origin, ms: Date.now() - t0,
          reachable: true, status: r.status,
        };
      } catch (err) {
        return {
          ok: true, siteId, origin: st.origin, ms: Date.now() - t0,
          reachable: false, status: null, reason: String(err?.message || err).slice(0, 160),
        };
      }
    },
    'GET settings': async () => {
      if (!settingsStore) return { ok: true, extraPrompt: '' };
      const config = settingsStore.get();
      // 投递形态与间隔**基准**都必须带默认值回给调用方（0.16.3 / 0.16.31）：设置页
      // 要显示「当前生效值」，而用户从未保存过时设置文件里根本没有这个键。回
      // undefined 会让面板上的下拉/单选一个都没选中，看起来像「设置坏了」——
      // 实际是默认值。判据与写入侧（POST settings）同源，不在前端各造一份。
      return {
        ok: true,
        ...config,
        promptTransport: config.promptTransport === 'inline' ? 'inline' : 'attach',
        sendGapBasis: config.sendGapBasis === 'end-to-start' ? 'end-to-start' : 'send-to-send',
        // 两个站点级字典（0.16.38）：与上面同一条纪律——从未保存过时设置文件里
        // 没有这两个键，回 undefined 会让前端渲染成「加载失败」。回空对象。
        defaultModelBySite: config.defaultModelBySite && typeof config.defaultModelBySite === 'object' ? config.defaultModelBySite : {},
        extraPromptBySite: config.extraPromptBySite && typeof config.extraPromptBySite === 'object' ? config.extraPromptBySite : {},
      };
    },
    'POST settings': async (body) => {
      if (!settingsStore) return { ok: false, error: 'settings store unavailable' };
      const current = settingsStore.get();
      const updated = { ...current, ...body };
      // 子代理站点白名单：'follow' 或真实站点 id。轮次路由按它选驱动，
      // 手改配置写入未知值会让子代理轮次全部落到「未知站点」报错。
      if ('subAgentSite' in updated) {
        const v = String(updated.subAgentSite ?? 'follow').trim() || 'follow';
        updated.subAgentSite = v === 'follow' || getSite(v) ? v : 'follow';
      }
      // 发送间隔规范化：非负整数毫秒、上限 10 分钟。负数/NaN 一律归 0（关闭）。
      if ('sendGapMs' in updated) {
        updated.sendGapMs = Math.min(600_000, Math.max(0, Math.round(Number(updated.sendGapMs) || 0)));
      }
      // 间隔基准（0.16.31）：只有逐字 'end-to-start' 才认，其余一律归一成
      // 'send-to-send'。与上面几项同一条纪律——设置文件可手改，写错的配置
      // 只许退化成默认行为，不许变成第三种谁也没定义过的口径。
      if ('sendGapBasis' in updated) {
        updated.sendGapBasis = updated.sendGapBasis === 'end-to-start' ? 'end-to-start' : 'send-to-send';
      }
      // 账户槽（0.14.7）：`accounts` 与槽级间隔都来自界面，但设置文件可手改，
      // 因此写入前一律用 accounts.js 的纯函数归一化——非法条目丢弃而不是抛错，
      // 一个拼错的槽不该让整个设置保存 500。
      if ('accounts' in updated) {
        const raw = Array.isArray(updated.accounts) ? updated.accounts : [];
        const clean = normalizeAccounts(raw);
        if (clean.length !== raw.length) warn(`accounts: 丢弃了 ${raw.length - clean.length} 条非法账户槽配置`);
        updated.accounts = clean.map(({ siteId, slot, enabled }) => ({ siteId, slot, enabled }));
      }
      // 槽级发送间隔：键必须是合法 accountKey，值按全局同一口径 clamp。
      // 未知站点的键直接丢弃——它永远不会被查表命中，留着只会让设置文件越来越脏。
      if ('sendGapMsBySlot' in updated) {
        const src = updated.sendGapMsBySlot && typeof updated.sendGapMsBySlot === 'object' ? updated.sendGapMsBySlot : {};
        const out = {};
        for (const [key, val] of Object.entries(src)) {
          try { if (!getSite(parseAccountKey(key).siteId)) continue; } catch { continue; }
          out[key] = Math.min(600_000, Math.max(0, Math.round(Number(val) || 0)));
        }
        updated.sendGapMsBySlot = out;
      }
      // 提示词**投递形态**（0.16.3）：只有逐字等于 'inline' 才是「永远纯文本」，
      // 其余一律归一成 'attach'（含空值、拼错、旧版本没这个键）。
      //
      // 这个字面量判据在三个地方逐字相同：这里、browser-driver 的
      // promptTransportNow（真正的行为）、client.cjs 的渲染（bundle 里 import
      // 不到本文件）。三处必须一致——任何一处放宽（例如把 'Inline' 也当纯文本），
      // 面板显示的生效值就会与驱动的真实行为分叉，而面板是用户判断「设置到底有没有
      // 生效」的唯一入口。归一化放在写入侧，是为了让**落盘的设置文件**里永远只有
      // 两个合法值，下次读的人不必再猜。
      if ('promptTransport' in updated) {
        updated.promptTransport = updated.promptTransport === 'inline' ? 'inline' : 'attach';
      }
      // 站点级设置（0.16.38）：`defaultModelBySite` 与 `extraPromptBySite` 都是
      // 「站点 id → 值」的字典，设置文件可手改，因此写入前一律归一化：
      //   · 键必须是在编站点 id（未知键丢弃，它永远不会被查表命中）；
      //   · 模型值必须是能解析的模型 id，**且落在同一个站点上**（站点级默认模型的
      //     语义是「这个站点用哪一支」，它不该能把落点站点搬走）；
      //   · 指令是字符串、单站 ≤ 4000 字符（与前端 maxLength 同一条上限）；
      //     trim 后为空的条目直接**删键**——「没配」与「配了空串」必须可区分，
      //     后者会白白进一次契约指纹、白白整段重建一轮。
      if ('defaultModelBySite' in updated) {
        const src = updated.defaultModelBySite && typeof updated.defaultModelBySite === 'object' ? updated.defaultModelBySite : {};
        const out = {};
        for (const [sid, val] of Object.entries(src)) {
          if (!getSite(sid)) continue;
          const id = String(val ?? '').trim();
          if (!id) continue;
          // 站点归属判据只有一处：resolveWebModel（它同时负责别名与槽解析）。
          try { if (resolveWebModel(id).siteId !== sid) continue; } catch { continue; }
          out[sid] = id;
        }
        updated.defaultModelBySite = out;
      }
      if ('extraPromptBySite' in updated) {
        const src = updated.extraPromptBySite && typeof updated.extraPromptBySite === 'object' ? updated.extraPromptBySite : {};
        const out = {};
        for (const [sid, val] of Object.entries(src)) {
          if (!getSite(sid)) continue;
          const text = typeof val === 'string' ? val.trim().slice(0, 4000) : '';
          if (text) out[sid] = text;
        }
        updated.extraPromptBySite = out;
      }
      const result = settingsStore.set(updated);
      return { ok: true, ...result };
    },
    'GET preset': async () => {
      const info = presetInfo?.() ?? null;
      if (!info) return { ok: true, prompt: null, note: '尚未发送过首轮请求——发送第一条消息后这里显示实际注入的完整提示词模板' };
      return { ok: true, ...info };
    },
    // 首轮提示词的全部适配分支（只读）。设置页默认展开显示的就是这一份：
    // 模板由桥按当前会话的工具清单现算，因此不存在「一个固定字符串」可编辑；
    // 能编辑的只有 extraPrompt（全局指令），它会体现在每个变体的 text 里。
    // 变体由 lib/prompt-variants.js 用真函数现算——与真正发出去的那一份同源。
    //
    // 0.16.25：追加 `sites`——「每行一个网站 + 该网站实际使用的协议」。UI 以它
    // 为准渲染；`variants` 保留给「切换预览另一个协议」用（只读，不改真实选路）。
    'GET prompt-variants': async () => {
      const last = presetInfo?.() ?? null;
      // 优先用「本会话最近一次真实调用过的工具清单」：这样设置页看到的就是
      // 本会话真实会发出去的模板。没有则退到占位集，并在 toolsSource 里如实
      // 标注（UI 据此提示「这是占位，发送第一条消息后变为真实清单」）。
      const tools = last && Array.isArray(last.tools) && last.tools.length
        ? last.tools.map((n) => ({ name: n, description: '', parameters: {} }))
        : undefined;
      const settings = settingsStore ? settingsStore.get() : {};
      // 站点专属指令（0.16.38）：按站点取，缺省空串。取值函数**只在这里**造一份，
      // variants 与 sites 共用——两处各取一次，迟早会在某一处漏掉站点归属。
      const bySite = settings.extraPromptBySite && typeof settings.extraPromptBySite === 'object' ? settings.extraPromptBySite : {};
      const sitePromptOf = (sid) => (sid && typeof bySite[sid] === 'string' ? bySite[sid] : '');
      const opts = { tools, extraPrompt: settings.extraPrompt || '', sitePromptOf, system: undefined, lastPreset: last };
      const { variants, toolsSource, active } = buildPromptVariants(opts);
      // sites 与 variants 必须基于**同一份输入**现算，否则两处会给出不同的模板。
      const { sites } = buildSitePromptRows({ ...opts, system: undefined });
      // 站点提示词文件路径（0.16.38）：由**服务端**用 prompt-store 的同一个函数
      // 算好交给前端——前端只负责显示与「用默认程序打开」，绝不自己拼路径
      //（自己拼就会与真正落盘/读回的那一份分叉）。storeDir 一并回，文件还没生成
      // 时界面要如实把目录显示出来。
      const storeDir = promptStoreDir();
      const rows = sites.map((row) => ({ ...row, file: sitePromptPath(storeDir, row.siteId) }));
      return {
        ok: true, variants, sites: rows, toolsSource, active,
        extraPrompt: settings.extraPrompt || '', storeDir,
      };
    },
    // 用**系统默认程序**打开某站点的提示词文件（0.16.38）。
    //
    // 安全形状：请求体只带 siteId，路径由服务端用 sitePromptPath 现算——绝不接受
    // 调用方传来的路径。于是这条路由的能力被钉死在「prompts/ 下的那几个 .md」，
    // 拿不到任意文件读写的把手（与本仓库对 session-import 的纪律一致）。
    // 文件不存在时如实回 PROMPT_FILE_MISSING（发送第一条消息后才生成），不静默。
    'POST prompt-file': async (body) => {
      const sid = String(body?.siteId || '').trim();
      if (!sid || !getSite(sid)) return { ok: false, error: 'unknown siteId' };
      const storeDir = promptStoreDir();
      const file = sitePromptPath(storeDir, sid);
      if (storeDir === 'off') return { ok: false, code: 'PROMPT_STORE_OFF', file, storeDir };
      if (typeof openPath !== 'function') return { ok: false, code: 'OPEN_UNAVAILABLE', file, storeDir };
      let exists = false;
      try { exists = fs.existsSync(file); } catch { exists = false; }
      if (!exists) return { ok: false, code: 'PROMPT_FILE_MISSING', file, storeDir };
      const r = await openPath(file);
      if (r && r.ok) return { ok: true, file, storeDir };
      return { ok: false, code: 'OPEN_FAILED', file, storeDir, error: String(r?.error || 'open failed').slice(0, 200) };
    },
    'POST login': async (body) => {
      const accountKey = accountKeyOf(body, { fallback: '' });
      const wait = body?.wait !== false;     // 默认等待；显式 {wait:false} 才是旧的即开即回
      // 优先走「等结果」的入口：设置页需要知道这次登录到底成没成，
      // 否则失败只会写进宿主控制台，界面永远停在「未登录」。
      const loginAndReport = relay?.config?.loginAndReport;
      if (loginAndReport && wait) {
      const r = await loginAndReport(accountKey || 'deepseek', { timeoutMs: body?.timeoutMs });
      const message = r?.ok ? (r?.note || '登录完成') : (r?.error || '登录失败');
      return {
        ok: r?.ok === true,
        siteId: r?.siteId,
        siteName: r?.siteName,
        slot: r?.slot ?? null,
        loggedIn: r?.loggedIn ?? null,
        alreadyLoggedIn: r?.alreadyLoggedIn === true,
        ms: r?.ms ?? null,
        message,
        // 失败原因必须同时落在 error 字段:面板 api() 只认 data.error,
        // 只写 message 会把真实原因(超时/窗口被关/profile 锁)吞成「请求失败」。
        ...(r?.ok ? {} : { error: message }),
      };
      }
      const loginTrigger = relay?.config?.loginTrigger;
      if (!loginTrigger) return { ok: false, error: 'no driver' };
      loginTrigger(accountKey || undefined).catch((err) => warn('login flow error:', err?.message));
      return { ok: true, message: '登录窗口打开中，请在该窗口完成一次性登录' };
    },
    'POST verify-login': async (body) => {
      // 显式检测某站点登录态：connect 幂等且轻量（已启动时只查页面输入框），
      // 给设置面板「检测」按钮用——用户在独立窗口里登录完后能立即确认结果。
      const accountKey = accountKeyOf(body);
      const target = relay?.config?.siteConnect?.(accountKey);
      if (!target) return { ok: false, error: 'no driver' };
      const r = await target.connect();
      return { ok: true, siteId: accountKey, accountKey, loggedIn: r?.loggedIn ?? null };
    },
    // 「导入本机登录态」：把用户真实 Edge profile 的 cookies 采纳进所选站点的桥
    // profile。动机（真机 2026-09-13）：桥 profile 里除 deepseek 外**没有任何站点
    // 的 cookie**（全量 7 枚，5 枚属于 deepseek），因此 kimi/qwen/doubao/zai 在桥
    // 里永远是游客态，右栏看到的登录视角无从谈起。用户已在本机浏览器里登录过，
    // 没必要为每个站点再手工登录一次。
    //
    // 安全：与 login/window 同级敏感度（会把真实登录态复制进桥 profile），
    // 因此走同一个 csrfSafe 门禁（回环 Host + 同源/白名单 Origin）。
    'POST session-import': async (body) => {
      const importer = relay?.config?.sessionImport;
      if (typeof importer !== 'function') return { ok: false, error: 'no driver' };
      const accountKey = accountKeyOf(body);
      const dir = String(body?.sourceProfileDir || '').trim() || defaultEdgeUserDataDir();
      if (!dir) return { ok: false, error: '未找到本机 Edge profile 目录，请在请求里显式给出 sourceProfileDir' };
      // 目录白名单（0.14.4）：旧实现只查「存在」，于是任意路径都能让调用方在磁盘
      // 任意位置创建 Chromium profile 文件。与 openai.js 的 /bridge/import-session
      // 共用同一套判定（permittedImportRoots），两条入口防护强度从此一致。
      if (!isWithinRoots(dir, permittedImportRoots(config))) {
        return { ok: false, error: '源 profile 目录不在允许范围内（仅 DSH home / 桥 profile / 本包树）' };
      }
      try {
        if (!fs.existsSync(dir)) return { ok: false, error: '源 profile 目录不存在：' + dir };
      } catch (err) {
        return { ok: false, error: '源 profile 目录不可访问：' + String(err?.message || err).slice(0, 120) };
      }
      const r = await importer(accountKey, dir);
      return { ok: true, siteId: accountKey, accountKey, sourceProfileDir: dir, ...(r || {}) };
    },
    // 设置页「登录网站」下拉的数据源：站点清单 + 各自登录态，不启动浏览器。
    'GET login-sites': async () => {
      const state = relay?.config?.driverStatus?.() ?? null;
      // 0.14.7：一行是**一个账户槽**。但「列出全部站点」这条契约不能丢——
      // 面板要能对**任何**站点发起登录，包括本轮从未懒创建过的那些。
      //
      // 因此这里是**合并**而不是替换：
      //   ① 先为 SITES 里每个站点铺一行默认槽（与 0.14.6 的清单逐字一致）；
      //   ② 再把 driverStatus 里同 accountKey 的实时状态盖上去；
      //   ③ 最后追加非默认槽行（`glm#2`）——它们只可能来自设置，不在 SITES 里。
      const live = new Map();
      for (const s of state?.sites || []) if (s?.accountKey || s?.siteId) live.set(s.accountKey || s.siteId, s);
      const rows = [];
      for (const st of SITES) {
        const s = live.get(st.id);
        live.delete(st.id);
        rows.push({
          siteId: st.id,
          siteName: st.name,
          origin: st.origin,
          slot: DEFAULT_SLOT,
          accountKey: st.id,
          displayName: st.name,
          initialized: s?.initialized === true,
          loggedIn: s?.loggedIn ?? null,
          loginState: s?.loginState || 'idle',
          lastLogin: s?.lastLogin || null,
          profileDir: s?.profileDir ?? null,
        });
      }
      // 剩下的都是非默认槽（或未知站点，直接忽略）。
      for (const s of live.values()) {
        if (!getSite(s.siteId)) continue;
        rows.push({
          siteId: s.siteId,
          siteName: s.siteName || getSite(s.siteId).name,
          origin: s.origin || getSite(s.siteId).origin,
          slot: s.slot || DEFAULT_SLOT,
          accountKey: s.accountKey || s.siteId,
          displayName: s.displayName || s.siteName || getSite(s.siteId).name,
          initialized: s.initialized === true,
          loggedIn: s.loggedIn ?? null,
          loginState: s.loginState || 'idle',
          lastLogin: s.lastLogin || null,
          profileDir: s.profileDir ?? null,
        });
      }
      return { ok: true, mainSiteId: state?.siteId || 'deepseek', sites: rows };
    },
    'POST sessions': async (body) => {
      const r = await driver.listSessions(Math.min(200, Math.max(1, Number(body?.count) || 100)));
      return r;
    },
    'POST history': async (body) => {
      const r = await driver.fetchHistory(String(body?.sessionId || ''));
      const { line, branchCount } = mainLineOf(r.messages);
      return { ...r, count: r.messages.length, branchCount, messages: line };
    },
    'GET workspaces': async () => {
      if (!host.listWorkspaces) return { ok: true, workspaces: [] };
      return host.listWorkspaces();
    },
    'POST import': async (body) => {
      if (!host.importToWorkspace) return { ok: false, error: 'DSH 会话导入不可用（非 DSH 环境）' };
      return host.importToWorkspace({
        sessionId: String(body?.sessionId || ''),
        title: body?.title === undefined ? undefined : String(body.title),
        workspaceId: String(body?.workspaceId || ''),
      });
    },
  };

  // ── `status` 必须同时接受 GET 与 POST（0.15.3，真机缺陷修复）────────────────
  //
  // 真机 2026-09-16：设置页「正在运行（子代理 / Team）」那一栏永远读不到花名册。
  // 根因不是花名册本身，而是**两端对同一个动作的方法不一致**：
  //
  //     lib/client.cjs      api('status', { sessionId })  ← 带 body ⇒ POST
  //     lib/web-control.js  'GET status'                  ← 只注册了 GET
  //
  // 于是真机 POST /__webcode/status ⇒ **405**（上面的 `if (!actions[key])` 分支
  // 发现同名后缀存在、方法不匹配，就带 Allow 头回 405）。花名册这一栏因此永远
  // 停在「读不到」，而 `subAgentsError` 报的是 `no-session-id` —— 那个原因本身
  // 也是真的（sessionId 根本没送达），但它是**后果**，不是根因。
  //
  // 为什么离线全绿：`client-render.test.mjs` 的 mock fetch **不看方法**，任何
  // URL 都回 200 + JSON。护栏自己的建模失真，把「服务端没这条路由」整个盖住了。
  //
  // 为什么不把客户端改成 GET：花名册的 subagentCatalog 是**会话级**投影，
  // sessionId 必须随请求送达，而客户端统一走 `request()` 的「有 body 就 POST」
  // 契约。两头都收才是对调用方无假设的形态（外部脚本用 GET 也照旧可用）。
  //
  // 这里用**别名**而不是复制一份实现：两个方法必须返回逐字节相同的形状，
  // 复制一份迟早会漂移——那正是这次故障的同族病（两端各写各的）。
  //
  // 判据由 `test/client-server-contract.test.mjs` 钉住：它把客户端
  // `api(action, body)` 推导出的方法与服务端动作表直接对齐，于是这一族
  // 「调用点存在、另一端没有」的缺陷从此在离线就能红。
  actions['POST status'] = actions['GET status'];

  // `session-slot` 同样两头都收（与 status 同一理由：客户端统一走「有 body 就
  // POST」，而排障形态天然是 `curl .../__webcode/session-slot` 这种 GET）。
  // 别名而不是复制实现——两个方法必须返回逐字相同的形状。
  actions['POST session-slot'] = actions['GET session-slot'];

  /**
   * Handle one request. `pathname` is the full path; any suffix that ends
   * with one of the action names (e.g. /__webcode/status, /bridge/web/status)
   * is accepted, so the same table serves both mounts.
   */
  // suffix → Set(methods)：用于把「路径存在但方法不对」和「路径根本不存在」
  // 区分开。两者都必须回 **JSON** 且带 `ok:false`——空 body 会让客户端的
  // response.json() 抛解析错误，把真实原因（405/404）吞掉变成一句
  // “unexpected end of JSON data”。
  const index = routeIndex(actions);

  async function handle(req, res, pathname) {
    const suffix = pathname.replace(/^.*\//, '');
    const key = req.method + ' ' + suffix;
    if (req.method === 'OPTIONS') {
      // preflight: reflect only allowlisted origins; a bare 204 means the
      // preflight fails, which is exactly what we want for strangers
      res.writeHead(204, corsHeaders(req));
      res.end();
      return true;
    }
    if (!actions[key]) {
      // 已注册的 suffix、但不是这个 method → 405（带 Allow），绝不空 body。
      const methods = index.get(suffix);
      if (methods) {
        const allow = [...methods].sort().join(', ');
        sendJson(req, res, { ok: false, error: `method not allowed: ${req.method} ${suffix} (allowed: ${allow})` }, 405);
        return true;
      }
      // 真未知路径：交回调用方写 404（它知道自己的挂载前缀）。
      return false;
    }
    if (!csrfSafe(req)) {
      warn('rejected cross-site control request', key, 'from', req.headers.origin || '(no origin)');
      sendJson(req, res, { ok: false, error: 'cross-site control requests are not allowed' }, 403);
      return true;
    }
    try {
      let body = {};
      if (req.method === 'POST') {
        body = await readBody(req);
        if (body?.__tooLarge) {
          sendJson(req, res, { ok: false, error: 'request body too large' }, 413);
          return true;
        }
      } else {
        // GET 也要能带参数（0.15.0）：花名册是**按会话**读的
        //（subagentCatalog 投影挂在发起会话自己的日志上），而轮询花名册的
        // 天然形态是 GET /__webcode/status?sessionId=…。此前 GET 一律收
        // 空对象，`/status` 因此拿不到会话身份，只能读「当前进程里最后一个
        // 会话」——多会话并行时会显示别人的子代理。解析 query 是最小改动：
        // 不新增端点、不改变既有 GET 的语义（无 query 时行为与以前逐字相同）。
        // 只取第一层标量，值一律按字符串处理；重复键取最后一个（与 URLSearchParams
        // 的 get() 一致），不做数组展开——控制面不需要那层复杂度。
        try {
          const qs = String(req.url || '').split('?')[1] || '';
          for (const [k, v] of new URLSearchParams(qs)) body[k] = v;
        } catch { /* 畸形 query 按无参数处理 */ }
      }
      const result = await actions[key](body);
      sendJson(req, res, result, 200);
    } catch (err) {
      // 错误文本透传（截断到 200 字符）：设置面板是本机用户的唯一操作入口，
      // 把「web request failed」换成真实原因（如 profile 锁被孤儿 Edge 占用）
      // 才能照着排查。端点本身 loopback-only，暴露面没有变化。
      warn(suffix, 'failed:', err?.message);
      const reason = String(err?.message || '').slice(0, 200) || 'web request failed';
      sendJson(req, res, { ok: false, error: reason }, 502);
    }
    return true;
  }

  /** Live JPEG preview of the driver page (GET — <img> friendly). */
  async function handlePreview(req, res) {
    if (!csrfSafe(req)) {
      sendJson(req, res, { ok: false, error: 'cross-site preview is not allowed' }, 403);
      return true;
    }
    try {
      // Panel-size sync: ?w=&h= resize the headless viewport so layout and
      // click mapping match the sidebar panel instead of a fixed 640×900.
      let params = {};
      try { params = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams); } catch { /* bare path */ }
      const shot = await driver.screenshotBase64({
        quality: 55,
        width: Number(params.w) || undefined,
        height: Number(params.h) || undefined,
        withMeta: true,
      });
      if (!shot) return sendJson(req, res, { ok: false, error: 'driver not running' }, 503);
      const buf = Buffer.from(shot.base64, 'base64');
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': buf.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // clip metadata (image px + viewport CSS px) for exact click mapping
        ...(shot.clip ? { 'x-webcode-clip': JSON.stringify(shot.clip) } : {}),
        ...(shot.viewport ? { 'x-webcode-viewport': JSON.stringify(shot.viewport) } : {}),
        ...corsHeaders(req),
      });
      res.end(buf);
    } catch (err) {
      sendJson(req, res, { ok: false, error: 'preview failed' }, 500);
    }
    return true;
  }

  // routes / methods 一并暴露：宿主挂载从这份索引派生，不再手写第二份清单。
  return { handle, handlePreview, actions, routes: [...index.keys()], routeMethods: index };
}

/**
 * Reduce a raw (branch-carrying) web message list to the conversation's main
 * line. DeepSeek web gives messages with parent_id; the main line is the
 * parent chain ending at the newest message. Falls back to the original
 * order when the ids/parents don't form a usable tree.
 */
export function mainLineOf(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const byId = new Map(msgs.filter((m) => m && m.id).map((m) => [m.id, m]));
  if (byId.size === msgs.length && msgs.length > 1) {
    const last = msgs[msgs.length - 1];
    const chain = [];
    for (let cur = last; cur; ) {
      chain.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
      if (chain.length > msgs.length) break; // cycle guard
    }
    if (chain.length > 1 && chain.length <= msgs.length) {
      return { line: chain.reverse(), branchCount: msgs.length - chain.length };
    }
  }
  return { line: msgs, branchCount: 0 };
}

/**
 * Convert DeepSeek web history into a resumable DSH session event stream.
 * Branch messages (regenerations) are dropped — the main line imports; the
 * caller can report how many branch messages were skipped.
 */
export function buildSessionEvents(messages, title) {
  const events = [];
  let seq = 0;
  let turn = 0;
  let openStep = false;
  const base = Date.now();
  const push = (type, data, surfaceOp) => {
    const ev = { type, seq, time: base + seq, data };
    if (surfaceOp !== undefined) ev.surfaceOp = surfaceOp;
    events.push(ev);
    seq += 1;
  };
  push('session/title', { title: String(title || 'DeepSeek 导入对话'), messageSeqs: [], source: { kind: 'user' } });
  for (const m of messages || []) {
    const role = String(m.role || '').toLowerCase();
    const text = typeof m.content === 'string' ? m.content : '';
    if (!text.trim()) continue;
    if (role === 'user') {
      if (openStep) {
        push('step/end', { turn, step: 1 });
        push('turn/end', { turn, reason: { kind: 'completed' } });
        openStep = false;
      }
      turn += 1;
      push('turn/start', { turn });
      push('user/message', { id: 'msg-' + turn + '-u', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, 'append');
      push('step/start', { turn, step: 1 });
      openStep = true;
    } else if (role === 'assistant' || role === 'model') {
      if (!openStep) {
        turn += 1;
        push('turn/start', { turn });
        push('step/start', { turn, step: 1 });
        openStep = true;
      }
      push('assistant/message', {
        turn,
        step: 1,
        message: { id: 'msg-' + turn + '-a', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'webcode', model: 'deepseek-web' } },
      }, 'append');
      push('step/end', { turn, step: 1 });
      push('turn/end', { turn, reason: { kind: 'completed' } });
      openStep = false;
    }
    // anything else (system notices etc.) is skipped
  }
  if (openStep) {
    push('step/end', { turn, step: 1 });
    push('turn/end', { turn, reason: { kind: 'completed' } });
  }
  push('session/end-seed', {});
  return events;
}
