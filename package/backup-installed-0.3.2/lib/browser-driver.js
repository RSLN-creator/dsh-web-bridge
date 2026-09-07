// browser-driver.js — in-package browser automation (no extension needed).
//
// Drives the system Edge (playwright-core + executablePath) against the web
// AI site with a dedicated persistent profile:
//   • first use: a headed window opens for a one-time login;
//   • afterwards: headless, invisible — fill input, auto-send, capture the
//     site's own SSE response via an init script, stream deltas out.
//
// The capture init script mirrors extension/content/capture_page.js (XHR +
// fetch wrap, tee for fetch) and forwards chunks through an exposed binding.

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The decoder is a plain browser-style script that defines a global; load it
// into this Node process the same way the unit test does.
const decoderPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'decoder.js');
// Fallback: repo-relative resolution may differ when installed as a package —
// accept an explicit path via options.decoderPath.
function loadDecoderClass(explicitPath) {
  const p = explicitPath || decoderPath;
  const code = fs.readFileSync(p, 'utf8');
  new Function(code)();
  return globalThis.WebCodeDeepSeekStreamDecoder;
}

const SEL = {
  input: 'textarea.ds-scroll-area',
  sendButton: "div[role='button']:has(path[d^='M8.3125'])",
  stopButton: "div[role='button']:has(path[d^='M2 4.88'])",
};

const CAPTURE_INIT = `
(function () {
  if (window.__webcodeCaptureInstalled) return;
  window.__webcodeCaptureInstalled = true;
  const TARGET = '/api/v0/chat/completion';
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  function emit(id, phase, text) { try { window.__webcodeChunk(id, phase, text || ''); } catch {} }
  function newId() { return 'cap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__wcInfo = { method: String(method || '').toUpperCase(), url: String(url || '') }; } catch {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const info = this.__wcInfo;
    if (info && info.method === 'POST' && info.url.includes(TARGET)) {
      const id = newId();
      let lastLen = 0;
      const drain = () => {
        try {
          const t = typeof this.responseText === 'string' ? this.responseText : '';
          if (t.length > lastLen) { emit(id, 'chunk', t.slice(lastLen)); lastLen = t.length; }
        } catch {}
      };
      const timer = setInterval(drain, 30);
      emit(id, 'start', '');
      this.addEventListener('loadend', () => { clearInterval(timer); drain(); emit(id, 'end', ''); });
    }
    return origSend.apply(this, arguments);
  };
  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = async function (input, init) {
      const resp = await origFetch(input, init);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (method === 'POST' && url.includes(TARGET) && resp.ok && resp.body) {
          const id = newId();
          emit(id, 'start', '');
          const [forPage, forCapture] = resp.body.tee();
          const reader = forCapture.getReader();
          const dec = new TextDecoder();
          (async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                emit(id, 'chunk', dec.decode(value, { stream: true }));
              }
            } catch {}
            emit(id, 'end', '');
          })();
          return new Response(forPage, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
        }
      } catch {}
      return resp;
    };
  }
})();
`;

const fillAndSend = (prompt) => {
  const SEL = {
    input: 'textarea.ds-scroll-area',
    sendButton: "div[role='button']:has(path[d^='M8.3125'])",
  };
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const el = [...document.querySelectorAll(SEL.input)].find(visible) || document.querySelector(SEL.input);
  if (!el) return { ok: false, reason: 'input-not-found' };
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, prompt);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  const base = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', base));
  el.dispatchEvent(new KeyboardEvent('keypress', base));
  el.dispatchEvent(new KeyboardEvent('keyup', base));
  return { ok: true };
};

