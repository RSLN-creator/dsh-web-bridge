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
import { toPlaywrightCookie } from './cookies.js';
import { getSite, getContract, resolveWebModel, conversationNav, conversationIdFromUrl } from './contract.js';
import { DEFAULT_SLOT, normalizeSlot } from './accounts.js';
import { selectWebModel, pickerUsable } from './model-picker.js';
import { deriveLastRate, shouldSettleWip, shouldSettleStalledThinking, answerDomLength } from './metrics.js';
import { emptyWebResponseError } from './zero-progress.js';
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

/** 捕获脚本：按站点 completionPaths 拦截 SSE 或 Connect-RPC（XHR drain + fetch tee）。
 *  自愈守护：站点埋点 SDK 会把 window.fetch **恢复成原生引用**（GLM 真机实锤：
 *  installed=true 而 fetch 包装出链，整条流静默丢失），单次包装挡不住。包装带
 *  __wcCap 特征标记，守护每 500ms 查一次，丢失立即重装——导航后脚本重跑，
 *  守护只存在于当前文档，不会累积。
 *
 *  Connect-RPC（kimi 2026-09-21 真机确证）：网页已从旧 SSE 全面迁移到
 *  `POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat`（Content-Type:
 *  application/connect+json），响应是**二进制帧流**：每帧 `[flags(1)][len(4BE)][json]`，
 *  逐帧 JSON 自描述（{op:'set'|'append', mask:'block.text|block.think.content|...',
 *  done:{}}）。TextDecoder 会把字节头解成乱码、无法按行切分 → 这里对 connect 站点
 *  用原始字节累积 + 按帧头切分，把每帧 JSON 以独立一行 emit 给下游行式解码器。 */
