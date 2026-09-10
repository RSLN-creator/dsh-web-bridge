// browser-driver.js — 内置浏览器自动化（无需扩展）。
//
// 用系统 Edge（playwright-core + executablePath）以独立持久 profile 驱动内容
// 服务网页：首次 headed 登录一次，之后 headless——填输入框、自动发送、通过
// init 脚本捕获站点自身的 SSE 流并吐出增量。
//
// 多站点：站点契约（输入框/按钮/捕获路径/解码器）来自 lib/contract.js；
// 解码器实例从 globalThis.WebCodeStreamDecoders 按站点 decoder 字段选用；
// 没有稳定网络流的站点（decoder:'dom'，如 Gemini）用页面终态抓取兜底。
//
// 思考链与图片：页面捕获 → decoder onThink/onImage → active → runTurn 返回
// {text, thinking, images}——修复“没有思考链条”“有图说没图”。

import { chromium } from 'playwright-core';
import { getSite, getContract, resolveWebModel } from './contract.js';
import { deriveLastRate } from './metrics.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const decoderPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'decoder.js');
function loadDecoderRegistry(explicitPath) {
  const p = explicitPath || decoderPath;
  const code = fs.readFileSync(p, 'utf8');
  new Function(code)();
  return globalThis.WebCodeStreamDecoders;
}