export function createBrowserDriver(options = {}) {
  const cfg = {
    site: options.site ?? 'https://chat.deepseek.com/',
    profileDir: options.profileDir,
    executablePath: options.executablePath ?? defaultEdgePath(),
    headless: options.headless !== false,
    loginTimeoutMs: options.loginTimeoutMs ?? 300_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 240_000,
    decoderPath: options.decoderPath ?? null,
    logger: options.logger ?? console,
  };
  const log = (...a) => cfg.logger.log?.('[webcode-driver]', ...a);
  const warn = (...a) => cfg.logger.warn?.('[webcode-driver]', ...a);

  let ctx = null;
  let page = null;
  let busy = false;
  let active = null;   // { captureId, decoder, text, onDelta, resolve, reject }
  let Decoder = null;
  let lastTurn = null; // { sessionId, url, at } — web session the last turn landed in
  // session-mode store: dshSessionId → { webSessionId, at } — one web
  // conversation per DSH session, persisted so restarts resume the chat
  let conversations = new Map();
  let storeLoaded = false;
  const storePath = () => path.join(cfg.profileDir, 'webcode-sessions.json');

  function loadStore() {
    if (storeLoaded) return;
    storeLoaded = true;
    try {
      const j = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
      if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) {
        if (v && typeof v.webSessionId === 'string') conversations.set(k, v);
      }
    } catch { /* first run / corrupt → empty */ }
  }
  function saveStore() {
    try {
      fs.mkdirSync(cfg.profileDir, { recursive: true });
      fs.writeFileSync(storePath(), JSON.stringify(Object.fromEntries(conversations), null, 2));
    } catch (e) { warn('session store save failed:', e?.message); }
  }
  function conversationFor(key) {
    loadStore();
    return conversations.get(String(key || 'main')) || null;
  }
  function rememberConversation(key, webSessionId) {
    loadStore();
    conversations.set(String(key || 'main'), { webSessionId, at: Date.now() });
    saveStore();
  }
  function forgetConversation(key) {
    loadStore();
    conversations.delete(String(key || 'main'));
    saveStore();
  }

  function status() {
    return {
      running: Boolean(ctx),
      busy,
      loggedIn: null,     // unknown until a page check runs
      needLogin: false,
      profileDir: cfg.profileDir,
      lastTurn,
      conversations: Object.fromEntries(conversations),
    };
  }

  function defaultEdgePath() {
    for (const c of [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]) {
      try { if (fs.existsSync(c)) return c; } catch {}
    }
    return null;
  }

  function onPageCapture(m) {
    if (!active) return;
    if (m.phase === 'start') {
      if (!active.captureId) {
        active.captureId = m.captureId;
        active.decoder = new Decoder({ onDelta: (t) => { active.text += t; try { active.onDelta?.(t); } catch {} } });
      }
      return;
    }
    if (m.captureId !== active.captureId) return;
    if (m.phase === 'chunk' && active.decoder) active.decoder.push(m.text);
    if (m.phase === 'end' && active.decoder) {
      const result = active.decoder.finish();
      const resolve = active.resolve;
      finishActive();
      resolve(result);
    }
  }

  function finishActive() {
    const a = active;
    active = null;
    busy = false;
    if (a?.timer) clearTimeout(a.timer);
    return a;
  }

  async function launch({ headless } = {}) {
    if (!cfg.executablePath) throw new Error('system Edge not found — install Edge or set executablePath');
    fs.mkdirSync(cfg.profileDir, { recursive: true });
    ctx = await chromium.launchPersistentContext(cfg.profileDir, {
      executablePath: cfg.executablePath,
      headless: headless ?? cfg.headless,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
      viewport: { width: 1280, height: 860 },
      ...(cfg.storageState ? { storageState: cfg.storageState } : {}),
    });
    page = ctx.pages()[0] || (await ctx.newPage());
    await page.exposeBinding('__webcodeChunk', (source, captureId, phase, text) => {
      onPageCapture({ captureId, phase, text });
    });
    await page.addInitScript(CAPTURE_INIT);
    log(`launched (${headless ?? cfg.headless ? 'headless' : 'headed'}) profile=${cfg.profileDir}`);
  }

  async function ensure() {
    if (ctx) return;
    if (!Decoder) Decoder = loadDecoderClass(cfg.decoderPath);
    await fs.promises.mkdir(cfg.profileDir, { recursive: true });
    await launch();
  }

  async function gotoFreshChat() {
    const root = new URL(cfg.site);
    let u;
    try { u = new URL(page.url()); } catch { u = null; }
    if (!u || u.origin !== root.origin || u.pathname !== '/') {
      await page.goto(cfg.site, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }
    try {
      await page.waitForSelector(SEL.input, { timeout: 20_000 });
      return true;
    } catch {
      return false; // likely not logged in (redirected to /sign_in)
    }
  }

  /**
   * One web turn. `navigate`:
   *   'fresh'      → new web conversation (first turn of a session)
   *   '<chat url>' → existing conversation page (session continuation)
   * Fills the input, auto-sends, streams the answer via the capture hook.
   */
  async function runTurn(message, { navigate, signal, onDelta } = {}) {
    busy = true;
    let timer = null;
    // Register abort handling BEFORE any await: a caller that cancels while
    // Edge is still cold-starting must not end up sending the prompt anyway.
    if (signal?.aborted) { busy = false; throw abortError(); }
    const throwIfAborted = () => { if (signal?.aborted) throw abortError(); };
    signal?.addEventListener('abort', () => {
      const a = finishActive();
      void (async () => {
        try {
          const stop = page?.locator(SEL.stopButton);
          if (stop && await stop.isVisible()) await stop.click({ timeout: 1000 });
        } catch {}
      })();
      a?.reject?.(abortError());
    }, { once: true });
    try {
      await ensure();
      throwIfAborted();

      if (navigate === 'fresh') {
        const inputReady = await gotoFreshChat();
        throwIfAborted();
        if (!inputReady) {
          const err = new Error('NEED_LOGIN: web AI session missing — open the Web AI panel and log in once');
          err.code = 'NEED_LOGIN';
          throw err;
        }
      } else {
        // continue an existing conversation; if it is gone (deleted on the
        // web side), fall back to a fresh chat so the turn still lands
        let ready = false;
        try {
          const target = String(navigate);
          if (!page.url().startsWith(target)) {
            await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          }
          await page.waitForSelector(SEL.input, { timeout: 20_000 });
          ready = true;
        } catch { ready = false; }
        throwIfAborted();
        if (!ready) {
          warn('conversation page unreachable, falling back to a fresh chat');
          const inputReady = await gotoFreshChat();
          if (!inputReady) {
            const err = new Error('NEED_LOGIN: web AI session missing — open the Web AI panel and log in once');
            err.code = 'NEED_LOGIN';
            throw err;
          }
        }
      }

      const done = new Promise((resolve, reject) => {
        active = { captureId: null, decoder: null, text: '', onDelta, resolve, reject, timer: null };
      });
      timer = setTimeout(() => {
        const a = finishActive();
        const err = new Error(`web turn timed out after ${cfg.requestTimeoutMs}ms`);
        if (a) a.reject(err); else warn(err.message);
      }, cfg.requestTimeoutMs);
      if (active) active.timer = timer;

      const r = await page.evaluate(fillAndSend, message);
      if (!r?.ok) throw new Error('could not fill the web input (' + (r?.reason || 'unknown') + ')');

      const result = await done;
      if (!result.complete) throw new Error('web capture ended incomplete: ' + (result.reason || 'unknown'));
      if (!result.text?.trim()) throw new Error('empty response from web AI');
      lastTurn = { sessionId: sessionIdFromUrl(page.url()), url: safeUrl(page.url()), at: Date.now() };
      return { text: result.text, sessionId: lastTurn.sessionId };
    } finally {
      if (active) finishActive();
      else busy = false;
      void timer;
    }
  }

  /**
   * Session-mode turn: one web conversation per key. `fresh` forces a new
   * conversation (first turn / divergence reset); otherwise the stored
   * conversation page is reopened and only the incremental message lands.
   */
  async function sendTurn(key, message, { fresh = false, signal, onDelta } = {}) {
    const existing = conversationFor(key);
    let navigate = 'fresh';
    if (!fresh && existing?.webSessionId) {
      const root = new URL(cfg.site);
      navigate = root.origin + '/a/chat/s/' + encodeURIComponent(existing.webSessionId);
    }
    const result = await runTurn(message, { navigate, signal, onDelta });
    if (result.sessionId) rememberConversation(key, result.sessionId);
    else if (navigate !== 'fresh') {
      // continued page but no id in URL — treat as diverged, reset the slot
      forgetConversation(key);
    }
    return result;
  }

  /** Stateless single turn (OpenAI HTTP front / aux calls): always fresh. */
  async function sendPrompt(prompt, { signal, onDelta } = {}) {
    return runTurn(prompt, { navigate: 'fresh', signal, onDelta });
  }

  /** Drop one stored conversation (divergence reset); next turn starts fresh. */
  async function resetConversation(key) {
    forgetConversation(key);
  }

  /** The web login token, read inside the logged-in page (mirror seeding). */
  async function getToken() {
    await ensure();
    if (!page) throw new Error('driver page not ready');
    let origin = '';
    try { origin = new URL(page.url()).origin; } catch {}
    if (origin !== new URL(cfg.site).origin) {
      await page.goto(cfg.site, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    }
    return page.evaluate(() => {
      const raw = localStorage.getItem('userToken');
      try {
        const j = JSON.parse(raw || 'null');
        if (j && typeof j.value === 'string') return j.value;
      } catch { /* raw string form */ }
      return raw || null;
    });
  }

  /** Open a headed window for the one-time login; wait; then go headless. */
  async function openLogin({ onState } = {}) {
    if (busy) throw new Error('driver busy with a web turn — login refused');
    try { if (ctx) await ctx.close(); } catch {}
    ctx = null; page = null;
    log('opening headed window for login');
    await launch({ headless: false });
    try {
      await page.goto(cfg.site, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch {}
    onState?.('waiting-for-login');
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      if (Date.now() - t0 > cfg.loginTimeoutMs) throw new Error('login wait timed out');
      try {
        if (page.isClosed?.()) throw new Error('login window was closed before login completed');
        const u = new URL(page.url());
        if (u.pathname === '/sign_in') continue;
        const input = await page.$(SEL.input);
        if (input) break;
      } catch (err) {
        throw err;
      }
    }
    log('login detected; switching to headless');
    try { await ctx.close(); } catch {}
    ctx = null; page = null;
    await launch({ headless: true });
    await gotoFreshChat();
    onState?.('ready');
  }

  /** Adopt cookies+localStorage from another Edge profile (session transfer). */
  async function importStorageFromProfile(sourceProfileDir) {
    if (busy) throw new Error('driver busy with a web turn — session import refused');
    const cookiesFile = path.join(sourceProfileDir, 'Default', 'Network', 'Cookies');
    if (!fs.existsSync(cookiesFile)) throw new Error('source profile has no cookies: ' + sourceProfileDir);
    let tmp = null;
    try {
      tmp = await chromium.launchPersistentContext(sourceProfileDir, {
        executablePath: cfg.executablePath,
        headless: true,
        args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
      });
      cfg.storageState = await tmp.storageState();
    } finally {
      try { await tmp?.close(); } catch {}
    }
    // settle any half-open turn state before tearing the context down so a
    // pending sendPrompt promise rejects instead of hanging forever
    const stale = finishActive();
    stale?.reject?.(abortError('session import interrupted the web turn'));
    if (ctx) { try { await ctx.close(); } catch {} ctx = null; page = null; busy = false; active = null; }
    await launch({ headless: true });
    const ready = await gotoFreshChat();
    log('session imported; loggedIn =', ready);
    return { loggedIn: ready };
  }

  async function close() {
    try { await ctx?.close(); } catch {}
    ctx = null; page = null; busy = false; active = null;
  }

  // ---- web-side introspection (conversation sync / naming / preview) ----
  //
  // These run INSIDE the logged-in page, so they carry the site's own cookies
  // and the userToken it keeps in localStorage — no token ever leaves the
  // page and nothing is pasted by the user.

  /** GET/POST one DeepSeek web-internal API path with the page's own auth.
   *  apiPath must be a site-relative path — absolute URLs would turn this
   *  into "fetch anything with the user's Bearer token attached". */
  async function webApi(apiPath, { method = 'GET', body = null, timeoutMs = 20_000 } = {}) {
    if (typeof apiPath !== 'string' || !apiPath.startsWith('/') || apiPath.startsWith('//')) {
      throw new Error('webApi: site-relative path required');
    }
    await ensure();
    if (!page) throw new Error('driver page not ready');
    // localStorage (the token source) needs the site's real origin — an
    // about:blank tab has an opaque origin and denies access.
    let origin = '';
    try { origin = new URL(page.url()).origin; } catch {}
    if (origin !== new URL(cfg.site).origin) {
      await page.goto(cfg.site, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    }
    return page.evaluate(async ({ apiPath, method, body, timeoutMs }) => {
      const raw = localStorage.getItem('userToken');
      let token = raw || '';
      try {
        const j = JSON.parse(raw || 'null');
        if (j && typeof j.value === 'string') token = j.value;
      } catch { /* raw string form */ }
      const headers = {
        accept: 'application/json',
        'x-app-version': '20240105.0',
        'x-client-platform': 'web',
        'x-client-version': '1.0.0-alpine',
        'x-client-locale': 'zh_CN',
      };
      if (token) headers.authorization = 'Bearer ' + token;
      const init = { method, headers, credentials: 'include' };
      if (body !== null && body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const target = new URL(apiPath, location.origin);
        if (target.origin !== location.origin) throw new Error('cross-origin api path rejected');
        const resp = await fetch(target.toString(), { ...init, signal: ctrl.signal });
        const text = await resp.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* keep text */ }
        return { status: resp.status, ok: resp.ok, json, text: json ? undefined : text.slice(0, 2000) };
      } finally {
        clearTimeout(t);
      }
    }, { apiPath, method, body, timeoutMs });
  }

  /** Latest web conversations (title + time + id) — the real-time naming feed. */
  async function listSessions(count = 100) {
    const r = await webApi('/api/v0/chat_session/fetch_page?count=' + Math.min(500, Math.max(1, Number(count) || 100)));
    const data = r.json?.data ?? r.json;
    const biz = data?.biz_data ?? data;
    const arr = biz?.chat_sessions || biz?.sessions || biz?.chat_session_list || null;
    if (!Array.isArray(arr)) {
      const err = new Error('unexpected fetch_page payload' + (r.json?.code !== undefined ? ' code=' + r.json.code : ''));
      err.payload = JSON.stringify(r.json ?? r.text ?? '').slice(0, 400);
      throw err;
    }
    return {
      ok: true,
      sessions: arr.map((s) => ({
        id: s.id || s.chat_session_id || null,
        title: s.title || '(无标题)',
        updatedAt: s.updated_at || s.updatedAt || s.inserted_at || null,
      })).filter((s) => s.id),
    };
  }

  /** Full message history of one web conversation (raw, branch-aware fields
   *  preserved). Main-line selection + branch counting live in
   *  web-control.mainLineOf so they stay unit-testable. */
  async function fetchHistory(sessionId) {
    if (!/^[0-9a-zA-Z-]{8,64}$/.test(String(sessionId || ''))) throw new Error('invalid sessionId');
    const r = await webApi('/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sessionId));
    const data = r.json?.data ?? r.json;
    const biz = data?.biz_data ?? data;
    const arr = biz?.chat_messages || biz?.messages || biz?.history || null;
    if (!Array.isArray(arr)) {
      const err = new Error('unexpected history payload' + (r.json?.code !== undefined ? ' code=' + r.json.code : ''));
      err.payload = JSON.stringify(r.json ?? r.text ?? '').slice(0, 400);
      throw err;
    }
    return {
      ok: true,
      sessionId: String(sessionId),
      messages: arr.map((m) => ({
        id: m.id || m.message_id || null,
        role: String(m.role || '').toLowerCase(),
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        parentId: m.parent_id || m.parentId || null,
        isBranch: Boolean(m.is_branch ?? m.is_branch_point ?? false),
        at: m.inserted_at || m.created_at || null,
      })),
    };
  }

  /** JPEG screenshot of the driver page — the real-time official-site view. */
  async function screenshotBase64({ quality = 55 } = {}) {
    if (!ctx || !page || page.isClosed?.()) return null;
    const buf = await page.screenshot({ type: 'jpeg', quality: Math.min(90, Math.max(30, quality)), timeout: 8000 });
    return buf.toString('base64');
  }

  function sessionIdFromUrl(url) {
    try {
      const u = new URL(url);
      const q = u.searchParams.get('chat_session_id');
      if (q) return q;
      const m = u.pathname.match(/\/a\/chat\/s\/([0-9a-zA-Z-]{8,64})/);
      if (m) return m[1];
    } catch {}
    return null;
  }
  function safeUrl(url) { try { return String(new URL(url)); } catch { return null; } }

  return { sendPrompt, sendTurn, resetConversation, conversationFor, getToken, openLogin, importStorageFromProfile, status, close, get page() { return page; }, webApi, listSessions, fetchHistory, screenshotBase64 };
}

function abortError() {
  const err = new Error('webcode driver: aborted');
  err.name = 'AbortError';
  return err;
}
