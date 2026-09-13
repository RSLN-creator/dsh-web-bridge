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

import { listAllModels, SITES, getSite } from './providers.js';
import { buildPromptVariants } from './prompt-variants.js';
import { composerWaitLine, waitStatRows, formatDuration } from './wait-stats.js';
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
  } = deps;
  const log = (...a) => logger.log?.('[webcode-web]', ...a);
  const warn = (...a) => logger.warn?.('[webcode-web]', ...a);
  const allowedOrigins = new Set((config.allowedOrigins || []).map((s) => String(s).toLowerCase()));

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
    return {
      ok: true,
      total,
      session,
      // 设置页「累计」区块直接渲染这些行。
      rows: total ? waitStatRows(total) : [],
      // 输入框底下那一条速览（数据不足时为 null，前端据此不渲染）。
      line: composerWaitLine({ session, metrics }) || (total && total.totalWaitMs > 0
        ? '累计等待发送 ' + formatDuration(total.totalWaitMs)
        : null),
    };
  }

  /** One route table keyed by "METHOD path-suffix". */
  const actions = {
    'POST connect': async (body) => {
      // 侧栏视图按站点连接：未指定时保持 DeepSeek 兼容行为
      const siteId = String(body?.siteId || 'deepseek').trim();
      const target = relay?.config?.siteConnect?.(siteId);
      if (target) return target.connect();
      return driver.connect();
    },
    // 展示窗口（真实有头 Edge 窗口）：open/close 两个动作 + 状态查询。
    // 与 login/consent 同级敏感度：窗口里是已登录网页会话，因此只接受
    // csrfSafe 的本地请求（同源挂载 / allowlisted origin），不新增暴露面。
    'POST window': async (body) => {
      const opener = relay?.config?.windowOpener;
      if (!opener) return { ok: false, error: 'no driver' };
      const siteId = String(body?.siteId || 'deepseek').trim() || 'deepseek';
      const action = body?.action === 'close' ? 'close' : 'open';
      const width = Number(body?.width) || undefined;
      const height = Number(body?.height) || undefined;
      if (action === 'close') return opener(siteId, 'close');
      return opener(siteId, 'open', { width, height });
    },
    'GET window': async () => {
      const state = relay?.config?.driverStatus?.();
      const sid = String(state?.siteId || 'deepseek');
      // 顶层 window 字段来自 deepseek 主驱动;聚合 sites 里各站点窗口各自带
      const siteWindow = state?.window ?? state?.sites?.find((s) => s.siteId === sid)?.window ?? null;
      // 聚合各站点窗口：面板按站点行各自显示「已开独立窗口」，不再只认 deepseek。
      const windows = {};
      for (const s of state?.sites || []) if (s?.window?.open) windows[s.siteId] = s.window;
      return { ok: true, siteId: sid, window: siteWindow, windows };
    },
    'POST interact': async body => {
      if (!relay?.status().consent) return { ok: false, error: '请在设置中启用网页自动化' };
      return driver.interact(body);
    },
    'GET diagnostics': async () => ({ ok: true, ...(await driver.diagnostics()) }),
    'GET status': async () => ({
      ok: true,
      build: { hash: config.buildHash || null, version: config.version || null },
      relay: relay ? (({ running, consent, consentPersistent, requireConsent, busy, queueLength, activeRequests, lastError, metrics }) => ({
        running, consent, consentPersistent, requireConsent, busy, queueLength, activeRequests, lastError, metrics,
      }))(relay.status()) : null,
      driver: relay?.config?.driverStatus?.() ?? (driver ? (({ running, busy, loggedIn, needLogin, selectedModel, lastTurn, profileDir, conversations, recoveredTurns, lastRecovered, lastEndReason, lastTimeoutScene, sessionLostCount, lastSessionLost }) => ({
        running, busy, loggedIn, needLogin, selectedModel, profileDir,
        conversationCount: conversations ? Object.keys(conversations).length : 0,
        lastTurn: lastTurn ? { sessionId: lastTurn.sessionId, at: lastTurn.at } : null,
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
      }))(driver.status()) : null),
    }),
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
    // 走 POST 是因为要带 sessionId；GET 形态同时保留，便于 curl 核对累计值。
    'POST wait-stats': async (body) => waitStatsPayload(body?.sessionId, body?.metrics || null),
    'GET wait-stats': async () => waitStatsPayload(),
    // 窗口声明可见性（B-3）——「桥向 DSH 声明的上下文窗口」此前只存在于代码里，
    // 用户在 GUI 上看到的占用百分比是相对一个**看不见**的数，越界报错也说不清
    // 比的是哪个值。这里把每个站点的声明值 + 它的**来源**（实测 / 配置覆盖 /
    // 保守兜底）如实列出，于是「为什么这次被 CONTEXT_WINDOW_EXCEEDED 拦了」
    // 可以在面板上直接核对。
    'GET context-windows': async () => {
      const rows = listAllModels().map((m) => ({
        id: m.id, siteId: m.siteId, name: m.name,
        contextWindow: contextWindowOf ? contextWindowOf(m) : (m.context || null),
        source: m.context ? 'declared' : (contextWindowOf ? 'fallback-or-config' : 'unknown'),
      }));
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
      return { ok: true, ...config };
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
    'GET prompt-variants': async () => {
      const last = presetInfo?.() ?? null;
      // 优先用「本会话最近一次真实调用过的工具清单」：这样设置页看到的就是
      // 本会话真实会发出去的模板。没有则退到占位集，并在 toolsSource 里如实
      // 标注（UI 据此提示「这是占位，发送第一条消息后变为真实清单」）。
      const tools = last && Array.isArray(last.tools) && last.tools.length
        ? last.tools.map((n) => ({ name: n, description: '', parameters: {} }))
        : undefined;
      const settings = settingsStore ? settingsStore.get() : {};
      const { variants, toolsSource, active } = buildPromptVariants({
        tools,
        extraPrompt: settings.extraPrompt || '',
        lastPreset: last,
      });
      return { ok: true, variants, toolsSource, active, extraPrompt: settings.extraPrompt || '' };
    },
    'POST login': async (body) => {
      const siteId = String(body?.siteId || '').trim();
      const wait = body?.wait !== false;     // 默认等待；显式 {wait:false} 才是旧的即开即回
      // 优先走「等结果」的入口：设置页需要知道这次登录到底成没成，
      // 否则失败只会写进宿主控制台，界面永远停在「未登录」。
      const loginAndReport = relay?.config?.loginAndReport;
      if (loginAndReport && wait) {
      const r = await loginAndReport(siteId || 'deepseek', { timeoutMs: body?.timeoutMs });
      const message = r?.ok ? (r?.note || '登录完成') : (r?.error || '登录失败');
      return {
        ok: r?.ok === true,
        siteId: r?.siteId,
        siteName: r?.siteName,
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
      loginTrigger(siteId || undefined).catch((err) => warn('login flow error:', err?.message));
      return { ok: true, message: '登录窗口打开中，请在该窗口完成一次性登录' };
    },
    'POST verify-login': async (body) => {
      // 显式检测某站点登录态：connect 幂等且轻量（已启动时只查页面输入框），
      // 给设置面板「检测」按钮用——用户在独立窗口里登录完后能立即确认结果。
      const siteId = String(body?.siteId || 'deepseek').trim();
      const target = relay?.config?.siteConnect?.(siteId);
      if (!target) return { ok: false, error: 'no driver' };
      const r = await target.connect();
      return { ok: true, siteId, loggedIn: r?.loggedIn ?? null };
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
      const siteId = String(body?.siteId || 'deepseek').trim();
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
      const r = await importer(siteId, dir);
      return { ok: true, siteId, sourceProfileDir: dir, ...(r || {}) };
    },
    // 设置页「登录网站」下拉的数据源：站点清单 + 各自登录态，不启动浏览器。
    'GET login-sites': async () => {
      const state = relay?.config?.driverStatus?.() ?? null;
      const byId = new Map((state?.sites || []).map((s) => [s.siteId, s]));
      return {
        ok: true,
        mainSiteId: state?.siteId || 'deepseek',
        sites: SITES.map((st) => {
          const s = byId.get(st.id);
          return {
            siteId: st.id,
            siteName: st.name,
            origin: st.origin,
            initialized: s?.initialized === true,
            loggedIn: s?.loggedIn ?? null,
            loginState: s?.loginState || 'idle',
            lastLogin: s?.lastLogin || null,
          };
        }),
      };
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
