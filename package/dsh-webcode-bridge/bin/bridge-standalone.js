#!/usr/bin/env node
// bridge-standalone.js — run the relay + driver + OpenAI front WITHOUT DSH.
// Used for local verification (driver E2E against the mock site) and by
// anyone wanting the bridge alone.
//
//   node bin/bridge-standalone.js [port]
//   WEBCODE_SITE=http://127.0.0.1:8932/ WEBCODE_PROFILE_DIR=... node bin/bridge-standalone.js

import os from 'node:os';
import path from 'node:path';
import { createRelay } from '../lib/relay.js';
import { createOpenAiFront } from '../lib/openai.js';
import { createBrowserDriver } from '../lib/browser-driver.js';
import { createWebControl } from '../lib/web-control.js';
import { createMirror } from '../lib/mirror.js';
import { getSite, SITES, qualifyModelId } from '../lib/providers.js';

const port = Number(process.argv[2] || process.env.WEBCODE_PORT || 8931);
const cfg = {
  port,
  host: '127.0.0.1',
  requireConsent: process.env.WEBCODE_NO_CONSENT ? false : true,
  requestTimeoutMs: Number(process.env.WEBCODE_REQUEST_TIMEOUT_MS || 240_000),
  queueTimeoutMs: Number(process.env.WEBCODE_QUEUE_TIMEOUT_MS || 300_000),
  loginTimeoutMs: Number(process.env.WEBCODE_LOGIN_TIMEOUT_MS || 300_000),
  site: process.env.WEBCODE_SITE || 'https://chat.deepseek.com/',
  profileDir: process.env.WEBCODE_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'webcode-edge-profile'),
  headless: process.env.WEBCODE_HEADED ? false : true,
};

const driver = createBrowserDriver({
  site: cfg.site,
  profileDir: cfg.profileDir,
  headless: cfg.headless,
  requestTimeoutMs: cfg.requestTimeoutMs,
  loginTimeoutMs: cfg.loginTimeoutMs,
  logger: console,
});

// 多站点：与 DSH 侧同一套懒创建规则（独立 profile，避免登录态串号），
// 独立运行时的控制面/镜像也能覆盖全部站点。
const drivers = new Map();
function driverFor(siteId) {
  const sid = getSite(siteId) ? siteId : 'deepseek';
  if (sid === 'deepseek' && !process.env.WEBCODE_SITE) return driver;
  if (!drivers.has(sid)) {
    const st = getSite(sid);
    drivers.set(sid, createBrowserDriver({
      siteId: sid,
      site: st.origin + '/',
      profileDir: path.join(cfg.profileDir, 'sites', sid),
      headless: cfg.headless,
      requestTimeoutMs: cfg.requestTimeoutMs,
      loginTimeoutMs: cfg.loginTimeoutMs,
      logger: console,
    }));
  }
  return drivers.get(sid);
}
function driverStatus() {
  const base = driver.status();
  const sites = SITES.map((st) => {
    const d = st.id === 'deepseek' ? driver : drivers.get(st.id);
    if (!d) return { siteId: st.id, siteName: st.name, origin: st.origin, initialized: false, running: false, busy: false, loggedIn: null, needLogin: false, selectedModel: null, window: null, loginState: 'idle', lastLogin: null };
    const s = d.status();
    return { siteId: st.id, siteName: st.name, origin: st.origin, initialized: true, running: s.running, busy: s.busy, loggedIn: s.loggedIn, loggedInCached: s.loggedInCached === true, loginBasis: s.loginBasis ?? null, needLogin: s.needLogin, selectedModel: s.selectedModel, window: s.window ?? null, loginState: s.loginState ?? 'idle', lastLogin: s.lastLogin ?? null };
  });
  return { ...base, sites };
}