function captureInit(paths, opts = {}) {
  const connect = opts.transport === 'connect';
  const list = JSON.stringify(paths.length ? paths : ['/api/v0/chat/completion']);
  return `
(function () {
  if (window.__webcodeCaptureInstalled) { try { install(); } catch {} return; }
  window.__webcodeCaptureInstalled = true;
  const TARGETS = ${list};
  const CONNECT = ${connect};
  const hit = (u) => TARGETS.some((t) => String(u || '').includes(t));
  const emit = (id, phase, text) => { try { window.__webcodeChunk(id, phase, text || ''); } catch {} };
  function newId() { return 'cap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  // Connect-RPC 二进制帧切分器：累积原始字节，按 [flags(1)][len(4BE)][json] 逐帧取 JSON。
  function makeConnectSplitter(emitFrame) {
    let frames = [];          // Uint8Array 累积
    function px(arr, off, n) { let v = 0; for (let i = 0; i < n; i++) v = (v * 256) + (arr[off + i] || 0); return v; }
    function consume(bytes) {
      for (const b of bytes) frames.push(b);
      let buf = Uint8Array.from(frames);
      let off = 0;
      for (;;) {
        if (buf.length - off < 5) break;
        const len = ((buf[off + 1] & 0xff) * 0x1000000) + ((buf[off + 2] & 0xff) * 0x10000)
          + ((buf[off + 3] & 0xff) * 0x100) + (buf[off + 4] & 0xff);
        if (len < 0 || len > 64 * 1024 * 1024) { off++; continue; }   // 防脏帧死循环
        // 长度头之后必须紧跟 JSON 对象的首字节 {：Connect-RPC 的载荷是自描述 JSON，
        // 而「假长度头」也能落在合法区间内（真机噪音里见过 33MB 这种值）——只看长度
        // 会让切帧器停在那儿死等一个永远凑不齐的帧，**后面所有真帧全被扣住**。
        // 用载荷首字节做第二判据即可重同步；正常帧的 payload 恒以 { 开头，不误伤。
        if (buf[off + 5] !== 0x7b) { off++; continue; }
        if (buf.length - off < 5 + len) break;
        const chunk = buf.subarray(off + 5, off + 5 + len);
        // Decode as UTF-8. Do NOT build the string byte-by-byte with String.fromCharCode:
        // Connect-RPC JSON frames carry CJK text, and raw-byte decoding turns it into
        // mojibake that JSON.parse still accepts, so the corruption travels silently all
        // the way to the decoder and the harness (no throw, no trace, only garbled text).
        // Caught 2026-09-21 by the real-execution cases in test/capture-connect.test.mjs.
        // NOTE: this block lives inside a template literal; comments here must not contain
        // backticks, or the template is cut short (hit for real on 2026-09-21).
        let s = '';
        try { s = new TextDecoder('utf-8').decode(chunk); } catch { continue; }
        try { const j = JSON.parse(s); emitFrame(j); } catch { /* 跳过非 JSON 帧 */ }
        off += 5 + len;
      }
      frames = Array.from(buf.subarray(off));
    }
    return { consume };
  }
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
              if (CONNECT) {
                const splitter = makeConnectSplitter((j) => {
                  // 每帧 JSON 一行喂给下游行式解码器（JsonLinesDecoder 按 \\n 分行）。
                  emit(id, 'chunk', JSON.stringify(j) + '\\n');
                });
                (async () => {
                  try {
                    for (;;) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      splitter.consume(value);
                    }
                  } catch {}
                  emit(id, 'end', '');
                })();
              } else {
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
              }
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

/**
 * 写入计划（纯函数，便于护栏测试）：给定总长度与单块上限，决定一次性写还是分块写。
 *
 * 为什么这条决策要单独抽出来：真机 2026-09-14 的 turn/end 里留下了 80 万字符
 * 一次性 fill 导致 30s 超时的证据（详见 fillComposer 注释）。「多少算太长」是
 * 一个会随站点变化的阈值，把它写成可断言的数据，比埋在两个 async 循环里可靠。
 *
 * 边界：非法 chunkChars（0/NaN/负数）走默认 20_000；clamp 到 [1_000, 200_000]，
 * 避免配置成 1 导致每字符一次往返（把卡死换成更慢）。
 */
export function composerWritePlan({ length = 0, chunkChars = 20_000, kind = 'field' } = {}) {
  const total = Math.max(0, Math.floor(Number(length) || 0));
  // 非法值（0 / 负数 / NaN / 非数字）走**默认**，不是走 clamp 的下界：
  // 「配成 -5」不是一个「很小的块」，而是一个错误配置，语义上应当等价于没配。
  // （写成 clamp 的话 -5 会被抬成 1000，把错误配置伪装成一个合法的激进值。）
  const raw = Number(chunkChars);
  const size = Number.isFinite(raw) && raw > 0 ? Math.max(1_000, Math.min(200_000, raw)) : 20_000;
  const chunks = total === 0 ? 0 : Math.ceil(total / size);
  return { mode: total <= size ? 'single' : 'chunked', chunkChars: size, kind, chunks, total };
}

/**
 * 提示词投递计划（纯函数）：超长正文走**附件**还是继续 inline（0.16.2）。
 *
 * ## 为什么需要它
 *
 * 真机实测：`GET /__webcode/preset` 读到 `promptChars: 409555`。这 40 万字符里
 * 90% 是会话 transcript，全部作为**纯文本**灌进网页输入框。纯文本投递有两个
 * 已经发生过的真机事故：`PROMPT_WRITE_STALLED`（写入期间长度不再增长）与
 * `PROMPT_TRUNCATED`（网页只收了半截）。把长正文改为附件投递，是绕开输入框
 * 长度与写入性能问题的直接手段。
 *
 * ## 为什么抽成纯函数
 *
 * 与 `composerWritePlan` 同一条纪律：「多少算太长」是一个会随站点与网页改版
 * 变化的阈值，写成可断言的数据比埋在两个 async 分支里可靠。
 *
 * ## 默认必须保守（三个条件缺一不可）
 *
 *   · `attachEnabled`  —— 配置开关，**默认关**。没开就永远 inline，
 *                         即默认行为与 0.16.1 逐字相同。
 *   · `attachSupported`—— 页面真的有可用的文件上传入口（探测结果）。
 *   · `inlineLimit > 0`—— 阈值本身要有效。
 *
 * 任一不成立就回落 `inline`。这条「宁可 inline，不要发不出去」的取向与
 * `uploadImages` 的「附件未确认就报错」是一致的：投递方式是实现细节，
 * 而「消息必须发出去」是用户可见的契约。
 *
 * ## 附件也有自己的上限（0.16.3 新增 maxChars）
 *
 * 判定「改走附件」只解决了输入框，附件本身仍要过网页的上传与模型读取：把整份
 * 40 万级字符塞进去，是拿上传/风控换输入框，不是解决问题。因此 `chars > maxChars`
 * 时 **mode 不变**（仍是 attach），只多出 `truncate:true` 与 `kept`——**截断是投递
 * 层的事，不是判定层的事**。保留哪个方向由调用点决定（见 runTurn：保尾部，因为
 * 尾部才是当下要执行的内容），且必须把「已省略前 N 字符」写出来，绝不静默丢内容。
 *
 * `payloadChars` = **真正会上传的字符数**（截断时 = kept，否则 = total），
 * 一次性回答「这一轮到底有多少字符进了网页」，让日志/`onThink` 读数有唯一口径。
 *
 * 缺失（`undefined`）才取默认 `1_500_000`；**显式传非法值（`<=0` / `NaN` / 非数字 /
 * `null`）一律视为不设上限**（truncate:false、payloadChars=total）。这样「配置写错」
 * 只会退化成 0.16.2 的旧行为，而不是把这一轮的消息悄悄砍成半截。调用点若拿不到
 * 宿主配置（`cfg.attachMaxChars` 未透传 = `undefined`），必须显式传 `null`——
 * 缺配置时的正确行为是「不砍消息」，不是「按默认值砍」。
 *
 * ## 设置面的「投递形态」开关（0.16.3 新增 transport）
 *
 * `transport: 'inline'` 是**用户显式要求纯文本**（设置页单选「纯文本」），它是
 * 判定层的第一优先级：命中就返回 `inline` / `reason:'transport-inline'`，不再看
 * 阈值与入口。这条**不改变任何既有判据的语义**——旧入参（不传 transport）走的分支
 * 与 0.16.2 逐字相同，默认值也是 `'attach'`（即「不由这一层强制」）。
 *
 * 为什么不让调用点直接 `if (transport === 'inline') skip`：那样「走没走附件」的
 * 判据就有两处（调用点的 if 与这里的阈值），而真机出过的正是这类漂移——同一个
 * 判断写两份，一份改了另一份没改。reason 也必须是**新的**一个值，不能借用
 * `attach-disabled`：那句话在面板上会被读成「附件功能被关掉了」，而用户只是选了纯文本。
 *
 * @param {{chars?: number, inlineLimit?: number, attachSupported?: boolean, attachEnabled?: boolean,
 *   maxChars?: number, transport?: 'attach'|'inline', attachForbidden?: boolean}} o
 * @returns {{mode: 'inline'|'attach', reason: string, total: number, limit: number,
 *   payloadChars: number, truncate: boolean, kept: number|null, maxChars: number|null}}
 */
export function promptTransportPlan(o = {}) {
  const total = Math.max(0, Math.floor(Number(o.chars) || 0));
  const limit = Number(o.inlineLimit) > 0 ? Math.floor(Number(o.inlineLimit)) : 0;
  // 1_500_000 不是网页的实测上限，是「真机已知最大 409555 字符（GET /__webcode/preset
  // 的 promptChars，见本函数上方注释）的约 3.7 倍」这个余量的落点：真机正常轮次离它
  // 很远，触到它的输入本就该怀疑是不是上下文失控了。
  const rawMax = o.maxChars === undefined ? 1_500_000 : Number(o.maxChars);
  const maxChars = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : null;
  const cap = (mode, reason) => {
    // 截断字段**只在真的要走附件时**才有意义（0.16.3 修正，实测发现的口径歧义）。
    //
    // 修前的读数是：`attachEnabled:true, attachSupported:false`（页面没有上传入口）
    // 且 chars 超上限时，plan 给 `mode:'inline', truncate:true, payloadChars:1500000`——
    // 而 inline 路径**一个字符都不会截**，2,000,000 字符原样写进输入框。
    // 字段名写的是「会发多少」，读数却是「假如走附件会上传多少」，两句话不是一件事。
    // 它今天没有造成故障（调用点只在 attach 分支读这两个字段），但它是**下一次**
    // 「按读数做决策」的陷阱，也是这种「读数与事实不符」在项目里已经出过多次的形态。
    //
    // 因此这里把它归零：inline ⇒ 不截断、payloadChars = 真正外发的 total。
    // 「若走附件会上传多少」这个信息在 mode 变成 attach 时会自己回来，不丢。
    const truncate = mode === 'attach' && maxChars !== null && total > maxChars;
    return {
      mode, reason, total, limit,
      payloadChars: truncate ? maxChars : total,
      truncate,
      kept: truncate ? maxChars : null,
      maxChars,
    };
  };
  if (o.transport === 'inline') return cap('inline', 'transport-inline');
  // 站点级禁令优先于阈值（0.16.7）：DeepSeek 的网页**收得下附件但不读它**——真机
  // 2026-09-18 实测「附件投递（over-limit, 71994 字符, webcode-context.md）」那一轮
  // 零回复、页面退回根地址、domChars=0；同一份设置改回纯文本就正常。因此该站点
  // 无论多长都只走输入框：宁可慢，也不要「网页收下了、什么都不回」。
  // 判据是**站点声明**（ATTACH_FORBIDDEN_SITES），不是调用方每次都记得传的开关——
  // 这条知识属于站点契约，写在别处必然漂移。
  if (o.attachForbidden) return cap('inline', 'site-no-attach');
  if (!o.attachEnabled) return cap('inline', 'attach-disabled');
  if (!o.attachSupported) return cap('inline', 'no-attach-input');
  if (limit <= 0) return cap('inline', 'no-limit');
  if (total <= limit) return cap('inline', 'under-limit');
  return cap('attach', 'over-limit');
}

/**
 * 哪些站点的网页**能上传附件但不读附件**，因此永远不许走附件投递（0.16.7）。
 *
 * 真机读数（2026-09-18，DeepSeek，用户报障原文「deepseek以附件投递会出问题！不能回复！
 * 前面时候改为输入框还行！」）：`/__webcode/status` 的
 * `attachTransport = { transport:'attach', reason:'over-limit', name:'webcode-context.md',
 * total:71994, evidence:'text:webcode-context.md' }` —— 附件确实传上去了、页面上也出现了，
 * 但这一轮**没有任何回复**：`lastEndReason` 空、`domChars:0`、`lastRate:null`，
 * 页面退回 `https://chat.deepseek.com/` 根地址，navTrace 里连 `landed:after-submit` 都没有。
 * 同一账号改回纯文本投递后恢复正常。
 *
 * ## 2026-09-20 解禁（0.16.31）：静态表清空，DeepSeek 交回**运行期自愈**
 *
 * 上面那条禁令的前提在 0.16.31 被真机探针推翻了一半，而另一半有了更好的兜底：
 *
 * ① **前提被推翻的一半**：`POST /__webcode/attach-probe`（只上传、绝不发送）实测
 *    `ok:true`、`evidence:'text:webcode-probe.md'`、`domSnippet` 实拍到输入框里的
 *    chip（`<div class="e70accd6">webcode-probe.md</div>`）、耗时 105ms。
 *    即「收得下、渲染得出」这一半**在今天的页面上是成立的**；2026-09-18 那次
 *    `ATTACH_NOT_CONFIRMED` 的直接原因（文件名证据当时还没实现，类名清单零命中）
 *    已经不在了。
 *
 * ② **另一半（模型读不读、会不会零回复）仍未由读数据证明**：探针只证明「页面
 *    收下了」，它**不发送**，因此回答不了「模型会不会读到、会不会零回复」。
 *    但这一半现在有**运行期自愈**兜底：`DYNAMIC_ATTACH_BLOCKS` 对「附件轮整轮
 *    零回复」（空结果与超时两个签名）自动降级并记住，当轮即回落 inline，用户最多
 *    损失一轮而不是一直坏。也就是说：留着静态禁令防的是「一轮」，代价却是
 *    **永远走不了附件**——用一个永久能力换一轮风险，不划算。
 *
 * 因此本表清空，DeepSeek 与其它站点走同一条判定（阈值 + 入口 + 运行期自愈）。
 * 真正的站点差异（GLM 输入框装不下长文）仍然由各站点的**阈值**表达，不由禁令表达。
 * 若自愈再次记下 DeepSeek 的 `ATTACH_ZERO_REPLY`，`attachBlocked` 会在
 * `/__webcode/status` 上如实报出——那时再按读数据决定要不要恢复静态禁令。
 *
 * 反向要求同样成立：GLM 的输入框装不下长文（用户原话「他在附件可以，输入框过长」），
 * 所以它必须留在附件路径上——本表只排除，不改变其它站点的既有行为。
 */
export const ATTACH_FORBIDDEN_SITES = Object.freeze(new Set());

/**
 * 运行期附件禁令（0.16.28）：站点级**自愈降级**记录 ——「附件投递后零回复 ⇒ 自动
 * 降级并记住」。这是 0.16.7 台账「仍未做 §2」挂账的理想形态：静态禁令（上面的
 * ATTACH_FORBIDDEN_SITES）只能人工复验后解除，而站点契约是会变的（DeepSeek 修好
 * 附件解析的那天，静态表就成了盲区）；反过来，未列入静态表的站点一旦出现同款
 * 「传得上、零回复」症状，旧实现会每轮都白传一次附件。
 *
 * 判据与 0.16.7 真机签名逐字同源：**该轮真的走了附件**（attachTransport.transport
 * === 'attach' 且未回落）且**正文/思考/图片全空**（emptyWebResponseError 的判定）。
 * 命中即按站点记录（进程生命周期内有效，重启清零——重启后首预算作一次自然复验），
 * promptTransportPlan 的 attachForbidden 判定与 status 读数都会看见它。
 */
const DYNAMIC_ATTACH_BLOCKS = new Map();

/** 运行期附件禁令读数：{ at, code, total } | null。 */
export function dynamicAttachBlock(siteId) {
  return DYNAMIC_ATTACH_BLOCKS.get(String(siteId || '')) || null;
}

/** 该站点当前是否被附件禁令（静态 ∪ 运行期）拦住。 */
export function attachForbiddenFor(siteId) {
  return ATTACH_FORBIDDEN_SITES.has(siteId) || DYNAMIC_ATTACH_BLOCKS.has(String(siteId || ''));
}

/** 记录一次运行期禁令（runTurn 的空回复 × 附件轮现场）。幂等，保留首次现场。
 *  返回是否新记（false = 已有记录）；warn 由调用点负责——模块级拿不到 cfg.logger。 */
export function markDynamicAttachBlock(siteId, total) {
  const key = String(siteId || '');
  if (DYNAMIC_ATTACH_BLOCKS.has(key)) return false;
  DYNAMIC_ATTACH_BLOCKS.set(key, { at: Date.now(), code: 'ATTACH_ZERO_REPLY', total });
  return true;
}

/**
 * 停滞判定（纯函数）：块间回读长度不增长即计入停滞，连续两块即判死。
 *
 * 为什么是「连续两块」而不是「一块」：富文本编辑器（tiptap/ProseMirror）在
 * 插入大块文本后需要一拍才把内部文档同步到 DOM，单块回读偶尔会读到旧长度——
 * 只判一块会把正常的 doubao/kimi 误杀。连续两块不涨，才是真的卡住。
 *
 * curLen 为 null 表示回读失败（元素被替换、页面转场）：既不计入停滞、也不重置
 * 计数，也**不**据此判死——那是另一类故障，由调用方的超时与错误码负责。
 */
export function stallStep(prevLen, curLen, stalled) {
  const prev = typeof prevLen === 'number' ? prevLen : -1;
  const count = Math.max(0, Number(stalled) || 0);
  if (curLen == null) return { stalled: count, prevLen: prev, died: false };
  const len = Number(curLen) || 0;
  const next = len <= prev ? count + 1 : 0;
  return { stalled: next, prevLen: len, died: next >= 2 };
}

/**
 * 建一个站点驱动实例：用真实 Edge 打开站点、登录、发消息、收流、回读会话 id。
 *
 * 一个实例 = **一个「站点 × 账户槽」**（0.14.7 起）。同站点两个账户是两个实例、
 * 两个独立 profileDir——共用会让两边的登录态互相覆盖，界面上表现为「点了账户2
 * 却在动账户1」。
 *
 * 驱动是本桥**唯一**持有浏览器状态的地方：所有镜像、控制面、OpenAI 前端最终都
 * 汇到它的 `sendTurn`。因此这里的取舍一律偏向「宁可慢、不要错」：分块写入
 * composer、空流宽限重绑、WIP 稳态巡检，都是为了不让长任务被一次抖动打死。
 *
 * @param {object} [options] siteId/site/profileDir/headless/超时/composerChunkChars/logger…
 * @returns {object} driver 实例（sendTurn/status/login/interact/diagnostics…）
 */
export function createBrowserDriver(options = {}) {
  const siteId = options.siteId ?? 'deepseek';
  const site = getSite(siteId);
  const contract = getContract(siteId);
  if (!site || !contract) throw new Error('webcode driver: unknown siteId ' + siteId);
  // 账户槽（0.14.7）：同一站点的第 2 个账户是**另一个驱动实例**，用另一个 profileDir。
  // 槽在驱动里只做两件事：① 透出给 /status 与面板（用户要知道这行是哪个账户）；
  // ② 进日志前缀（两个槽的日志混在一起时能分开）。
  //
  // 文件名**刻意不按槽改名**：profileDir 本身已经是槽目录（见 accounts.slotProfileDir），
  // 在槽目录里再写一份带槽名的文件名是冗余的——而冗余的名字意味着多一条迁移路径，
  // 迁移就是风险。默认槽因此逐字保持 0.14.6 的落盘形状。
  const slot = normalizeSlot(options.slot) || DEFAULT_SLOT;
  const siteUrl = options.site ?? site.origin + '/';
  const cfg = {
    siteId,
    slot,
    site: siteUrl,
    profileDir: options.profileDir,
    executablePath: options.executablePath ?? defaultEdgePath(),
    headless: options.headless !== false,
    loginTimeoutMs: options.loginTimeoutMs ?? 300_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 240_000,
    // 单块写入字符数上限（0.14.5）。超过它就把 composer 分块写入并在块间回读
    // 长度——一次性写 80 万字符会让 Playwright 的 fill 整段卡死（真机证据见
    // fillComposer 的注释）。0 或非法值走默认 20_000。
    composerChunkChars: Number(options.composerChunkChars) > 0 ? Number(options.composerChunkChars) : 20_000,
    // 超过这个字符数就改走**附件**投递（0.16.2）。**默认 0 = 关闭**：没有真机
    // 配对数据之前不改变默认行为。见 promptTransportPlan 的注释。
    attachInlineLimitChars: Number(options.attachInlineLimitChars) > 0 ? Number(options.attachInlineLimitChars) : 0,
    // 「只出思维链、永远不出正文」的绝对上限（0.15.2）。与 requestTimeoutMs 的分工：
    // 那个是**整轮**（含正常的长思考 + 长正文）的总兜底，240s 到点时用户已经干等
    // 四分钟且报错是通用 timeout；这个从**最后一次正文/图片**起算，专抓「思考完
    // 就没下文」这一形态。0 / 非有限值 = 关闭该判据（见 metrics.shouldSettleStalledThinking）。
    answerTimeoutMs: Number(options.answerTimeoutMs) >= 0 ? Number(options.answerTimeoutMs) : 180_000,
    decoderPath: options.decoderPath ?? null,
    // 注入式页面（**离线护栏专用**，`options.page`）：给了它，`ensure()` 就把它
    // 当成已就绪的页面，一个浏览器都不启动，runTurn 的全部页面交互打在这个脚本
    // 页上（护栏须提供 url/goto/locator/evaluate 等最小方法，见 test/ 的用例）。
    //
    // 为什么需要一个注入口：「落地即落盘」（sessionSlot / navTrace）这条安全线的
    // 反向验证必须能离线跑——真机事故的形态是「导航落地成功、这一轮随后失败」，
    // 只有把页面脚本化才造得出这个相位；而真机 Edge 不能在 CI 里跑。
    // 它与 `rateLimitBackoffMinMs`（仅供离线测试调小）同一条纪律：**只为测试存在**，
    // 生产路径不构造，缺省 null 时行为与旧版本逐字相同。
    injectedPage: options.page ?? null,
    logger: options.logger ?? console,
  };
  const SEL = {
    input: contract.inputSelector,
    sendButton: contract.sendButtonSelector,
    stopButton: contract.stopButtonSelector,
  };
  // 日志前缀带槽：两个槽同时跑时，`[webcode-driver:glm#2]` 与 `[webcode-driver:glm]`
  // 能一眼分开，否则排障时要靠时间戳猜哪条属于哪个账户。
  const tag = slot === DEFAULT_SLOT ? siteId : siteId + '#' + slot;
  const log = (...a) => cfg.logger.log?.('[webcode-driver:' + tag + ']', ...a);
  const warn = (...a) => cfg.logger.warn?.('[webcode-driver:' + tag + ']', ...a);

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
  // 0.16.3：上面那条收束原因**是什么时候**写的（epoch ms）。
  //
  // 为什么必须有它：真机事故 2026-09-17 18:43 的报错文本是
  // 「WEB_NO_PROGRESS: …（页面在，本轮收束原因 finished）」——而那一轮**根本没跑完**，
  // `finished` 是**上一轮**的收束原因。它被无标注地借用，把「网页那侧还在生成」
  // 读成了「网页已经收束过、所以桥该收到东西」，排查方向当场被带偏。
  // 记住写入时刻，报错里就能把「刚刚这一轮」与「很久以前那一轮」分开。
  let lastEndReasonAt = null;
  /** 收束原因与它的写入时刻必须**同时**更新——分两处写迟早会漂移成
   *  「时间是新的、原因是旧的」这种最难查的读数。 */
  function noteEndReason(reason) {
    lastEndReason = reason;
    lastEndReasonAt = Date.now();
  }
  // 0.16.3：适配器侧 WEB_NO_PROGRESS 报错要带的两段现场（真机事故「web 明明有回复、
  // 桥说没内容」的判据点）。与 lastEndReason 同寿命：本轮结束后**不**清空，超时那一刻
  // 取到的才是刚刚这一轮的读数。
  //   lastActivityAt — 本轮最后一次**观察到活动**的 epoch ms：流增量（delta/think/image）
  //     或 WIP 巡检成功采到页面。它比「上一次事件」宽一层——页面被读到也算活动，
  //     于是「它很新 + 适配器侧零事件」正好把「网页在生成但没回传」与「捕获链死了」
  //     分开。用 Date.now() 而不是驱动内部惯用的 performance.now()：适配器要算的是
  //     「距今几秒」这句墙钟话，不必再对齐两个时间原点。
  //   domReplyChars — WIP 巡检器最近一次 metrics.answerDomLength(domText) 的读数
  //     （剥掉「思考中 / Thought for Ns」计时文案后的真实回复长度）。dom 类站点不跑
  //     巡检（startWipWatch 直接返回）⇒ 恒为 null。
  let lastActivityAt = null;
  let domReplyChars = null;
  /** 记一次「本轮观察到活动」。流增量与 WIP 采样共用同一个读数——两份分别刷新的话，
   *  迟早有一份被漏掉，读数就退化成误导后人的旧值。 */
  function noteActivity() { lastActivityAt = Date.now(); }
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
  // 0.15.2（用户报「长时间后只有思维链卡住，harness 端没有任何报错，没有下一步」）：
  // 「只出思维链、正文一个字符都没来」被硬上限收束的次数与现场。与 recoveredTurns
  // 分列而不是合并——那是「内容保住了」，这是「内容根本没来」，修法完全不同。
  let thinkingOnlyTurns = 0;
  let lastStalledSettle = null;  // { at, reason, thinkingChars, answerChars, waitedMs }
  let wipWatch = null;       // { timer } 当前轮次的稳态巡检器
  // 0.16.3：最近一轮**超长提示词**的投递方式读数（成功与回落都记）。
  // 为什么必须做成可读字段：附件投递的失败被 runTurn 的 catch 吞掉后回落 inline，
  // 只留一行 warn——用户侧看到的是「照样发出去了」，于是「到底有没有真的走附件」
  // 无从判断（用户为此抱怨过好几次「说做了、其实没做」）。这里把它变成 /status 上
  // 可核对的字段：成功 `{ at, name, chars, payloadChars, truncated, evidence, total }`，
  // 回落 `{ at, fallback: true, code, total }`。null = 本轮次没触发过附件投递。
  let attachTransport = null;
  // 0.16.3：`POST /__webcode/attach-probe`（只上传、绝不发送）最近一次的读数。
  // 与 attachTransport **分列**而不是合并：那个记的是「真实轮次实际走了哪条路」，
  // 这个记的是「探针此时此刻的观测」。合成一个字段的话，跑一次探针就会覆盖掉
  // 「上一轮真消息到底有没有走附件」——那正是这一整轮要回答的问题。
  let attachProbe = null;
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
      // mode 0o600 与 consent/settings/send-state 三个文件一致。注意：Windows 上
      // Node 的 mode 不生效（权限由 ACL 决定），这里写它是为了跨平台正确性与
      // 意图表达——不要据此认为凭据文件已被额外加固（见 doc/security-review.md 6.3）。
      fs.writeFileSync(loginStatePath(), JSON.stringify(entry), { mode: 0o600 });
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
    // SPA 水合重探（kimi 真机 2026-09-21）：domcontentloaded 一瞬，头部「登录」按钮
    // 尚未水合，bad/ok 双缺 → 直接回退会把「没登录」记成「有输入框=已登录」。
    // 只有「声明了特征 + 双缺 + 将回退成语义歧义（有可见 composer）」才兜这一次：
    //   已正确命中过的站点（快速路径）零等待；deepseek 未声明特征，完全不进这里；
    //   无 composer 时回退必为 false，再等也等不出区别，跳过。
    if (declared && probe?.bad && await visibleComposerCount(p) > 0) {
      try {
        const appeared = await p.locator(probe.bad).first().waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false);
        if (appeared) { lastLoginBasis = 'probe-bad'; return false; }
      } catch { /* 重探异常不进坑 */ }
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
  // [DIAG-nav] 导航轨迹：「每轮新开对话」必须变成可复核的现场。
  // 记录每轮导航前后的地址与会话 id 变化，只保留最近 40 条，
  // **不改变任何行为**（纯记录）。
  //
  // 2026-09-16：原先这里指向 `doc/diagnosis-fresh-chat-per-turn.md` §6，那份一次性
  // 诊断报告已按用户指示删除。**诊断结论的载体是这个功能本身**——轨迹经 `status()`
  // 的 `navTrace` 字段对外可读（见下方 status() 里的注释），不依赖那份文档。
  // 删除文档时保留了它，正因为「可复核的读数」比「一份会过期的叙述」耐用。
  const navTrace = [];
  let conversationReplacedCount = 0;
  function pushNavTrace(entry) {
    try {
      navTrace.push({ at: Date.now(), ...entry });
      while (navTrace.length > 40) navTrace.shift();
    } catch { /* 诊断绝不影响主链路 */ }
  }
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
      fs.writeFileSync(storePath(), JSON.stringify(Object.fromEntries(conversations), null, 2), { mode: 0o600 });
    } catch (e) { warn('session store save failed:', e?.message); }
  }
  function conversationFor(key) { loadStore(); return conversations.get(String(key || 'main')) || null; }
  /**
   * 写下「这个 DSH 会话 ⇄ 哪个网页会话」这条映射（落盘，跨轮次/跨进程存活）。
   *
   * 为什么这里多一个 `source`：同一行可能来自两种完全不同的来历，排障时
   * 「它是怎么来的」决定下一步查哪里——`'store'` 是本进程**亲眼看到落地**
   * 之后写下的（含导航落地那一刻），`'url-heal'` 是槽为空、从地址栏反推补齐的
   *（见 sendTurn 的自愈分支）。
   *
   * 为什么「什么时候调用它」是本文件最要命的一件事：**真机事故 2026-09-17
   * 20:52**（DSH 会话 `session-063b0a99`，网页会话 `187fdbbd-…`）。旧实现的
   * 唯一调用点在 `sendTurn` 里 `runTurn` **成功返回之后**，于是这一轮——
   * 导航已经落到 `187fdbbd`、407,064 字符已经发出去、只是流后来失败
   *（WEB_NO_PROGRESS）——的映射**从未写下**：`webcode-sessions-deepseek.json`
   * 里没有该 key，`/status` 的 `conversations` 也没有。下一轮 conversationFor
   * 为空 ⇒ conversationNav 回 `unsupported/no-stored-session` ⇒ 上层整段重建
   * 再开一个**新**网页会话。用户看到的就是「明明上下文没到，却一直没有在同一
   * 对话里」。会话身份只要**落地**就已经确定，与轮次成败无关——所以调用点前移
   * 到导航落地那一刻（runTurn 里的 noteLanded），失败路径同样算数。
   *
   * @param {string} key 会话键（DSH 的 `<sessionId>::<agentId>`）
   * @param {string} webSessionId 网页侧会话 id
   * @param {'store'|'url-heal'} [source] 这条记录的来历（默认 'store'）
   */
  function rememberConversation(key, webSessionId, source = 'store') {
    loadStore();
    conversations.set(String(key || 'main'), { webSessionId, at: Date.now(), source });
    // 一个 id 能被重新写下，就证明它是活的：清掉它的「不可达」标记（见 deadSessions）。
    deadSessions.delete(String(webSessionId));
    if (conversations.size > 128) {
      let oldestKey = null; let oldestAt = Infinity;
      for (const [k, v] of conversations) if (v && v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
      if (oldestKey) conversations.delete(oldestKey);
    }
    saveStore();
  }
  function forgetConversation(key) { loadStore(); conversations.delete(String(key || 'main')); saveStore(); }
  // 最近一次 sendTurn 的 key —— `status().sessionSlot` 报的就是它的槽。
  let lastSessionKey = 'main';
  // 被判「不可达」的网页会话 id → 时刻（见 sendTurn 的 WEB_SESSION_LOST 分支）。
  // 自愈补槽必须跳开它们：否则「深链导航失败 → forgetConversation → 下一轮又从
  // 地址栏把同一个死会话补回来」会变成永不退出重建的循环——而地址栏在导航失败
  // 之后**可能仍停在那条深链上**，这正是自愈要防的第二种误伤。
  const deadSessions = new Map();
  function markSessionDead(id, at = Date.now()) {
    if (!id) return;
    deadSessions.set(String(id), at);
    while (deadSessions.size > 64) deadSessions.delete(deadSessions.keys().next().value);
  }

  /**
   * 会话槽的只读投影（冻结契约 `{ webSessionId, at, source }`）。
   *
   * 三态来历缺一不可：
   *   'store'    — 槽里记着（本进程刚写下或历史落盘值）；
   *   'url-heal' — 槽为空，但页面**此刻就停在**某个网页会话上。这是「落地了但
   *                槽没写下来」的现场（2026-09-17 那次事故正是这个形状），
   *                如实报出来，而不是显示成「没有会话」；
   *   'none'     — 两者都没有。
   *
   * 纯读：**不落盘、不导航、不改状态**（`/status` 与 `session-slot` 动作都调它）。
   *
   * @param {string} [key] 省略 = 最近一次 sendTurn 的 key（与 status() 同口径）
   */
  function sessionSlotFor(key) {
    const rec = conversationFor(key ? String(key) : lastSessionKey);
    if (rec?.webSessionId) {
      return {
        webSessionId: rec.webSessionId,
        at: rec.at ?? null,
        // 旧版本落盘的记录没有 source 字段：按 'store' 报（它确实是槽里的值）。
        source: rec.source === 'url-heal' ? 'url-heal' : 'store',
      };
    }
    const fromUrl = sessionIdFromUrl(page?.url?.() || '');
    if (fromUrl) return { webSessionId: fromUrl, at: Date.now(), source: 'url-heal' };
    return { webSessionId: null, at: null, source: 'none' };
  }

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
      // 账户槽（0.14.7）：面板据此把「glm」与「glm#2」分成两行，并知道该读哪个目录。
      slot,
      accountKey: slot === DEFAULT_SLOT ? siteId : siteId + '#' + slot,
      profileDir: cfg.profileDir,
      loginState,
      lastLogin,
      recoveredTurns,
      lastRecovered,
      // 0.15.2：只出思维链、正文一个字符都没来的轮次。与 recoveredTurns 分列——
      // 那是「内容保住了」，这是「内容根本没来」，用户看到的都是「卡住」但下一步
      // 完全不同。answerTimeoutMs 一并透出，便于确认这条防线是否真在生效。
      thinkingOnlyTurns,
      lastStalledSettle,
      answerTimeoutMs: cfg.answerTimeoutMs,
      // 0.14.0：「网页已回复但桥卡住」的可观测面——本轮为什么收束（finished /
      // partial-wip-settled / timeout / dom-capture），以及超时那一刻的页面现场
      //（captureAlive + replyChars）。旧实现只把现场 warn 到宿主控制台。
      lastEndReason,
      // 0.16.3：上面那条收束原因是**什么时候**写的。真机事故里报错文本借用了
      // 上一轮的 `finished`（本轮根本没跑完），把排查方向带偏——有了这个时间戳，
      // 报错就能写出「（上一轮收束原因 finished，30s 前）」，无从混淆。
      lastEndReasonAt,
      // 0.16.3：适配器侧看门狗报错要用的两段现场（判据见 lib/idle-window.js）。
      // lastActivityAt = 本轮最后一次观察到活动的 epoch ms（流增量或 WIP 采样到页面），
      // domReplyChars = 巡检器最近一次剥掉计时文案后的页面回复长度（dom 站点恒 null）。
      // 放在 status 上而不是只写进日志：看门狗开火那一刻只能**同步**读到这个（没有
      // 页面往返），而「最近活动很新 + 页面已有 N 字未回传」正是这次事故的一句话定位。
      lastActivityAt,
      domReplyChars,
      lastTimeoutScene,
      // C-3：会话槽丢失的可核对数字（原先完全静默——用户只看到「每轮新开对话」）
      sessionLostCount,
      lastSessionLost,
      lastTurn,
      // [DIAG-nav] 导航轨迹与「会话 id 被换掉」计数：把「每轮新开对话」从
      // 用户可见的怪异现象变成可复核的读数。这就是该诊断的交付物本身
      // （原先指向的 doc/diagnosis-fresh-chat-per-turn.md 已于 2026-09-16 删除）。
      navTrace: navTrace.slice(-12),
      conversationReplacedCount,
      lastRate: deriveLastRate(lastFinished, selectedModel),
      // 0.16.3：「超长提示词到底走没走附件」的可核对读数（成功与回落都记，见变量声明处）。
      attachTransport,
      // 0.16.3：**当前生效**的投递形态（每次读都现算，见 promptTransportNow）。
      // 放在 status 上，是因为设置面要显示「生效值」——只显示用户选了什么，
      // 会出现「设置页写纯文本、实际走附件」这种无从发现的偏差。
      promptTransport: promptTransportNow(),
      // 0.16.9：站点附件禁令的**可核对读数**。0.16.7 加了禁令却没在任何投影里出现，
      // 于是「修复生效没有」在面板与 /status 上都看不出来（attach-status 反而还在
      // 承诺超阈值走附件）。读数是站点事实，放在 status 上与 promptTransport 并列。
      // 0.16.28：拆成静态（ATTACH_FORBIDDEN_SITES）与运行期（attachBlocked，自愈
      // 降级的现场：at/code/total）两格——「为什么这站不走附件」从此一眼可分。
      attachForbidden: attachForbiddenFor(siteId),
      attachForbiddenStatic: ATTACH_FORBIDDEN_SITES.has(siteId),
      attachBlocked: dynamicAttachBlock(siteId),
      siteId,
      // 0.16.3：探针最近一次读数（见 attachProbe 声明处）。
      attachProbe,
      conversations: Object.fromEntries(conversations),
      // T1 会话槽只读读数（判据见 sessionSlotFor）：把「这个会话到底有没有落到
      // 同一个网页会话上、这条记录是什么来历」变成面板与排障可核对的一行。
      //
      // 为什么 conversations 那张原始映射不够：槽为空时它只能回 `{}`，看不出
      // 「页面其实还停在那会话上」——而 2026-09-17 那次「一直新开对话」的事故
      // 现场恰恰就是「槽为空 + 页面正停在该会话上」，两者必须能分开读。
      sessionSlot: sessionSlotFor(lastSessionKey),
      transport: 'playwright-edge',
      preview: Boolean(page && !page.isClosed?.()),
      window: windowState(),
    };
  }
  async function profileCookies(origin = siteUrl) {
    if (!ctx || typeof ctx.cookies !== 'function') return [];
    try { return await ctx.cookies(origin); } catch { return []; }
  }
  /**
   * 把上游的 Set-Cookie 写回**驱动自己的** cookie jar。
   *
   * 旧实现只取 `name=value` 就 `ctx.addCookies([{name,value,url}])`，在三种真实
   * 情形下是有害的（0.14.4，豆包「登录后右侧打开网页会掉登录」的根因之一）：
   *   • **删除被当成设置**：`name=; Max-Age=0` 会被写成「该 cookie 的空值且不过期」
   *     ——profile 里那枚有效登录 cookie 当场被抹掉，下一轮真实发送就是未登录。
   *   • `__Secure-` / `__Host-` 前缀 cookie 必须带 `secure: true`，否则 playwright
   *     直接抛错，**整批一枚都写不进去**。
   *   • `SameSite=None` 必须与 `Secure` 同时成立，缺任一会被浏览器拒绝。
   *
   * 现在按 RFC 6265 解析（cookies.toPlaywrightCookie）：删除 → `expires: 0`；
   * 其余带上 domain/path/secure/sameSite/expires 写入。
   *
   * @param {string[]} setCookieHeaders 上游原样的 Set-Cookie 头（可多条）
   * @param {string} [origin] 归属源；用于补齐 host-only 的 domain
   */
  async function writeProfileCookies(setCookieHeaders, origin = siteUrl) {
    if (!ctx || typeof ctx.addCookies !== 'function') return;
    const url = String(origin).replace(/\/$/, '') + '/';
    const now = Date.now();
    const list = [];
    for (const raw of Array.isArray(setCookieHeaders) ? setCookieHeaders : []) {
      const cookie = toPlaywrightCookie(raw, url, now);
      if (cookie) list.push(cookie);
    }
    if (list.length) await ctx.addCookies(list);
  }
  async function userAgent() {
    try { return page && !page.isClosed?.() ? await page.evaluate(() => navigator.userAgent) : null; } catch { return null; }
  }

  function defaultChromiumPath() {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    const candidates = [
      // 1. Edge
      path.join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      localAppData ? path.join(localAppData, 'Microsoft\\Edge\\Application\\msedge.exe') : '',
      // 2. Google Chrome
      path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      localAppData ? path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe') : '',
      // 3. Brave
      path.join(programFiles, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      localAppData ? path.join(localAppData, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe') : '',
      // 4. Chromium / Vivaldi
      path.join(programFiles, 'Chromium\\Application\\chrome.exe'),
      localAppData ? path.join(localAppData, 'Vivaldi\\Application\\vivaldi.exe') : '',
      // macOS
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      // Linux
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/brave-browser',
    ].filter(Boolean);

    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch {}
    }
    return null;
  }
  function defaultEdgePath() {
    return defaultChromiumPath();
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
            // 0.16.3：驱动侧现场读数（适配器看门狗据此区分「网页没回传」与「链路死了」）。
            noteActivity();
            // 0.15.2：「正文真的来了」的独立时刻。它与 lastProgressAt 刻意分开——
            // 思考增量刷新前者、**不**刷新这个。混成一个的话，「一直思考」与
            // 「思考完给出正文」在判据上无法区分，硬上限就永远判不出来。
            active.lastAnswerAt = performance.now();
            active.text += t;
            try { active.onDelta?.(t); } catch {}
          },
          onThink: (t) => {
            if (active.firstThinkAt == null) active.firstThinkAt = performance.now();
            active.lastProgressAt = performance.now();
            noteActivity();
            active.thinking += t;
            try { active.onThink?.(t); } catch {}
          },
          onImage: (img) => {
            if (img) active.images.push(img);
            active.lastProgressAt = performance.now();
            noteActivity();
            // 图片是交付物，与正文同等对待：只出图不出字是合法形态（识图轮），
            // 不能被「只出思维链」的硬上限误判成卡死。
            active.lastAnswerAt = performance.now();
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
   * ## 0.15.2 新增第三条判据：只出思维链的硬上限
   *
   * 上面那条双条件有一个结构性盲区（真机故障：「长时间后只有思维链卡住，harness
   * 端没有任何报错，没有下一步」）：思考阶段网页会把「思考中 / Thought for Ns」
   * 计时文案持续写进同一个助手节点，节点 `innerText.length` 因此一直变长，
   * `lastDomGrowthAt` 被无休止刷新 → **「DOM 停长」永远不成立** → 收束器永不动作。
   * 而看门狗按「最后一个增量」计时，思考增量同样刷新它，也判不出来。于是唯一
   * 兜底是 240s 总超时，报错还是通用 `web turn timed out`。
   *
   * 两条修法都已落地，缺一不可：
   *   ① DOM 采样改量**剥掉计时文案后**的真实回答长度（metrics.answerDomLength），
   *      让「只剩计时器在动」重新等于「DOM 停长」；
   *   ② 再加一条**绝对墙钟**判据 shouldSettleStalledThinking：自最后一次正文/图片
   *      起超过 cfg.answerTimeoutMs 就收束，完全不看 DOM、不看思考。
   *
   * 收尾方式刻意与既有 partial 路径同形（把已有内容当本轮结果交出去），因此
   * 上层的工具协议解析、部分流自愈、空回复判定全部照旧，不新增第二条收尾通路。
   */
  function startWipWatch() {
    if (!active || active.decoderKind === 'dom') return;   // dom 站点本就不靠流收场
    const tick = async () => {
      const a = active;
      if (!a) return;
      // 采样返回**原始 innerText**，剥计时文案在 Node 侧做：注入浏览器的函数里
      // 不能用模块作用域，而且把判据留在 metrics.answerDomLength 才能离线单测。
      let domText = null;
      try {
        domText = await page?.evaluate?.(() => {
          const last = [...document.querySelectorAll('.markdown, [data-message-author-role="assistant"], .ds-markdown')].pop();
          return last ? (last.innerText || '') : '';
        });
      } catch { domText = null; }
      if (active !== a) return;                              // 轮次已结束或被替换
      const domLen = typeof domText === 'string' ? answerDomLength(domText) : null;
      if (typeof domLen === 'number') {
        a.domAvailable = true;
        // 0.16.3：采样成功既算「页面还活着」（noteActivity），也留下最新读数
        // （domReplyChars）。只在**真的读到页面**时刷新：取不到页面是「读不到」，
        // 把它记成一次活动会让看门狗报出「最近驱动活动 0s 前」这种假活的读数。
        noteActivity();
        domReplyChars = domLen;
        if (a.lastDomLen == null || domLen > a.lastDomLen) a.lastDomGrowthAt = performance.now();
        // 记下「页面节点确实有字、但剥掉计时文案后等于没内容」——这是本故障的
        // 现场特征，写进 settled_by 让人一眼认出，而不是笼统的 partial-wip-settled。
        a.domTimerOnly = domLen === 0 && String(domText || '').trim().length > 0;
        a.lastDomLen = domLen;
      } else {
        // 页面取不到（关窗/导航中）：退回「仅流停」判定，并如实标注收束原因。
        a.domAvailable = false;
      }
      const now = performance.now();
      const bodyReady = Boolean(a.text) || Boolean(a.thinking) || (Array.isArray(a.images) && a.images.length > 0);
      if (!bodyReady) { a.wipTimer = setTimeout(tick, WIP_IDLE_MS); return; }
      // 第三条判据优先判定：它不需要 DOM，也不被思考增量推迟。
      const stalled = shouldSettleStalledThinking({ now, lastAnswerAt: a.lastAnswerAt, hardCapMs: cfg.answerTimeoutMs });
      if (!stalled && !shouldSettleWip({
        now,
        lastProgressAt: a.lastProgressAt,
        lastDomGrowthAt: a.lastDomGrowthAt,
        domAvailable: a.domAvailable,
        wipIdleMs: WIP_IDLE_MS,
      })) { a.wipTimer = setTimeout(tick, WIP_IDLE_MS); return; }
      // 已达稳态：网页这一轮事实上结束了，只是没送 FINISHED。按已有正文收束。
      // 收束原因如实区分三种来历，不再一律 partial-wip-settled——「只出思维链」
      // 与「正文写完没送 FINISHED」的下一步完全不同，混成一个词等于没有线索。
      const reason = stalled ? 'thinking-only-settled'
        : a.domAvailable ? (a.domTimerOnly ? 'partial-wip-settled(dom-timer-only)' : 'partial-wip-settled')
        : 'partial-wip-settled(dom-unavailable)';
      const answerChars = String(a.text || '').length;
      warn(`wip steady state — settling turn with ${answerChars} chars answer / `
        + `${String(a.thinking || '').length} chars thinking (${reason})`);
      const result = a.decoder ? a.decoder.finish() : null;
      if (!result) {
        // 捕获链从未建立：没有可信正文，交给既有超时路径报错（不伪造结果）。
        a.wipTimer = setTimeout(tick, WIP_IDLE_MS);
        return;
      }
      const patched = result.complete ? result
        : { ...result, complete: false, partial: true, reason: result.reason || reason };
      a.settled_by = reason;
      noteEndReason(reason);
      // 只出思维链的轮次单独计数并留现场：这是「没有报错、没有下一步」的唯一
      // 事后线索，混进 recoveredTurns 会让「内容保住了」与「内容根本没来」不可分。
      if (stalled) {
        thinkingOnlyTurns += 1;
        lastStalledSettle = {
          at: Date.now(),
          reason,
          thinkingChars: String(a.thinking || '').length,
          answerChars,
          waitedMs: Math.round(now - (Number(a.lastAnswerAt) || now)),
          domTimerOnly: a.domTimerOnly === true,
        };
      }
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
    if (!cfg.executablePath) throw new Error('Chromium-based browser not found — install Edge, Chrome, Brave or set executablePath');
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
    // 注入式页面（**离线护栏专用**，见 cfg.injectedPage）：直接当作已就绪的页，
    // 绝不启动浏览器。生产路径永远不传它（index.js 不构造该字段），
    // 缺省 null 时这一支不进入，行为与旧版本逐字相同。
    if (cfg.injectedPage && page !== cfg.injectedPage) {
      page = cfg.injectedPage;
      ctx = typeof page.context === 'function'
        ? page.context()
        : { on() {}, newPage: async () => page, close: async () => {} };
    }
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
    const init = captureInit(paths, { transport: site.streamTransport || null });
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

  /**
   * 把文本写进 composer——按真实元素形态分派（见 composerKind 的说明）。
   *
   * 为什么必须分块（0.14.5）：真机会话的 turn/end 里留下了直接证据——
   *
   *   locator.fill: Timeout 30000ms exceeded
   *   - locator resolved to <textarea … placeholder="给 DeepSeek 发送消息">
   *   - fill("# 可用本地工具…(+807789)
   *
   * 一次性把 80 万字符交给 fill() 时，Playwright 在网页侧的执行会整段卡住，
   * 30 秒后超时；而**卡住期间没有任何中间态可读**，事后只能看到一个光秃秃的
   * 超时，既不知道写了多少、也不知道元素是否还活着。旧实现唯一的预兆是一句
   * `large prompt: … consider trimming context` 的 warn，用户看不到。
   *
   * 现在：超过阈值就分块写（每块写完回读长度），并设「停滞」判据——
   * 连续两块长度不增长即抛 PROMPT_WRITE_STALLED，把已写长度、总长度、站点与
   * 元素现场一起带出来。失败得更早、且可归因。
   *
   * @returns {{kind:string, wrote:number}} kind=元素形态，wrote=实际写入字符数
   */
  async function fillComposer(locator, message) {
    const kind = await composerKind(locator);
    const text = String(message);
    // 「一次性写还是分块写」由纯函数决定（可断言，见 composerWritePlan 的注释）。
    const plan = composerWritePlan({ length: text.length, chunkChars: cfg.composerChunkChars, kind });
    if (kind === 'field') {
      if (plan.mode === 'single') { await locator.fill(text); return { kind, wrote: text.length }; }
      return { kind, wrote: await writeFieldChunked(locator, text, plan.chunkChars) };
    }
    // contenteditable：fill() 在部分富文本编辑器上不触发框架的 input 事件
    // （tiptap/ProseMirror 靠 beforeinput/input 维护内部文档），因此先聚焦、
    // 清空既有内容，再用键盘级插入——这是与真人输入最接近的路径。
    await locator.click({ timeout: 10_000 }).catch(() => {});
    await locator.focus().catch(() => {});
    try { await page.keyboard.press('Control+A'); await page.keyboard.press('Delete'); } catch { /* 空框 */ }
    if (plan.mode === 'single') { await page.keyboard.insertText(text); return { kind, wrote: text.length }; }
    let wrote = 0;
    let step = { stalled: 0, prevLen: -1, died: false };
    for (let i = 0; i < text.length; i += plan.chunkChars) {
      const slice = text.slice(i, i + plan.chunkChars);
      await page.keyboard.insertText(slice);
      wrote += slice.length;
      // 让出事件循环：富文本编辑器靠 input 事件重建内部文档，连发不喘气
      // 会让它把中间状态丢掉（真机 doubao/kimi 的 insertText 长串同样会卡）。
      await page.waitForTimeout(0);
      step = stallStep(step.prevLen, (await readComposer(locator))?.length ?? null, step.stalled);
      if (step.died) throw await writeStalledError(locator, wrote, text.length, kind);
    }
    return { kind, wrote };
  }

  /**
   * textarea/input 的分块写入。
   *
   * 第一块用 `fill`（它会先清空，语义最干净），后续块用键盘级 `insertText`
   * ——对 textarea 也成立，且不会像 `fill` 那样每次都重建整个值（那正是
   * 超长文本卡死的来源）。每块后回读长度，用于停滞判定。
   */
  async function writeFieldChunked(locator, text, chunkChars) {
    await locator.fill(text.slice(0, chunkChars));
    let wrote = chunkChars;
    let step = { stalled: 0, prevLen: (await readComposer(locator))?.length ?? -1, died: false };
    for (let i = chunkChars; i < text.length; i += chunkChars) {
      const slice = text.slice(i, i + chunkChars);
      // 光标必须在末尾，否则 insertText 会插到开头——先按 End 再插。
      await locator.press('End').catch(() => {});
      await page.keyboard.insertText(slice);
      wrote += slice.length;
      await page.waitForTimeout(0);
      step = stallStep(step.prevLen, (await readComposer(locator))?.length ?? null, step.stalled);
      if (step.died) throw await writeStalledError(locator, wrote, text.length, 'field');
    }
    return wrote;
  }

  /**
   * 构造「写入停滞」错误：把元素现场与进度一起带出去，便于事后归因。
   *
   * 现场取不到（evaluate 抛错）时**不**让错误构造本身失败——那会把
   * PROMPT_WRITE_STALLED 换成一个无意义的 evaluate 报错，丢掉真正的进度信息。
   */
  async function writeStalledError(locator, wrote, total, kind) {
    const scene = await locator.evaluate((el) => ({
      tag: (el.tagName || '').toLowerCase(),
      id: el.id || null,
      placeholder: el.getAttribute?.('placeholder') || null,
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects?.().length),
      disabled: el.disabled === true,
    })).catch(() => null);
    const err = new Error('PROMPT_WRITE_STALLED: 网页输入框写入停滞——已写 ' + wrote + '/' + total
      + ' 字符后长度不再增长（元素 ' + (kind === 'field' ? 'textarea/input' : 'contenteditable')
      + '，现场 ' + JSON.stringify(scene) + '）。这通常是网页端对超长文本的处理卡住，'
      + '请先压缩上下文再重试。');
    err.code = 'PROMPT_WRITE_STALLED';
    err.scene = scene;
    return err;
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
   * 「网页里确实多了一个附件类节点」这个事实。
   *
   * ## 真机 2026-09-17 反证：这张清单在 DeepSeek 上**零命中**（而入口是好的）
   *
   * 同一台机器的 `/__webcode/status` 读到
   * `attachTransport = {fallback:true, code:'ATTACH_NOT_CONFIRMED', total:417276}`
   * ——文件已经 `setInputFiles` 塞进隐藏 input，20s 后下列选择器一个都没命中，
   * 于是 41.7 万字符整段回落 inline 灌进输入框（用户报的「一开头就很长 token
   * 窗口」）。同时 `GET /__webcode/attach-entry` 读到 `available:true`、
   * `inputs:1`、`accept` 含 `.md/.txt/.json/.log`、`multiple:true`——入口与格式
   * 都没问题，坏的只是「确认」这一步。
   *
   * 根因形状：这里猜的是**类名**，而 DeepSeek 的预览节点用构建期哈希类名
   * （`_xxxxxx` 形态，随站点发版变化），任何字面量清单都只可能偶尔命中。
   * 因此 0.16.3 的主证据换成**刚上传的那个文件名出现在页面上**（文件名是我们
   * 自己传给 setInputFiles 的，命中即证明网页真的收到了这个附件，且完全不需要
   * 猜类名，见下方 filenameEvidence）。这张清单**继续保留**：它在别的站点与将来
   * 的 DeepSeek 发版上仍可能先命中，两种证据取先到者。
   *
   * **不新增任何类名字面量**：本机至今没有拿到「DeepSeek 附件已就位」时的 DOM
   * 读数（那正是 `/__webcode/attach-probe` 要产出、而它需要宿主重启才有路由），
   * 凭想象补类名等于把下一个会话的排障方向带偏。 */
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

  /** 候选证据选择器清单（站点声明的排在通用探针之前）。三个调用点共用一份，
   *  否则「探针说有证据、投递说没有」会各写各的清单。 */
  function attachCandidates() {
    const declared = contract.attachPreviewSelector;
    return declared ? [declared, ...ATTACH_PREVIEW_FALLBACK] : ATTACH_PREVIEW_FALLBACK;
  }

  /**
   * 「刚上传的文件名出现在页面上」这条证据——**不猜类名**的确认判据。
   *
   * 为什么它不是「凭想象加的判据」：文件名是调用方自己交给 `setInputFiles` 的
   * （探针用 `webcode-probe.md`，投递用 `webcode-context*.md`），它出现在页面上
   * 只有一种解释——网页收到了这个文件并渲染了它。而类名清单在 DeepSeek 上
   * 真机零命中（见 ATTACH_PREVIEW_FALLBACK 的 2026-09-17 反证）。
   *
   * 两条收紧条件都有可核对的口径，避免把**别处偶然出现的同名文本**当证据：
   *   · 只认**文本长度 ≤ 文件名 + 80 字符**的节点——附件 chip 的量级就是
   *     「文件名 + 几个图标/字数说明」；放宽到整页会把侧栏历史标题一起算进来；
   *   · 取**最深**的命中节点（祖先链上含同一段文本）——否则 200 字符的
   *     domSnippet 会被外层容器的壳占满，看不到文件名本身。
   *
   * @returns {Promise<{tag:string, cls:string, id:string, snippet:string}|null>}
   */
  async function filenameEvidence(name) {
    const target = String(name || '');
    if (!target) return null;
    return page.evaluate(({ NAME, MAX }) => {
      const hit = [...document.querySelectorAll('body *')].filter((el) => {
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'INPUT' || tag === 'TEXTAREA') return false;
        const t = (el.textContent || '').trim();
        return t.includes(NAME) && t.length <= MAX;
      });
      if (!hit.length) return null;
      // 最深命中：没有任何其它命中节点在它里面
      const deep = hit.filter((el) => !hit.some((o) => o !== el && el.contains(o)));
      const node = deep[0] || hit[0];
      return {
        tag: node.tagName.toLowerCase(),
        cls: String(node.getAttribute('class') || '').slice(0, 120),
        id: node.id || null,
        snippet: node.outerHTML.replace(/\s+/g, ' ').trim().slice(0, 200),
      };
    }, { NAME: target, MAX: target.length + 80 }).catch(() => null);
  }

  /** 轮询等待附件在页面上出现。返回命中的选择器（文件名证据返回 `text:<name>`），或 null（超时）。
   *
   * `name` 是**本轮真正上传的文件名**：传了它才会启用文件名证据（见 filenameEvidence）。
   * 不传（图片轮）时行为与 0.16.2 逐字相同——只认类名清单，不动图片轮已确认过的路径。 */
  async function waitForAttachment(timeoutMs = 15_000, { name = null } = {}) {
    const candidates = attachCandidates();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const sel of candidates) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.count() && await loc.isVisible().catch(() => false)) return sel;
        } catch { /* 选择器语法或页面转场：试下一个 */ }
      }
      if (name) {
        const hit = await filenameEvidence(name);
        if (hit) return 'text:' + name;
      }
      if (Date.now() >= deadline) return null;
      await page.waitForTimeout(250);
    }
  }

  /**
   * 上传失败时的**现场**：候选选择器 × 命中数（含可见数）+ 文件名证据命中情况 +
   * 一段 DOM 片段。失败读数必须能回答「是没上传成功，还是页面上有节点而我们没认出来」。
   *
   * 一次 evaluate 取全，不做 N 次往返：失败路径本身已经等了 20s，再逐个选择器
   * 往返会把现场拖到与页面状态不同步（页面转场后读到的是另一个界面）。
   */
  async function attachEvidenceDiag(name) {
    return page.evaluate(({ NAME, sels, inputSel, MAX }) => {
      const pick = (sel) => { try { return [...document.querySelectorAll(sel)]; } catch { return []; } };
      const visible = (el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects?.().length);
      const candidates = (sels || []).map((sel) => {
        const els = pick(sel);
        return { sel, count: els.length, visible: els.filter(visible).length };
      });
      const hits = [...document.querySelectorAll('body *')].filter((el) => {
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'INPUT' || tag === 'TEXTAREA') return false;
        const t = (el.textContent || '').trim();
        return NAME && t.includes(NAME) && t.length <= MAX;
      });
      const deep = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
      const node = deep[0] || hits[0] || null;
      // 兜底现场：把上传入口往上的两级容器抄下来。没有它，失败读数只剩
      // 「一张清单 × 一堆 0」，看不出页面究竟变成了什么样。
      let near = null;
      const input = pick(inputSel)[0] || null;
      let box = input;
      for (let i = 0; i < 2 && box?.parentElement; i += 1) box = box.parentElement;
      if (box) near = box.outerHTML.replace(/\s+/g, ' ').trim().slice(0, MAX);
      return {
        candidates,
        nameHit: node ? {
          tag: node.tagName.toLowerCase(),
          cls: String(node.getAttribute('class') || '').slice(0, 120),
          snippet: node.outerHTML.replace(/\s+/g, ' ').trim().slice(0, MAX),
        } : null,
        domSnippet: node
          ? node.outerHTML.replace(/\s+/g, ' ').trim().slice(0, MAX)
          : near,
      };
    }, { NAME: String(name || ''), sels: attachCandidates(), inputSel: contract.attachSelector || "input[type='file']", MAX: 200 })
      .catch((e) => ({ error: String(e?.message || e).slice(0, 120), candidates: [], nameHit: null, domSnippet: null }));
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

  /**
   * 把一段长文本作为**附件**上传（0.16.2）。
   *
   * **定义位置是契约的一部分（0.16.3 修正）**：本函数必须在 `uploadImages`
   * **完整结束之后**。0.16.2 把它插进了 `uploadImages` 的 `if (!hit) { … }` 内部
   * （闭括号之前），靠函数声明提升仍然能跑，但 `if` 块被提前关掉、只剩两个孤立
   * 闭括号。这种结构下任何一次相邻重构都可能让它真的只在 `catch` 作用域里可见 →
   * 调用点 `ReferenceError` → 被 runTurn 的 catch 吞掉 → **静默回落 inline**，
   * 表现正是用户抱怨的「说做了、其实没做」。改动本区域时**不要**再把它挪进任何分支。
   *
   * 为什么不落临时文件：setInputFiles 直接接受内存载荷（name/mimeType/buffer），
   * uploadImages 对图片就是这么做的。少一个临时目录就少一类权限与清理问题
   * （本机 %TEMP% 受限已经让 3 个测试文件假失败过）。
   *
   * 与 uploadImages 同一条纪律：**看到可见附件证据才放行**。看不到就抛
   * ATTACH_NOT_CONFIRMED，由调用方回落 inline——绝不发一条「说附件在、其实不在」
   * 的消息。
   *
   * `chars` 是**上传内容**的字符数（可能已被 runTurn 尾部截断），不是原始提示词长度。
   */
  async function uploadTextAttachment(text, { timeoutMs = 20_000, name = 'webcode-context.md' } = {}) {
    const fi = page.locator(contract.attachSelector || "input[type='file']").first();
    if (!await fi.count()) {
      const err = new Error('ATTACH_UNAVAILABLE: 页面没有可用的文件上传入口');
      err.code = 'ATTACH_UNAVAILABLE';
      throw err;
    }
    const body = String(text ?? '');
    await fi.setInputFiles([{ name, mimeType: 'text/markdown', buffer: Buffer.from(body, 'utf8') }]);
    const hit = await waitForAttachment(timeoutMs, { name });
    if (!hit) {
      // 失败必须带现场：真机 0.16.3 的那次失败只留下 `ATTACH_NOT_CONFIRMED` 一个码，
      // 事后既看不出「网页压根没收」还是「收了而选择器没认出来」，也就无法判断该
      // 改证据判据还是该改上传方式。现场同时挂到 err.attachDiag 上，由 runTurn
      // 原样写进 attachTransport（进 /__webcode/status，面板可读）。
      const diag = await attachEvidenceDiag(name);
      const err = new Error('ATTACH_NOT_CONFIRMED: 已选择附件 ' + name + '，但 '
        + Math.round(timeoutMs / 1000) + 's 内页面上没有出现附件'
        + (diag?.domSnippet ? ' — 现场 DOM：' + diag.domSnippet : ''));
      err.code = 'ATTACH_NOT_CONFIRMED';
      err.attachDiag = diag;
      throw err;
    }
    return { evidence: hit, chars: body.length, name };
  }

  /**
   * 当前生效的投递形态（`'attach' | 'inline'`）——**每次投递前现读，不取构造期快照**。
   *
   * 为什么必须现读：设置页写的是 webcode **设置命名空间**（`POST /__webcode/settings`
   * → `configManager`），而驱动构造期拿到的是插件 config（cordis.yml 的 config
   * 段）+ DEFAULTS。只把值快照进 cfg 的话，「设置页选了纯文本、实际仍走附件」
   * 会原样出现——本项目已经有过一次同类缺陷（`answerTimeoutMs` 只在 driver 侧
   * 有默认值、index.js 没声明也没透传，于是那个配置项完全够不着，见
   * lib/index.js 的 DEFAULTS 注释）。因此 index.js 两个构造点传的是**读取函数**
   * `getPromptTransport`，这里每次调用它。
   *
   * 非法值一律当 `'attach'`：投递形态只有两个合法取值，写错的配置必须退化成
   * 默认行为，而不是让投递直接失败（同 promptTransportPlan 里 attachEnabled
   * 的取向）。读取函数抛错也一样退化——设置服务不可用不该拦住一轮消息。
   */
  function promptTransportNow() {
    let raw;
    try {
      raw = typeof options.getPromptTransport === 'function' ? options.getPromptTransport() : options.promptTransport;
    } catch { raw = options.promptTransport; }
    return raw === 'inline' ? 'inline' : 'attach';
  }

  /**
   * 清理探针上传的附件（`POST /__webcode/attach-probe` 的收尾）。
   *
   * 为什么探针必须有清理：上传是有副作用的动作——附件留在输入框里，用户下一条
   * 消息就会莫名其妙带上一份 `webcode-probe.md`。因此探针在**上传之前**就必须
   * 想好退路（本函数），并在返回里如实报告 `cleaned`；清理不掉的必须报
   * `cleaned:false` 而不是假装干净。
   *
   * 两条退路，按「不依赖站点选择器」优先：
   *   ① `setInputFiles([])`——Playwright 的「清空已选文件」原语，零站点知识。
   *      但它能否连带清掉网页自己渲染的 chip 取决于站点的 change 处理，
   *      所以**必须回读确认**（`filenameEvidence` 里那个文件名还在不在），
   *      不能把「调用没抛错」当成清理成功。
   *   ② 附件 chip 自己容器内的删除控件。容器边界是**可测量的**：从最深命中节点
   *      向上走，只要容器的文本长度仍 ≤ 文件名 + 200 字符就还在 chip 量级；
   *      一旦越过就停（再往上就是 composer / 页面级容器，在那里点按钮可能点到
   *      发送或导航）。候选控件也必须命中 删除|移除|remove|close|clear|取消|×
   *      这类语义，且排除 `type=submit`。
   *
   * @returns {Promise<{cleaned:boolean, cleanedBy:string, note?:string}>}
   */
  async function cleanupAttachment(name) {
    const fi = page.locator(contract.attachSelector || "input[type='file']").first();
    const gone = async () => !(await filenameEvidence(name));
    try {
      if (await fi.count()) await fi.setInputFiles([]);
    } catch { /* 清空失败照样走下面的回读与 ② */ }
    if (await gone()) return { cleaned: true, cleanedBy: 'input-cleared' };
    const clicked = await page.evaluate(({ NAME, MAX }) => {
      // 附件 chip 的最深命中节点（真机实拍：`<div class="e70accd6">webcode-probe.md</div>`）。
      // 它自己就是 chip 的文本节点，**删除控件不一定在它的祖先里**——所以下面
      // 除了沿祖先链找，还要横向找兄弟（见 `roots`）。
      const hits = [...document.querySelectorAll('body *')].filter((el) => {
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'INPUT' || tag === 'TEXTAREA') return false;
        const t = (el.textContent || '').trim();
        return t.includes(NAME) && t.length <= NAME.length + 80;
      });
      if (!hits.length) return null;
      const deep = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
      const node = deep[0] || hits[0];
      // 候选容器：最深命中节点 + 它的祖先链（文本长度仍在 chip 量级内才继续往上）。
      const roots = [node];
      let box = node;
      for (let i = 0; i < 4 && box.parentElement; i += 1) {
        const p = box.parentElement;
        if ((p.textContent || '').trim().length > NAME.length + MAX) break;
        box = p;
        roots.push(box);
      }
      const RE = /删除|移除|remove|close|clear|取消|×|✕|✖|trash|delete/i;
      const semantic = (el) => {
        if (el.tagName === 'BUTTON' && el.getAttribute('type') === 'submit') return '';
        const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-testid') || el.getAttribute('class') || '';
        return RE.test(label) ? label : '';
      };
      // ① 先按语义标签找（最稳：不依赖位置）。
      for (const root of roots) {
        const ctl = [...root.querySelectorAll('[aria-label],[title],[data-testid],button,[role="button"],svg,i')]
          .find((el) => semantic(el) !== '');
        if (ctl) {
          try { ctl.click(); } catch { /* 试下一条路 */ }
          return 'semantic:' + ctl.tagName.toLowerCase() + ':' + String(semantic(ctl)).slice(0, 60);
        }
      }
      // ② 语义标签全落空时，按**位置**找 chip 容器里的可点控件：
      //    chip 里的删除按钮通常是与文件名同容器、且位于其**右侧**的最后一个
      //    可点元素（`svg` / `button` / `[role=button]` / 带 cursor:pointer 的 div）。
      //    这条路的判据是几何关系，因此必须先确认容器内**只有一个**文件名命中——
      //    多个附件时右边缘那个可能是别的文件的删除键，点错等于删掉别人的附件。
      if (deep.length === 1) {
        for (const root of roots) {
          const cands = [...root.querySelectorAll('button,[role="button"],svg,i,[class*="icon"],[class*="close"],[class*="delete"]')]
            .filter((el) => {
              if (el.tagName === 'BUTTON' && el.getAttribute('type') === 'submit') return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.width <= 48 && r.height <= 48;
            });
          if (!cands.length) continue;
          const nr = node.getBoundingClientRect();
          const right = cands
            .filter((el) => el.getBoundingClientRect().left >= nr.right - 4)
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
          if (!right) continue;
          try { right.click(); } catch { continue; }
          return 'position:right:' + right.tagName.toLowerCase() + ':'
            + String(right.getAttribute('class') || right.getAttribute('aria-label') || '').slice(0, 60);
        }
      }
      return null;
    }, { NAME: String(name || ''), MAX: 200 }).catch(() => null);
    if (!clicked) {
      return { cleaned: false, cleanedBy: 'none', note: '未找到清除入口（只试了 setInputFiles([]) 与附件节点自身容器内的删除控件；多附件时不按位置猜——点错会删掉别人的附件）' };
    }
    await page.waitForTimeout(600);   // 给网页一拍把 chip 从 DOM 里摘掉
    if (await gone()) return { cleaned: true, cleanedBy: 'removed:' + clicked };
    return { cleaned: false, cleanedBy: 'clicked-no-effect:' + clicked, note: '点了清除控件，但文件名仍留在页面上' };
  }

  /**
   * 附件投递**探针**：只上传、**绝不发送**（0.16.3，M5）。
   *
   * 存在的理由：`GET /__webcode/attach-entry` 只能证明「入口在、格式被接受」
   *（真机读数 `available:true`、`accept` 含 `.md/.txt/.json/.log`、`multiple:true`），
   * 它**不能**回答「上传之后网页会不会渲染出可见的附件」。而真机失败读数
   * `attachTransport = {fallback:true, code:'ATTACH_NOT_CONFIRMED', total:417276}`
   * 恰好卡在这一步——没有探针，就只能靠「发一条真消息看模型有没有读到附件」，
   * 那是拿一次真实会话（和一次站点风控）换一个读数。
   *
   * 与 uploadTextAttachment 的分工：那个是**投递路径**（失败要抛错、由调用方
   * 回落 inline）；这个是**读数路径**（失败返回结构化现场，绝不抛错、绝不发送，
   * 并且必须清理）。两者共用同一套证据判据（waitForAttachment 的 name 分支与
   * attachEvidenceDiag），不各写一份——否则会出现「探针说有附件、投递说没有」。
   *
   * 副作用与纪律（写在这里，因为调用方是 HTTP 路由）：会上传一个真实文件；
   * 因此调用前必须确认驱动空闲（busy 中直接拒绝，绝不插进正在跑的一轮），
   * 且清理路径在任何返回分支上都被走到。
   *
   * @param {string} text 探针内容（字符数即返回的 chars）
   * @param {{timeoutMs?:number, name?:string, cleanup?:boolean}} [opts]
   */
  async function probeAttachment(text, { timeoutMs = 20_000, name = 'webcode-probe.md', cleanup = true } = {}) {
    const t0 = Date.now();
    const body = String(text ?? '');
    const base = { siteId, chars: body.length, name, sent: false };
    if (busy || transitioning) {
      return { ...base, ok: false, code: 'DRIVER_BUSY', evidence: null, selector: null, domSnippet: null,
        candidates: [], cleaned: true, cleanedBy: 'nothing-uploaded',
        note: '驱动正在跑一轮——探针绝不插进正在进行的轮次（那会污染真实消息），请稍后重试' };
    }
    if (!page || page.isClosed?.()) {
      // 与 diagnostics()/GET attach-entry 同一取向：**不因为一次只读探测去拉起浏览器**。
      // 探针的价值在于「回答上传后网页长什么样」，页面都没起来时它给不出任何答案。
      return { ...base, ok: false, code: 'ATTACH_UNAVAILABLE', evidence: null, selector: null, domSnippet: null,
        candidates: [], nameHit: null, cleaned: true, cleanedBy: 'nothing-uploaded', ms: Date.now() - t0,
        note: '驱动页面不可用（浏览器未启动或页面已关闭）：**未做任何上传**。先在设置页连上该站点或发过一轮，再探。' };
    }
    const fi = page.locator(contract.attachSelector || "input[type='file']").first();
    // 只在**本驱动的站点页面**上上传：页面被人工导航到别处时（用户在独立窗口里
    // 切到了别的站点/别的页面），往那个页面塞一个文件属于用户看不见的越界副作用。
    // 宁可拒绝并说清原因——探针的整个意义是「读数诚实」。
    try {
      if (new URL(page.url()).origin !== new URL(cfg.site).origin) {
        return { ...base, ok: false, code: 'ATTACH_UNAVAILABLE', reason: 'wrong-origin', evidence: null, selector: null,
          domSnippet: null, candidates: [], nameHit: null, cleaned: true, cleanedBy: 'nothing-uploaded', ms: Date.now() - t0,
          note: '当前页面不在本驱动的站点上（' + page.url().slice(0, 120) + '）：**未做任何上传**' };
      }
    } catch { /* url 不可解析（about:blank 等）：交给下面的入口检查 */ }
    if (!await fi.count()) {
      const diag = await attachEvidenceDiag(name);
      return { ...base, ok: false, code: 'ATTACH_UNAVAILABLE', evidence: null, selector: null,
        domSnippet: diag?.domSnippet ?? null, candidates: diag?.candidates ?? [], nameHit: diag?.nameHit ?? null,
        cleaned: true, cleanedBy: 'nothing-uploaded', ms: Date.now() - t0,
        note: '页面没有可用的文件上传入口：未上传任何文件，因此无需清理' };
    }
    await fi.setInputFiles([{ name, mimeType: 'text/markdown', buffer: Buffer.from(body, 'utf8') }]);
    const hit = await waitForAttachment(timeoutMs, { name });
    // 现场必须在**清理之前**抓：清理成功会把证据节点一起摘掉，之后再抓只剩空 DOM，
    // 这个读数本来就是为了回答「当时页面上到底有什么」。
    const diag = await attachEvidenceDiag(name);
    let cleanupInfo = { cleaned: false, cleanedBy: 'skipped', note: '调用方显式要求不清除（cleanup:false）' };
    if (cleanup) cleanupInfo = await cleanupAttachment(name);
    const result = {
      ...base,
      ok: Boolean(hit),
      code: hit ? null : 'ATTACH_NOT_CONFIRMED',
      evidence: hit,
      selector: hit,                       // 与 task 约定的字段名对齐：命中的选择器 / `text:<name>`
      domSnippet: diag?.domSnippet ?? null,
      candidates: diag?.candidates ?? [],
      nameHit: diag?.nameHit ?? null,
      cleaned: cleanupInfo.cleaned,
      cleanedBy: cleanupInfo.cleanedBy,
      cleanupNote: cleanupInfo.note ?? null,
      ms: Date.now() - t0,
    };
    if (hit) log('attach-probe ok: evidence=' + hit + ' chars=' + body.length + ' cleaned=' + result.cleaned + '(' + result.cleanedBy + ')');
    else warn('attach-probe failed: ' + result.code + ' candidates=' + JSON.stringify(result.candidates));
    attachProbe = { at: Date.now(), ...result };
    return result;
  }

  async function runTurn(message, { navigate, key = null, signal, onDelta, onThink, onImage, model, images, thinkMode } = {}) {
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
        const target = String(navigate);
        // 续聊韧性（0.14.8）：导航回既有会话时，SPA 冷加载偶发拿不到 composer
        //（页面仍在 hydrate / 首屏竞态），旧实现立刻判「会话已不可达」→
        // WEB_SESSION_LOST → 上层把整段首轮提示词重放进一个**新**网页对话。
        // 真机 2026-09-15 实测：`sessionLostCount` 在十分钟内涨到 2，每次都伴随
        // 一次 39 万字符重写 —— 用户看到的就是「每轮把上下文放进新对话」。
        //
        // 会话真被删是少数，瞬时加载失败是多数，所以**先重试一次再下结论**。
        // 重试只针对「没有风控页」的情形：命中风控页时再撞一次只会加重风控
        //（doc/bridge-failure-ledger.md §3 的纪律）。
        for (let attempt = 0; attempt < 2 && !ready; attempt += 1) {
          if (attempt > 0) {
            warn(`resume navigation not ready — retrying once (site=${siteId}, ${nav.reason || 'n/a'})`);
            await sleep(1500);
          }
          try {
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
          if (challenge) break;
        }
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

      /**
       * 「落地即落盘」——本轮导航真的落到某个网页会话上之后**立刻**把身份记下来，
       * **不等这一轮跑完**。
       *
       * 为什么必须提前到这一刻（真机事故 2026-09-17 20:52，DSH 会话
       * `session-063b0a99`）：那一轮首轮导航落地到网页会话 `187fdbbd-…`、
       * 407,064 字符也已经发出去，但流后来失败（WEB_NO_PROGRESS）。旧实现只在
       * `sendTurn` 的成功返回处调 rememberConversation，于是「已经真正建立起来的
       * 那个网页会话」在失败路径上被整体丢掉：槽为空 ⇒ 下一轮
       * `unsupported/no-stored-session` ⇒ 整段重建 + 又开一个新对话。
       * 身份与轮次成败是两件事——**失败的轮次同样产生身份**，这就是本函数存在的
       * 全部理由；把它删掉，那次事故会逐字复现。
       *
       * 只在有 key 时写：`sendPrompt` 是无会话键的无状态轮（OpenAI 前端 / aux），
       * 把那种轮次临时开出来的会话记到 'main' 上，会让之后同 key 的会话轮次误续
       *（续到一个没有前文、也没有工具协议的对话里）。
       *
       * @param {string} phase 本次读取发生在哪一步（写进 navTrace 与日志，便于复核）
       * @returns {string|null} 读到的网页会话 id（没读到则 null）
       */
      const noteLanded = (phase) => {
        if (!key) return null;
        const id = sessionIdFromUrl(page?.url?.() || '');
        if (!id) return null;
        const before = conversationFor(key)?.webSessionId || null;
        if (before === id) return id;
        rememberConversation(key, id);
        pushNavTrace({
          phase: 'landed:' + phase, key: String(key),
          storedBefore: before, landedId: id, pageUrl: safeUrl(page?.url?.() || ''),
        });
        log(`web session slot written at ${phase}: key=${key} id=${id}${before ? ' (was ' + before + ')' : ''}`);
        return id;
      };
      // ① 导航落地这一刻。resume 的目标地址本来就带 id（通常与槽里一致，无事
      //    发生）；fresh 之后地址栏一般还是站点根，由下面 ② 的发送后读取补上。
      noteLanded('nav');

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
      // 新一轮开始：把两段现场读数清空再采（0.16.3）。**必须清**，理由就是这次事故本身：
      // 看门狗当时读到的 `lastEndReason=finished` 其实是**上一轮**的收束原因，被当成了
      // 本轮的线索，于是「网页还在 prefill」被误判成「网页已经正常结束」。同一个陷阱
      // 不能让新字段再踩一次——它们的语义写的就是「本轮」。
      lastActivityAt = null;
      domReplyChars = null;
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
          // 0.15.2 第三条防线（见 metrics.shouldSettleStalledThinking）：最后一次
          // 收到**正文/图片**的时刻，思考增量不刷新它。与上面两个并存，语义不同：
          //   lastProgressAt  任何增量（含思考）→ 「流还活着吗」
          //   lastDomGrowthAt 页面助手节点变长     → 「页面还在写吗」
          //   lastAnswerAt    正文/图片            → 「到底有没有回答」（本条）
          lastAnswerAt: performance.now(),
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
        lastEndReasonAt = Date.now();
        // 0.16.28 自愈降级的第二个签名：附件轮整轮超时、页面无回复文本——真机复验
        // （2026-09-20，62,596 字符附件上传成功 evidence 命中、240s 零回复）证明
        // 「DeepSeek 收得下附件但不读」在整轮超时这一支同样出现，而它不走
        // emptyWebResponseError（那是在收束后的空结果判定），自愈必须在超时点补位。
        // 页面已有 N 字未回传（captureAlive 但 replyChars>0）不算「零回复」：
        // 那是捕获/回传问题，不是附件不被读，降级反而会掩盖真故障。
        const zeroReply = scene && scene.replyChars === 0;
        if (zeroReply && attachTransport?.transport === 'attach' && !attachTransport.fallback
          && markDynamicAttachBlock(siteId, attachTransport.total ?? String(message).length)) {
          warn('attach transport timed out with zero reply (site=' + siteId + ', total='
            + (attachTransport.total ?? String(message).length) + ') — auto-degraded: '
            + 'this site stays inline until the bridge restarts (0.16.28 self-heal, timeout signature)');
        }
        const err = new Error(`web turn timed out after ${cfg.requestTimeoutMs}ms（${detail}）`);
        if (a) a.reject(err); else warn(err.message);
      }, cfg.requestTimeoutMs);
      if (active) active.timer = timer;

      done.catch(() => {});
      if (String(message).length > 400_000) {
        warn(`large prompt:${String(message).length} chars — the web composer may become slow; consider trimming context`);
      }
      // 0.16.2：超长提示词改走**附件**投递；任何一步失败都回落 inline。
      // 0.16.3：默认阈值 60_000（见 lib/index.js 的 DEFAULTS 注释：真机事故那一轮
      // 发进网页的是 127,888 字符纯文本），失败原因与现场一律落进 attachTransport
      // （进 status()），因此「有没有真的走附件」在 /__webcode/status 上可核对；
      // 设置面的「投递形态」开关（inline = 永远纯文本）由 promptTransportNow 现读。
      if (!attachEvidence) {
        const plan = promptTransportPlan({
          chars: String(message).length,
          inlineLimit: cfg.attachInlineLimitChars,
          attachEnabled: cfg.attachInlineLimitChars > 0,
          attachSupported: true,
          // 站点级禁令（0.16.7 静态表 + 0.16.28 运行期自愈）：DeepSeek 收得下附件但
          // 读不到它（真机实测零回复），因此该站点永远走输入框，与阈值无关。
          // 见 ATTACH_FORBIDDEN_SITES 与 DYNAMIC_ATTACH_BLOCKS。
          attachForbidden: attachForbiddenFor(siteId),
          // 设置面的「投递形态」开关（0.16.3）：'inline' = 用户显式要求纯文本，
          // 逐字回到旧行为；其余一律 'attach'（是否真的走附件仍由上面的阈值决定）。
          // 现读而不是取构造函数快照，理由见 promptTransportNow。
          transport: promptTransportNow(),
          // cfg.attachMaxChars 由 index.js 透传（task-1 / lib/index.js）。
          // 未配置时这里是 undefined，**必须显式转成 null**再传：undefined 在
          // promptTransportPlan 里是「取默认 1_500_000」，而缺配置时的正确行为是
          // 「不设上限」——缺配置只退化成 0.16.2 的旧行为，绝不因此砍掉消息。
          maxChars: cfg.attachMaxChars === undefined ? null : cfg.attachMaxChars,
        });
        if (plan.mode === 'attach') {
          try {
            let attachText = String(message);
            let attachName = 'webcode-context.md';
            let omitted = 0;
            if (plan.truncate) {
              // 尾部保留：提示词的开头是长期不变的工具教学与历史 transcript，
              // **尾部才是当下要执行的那一步**（失败会话的 step5 就在最后一次增量里）。
              // 丢掉头部必须留痕：少一句「已省略前 N 字符」，模型会把「没看到」当成
              // 「不存在」，而用户也看不出这一轮其实投了半截——那就是静默丢上下文。
              // 头部声明本身占掉的字符要算进 omitted，读者按 omitted 复算时才对得上。
              omitted = plan.total - plan.payloadChars;
              const head = '【本文件已省略前 ' + omitted + ' 字符】'
                + '为控制附件长度，以下内容从原文第 ' + (omitted + 1) + ' 字符起保留（原文共 '
                + plan.total + ' 字符）；被省略的是更早的会话历史与教学文本。\n\n';
              attachText = head + attachText.slice(-plan.payloadChars);
              attachName = 'webcode-context-tail' + plan.payloadChars + 'of' + plan.total + '.md';
            }
            const info = await uploadTextAttachment(attachText, { name: attachName });
            attachEvidence = { attached: 1, evidence: info.evidence };
            attachTransport = {
              at: Date.now(), name: info.name, chars: plan.total, payloadChars: plan.payloadChars,
              truncated: plan.truncate, evidence: info.evidence, total: plan.total,
              transport: 'attach', reason: plan.reason, selector: info.evidence,
            };
            onThink?.('提示词以附件投递：' + info.name + '（原始 ' + plan.total + ' 字符，实际上传 '
              + plan.payloadChars + ' 字符' + (plan.truncate ? '，已省略前 ' + omitted + ' 字符' : '')
              + '，证据 ' + info.evidence + '）');
            log('prompt sent as attachment: name=' + info.name + ' total=' + plan.total
              + ' payloadChars=' + plan.payloadChars + ' truncated=' + plan.truncate + ' evidence=' + info.evidence);
            message = '提示词正文已作为附件 ' + info.name + ' 上传（原始 ' + plan.total + ' 字符，实际上传 '
              + plan.payloadChars + ' 字符' + (plan.truncate ? '，开头已省略的 ' + omitted + ' 字符不再重复列出' : '')
              + '）。请先读取该附件全文，再按其中的要求继续任务。';
          } catch (err) {
            // 回落 inline 的决策也要可核对——只 warn 到控制台等于没有读数。
            // 0.16.3：`diag` 是失败现场（候选选择器 × 命中数 × DOM 片段，截断 200），
            // 由 uploadTextAttachment 挂在 err.attachDiag 上。没有它，「附件没确认」
            // 这一条在面板上只是一句话，用户与下一个会话都无法判断下一步改什么。
            attachTransport = { at: Date.now(), fallback: true, code: err?.code || null, total: String(message).length,
              transport: 'attach', reason: 'attach-failed', diag: err?.attachDiag || null };
            warn('prompt attachment transport failed, falling back to inline: ' + (err?.code || err?.message));
          }
        } else if (plan.reason === 'transport-inline') {
          // 用户在设置面显式选了「纯文本」：这也要落读数。否则面板上「当前生效值」
          // 与「最近一次实际投递结果」会互相矛盾（选了纯文本，却仍显示上一轮的
          // 附件成功记录），而这一整块存在的意义就是「不许只留一行 warn」。
          // code 用 TRANSPORT_INLINE 而不是错误码：这不是故障，是用户的选择。
          attachTransport = { at: Date.now(), fallback: true, code: 'TRANSPORT_INLINE', total: String(message).length,
            transport: 'inline', reason: plan.reason };
          log('prompt transport forced inline by settings (promptTransport=inline), chars=' + plan.total);
        } else if (plan.reason === 'site-no-attach') {
          // 0.16.9：站点禁令生效时也**必须落读数**。0.16.7 加了 ATTACH_FORBIDDEN_SITES
          // 却漏了这里，于是 DeepSeek 上「禁令已生效」在界面上完全看不出来：读数停在
          // 上一轮的旧值，面板反而还在承诺「超 60000 字符改走附件」。用户没法核对
          // 自己的修复到底生效没有——这正是本仓库反复记下的那条纪律：
          // 「只 warn 到控制台等于没有读数」。
          // 与 TRANSPORT_INLINE 同型：这是站点事实，不是故障，所以用 code 而不是 error。
          attachTransport = { at: Date.now(), fallback: true, code: 'SITE_NO_ATTACH', total: String(message).length,
            transport: 'inline', reason: plan.reason, siteId };
          log('prompt transport forced inline by site policy (ATTACH_FORBIDDEN_SITES), site=' + siteId
            + ' chars=' + plan.total);
        }
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
        // accepted/total 供 executor 的自动压缩重试取数（0.16.11）：真机 0a62dbb8
        // 整轮差 11 个字符就作废——这种轮次必须能按已接受长度自动压缩重试一次。
        err.accepted = echoed.length;
        err.total = String(message).length;
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
      // ② 发送之后：**新会话的地址是网页收下消息那一刻才被 SPA 写进地址栏的**
      //   （DeepSeek：`/` → `/a/chat/s/<id>`，history.replaceState），所以这一刻
      //    读一次往往就拿到了——这正是 2026-09-17 那次失败轮次之前必须落盘的时机。
      //    读不到时用一个**不阻塞本轮**的短轮询兜底（≤3s；轮次一结束立即自停，
      //    不留定时器），而不是退回「等 runTurn 成功」。12 × 250ms 的依据：真机
      //    上地址改写发生在发送成功后几百毫秒内，3s 已是宽裕上界。
      if (key) {
        // 轮询只属于**这一轮**：绑定到本轮那个 active 对象上，换轮/收尾即停。
        // 只看 `!active` 不够——两轮之间若在 250ms 内接上（sendGapMs=0 时可能），
        // 上一轮的残余轮询会读到**下一轮**落地出来的会话 id，并把它写进本轮的 key
        // （两个 key 各自的槽被写串，比不写更坏）。
        const ownTurn = active;
        let landedTries = 0;
        const waitLanded = () => {
          if (active !== ownTurn) return;              // 本轮已结束（或已换轮）：收工
          if (noteLanded('after-submit')) return;      // 已读到 → 已落盘，收工
          if (++landedTries >= 12) return;             // 3s 到点
          setTimeout(waitLanded, 250);
        };
        waitLanded();
      }

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
      // 0.16.11（#26）：只看 text 会把「只有思考」的轮次整轮作废（真机 d5fd2e11
      // turn 8：reasoning 块 + finish、正文/调用为零 → UNKNOWN 硬失败，任务断链）。
      // 思考-only 由适配器的 thinkingOnlyNotice 路径交回提示继续任务；这里只拦全空。
      const emptyErr = emptyWebResponseError(result, { lastEndReason, rawHead: lastFinished?.rawHead });
      if (emptyErr) {
        // 0.16.28 自愈降级：这一轮真的走了附件且全空——与 0.16.7 真机签名（传得上、
        // 零回复）同源。按站点记住，之后该站点回落 inline 直到桥重启；不记的话，
        // 「站点悄悄坏了附件」会表现为每轮白传一次附件 + 空回复 + 上层 reset 槽 +
        // 整段重建的死循环（0.16.7 事故链的自动版）。
        if (attachTransport?.transport === 'attach' && !attachTransport.fallback
          && markDynamicAttachBlock(siteId, attachTransport.total ?? String(message).length)) {
          warn('attach transport produced a zero-reply round (site=' + siteId + ', total='
            + (attachTransport.total ?? String(message).length) + ') — auto-degraded: '
            + 'this site stays inline until the bridge restarts (0.16.28 self-heal)');
        }
        throw emptyErr;
      }
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
      noteEndReason(lastFinished?.settled_by || (site.decoder === 'dom' ? 'dom-capture' : 'finished'));
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
    // 这个 key 就是「当前」会话槽（`status().sessionSlot` 报它）。
    lastSessionKey = String(key || 'main');
    let existing = conversationFor(key);
    // 自愈补槽（B）：槽为空、但页面**此刻就停在**某个网页会话上。
    //
    // 那正是上一轮真正落地的那个会话——本轮修复前「失败轮次不落盘」的历史槽就是
    // 这样坏掉的（2026-09-17 20:52 事故的后效）。不补这一刀，conversationNav 会回
    // `unsupported/no-stored-session`，上层就把整段首轮（真机 407,064 字符）重放进
    // 一个**新**对话——即用户报的「一直新开对话」。
    //
    // 两个刻意收窄的条件：
    //   • 只在 fresh=false 时补。调用方明确要求「开新会话」时页面停在哪里都无所谓，
    //     把旧 id 记进槽反而会让下一轮续到一个缺少本轮内容的旧对话上。
    //   • 跳过 deadSessions 里刚被判「不可达」的 id，避免「导航失败 → 丢槽 →
    //     下一轮又从地址栏把同一个死会话补回来」的循环。
    if (!existing?.webSessionId && !fresh) {
      const fromUrl = sessionIdFromUrl(page?.url?.() || '');
      if (fromUrl && !deadSessions.has(fromUrl)) {
        rememberConversation(key, fromUrl, 'url-heal');
        existing = conversationFor(key);
        warn(`web session slot healed from page URL (site=${siteId}, key=${key}, id=${fromUrl}) — 槽为空但页面就停在该会话上`);
        pushNavTrace({
          phase: 'heal', key: String(key || 'main'),
          healedId: fromUrl, pageUrl: safeUrl(page?.url?.() || ''),
        });
      }
    }
    // 三态导航（C-2）：'fresh' 开新会话、'resume' 导航回既有会话、
    // 'unsupported' 明确报错。**没有第四态**——旧实现在这里默默开新会话并把增量
    // 发进去，网页模型在毫无前文的情况下接着答，是「跑着跑着变傻」的根因。
    const nav = conversationNav({
      siteId,
      origin: new URL(cfg.site).origin,
      fresh,
      sessionId: existing?.webSessionId,
    });
    pushNavTrace({
      phase: 'nav', key: String(key || 'main'), requestedFresh: fresh,
      state: nav.state, reason: nav.reason || null,
      storedId: existing?.webSessionId || null,
      pageUrl: safeUrl(page?.url?.() || ''),
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
      // key 一并交给 runTurn：「落地即落盘」的写点在里面（见 runTurn 的
      // noteLanded）——身份必须在导航落地那一刻就记下，而不是等这里成功返回。
      result = await runTurn(message, { key, navigate, signal, onDelta, onThink, onImage, model, images, thinkMode });
    } catch (err) {
      // 会话槽里存的是一个已经死掉的网页会话：立刻丢掉，别让下一轮再撞一次。
      // 上层收到 WEB_SESSION_LOST 后作废游标并以整段首轮提示词重开。
      // 同时把该 id 标成不可达：下一个轮次的自愈补槽必须跳开它（见 deadSessions）。
      if (err?.code === 'WEB_SESSION_LOST') {
        markSessionDead(existing?.webSessionId);
        forgetConversation(key);
      }
      throw err;
    }
    // 身份优先来自地址、其次来自流（C-1）。两者都拿不到时才丢掉会话槽——
    // 而这种情况在 GLM/Z.ai 上曾经是**恒态**（旧实现只认 DeepSeek 的地址形状）。
    //
    // 这里是**确认写**，不是唯一写点：落地那一刻已经写过一次（runTurn 的
    // noteLanded），所以即使本轮抛错，槽里也留着真实落地过的会话——那次事故
    //（2026-09-17）就是因为只有这一处写点才把槽丢空的。删掉上面那处、只留这里，
    // 等于把事故原样恢复。
    const storedBefore = existing?.webSessionId || null;
    if (storedBefore && result.sessionId && storedBefore !== result.sessionId) conversationReplacedCount += 1;
    pushNavTrace({
      phase: 'done', key: String(key || 'main'),
      navigate: navigate === 'fresh' ? 'fresh' : 'resume',
      storedBefore,
      landedId: result.sessionId || null,
      pageUrl: safeUrl(page?.url?.() || ''),
      replaced: Boolean(storedBefore && result.sessionId && storedBefore !== result.sessionId),
      messageChars: String(message || '').length,
    });
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
    // 附件入口的存在性读数（0.16.3）——**只读，不上传任何东西**。
    //
    // 为什么需要它：超长提示词改走附件投递（`uploadTextAttachment`）之后，必须能
    // 当场回答一个问题——「这个站点的页面上到底有没有可用的上传入口」。没有这个
    // 读数的话，「附件投递没生效」与「网页根本没有上传入口」在事后完全不可分：
    // 两条路径都只是回落 inline，日志里都只有一行 warn。
    //
    // 判据与 `uploadImages` / `uploadTextAttachment` 用的是**同一个选择器来源**
    // （契约的 attachSelector + 站点 attachPreview）。刻意不复制一份选择器清单：
    // 读数与真实投递路径一旦各写一份，迟早出现「探针说有入口、投递说没有」这种
    // 自相矛盾的现场。
    const attachEntry = await page.evaluate(({ inputSel, previewSels }) => {
      const pick = (sel) => {
        try { return [...document.querySelectorAll(sel)]; } catch { return []; }
      };
      const inputs = pick(inputSel);
      const first = inputs[0] || null;
      const hitPreviews = [];
      for (const sel of previewSels || []) {
        const n = pick(sel).length;
        if (n) hitPreviews.push({ sel, count: n });
      }
      return {
        inputs: inputs.length,
        inputSel,
        accept: first ? (first.getAttribute('accept') || '') : null,
        multiple: first ? first.hasAttribute('multiple') : null,
        disabled: first ? Boolean(first.disabled) : null,
        // 预览节点是「附件真的进了网页」的可见证据（见 waitForAttachment）。
        // 页面此刻可能本来就带着历史附件，所以它只是**参考**，不是本轮投递的证明。
        previewHits: hitPreviews,
      };
    }, {
      inputSel: contract.attachSelector || "input[type='file']",
      previewSels: [...(contract.attachPreviewSelector ? [contract.attachPreviewSelector] : []), ...ATTACH_PREVIEW_FALLBACK],
    }).catch(() => null);
    return {
      urlPath: new URL(page.url()).pathname,
      attachEntry,
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

  // sessionSlot 与 status().sessionSlot 同源（sessionSlotFor）：控制面
  //（`GET/POST /__webcode/session-slot`）与面板都要能按 key 直接问一次，
  // 而不是只能读「最近一个 key」的 status 投影。省略 key = 最近一次 sendTurn 的 key。
  return { sendPrompt, sendTurn, resetConversation, conversationFor, sessionSlot: sessionSlotFor, connect, interact, openLogin, openWindow, closeWindow, importStorageFromProfile, status, close, diagnostics, getToken, profileCookies, writeProfileCookies, userAgent, probeAttachment, get page() { return page; }, webApi, listSessions, fetchHistory, screenshotBase64, setImageLimitsProvider };
}

function abortError() {
  const err = new Error('webcode driver: aborted');
  err.name = 'AbortError';
  return err;
}
