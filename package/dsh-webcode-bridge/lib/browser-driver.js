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
import { getSite, getContract, resolveWebModel, conversationNav, conversationIdFromUrl } from './contract.js';
import { selectWebModel, pickerUsable } from './model-picker.js';
import { deriveLastRate, shouldSettleWip } from './metrics.js';
import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const decoderPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'decoder.js');
// SSE 原始帧抓包目录（WEBCODE_SSE_DEBUG=<dir> 时启用，仅用于新站点解码器取证）。
const SSE_DEBUG_DIR = process.env.WEBCODE_SSE_DEBUG || null;
function loadDecoderRegistry(explicitPath) {
  const p = explicitPath || decoderPath;
  const code = fs.readFileSync(p, 'utf8');
  new Function(code)();
  return globalThis.WebCodeStreamDecoders;
}

/** 捕获脚本：按站点 completionPaths 拦截 SSE（XHR drain + fetch tee）。
 *  自愈守护：站点埋点 SDK 会把 window.fetch **恢复成原生引用**（GLM 真机实锤：
 *  installed=true 而 fetch 包装出链，整条流静默丢失），单次包装挡不住。包装带
 *  __wcCap 特征标记，守护每 500ms 查一次，丢失立即重装——导航后脚本重跑，
 *  守护只存在于当前文档，不会累积。 */