let front = null;
const relay = createRelay({
  ...cfg,
  logger: console,
  executor: (prompt, opts) => {
    const m = opts?.meta || null;
    const qualified = qualifyModelId(m?.model, m?.siteId);
    return driverFor(m?.siteId).sendPrompt(prompt, { ...opts, model: qualified });
  },
  driverStatus,
  loginTrigger: (siteId) => driverFor(siteId || 'deepseek').openLogin(),
  loginAndReport: async (siteId) => {
    const sid = getSite(siteId) ? siteId : 'deepseek';
    const t0 = Date.now();
    try {
      const r = await driverFor(sid).openLogin();
      return { ok: true, siteId: sid, siteName: getSite(sid)?.name, ms: Date.now() - t0, ...(r || {}) };
    } catch (err) {
      return { ok: false, siteId: sid, siteName: getSite(sid)?.name, ms: Date.now() - t0, error: String(err?.message || err) };
    }
  },
  siteConnect: (siteId) => driverFor(siteId),
  // 与 DSH 侧同一签名 (siteId, dir)：把本机真实 Edge 的登录态导入所选站点。
  sessionImport: (siteId, dir) => driverFor(getSite(siteId) ? siteId : 'deepseek').importStorageFromProfile(dir),
  windowOpener: (siteId, action, opts = {}) => {
    const d = driverFor(siteId);
    return action === 'close' ? d.closeWindow() : d.openWindow(opts);
  },
  onHttp: (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname;
    // 多站点侧栏视图（主形态）：<siteId>.localhost:<port>/…
    // 与 DSH 侧（lib/index.js）同一规则：站点住在自己的源上，pathname 与真实
    // 站点逐字一致，SPA router 基线与根相对资源天然正确。独立运行时也需要它，
    // 否则 standalone 下 doubao/z.ai/qwen 仍然是「打不开 / 登录跳回根」。
    const hostSite = /^([a-z0-9-]+)\.localhost(:\d+)?$/i.exec(String(req.headers.host || ''));
    const LOCAL_PREFIXES = ['/v1/', '/bridge/', '/webcode/', '/__webcode/'];
    const isControlPath = LOCAL_PREFIXES.some((p) => pathname === p.slice(0, -1) || pathname.startsWith(p));
    if (hostSite && getSite(hostSite[1].toLowerCase()) && !isControlPath) {
      const sid = hostSite[1].toLowerCase();
      mirrorFor(sid).handle(req, res, pathname, u.search).catch(() => { try { res.end(); } catch {} });
      return;
    }
    // 兼容旧路径形态：/__webcode/site/<siteId>/… → 对应站点 mirror
    const siteRoute = /^\/__webcode\/site\/([a-z0-9-]+)(\/.*)?$/.exec(pathname);
    if (siteRoute) {
      const [, sid, rest = '/'] = siteRoute;
      if (!getSite(sid)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unknown site: ' + sid } }));
        return;
      }
      mirrorFor(sid, { prefixed: true }).handle(req, res, rest, u.search).catch(() => { try { res.end(); } catch {} });
      return;
    }
    // web-side control plane fallbacks (no DSH host services here, so
    // sessions/history/preview work and import reports unavailable)
    if (pathname === '/bridge/web/preview') {
      webControl.handlePreview(req, res).catch(() => { try { res.end(); } catch {} });
      return;
    }
    if (pathname.startsWith('/bridge/web/') || pathname.startsWith('/__webcode/')) {
      webControl.handle(req, res, pathname).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'no route: ' + pathname } }));
        }
      }).catch(() => { try { res.end(); } catch {} });
      return;
    }
    if (!frontClaims(pathname)) {
      mirror.handle(req, res, pathname, u.search).catch(() => { try { res.end(); } catch {} });
      return;
    }
    if (!front) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'front not ready' } }));
      return;
    }
    front.handle(req, res, pathname);
  },
});
const webControl = createWebControl({ driver, relay, config: cfg, host: {}, logger: console });
const mirror = createMirror({ siteOrigin: new URL(cfg.site).origin, getToken: () => driver.getToken(), logger: console });
// 多站点镜像：懒创建，两种挂载形态各一份实例——子域根挂载（主形态，
// mountPrefix ''）与路径前缀挂载（兼容形态 /__webcode/site/<siteId>/…）。
// 同 lib/index.js 的 mirrorFor：两者都是同一站点同一 driver 的只读转发。
const mirrors = new Map();
function mirrorFor(siteId, { prefixed = false } = {}) {
  const sid = getSite(siteId) ? siteId : 'deepseek';
  const key = sid + (prefixed ? '#path' : '');
  if (!mirrors.has(key)) {
    const st = getSite(sid);
    mirrors.set(key, createMirror({
      siteOrigin: st.origin,
      getToken: () => driverFor(sid).getToken(),
      logger: console,
      assetOrigins: st.staticOrigins || [],
      mountPrefix: prefixed ? '/__webcode/site/' + sid : '',
      // 子域形态 pathname 与真实站点逐字一致，无需（也不应）改写路由基线。
      rootPathForSpa: prefixed && st.rootPathForSpa === true,
    }));
  }
  return mirrors.get(key);
}

/** Routes the OpenAI front owns on the relay; everything else mirrors upstream. */
function frontClaims(pathname) {
  return pathname.startsWith('/v1') || pathname.startsWith('/webcode/v1') ||
    pathname === '/bridge/status' || pathname === '/bridge/consent' ||
    pathname === '/bridge/login' || pathname === '/bridge/import-session';
}
front = createOpenAiFront(relay, {
  providerId: 'webcode',
  modelId: process.env.WEBCODE_MODEL_ID || 'deepseek-web',
  modelName: 'DeepSeek Web (网页版)',
});
relay.start();

setTimeout(() => {
  const st = relay.status();
  if (!st.running) {
    console.error('[webcode-bridge] failed to start:', st.startError);
    process.exit(1);
  }
}, 1500);

process.on('SIGINT', () => { relay.stop(); driver.close().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { relay.stop(); driver.close().finally(() => process.exit(0)); });
