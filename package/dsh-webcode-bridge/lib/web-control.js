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

import { listAllModels, SITES } from './providers.js';

const MAX_BODY_BYTES = 256 * 1024;
const LOOPBACK_HOST = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i;

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
    if (!LOOPBACK_HOST.test(hostHeader)) return false;              // DNS-rebinding
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (site === 'cross-site') return false;                        // public-website browser
    const origin = String(req.headers.origin || '');
    if (origin) {
      // Only exact same-origin (scheme+host+port of THIS server) or the
      // explicit allowlist may carry an Origin. Any other loopback port is a
      // different (potentially hostile) application, not "us".
      if (allowedOrigins.has(origin.toLowerCase())) return true;
      try {
        const o = new URL(origin);
        const host = String(hostHeader);
        return o.host === host && (o.protocol === 'http:' || o.protocol === 'https:');
      } catch { return false; }
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
      return { ok: true, siteId: sid, window: siteWindow };
    },
    'POST interact': async body => {
      if (!relay?.status().consent) return { ok: false, error: '请在设置中启用网页自动化' };
      return driver.interact(body);
    },
    'GET diagnostics': async () => ({ ok: true, ...(await driver.diagnostics()) }),
    'GET status': async () => ({
      ok: true,
      relay: relay ? (({ running, consent, consentPersistent, requireConsent, busy, queueLength, activeRequests, lastError, metrics }) => ({
        running, consent, consentPersistent, requireConsent, busy, queueLength, activeRequests, lastError, metrics,
      }))(relay.status()) : null,
      driver: relay?.config?.driverStatus?.() ?? (driver ? (({ running, busy, loggedIn, needLogin, selectedModel, lastTurn, profileDir, conversations }) => ({
        running, busy, loggedIn, needLogin, selectedModel, profileDir,
        conversationCount: conversations ? Object.keys(conversations).length : 0,
        lastTurn: lastTurn ? { sessionId: lastTurn.sessionId, at: lastTurn.at } : null,
      }))(driver.status()) : null),
    }),
    'POST consent': async (body) => {
      if (!relay) return { ok: false, error: 'no relay' };
      relay.setConsent(body?.accepted === true);
      return { ok: true, consent: relay.status().consent };
    },
    'GET models': async () => ({ ok: true, models: listAllModels() }),
    'GET settings': async () => {
      if (!settingsStore) return { ok: true, extraPrompt: '' };
      const config = settingsStore.get();
      return { ok: true, ...config };
    },
    'POST settings': async (body) => {
      if (!settingsStore) return { ok: false, error: 'settings store unavailable' };
      const current = settingsStore.get();
      const updated = { ...current, ...body };
      const result = settingsStore.set(updated);
      return { ok: true, ...result };
    },
    'GET preset': async () => {
      const info = presetInfo?.() ?? null;
      if (!info) return { ok: true, prompt: null, note: '尚未发送过首轮请求——发送第一条消息后这里显示实际注入的完整提示词模板' };
      return { ok: true, ...info };
    },
    'POST login': async (body) => {
      const siteId = String(body?.siteId || '').trim();
      const wait = body?.wait !== false;     // 默认等待；显式 {wait:false} 才是旧的即开即回
      // 优先走「等结果」的入口：设置页需要知道这次登录到底成没成，
      // 否则失败只会写进宿主控制台，界面永远停在「未登录」。
      const loginAndReport = relay?.config?.loginAndReport;
      if (loginAndReport && wait) {
        const r = await loginAndReport(siteId || 'deepseek', { timeoutMs: body?.timeoutMs });
        return {
          ok: r?.ok === true,
          siteId: r?.siteId,
          siteName: r?.siteName,
          loggedIn: r?.loggedIn ?? null,
          alreadyLoggedIn: r?.alreadyLoggedIn === true,
          ms: r?.ms ?? null,
          message: r?.ok ? (r?.note || '登录完成') : (r?.error || '登录失败'),
        };
      }
      const loginTrigger = relay?.config?.loginTrigger;
      if (!loginTrigger) return { ok: false, error: 'no driver' };
      loginTrigger(siteId || undefined).catch((err) => warn('login flow error:', err?.message));
      return { ok: true, message: '登录窗口打开中，请在该窗口完成一次性登录' };
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
    if (!actions[key]) return false;
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
      // Never echo internals — fixed text plus, when the driver attached a
      // sanitized payload hint, that hint only (already size-capped).
      warn(suffix, 'failed:', err?.message);
      sendJson(req, res, { ok: false, error: err?.payload ? err.message : 'web request failed' }, 502);
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

  return { handle, handlePreview, actions };
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