/** 捕获脚本：按站点 completionPaths 拦截 SSE（XHR drain + fetch tee）。 */
function captureInit(paths) {
  const list = JSON.stringify(paths.length ? paths : ['/api/v0/chat/completion']);
  return `
(function () {
  if (window.__webcodeCaptureInstalled) return;
  window.__webcodeCaptureInstalled = true;
  const TARGETS = ${list};
  const hit = (u) => TARGETS.some((t) => String(u || '').includes(t));
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
    if (info && info.method === 'POST' && hit(info.url)) {
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
        if (method === 'POST' && hit(url) && resp.ok && resp.body) {
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
}

/** DOM 兜底抓取（decoder:'dom' 站点）：等回答区稳定后抄全文。 */
const DOM_CAPTURE = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = () => {
    const sels = ['.markdown', '.answer', '[data-message-author-role="assistant"]', '.response-container', 'main'];
    for (const s of sels) {
      const nodes = [...document.querySelectorAll(s)];
      if (nodes.length) return nodes[nodes.length - 1].innerText || '';
    }
    return document.body.innerText || '';
  };
  let prev = text();
  let stable = 0;
  for (let i = 0; i < 240; i++) {
    await sleep(1000);
    const cur = text();
    if (cur === prev) stable++; else stable = 0;
    prev = cur;
    if (stable >= 4) break;
  }
  return prev;
})()
`;

export function createBrowserDriver(options = {}) {
  const siteId = options.siteId ?? 'deepseek';
  const site = getSite(siteId);
  const contract = getContract(siteId);
  if (!site || !contract) throw new Error('webcode driver: unknown siteId ' + siteId);
  const siteUrl = options.site ?? site.origin + '/';
  const cfg = {
    siteId,
    site: siteUrl,
    profileDir: options.profileDir,
    executablePath: options.executablePath ?? defaultEdgePath(),
    headless: options.headless !== false,
    loginTimeoutMs: options.loginTimeoutMs ?? 300_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 240_000,
    decoderPath: options.decoderPath ?? null,
    logger: options.logger ?? console,
  };
  const SEL = {
    input: contract.inputSelector,
    sendButton: contract.sendButtonSelector,
    stopButton: contract.stopButtonSelector,
  };
  const log = (...a) => cfg.logger.log?.('[webcode-driver:' + siteId + ']', ...a);
  const warn = (...a) => cfg.logger.warn?.('[webcode-driver:' + siteId + ']', ...a);

  let ctx = null;
  let page = null;
  let busy = false;
  let transitioning = false;
  let active = null;
  let lastFinished = null;
  let Decoders = null;
  let loggedIn = null;
  let selectedModel = null;
  let dsUi = null; // DeepSeek 网页 UI 代际缓存：'classic' | 'unified'（见 detectDeepSeekUi）
  let requestMetadata = null;
  let launching = null;
  let interaction = Promise.resolve();
  let lastTurn = null;
  let conversations = new Map();
  let storeLoaded = false;
  // 有头展示窗口：openWindow 打开，headlessMode 记录「无头会话是否曾在
  // 展示窗口上执行」——展示窗口被用户关闭后，Page#close 事件触发 relaunch。
  let headed = false;
  const storePath = () => path.join(cfg.profileDir, 'webcode-sessions-' + siteId + '.json');

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
  function conversationFor(key) { loadStore(); return conversations.get(String(key || 'main')) || null; }
  function rememberConversation(key, webSessionId) {
    loadStore();
    conversations.set(String(key || 'main'), { webSessionId, at: Date.now() });
    if (conversations.size > 128) {
      let oldestKey = null; let oldestAt = Infinity;
      for (const [k, v] of conversations) if (v && v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
      if (oldestKey) conversations.delete(oldestKey);
    }
    saveStore();
  }
  function forgetConversation(key) { loadStore(); conversations.delete(String(key || 'main')); saveStore(); }

  function status() {
    loadStore();
    return {
      running: Boolean(ctx),
      busy,
      loggedIn,
      needLogin: loggedIn === false,
      selectedModel,
      siteId,
      profileDir: cfg.profileDir,
      lastTurn,
      lastRate: deriveLastRate(lastFinished, selectedModel),
      conversations: Object.fromEntries(conversations),
      transport: 'playwright-edge',
      preview: Boolean(page && !page.isClosed?.()),
      window: windowState(),
    };
  }

  function defaultEdgePath() {
    for (const c of [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
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
      if (!active.captureId && active.decoderKind !== 'dom') {
        active.captureId = m.captureId;
        const Cls = Decoders?.[active.decoderKind] ?? Decoders?.deepseek;
        if (!Cls) { warn('no decoder for kind', active.decoderKind); return; }
        active.decoder = new Cls({
          onDelta: (t) => {
            if (active.firstResponseAt == null) active.firstResponseAt = performance.now();
            active.text += t;
            try { active.onDelta?.(t); } catch {}
          },
          onThink: (t) => {
            if (active.firstThinkAt == null) active.firstThinkAt = performance.now();
            active.thinking += t;
            try { active.onThink?.(t); } catch {}
          },
          onImage: (img) => {
            if (img) active.images.push(img);
            try { active.onImage?.(img); } catch {}
          },
        });
      }
      return;
    }
    if (active.captureId && m.captureId !== active.captureId) return;
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
    if (a) { try { a.settleResolve?.(); } catch {} }
    return a;
  }

  /** 当前轮次以「页面已死」这类故障收尾：立刻失败，不要干等到 requestTimeoutMs。
   *  返回 false 表示当时没有进行中的轮次（例如我们自己有意关掉上下文）。 */
  function failActive(reason, code) {
    const a = finishActive();
    if (!a) return false;
    const err = new Error(reason);
    err.code = code;
    warn(reason);
    try { a.reject?.(err); } catch {}
    return true;
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
    ctx.on('close', () => {
      ctx = null; page = null;
      failActive(`WEB_BROWSER_CLOSED: 浏览器已关闭 — 下一轮会自动重启`, 'WEB_BROWSER_CLOSED');
    });
    await installPage();
    log(`launched (${(headless ?? cfg.headless) ? 'headless' : 'headed'}) profile=${cfg.profileDir}`);
  }

  async function ensure() {
    if (launching) return launching;
    if (ctx && page && !page.isClosed()) return;
    // 展示窗口被用户关闭（page=null）或浏览器整个退出（ctx 已死）：
    // 无头转有头窗口保留在当前形态重开一页；无头会话则回到无头。
    const targetHeadless = ctx ? headed : cfg.headless !== false;
    if (ctx) {
      try { page = await ctx.newPage(); await installPage(); } catch { ctx = null; page = null; }
      if (page) return;
    }
    if (!Decoders) Decoders = loadDecoderRegistry(cfg.decoderPath);
    launching = (async () => { await launch({ headless: targetHeadless }); })();
    try { await launching; } finally { launching = null; }
  }

  /** 在已开的浏览器上下文里装捕获脚本（新页/自愈重开后共用），并挂上页面
   *  生命周期兜底。展示窗口被用户点 X 关掉时上下文仍在（页面关闭≠浏览器
   *  退出）：清掉 page 引用让 ensure() 下次自愈重开新页，而不是拿死句柄操作。
   *  页面崩溃 / 浏览器被整个关掉时，立刻让进行中的轮次失败——否则 240s 超时
   *  会被白白耗在死句柄上，长跑会表现为「卡住不动」。 */
  async function installPage() {
    const p = page;
  dsUi = null; // 换页/换浏览器后 UI 代际要重新侦测
    const paths = site.completionPaths || [];
    p.on('close', () => { if (page === p) page = null; });
    p.on('crash', () => {
      if (page === p) page = null;
      failActive(`WEB_PAGE_CRASHED: ${site.name} 页面崩溃 — 下一轮会自动重开`, 'WEB_PAGE_CRASHED');
    });
    p.on('request', (request) => {
      if (request.method() !== 'POST' || !paths.some((path) => request.url().includes(path))) return;
      try {
        const body = request.postDataJSON();
        requestMetadata = Object.fromEntries(Object.entries(body).filter(([key, value]) => /model|thinking|search/.test(key) && ['string', 'boolean', 'number'].includes(typeof value)));
      } catch { requestMetadata = null; }
    });
    await p.exposeBinding('__webcodeChunk', (source, captureId, phase, text) => {
      onPageCapture({ captureId, phase, text });
    }).catch(() => {});
    const init = captureInit(paths);
    await p.addInitScript(init);
    try { await p.evaluate(init); } catch { /* 页面尚未可用时忽略 */ }
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
      return false; // likely not logged in
    }
  }

  async function uploadImages(files) {
    const fi = page.locator(contract.attachSelector || "input[type='file']").first();
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
    await page.waitForTimeout(500);
  }

  async function runTurn(message, { navigate, signal, onDelta, onThink, onImage, model, images, thinkMode } = {}) {
    if (busy || transitioning) throw new Error('driver busy');
    busy = true;
    let timer = null;
    let stopClick = null;
    if (signal?.aborted) { busy = false; throw abortError(); }
    const throwIfAborted = () => { if (signal?.aborted) throw abortError(); };
    const onAbort = () => {
      const a = finishActive();
      // 中止必须把网页端仍在生成的这一轮真正停下：只放行 busy 不点停止，
      // 下一轮会在站点仍处于「生成中」时填框发送（输入被禁用、消息被吞）。
      stopClick = (async () => {
        try {
          // 没有停止按钮契约的站点就什么都不点：旧写法回落到
          // "div[role='button']" 会点到页面上第一个按钮（可能是「新会话」
          // 或发送），中止反而把页面搞乱。
          if (!SEL.stopButton) return;
          const stop = page?.locator(SEL.stopButton).first();
          if (stop && await stop.isVisible()) await stop.click({ timeout: 1000 });
        } catch {}
      })();
      a?.reject?.(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // 每次轮次重置请求元数据：上一轮（尤其被中止的那轮）残留的 model_type
      // 会让本轮的严格模型校验误判为 MODEL_UI_CHANGED。
      requestMetadata = null;
      await ensure();
      throwIfAborted();

      if (navigate === 'fresh') {
        const inputReady = await gotoFreshChat();
        throwIfAborted();
        if (!inputReady) {
          loggedIn = false;
          const err = new Error(`NEED_LOGIN: ${site.name} 会话缺失 — 打开 Web AI 面板登录一次`);
          err.code = 'NEED_LOGIN';
          throw err;
        }
      } else {
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
          // 会话在网页端已被删除或过期。旧实现在这里静默改开新会话、把这轮的
          // 增量照发——新会话既没有首轮预设也没有任何历史，模型带着半截上下文
          // 裸奔（长时间运行的会话删/过期后最常见的一类「越跑越傻」）。
          // 现在抛码给上层：游标作废、下一轮整段重建。
          const inputReady = await gotoFreshChat();
          if (!inputReady) {
            loggedIn = false;
            const err = new Error(`NEED_LOGIN:${site.name} 会话缺失 — 打开 Web AI 面板登录一次`);
            err.code = 'NEED_LOGIN';
            throw err;
          }
          const err = new Error('WEB_SESSION_LOST: 网页会话已不可达（已删除或过期） — 需要整段重建');
          err.code = 'WEB_SESSION_LOST';
          throw err;
        }
      }

      loggedIn = true;
      // thinkMode: 'auto'(按模型默认) | 'on'(强制开) | 'off'(强制关)——设置页手动覆盖。
      // DeepSeek 的「深度思考」pill 是独立开关,auto 时按模型 thinking 属性双向同步。
      const thinkOverride = thinkMode === 'on' ? true : thinkMode === 'off' ? false : null;
      const selection = model ? await selectModel(model, { hasImages: Array.isArray(images) && images.length > 0, thinkOverride }) : null;
      if (contract.searchTogglePattern) {
        const search = page.locator('[aria-pressed]').filter({ hasText: contract.searchTogglePattern });
        if (await search.count() && await search.first().getAttribute('aria-pressed') === 'true') await search.first().click();
      }
      throwIfAborted();
      if (Array.isArray(images) && images.length) {
        await uploadImages(images);
        throwIfAborted();
      }
      const done = new Promise((resolve, reject) => {
        let settleResolve;
        const settled = new Promise((r) => { settleResolve = r; });
        active = {
          captureId: null, decoder: null, decoderKind: site.decoder,
          text: '', thinking: '', images: [],
          onDelta, onThink, onImage, resolve, reject,
          settled, settleResolve,
          timer: null, firstThinkAt: null, firstResponseAt: null, t0: null,
        };
      });
      timer = setTimeout(() => {
        const a = finishActive();
        const err = new Error(`web turn timed out after ${cfg.requestTimeoutMs}ms`);
        if (a) a.reject(err); else warn(err.message);
      }, cfg.requestTimeoutMs);
      if (active) active.timer = timer;

      done.catch(() => {});
      if (String(message).length > 400_000) {
        warn(`large prompt:${String(message).length} chars — the web composer may become slow; consider trimming context`);
      }
      const input = page.locator(SEL.input).first();
      await input.fill(message);
      // 网页输入框有长度上限，超限会被静默截断——模型只看到半截提示词却照常
      // 作答，长跑里表现为「越到后面越答非所问」。回读一次，长度对不上就拒绝
      // 发送，让上层压缩后重试（此时还没按 Enter，网页端没有被污染）。
      const echoed = await input.inputValue().catch(() => null);
      if (typeof echoed === 'string' && echoed.length < String(message).length - 8) {
        const err = new Error(`PROMPT_TRUNCATED: 网页输入框只接收了 ${echoed.length}/${String(message).length} 字符（网页端长度上限）— 请缩短上下文或先压缩历史再重试`);
        err.code = 'PROMPT_TRUNCATED';
        throw err;
      }
      throwIfAborted();
      if (active) active.t0 = performance.now();
      await input.press('Enter');

      let result;
      if (site.decoder === 'dom') {
        // 无稳定网络流的站点：等页面终态，抄全文（无思考/图片）
        const text = await page.evaluate(DOM_CAPTURE).catch(() => '');
        result = { complete: Boolean(text.trim()), text: (text || '').trim(), thinking: '', images: [], reason: text ? undefined : 'dom_capture_empty' };
        const a = finishActive();
      } else {
        result = await done;
      }
      if (siteId === 'deepseek' && model && selection?.strict !== false) {
        // 「绝不静默降级模型」：核验本轮真实请求元数据。新版统一 UI 的模式差异在
        // thinking_enabled（model_type 恒为 default），旧三 pill UI 的差异在
        // model_type。取不到请求体本身即失败——旧实现只比对非空 model_type，
        // 请求体一旦改形（如 model_type 消失）就会静默放行。
        if (!requestMetadata) {
          const err = new Error('MODEL_UI_CHANGED: 未捕获到本轮 /chat/completion 请求体，无法核验网页实际模式');
          err.code = 'MODEL_UI_CHANGED';
          throw err;
        }
        const expect = contract.expectedRequestMetadata(model, { ui: selection?.ui, wantThink: selection?.wantThink });
        // 续聊消息（同会话第 2 条起）网页只发 model_type:null——语义是「沿用会话
        // 模型」，新会话首条已核验过，故 model_type 缺失/为 null 时跳过该项；其余
        // 期望键（unified 的 thinking_enabled）必须出现且相等，不允许静默降级。
        const bad = Object.entries(expect || {}).find(([k, want]) => {
          if (want == null) return false;
          const seen = requestMetadata[k];
          if (seen == null) return k !== 'model_type';
          return seen !== want;
        });
        if (bad) {
          const err = new Error(`MODEL_UI_CHANGED: 网页实际 ${bad[0]}=${JSON.stringify(requestMetadata[bad[0]])}，所选模式期望 ${JSON.stringify(bad[1])}`);
          err.code = 'MODEL_UI_CHANGED';
          throw err;
        }
      }
      if (!result.complete) throw new Error('web capture ended incomplete: ' + (result.reason || 'unknown'));
      if (!result.text?.trim()) throw new Error('empty response from web AI');
      lastTurn = { sessionId: sessionIdFromUrl(page.url()), url: safeUrl(page.url()), at: Date.now() };
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
      if (fin) Object.assign(fin, { metrics, chars: (result.text || '').length });
      return {
        text: result.text,
        thinking: result.thinking || '',
        images: Array.isArray(result.images) ? result.images : [],
        sessionId: lastTurn.sessionId,
        metrics,
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (active) finishActive();
      else busy = false;
      // 中止路径要把「点停止」等完再放行，否则下一轮与仍在生成的页面打架。
      if (stopClick) await stopClick.catch(() => {});
      void timer;
    }
  }

  async function sendTurn(key, message, { fresh = false, signal, onDelta, onThink, onImage, model, images, thinkMode } = {}) {
    const existing = conversationFor(key);
    let navigate = 'fresh';
    if (!fresh && existing?.webSessionId) {
      const root = new URL(cfg.site);
      navigate = root.origin + '/a/chat/s/' + encodeURIComponent(existing.webSessionId);
    } else if (!fresh) {
      // 上层要续聊、本地却没有对应的网页会话（store 丢了/被清过）。此时若默默
      // 开新会话并只发增量，网页模型会在毫无前文的情况下接着答——同样是静默
      // 丢上下文。抛码让上层重放首轮整段。
      const err = new Error('WEB_SESSION_LOST: 本地会话槽为空 — 需要整段重建');
      err.code = 'WEB_SESSION_LOST';
      throw err;
    }
    let result;
    try {
      result = await runTurn(message, { navigate, signal, onDelta, onThink, onImage, model, images, thinkMode });
    } catch (err) {
      // 会话槽里存的是一个已经死掉的网页会话：立刻丢掉，别让下一轮再撞一次。
      // 上层收到 WEB_SESSION_LOST 后作废游标并以整段首轮提示词重开。
      if (err?.code === 'WEB_SESSION_LOST') forgetConversation(key);
      throw err;
    }
    if (result.sessionId) rememberConversation(key, result.sessionId);
    else if (navigate !== 'fresh') forgetConversation(key);
    return result;
  }

  async function sendPrompt(prompt, { signal, onDelta, onThink, onImage, meta, model, thinkMode } = {}) {
    return runTurn(prompt, {
      navigate: 'fresh', signal, onDelta, onThink, onImage, thinkMode,
      model: model || meta?.model,
      images: meta?.images,
    });
  }

  async function selectModel(value, { hasImages = false, thinkOverride = null } = {}) {
    const model = resolveWebModel(value);
    if (model.siteId !== siteId) throw new Error(`MODEL_SITE_MISMATCH: 模型 ${model.id} 属于站点${model.siteId}，当前驱动为 ${siteId}`);
    if (model.vision && !hasImages) {
      const err = new Error('VISION_REQUIRES_IMAGE: 识图模式必须附带至少一张图片');
      err.code = 'VISION_REQUIRES_IMAGE';
      throw err;
    }
    // 未真机校准的站点用「网页当前模型」入口:不做任何模型 UI 操作,
    // 网页上选什么就用什么(DOM 契约未知,乱点比不点风险更大)。
    if (model.id === 'auto') {
      selectedModel = model.id;
      return { strict: false, fallback: 'web-current' };
    }
    // 手动覆盖 > 模型默认;auto 时不干预 pill 之外的既有逻辑
    const label = new RegExp('^(?:' + model.labels.join('|') + ')$', 'i');
    if (siteId === 'deepseek') return selectModelDeepSeek(model, { hasImages, label, thinkOverride });
    return selectModelGeneric(model, { label });
  }

  async function selectModelGeneric(model, { label }) {
    let mode = page.getByText(model.labels[0], { exact: true }).filter({ visible: true });
    if (await mode.count()) {
      await mode.last().click();
      await page.keyboard.press('Escape');
      selectedModel = model.id;
      return { strict: true };
    }
    const trigger = page.getByRole('button', { name: /^(模型|Model|模式|Mode)/i }).first();
    if (await trigger.count()) {
      await trigger.click().catch(() => {});
      const option = page.getByRole('option', { name: label }).or(page.getByRole('menuitem', { name: label }));
      if (await option.count()) {
        await option.first().click();
        selectedModel = model.id;
        return { strict: true };
      }
      await page.keyboard.press('Escape');
    }
    selectedModel = null;
    return { strict: false, fallback: 'default-model' };
  }

  /** 网页新版的「深度思考」pill 是独立开关(aria-pressed),与模型 pill 并存:
   *  thinking 模型必须把它点亮(否则 thinking_enabled=false、无 THINK 流——
   *  2026-09-08 真机实测);非 thinking 模型必须关掉。任何形态缺失都只是
   *  跳过同步,绝不阻断已成功的模型选择。
   *  定位:输入框往上第 3 层祖先容器内取「深度思考」文本(与 diagnostics
   *  的 composer 分析同一 DOM 路径;全页 getByText 会撞上菜单/会话标题)。 */
  async function syncThinkPill(want) {
    try {
      const pill = await page.evaluateHandle(() => {
        const ta = [...document.querySelectorAll('textarea')].find(e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 0; });
        if (!ta) return null;
        let box = ta;
        for (let i = 0; i < 3 && box.parentElement; i++) box = box.parentElement;
        for (const el of box.querySelectorAll('button, [role="button"], [aria-pressed]')) {
          if ((el.textContent || '').trim() === '深度思考' && el.getAttribute('aria-pressed') !== null) return el;
        }
        return null;
      });
      if (!pill || !(await pill.asElement())) return null;
      const el = pill.asElement();
      const pressed = await el.getAttribute('aria-pressed');
      const enabled = pressed === 'true';
      if (enabled !== want) {
        await el.click({ timeout: 3000 });
        await page.waitForTimeout(400);
        let now = await el.getAttribute('aria-pressed');
        if (now !== (want ? 'true' : 'false')) {
          // 点击未翻转:真实坐标兜底(部分版本 pill 只吃真实鼠标事件)
          const box = await el.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(400);
          }
          now = await el.getAttribute('aria-pressed');
          if (now !== (want ? 'true' : 'false')) warn('深度思考 pill 点击后仍未翻转(当前:', now, '目标:', want, ')');
        }
      }
      return want;
    } catch (err) { warn('深度思考 pill 同步失败:', err?.message); return null; }
  }

  /** DeepSeek 网页 UI 代际侦测（其余站点返回 null）。
   *  classic：输入框上方有「快速模式/专家模式/识图模式」三 pill（≤0.7.2 的旧版）；
   *  unified：2026-09-10 新版统一 UI——没有模型 pill，模式差异只剩「深度思考」
   *  aria-pressed 开关（真机 probe-19/20 实测：POST 体 model_type 恒为 default，
   *  带图发送同样是 default + ref_file_ids，识图不再单独占一个 model_type）。
   *  判定缓存到 dsUi，页面重装（installPage）时失效。 */
  async function detectDeepSeekUi() {
    if (siteId !== 'deepseek' || !page || page.isClosed?.()) return null;
    if (dsUi) return dsUi;
    try {
      if (await page.getByText(/^(快速模式|专家模式|识图模式)$/).filter({ visible: true }).count() > 0) {
        dsUi = 'classic';
        return dsUi;
      }
      const hasThinkToggle = await page.evaluate(() => {
        const ta = [...document.querySelectorAll('textarea')].find(e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 0; });
        if (!ta) return false;
        let box = ta;
        for (let i = 0; i < 3 && box.parentElement; i++) box = box.parentElement;
        return [...box.querySelectorAll('[aria-pressed]')].some(el => (el.textContent || '').trim() === '深度思考');
      });
      if (hasThinkToggle) dsUi = 'unified';
    } catch { /* 页面转场中偶发取不到 DOM——保持未判定，下一轮再判 */ }
    return dsUi;
  }

  async function selectModelDeepSeek(model, { hasImages, label, thinkOverride = null }) {
    // 思考状态目标:手动覆盖优先,否则按模型 thinking 属性
    const wantThink = thinkOverride !== null ? thinkOverride : model.thinking === true;
    const ui = await detectDeepSeekUi();

    if (ui === 'unified') {
      // 新版统一 UI：模型 pill 已取消，模式差异 =「深度思考」开关。
      //   deepseek → 打开思考（model_type=default + thinking_enabled=true）
      //   flash    → 关闭思考（model_type=default + thinking_enabled=false）
      //   vision   → 没有独立入口：带图发送由网页自行路由（probe-20 实测
      //              model_type=default + ref_file_ids，回答确实读了图）。
      if (model.vision) {
        selectedModel = model.id;
        return { strict: false, ui, fallback: 'image-auto-route' };
      }
      const thinkState = await syncThinkPill(wantThink);
      if (thinkState === null) {
        // 连「深度思考」开关都定位不到：本轮 thinking 状态不可控，不再假装成功。
        selectedModel = null;
        const diag = await composerSnippet();
        const err = new Error('MODEL_UI_CHANGED: 新版网页未找到「深度思考」开关' + (diag ? ' — 输入框附近可点项：' + diag : ''));
        err.code = 'MODEL_UI_CHANGED';
        throw err;
      }
      selectedModel = model.id;
      return { strict: true, ui, wantThink };
    }

    // classic 三 pill（≤0.7.2 的旧版 UI）：找不到本模型 pill 时先点当前 pill 打开
    // 菜单，再选目标；再不行才走下面的通用弹层兜底。
    let mode = page.getByText(model.labels[0], { exact: true }).filter({ visible: true });
    if (!await mode.count()) {
      const current = page.getByText(/^(快速模式|专家模式|识图模式)$/).filter({ visible: true });
      if (await current.count()) await current.first().click();
    }
    mode = page.getByText(model.labels[0], { exact: true }).filter({ visible: true });
    if (await mode.count()) {
      await mode.last().click();
      await page.keyboard.press('Escape');
      selectedModel = model.id;
      await syncThinkPill(wantThink);
      return { strict: true, ui: 'classic', wantThink };
    }
    const native = page.locator('select[aria-label="模型"], select[aria-label="Model"]');
    if (await native.count()) {
      const option = native.first().locator(`option[value="${model.id}"]`);
      if (!await option.count()) {
        if (model.vision && hasImages) { selectedModel = model.id; return { strict: false, ui: 'classic', fallback: 'image-attachment' }; }
        throw new Error('MODEL_UNAVAILABLE: 当前账号没有目标模型 ' + model.id);
      }
      await native.first().selectOption(model.id);
      if (await native.first().inputValue() !== model.id) throw new Error('模型选择未生效');
      selectedModel = model.id;
      await syncThinkPill(wantThink);
      return { strict: true, ui: 'classic', wantThink };
    }
    const thinking = page.getByRole('button', { name: /^深度思考$|^DeepThink(?: \(R1\))?$/i });
    if (await thinking.count()) {
      if (model.vision && hasImages) { selectedModel = model.id; return { strict: false, ui: 'classic', fallback: 'image-attachment' }; }
      if (model.vision) throw new Error('MODEL_UNAVAILABLE: 当前网页没有独立 Vision 模型选择器');
      const control = thinking.first();
      const pressed = await control.getAttribute('aria-pressed');
      const state = await control.getAttribute('data-state');
      if (pressed !== null || state !== null) {
        const enabled = pressed === 'true' || state === 'on' || state === 'checked';
        if (enabled !== (model.id === 'deepseek')) await control.click();
        selectedModel = model.id;
        return { strict: true, ui: 'classic', wantThink };
      }
    }
    // 通用弹层入口：旧版 UI 的模型选择器可能藏在输入框工具条里。找不到就把
    // 输入框附近的可点元素如实报出来，让 MODEL_UI_CHANGED 自带诊断。
    const trigger = page.getByRole('button', { name: /^(Flash|Vision|DeepSeek|模型|Model|快速|极速|视觉)/i }).first();
    if (!await trigger.count()) {
      const diag = await composerSnippet();
      if (model.vision && hasImages) { selectedModel = model.id; return { strict: false, ui: 'classic', fallback: 'image-attachment' }; }
      const err = new Error('MODEL_UI_CHANGED: 未找到模型选择器' + (diag ? ' — 输入框附近可点项：' + diag : ''));
      err.code = 'MODEL_UI_CHANGED';
      throw err;
    }
    await trigger.click();
    const option = page.getByRole('option', { name: label }).or(page.getByRole('menuitem', { name: label }));
    if (!await option.count()) {
      if (model.vision && hasImages) { selectedModel = model.id; return { strict: false, ui: 'classic', fallback: 'image-attachment' }; }
      throw new Error('MODEL_UNAVAILABLE: 当前账号没有目标模型 ' + model.id);
    }
    await option.first().click();
    if (!await page.getByRole('button', { name: label }).count()) throw new Error('模型选择未确认');
    selectedModel = model.id;
    await syncThinkPill(wantThink);
    return { strict: true, ui: 'classic', wantThink };
  }

  /** 报错前抓一段输入框附近的按钮文本，让 MODEL_UI_CHANGED 不再是一句干报错。 */
  async function composerSnippet() {
    try {
      return await page.evaluate(() => {
        const ta = [...document.querySelectorAll('textarea')].find(e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 0; });
        if (!ta) return null;
        let box = ta;
        for (let i = 0; i < 3 && box.parentElement; i++) box = box.parentElement;
        const names = [];
        for (const el of box.querySelectorAll('button, [role="button"]')) {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const t = (el.textContent || '').trim().slice(0, 20);
          if (t) names.push(t + (el.getAttribute('aria-pressed') ? '[p' + el.getAttribute('aria-pressed') + ']' : ''));
        }
        return names.slice(0, 10).join('、');
      });
    } catch { return null; }
  }

  async function diagnostics() {
    if (!page) return { controls: [], urlPath: null, transport: 'playwright-edge', preview: false, siteId };
    // composer 分析:输入框附近(输入框向上 3 层祖先容器内)的全部可点元素,
    // 用于真机核对模型 pill/深度思考开关的真实形态。只读,不点击。
    const composer = await page.evaluate(() => {
      const ta = [...document.querySelectorAll('textarea')].find(e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 0; });
      if (!ta) return null;
      let box = ta;
      for (let i = 0; i < 3 && box.parentElement; i++) box = box.parentElement;
      const out = [];
      for (const el of box.querySelectorAll('button, [role="button"], [aria-pressed], [aria-label]')) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        out.push({
          text: (el.textContent || '').trim().slice(0, 30),
          ariaLabel: el.getAttribute('aria-label'),
          pressed: el.getAttribute('aria-pressed'),
          state: el.getAttribute('data-state'),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        });
      }
      return out.slice(0, 20);
    }).catch(() => null);
    return {
      urlPath: new URL(page.url()).pathname,
      ui: await detectDeepSeekUi(),
      selectedModel,
      requestMetadata,
      composer,
      transport: 'playwright-edge',
      preview: !page.isClosed?.(),
      siteId,
      conversationCount: conversations.size,
      controls: await page.locator('body *').evaluateAll(nodes => nodes.filter(n => (n.textContent || '').trim().length <= 12).map(n => ({ text: n.textContent.trim(), tag: n.tagName, pressed: n.getAttribute('aria-pressed'), state: n.getAttribute('data-state') })).filter(c => c.text).slice(0, 25)),
    };
  }

  async function resetConversation(key) { forgetConversation(key); }

  async function getToken() {
    await ensure();
    if (!page) throw new Error('driver page not ready');
    let origin = '';
    try { origin = new URL(page.url()).origin; } catch {}
    if (origin !== new URL(cfg.site).origin) {
      await page.goto(cfg.site, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    }
    const key = siteId === 'deepseek' ? 'userToken' : null;
    if (!key) return null;
    return page.evaluate((k) => {
      const raw = localStorage.getItem(k);
      try {
        const j = JSON.parse(raw || 'null');
        if (j && typeof j.value === 'string') return j.value;
      } catch { /* raw string form */ }
      return raw || null;
    }, key);
  }

  async function openLogin({ onState } = {}) {
    if (busy || transitioning) throw new Error('driver busy with a web turn — login refused');
    transitioning = true;
    try {
      try { if (ctx) await ctx.close(); } catch {}
      ctx = null; page = null;
      log('opening headed window for login');
      await launch({ headless: false });
      try { await page.goto(cfg.site, { waitUntil: 'domcontentloaded', timeout: 45_000 }); } catch {}
      onState?.('waiting-for-login');
      const t0 = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        if (Date.now() - t0 > cfg.loginTimeoutMs) throw new Error('login wait timed out');
        try {
          if (page.isClosed?.()) throw new Error('login window was closed before login completed');
          const u = new URL(page.url());
          if (/sign|login/i.test(u.pathname)) continue;
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
    } finally {
      transitioning = false;
    }
  }

  // ---- 展示窗口（真实有头 Edge 窗口）--------------------------------
  // openWindow: 把当前站点开成一个真实浏览器窗口（默认停靠屏幕右半），
  // 用户可直接在里面聊天/选模型/登录；自动化轮次照常驱动同一页面——
  // 「独立窗口」与「右栏预览」共享同一登录会话，这是 iframe 方案做不到的
  // （DeepSeek 等站点 CSP 拒绝 iframe，参考 webcode 也用独立窗口承载）。
  // 生成期间可用：busy 锁只挡写操作（登录/导入），窗口打开不与轮次互斥。
  async function openWindow({ width, height, url } = {}) {
    await ensure();
    throwIfTransitioning();
    const w = Math.max(360, Math.min(3840, Math.round(Number(width) || 0)) || 1000);
    const h = Math.max(480, Math.min(2160, Math.round(Number(height) || 0)) || 900);
    if (ctx && !headed) {
      // 无头上下文 → 有头窗口：持久 profile 只能开一个实例，必须先关再开。
      try { await ctx.close(); } catch {}
      ctx = null; page = null;
      await launch({ headless: false });
    } else if (!page || page.isClosed()) {
      await ensure();
    }
    headed = true;
    await page.setViewportSize({ width: w, height: h });
    // 停靠屏幕右半（Playwright 无直接 API，用 CDP setWindowBounds；屏幕几何
    // 只在 browser-target CDP session 上有——用 ctx.browser().newBrowserCDPSession）。
    try {
      const browserCtx = ctx.browser();
      const bcdp = await (browserCtx?.newCDPSession?.() ?? null);
      if (bcdp) {
        const screens = (await bcdp.send('SystemInfo.getInfo'))?.displayInfo || [];
        await bcdp.detach().catch(() => {});
        const screen = screens.find((d) => d.isPrimary) || screens[0];
        const bounds = screen?.bounds ? {
          left: Math.round(screen.bounds.left + (screen.bounds.width - w) / 2 + screen.bounds.width / 4),
          top: screen.bounds.top || 0,
          width: w,
          height: Math.min(h, (screen.bounds.height || h) - 40),
          windowState: 'normal',
        } : { left: 0, top: 0, width: w, height: h, windowState: 'normal' };
        const cdp = await ctx.newCDPSession(page);
        const { windowId } = await cdp.send('Browser.getWindowForTarget');
        await cdp.send('Browser.setWindowBounds', { windowId, bounds });
        await cdp.detach();
      }
    } catch (err) { warn('window dock failed (window stays at default position):', err?.message); }
    const target = url || cfg.site;
    try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {}); } catch { /* already there */ }
    try { loggedIn = await page.locator(SEL.input).count() > 0 || !/sign|login/i.test(new URL(page.url()).pathname); } catch { loggedIn = null; }
    log(`headed window open ${w}x${h} → ${target}`);
    return { ok: true, ...windowState() };
  }

  /** 关闭展示窗口，回到无头（自动化继续，屏幕上不留窗口）。 */
  async function closeWindow() {
    throwIfTransitioning();
    if (!headed) return { ok: true, ...windowState() };
    if (busy) {
      // 正在生成：不硬关（会杀掉进行中的轮次页面），只标记意图，轮次结束后由 ensure 收尾。
      warn('a web turn is running — window will go headless after it settles');
      await activeSettled();
    }
    try { if (ctx) await ctx.close(); } catch {}
    ctx = null; page = null;
    headed = false;
    await launch({ headless: true });
    await gotoFreshChat().catch(() => {});
    return { ok: true, ...windowState() };
  }

  async function activeSettled() {
    const a = active;
    if (!a) return;
    // 轮次一结束（成功/失败/中止/超时）就返回；120s 只是极端情况下的兜底。
    // 旧写法把定时器挂在 a.settleHook 上，但没有任何地方会在轮次结束时
    // 清除它——于是「生成期间关窗口」每次都白等满 120 秒。
    let t = null;
    try {
      await Promise.race([a.settled, new Promise((resolve) => { t = setTimeout(resolve, 120_000); })]);
    } finally { if (t) clearTimeout(t); }
  }

  function throwIfTransitioning() {
    if (busy || transitioning) {
      const err = new Error('driver busy with a web turn — window switch refused, retry after the turn settles');
      err.code = 'DRIVER_BUSY';
      throw err;
    }
  }

  function windowState() {
    return {
      open: headed && Boolean(page && !page.isClosed?.()),
      headed,
      url: page && !page.isClosed?.() ? safeUrl(page.url()) : null,
    };
  }

  async function importStorageFromProfile(sourceProfileDir) {
    if (busy || transitioning) throw new Error('driver busy with a web turn — session import refused');
    transitioning = true;
    try {
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
      const stale = finishActive();
      stale?.reject?.(abortError('session import interrupted the web turn'));
      if (ctx) { try { await ctx.close(); } catch {} ctx = null; page = null; busy = false; active = null; }
      await launch({ headless: true });
      const ready = await gotoFreshChat();
      log('session imported; loggedIn =', ready);
      return { loggedIn: ready };
    } finally {
      transitioning = false;
    }
  }

  async function close() {
    finishActive()?.reject?.(abortError());
    try { await ctx?.close(); } catch {}
    ctx = null; page = null; busy = false; active = null;
  }

  async function webApi(apiPath, { method = 'GET', body = null, timeoutMs = 20_000 } = {}) {
    if (typeof apiPath !== 'string' || !apiPath.startsWith('/') || apiPath.startsWith('//')) {
      throw new Error('webApi: site-relative path required');
    }
    await ensure();
    if (!page) throw new Error('driver page not ready');
    let origin = '';
    try { origin = new URL(page.url()).origin; } catch {}
    if (origin !== new URL(cfg.site).origin) {
      await page.goto(cfg.site, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    }
    return page.evaluate(async ({ apiPath, method, body, timeoutMs, tokenKey }) => {
      const raw = tokenKey ? localStorage.getItem(tokenKey) : '';
      let token = raw || '';
      try {
        const j = JSON.parse(raw || 'null');
        if (j && typeof j.value === 'string') token = j.value;
      } catch { /* raw string form */ }
      const headers = { accept: 'application/json' };
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
    }, { apiPath, method, body, timeoutMs, tokenKey: siteId === 'deepseek' ? 'userToken' : null });
  }

  async function listSessions(count = 100) {
    if (siteId !== 'deepseek') throw new Error('listSessions: 仅 DeepSeek 支持会话目录 API');
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

  async function fetchHistory(sessionId) {
    if (siteId !== 'deepseek') throw new Error('fetchHistory: 仅 DeepSeek 支持历史消息 API');
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

  async function syncViewport(width, height) {
    if (!page || page.isClosed?.()) return;
    const w = Math.round(Math.min(1600, Math.max(360, Number(width) || 0)));
    const h = Math.round(Math.min(2000, Math.max(480, Number(height) || 0)));
    const cur = page.viewportSize();
    if (!cur || Math.abs(cur.width - w) > 8 || Math.abs(cur.height - h) > 8) {
      await page.setViewportSize({ width: w, height: h }).catch(() => {});
    }
  }

  async function chatClipRect() {
    return page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 120; };
      const input = [...document.querySelectorAll('textarea')].find((e) => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 0; });
      if (!input) return null;
      const vw = window.innerWidth, vh = window.innerHeight;
      const ir = input.getBoundingClientRect();
      let best = null;
      for (let el = input; el && el !== document.body; el = el.parentElement) {
        const r = el.getBoundingClientRect();
        if (!vis(el)) continue;
        if (r.width >= vw * 0.96) break;
        if (!best || r.width > best.w) best = { x: r.x, w: r.width };
      }
      if (best && best.w >= vw * 0.5) {
        const x = Math.max(0, Math.round(best.x));
        return { x, y: 0, width: Math.min(vw - x, Math.round(best.w)), height: vh };
      }
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

  return { sendPrompt, sendTurn, resetConversation, conversationFor, connect, interact, openLogin, openWindow, closeWindow, importStorageFromProfile, status, close, diagnostics, getToken, get page() { return page; }, webApi, listSessions, fetchHistory, screenshotBase64 };
}

function abortError() {
  const err = new Error('webcode driver: aborted');
  err.name = 'AbortError';
  return err;
}
