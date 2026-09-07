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
import { DEEPSEEK, resolveWebModel, DEEPSEEK_WEB_CONTRACT } from './contract.js';
import { deriveLastRate } from './metrics.js';
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
  input: DEEPSEEK_WEB_CONTRACT.inputSelector,
  sendButton: DEEPSEEK_WEB_CONTRACT.sendButtonSelector,
  stopButton: DEEPSEEK_WEB_CONTRACT.stopButtonSelector,
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
  let lastFinished = null; // the entry finishActive() just retired — carries turn timing
  let Decoder = null;
  let loggedIn = null;
  let selectedModel = null;
  let requestMetadata = null;
  let launching = null;
  let interaction = Promise.resolve();
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
    // 防止并行 agents / 长期使用让会话槽无限增长：保留最近 128 个。
    if (conversations.size > 128) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [k, v] of conversations) {
        if (v && v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
      }
      if (oldestKey) conversations.delete(oldestKey);
    }
    saveStore();
  }
  function forgetConversation(key) {
    loadStore();
    conversations.delete(String(key || 'main'));
    saveStore();
  }

  function status() {
    loadStore();
    return {
      running: Boolean(ctx),
      busy,
      loggedIn,
      needLogin: loggedIn === false,
      selectedModel,
      profileDir: cfg.profileDir,
      lastTurn,
      lastRate: deriveLastRate(lastFinished, selectedModel),
      conversations: Object.fromEntries(conversations),
      transport: 'playwright-edge',
      preview: Boolean(page && !page.isClosed?.()),
    };
  }

  function defaultEdgePath() {
    for (const c of [
      // Windows
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      // macOS
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      // Linux
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/microsoft-edge-dev',
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
        active.decoder = new Decoder({
          onDelta: (t) => {
            if (active.firstResponseAt == null) active.firstResponseAt = performance.now();
            active.text += t;
            try { active.onDelta?.(t); } catch {}
          },
          onThink: () => { if (active.firstThinkAt == null) active.firstThinkAt = performance.now(); },
        });
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
    if (a) lastFinished = a;
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
      viewport: { width: 640, height: 900 },
      ...(cfg.storageState ? { storageState: cfg.storageState } : {}),
    });
    page = ctx.pages()[0] || (await ctx.newPage());
    page.on('request', request => {
      if (request.method() !== 'POST' || !request.url().includes('/api/v0/chat/completion')) return;
      try {
        const body = request.postDataJSON();
        requestMetadata = Object.fromEntries(Object.entries(body).filter(([key, value]) => /model|thinking|search/.test(key) && ['string', 'boolean', 'number'].includes(typeof value)));
      } catch { requestMetadata = null; }
    });
    await page.exposeBinding('__webcodeChunk', (source, captureId, phase, text) => {
      onPageCapture({ captureId, phase, text });
    });
    await page.addInitScript(CAPTURE_INIT);
    log(`launched (${headless ?? cfg.headless ? 'headless' : 'headed'}) profile=${cfg.profileDir}`);
  }

  async function ensure() {
    if (launching) return launching;
    if (ctx && page && !page.isClosed()) return;
    if (!Decoder) Decoder = loadDecoderClass(cfg.decoderPath);
    launching = launch();
    try { await launching; } finally { launching = null; }
  }

  async function connect() {
    await ensure();
    if (!busy && new URL(page.url()).origin !== new URL(cfg.site).origin) loggedIn = await gotoFreshChat();
    else loggedIn = await page.locator(SEL.input).count() > 0;
    return { ok: true, loggedIn };
  }

  function interact(body) {
    const task = interaction.then(async () => {
      if (busy) throw new Error('生成期间暂不可操作网页');
      if (!page || new URL(page.url()).origin !== new URL(cfg.site).origin) throw new Error('网页未就绪');
      const size = page.viewportSize();
      if (body.type === 'click' && Number.isFinite(body.x) && Number.isFinite(body.y) && body.x >= 0 && body.x <= 1 && body.y >= 0 && body.y <= 1) {
        await page.mouse.click(body.x * size.width, body.y * size.height);
      } else if (body.type === 'scroll' && Number.isFinite(body.deltaY)) {
        await page.mouse.wheel(0, Math.max(-900, Math.min(900, body.deltaY)));
      } else if (body.type === 'text' && typeof body.text === 'string' && body.text.length <= 32000) {
        await page.keyboard.insertText(body.text);
      } else if (body.type === 'key' && typeof body.key === 'string' && (body.key.length === 1 || /^(Enter|Backspace|Delete|Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End)$/.test(body.key))) {
        await page.keyboard.press(body.key);
      } else throw new Error('无效网页操作');
      return { ok: true };
    });
    interaction = task.catch(() => {});
    return task;
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
  /**
   * Upload image attachments through the page's own file input (识图模式).
   * Files: [{ name, contentType, data(base64) }]. The thumbnails must finish
   * uploading before the text is sent, so wait for the composer to settle.
   */
  async function uploadImages(files) {
    const fi = page.locator("input[type='file']").first();
    if (!await fi.count()) {
      const err = new Error('ATTACH_UNAVAILABLE: 页面没有可用的文件上传入口');
      err.code = 'ATTACH_UNAVAILABLE';
      throw err;
    }
    const payloads = files.slice(0, 6).map((f) => ({
      name: String(f.name || 'image.png').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'image.png',
      mimeType: String(f.contentType || 'image/png'),
      buffer: Buffer.from(String(f.data || ''), 'base64'),
    }));
    await fi.setInputFiles(payloads);
    // give the site time to render thumbnails / finish its own upload calls
    await page.waitForTimeout(500);
  }

  async function runTurn(message, { navigate, signal, onDelta, model, images } = {}) {
    if (busy) throw new Error('driver busy');
    busy = true;
    let timer = null;
    let rebuilt = false; // 续聊目标被删除/不可达时，自动降级到新会话
    // Register abort handling BEFORE any await: a caller that cancels while
    // Edge is still cold-starting must not end up sending the prompt anyway.
    if (signal?.aborted) { busy = false; throw abortError(); }
    const throwIfAborted = () => { if (signal?.aborted) throw abortError(); };
    const onAbort = () => {
      const a = finishActive();
      void (async () => {
        try {
          const stop = page?.locator(SEL.stopButton);
          if (stop && await stop.isVisible()) await stop.click({ timeout: 1000 });
        } catch {}
      })();
      a?.reject?.(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await ensure();
      throwIfAborted();

      if (navigate === 'fresh') {
        const inputReady = await gotoFreshChat();
        throwIfAborted();
        if (!inputReady) {
          loggedIn = false;
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
          rebuilt = true;
          warn('conversation page unreachable, falling back to a fresh chat');
          const inputReady = await gotoFreshChat();
          if (!inputReady) {
            const err = new Error('NEED_LOGIN: web AI session missing — open the Web AI panel and log in once');
            err.code = 'NEED_LOGIN';
            throw err;
          }
        }
      }

      loggedIn = true;
      const selection = model
        ? await selectModel(model, { hasImages: Array.isArray(images) && images.length > 0 })
        : null;
      const search = page.locator('[aria-pressed]').filter({ hasText: DEEPSEEK_WEB_CONTRACT.searchTogglePattern });
      if (await search.count() && await search.first().getAttribute('aria-pressed') === 'true') await search.first().click();
      throwIfAborted();
      if (Array.isArray(images) && images.length) {
        await uploadImages(images);
        throwIfAborted();
      }
      const done = new Promise((resolve, reject) => {
        active = { captureId: null, decoder: null, text: '', onDelta, resolve, reject, timer: null, firstThinkAt: null, firstResponseAt: null, t0: null };
      });
      timer = setTimeout(() => {
        const a = finishActive();
        const err = new Error(`web turn timed out after ${cfg.requestTimeoutMs}ms`);
        if (a) a.reject(err); else warn(err.message);
      }, cfg.requestTimeoutMs);
      if (active) active.timer = timer;

      done.catch(() => {});
      if (String(message).length > 400_000) {
        warn(`large prompt: ${String(message).length} chars — the web composer may become slow; consider trimming context`);
      }
      const input = page.locator(SEL.input).first();
      await input.fill(message);
      throwIfAborted();
      if (active) active.t0 = performance.now();
      await input.press('Enter');

      const result = await done;
      if (model && requestMetadata?.model_type && selection?.strict !== false) {
        // 真机实测（real-probe-08）确认：网页识图模式在 /api/v0/chat/completion
        // 上报 model_type:"vision"（并非"基于 V4-Flash 仍上报 default"——那是
        // 二手调研的错误结论，曾导致此期望被误改成 default 而误报）。三个模式
        // 的真实上报值：flash→default / deepseek→expert / vision→vision。
        const expected = DEEPSEEK_WEB_CONTRACT.expectedModelType(model);
        if (requestMetadata.model_type !== expected) throw new Error('MODEL_UI_CHANGED: 网页实际模型与所选模型不一致');
      }
      if (!result.complete) throw new Error('web capture ended incomplete: ' + (result.reason || 'unknown'));
      if (!result.text?.trim()) throw new Error('empty response from web AI');
      lastTurn = { sessionId: sessionIdFromUrl(page.url()), url: safeUrl(page.url()), at: Date.now(), rebuilt };
      // Real phase metrics (ms) from the SSE stream: send → first THINK
      // fragment → first RESPONSE fragment → stream end. The relay prefers
      // these over its own coarse estimates. The entry is retired (active
      // nulled) by the time `done` resolves, so timing lives on lastFinished.
      const endAt = performance.now();
      const fin = lastFinished;
      const t0 = fin?.t0 ?? endAt;
      const firstResponseMs = fin?.firstResponseAt != null ? Math.round(fin.firstResponseAt - t0) : null;
      const thinkingMs = fin?.firstThinkAt != null
        ? Math.round((fin.firstResponseAt ?? endAt) - fin.firstThinkAt)
        : null;
      const metrics = {
        endToEndMs: Math.round(endAt - t0),
        firstResponseMs,
        thinkingMs,
        responseMs: firstResponseMs != null ? Math.max(1, Math.round(endAt - t0) - firstResponseMs) : null,
      };
      // Expose the real phase metrics on status() too, so the settings page can
      // show measured generation speed against any coarse estimate.
      if (fin) Object.assign(fin, { metrics, chars: (result.text || '').length });
      return { text: result.text, sessionId: lastTurn.sessionId, metrics, rebuilt };
    } finally {
      signal?.removeEventListener('abort', onAbort);
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
  async function sendTurn(key, message, { fresh = false, signal, onDelta, model, images } = {}) {
    const existing = conversationFor(key);
    let navigate = 'fresh';
    if (!fresh && existing?.webSessionId) {
      const root = new URL(cfg.site);
      navigate = root.origin + '/a/chat/s/' + encodeURIComponent(existing.webSessionId);
    }
    const result = await runTurn(message, { navigate, signal, onDelta, model, images });
    if (result.sessionId) rememberConversation(key, result.sessionId);
    else if (navigate !== 'fresh') {
      // continued page but no id in URL — treat as diverged, reset the slot
      forgetConversation(key);
    }
    return result;
  }

  /** Stateless single turn (OpenAI HTTP front / aux calls): always fresh. */
  async function sendPrompt(prompt, { signal, onDelta, meta, model } = {}) {
    return runTurn(prompt, { navigate: 'fresh', signal, onDelta, model: model || meta?.model, images: meta?.images });
  }

  async function selectModel(value, { hasImages = false } = {}) {
    const model = resolveWebModel(value);
    if (model.id === 'vision' && !hasImages) {
      const err = new Error('VISION_REQUIRES_IMAGE: 识图模式必须附带至少一张图片');
      err.code = 'VISION_REQUIRES_IMAGE';
      throw err;
    }
    const label = new RegExp('^(?:' + model.labels.join('|') + ')$', 'i');
    let mode = page.getByText(model.labels[0], { exact: true });
    // Conversation pages expose only the selected label until its menu opens.
    if (!await mode.count()) {
      const current = page.getByText(/^(快速模式|专家模式|识图模式)$/).filter({ visible: true });
      if (await current.count()) await current.first().click();
    }
    mode = page.getByText(model.labels[0], { exact: true }).filter({ visible: true });
    if (await mode.count()) {
      await mode.last().click();
      await page.keyboard.press('Escape');
      selectedModel = model.id;
      return { strict: true };
    }
    const native = page.locator('select[aria-label="模型"], select[aria-label="Model"]');
    if (await native.count()) {
      const option = native.first().locator(`option[value="${model.id}"]`);
      if (!await option.count()) {
        if (model.id === 'vision' && hasImages) {
          selectedModel = model.id;
          return { strict: false, fallback: 'image-attachment' };
        }
        throw new Error('MODEL_UNAVAILABLE: 当前账号没有目标模型 ' + model.id);
      }
      await native.first().selectOption(model.id);
      if (await native.first().inputValue() !== model.id) throw new Error('模型选择未生效');
      selectedModel = model.id;
      return { strict: true };
    }
    // 旧版页面没有下拉模型目录，只有深度思考开关；不能把 Vision 伪装成文本模型。
    const thinking = page.getByRole('button', { name: /^深度思考$|^DeepThink(?: \(R1\))?$/i });
    if (await thinking.count()) {
      if (model.id === 'vision' && hasImages) {
        selectedModel = model.id;
        return { strict: false, fallback: 'image-attachment' };
      }
      if (model.id === 'vision') throw new Error('MODEL_UNAVAILABLE: 当前网页没有独立 Vision 模型选择器');
      const control = thinking.first();
      const pressed = await control.getAttribute('aria-pressed');
      const state = await control.getAttribute('data-state');
      if (pressed !== null || state !== null) {
        const enabled = pressed === 'true' || state === 'on' || state === 'checked';
        if (enabled !== (model.id === 'deepseek')) await control.click();
        selectedModel = model.id;
        return { strict: true };
      }
    }
    const trigger = page.getByRole('button', { name: /^(Flash|Vision|DeepSeek|模型|Model|快速|极速|视觉|深度思考)$/i });
    if (!await trigger.count()) {
      if (model.id === 'vision' && hasImages) {
        selectedModel = model.id;
        return { strict: false, fallback: 'image-attachment' };
      }
      throw new Error('MODEL_UI_CHANGED: 未找到模型选择器');
    }
    await trigger.first().click();
    const option = page.getByRole('option', { name: label }).or(page.getByRole('menuitem', { name: label }));
    if (!await option.count()) {
      if (model.id === 'vision' && hasImages) {
        selectedModel = model.id;
        return { strict: false, fallback: 'image-attachment' };
      }
      throw new Error('MODEL_UNAVAILABLE: 当前账号没有目标模型 ' + model.id);
    }
    await option.first().click();
    if (!await page.getByRole('button', { name: label }).count()) throw new Error('模型选择未确认');
    return { strict: true };
    selectedModel = model.id;
  }

  async function diagnostics() {
    if (!page) return { controls: [], urlPath: null, transport: 'playwright-edge', preview: false };
    return {
      urlPath: new URL(page.url()).pathname,
      selectedModel,
      requestMetadata,
      transport: 'playwright-edge',
      preview: !page.isClosed?.(),
      conversationCount: conversations.size,
      controls: await page.locator('body *').evaluateAll(nodes => nodes.filter(n => /^(快速模式|专家模式|识图模式|深度思考|智能搜索)$/.test((n.textContent || '').trim())).map(n => ({ text: n.textContent.trim(), tag: n.tagName, pressed: n.getAttribute('aria-pressed'), state: n.getAttribute('data-state'), className: n.className, parentClass: n.parentElement?.className })).slice(0, 25)),
    };
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
    finishActive()?.reject?.(abortError());
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

  /** Match the headless viewport to the panel container so the preview is
   *  WYSIWYG (clicks map 1:1) instead of a squeezed 640×900. */
  async function syncViewport(width, height) {
    if (!page || page.isClosed?.()) return;
    const w = Math.round(Math.min(1600, Math.max(360, Number(width) || 0)));
    const h = Math.round(Math.min(2000, Math.max(480, Number(height) || 0)));
    const cur = page.viewportSize();
    if (!cur || Math.abs(cur.width - w) > 8 || Math.abs(cur.height - h) > 8) {
      await page.setViewportSize({ width: w, height: h }).catch(() => {});
    }
  }

  /**
   * Bounding box (viewport CSS px) of the chat column — the area RIGHT of the
   * session sidebar. Two layouts are covered: flex rows (the column is a
   * narrow ancestor) and overlay/margin sidebars (probe the left gutter with
   * elementFromPoint). When nothing occupies the gutter (sidebar collapsed)
   * there is nothing to cut → null = full page.
   */
  async function chatClipRect() {
    return page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 120; };
      // the composer itself is only ~50px tall — visibility filter applies to
      // its ANCESTORS, not to the textarea discovery
      const input = [...document.querySelectorAll('textarea.ds-scroll-area, textarea')].find((e) => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 0; });
      if (!input) return null;
      const vw = window.innerWidth, vh = window.innerHeight;
      const ir = input.getBoundingClientRect();
      let best = null;
      for (let el = input; el && el !== document.body; el = el.parentElement) {
        const r = el.getBoundingClientRect();
        if (!vis(el)) continue;
        // a container wide as the viewport spans the sidebar too — stop before it
        if (r.width >= vw * 0.96) break;
        if (!best || r.width > best.w) best = { x: r.x, w: r.width };
      }
      if (best && best.w >= vw * 0.5) {
        const x = Math.max(0, Math.round(best.x));
        return { x, y: 0, width: Math.min(vw - x, Math.round(best.w)), height: vh };
      }
      // overlay/margin layout: whatever sits in the left gutter next to the composer
      const probe = document.elementFromPoint(12, Math.max(12, Math.min(vh - 12, ir.y || 300)));
      if (probe) {
        const pr = probe.getBoundingClientRect();
        if (pr.right > 8 && pr.right <= ir.x + 4 && pr.width < vw * 0.5) {
          return { x: Math.round(pr.right), y: 0, width: Math.round(vw - pr.right), height: vh };
        }
      }
      return null;
    }).catch(() => null);
  }

  /** JPEG screenshot of the driver page — the real-time official-site view.
   *  With { width, height } the viewport is resized first (panel-size sync);
   *  the returned clip metadata lets the client map clicks into the page. */
  async function screenshotBase64({ quality = 55, width, height, withMeta = false } = {}) {
    if (!ctx || !page || page.isClosed?.()) return null;
    if (width || height) await syncViewport(width, height);
    const clip = await chatClipRect();
    const opts = { type: 'jpeg', quality: Math.min(90, Math.max(30, quality)), timeout: 8000 };
    if (clip) opts.clip = clip;
    const buf = await page.screenshot(opts);
    const b64 = buf.toString('base64');
    if (!withMeta) return b64;
    return { base64: b64, clip, viewport: page.viewportSize() };
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

  return { sendPrompt, sendTurn, resetConversation, conversationFor, connect, interact, openLogin, importStorageFromProfile, status, close, diagnostics, getToken, get page() { return page; }, webApi, listSessions, fetchHistory, screenshotBase64 };
}

function abortError() {
  const err = new Error('webcode driver: aborted');
  err.name = 'AbortError';
  return err;
}