function captureInit(paths) {
  const list = JSON.stringify(paths.length ? paths : ['/api/v0/chat/completion']);
  return `
(function () {
  if (window.__webcodeCaptureInstalled) { try { install(); } catch {} return; }
  window.__webcodeCaptureInstalled = true;
  const TARGETS = ${list};
  const hit = (u) => TARGETS.some((t) => String(u || '').includes(t));
  const emit = (id, phase, text) => { try { window.__webcodeChunk(id, phase, text || ''); } catch {} };
  function newId() { return 'cap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  function install() {
    // ---- fetch：不是我们的包装（或已是）都要保证最外层带 __wcCap 标记 ----
    if (!(window.fetch && window.fetch.__wcCap)) {
      const origFetch = window.fetch ? window.fetch.bind(window) : null;
      if (origFetch) {
        const wrapped = async function (input, init) {
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
        wrapped.__wcCap = true;
        window.fetch = wrapped;
      }
    }
    // ---- XHR：open/send 成对重装（标记挂在 send 上判断）----
    if (!(XMLHttpRequest.prototype.send && XMLHttpRequest.prototype.send.__wcCap)) {
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { this.__wcInfo = { method: String(method || '').toUpperCase(), url: String(url || '') }; } catch {}
        return origOpen.apply(this, arguments);
      };
      const wrappedSend = function () {
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
      wrappedSend.__wcCap = true;
      XMLHttpRequest.prototype.send = wrappedSend;
    }
  }
  install();
  setInterval(() => { try { install(); } catch {} }, 500);
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

/**
 * composer 形态判定（纯函数，便于护栏测试）：给定元素的标签与可编辑性，
 * 决定用「表单控件」还是「富文本编辑器」策略。
 *
 * 真机形状（2026-09-13）：
 *   field    — textarea（deepseek / glm / qwen / zai / grok / claude）
 *   editable — contenteditable（doubao 的 div.tiptap.ProseMirror、
 *              kimi 的 div.chat-input-editor、gemini 的 div.ql-editor）
 * 判错的代价：fill() 写不进去或 inputValue() 抛错 → 这两个站点要么发不出
 * 消息、要么被判成「提示词被截断」。因此这里只按元素事实分派，不看站点名。
 */
export function composerStrategy(info) {
  if (!info) return 'unknown';
  const tag = String(info.tag || '').toLowerCase();
  if (info.editable === true) return 'editable';
  if (tag === 'textarea' || tag === 'input') return 'field';
  // 其它标签（div 等）即便没声明 contenteditable 也按富文本处理：写进去才是
  // 目的，用 fill() 对 div 会直接抛错。
  return 'editable';
}

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

  // 宿主的图片限额（每消息张数 / 单图字节 / 允许的媒体类型）。由 index.js 在
  // 解析到 attachment 服务后注入；拿不到就退回保守默认。上传前用它拦下必然被
  // 网页拒绝的输入，而不是发出去再猜为什么「模型说没图」。
  let getImageLimits = typeof options.getImageLimits === 'function' ? options.getImageLimits : null;
  function attachmentsRef() {
    try { return getImageLimits ? getImageLimits() : null; } catch { return null; }
  }
  function setImageLimitsProvider(fn) { getImageLimits = typeof fn === 'function' ? fn : null; }

  let ctx = null;
  let page = null;
  let busy = false;
  let transitioning = false;
  let active = null;
  let lastFinished = null;
  // 登录流程的可观测状态：控制面 POST login 现在会等它结束并把结果带回去，
  // 设置页因此能显示「登录中… / 已登录 / 失败原因」，而不是永远显示「登录」。
  let loginState = 'idle';   // idle | launching | waiting-for-login | already-logged-in | ready | error
  let lastLogin = null;      // { ok, at, ms, error, message }
  // 「部分流」自愈次数：网页没送 FINISHED 但正文已经解出来的轮次。UI 用它区分
  // 「网页掉流但内容保住了」和「真的失败了」。
  let recoveredTurns = 0;
  let lastRecovered = null;  // { at, reason, status, chars }
  // 0.14.0（用户报「网页端回复了但 harness 这边卡住」）：
  // WIP 稳态收束的窗口——网页流以 status:'WIP' 结束且**永不发 FINISHED** 时，
  // 旧实现只有 240s 定时器能救，界面表现就是「无限思考中」。这里用「流停
  // **且** 页面 DOM 助手消息长度停止增长」双条件在秒级收束（判定收在
  // metrics.shouldSettleWip，有反向单测钉住安全线）。
  const WIP_IDLE_MS = Math.max(300, Number(cfg.wipIdleMs) || 2500);
  // 本轮收束原因，供 /status 与右栏显示：finished | partial-wip-settled |
  // partial-wip-settled(dom-unavailable) | timeout。null = 尚未跑过轮次。
  let lastEndReason = null;
  // 最近一次超时时的页面现场（captureAlive / replyChars）。旧实现只 warn 到
  // 宿主控制台，用户与后续会话都看不到——「网页没生成」和「捕获链死了」修法
  // 完全不同，这份现场必须能事后取到。
  let lastTimeoutScene = null;
  // 会话丢失（C-3）不再静默：WEB_SESSION_LOST 原先只在驱动内部抛码、由上层默默
  // 重放首轮，用户侧**完全不可见**——真机症状就是「同一个会话每轮都新开对话」，
  // 而面板上没有任何线索（glm 的 webcode-sessions-glm.json 恒为 "{}" 也是同一
  // 根因）。这里记次数与最近一次现场，让「会话槽反复丢失」变成一个可核对的数字。
  let sessionLostCount = 0;
  let lastSessionLost = null;  // { at, reason, siteId, hasStoredSession, chars }
  let wipWatch = null;       // { timer } 当前轮次的稳态巡检器
  // 注册表必须在驱动创建时就加载（0.12.2）：启动时的自动登录核验先于 ensure()
  // 直接 launch 出活页，首个轮次的 ensure() 见 ctx/page 存活便提前返回，注册表
  // 再无加载机会——onPageCapture 只剩「no decoder for kind」警告，整轮静默挂到
  // 超时（0.12.1 真机实锤：deepseek 轮 240s 无响应）。
  let Decoders = null;
  try { Decoders = loadDecoderRegistry(cfg.decoderPath); } catch (e) { warn('decoder registry preload failed:', e?.message); }
  let loggedIn = null;
  // 上一次登录判定**依据什么得出**（'probe-bad' | 'probe-ok' | 'input-fallback'
  // | 'unavailable'）。落盘时带上它，面板才能区分「按站点特征核验过」与
  // 「旧版本按输入框猜的」——0.12.9 之前所有站点的结论都是后者（qwen/gemini/
  // glm/zai/grok 全被记成已登录），若把它当权威，修好判定后面板仍会显示旧结论。
  let lastLoginBasis = null;
  // 重启前最后一次核验的登录态（持久化在各站点 profile）：进程内存里的 loggedIn
  // 重启即归零，没有这份缓存，面板每次重启都把所有站点打回「待检查」，
  // 用户只能逐站点手动核验（cookies 明明还在 profile 里）。
  const loginStatePath = () => path.join(cfg.profileDir, 'webcode-login-state.json');
  let cachedLogin = null;    // { loggedIn, at, message } | null
  try { cachedLogin = JSON.parse(fs.readFileSync(loginStatePath(), 'utf8')); } catch { /* first run */ }
  if (!cachedLogin || typeof cachedLogin !== 'object' || typeof cachedLogin.loggedIn !== 'boolean') cachedLogin = null;
  function persistLoginState(entry) {
    cachedLogin = entry;
    try {
      fs.mkdirSync(cfg.profileDir, { recursive: true });
      fs.writeFileSync(loginStatePath(), JSON.stringify(entry));
    } catch (e) { warn('login state save failed:', e?.message); }
  }
  /** 轮次/连接路径的高频持久化入口：值没变且 60s 内写过就不重复落盘。
   *  但**判定依据**变了必须重写：否则「输入框猜的 true」会挡住「特征核验的
   *  false」，面板永远显示修好之前的旧结论。 */
  function rememberLogin(v) {
    const val = v === true;
    const basis = lastLoginBasis;
    if (cachedLogin && cachedLogin.loggedIn === val && cachedLogin.basis === basis
      && Date.now() - (cachedLogin.at || 0) < 60_000) return;
    persistLoginState({
      loggedIn: val,
      at: Date.now(),
      basis: basis || 'unavailable',
      message: basis === 'probe-bad' ? '页面核验：命中未登录特征'
        : basis === 'probe-ok' ? '页面核验：命中登录特征'
          : basis === 'probe-fallback' ? '页面核验：站点特征未命中，回退输入框判定'
            : basis === 'input-fallback' ? '页面核验：回退输入框判定'
              : '页面核验：页面不可用',
    });
  }
  /**
   * 风控/验证页识别（纯判定，真机取证 2026-09-14）。
   *
   * 背景：GLM 在**直接深链** `…/main/alltoolsdetail?cid=<id>` 时会返回阿里云
   * 滑块验证页（title「滑动验证页面」，正文「访问验证…请按住滑块，拖动到最右边」），
   * 页面上有 3 个**隐藏** textarea（内容是 CF_APP_WAF / renderData / _waf_ 内联脚本）。
   * 旧判定只数 textarea 个数、不看可见性 → 被判成「已登录 + 输入框在」→ 继续
   * fill → 30s 超时。这是「第二轮必挂」的直接机制。
   *
   * 与登录态是两件事：验证页**不代表未登录**（cookie 可能完全有效），它代表
   * 「这个 URL 形状被风控拦了」。因此单独成一态，让调用方换一条路（见 sendTurn）。
   */
  async function detectChallenge(p) {
    try {
      return await p.evaluate(() => {
        const t = String(document.title || '');
        const body = String(document.body?.innerText || '');
        // 三种指纹任一命中即算：title、可见文案、WAF 脚本标识
        if (/滑动验证|访问验证|安全验证|验证页面/.test(t)) return 'waf-title';
        if (/访问验证|请按住滑块|拖动到最右边/.test(body)) return 'waf-body';
        if (/CF_APP_WAF|aliyun_waf|_waf_[0-9a-f]+/.test(document.documentElement?.innerHTML || '')) return 'waf-script';
        return null;
      });
    } catch { return null; }
  }

  /**
   * 页面上是否存在**可见且可编辑**的 composer（真机 2026-09-14 修正）。
   *
   * 旧实现是 `locator(SEL.input).count() > 0` —— 只数个数。风控页/未渲染完的页面上
   * 藏着若干个不可见 textarea（脚本模板），于是判定为「输入框在」，紧接着的 fill
   * 必然超时。这里改为逐元素检查可见性，语义与后面真正要做的动作一致。
   *
   * ⚠ 必须逐个 selector 试**全部**候选，不能只取 `SEL.input.split(',')[0]`：
   * GLM 的真实 composer 是裸 `<textarea>`（真机 probe-27：id=null、placeholder=null），
   * 只认第一个候选（`textarea#chat-input`）会漏掉它，把正常页面判成未登录。
   */
  async function visibleComposerCount(p) {
    try {
      return await p.evaluate((sel) => {
        const cands = sel.split(',').map((s) => s.trim()).filter(Boolean);
        const seen = new Set();
        let n = 0;
        for (const c of cands) {
          let nodes = [];
          try { nodes = [...document.querySelectorAll(c)]; } catch { continue; }
          for (const e of nodes) {
            if (seen.has(e)) continue;
            seen.add(e);
            if (e.offsetWidth || e.offsetHeight || e.getClientRects().length) n += 1;
          }
        }
        return n;
      }, SEL.input);
    } catch { return 0; }
  }

  /**
   * 统一的「这个页面算不算已登录」判定。旧实现只看 SEL.input 是否存在，而
   * z.ai 游客页自带完整输入框（真机实测 textarea + 发送按钮都在），未登录
   * 也被记成已登录。站点可在 providers.js 声明 loginProbe：
   *   bad — 命中即判未登录（如游客页可见的「登录」按钮）；
   *   ok  — 命中即判已登录（登录后才有的元素）；都没有时回退输入框判定。
   *
   * 0.14.3 修正：回退判定必须是**可见**的 composer。只数个数会把风控页里的隐藏
   * textarea 当成输入框（GLM 深链的真实症状）。
   */
  async function judgeLoggedIn(p) {
    if (!p || p.isClosed?.()) { lastLoginBasis = 'unavailable'; return false; }
    const probe = site.loginProbe;
    const declared = Boolean(probe?.bad || probe?.ok);
    if (probe?.bad) {
      try {
        const bad = p.locator(probe.bad).first();
        if (await bad.count() && await bad.isVisible().catch(() => false)) { lastLoginBasis = 'probe-bad'; return false; }
      } catch { /* bad 特征坏了不阻塞判定 */ }
    }
    if (probe?.ok) {
      try { if (await p.locator(probe.ok).first().count()) { lastLoginBasis = 'probe-ok'; return true; } } catch { /* 同上 */ }
    }
    // 声明了特征但都没命中（如站点改版、或页面根本没加载出来）：如实标成
    // probe-fallback，不要谎称「命中了登录特征」——那会让面板把一次猜测
    // 当成特征核验的结果。
    lastLoginBasis = declared ? 'probe-fallback' : 'input-fallback';
    return await visibleComposerCount(p) > 0;
  }
  /** 当前页面捕获链自检：binding + 捕获脚本必须真实存在于文档（见 installPage）。 */
  async function captureChainAlive(p) {
    if (!p || p.isClosed?.()) return false;
    return p.evaluate(() => typeof window.__webcodeChunk === 'function' && window.__webcodeCaptureInstalled === true).catch(() => false);
  }
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
    // 重启前那份落盘结论只有在**由本版本判定逻辑写出**时才可信。0.12.9 之前
    // 所有站点都是「有输入框=已登录」猜出来的，qwen/gemini/glm/zai/grok 全被记成
    // true（真机证据：state 文件里 message 逐字为「输入框在」），且文件里**没有
    // basis 字段**。因此「有 basis」= 新逻辑写的、「没 basis」= 旧版本的猜测。
    //
    // 注意不能只认 probe-*：deepseek 的设计就是输入框回退（游客落地页是 /sign_in、
    // 没有 textarea；已登录会话页有），它的 basis 恒为 input-fallback，若把它一并
    // 降级成「待检查」，反而让唯一可用的基线每次重启都要手动核验。
    const cachedTrusted = Boolean(cachedLogin && typeof cachedLogin.basis === 'string');
    const effectiveLoggedIn = loggedIn != null ? loggedIn : (cachedTrusted ? cachedLogin.loggedIn : null);
    return {
      running: Boolean(ctx),
      busy,
      loggedIn: effectiveLoggedIn,
      // loggedIn 为 null（本进程从未核验）时回退到重启前的持久值，面板据此
      // 显示「已登录(缓存)」而不是「待检查」；loggedInCached 标记数据来源。
      loggedInCached: loggedIn == null && cachedTrusted && cachedLogin.loggedIn === true,
      // 判定依据：'probe-bad'/'probe-ok' 是按站点特征核验；'input-fallback' 是
      // 回退判定；'stale' 表示落盘值来自旧版本、已不再作为结论。
      loginBasis: lastLoginBasis || (cachedTrusted ? cachedLogin.basis : (cachedLogin ? 'stale' : null)),
      loginCheckedAt: lastLogin?.at ?? cachedLogin?.at ?? null,
      needLogin: effectiveLoggedIn === false,
      selectedModel,
      siteId,
      profileDir: cfg.profileDir,
      loginState,
      lastLogin,
      recoveredTurns,
      lastRecovered,
      // 0.14.0：「网页已回复但桥卡住」的可观测面——本轮为什么收束（finished /
      // partial-wip-settled / timeout / dom-capture），以及超时那一刻的页面现场
      //（captureAlive + replyChars）。旧实现只把现场 warn 到宿主控制台。
      lastEndReason,
      lastTimeoutScene,
      // C-3：会话槽丢失的可核对数字（原先完全静默——用户只看到「每轮新开对话」）
      sessionLostCount,
      lastSessionLost,
      lastTurn,
      lastRate: deriveLastRate(lastFinished, selectedModel),
      conversations: Object.fromEntries(conversations),
      transport: 'playwright-edge',
      preview: Boolean(page && !page.isClosed?.()),
      window: windowState(),
    };
  }
  async function profileCookies(origin = siteUrl) {
    if (!ctx || typeof ctx.cookies !== 'function') return [];
    try { return await ctx.cookies(origin); } catch { return []; }
  }
  async function writeProfileCookies(setCookieHeaders, origin = siteUrl) {
    if (!ctx || typeof ctx.addCookies !== 'function') return;
    const url = String(origin).replace(/\/$/, '') + '/';
    const list = [];
    for (const raw of Array.isArray(setCookieHeaders) ? setCookieHeaders : []) {
      const first = String(raw).split(';', 1)[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      list.push({ name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim(), url });
    }
    if (list.length) await ctx.addCookies(list);
  }
  async function userAgent() {
    try { return page && !page.isClosed?.() ? await page.evaluate(() => navigator.userAgent) : null; } catch { return null; }
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
        // 空流宽限期内等到了新流：撤掉收场定时器，按正常路径绑定新解码器。
        if (active.retryGrace) { active.retryGrace = false; clearTimeout(active.graceTimer); active.graceTimer = null; }
        // 兜底：预加载失败（文件被占用/磁盘抖动）时在首个 SSE 帧前重试一次，
        // 而不是让整轮没有解码器地挂到超时。
        if (!Decoders) { try { Decoders = loadDecoderRegistry(cfg.decoderPath); } catch (e) { warn('decoder registry load failed:', e?.message); } }
        const Cls = Decoders?.[active.decoderKind] ?? Decoders?.deepseek;
        if (!Cls) { warn('no decoder for kind', active.decoderKind); return; }
        active.decoder = new Cls({
          onDelta: (t) => {
            if (active.firstResponseAt == null) active.firstResponseAt = performance.now();
            // WIP 稳态的「流还在动」证据：任何一帧增量都推迟收束判定。
            active.lastProgressAt = performance.now();
            active.text += t;
            try { active.onDelta?.(t); } catch {}
          },
          onThink: (t) => {
            if (active.firstThinkAt == null) active.firstThinkAt = performance.now();
            active.lastProgressAt = performance.now();
            active.thinking += t;
            try { active.onThink?.(t); } catch {}
          },
          onImage: (img) => {
            if (img) active.images.push(img);
            active.lastProgressAt = performance.now();
            try { active.onImage?.(img) } catch {}
          },
        });
      }
      return;
    }
    if (active.captureId && m.captureId !== active.captureId) return;
    // SSE 原始帧抓包（WEBCODE_SSE_DEBUG=<dir> 时启用）：新站点解码器对不上时，
    // 用真实流写解码器的第一手证据，而不是猜。
    if (SSE_DEBUG_DIR && m.phase === 'chunk' && m.text) {
      try {
        if (!active.debugFile) active.debugFile = path.join(SSE_DEBUG_DIR, `sse-${siteId}-${Date.now()}.log`);
        fs.appendFileSync(active.debugFile, m.text);
      } catch { /* debug only */ }
    }
    if (m.phase === 'chunk') {
      if (m.text) active.rawHead = ((active.rawHead || '') + m.text).slice(0, 400);
      if (active.decoder) active.decoder.push(m.text);
    }
    if (m.phase === 'end' && active.decoder) {
      const result = active.decoder.finish();
      // 把解码器认出来的会话 id 钉在结果与 active 上（C-1）：GLM/Z.ai 的身份在流
      // 里，而 finishActive() 之后 active 就没了，必须在此之前取出来。
      if (result && typeof result === 'object') {
        result.conversationId = active.decoder.conversationId || null;
      }
      active.decoderConversationId = active.decoder.conversationId || null;
      const emptyStream = !result?.complete && !result?.partial
        && !String(result?.text || '').trim() && !String(result?.thinking || '').trim()
        && !(Array.isArray(result?.images) && result.images.length);
      // 空流宽限重绑（no_response_frames 缓解）：DeepSeek 前端自动重试时，占位的
      // 空/错流会先到先收（end 触发 finish），真正的重试流随后才开、被
      // captureId 过滤丢弃——整轮报 no_response_frames，长任务反复被打死
      // （0.12.2 真机 goal 会话 turn2 step12 实锤）。空流不立即收场：留 3s
      // 窗口等新流绑定；等不到再按原样收场，代价上限 3s。
      // 限流（rate_limited）不进宽限：服务端已撤回消息、不会自动重发，白等 3s。
      if (emptyStream && result.reason !== 'rate_limited' && !active.retryGrace) {
        active.retryGrace = true;
        active.decoder = null;
        active.captureId = null;
        active.graceTimer = setTimeout(() => {
          if (!active) return;
          const resolve = active.resolve;
          finishActive();
          resolve(result);
        }, 3000);
        return;
      }
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
    if (a?.graceTimer) clearTimeout(a.graceTimer);
    // 稳态巡检器必须随之停掉：它对 active 做 DOM 采样并可能 resolve 本轮，
    // 留着会在下一轮误判（甚至提前收束别人的轮次）。
    if (a?.wipTimer) clearTimeout(a.wipTimer);
    if (a) { try { a.settleResolve?.(); } catch {} }
    return a;
  }

  /**
   * WIP 稳态收束巡检器（0.14.0）——「网页端回复了但 harness 这边卡住」的主修。
   *
   * 背景（真机 2026-09-13 取证）：DeepSeek 网页流可能以 `status:'WIP'` 结束且
   * **永不发 FINISHED**。解码器于是给 `{complete:false, partial:true}`，而
   * `done` promise 只有 `phase==='end'`（此时已经过去了）或 240s 定时器能
   * settle——一轮早就写完的回复于是把 sendTurn → relay → 适配器的
   * `await ch.next()` 全部挂住，界面表现是**无限「思考中」**。
   * 现场证据：recoveredTurns=1、lastRecovered.reason='stream_ended_before_finished'、
   * status='WIP'、chars=463。
   *
   * 判据是双条件（见 metrics.shouldSettleWip）：**流停** 且 **页面 DOM 助手
   * 消息长度停止增长**。任何一条还在动就绝不收束——思考阶段本就可能十几秒不吐
   * 正文，只看流停会把正常长回复判死（反向单测钉住这条安全线）。
   *
   * 收尾方式刻意与既有 partial 路径同形（把已有内容当本轮结果交出去），因此
   * 上层的工具协议解析、部分流自愈、空回复判定全部照旧，不新增第二条收尾通路。
   */
  function startWipWatch() {
    if (!active || active.decoderKind === 'dom') return;   // dom 站点本就不靠流收场
    const tick = async () => {
      const a = active;
      if (!a) return;
      let domLen = null;
      try {
        domLen = await page?.evaluate?.(() => {
          const last = [...document.querySelectorAll('.markdown, [data-message-author-role="assistant"], .ds-markdown')].pop();
          return last ? (last.innerText || '').length : 0;
        });
      } catch { domLen = null; }
      if (active !== a) return;                              // 轮次已结束或被替换
      if (typeof domLen === 'number') {
        a.domAvailable = true;
        if (a.lastDomLen == null || domLen > a.lastDomLen) a.lastDomGrowthAt = performance.now();
        a.lastDomLen = domLen;
      } else {
        // 页面取不到（关窗/导航中）：退回「仅流停」判定，并如实标注收束原因。
        a.domAvailable = false;
      }
      const bodyReady = Boolean(a.text) || Boolean(a.thinking) || (Array.isArray(a.images) && a.images.length > 0);
      if (!bodyReady || !shouldSettleWip({
        now: performance.now(),
        lastProgressAt: a.lastProgressAt,
        lastDomGrowthAt: a.lastDomGrowthAt,
        domAvailable: a.domAvailable,
        wipIdleMs: WIP_IDLE_MS,
      })) { a.wipTimer = setTimeout(tick, WIP_IDLE_MS); return; }
      // 已达稳态：网页这一轮事实上结束了，只是没送 FINISHED。按已有正文收束。
      const reason = a.domAvailable ? 'partial-wip-settled' : 'partial-wip-settled(dom-unavailable)';
      warn(`wip steady state — settling turn with ${String(a.text || '').length} chars (${reason})`);
      const result = a.decoder ? a.decoder.finish() : null;
      if (!result) {
        // 捕获链从未建立：没有可信正文，交给既有超时路径报错（不伪造结果）。
        a.wipTimer = setTimeout(tick, WIP_IDLE_MS);
        return;
      }
      const patched = result.complete ? result
        : { ...result, complete: false, partial: true, reason: result.reason || reason };
      a.settled_by = reason;
      lastEndReason = reason;
      const resolve = a.resolve;
      finishActive();
      resolve(patched);
    };
    if (active) active.wipTimer = setTimeout(tick, WIP_IDLE_MS);
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

  /** 持久 profile 的 Chromium 单实例锁文件。浏览器被强杀 / 上次启动中途失败时
   *  这些文件会留下来，下一次 launchPersistentContext 直接抛
   *  「ProcessSingleton」类错误——表现为「退出过一次之后不管哪里都无法登录」。
   *  只有在本次进程确认没有活着的 ctx 时才清理（有 ctx 说明锁是真被持有的）。 */
  const SINGLETON_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
  function clearStaleProfileLocks() {
    if (ctx) return [];
    const removed = [];
    for (const name of SINGLETON_FILES) {
      const p = path.join(cfg.profileDir, name);
      try {
        if (!fs.existsSync(p)) continue;
        fs.rmSync(p, { force: true });
        removed.push(name);
      } catch (err) {
        warn('stale lock remove failed', name, err?.message);
        // Windows：EPERM = 锁被一个**活着的** Edge 进程持有（用户直接关掉窗口
        // 而 Edge 按配置留在后台、或上次会话崩溃残留）。只清文件救不回来——
        // 按命令行里的 profileDir 精确匹配杀掉这些孤儿进程再清一次。
        if (err?.code === 'EPERM') killOrphanEdgeForProfile();
      }
    }
    if (removed.length) warn('cleared stale profile locks:', removed.join(', '));
    return removed;
  }

  /** 杀掉命令行里含本 profileDir 的孤儿 Edge 进程（只杀 ours，不碰用户自己的 Edge）。
   *  必须走 WMI Terminate：Stop-Process/taskkill 对 Chromium 子进程的受限 DACL
   *  会拒绝访问（真机 2026-09-12 实测），WMI 的 Terminate 能正常终结。 */
  function killOrphanEdgeForProfile() {
    if (process.platform !== 'win32') return;
    try {
      // 统一成全反斜杠再匹配：调用方传混合分隔符（C:\Users\x/.dsh/…）时
      // -like 永远匹配不上（真机踩过）。
      const dir = String(cfg.profileDir).replace(/\//g, '\\').replace(/'/g, "''");
      const script =
        `$procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
        `Where-Object { $_.CommandLine -like '*${dir}*' }; ` +
        `foreach ($p in $procs) { Invoke-CimMethod -InputObject $p -MethodName Terminate | Out-Null; Write-Output $p.ProcessId }`;
      const out = child_process.execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 30_000, encoding: 'utf8' });
      const pids = out.split(/\s+/).filter(Boolean);
      if (pids.length) warn(`killed orphan Edge for profile via WMI (pids: ${pids.join(', ')})`);
      setTimeout(() => clearStaleProfileLocks(), 500);
    } catch (err) { warn('orphan edge kill failed:', err?.message); }
  }

  /** 经 CDP 优雅回收孤儿 Edge：launch 时带 --remote-debugging-port=0，profile 里的
   *  DevToolsActivePort 记录了调试端口；孤儿进程还在监听时 connectOverCDP 后
   *  browser.close() 即可让它正常退出、释放单实例锁（强杀受 Playwright 的受限
   *  DACL 保护会拒绝访问，这条路才是可靠的）。 */
  async function releaseOrphanByCDP() {
    const portFile = path.join(cfg.profileDir, 'DevToolsActivePort');
    try {
      if (!fs.existsSync(portFile)) return false;
      const port = String(fs.readFileSync(portFile, 'utf8').split('\n')[0] || '').trim();
      if (!/^\d+$/.test(port)) return false;
      const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 5000 });
      await browser.close();
      await new Promise((r) => setTimeout(r, 800));
      log('orphan Edge released via CDP (port ' + port + ')');
      return true;
    } catch (err) { warn('cdp orphan release failed:', err?.message); return false; }
  }

  async function launch({ headless } = {}) {
    if (!cfg.executablePath) throw new Error('system Edge not found — install Edge or set executablePath');
    fs.mkdirSync(cfg.profileDir, { recursive: true });
    clearStaleProfileLocks();
    const launchOnce = () => chromium.launchPersistentContext(cfg.profileDir, {
      executablePath: cfg.executablePath,
      headless: headless ?? cfg.headless,
      args: [
      '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled',
      // 记录调试端口到 profile 的 DevToolsActivePort：本进程意外退出后，下一次
      // 启动可以经 CDP 优雅关掉孤儿浏览器、释放单实例锁（不需要管理员权限）。
      '--remote-debugging-port=0',
      // Edge 在上次进程被强杀后启动时会自动恢复旧标签页；这些恢复页没有捕获
      // 绑定，被当成 driver 页后整条流捕获都是死的（2026-09-12 DeepSeek 240s
      // 超时的根因）。抑制恢复气泡，下面再把恢复页一律关掉。
      '--hide-crash-restore-bubble',
    ],
      viewport: { width: 640, height: 900 },
      ...(cfg.storageState ? { storageState: cfg.storageState } : {}),
    });
    try {
      ctx = await launchOnce();
    } catch (err) {
      // 锁被孤儿进程占着时的典型报错——用户手动关窗后 Edge 留在后台持锁、
      // 或上次会话崩溃/进程被强杀残留。先经 CDP 优雅回收（能杀干净且不留
      // 半死状态），再退回强杀孤儿，最后清锁重试一次。
      const msg = String(err?.message || err);
      if (!/has been closed|ProcessSingleton|SingletonLock|Target closed|singleton|exitCode=21/i.test(msg)) throw err;
      warn('launch failed with stale profile lock — attempting self-heal:', msg.slice(0, 160));
      ctx = null; page = null;
      await releaseOrphanByCDP();
      killOrphanEdgeForProfile();
      await new Promise((r) => setTimeout(r, 1200));
      clearStaleProfileLocks();
      ctx = await launchOnce();
    }
    // 绝不复用 ctx.pages() 里的现成页（Edge 会话恢复页 / about:blank 残页）：
    // 恢复页的文档已经加载完，capture binding 与 init script 都不在上面，
    // 「发得出去收不回」。永远开干净新页，现成页一律关掉。
    const stalePages = ctx.pages();
    page = await ctx.newPage();
    for (const stale of stalePages) { try { await stale.close(); } catch {} }
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
      try {
        page = await ctx.newPage();
        if ((await installPage()) === false) throw new Error('capture self-check failed');
      } catch { ctx = null; page = null; }
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
    // 注入自检：binding 与捕获脚本必须在**当前文档**真实存在。exposeBinding
    // 被静默吞错、init 脚本注入竞争时，页面照样能用但整条捕获是死的——
    // 发出去收不回，只能白等 240s 超时（2026-09-12 DeepSeek 断流事故）。
    if (!(await captureChainAlive(p))) {
      await p.exposeBinding('__webcodeChunk', (source, captureId, phase, text) => {
        onPageCapture({ captureId, phase, text });
      }).catch(() => {});
      try { await p.evaluate(init); } catch {}
      if (!(await captureChainAlive(p))) {
        warn('capture chain self-check FAILED — stream capture is dead on this page; reopening next turn');
        return false;
      }
    }
    return true;
  }

  async function connect() {
    await ensure();
    // 统一走 judgeLoggedIn：旧实现这里只看「有没有输入框」，而多数站点的游客页
    // 自带完整输入框（qwen 的 message-input-textarea、gemini 的 ql-editor、
    // doubao 的 tiptap、z.ai 的 #chat-input），于是「未登录」被记成「已登录」，
    // 设置页与右栏徽标据此显示错误结论（真机证据 2026-09-13）。
    // 站点可在 providers.js 声明 loginProbe.bad（未登录特征）来纠正。
    if (!busy && new URL(page.url()).origin !== new URL(cfg.site).origin) loggedIn = await gotoFreshChat();
    else loggedIn = await judgeLoggedIn(page);
    rememberLogin(loggedIn);
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
    // 输入框在≠已登录（z.ai 游客页有完整输入框），统一走登录判定。
    await page.waitForSelector(SEL.input, { timeout: 20_000 }).catch(() => {});
    const ok = await judgeLoggedIn(page);
    rememberLogin(ok);
    return ok;
  }

  /** 输入框是富文本编辑器（contenteditable）还是表单控件？
   *  doubao=div.tiptap.ProseMirror、kimi=div.chat-input-editor、gemini=div.ql-editor
   *  都是前者；deepseek/glm/qwen/zai/grok/claude 的 textarea 是后者。
   *  分派规则见 composerStrategy（纯函数，有护栏测试）。 */
  async function composerKind(locator) {
    const info = await locator.evaluate((el) => ({
      tag: (el.tagName || '').toLowerCase(),
      editable: el.isContentEditable === true || el.getAttribute('contenteditable') === 'true',
    })).catch(() => null);
    return composerStrategy(info);
  }

  /** 把文本写进 composer——按真实元素形态分派（见 composerKind 的说明）。 */
  async function fillComposer(locator, message) {
    const kind = await composerKind(locator);
    if (kind === 'field') { await locator.fill(message); return kind; }
    // contenteditable：fill() 在部分富文本编辑器上不触发框架的 input 事件
    // （tiptap/ProseMirror 靠 beforeinput/input 维护内部文档），因此先聚焦、
    // 清空既有内容，再用键盘级插入——这是与真人输入最接近的路径。
    await locator.click({ timeout: 10_000 }).catch(() => {});
    await locator.focus().catch(() => {});
    try { await page.keyboard.press('Control+A'); await page.keyboard.press('Delete'); } catch { /* 空框 */ }
    await page.keyboard.insertText(String(message));
    return kind;
  }

  /** 回读 composer 里的文本，用于「网页端有没有截断」校验。
   *  表单控件读 value；contenteditable 读 innerText（textarea 的 inputValue()
   *  对富文本编辑器必抛错，旧实现因此把 doubao/kimi 判成截断）。 */
  async function readComposer(locator) {
    const kind = await composerKind(locator);
    if (kind === 'field') return await locator.inputValue().catch(() => null);
    return await locator.evaluate((el) => el.innerText || el.textContent || '').catch(() => null);
  }

  /** 上传后的**可见证据**选择器：附件真进了网页才会出现这些节点。
   *
   * 站点没声明时退回一组通用探针（blob 缩略图 / attachment|file-card|upload
   * 类名 / 输入框附近的 <img>）。探针命中即算确认——它不需要精确，只需要
   * 「网页里确实多了一个附件类节点」这个事实。 */
  const ATTACH_PREVIEW_FALLBACK = [
    "img[src^='blob:']",
    "[class*='attachment']",
    "[class*='Attachment']",
    "[class*='file-card']",
    "[class*='fileCard']",
    "[class*='upload-item']",
    "[class*='uploadItem']",
    "[data-testid*='attachment']",
    "[data-testid*='file']",
  ];

  /** 轮询等待附件在页面上出现。返回命中的选择器，或 null（超时）。 */
  async function waitForAttachment(timeoutMs = 15_000) {
    const declared = contract.attachPreviewSelector;
    const candidates = declared ? [declared, ...ATTACH_PREVIEW_FALLBACK] : ATTACH_PREVIEW_FALLBACK;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const sel of candidates) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.count() && await loc.isVisible().catch(() => false)) return sel;
        } catch { /* 选择器语法或页面转场：试下一个 */ }
      }
      if (Date.now() >= deadline) return null;
      await page.waitForTimeout(250);
    }
  }

  async function uploadImages(files, { timeoutMs = 15_000 } = {}) {
    const fi = page.locator(contract.attachSelector || "input[type='file']").first();
    if (!await fi.count()) {
      const err = new Error('ATTACH_UNAVAILABLE: 页面没有可用的文件上传入口');
      err.code = 'ATTACH_UNAVAILABLE';
      throw err;
    }
    // 附件数上限：宿主的 attachment 服务知道真实限额（imageLimits
    // .maxImagesPerMessage），拿不到才退回 6。
    const maxImages = Number(attachmentsRef()?.imageLimits?.maxImagesPerMessage) || 6;
    const payloads = files.slice(0, maxImages).map((f) => ({
      name: String(f.name || 'image.png').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'image.png',
      mimeType: String(f.contentType || 'image/png'),
      buffer: Buffer.from(String(f.data || ''), 'base64'),
    }));
    await fi.setInputFiles(payloads);
    // 关键修复：不再「固定等 500ms 就当传好了」。setInputFiles 只是把文件塞进
    // 隐藏 input，网页的上传/预览是异步的——旧写法在慢站点上会在附件尚未落地
    // 时按 Enter 发送，网页端收到的就是一条**没有附件**的消息，模型于是说
    //「我没有看到图片」。现在必须看到可见的附件证据才放行；看不到就明确报错，
    // 绝不发一条注定「没有图」的消息。
    const hit = await waitForAttachment(timeoutMs);
    if (!hit) {
      const diag = await composerSnippet();
      const err = new Error('ATTACH_NOT_CONFIRMED: 已选择 ' + payloads.length
        + ' 个文件，但 ' + Math.round(timeoutMs / 1000) + 's 内页面上没有出现附件'
        + (diag ? ' — 输入框附近可点项：' + diag : '')
        + '（网页可能拒绝了该格式/大小，或上传入口与预览节点都已改版）');
      err.code = 'ATTACH_NOT_CONFIRMED';
      throw err;
    }
    return { attached: payloads.length, evidence: hit };
  }

  async function runTurn(message, { navigate, signal, onDelta, onThink, onImage, model, images, thinkMode } = {}) {
    if (busy || transitioning) throw new Error('driver busy');
    busy = true;
    let timer = null;
    let stopClick = null;
    let attachEvidence = null;   // 本轮图片上传的确认结果 { attached, evidence }
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
      // 发送前的最后一道捕获自检：binding 缺失的页面「发得出去收不回」，只能
      // 白等超时。发现死捕获就换干净页再来（登录态在 profile，不受影响）。
      if (!(await captureChainAlive(page))) {
        warn('capture chain missing before turn — reopening a clean page');
        try { await page.close(); } catch {}
        page = null;
        await ensure();
      }
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
        let challenge = null;
        try {
          const target = String(navigate);
          // 「已在目标会话上」判定要用 **cid/会话 id**，不能用 URL 字符串前缀。
          // 真机 2026-09-14：站点自己会把地址补成 `?lang=zh&cid=X`（首轮落点就是
          // 这个），而桥拼的目标是 `?cid=X`——startsWith 判为「不同」，于是**白白
          // 整页重载一次**，而重载正好会撞上风控验证页。idsMatch 用站点声明的解析
          // 器比会话 id，语义正确且不会因参数顺序/多余参数误判。
          const wantId = conversationIdFromUrl(siteId, target);
          const haveId = conversationIdFromUrl(siteId, page.url());
          const alreadyThere = Boolean(wantId && haveId && wantId === haveId)
            || page.url().startsWith(target);
          if (!alreadyThere) {
            await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          }
          await page.waitForSelector(SEL.input, { timeout: 20_000 }).catch(() => {});
          // 风控/验证页要在判定登录态**之前**识别：那种页面上的 textarea 全是隐藏的
          // 脚本模板，judgeLoggedIn 会把它们当成「输入框在 = 已登录」，随后 fill
          // 必然超时（这正是 GLM 深链第二轮的失败形态）。
          challenge = await detectChallenge(page);
          ready = !challenge && await judgeLoggedIn(page);
        } catch { ready = false; }
        throwIfAborted();
        if (!ready) {
          // 会话在网页端已被删除或过期。旧实现在这里静默改开新会话、把这轮的
          // 增量照发——新会话既没有首轮预设也没有任何历史，模型带着半截上下文
          // 裸奔（长时间运行的会话删/过期后最常见的一类「越跑越傻」）。
          // 现在抛码给上层：游标作废、下一轮整段重建。
          //
          // 风控页是**另一回事**：它不是「会话没了」，而是「这条深链被拦了」。
          // 两者都导致无法续聊，恢复动作也一样（丢掉会话槽 + 整段重建），
          // 但原因必须如实分开——否则用户按「会话过期」去查，永远查不到风控。
          const inputReady = await gotoFreshChat();
          if (!inputReady) {
            loggedIn = false;
            const err = new Error(`NEED_LOGIN:${site.name} 会话缺失 — 打开 Web AI 面板登录一次`);
            err.code = 'NEED_LOGIN';
            throw err;
          }
          const reason = challenge
            ? `导航回既有会话时被风控验证页拦截（${challenge}）`
            : '网页会话已不可达（已删除或过期）';
          const err = new Error(`WEB_SESSION_LOST: ${reason} — 需要整段重建`);
          err.code = 'WEB_SESSION_LOST';
          err.navReason = challenge ? 'challenge-page' : 'conversation-gone';
          err.challenge = challenge;
          throw err;
        }
      }

      loggedIn = true;
      // thinkMode: 'auto'(按模型默认) | 'on'(强制开) | 'off'(强制关)——设置页手动覆盖。
      // DeepSeek 的「深度思考」pill 是独立开关,auto 时按模型 thinking 属性双向同步。
      const thinkOverride = thinkMode === 'on' ? true : thinkMode === 'off' ? false : null;
      const selection = model ? await selectModel(model, { hasImages: Array.isArray(images) && images.length > 0, thinkOverride }) : null;
      // 模型切换未能确认时如实告知，而不是让用户以为选中的模型生效了。
      // 0.12.9 的 selectModelGeneric 在切换失败时静默返回 default-model，
      // 调用方当成功继续 —— 于是「模型选择」在多数站点上是空操作，
      // 用户在网页端看到的是另一个模型，却没有任何提示。
      if (selection && selection.strict === false && selection.note) {
        warn('model selection not confirmed:', selection.fallback, '—', selection.note);
        onThink?.('⚠ ' + selection.note);
      }
      if (selection && selection.fallback === 'unverified') {
        // 站点没有选择契约（未真机校准）：必须让用户知道本轮用的是网页当前模型
        onThink?.('⚠ 本轮未切换网页模型（该站点尚未真机校准），将按页面当前模型对话');
      }
      // 上传确认结果也要可见：附件没落地时报错已经很响，但成功时给一条
      // 可核对的痕迹（张数 + 命中的证据选择器）便于真机排查。
      if (attachEvidence) onThink?.(`已附加 ${attachEvidence.attached} 张图片（页面证据：${attachEvidence.evidence}）`);
      if (contract.searchTogglePattern) {
        const search = page.locator('[aria-pressed]').filter({ hasText: contract.searchTogglePattern });
        if (await search.count() && await search.first().getAttribute('aria-pressed') === 'true') await search.first().click();
      }
      throwIfAborted();
      if (Array.isArray(images) && images.length) {
        // 上传后**确认**附件真的进了网页才继续（见 uploadImages 的注释）：
        // 拿不到可见证据就抛 ATTACH_NOT_CONFIRMED，绝不发一条注定「没有图」的消息。
        attachEvidence = await uploadImages(images);
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
          // WIP 稳态判定用的两个时刻（见 metrics.shouldSettleWip）：
          // lastProgressAt  = 最后一次收到 delta/think/image
          // lastDomGrowthAt = 最后一次观察到页面助手消息**变长**
          // 二者是「可以收束」的双条件；只满足一条绝不收束（不截断长回复）。
          lastProgressAt: performance.now(),
          lastDomGrowthAt: performance.now(),
          domAvailable: true,
          wipTimer: null,
          settled_by: null,
        };
      });
      timer = setTimeout(async () => {
        const a = finishActive();
        // 超时必须带页面现场：「网页没生成」和「捕获链死了」修法完全不同，
        // 黑盒超时只能瞎猜（2026-09-12 断流事故：页面早有全文、捕获从未建立）。
        const scene = await page?.evaluate?.(() => {
          const last = [...document.querySelectorAll('.markdown, [data-message-author-role="assistant"], .ds-markdown')].pop();
          return {
            captureAlive: typeof window.__webcodeChunk === 'function' && window.__webcodeCaptureInstalled === true,
            replyChars: last ? (last.innerText || '').length : 0,
          };
        }).catch(() => null);
        const detail = !scene ? '页面不可用'
          : (scene.captureAlive ? '捕获链在' : '捕获链缺失')
            + (scene.replyChars ? `，页面已有 ${scene.replyChars} 字回复未回传` : '，页面无回复文本');
        warn('turn timeout scene:', JSON.stringify(scene));
        // 现场同时落进 status：只 warn 到控制台的话，用户与事后排查都取不到，
        // 而这正是「页面早有全文、捕获从未建立」这类事故的唯一直接证据。
        lastTimeoutScene = scene ? { ...scene, at: Date.now() } : { at: Date.now(), page: 'unavailable' };
        lastEndReason = 'timeout';
        const err = new Error(`web turn timed out after ${cfg.requestTimeoutMs}ms（${detail}）`);
        if (a) a.reject(err); else warn(err.message);
      }, cfg.requestTimeoutMs);
      if (active) active.timer = timer;

      done.catch(() => {});
      if (String(message).length > 400_000) {
        warn(`large prompt:${String(message).length} chars — the web composer may become slow; consider trimming context`);
      }
      const input = page.locator(SEL.input).first();
      // 2026-09-13：doubao（tiptap/ProseMirror）与 kimi（div.chat-input-editor）
      // 的输入框是 contenteditable，**不是**表单控件。Playwright 的 fill() 只认
      // input/textarea/[contenteditable]（后者要走 locator.fill 的 contenteditable
      // 分支）；而 inputValue() 对富文本编辑器永远抛错 → 旧实现里这两个站点要么
      // 写不进去、要么回读校验直接失败。按真实元素形态分派输入与回读。
      await fillComposer(input, message);
      // 网页输入框有长度上限，超限会被静默截断——模型只看到半截提示词却照常
      // 作答，长跑里表现为「越到后面越答非所问」。回读一次，长度对不上就拒绝
      // 发送，让上层压缩后重试（此时还没按 Enter，网页端没有被污染）。
      const echoed = await readComposer(input);
      if (typeof echoed === 'string' && echoed.length < String(message).length - 8) {
        const err = new Error(`PROMPT_TRUNCATED: 网页输入框只接收了 ${echoed.length}/${String(message).length} 字符（网页端长度上限）— 请缩短上下文或先压缩历史再重试`);
        err.code = 'PROMPT_TRUNCATED';
        throw err;
      }
      throwIfAborted();
      if (active) active.t0 = performance.now();
      // 发送方式按站点契约：定义了 sendButton 的站点（如 z.ai 的
      // #send-message-button）点按钮提交——这些站点对程序化 Enter 不响应
      // （真机 2026-09-12：z.ai 轮次静默挂死正因 Enter 不触发发送）；
      // 其余站点维持 Enter。按钮点击失败回落 Enter，不发半截消息。
      if (SEL.sendButton) {
        const btn = page.locator(SEL.sendButton).first();
        try {
          if (await btn.count()) {
            const btnBefore = await btn.isEnabled().catch(() => true);
            if (btnBefore) await btn.click({ timeout: 5000 }).catch(async () => { await input.press('Enter'); });
            else await input.press('Enter');
          } else await input.press('Enter');
        } catch { await input.press('Enter').catch(() => {}); }
      } else {
        await input.press('Enter');
      }
      // 发送已发出：启动 WIP 稳态巡检器（网页不发 FINISHED 时的秒级收束）。
      startWipWatch();

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
      if (!result.complete && !result.partial) {
        // 限流单列：hint 带着服务端原话（「消息发送过于频繁」），按专门错误码
        // 抛出，让上层退避后重试，而不是和无从下手的不完整流混在一起。
        if (result.reason === 'rate_limited') {
          const err = new Error(`RATE_LIMITED: ${site.name} 网页端限流（${result.hint || '消息发送过于频繁，请稍后重试'}）— 将退避后重试`);
          err.code = 'RATE_LIMITED';
          throw err;
        }
        // 带上流首段原文：整流零响应帧时，「网页 200 包错误 JSON（风控/审核）」
        // 和「流形态对不上」在报错文本里一眼可分，不用再开 SSE_DEBUG 抓包。
        const head = lastFinished?.rawHead ? ' | 流首段: ' + String(lastFinished.rawHead).slice(0, 200) : '';
        throw new Error('web capture ended incomplete: ' + (result.reason || 'unknown') + head);
      }
      if (!result.text?.trim()) throw new Error('empty response from web AI');
      if (!result.complete) {
        // 部分流：正文/思考/图片已拿到，但网页没发 FINISHED/close。把已有内容当
        // 本轮结果交出去（上层会解析工具协议、执行、回填），下一轮再让模型续写。
        // 旧实现直接抛错——模型已输出的正文与完整工具调用被整段丢弃，界面上就是
        // 「跑到一半突然停止」，且工具循环再也不会继续。
        recoveredTurns += 1;
        lastRecovered = { at: Date.now(), reason: result.reason || 'unknown', status: result.status || null, chars: String(result.text || '').length };
        warn(`partial web stream accepted (${result.reason}, status=${result.status || 'n/a'}, `
          + `${String(result.text || '').length} chars, ${(result.images || []).length} image(s)) — `
          + 'content preserved; the next turn will continue from here');
      }
      lastTurn = { sessionId: turnSessionId(page.url()), url: safeUrl(page.url()), at: Date.now() };
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
      // 本轮收束原因：稳态巡检器收束时已写好 settled_by；否则就是正常 FINISHED
      // 或 dom 站点抄全文。透出到 /status 与右栏，用户不必再靠「卡了多久」猜。
      lastEndReason = lastFinished?.settled_by || (site.decoder === 'dom' ? 'dom-capture' : 'finished');
      metrics.endReason = lastEndReason;
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
    // 三态导航（C-2）：'fresh' 开新会话、'resume' 导航回既有会话、
    // 'unsupported' 明确报错。**没有第四态**——旧实现在这里默默开新会话并把增量
    // 发进去，网页模型在毫无前文的情况下接着答，是「跑着跑着变傻」的根因。
    const nav = conversationNav({
      siteId,
      origin: new URL(cfg.site).origin,
      fresh,
      sessionId: existing?.webSessionId,
    });
    if (nav.state === 'unsupported') {
      sessionLostCount += 1;
      lastSessionLost = {
        at: Date.now(),
        reason: nav.reason,
        siteId,
        hasStoredSession: Boolean(existing?.webSessionId),
        chars: String(message || '').length,
      };
      const err = new Error(
        'WEB_SESSION_LOST: 会话槽' + (nav.reason === 'no-stored-session' ? '为空' : '存的会话无法导航回去')
        + `（site=${siteId}，${nav.reason}） — 需要整段重建`,
      );
      err.code = 'WEB_SESSION_LOST';
      err.navReason = nav.reason;
      err.siteId = siteId;
      err.hasStoredSession = Boolean(existing?.webSessionId);
      warn(`web session lost (#${sessionLostCount}, site=${siteId}, ${nav.reason}) — 上层将整段重建`);
      throw err;
    }
    const navigate = nav.state === 'resume' ? nav.url : 'fresh';
    let result;
    try {
      result = await runTurn(message, { navigate, signal, onDelta, onThink, onImage, model, images, thinkMode });
    } catch (err) {
      // 会话槽里存的是一个已经死掉的网页会话：立刻丢掉，别让下一轮再撞一次。
      // 上层收到 WEB_SESSION_LOST 后作废游标并以整段首轮提示词重开。
      if (err?.code === 'WEB_SESSION_LOST') forgetConversation(key);
      throw err;
    }
    // 身份优先来自地址、其次来自流（C-1）。两者都拿不到时才丢掉会话槽——
    // 而这种情况在 GLM/Z.ai 上曾经是**恒态**（旧实现只认 DeepSeek 的地址形状）。
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

  /**
   * 非 DeepSeek 站点的模型选择。
   *
   * 0.13.0 重写（真机根因）：旧实现在没有选择器契约时，用
   * `getByText(labels[0], {exact:true})` 之类的启发式**猜着点**，猜不到就
   * `return { strict:false, fallback:'default-model' }` —— 而调用方把这个
   * 返回值当成功继续往下走，于是「模型选择」在多数站点上是静默的空操作。
   *
   * 现在：站点在 providers 里声明 modelPicker 契约（触发 + 选项 + 回读），
   * 由 lib/model-picker.js 执行**精确名匹配 + 点击后回读确认**；没有契约就
   * 如实报告 unverified，绝不假装切换成功。
   */
  async function selectModelGeneric(model, { label }) {
    const picker = site.modelPicker;
    if (!pickerUsable(picker)) {
      // 旧行为保留一层：站点若有原生 <select> 或多形态标签，仍可尝试，
      // 但**必须**以「是否真的读到目标名」判定成败。
      const native = page.locator('select[aria-label="模型"], select[aria-label="Model"]');
      if (await native.count()) {
        const option = native.first().locator(`option[value="${model.id}"]`);
        if (await option.count()) {
          await native.first().selectOption(model.id);
          const now = await native.first().inputValue();
          if (now === model.id) { selectedModel = model.id; return { strict: true, ui: 'native-select' }; }
        }
      }
      selectedModel = null;
      warn(`站点 ${siteId} 没有模型选择契约（providers.modelPicker），本轮不切换网页模型`);
      return { strict: false, fallback: 'unverified', note: `站点 ${siteId} 的模型切换尚未真机校准，本轮沿用网页当前模型` };
    }

    const result = await selectWebModel(page, model, picker);
    if (!result.ok) {
      selectedModel = null;
      const detail = result.options?.length ? ' — 弹层可选：' + result.options.join('、') : '';
      const err = new Error(`MODEL_UNAVAILABLE: 未能切换到 ${result.requested}（${result.reason}）${detail}`);
      err.code = 'MODEL_UNAVAILABLE';
      throw err;
    }
    selectedModel = model.id;
    if (!result.confirmed && result.applied) {
      // 点了、也回读到了，但读出来的不是目标名 —— 这是一次**可能没生效**的
      // 切换，必须让上层知道（旧实现会把这种情况记成成功）。
      warn(`模型回读不一致：目标 ${result.requested}，回读 ${result.applied}`);
      return { strict: false, fallback: 'readback-mismatch', applied: result.applied, note: `已点击 ${result.clicked}，但回读为「${result.applied}」` };
    }
    if (!result.applied) {
      // 站点没声明回读选择器：点了但无法确认
      return { strict: false, fallback: 'unverified-click', note: `已点击 ${result.clicked}，该站点无法回读当前模型名` };
    }
    return { strict: true, ui: 'picker', applied: result.applied };
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

  /**
   * 一次性登录（有头 Edge → 完成后切回无头）。
   *
   * 返回 { ok, loggedIn, siteId, alreadyLoggedIn, ms, note } —— 旧实现只
   * fire-and-forget，控制面立刻回「登录窗口打开中」，真实失败全被吞掉；用户看到
   * 的现象是「点了登录没反应，之后哪儿都登不上」。现在把结果带回控制面。
   *
   * @param {{onState?: (s: string) => void}} [opts]
   */
  async function openLogin({ onState } = {}) {
    if (busy || transitioning) throw new Error('driver busy with a web turn — login refused');
    transitioning = true;
    const t0 = Date.now();
    const report = (s) => { loginState = s; try { onState?.(s); } catch {} };
    report('idle');
    try {
      // 已经登录过的 profile：无需再走「打开窗口 + 人工登录」，直接核验一次。
      // （换账户时用户会先点网页里的退出，此时输入框消失，仍会正常进入登录流程。）
      if (ctx && page && !page.isClosed?.()) {
        try {
          if (await judgeLoggedIn(page)) {
            loggedIn = true;
            persistLoginState({ loggedIn: true, at: Date.now(), message: '快速核验：登录态有效' });
            report('already-logged-in');
            lastLogin = { ok: true, at: Date.now(), ms: Date.now() - t0, alreadyLoggedIn: true, message: '登录态仍有效，无需重新登录' };
            return { ok: true, loggedIn: true, alreadyLoggedIn: true, siteId, ms: lastLogin.ms, note: lastLogin.message };
          }
        } catch { /* fall through to the headed login flow */ }
      }
      // 无活页时先做一次无头快速核验（0.12.5）：旧实现在驱动尚未懒创建（fresh
      // boot）时直接开有头登录窗口——cookies 明明有效也要用户看着登录窗口闪一道、
      // 每次重启都被迫手点一次（真机：DeepSeek 每次重启都要点，其他站点因
      // 「已登录(缓存)」直接绿标）。无头核验确认掉登录才升级有头人工流程。
      if (!ctx || !page || page.isClosed?.()) {
        report('launching');
        try {
          await launch({ headless: true });
          try { await page.goto(cfg.site, { waitUntil: 'domcontentloaded', timeout: 45_000 }); } catch {}
          if (await judgeLoggedIn(page)) {
            loggedIn = true;
            persistLoginState({ loggedIn: true, at: Date.now(), message: '无头快速核验：登录态有效' });
            report('already-logged-in');
            lastLogin = { ok: true, at: Date.now(), ms: Date.now() - t0, alreadyLoggedIn: true, message: '登录态有效（无头核验），无需打开登录窗口' };
            return { ok: true, loggedIn: true, alreadyLoggedIn: true, siteId, ms: lastLogin.ms, note: lastLogin.message };
          }
          warn('headless quick verify says logged out — escalating to headed login');
        } catch (e) {
          warn('headless quick verify failed, falling back to headed login:', e?.message);
        }
        try { if (ctx) await ctx.close(); } catch {}
        ctx = null; page = null;
      }
      try { if (ctx) await ctx.close(); } catch {}
      ctx = null; page = null;
      log('opening headed window for login');
      report('launching');
      await launch({ headless: false }).catch(async (err) => {
        // 上一次浏览器被强杀留下的单实例锁：清掉再试一次（clearStaleProfileLocks
        // 在 ctx 为空时才动手，这里 ctx 已置空，是安全的）。
        warn('headed launch failed, retrying after lock cleanup:', err?.message);
        await new Promise((r) => setTimeout(r, 800));
        ctx = null; page = null;
        await launch({ headless: false });
      });
      try { await page.goto(cfg.site, { waitUntil: 'domcontentloaded', timeout: 45_000 }); } catch {}
      report('waiting-for-login');
      const t1 = Date.now();
      let healed = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        if (Date.now() - t1 > cfg.loginTimeoutMs) throw new Error('login wait timed out');
        if (!page || page.isClosed?.()) {
          // 登录窗口被关/页面丢失：旧实现 page.isClosed?.() 直接 TypeError
          //（豆包/Kimi 真机报「Cannot read properties of null (reading 'isClosed')」），
          // 用户只看到「请求失败」。先自愈重开一次——cookies 在 profile 里，
          // 已完成的登录不丢；重开也失败才按可读错误收场。
          if (++healed > 2) throw new Error('登录窗口已关闭且无法重开，登录未完成');
          warn('login window lost mid-flow — reopening');
          try {
            await ensure();
            await page.goto(cfg.site, { waitUntil: 'domcontentloaded', timeout: 45_000 });
            report('waiting-for-login');
            continue;
          } catch (e) { throw new Error('登录窗口已关闭，登录未完成（' + String(e?.message || e).slice(0, 80) + '）'); }
        }
        try {
          const u = new URL(page.url());
          if (/sign|login/i.test(u.pathname)) continue;
          if (await judgeLoggedIn(page)) break;
        } catch (err) {
          throw err;
        }
      }
      log('login detected; switching to headless');
      try { await ctx.close(); } catch {}
      ctx = null; page = null;
      await launch({ headless: true });
      await gotoFreshChat();
      loggedIn = true;
      persistLoginState({ loggedIn: true, at: Date.now(), message: '人工登录完成' });
      report('ready');
      lastLogin = { ok: true, at: Date.now(), ms: Date.now() - t0, alreadyLoggedIn: false, message: '登录完成，已切回无头运行' };
      return { ok: true, loggedIn: true, alreadyLoggedIn: false, siteId, ms: lastLogin.ms, note: lastLogin.message };
    } catch (err) {
      report('error');
      lastLogin = { ok: false, at: Date.now(), ms: Date.now() - t0, error: String(err?.message || err) };
      persistLoginState({ loggedIn: false, at: Date.now(), message: String(err?.message || err).slice(0, 120) });
      throw err;
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
  async function openWindow({ width, height, url, offset = 0 } = {}) {
    await ensure();
    throwIfTransitioning();
    // 已开着窗口：聚焦弹到最前（跳回已有窗口），不重新停靠/goto 覆盖现场。
    if (ctx && headed && page && !page.isClosed()) {
      await page.bringToFront().catch(() => {});
      return { ok: true, alreadyOpen: true, ...windowState() };
    }
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
        // 多窗口错位：第 N 个窗口向右上错开 N*36px，避免新窗完全盖住旧窗。
        const off = Math.max(0, Math.min(6, Math.round(Number(offset) || 0))) * 36;
        const bounds = screen?.bounds ? {
          left: Math.round(screen.bounds.left + (screen.bounds.width - w) / 2 + screen.bounds.width / 4) + off,
          top: Math.max(0, (screen.bounds.top || 0) - off),
          width: w,
          height: Math.min(h, (screen.bounds.height || h) - 40),
          windowState: 'normal',
        } : { left: off, top: off, width: w, height: h, windowState: 'normal' };
        const cdp = await ctx.newCDPSession(page);
        const { windowId } = await cdp.send('Browser.getWindowForTarget');
        await cdp.send('Browser.setWindowBounds', { windowId, bounds });
        await cdp.detach();
      }
    } catch (err) { warn('window dock failed (window stays at default position):', err?.message); }
    const target = url || cfg.site;
    try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {}); } catch { /* already there */ }
    // 与登录同一套判定（z.ai 游客页有输入框，旧「URL 不含 login 即已登录」
    // 会把未登录记成已登录）；先等输入框渲染完再判，避免瞬时误判未登录。
    await page.waitForSelector(SEL.input, { timeout: 15_000 }).catch(() => {});
    loggedIn = await judgeLoggedIn(page);
    if (loggedIn) persistLoginState({ loggedIn: true, at: Date.now(), message: '独立窗口核验' });
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

  /**
   * 「导入本机登录态」：把用户真实 Edge profile 的 cookies 采纳进本驱动。
   *
   * 关键实现约束（2026-09-13 重写）：**绝不在原 profile 上 launchPersistentContext**。
   * 旧实现直接 launchPersistentContext(sourceProfileDir) —— 那个目录正是用户日常
   * 正在使用的 Edge User Data，会撞单实例锁、更糟的是可能把用户的浏览器带进
   * 自动化会话。现在先复制成临时 profile 再读 storageState，读完即删。
   *
   * @param {string} sourceProfileDir User Data 目录（内部会拼 Default/Network/Cookies）
   */
  async function importStorageFromProfile(sourceProfileDir) {
    if (busy || transitioning) throw new Error('driver busy with a web turn — session import refused');
    transitioning = true;
    try {
      const src = String(sourceProfileDir || '').trim();
      if (!src) throw new Error('source profile dir is empty');
      const cookiesFile = path.join(src, 'Default', 'Network', 'Cookies');
      if (!fs.existsSync(cookiesFile)) throw new Error('source profile has no cookies: ' + src);
      // 临时目录必须与本 profile 同盘才能保证 rename/copy 语义一致；用 profileDir
      // 的父目录下的 .tmp-import-<pid>（与既有 .tmp 约定一致，不污染用户目录）。
      const tmpProfile = path.join(path.dirname(cfg.profileDir), '.tmp-import-' + process.pid + '-' + Date.now());
      let tmp = null;
      try {
        fs.mkdirSync(tmpProfile, { recursive: true });
        // 只复制读取 storageState 所需的最小集合：Local State（加密密钥）与
        // Default/Network/Cookies（凭据本体）。整目录复制在真实 User Data 上可能
        // 是数 GB，且会把缓存/历史一起搬走。
        for (const rel of ['Local State', path.join('Default', 'Network', 'Cookies'),
          path.join('Default', 'Network', 'Cookies-journal'),
          path.join('Default', 'Preferences')]) {
          const from = path.join(src, rel);
          const to = path.join(tmpProfile, rel);
          try {
            if (!fs.existsSync(from)) continue;
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(from, to);
          } catch (err) { warn('import: copy skipped', rel, err?.message); }
        }
        tmp = await chromium.launchPersistentContext(tmpProfile, {
          executablePath: cfg.executablePath,
          headless: true,
          args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
        });
        cfg.storageState = await tmp.storageState();
        // 真机实测（2026-09-13）：Edge 128+ 用 **app-bound 加密**（cookie 的
        // encrypted_value 前缀为 `v20`，本机 372 枚全部如此），密钥绑定 Edge 应用
        // 身份而非仅用户 —— 换 profile 目录后一个都解不开。storageState 会静默
        // 返回 0 枚 cookie，看起来像「导入成功但没登录」。这里显式识别并如实报错，
        // 不让按钮骗人（cookies 为 v10/DPAPI 的旧 Edge 或其它 Chromium 仍可用）。
        const cookieCount = Array.isArray(cfg.storageState?.cookies) ? cfg.storageState.cookies.length : 0;
        if (cookieCount === 0) {
          // 不留半截状态：空 storageState 对后续 launch 没有意义，清掉更诚实。
          cfg.storageState = null;
          // 消息保持短（控制面透传时截断到 200 字符，可操作的那句必须在前面）。
          const err = new Error('cookie 无法解密：Edge 128+ 用 app-bound 加密（v20）把密钥绑定到 Edge 应用身份，复制 profile 读不出任何 cookie。请改用该站点的「登录」按钮——弹出的真实 Edge 窗口里登录一次即可，登录态会持久保存在桥自己的 profile 里。');
          err.code = 'COOKIE_IMPORT_UNDECRYPTABLE';
          throw err;
        }
        cfg.storageState.cookieCount = cookieCount;
      } finally {
        try { await tmp?.close(); } catch {}
        try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch { /* 下次覆盖 */ }
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

  /**
   * 本轮网页会话身份（C-1）——**地址与流两个来源都认**。
   *
   * 为什么必须两个来源（真机 2026-09-14 取证）：
   *   • DeepSeek 只把身份放在地址里（`?chat_session_id=` / `/a/chat/s/`）；
   *   • GLM 的地址里有 `?cid=<24 位十六进制>`，**同时** SSE 首帧带
   *     `conversation_id`，两者逐字相同（6aa6f08454b3a5a4e4f64a77）；
   *   • Z.ai 的地址形状尚未确认时，流里的 id 是唯一身份来源。
   *
   * 旧实现只看地址、且只认 DeepSeek 的两种形状 → GLM/Z.ai 恒 null →
   * rememberConversation 永不执行 → 每轮 WEB_SESSION_LOST → 上层 fresh 重开。
   * 用户看到的是「同一个会话，每轮都新开一个对话」。
   *
   * 顺序上地址优先：它是**用户此刻真实所在**的会话，比流里报的更权威。
   */
  function turnSessionId(url) {
    return conversationIdFromUrl(siteId, url) || lastFinished?.decoderConversationId || null;
  }

  function sessionIdFromUrl(url) {
    return conversationIdFromUrl(siteId, url);
  }
  function safeUrl(url) { try { return String(new URL(url)); } catch { return null; } }

  return { sendPrompt, sendTurn, resetConversation, conversationFor, connect, interact, openLogin, openWindow, closeWindow, importStorageFromProfile, status, close, diagnostics, getToken, profileCookies, writeProfileCookies, userAgent, get page() { return page; }, webApi, listSessions, fetchHistory, screenshotBase64, setImageLimitsProvider };
}

function abortError() {
  const err = new Error('webcode driver: aborted');
  err.name = 'AbortError';
  return err;
}
