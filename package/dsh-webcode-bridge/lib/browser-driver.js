// browser-driver.js — 内置浏览器自动化（无需扩展）。
//
// 用 **playwright 自带 Chromium 优先、系统浏览器兜底**（playwright-core +
// executablePath）以独立持久 profile 驱动内容服务网页：首次 headed 登录一次，
// 之后 headless——填输入框、自动发送、通过 init 脚本捕获站点自身的 SSE 流并吐出增量。
//
// 「自带优先」是 0.18.0 的改动：在此之前只认系统 Edge/Chrome/Brave，于是
// ① 没装浏览器的机器直接不可用，而 playwright-core 自带的 Chromium 本来就在；
// ② 登录态长期与用户日常浏览器混淆（两套 profile 互不相通）。自带 Chromium 让
// 桥的 profile 完全自持，兑现「下载本插件即可用全部功能」。选路逻辑见 bundledChromiumPath。
//
// 多站点：站点契约（输入框/按钮/捕获路径/解码器）来自 lib/contract.js；
// 解码器实例从 globalThis.WebCodeStreamDecoders 按站点 decoder 字段选用；
// 没有稳定网络流的站点（decoder:'dom'，如 Gemini）用页面终态抓取兜底。
//
// 思考链与图片：页面捕获 → decoder onThink/onImage → active → runTurn 返回
// {text, thinking, images}——修复“没有思考链条”“有图说没图”。

import { chromium } from 'playwright-core';
import { findSystemChromium, resolveBrowserExecutable, isBundledChromiumPath, installBundledChromium } from './browser-runtime.js';
import { toPlaywrightCookie } from './cookies.js';
import { getSite, getContract, resolveWebModel, conversationNav, conversationIdFromUrl, conversationStay } from './contract.js';
import { DEFAULT_SLOT, normalizeSlot } from './accounts.js';
import { selectWebModel, pickerUsable } from './model-picker.js';
import { deriveLastRate, shouldSettleWip, shouldSettleStalledThinking, answerDomLength, cleanAnswerDomText, shouldRescueStalledCapture } from './metrics.js';
import { createDeliveryTrace, compareStages } from './delivery-trace.js';
import { emptyWebResponseError } from './zero-progress.js';
import { readIdentityCache, writeIdentityCache } from './account-cache.js';
// 「昵称/头像候选」的页面侧扫描：**只在显式 debug 时**使用（见 readAccountIdentity）。
// 与离线探针脚本共用同一份实现——两处各写一份必然漂移（见该模块文件头）。
import { ACCOUNT_CANDIDATE_PROBE } from './account-candidates.js';
import { applyEffort } from './think-effort.js';
// 错误码真源：本文件是抛点最多的一个（20 处）。**不要**再手写 `err.code = 'X'`
// ——那样不带 `failure` 快照，码会在 harness 边界被归一化成 `UNKNOWN`
//（实测 137/137；见 lib/error-codes.js 文件头与
// doc/research/2026-10-02-dsh-official-error-and-repair.md §6）。
import { withWebcodeCode } from './error-codes.js';
// 0.19.18 用户准则「同一账号不能同时桥接运行」：账号级互斥锁（见 lib/bridge-lock.js）。
import { acquireBridgeLock, releaseBridgeLock, describeBridgeLockHolder } from './bridge-lock.js';
// 只用 ATTACH_PICK_SRC：判定主体注入浏览器执行（见 pageAttachEvidence）。
// 不 import pickAttachEvidence 本身——那是给单测直接驱动用的，在这里 import 会成死导入
// （本仓库对死导入有过明确处置：0.19.0 删过 transportNoteFor）。
import { ATTACH_PICK_SRC } from './attach-scope.js';
// 人机验证「页面自己说了什么」的**词表唯一真源**（纯函数 + 供页面侧重建的模式源码）。
// 为什么不再内联在 page.evaluate 里：内联的词表不可离线验证，且导航期/发送后/超时点
// 三处各写一份必然漂移——#63（doubao 图片选择式验证）正是「导航期认不出 + 发送后不采样」
// 两个缺口叠出来的。词表是**站点无关的自然语言事实**；「哪个选择器属于哪个站点」仍是
// 站点知识，继续收口在 providers.js。
import { CHALLENGE_PATTERN_SOURCES, looksLikeChallengeText } from './challenge-heuristics.js';
// 「逐 frame 扫验证」的**编排层**（纯函数）：遍历、命中即停、probe 汇总、frameError 如实记。
// 抽出来是为了**可离线驱动**——源码级护栏只能证明「字符串在场」（见 #75 的教训）。
import { scanFramesForChallenge } from './captcha-gate-scan.js';
import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 0.19.18 账号级互斥（用户准则「同一账号不能同时桥接运行」）：本进程的启动时刻。
// 参与 bridge-lock 的「这把锁是不是我的」判定。刻意用**进程**启动时刻而不是
// 驱动创建时刻：同一进程里同一账号只会有一个驱动实例，用创建时刻会让「进程内
// 重建驱动」把前一个实例的锁误判成别人的而拒绝自己。
const PROCESS_STARTED_AT = Date.now();

/**
 * Node 侧的等待原语（0.19.33）。
 *
 * 存在的理由是一次真机缺陷：`runTurn` 的续聊重试分支里写了 `await sleep(1500)`，
 * 而 `sleep` 只在本文件的 `DOM_CAPTURE` **注入模板串**里定义过（那是喂给浏览器
 * `page.evaluate` 执行的代码，与 Node 模块作用域毫无关系）。于是那一行必然抛
 * `ReferenceError: sleep is not defined`，被 `runTurn` 的 catch 当成普通失败 ——
 * 用户看到的是「这一轮模型整个没回复」，而不是「重试了一次仍然失败」。
 *
 * 这与同文件记录的 `nav is not defined` 是**同型**缺陷（跨作用域引用），区别只是
 * 这次被引用的名字恰好来自模板串而不是另一个函数。`test/driver-scope.test.mjs`
 * 是本缺陷的常驻护栏；它对模板串的建模失真也已一并修掉（见该文件头注）。
 *
 * 为什么叫 `delay` 而不是 `sleep`：模块里不能再出现 `sleep` 这个名字，否则
 * 护栏的回归钉（「`runTurn` 体内不得引用 `sleep`」）与「Node 侧有一个同名 helper」
 * 会互相打架，读代码的人也无从一眼分辨哪个是浏览器的、哪个是 Node 的。
 */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

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

/**
 * 助手回复节点的采样选择器（WIP 巡检与超时现场共用一份）。
 *
 * ## 为什么必须是唯一一份
 *
 * 0.19.16 之前这两处各写一份**逐字相同**的字面量（原先还有第三处）。三份并存的
 * 代价不是冗余而是**漂移**：修一处、忘两处，于是「判据用的节点」与「兜底交出去的
 * 节点」不是同一个，读数自相矛盾且看不出来。契约层（providers.js 的 answerSelector）
 * 一旦给出站点专属选择器，这里就是它唯一的消费者。
 *
 * ## 0.19.19：从「唯一一份」升级为「兜底那一份」
 *
 * 上面那句承诺（「契约层一旦给出站点专属选择器，这里就是它唯一的消费者」）
 * 在 0.19.19 兑现：`createBrowserDriver` 现在按 `contract.answerSelector ??
 * 本串` 求值一次，得出 `answerSelector` 供**两处**消费点共用——WIP 巡检采样
 * 与超时现场（两处 `page.evaluate`，见下方各自的长注释）。
 * 本串因此降级为**未声明站点**的兜底——这是纯增量：没写 answerSelector 的
 * 站点走到的仍是逐字相同的那一串。
 *
 * ## ⚠️ 勘误：0.19.19 这里一度写成「**三**处消费点共用」（0.19.23 修正）
 *
 * 那是错的，实际只有两处。第三处 `DOM_CAPTURE`（decoder:'dom' 站点的抄全文兜底）
 * 是**另一张表**——它多出 `.response-container` 与 `main`，服务的是「等回答区
 * 稳定后抄 innerText」，不是 WIP 采样，因此**不消费** `answerSelector`。
 *
 * 为什么留这句勘误而不直接删干净：本仓库反复记过「注释与实现不符」（审计 §六-4
 * 记过同型的 `answerSelector` 注释漂移，而那条正是催生本字段的原因）。
 * 一条错误的「三处」会让下一个读者去 `DOM_CAPTURE` 里找接线、找不到、然后
 * 怀疑接线断了——**错误的注释比没有注释更贵**，所以勘误本身要留下。
 *
 * 写死它服务全部 10 个站点曾是审计 C1 记的耦合点；现在站点差异有了声明位，
 * 「改一个站点不影响别人」在**这一项**上成立。
 *
 * ## 真机事实（2026-09-26）
 *
 * chatglm.cn 对这份 DeepSeek 专用串**一个都不命中**。⚠️ 但要注意取证条件：
 * 当时那批 count 读数是在**阿里云滑块页**上采的（裸 playwright 深链导航被拦，
 * 页面 title 变成「滑动验证页面」），因此它**不能**用来判定「选择器对 GLM 瞎」——
 * 见 doc/session-2026-09-26-requirements-and-progress.md §4.3 的诚实修正。
 * 结论方向不变（串里确实没有任何 GLM 类名），但「命中/不命中」尚待有效读数。
 *
 * 因此调用方**不能**把「采样到空串」当成「页面可采样」——必须由页面回报
 * found，见 startWipWatch 里的三态处理（metrics.shouldSettleWip 的 domFound）。
 */
const ANSWER_SELECTOR = '.markdown, [data-message-author-role="assistant"], .ds-markdown';

/**
 * 助手节点选择器的**解析规则**（纯函数）：站点声明优先，缺省回落到上面那份兜底串。
 *
 * ## 为什么把它抽成具名导出（0.19.50）
 *
 * 规则本身只有一行（`声明 || 兜底`），但它是**契约层与驱动层之间唯一的那条缝**，
 * 而这条缝在 0.19.16 出过事故：同一串字面量在三个地方各写一份，「修一处、忘两处」，
 * 于是「判据用的节点」与「兜底交出去的节点」不是同一个，读数自相矛盾且看不出来。
 *
 * 抽出来的直接收益：**这条规则可以被护栏钉住**（`test/answer-selector.test.mjs`），
 * 而在此之前它只活在一个内联表达式里——`createBrowserDriver` 需要浏览器才能跑，
 * 因此那行 `||` 谁都可以悄悄写反，没有任何单测会发现。
 *
 * ## 契约（三条，都被护栏钉住）
 *
 * 1. 站点在 `providers.js` 声明了 `answerSelector` ⇒ 用它（声明优先）；
 * 2. 站点没声明 ⇒ 逐字返回兜底串（**未声明站点零位移**，这是 0.19.19 的承诺）；
 * 3. 兜底串**只服务 DeepSeek 形状**，因此新增站点若形状不同，正确做法是去
 *    `providers.js` 声明，**不是**改这里——改这里等于让一个站点的修复影响另外九个。
 *
 * ⚠ 未声明站点上的形状错配是**已知缺口**，不是本函数的 bug：按本仓库纪律，
 * **没有真机读数就不声明选择器**（同 `think-effort.js`），因此其余站点的
 * `answerSelector` 只能等读数，不能靠猜。见 `doc/long-term-issues.md`。
 *
 * @param {string} siteId 站点 id（如 `'deepseek'` / `'glm'`）
 * @returns {string} 该站点实际使用的助手节点选择器
 */
export function answerSelectorFor(siteId) {
  const contract = getContract(siteId);
  return (contract && contract.answerSelector) || ANSWER_SELECTOR;
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
 * 页面侧：把 **contenteditable 编辑器**的内容读成「与写入文本可比」的字符串。
 *
 * ## 为什么不直接用浏览器内建读数（真机实证，2026-10-14）
 *
 * 同一个输入框、同一段写入文本，三个读数各不相同（doubao/tiptap，只写不发送）：
 *
 * | 写入 | `innerText` | `textContent` | 本函数 |
 * | --- | --- | --- | --- |
 * | `a\nb`（3） | `a\n\nb`（4） | `ab`（2） | `a\nb`（3）✓ |
 * | `甲\n\n乙`（4） | `甲\n\n\n\n\n乙`（7） | `甲乙`（2） | `甲\n\n乙`（4）✓ |
 *
 * 根因：tiptap/ProseMirror 把**每个换行渲染成一个块级 `<p>`**，空行渲染成
 * `<p class="is-empty"><br></p>`：
 *   · `innerText` 在**块与块之间**补 `\n\n`（块间距 + 段间距）⇒ 换行数翻倍；
 *   · `textContent` 不补任何块间分隔 ⇒ 换行被吞掉。
 * ⇒ 两者都**不可**作为「网页收到了什么」的判据；用它俩都会得出
 *   `content-mismatch` ⇒ 每轮含换行的提示词被 `PROMPT_TRUNCATED` 拦住。
 *
 * ## 判据（v4，真机 7/7 逐字精确；doubao 与 kimi 两个编辑器都验过）
 *
 *   ① 有块级子节点时：**按顶层子节点切分**，每段取其「行内文本」，再用**单个 `\n`** 连接；
 *      裸文本节点也算一段（编辑器可能把文本直接挂在根上）。
 *   ② 行内文本递归拼接；行内 `<br>` 记一个 `\n`（那是用户按的硬换行）。
 *   ③ **只含换行的段视为空串**：空块里的 `<br>` 是 ProseMirror 的**占位断行**，
 *      不是用户写的换行（把 `甲\n\n乙` 的中间空块当 `'\n'` 会多出一个换行）。
 *   ④ 去掉**首尾**空段（编辑器常在首尾留一个空 `<p>`），**中间空段保留**（那是真空行）。
 *
 * ⚠ 本函数是**纯函数**、且会被 `page.evaluate` 序列化后单独执行：
 *   **不得引用模块作用域**（0.19.48 真机 `ReferenceError` 的教训）。
 *
 * ⚠ 它**只**服务「回读校验」这一个用途（与写入内容比等价性）。**不要**拿它当
 *   「网页上显示了什么」的通用读数——那该用 `innerText`（块间距对人眼是对的）。
 *
 * @param {Element} el 编辑器根节点
 * @returns {string} 与写入文本可直接比较的字符串
 */
export const EDITOR_BLOCK_TEXT = (el) => {
  const BLOCK = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TR', 'SECTION', 'ARTICLE']);
  /** 行内文本：递归拼接；行内 `<br>` 记一个 `\n`。 */
  const inlineText = (n) => {
    let s = '';
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { s += c.nodeValue; continue; }
      if (c.nodeType !== 1) continue;
      if (c.tagName === 'BR') { s += '\n'; continue; }
      s += inlineText(c);
    }
    return s;
  };
  const tops = [...el.childNodes].filter((c) => c.nodeType === 1 && BLOCK.has(c.tagName));
  // 没有块级子节点：整段按行内读（普通 contenteditable / 已扁平化的编辑器）
  if (!tops.length) return inlineText(el);
  const lines = [...el.childNodes].map((c) => {
    if (c.nodeType === 3) return c.nodeValue;
    if (c.nodeType !== 1) return '';
    const seg = inlineText(c);
    // ③ 只含换行 ⇒ 空串（占位 <br> 不贡献内容）
    return /^\n*$/.test(seg) ? '' : seg;
  });
  // ④ 去首尾空段、留中间空段
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
};

/**
 * 回读校验（**纯函数**，便于离线断言）：这一次写入的正文是否**内容等价**。
 *
 * ## 为什么不能比长度（0.19.71；long-term-issues #48 的真根因）
 *
 * 旧判据是 `echoed.length < sent.length - 8`。它在换行口径不同的情况下**本就不可比**：
 * 浏览器按 HTML 规范把 `textarea.value` 里的 `\r\n` 规范化成 `\n`，于是回读**必然**
 * 比原文短，短的量恰好等于 CRLF 个数。真机读数（2026-10-11，HeadlessChrome/151）：
 * 44,202 字符的提示词两次都「丢 126 个字符」，而那 126 正是注入的 `AGENTS.md` 的
 * **126 行**（126 个 `\r\n`）——**正文一字未少**，纯属误报；`-8` 的容差对此毫无帮助。
 * 实测五项断言：CRLF 差值 = CRLF 对数（252=252）、LF 对照零差、规范化后内容逐字相等、
 * 尾部保留、旧判据确实触发。
 *
 * ## 允许的规范化（白名单，刻意极窄）
 *
 *   · `\r\n` → `\n`（以及孤立的 `\r` → `\n`）：浏览器对 textarea 的既定行为；
 *   · **行尾**空白差异（每行右端的空格/制表符）：富文本编辑器会吞掉；
 *   · Unicode 归一化（NFC）：某些编辑器会重排组合字符。
 *
 * **不允许**：泛化的 trim / 折叠中间空白 / 忽略缩进 / 忽略大小写——那些会掩盖真正的
 * 正文损坏，而本判据存在的全部理由就是不让半截正文被当成成功。
 *
 * ## 真正的截断依然会被拦住
 *
 * 网页只收了前半截时，规范化后**依然**不等 ⇒ `ok:false`，并给出可归因的 `reason`
 * 与实测长度，供上层自动压缩重试取数（`err.accepted` / `err.total`）。
 *
 * @param {string} sent 我们写进输入框的正文
 * @param {string|null|undefined} echoed 从网页回读到的正文（读不到时传 null）
 * @returns {{ok: boolean, reason: string, sentLength: number, echoedLength: number}}
 */
export function composerEchoVerdict(sent, echoed) {
  const s = String(sent ?? '');
  const sentLength = s.length;
  // 读不到（表单控件与富文本编辑器的读取方式不同，见 readComposer）：不能断言截断。
  // 这是**既有行为**——旧判据对非字符串同样直接放行。
  if (typeof echoed !== 'string') {
    return { ok: true, reason: 'echo-unavailable', sentLength, echoedLength: -1 };
  }
  const echoedLength = echoed.length;
  if (echoed === s) return { ok: true, reason: 'exact', sentLength, echoedLength };

  /** 白名单规范化：只动换行与行尾空白，绝不动正文内容。 */
  const norm = (t) => String(t ?? '')
    .replace(/\r\n?/g, '\n')          // CRLF / 孤立 CR → LF
    .replace(/[ \t]+$/gm, '')         // 每行行尾空白
    .normalize('NFC');                // Unicode 归一化

  if (norm(echoed) === norm(s)) {
    return { ok: true, reason: 'newline-normalized', sentLength, echoedLength };
  }
  return { ok: false, reason: 'content-mismatch', sentLength, echoedLength };
}

/**
 * 完成请求元数据的**可判定摘要**（0.19.11，2026-09-24）。
 *
 * ## 为什么必须改（这是「投递链不自证」的直接病灶）
 *
 * 用户报障：附件投递「送不进去／送进去不回复」，而桥**无法回答最基础的一问**——
 * 这一轮的完成请求到底带没带文件。旧实现是：
 *
 *   `Object.entries(body).filter(([key]) => /model|thinking|search/.test(key)
 *      && ['string','boolean','number'].includes(typeof value))`
 *
 * 两道门把证据全挡在外面：
 *   ① 键名正则只认 model/thinking/search，**`ref_file_ids` 直接出局**——
 *      而它正是 unified UI 时代「带图/带文件」的唯一权威字段（真机取证：
 *      test-mock/archive/real-probe-20-newui-facts.mjs:152 就是用
 *      `b.ref_file_ids && b.ref_file_ids.length` 判定附件在场）；
 *   ② 类型白名单只收标量——`ref_file_ids` 是**数组**，就算键名放行也照样被丢。
 * 于是 2026-09-18 / 2026-09-20 两次「附件轮零回复」都无法归因：既不能证明
 * 「请求带了文件」，也不能证明「没带」。README 里 0.16.31 解禁附件后的复验
 * 一直卡在这一步。
 *
 * ## 口径（只记 id 与长度，不记正文）
 *
 * · 标量沿用旧行为（model_type / thinking_enabled / search_enabled 一个不少）。
 * · 文件 id 列表只留**字符串 id**（最多 12 枚）并附 `*Count` 计数——id 不是内容，
 *   可以进 `/status`；附件正文一律不进。
 * · `prompt` 只记**长度**（`promptChars`）：这是「这一轮到底发了多少字符」的
 *   唯一口径，与 `attachTransport.payloadChars` 配对即可判定投递是否真的发生。
 * · 绝不把 body 里的其它键带进来：`/status` 是外发读数，不是抓包转储。
 *
 * @param {unknown} body 完成请求的 JSON body
 * @returns {Record<string, unknown>|null} 摘要；没有任何可判定字段时返回 null
 */
export function summarizeRequestMetadata(body) {
  if (!body || typeof body !== 'object') return null;
  const SCALAR_KEY = /model|thinking|search/i;
  const ID_LIST_KEY = /file_?ids?|files|attachment/i;
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    const t = typeof value;
    if (SCALAR_KEY.test(key) && (t === 'string' || t === 'boolean' || t === 'number')) { out[key] = value; continue; }
    if (ID_LIST_KEY.test(key) && Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      out[key] = value.slice(0, 12);
      out[key + 'Count'] = value.length;
    }
  }
  if (typeof body.prompt === 'string') out.promptChars = body.prompt.length;
  return Object.keys(out).length ? out : null;
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
 *   maxChars?: number, transport?: 'attach'|'inline', attachForbidden?: boolean,
 *   hardLimit?: number|null}} o
 * @returns {{mode: 'inline'|'attach', reason: string, total: number, limit: number,
 *   payloadChars: number, truncate: boolean, kept: number|null, maxChars: number|null}}
 */
export function promptTransportPlan(o = {}) {
  const total = Math.max(0, Math.floor(Number(o.chars) || 0));
  const limit = Number(o.inlineLimit) > 0 ? Math.floor(Number(o.inlineLimit)) : 0;
  // 站点级**硬上限**（0.19.41）：纯文本写入超过它就不再是「偏好」问题，而是「发出去
  // 必然半截」——因此它优先于用户显式选的 `transport: 'inline'`。
  //
  // 真机依据（2026-09-27，kimi）：用户把投递形态设成「纯文本」，于是 38,807 字符
  // 全量灌进 contenteditable，回读到 20,158（内容被静默丢掉）⇒ 桥如实报
  // PROMPT_TRUNCATED，**用户看到的是「一句话就处理失败」**。而同一个站点上
  // 附件投递实测可用（模型读出了只在附件正文里的标记值）。也就是说：
  // 「用户选了纯文本」与「这条消息根本发不完整」冲突时，让用户拿到完整回复优先。
  //
  // 为什么不是「inline 一律改成 attach」：那会夺掉用户的选择权，而 inline 在
  // 上限内是**完全正常**的（真机 38.8k 单次写入被模型正确回答）。这里只兜住
  // 「必然失败」的那一段，并且把原因如实写进 reason（面板可核对）。
  //
  // 阈值来源见 SITE_COMPOSER_HARD_LIMIT；`null`/非法 = 该站点没有实测上限，
  // 行为与旧版逐字相同（只有 `transport:'inline'` 一条判据）。
  const hardRaw = o.hardLimit === undefined || o.hardLimit === null ? null : Number(o.hardLimit);
  const hardLimit = Number.isFinite(hardRaw) && hardRaw > 0 ? Math.floor(hardRaw) : null;
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
  if (o.transport === 'inline') {
    // 超硬上限：纯文本这条路**必然**半截，改走附件（前提：站点真的有入口）。
    // 入口缺失时如实回落 inline——那时唯一可做的就是把「写不完整」这条错误暴露出来，
    // 而不是假装发成功。
    if (hardLimit !== null && total > hardLimit && o.attachSupported && !o.attachForbidden) {
      return cap('attach', 'inline-unsafe');
    }
    return cap('inline', 'transport-inline');
  }
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
 * 站点级「多长就走附件」的默认阈值（0.19.11）——只收紧，不开启。
 *
 * ## 为什么需要它（真机取证，2026-09-24）
 *
 * 用户报障原话：「明明在附件投递模式下，看的还是完整上下文」（同句现场读数见
 * runTurn 里 0.19.9 那段注释：`userMsgChars=81139`）。查下来不是判据错，是**阈值错**：
 * 全站默认 `attachInlineLimitChars = 60_000`（lib/index.js DEFAULTS），而真机
 * navTrace 里 webcode 路由的**典型首轮**是 `messageChars: 48937` 与 `53797`
 * —— 两个都在 60,000 以下 ⇒ 判定落在 `under-limit` ⇒ **全文逐字灌进输入框**。
 * 也就是说：越典型的会话越走 inline，「附件投递」只在超大轮才生效。
 *
 * ## 阈值取 8,000 的依据（两支真机探针，不是拍脑袋）
 *
 * `test-mock/real-attach-adjudicate.mjs`（3,530 字符 → 完成请求
 * `ref_file_ids:['file-c4332525-…']`、`promptChars:80`、页面用户消息只渲染 80 字符）
 * 与 `test-mock/real-attach-ingest.mjs`（**3,554 与 62,054 两个尺寸都从附件正文里
 * 读出了只在文件里的标记值**，分别 3.4s / 4.3s）证明：附件在 deepseek 上
 * 既能送达也能被读，小到 3.5k 也完全正常。
 * 8,000 的落点：**只留一句「闲聊级」的短轮走 inline**，任何真实会话（首轮含
 * 教学 + 会话历史，实测普遍 ≥ 20k）都走附件、对话框里只留那段指针文本。
 *
 * ## 与「0 = 关闭」的语义关系
 *
 * 这里**只做上限收紧**：配置为 0（用户显式关闭附件）时一律 inline，绝不因为本表
 * 把附件重新打开；配置为 60_000 且站点在本表内时取 `min(60_000, 8_000)`。
 * 未列出的站点逐字维持旧行为（能力边界：本次只改 deepseek）。
 *
 * ## kimi 加入（真机取证，2026-09-25）
 *
 * 与 deepseek 同构的事故形态：kimi 轮 38,807 字符（navTrace `messageChars:38807`）
 * 在全站默认 60,000 之下 ⇒ `under-limit` ⇒ 全文 inline 灌进 contenteditable
 * 输入框（`div.chat-input-editor`，providers.js:277）——而 kimi 输入框实测上限
 * ~20K，超限部分**静默丢失**，模型只见前半，会话上下文被无声截断。
 * `assertContextBudget` 拦不住它：kimi k3 声明 `context: 1_000_000`（providers.js:310），
 * 38.8K 字符 ≈ 38.8K token 远未超限——该闸对比的是**声明窗口**，不是输入框 DOM 上限。
 * kimi 的附件要件齐备（`attachSelector: "input[type='file']"`、Connect-RPC 解码器
 * 已在），与 0.19.11 deepseek 修复逐字同构地取 8,000：真实会话首轮普遍 ≥ 20k，
 * 收紧后全部走附件，输入框里只留指针文本。
 * ## GLM 加入（0.19.41，真机取证）
 *
 * 这一条**本该早就有**：本文件 `ATTACH_FORBIDDEN_SITES` 的注释（0.16.31 写）
 * 与 `providers.js` 的 GLM 声明都已经把结论写死了——
 *
 *   > 真正的站点差异（**GLM 输入框装不下长文**）仍然由各站点的**阈值**表达
 *   > 真机读数：GLM 的输入框装不下长文（用户原话「他在附件可以，输入框过长」），
 *   > 所以它必须留在附件路径上
 *
 * 但阈值表里**只加了 deepseek 与 kimi，glm 一直缺席**——于是那句「必须留在附件
 * 路径上」只是注释，没有约束力。真机后果（2026-09-27，本机 0.19.40）：
 *
 *   一轮 12,911 字符的提示词（全站默认阈值 60,000 ⇒ `under-limit` ⇒ inline）
 *   灌进 chatglm.cn 输入框，回读只有 12,870 字符，本轮直接以
 *   `PROMPT_TRUNCATED: 网页输入框只接收了 12870/12911 字符` 失败——**用户正报的
 *   「chatglm 老是失败」就是这么来的**。
 *
 * 取 8,000 与 deepseek/kimi 同口径（不是新拍的数）：真实会话首轮普遍 ≥ 20k，
 * 收紧后全部走附件，输入框里只留那段指针文本；GLM 的附件要件齐备
 * （`providers.js` 的 `attachSelector: "input[type='file']"`），且用户已在设置里
 * 把该站点显式设为 `promptTransportBySite.glm = "attach"`——本次只让阈值与那份
 * 显式选择**对齐**，没有把任何站点从 inline 拽去附件。
 *
 * 只收紧、不开启：配置为 0（用户显式关闭附件）时仍一律 inline。
 */
export const SITE_ATTACH_INLINE_LIMIT = Object.freeze({ deepseek: 8_000, kimi: 8_000, glm: 8_000 });

/**
 * 站点级「纯文本写入的**硬上限**」（0.19.41）——超过它就不是偏好问题，是必然半截。
 *
 * ## 与 SITE_ATTACH_INLINE_LIMIT 的分工（两者不是同一件事）
 *
 *   · `SITE_ATTACH_INLINE_LIMIT` 是**用户偏好之上的收紧**：用户选了「附件优先」时，
 *     超过 8,000 字符就走附件。用户显式选「纯文本」时它**让位**（transport-inline）。
 *   · 本表是**用户偏好之下的底线**：即便用户选了「纯文本」，超过这个数也改走附件，
 *     因为纯文本这条路在这一长度上**已经被证明发不完整**（内容被网页静默丢弃）。
 *
 * ## 阈值来源（真机读数，不是规格）
 *
 * kimi 取 **200,000**：真机取证（.tmp-probe/kimi/RESULT.md，2026-09-27）用
 * `keyboard.insertText` **单次**写入 50,000 / 100,000 / 200,000 字符（中文+换行）
 * 全部逐字回读（43 / 94 / 167ms）。即 200k 是**实测能用**的那一档，再往上没有读数，
 * 因此不写成更大的数——没有读数的余量就是猜。
 *
 * 为什么 kimi 在**分块**写入时代需要一个小得多的数（旧读数是 38,807 就丢）：
 * 丢内容的原因是分块本身（编辑器只吃第一块），已在 0.19.41 改成一次性写入。
 * 本表是「一次性写入也可能撑不住」时的第二道底线，不与那条修复重复。
 *
 * 真机 2026-09-27 的另一次读数（用户报障原话「一句话就处理失败」）说明这条底线必须
 * 存在：`transport:'inline'` 强制纯文本时，38,807 字符全量灌进输入框、回读 20,158，
 * 模型只看到半截上下文——而同一站点上附件投递实测可用。
 */
export const SITE_COMPOSER_HARD_LIMIT = Object.freeze({ kimi: 200_000 });

/**
 * 取某站点的纯文本硬上限；未列出的站点返回 `null`（= 不设底线，行为与旧版逐字相同）。
 *
 * @param {string} siteId 站点 id
 * @returns {number|null} 硬上限字符数
 */
export function composerHardLimitFor(siteId) {
  const v = SITE_COMPOSER_HARD_LIMIT[String(siteId || '')];
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/**
 * 把「调用方配置的阈值」与「站点上限」合成本次实际使用的阈值（纯函数，可断言）。
 *
 * @param {string} siteId 站点 id
 * @param {number} configured 配置阈值（`>0` 才算开启附件；`0`/非法 = 关闭）
 * @returns {number} 实际阈值；`0` 表示附件关闭（调用方据此把 attachEnabled 置假）
 */
export function effectiveAttachInlineLimit(siteId, configured) {
  const c = Number(configured);
  if (!Number.isFinite(c) || c <= 0) return 0;
  const site = SITE_ATTACH_INLINE_LIMIT[String(siteId || '')];
  return Number.isFinite(site) && site > 0 ? Math.min(c, site) : c;
}

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
/**
 * 判定「点击目标是否被页面级 UI 遮罩挡住」（F16，真机 z.ai 2026-10-19 Wave2）。
 *
 * ## 缺陷现场（只读 live-probe，`.tmp/live-2026-10-19/probe-report-2.md` §4）
 *
 * z.ai 既有会话页带**产品导览**：`body.className="driver-active driver-fade"`、
 * `.driver-overlay` svg 1 个、`.driver-popover` 文案「将任务结果保存到文件夹 … 1/2 下一页」。
 * `elementFromPoint` 在发送键中心 (1209,849) 与输入框中心 (852,799) 命中的都是
 * `.driver-overlay` 内的 `<path>`（pointer-events:auto），`hitInsideSelf=false`
 * （headed/headless 双证）。机制与症状吻合：写入输入框不需要点击（正文进框）→
 * 点发送键被遮罩拦 → catch 改 Enter（zai 对程序化 Enter 不响应）→ 再点仍被拦
 * → `SEND_NOT_CONFIRMED`。
 *
 * ## 为什么抽成纯函数
 *
 * 「遮罩是否盖住目标」的判据必须可离线反向验证（本仓库对 idle-window 等判据同一条纪律）。
 * 输入是 `elementFromPoint` 命中的元素信息——命中点本身就在目标 rect 中心，
 * 所以「目标 rect」已经体现在这次命中里；这里只需要判断命中链是否属于遮罩。
 *
 * @param {null|{className?:string, ancestorClasses?:string[], bodyClasses?:string, point?:{x:number,y:number}}} hit
 *   `elementFromPoint(targetCenter)` 命中的元素：自身 class/id、祖先链 class/id、body class。
 * @returns {{blocked:boolean, kind:'driver-tour'|'modal-overlay'|null}}
 *   blocked=true 时 kind 指明遮罩类型（产品导览可尝试 Escape 关闭；地区弹窗必须人工处理）。
 */
export function overlayBlocksPoint(hit) {
  if (!hit || typeof hit !== 'object') return { blocked: false, kind: null };
  const chain = [hit.className, ...(Array.isArray(hit.ancestorClasses) ? hit.ancestorClasses : []), hit.bodyClasses]
    .filter((s) => typeof s === 'string' && s.trim())
    .join(' ');
  if (!chain) return { blocked: false, kind: null };
  const classes = chain.split(/\s+/).filter(Boolean);
  const hasToken = (needle) => classes.some((c) => c.indexOf(needle) !== -1);
  // 产品导览（driver.js）：overlay 盖住目标点 ⇒ 点击必然打空。
  if (hasToken('driver-overlay') || hasToken('driver-popover')) return { blocked: true, kind: 'driver-tour' };
  // 地区/公告弹窗：语义上需要用户确认地区，**不自动处理**，只报可读错误。
  if (hasToken('_modal-overlay')) return { blocked: true, kind: 'modal-overlay' };
  return { blocked: false, kind: null };
}
/**
 * 富文本输入框「停滞」判据：连续两次回读长度没有增长才判死。
 *
 * 为什么是两次而不是一次：富文本站点（GLM 等）一次回读偶发拿到中间态，
 * 单次不涨就判死会误杀正常写入；单块不涨不算死、连续两块不涨才死。
 *
 * @param {number|null} prevLen 上一次回读长度（首块为 -1）
 * @param {number|null} curLen 本次回读长度（null = 读不到，不计数）
 * @param {number} stalled 当前累计停滞次数
 * @returns {{stalled:number, prevLen:number, died:boolean}}
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
 * 网页「联网搜索」开关的**计划层**（纯函数，0.19.94「搜索开关」的判据真源）。
 *
 * ## 为什么需要它（用户需求）
 *
 * 用户要求把搜索开关做成可配置的三态：`auto`（不动网页，零位移）/ `on`（强制开）/
 * `off`（强制关，即旧行为）。旧实现只有一行硬编码：「搜索按钮是 aria-pressed=true
 * 就点掉它」——**只有 off**，用户没有选择，而且它会在用户手动开了搜索后静默关掉。
 *
 * ## 三态语义（本函数只做判定，不碰页面）
 *
 * | mode | pressed=true | pressed=false | pressed=null（控件找不到/读不到） |
 * | --- | --- | --- | --- |
 * | auto | noop | noop | noop（**零位移**：不点、不退化成 off） |
 * | off  | turn-off | noop | noop（没有可关的东西） |
 * | on   | noop | turn-on | **fail**（用户明确要求开，却读不到控件 ⇒ 不许假装成功） |
 *
 * ## 为什么 `on` + 读不到必须是 fail 而不是 noop
 *
 * `on` 是用户的**显式要求**。网页改版后 aria-pressed 控件不见了，若静默 noop，
 * 用户以为「已开启联网搜索」，实际网页没开——这正是本项目「说做了、其实没做」
 * 那一族缺陷。fail 让驱动抛 `SEARCH_TOGGLE_UNCONFIRMED`，把「没确认」如实告诉用户。
 *
 * ## 为什么非法 mode 归 auto
 *
 * 设置文件可手改。写错的 mode 只许退化成**零位移**（旧用户行为不变），不许变成
 * 第三种谁也没定义过的口径——与 sendGapBasis / promptTransport 的归一化纪律同源。
 *
 * @param {{pressed?: boolean|null, mode?: string}} [input]
 *   pressed = 搜索控件当前 aria-pressed（true/false），控件不存在或读不到时 null/undefined。
 * @returns {{action: 'noop'|'turn-on'|'turn-off'|'fail', reason: string}}
 */
export function planSearchToggle({ pressed = null, mode = 'auto' } = {}) {
  // 归一化与 index.js / web-control.js 同一条纪律：只认三个合法值，其余归 auto。
  const m = mode === 'on' || mode === 'off' ? mode : 'auto';
  const p = typeof pressed === 'boolean' ? pressed : null;
  if (m === 'auto') return { action: 'noop', reason: 'mode-auto' };
  if (m === 'off') {
    if (p === true) return { action: 'turn-off', reason: 'mode-off-pressed' };
    return { action: 'noop', reason: p === false ? 'mode-off-already-off' : 'mode-off-control-missing' };
  }
  // on
  if (p === true) return { action: 'noop', reason: 'mode-on-already-on' };
  if (p === false) return { action: 'turn-on', reason: 'mode-on-not-pressed' };
  return { action: 'fail', reason: 'mode-on-control-missing' };
}

/**
 * 任务模式（站点→模式名，先只服务 GLM）的**纯判定**：这一轮到底要不要动网页控件。
 *
 * ## 为什么要能离线测（task-8）
 *
 * 三条安全线都是「判据」而不是「实现细节」，改坏了必须变红：
 *   ① **默认空 = 零位移**：`siteModeBySite` 没配（或空串/非字符串）⇒ 不点、不回读、不抛错。
 *      这是「不配置的用户行为逐字不变」的可核对形式。
 *   ② **只在 fresh 轮应用**：模式是与会话绑定的网页状态，resume（续聊既有会话）时重新点
 *      可能把「上一轮已选好的模式」改掉/切走，且既有会话页可能根本不渲染该控件
 *      （doubao 分段控件的同型教训，见 plan/record）。resume 一律不动。
 *   ③ 显式配置了但驱动层找不到控件/回读失败 ⇒ **抛可读错误**（SITE_MODE_UNAVAILABLE），
 *      不静默降级（与 planSearchToggle 的 on+fail 同一条纪律）。
 *
 * @param {{siteMode?: string|null, fresh?: boolean}} [input]
 *   siteMode = 设置层解析出的模式名（默认 ''）；fresh = 本轮是否新建会话。
 * @returns {{apply: boolean, mode: string|null, reason: string}}
 */
export function planSiteMode({ siteMode = '', fresh = false } = {}) {
  const mode = typeof siteMode === 'string' ? siteMode.trim() : '';
  if (!mode) return { apply: false, mode: null, reason: 'mode-unset' };
  if (!fresh) return { apply: false, mode, reason: 'resume-keeps-mode' };
  return { apply: true, mode, reason: 'fresh-apply' };
}

/**
 * 任务模式「是否已生效」的**真机判据**（GLM，2026-10-19 真机校准）。
 *
 * ## 真机事实（`.tmp/live-2026-10-19/glm-mode-calibration.md` + raw3）
 *
 * 点中任一模式后工具行**立刻淡出隐藏**（容器 `model-select-fade-leave-active`）：
 * DOM 里 `div.model-select-item.selected` 的文本=模式名，但 `visible=false`；
 * 条目**全程没有 aria-selected / aria-checked**。因此旧判据（只看可见 item 的
 * aria/class）**恒为 false** ⇒ 每次 fresh 轮都必抛 SITE_MODE_UNAVAILABLE。
 * 真正可读的选中证据有两个：
 *   ① `div.model-select-item.selected` 的 textContent（**不过滤可见**）；
 *   ② 可见的 `div.selected-model-info`（chip）的 textContent。
 *
 * 本函数把这两条收成纯函数，便于离线反向验证（判据必须可测，不能只活在驱动闭包里）。
 *
 * @param {{selectedItemTexts?: string[], selectedInfoText?: string|null, mode?: string}} [input]
 * @returns {{confirmed: boolean, basis: 'selected-item'|'selected-info'|null}}
 */
export function siteModeVerdict({ selectedItemTexts = [], selectedInfoText = null, mode = '' } = {}) {
  const want = typeof mode === 'string' ? mode.trim().replace(/\s+/g, ' ') : '';
  const norm = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
  if (!want) return { confirmed: false, basis: null };
  const hitItem = Array.isArray(selectedItemTexts) && selectedItemTexts.some((t) => norm(t) === want);
  if (hitItem) return { confirmed: true, basis: 'selected-item' };
  if (norm(selectedInfoText) === want) return { confirmed: true, basis: 'selected-info' };
  return { confirmed: false, basis: null };
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
  // 助手节点选择器（0.19.19）：站点在 providers.js 声明了 answerSelector 就用它，
  // 否则回落到那份 DeepSeek 兜底串。**求值一次、两处消费点共用**——这正是
  // 0.19.16 用「唯一一份」换来的东西，别在这里又抄第二份。
  // 缺省分支逐字等于 0.19.18 的行为，所以未声明站点零位移。
  // 0.19.50：规则抽成 `answerSelectorFor`（具名导出），本行只是它的调用点——
  // 抽出去是为了让这条规则**能被护栏钉住**，见该函数的注释。
  const answerSelector = answerSelectorFor(siteId);
  // 账户槽（0.14.7）：同一站点的第 2 个账户是**另一个驱动实例**，用另一个 profileDir。
  // 槽在驱动里只做两件事：① 透出给 /status 与面板（用户要知道这行是哪个账户）；
  // ② 进日志前缀（两个槽的日志混在一起时能分开）。
  //
  // 文件名**刻意不按槽改名**：profileDir 本身已经是槽目录（见 accounts.slotProfileDir），
  // 在槽目录里再写一份带槽名的文件名是冗余的——而冗余的名字意味着多一条迁移路径，
  // 迁移就是风险。默认槽因此逐字保持 0.14.6 的落盘形状。
  const slot = normalizeSlot(options.slot) || DEFAULT_SLOT;
  // 0.19.18 账号级互斥（用户准则「同一账号不能同时桥接运行」）的本实例状态：
  //   · accountKey 与 status() 里那一份**同口径**（默认槽 = siteId，非默认槽 = siteId#slot），
  //     两处必须是同一个字符串，否则「锁报的账号名」与「面板显示的账号名」会对不上；
  //   · accountLock.held 记本实例是否已持有锁，close() 据此决定要不要释放。
  const accountKey = slot === DEFAULT_SLOT ? siteId : siteId + '#' + slot;
  const accountLock = { held: false, path: '' };
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
  //
  // ⚠ 变量名必须是 `loginPhase` 而**不是** `loginState`（#60）：`status()` 里
  // 还有一个同名概念 `loginState` —— 那是 0.19.75 引入的**三态登录结论**
  // （verified-in / verified-out / uncertain）。两件事曾共用一个变量名，
  // 于是 status() 返回对象里 `loginState,` 这句简写（进度值 idle/…）把先写的
  // 三态 IIFE 整个覆盖掉 ⇒ 三态从未到达面板。名字分开后，两句各归各的。
  let loginPhase = 'idle';   // idle | launching | waiting-for-login | already-logged-in | ready | error
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
  // 0.19.12：捕获链中断兜底的静默阈值。真机事故（2026-09-24，session-12d9c3c6）：
  // 首事件已到后捕获管道中断，页面把回复完整写完（DOM 1072 字），桥侧 120s 零事件
  // ——WIP 稳态收束救不了它（bodyReady 要求正文先从流里来过），唯一的结局是适配器
  // 看门狗开火、内容整轮丢失。兜底判据见 metrics.shouldRescueStalledCapture；这里
  // 只定「流静默多久算疑似中断」。**必须 < 适配器看门狗 120s**，否则又是看门狗先
  // 开火、兜底永远轮不到。0 = 显式关闭（想完全回到旧行为就写 0）。
  const CAPTURE_STALL_MS = (() => {
    const n = Number(cfg.captureStallRescueMs);
    return Number.isFinite(n) && n >= 0 ? n : 45_000;
  })();
  // 0.19.16：**找不到助手节点**时的收束窗口。
  //
  // 与 WIP_IDLE_MS 的分工：那个是「页面看得到、也停长了」的常规窗口；这个用在
  // 「页面在、但选择器认不出哪条是回复」——此时「DOM 停长」这条判据**没有证据**
  // （a.lastDomGrowthAt 从不刷新），若仍按 2.5s 就收束，等于只凭流静默决定，
  // 真机后果就是 GLM 那类站点在页面还在写字时被腰斩。取 6×（默认 15s）是刻意的
  // 粗估：宁可多等十几秒，也不腰斩仍在生成的回复。
  // 必须远小于 requestTimeoutMs（240s），否则这一轮永远轮不到稳态收束、
  // 只能等通用超时（报错信息也就失去「收束原因」这条线索）。
  const DOM_BLIND_MS = Math.max(WIP_IDLE_MS * 6, 15_000);
  // 0.19.75 交付链逐层取证的开关（默认关：它只在排查「内容丢在哪一层」时需要）。
  //
  // 为什么要显式开：取证器每帧做一次 sha256 更新，长会话下是真实开销；而绝大多数
  // 运行不需要它。开启方式（两条都支持，配置优先）：
  //   · 环境变量 `WEBCODE_DELIVERY_TRACE=1`（可附 `WEBCODE_DELIVERY_TRACE_SAMPLE=N`
  //     额外保留每层前 N 字符原文——**默认 0 = 不留原文**，用户对话不该为排障默认落盘）；
  //   · 插件配置 `deliveryTrace: true` / `deliveryTraceSampleChars: N`。
  const deliveryTraceEnabled = cfg.deliveryTrace === true
    || process.env.WEBCODE_DELIVERY_TRACE === '1';
  const deliveryTraceSampleChars = (() => {
    const n = Number(cfg.deliveryTraceSampleChars ?? process.env.WEBCODE_DELIVERY_TRACE_SAMPLE);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();
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
  // 0.19.75：最近一轮的**交付链逐层读数**（snapshot + 比对结论）。
  // 与 lastEndReason 同寿命：本轮结束后**不**清空，于是超时那一刻
  // （或 /status 事后查看）取到的是刚刚这一轮的读数，而不是本轮清空后的 null。
  let _lastDeliveryTrace = null;
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
  // 0.19.5：最近一轮**图片投递**的结果读数。与 attachTransport 并列而不是合并——
  // 文字附件与图片是两条独立路径，合成一个字段会让「这一轮到底有没有把图送上去」
  // 无从判断。图片失败**不再终止整轮**（见 runTurn 的调用点），因此这一格是唯一凭据：
  // 成功 `{ at, ok:true, count, evidence, names }`，失败 `{ at, ok:false, code, fallback:true, diag }`。
  // **必须声明在驱动级**：status() 是另一个闭包，写在 runTurn 里会让它整个抛
  // ReferenceError（本文件 0.19.5 一度如此，被 stall-settle / settings-transport 抓住）。
  let imageTransport = null;
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
      return await p.evaluate((PAT) => {
        const t = String(document.title || '');
        const body = String(document.body?.innerText || '');
        const html = String(document.documentElement?.innerHTML || '');
        // 词表判据的唯一真源：lib/challenge-heuristics.js（以 source 传参在页面侧重建）。
        // ⚠ 这三条正则**不得带 g/y 标志**（会因 lastIndex 递进交替返回真假）——
        // CHALLENGE_PATTERN_SOURCES 已保证，别在这里手写 `…/g`。
        if (new RegExp(PAT.title).test(t)) return 'waf-title';
        if (new RegExp(PAT.body).test(body)) return 'waf-body';
        if (new RegExp(PAT.html).test(html)) return 'waf-script';
        return null;
      }, CHALLENGE_PATTERN_SOURCES);
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
        if (await bad.count() && await bad.isVisible().catch(() => false)) {
          // ## 0.19.78（真机修出）：`bad` 命中**不一定是终局** —— SPA 会先渲染「游客壳」
          //
          // 真机实证（qwen，2026-10-14，同一副本页多次采样）：
          //   +1.4s（domcontentloaded）：「登录 / 注册」**可见**、账号名**无**、`img.user-img` 0
          //   +2.2s                      ：仍同上
          //   +3.8s                      ：按钮**归零**、账号名 `QwenUser2147` 出现、`img.user-img` 1
          // ⇒ qwen 先渲染游客壳、再水合成已登录态；而 `gotoFreshChat` 等的是 `SEL.input`，
          //   qwen 的**游客壳自带 composer** ⇒ 1.4s 就返回 ⇒ 本函数撞上瞬时游客壳
          //   ⇒ 旧实现**立即** `return false` ⇒ 缓存 `loggedIn=false` ⇒ 整轮被拒
          //   （`site-verify --site qwen` 得到 `BLOCKED profile 未登录`，而页面其实已登录）。
          //
          // 与下面 :118x 那条「水合重探」的**关系**：那一条处理的是「bad 还没出现」
          // （kimi 真机：domcontentloaded 一瞬头部未水合），本处补的是**对称的另一半**
          // ——「bad 出现了但可能是瞬时的」。两条合起来才是完整的「水合窗口」处置。
          //
          // 代价与边界（刻意收窄，别放宽）：**只在「有可见 composer」时才做这次有界重探**
          // （qwen / gemini / doubao / zai 这一族游客页自带输入框；deepseek 未声明 bad、
          // 完全不进这里）。无 composer 时旧行为逐字不变，因此不会给「真的未登录」的
          // 站点普遍加延迟；有 composer 的站点最坏多等 2.5s，换来的是**不把已登录判成未登录**。
          if (await visibleComposerCount(p) > 0) {
            // ## 窗口取 6_000ms 的依据（不是拍脑袋）
            //
            // 真机时间线（qwen，2026-10-14，两轮独立采样）：
            //   · 上一轮（探针内 `goto` 后主动等 composer）：+1.4s / +2.2s 仍是游客壳，
            //     **+3.8s 已水合**（按钮归零、账号名出现、userImg=1）
            //   · 本轮（复刻 `gotoFreshChat` 的 `waitForSelector(SEL.input)`）：
            //     `inputWaitMs=252`（**游客壳自带 composer，等 0.25s 就返回了**）
            //     +1.2s / +3.8s 仍是游客壳；**+7.8s 才归零**
            //   ⇒ 水合完成时刻落在 **3.8s ~ 7.8s** 之间（两轮都证明它**晚于**任何
            //     「等 composer」的判据）。取 **6_000ms** 覆盖观测下界并留余量；
            //     若 `bad` 在窗口内消失 ⇒ 判为瞬时游客壳、继续走 ok 判定。
            //
            // ⚠ 这是**有界等待**：窗口耗尽仍未消失 ⇒ 维持旧的 `probe-bad`（真的未登录）。
            //   「真的未登录」的站点因此最多多等 6s，换来的是**不把已登录判成未登录**
            //   —— 这个交换对本项目的主用途（网页 AI 当 provider）是划算的：
            //   误报未登录会让整轮被 `NEED_LOGIN` 拒绝（用户上次就是这么被挡的），
            //   而多等 6s 只是慢一点。
            const gone = await bad.waitFor({ state: 'hidden', timeout: 6_000 }).then(() => true, () => false);
            // `bad` 在窗口内消失 ⇒ 那是瞬时游客壳，**不**据此判未登录，继续往下走 ok 判定。
            if (!gone) { lastLoginBasis = 'probe-bad'; return false; }
          } else {
            lastLoginBasis = 'probe-bad'; return false;
          }
        }
      } catch { /* bad 特征坏了不阻塞判定 */ }
    }
    if (probe?.ok) {
      try {
        // 快速路径（零等待，生产常见路径不变）：ok 特征已在页面里 ⇒ 直接判已登录。
        if (await p.locator(probe.ok).first().count()) { lastLoginBasis = 'probe-ok'; return true; }
        // ── F14：ok 特征的**水合窗口**（kimi 真机，2026-10-19 Wave2）────────────
        //
        // ## 缺陷现场（零发送真机读数，lead-probe）
        //
        // 证据：`.tmp/live-2026-10-19/raw/wave2probe-2026-10-19T14-12-39.json`。
        // kimi 落地页从 domcontentloaded 起，target 300/800/1500ms 采样（+1.16s /
        // +1.58s / +1.61s）：`span.user-name` 与 `img.user-avatar` **count=0 visible=0**，
        // 而 composer 已可见；到 **+4.2s** 才 `span.user-name` count1/visible1
        // text=TYZ0712、`img.user-avatar` 1/1。
        // ⇒ 旧实现只查一次 ok；水合前必然落到 `probe-fallback`（#53 三态 = uncertain）
        //   —— Wave2 kimi 的 `login.basis=UNVERIFIED(probe-fallback)` 正是此现场，
        //   **不是**声明错（#59 doubao 已 probe-ok，证明声明-同源没白做）。
        //
        // ## 判据（与上面 bad 分支的水合重探对称）
        //
        //   ① 快速路径已在上方返回，已登录常见路径零等待；
        //   ② 仅当 ok 一次都没命中 + **有可见 composer**（SPA 壳已渲染、只是头部账号区
        //      未水合）时，做一次**有界**等待；命中 ⇒ probe-ok；
        //   ③ 窗口耗尽 ⇒ 维持原逻辑继续往下走 fallback（**不得**写成 probe-bad：
        //      那会把「没等到」谎报成「确认未登录」）。
        //
        // 窗口 5_000ms 的依据：真机观测水合落在 1.6s～4.2s，取 5s 覆盖观测下界并留余量；
        // 只有「声明了 ok + ok 未命中 + composer 可见」的判定才会付这笔等待，
        // 已正确命中的站点/无 composer 的页面零等待。
        if (await visibleComposerCount(p) > 0) {
          const appeared = await p.locator(probe.ok).first()
            .waitFor({ state: 'visible', timeout: 5_000 })
            .then(() => true, () => false);
          if (appeared) { lastLoginBasis = 'probe-ok'; return true; }
        }
      } catch { /* 同上：ok 特征坏了不阻塞判定 */ }
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
  // 最近一次**真正生效**的思考等级（0.19.48）：{ at, siteId, target, readback, basis }。
  // 只在回读确认成功那一刻写（见 lib/think-effort.js 的 applyEffort 回读步），因此它不是「我们点过
  // 什么」而是「网页现在是什么」——status 里透出它，排障时能一眼看出档位有没有落下去。
  let effortApplied = null;
  // ---- 账号真实身份（0.19.4）--------------------------------------------------
  // 用户指令：「右侧要能够获取真实登录状态登录后就会显示下拉选择（像新建终端的下拉
  // 选择）……下拉取后显示已登录头像和昵称」，并明确「抓真实值 + 抓不到回落槽名」。
  //
  // 这里是**尽力而为**的一次 DOM 读取，不是保证：站点改版、头像走懒加载、登录后
  // 才渲染，任何一种都能让它读不到。读不到时字段留 null，界面回落成槽名——
  // 绝不拿槽名冒充昵称（本项目的「不造假状态」纪律）。
  let accountIdentity = null;   // { name, avatarUrl, capturedAt, basis }
  // 落盘缓存：路径与「什么算有效」的判据都收在 lib/account-cache.js（**唯一真源**）。
  // 三处消费同一口径——驱动（这里）、模型列表显示名（index.js 的 listModels）、
  // 控制面每个账户行。各写一份必然漂移；本项目对「两处口径漂移」记过多次。
  //
  // 为什么必须落盘（用户原话 2026-09-28：「账户名和图像不会缓存？每次新开？」）：
  // 上面那个 `accountIdentity` 原先只在内存里，桥一重启/懒驱动一回收就归零，
  // 面板回落到 displayName（用户看到的「图像 + Deepseek网页版」）。而 `loggedIn`
  // 早就落盘了——身份是**同一类装饰性读数**却漏了同一层。
  // 教训同源：**任何要在重启后仍显示的状态，都必须落盘。**
  accountIdentity = readIdentityCache(cfg.profileDir);
  /**
   * 站点的账号身份选择器：站点自己声明优先，否则用一组通用猜测。
   *
   * 通用列表刻意做成「类名里含 user/account/avatar」这一族：命中率不保证，
   * 但**误报代价低**（读不到就是 null），而站点声明需要真机取证——本项目不在没有
   * 真机证据的情况下编选择器，因此 `providers.js` 只给已取证的站点声明。
   */
  const GENERIC_NAME_SELECTORS = [
    '[class*="user-name"]', '[class*="userName"]', '[class*="username"]', '[class*="nickname"]',
    '[class*="nick-name"]', '[class*="account-name"]', 'header [class*="name"]',
  ];
  const GENERIC_AVATAR_SELECTORS = [
    'img[class*="avatar"]', '[class*="avatar"] img', 'header img[src*="avatar"]',
    'img[src*="avatar"]', '[class*="user"] img',
  ];
  /** 明显不是昵称的文本（登录入口/按钮文案）——命中就当没读到。 */
  const NOT_A_NAME_RE = /^(登录|登陆|注册|sign\s*in|log\s*in|login|sign\s*up|account|设置|settings)$/i;

  /**
   * 从当前页面读「这个账号真实的昵称与头像 URL」。
   *
   * @param {{debug?: boolean}} [opts] `debug:true` 时**额外**回传页面候选节点
   *   （`candidates`），供真机取证选择器；常规调用不要传它。
   * @returns {Promise<{name: string|null, avatarUrl: string|null, basis: string, capturedAt: string|null, candidates?: object|null}>}
   *   读不到时 `name`/`avatarUrl` 为 null；`basis` 说明来源（site-probe / generic / no-page / cache）。
   */
  async function readAccountIdentity(opts = {}) {
    const probe = site.accountProbe || null;
    const nameSels = (probe?.name?.length ? probe.name : GENERIC_NAME_SELECTORS);
    const avatarSels = (probe?.avatar?.length ? probe.avatar : GENERIC_AVATAR_SELECTORS);
    const p = page;   // 本驱动当前持有的页面（一个账号一个驱动）
    // 没有活页时**回落上次落盘的身份**，而不是一律 null（0.19.46）。
    //
    // 这一格正是用户报的「每次新开就没了」：重启后浏览器尚未 launch，`page` 为
    // null，旧实现直接返回全 null ⇒ 面板立刻抹掉头像与昵称。缓存存在的全部意义
    // 就在于这一刻——真机读得到时它是权威，读不到时它才是**唯一**的显示来源。
    // 仍不造假：缓存里本来就是真机读到的值（basis 标成 'cache' 以示区别），
    // 而且**读不到页面**与**读到空**是两件事，只有前者才用缓存。
    if (!p || p.isClosed?.()) {
      if (accountIdentity) return { ...accountIdentity, basis: 'cache' };
      return { name: null, avatarUrl: null, basis: 'no-page', capturedAt: null };
    }
    const raw = await p.evaluate(({ nameSels: ns, avatarSels: as }) => {
      const textOf = (sels) => {
        for (const s of sels) {
          let el = null;
          try { el = document.querySelector(s); } catch { continue; }
          const t = el && String(el.textContent || '').trim();
          if (t) return t;
        }
        return null;
      };
      const srcOf = (sels) => {
        for (const s of sels) {
          let el = null;
          try { el = document.querySelector(s); } catch { continue; }
          if (!el) continue;
          const direct = el.currentSrc || el.src || (el.getAttribute && el.getAttribute('src'));
          if (direct) return String(direct);
          try {
            const bg = getComputedStyle(el).backgroundImage || '';
            const m = bg.match(/url\(["']?([^"')]+)/);
            if (m) return m[1];
          } catch { /* 计算样式读不到就继续 */ }
        }
        return null;
      };
      return { name: textOf(ns), avatarUrl: srcOf(as) };
    }, { nameSels, avatarSels }).catch(() => ({ name: null, avatarUrl: null }));

    // 昵称后处理：截断 + 排除登录入口文案 + 排除纯符号。
    let name = raw?.name ? String(raw.name).replace(/\s+/g, ' ').trim() : null;
    if (name && (name.length > 40 || NOT_A_NAME_RE.test(name) || !/[\p{L}\p{N}]/u.test(name))) name = null;
    const avatarUrl = raw?.avatarUrl && /^(https?:|data:image\/)/i.test(raw.avatarUrl) ? String(raw.avatarUrl).slice(0, 2048) : null;
    if (name || avatarUrl) {
      accountIdentity = { name, avatarUrl, basis: probe ? 'site-probe' : 'generic', capturedAt: new Date().toISOString() };
      // 读到就落盘（0.19.46）：下次重启/驱动回收后，面板与模型列表仍能显示真实
      // 昵称与头像，不必等用户再点一次「检测」。落盘失败**不影响**本次读数
      //（装饰性）——与 persistLoginState 同一条纪律；写失败只 warn 一行。
      if (!writeIdentityCache(cfg.profileDir, accountIdentity)) warn('account identity cache save failed (profileDir=' + cfg.profileDir + ')');
    } else if (!accountIdentity) {
      accountIdentity = { name: null, avatarUrl: null, basis: probe ? 'site-probe' : 'generic', capturedAt: null };
    }
    // 取证通道（0.19.60，**opt-in**）：把页面上「可能是昵称/头像」的候选节点一并回传，
    // 供人据此挑出稳定选择器（本项目纪律：选择器必须来自真机读数，不许凭印象编）。
    //
    // 为什么必须显式开关而不是默认带上：常规路径是右栏每 8s 一次的轮询，
    // 每次都多扫一遍全页 DOM（子树遍历 + 计算样式）纯属浪费，而这条读数的唯一
    // 消费者是人在排障/取证时的一次性调用。默认行为**一字未改**。
    if (opts?.debug === true) {
      try {
        return { ...accountIdentity, candidates: await p.evaluate(ACCOUNT_CANDIDATE_PROBE) };
      } catch (e) {
        // 取证失败不影响身份读数本身：如实记原因，字段留 null。
        return { ...accountIdentity, candidates: null, candidatesError: String(e?.message || e) };
      }
    }
    return accountIdentity;
  }

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
  // 展示窗口当前是否处于**最小化**态（0.19.52，任务书「打开网站窗口慢 / 切换后
  // 要重新加载」的根因修复）。旧实现「关闭窗口 = ctx.close + 立即重启无头」，
  // 「打开窗口 = 再重启回有头 + goto 站点根」——一次开关循环要整浏览器重启两遍、
  // 整页重载两遍，而且 goto 的是站点根，正在看的会话现场直接丢掉。现在「关闭」
  // 改为最小化（页面、登录态、会话原地保留），「打开」= 恢复窗口 + bringToFront，
  // 全程零重载。真关掉（X 按钮 / 浏览器整个退出）走 ctx 'close' 兜底：headed 一并
  // 复位，下一次 ensure 回无头形态——旧实现漏了这刀，手 X 之后 headed 悬空成
  // true，下一次 openWindow 在无头浏览器上跑「有头」分支，窗口永远不出现。
  let windowMinimized = false;
  const storePath = () => path.join(cfg.profileDir, 'webcode-sessions-' + siteId + '.json');

  function loadStore() {
    if (storeLoaded) return;
    storeLoaded = true;
    try {
      const j = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
      if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) {
        // 0.19.52 起槽记录有两种合法形态：带 webSessionId（有地址形状/流里有 id
        // 的站点），或 webSessionId 为 null 但带 landedUrl（无形状站点——会话身份
        // 就是「落在这个地址上的那页」）。两者都不是的脏记录照旧丢弃。
        if (v && typeof v === 'object'
          && (typeof v.webSessionId === 'string'
            || (v.webSessionId === null && typeof v.landedUrl === 'string'))) conversations.set(k, v);
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
  /** 0.21.1：按 DSH 会话 id 前缀查（写入形状是 sessionId::accountKey，0.19.4 起带账号段）。
   *  命名链路只拿得到裸 sessionId；精确 miss 后在这里做前缀匹配，优先本槽自己的
   *  accountKey（避免多账户槽之间串标题）。找不到返回 null，调用方回落启发式。 */
  function conversationForSession(sessionId) {
    loadStore();
    const id = String(sessionId || '');
    if (!id || id.includes('::')) return conversations.get(id) || null;
    const own = conversations.get(id + '::' + (slot === 'default' ? siteId : siteId + '#' + slot));
    if (own) return own;
    const prefix = id + '::';
    for (const [k, v] of conversations) { if (k.startsWith(prefix)) return v; }
    return null;
  }
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
   * 0.19.52 起支持**两种身份**并采用合并语义（任务书「一 DSH 会话 = 一网页会话，
   * 后续也保证同一会话」）：
   *   · `webSessionId` —— 有地址形状/流里有 id 的站点（deepseek/glm/kimi…）；
   *   · `landedUrl` —— 没有形状的站点（zai/doubao/qwen…）：上一轮落地时页面停在
   *     的**会话地址**（如 z.ai 的 `/c/<uuid>`，真机 2026-09-30 两轮一致）。这些
   *     站点永远拿不到「由 id 构造地址」的能力（goto 深链会被弹回根地址），
   *     页面本身就是唯一锚点。
   * 合并规则：传 null 的那半保留旧值——resume 轮次拿不回流 id（zai 解不出流）
   * 时不会把已有身份抹掉；两个都传 null 则维持「槽空」不写。
   *
   * @param {string} key 会话键（DSH 的 `<sessionId>::<agentId>`）
   * @param {string|null} webSessionId 网页侧会话 id（无形状站点为 null）
   * @param {'store'|'url-heal'} [source] 这条记录的来历（默认 'store'）
   * @param {string|null} [landedUrl] 上一轮落地时的页面地址（站点根不算会话身份，
   *                                   调用方负责只传会话路径）
   */
  function rememberConversation(key, webSessionId, source = 'store', landedUrl = null) {
    loadStore();
    const prev = conversations.get(String(key || 'main')) || null;
    const id = webSessionId === null && prev ? prev.webSessionId ?? null : webSessionId;
    const url = landedUrl === null && prev ? prev.landedUrl ?? null : landedUrl;
    if (!id && !url) return; // 两半都空 = 没有可记的身份（fresh 轮落在站点根等）
    conversations.set(String(key || 'main'), {
      ...(id ? { webSessionId: id } : { webSessionId: null }),
      ...(url ? { landedUrl: url } : {}),
      at: Date.now(), source,
    });
    // 一个 id 能被重新写下，就证明它是活的：清掉它的「不可达」标记（见 deadSessions）。
    if (id) deadSessions.delete(String(id));
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
    // 0.19.52：无形状站点的「落地地址身份」——webSessionId 是 null 但槽里锚着
    // 上一轮落地的会话地址（zai/doubao/qwen…）。如实报出来，而不是显示成「没有
    // 会话」；stay 判据（sendTurn）用的就是这份 landedUrl。
    if (rec?.landedUrl) {
      return {
        webSessionId: null,
        landedUrl: rec.landedUrl,
        at: rec.at ?? null,
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
      // 0.19.75（#53 窄口径）：登录状态**三态**——已验证登录 / 已验证未登录 / 不确定。
      //
      // ## 为什么需要第三态
      //
      // 复审指出：不必在「强行判未登录」与「错误显示已登录」之间二选一。
      // `probe-fallback` 的含义是「站点**声明了**登录特征，却一个都没命中，于是退回
      // 按『有输入框』兜底」——那是**猜测**，不是核验结果。真机读数（全新空 profile、
      // kimi）：声明的 bad 特征命中 0、页面「登录」可见数 0、输入框可见 1
      // ⇒ 旧实现回 loggedIn=true，面板把一个**没登录**的站点显示成「已登录」，
      // 而真实发送路径立刻回 NEED_LOGIN。
      //
      // ## 口径刻意收窄（只动 probe-fallback）
      //
      //   · `probe-ok`        → 'verified-in'  （正向特征命中，是核验结果）
      //   · `probe-bad`       → 'verified-out' （负向特征命中，是核验结果）
      //   · `input-fallback`  → 'verified-in'/'verified-out' 按 loggedIn 照旧
      //     （**这是 DeepSeek 的路径**——它没有 loginProbe，靠输入框回退是设计如此。
      //      若把这一档也降为不确定，主站点会长期显示「不确定」，那是可见的行为退化，
      //      且与「DeepSeek 是唯一可整天长跑的站点」这一既有结论冲突。）
      //   · `probe-fallback`  → **'uncertain'**（声明了特征却没命中 = 猜测）
      //   · `stale`/null      → 'uncertain'（旧版本落盘值、尚未核验）
      //
      // 为什么不确定时**不**把 loggedIn 改成 false：那会把已登录用户（只是站点改版
      // 让特征没命中）判成未登录——谎报与误报都要避免。第三态的意义正是**两边都不说**，
      // 由面板如实显示「待确认」，而不是替用户下结论。
      loginState: (() => {
        const basis = lastLoginBasis || (cachedTrusted ? cachedLogin.basis : (cachedLogin ? 'stale' : null));
        if (basis === 'probe-ok') return 'verified-in';
        if (basis === 'probe-bad') return 'verified-out';
        if (basis === 'input-fallback') return effectiveLoggedIn === true ? 'verified-in' : 'verified-out';
        // probe-fallback / stale / null / 未知值：一律不确定（未知值不得落进「已验证」）
        return 'uncertain';
      })(),
      // 登录结论是否**已核验**（面板据此决定要不要画「已登录」那个绿点）。
      loginVerified: (() => {
        const basis = lastLoginBasis || (cachedTrusted ? cachedLogin.basis : (cachedLogin ? 'stale' : null));
        return basis === 'probe-ok' || basis === 'probe-bad'
          || (basis === 'input-fallback' && effectiveLoggedIn != null);
      })(),
      selectedModel,
      // 最近一次回读确认成功的思考等级（0.19.48）：`null` = 用户没选过（Default），
      // 不是「选了但没生效」——后者会在那一轮直接抛 THINK_EFFORT_UI_CHANGED。
      effortApplied,
      siteId,
      // 账户槽（0.14.7）：面板据此把「glm」与「glm#2」分成两行，并知道该读哪个目录。
      slot,
      accountKey: slot === DEFAULT_SLOT ? siteId : siteId + '#' + slot,
      // 真实昵称/头像（0.19.4）：只透出**缓存里由 readAccountIdentity 抓到的东西**，
      // 读不到就是 null——界面据此回落成槽名，绝不把槽名当昵称显示。
      accountName: accountIdentity?.name ?? null,
      avatarUrl: accountIdentity?.avatarUrl ?? null,
      accountIdentityAt: accountIdentity?.capturedAt ?? null,
      accountIdentityBasis: accountIdentity?.basis ?? null,
      profileDir: cfg.profileDir,
      // 0.18.0：**用的哪个浏览器**必须可核对。用户要的「零外部依赖、下载插件即可用」
      // 是可以用一次 GET 验证的性质，不该只活在代码里。
      //   · browserSource='bundled' —— playwright 自带的 Chromium（插件自持，推荐）
      //   · browserSource='system'  —— 本机 Edge/Chrome/Brave（兜底）
      //   · browserSource=null      —— 一个都没找到，`ensure()` 会抛可读安装指引
      executablePath: cfg.executablePath || null,
      browserSource: cfg.executablePath
        ? (isBundledChromiumPath(cfg.executablePath) ? 'bundled' : 'system')
        : null,
      // 登录**流程**的阶段（#60）：与上面 `loginState` 的三态**不是同一件事**。
      // 改名后两者互不覆盖：三态回答「结论是否已核验」，本字段回答「这一轮登录
      // 进行到哪一步」。旧实现用同名的 `loginState,` 简写把三态覆盖成 idle，
      // 面板因此永远看不到 verified-in/out/uncertain。
      loginPhase,
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
      // 0.19.75 交付链逐层读数（仅在开启取证时有值；未开启恒为 null）。
      //
      // 为什么必须与 lastActivityAt / domReplyChars **并列但语义不同**：
      // 那两个是末梢诊断读数（「驱动最近有没有动过」「页面 DOM 有多少字」），
      // **不会**告诉我们是哪一层把内容丢了。这里给出逐层计数/哈希，
      // 于是「页面有 2172 字但适配器零事件」能进一步定位到具体层。
      deliveryTrace: deliveryTraceEnabled ? _lastDeliveryTrace : null,
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
      //
      // 0.19.32：这一格现在是**本实例站点合并后**的生效值（站点档优先），与真正投递时
      // 判据用的是同一个函数、同一个入参——读数与行为不可能分叉。
      promptTransport: promptTransportNow(siteId),
      // 站点级覆盖的**存在性**（`null` = 本站点没有覆盖、跟随全局）。
      // 为什么单独报一格：面板要能回答「这个站点到底是自己设的，还是跟随全局的」——
      // 只有合并后的生效值时，用户看到的永远是一个值，无从判断覆盖是否真的存下了。
      // 与 sendGapMsBySlot 的读数口径一致：`null` 与具体值可区分。
      promptTransportSite: promptTransportSiteOverride(siteId),
      // 0.16.9：站点附件禁令的**可核对读数**。0.16.7 加了禁令却没在任何投影里出现，
      // 于是「修复生效没有」在面板与 /status 上都看不出来（attach-status 反而还在
      // 承诺超阈值走附件）。读数是站点事实，放在 status 上与 promptTransport 并列。
      // 0.16.28：拆成静态（ATTACH_FORBIDDEN_SITES）与运行期（attachBlocked，自愈
      // 降级的现场：at/code/total）两格——「为什么这站不走附件」从此一眼可分。
      attachForbidden: attachForbiddenFor(siteId),
      attachForbiddenStatic: ATTACH_FORBIDDEN_SITES.has(siteId),
      // 图片投递读数（0.19.5）：图片失败不再终止整轮，所以这一格是「本轮到底有没有把
      // 图送上去」的唯一凭据。与 attachTransport 并列，两条投递路径各自可核对。
      imageTransport,
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
    return findSystemChromium();
  }

  /**
   * 默认浏览器：**自带 Chromium 优先，系统浏览器兜底**。
   *
   * 顺序的理由：自带的那份是插件能保证存在与版本可控的一份；系统浏览器是
   * 「用户碰巧装了」的运气。让可控的来源优先，才能兑现「下载插件即可用」。
   * 两者都没有时返回 null，由 `launch()` 抛出可读的安装指引（那时确实无解）。
   *
   * @returns {string|null}
   */
  function defaultEdgePath() {
    // 浏览器来源的唯一真相在 browser-runtime.js（面板报状态、缺时安装也读那一份）。
    // 这里只取路径：把「自带优先、系统兜底」的顺序与扫描逻辑留在那边，避免两份实现漂移。
    return resolveBrowserExecutable().path;
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
            // 0.19.75 交付链取证：解码器**吐出的正文**（第 2 层）。
            // 与 capture 层分开记：两者长度不同即说明解码器吃掉了内容。
            active.trace?.note('decoder', t);
            // 0.15.2：「正文真的来了」的独立时刻。它与 lastProgressAt 刻意分开——
            // 思考增量刷新前者、**不**刷新这个。混成一个的话，「一直思考」与
            // 「思考完给出正文」在判据上无法区分，硬上限就永远判不出来。
            active.lastAnswerAt = performance.now();
            active.text += t;
            // 第 3 层：驱动自己累积到的正文（正常与 decoder 逐字相同；
            // 若这里更少，说明驱动侧的过滤/累积逻辑丢了东西）。
            active.trace?.note('driver', t);
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
      // 0.19.75 交付链取证（第 1 层）：**原始上线帧**。
      // 刻意与 decoder 层分开：原始帧含字段名/转义/分帧头，长度与正文**不可比**，
      // 判据见 lib/delivery-trace.js 的 TEXT_STAGES（只比「有没有解出正文」）。
      if (m.text) active.trace?.note('capture', String(m.text));
      if (m.text) active.rawHead = ((active.rawHead || '') + m.text).slice(0, 400);
      // 流**尾**（0.19.45）。只留首段是看不出真因的——真机 2026-09-28 GLM 那轮报错是
      // 「empty response from web AI | 流首段: …"parts":[],"status":"init"…」，
      // 而 `status:"init"` + `parts:[]` 是 **GLM 每一轮的正常开帧**，首段按构造就
      // 永远是它。真因（限流原话 / 审核 / last_error）都在**后面的帧**里。
      // 这里保留**最后一帧**原文，与 rawHead 一起进报错现场。
      if (m.text) {
        const tail = String(m.text);
        active.rawTail = (tail.length >= 400 ? tail : (active.rawTail || '') + tail).slice(-400);
      }
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
    // 0.19.75：在 active 被清掉**之前**冻结交付链读数（snapshot 是冻结语义，
    // 之后再记事件也不会改变已返回的这一份）。放在这里而不是每个收尾分支里：
    // 收尾路径有多条（稳态收束 / DOM 兜底 / 超时 / 中止），逐条写必然漏一条。
    if (a?.trace) {
      try {
        const snap = a.trace.snapshot();
        _lastDeliveryTrace = { ...compareStages(snap), at: Date.now(), settledBy: a.settled_by || null };
      } catch { /* 取证失败绝不影响收尾本身 */ }
    }
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
 * ## 0.19.12 新增第四条：捕获链中断的 DOM 兜底回传
 *
 * 上面三条防线有一个共同前提：**正文要先从流里来过**（bodyReady / decoder 内容）。
 * 真机事故（2026-09-24，session-12d9c3c6）证明这个前提本身会塌：首事件已到之后
 * 「页面 SSE → 页内捕获 → 解码器」管道中断，页面分支照常吃流把回复写完（DOM
 * 1072 字），桥侧 120s 零事件——WIP 稳态收束因 bodyReady 不成立而永不动作，
 * 思考硬上限救出来的还是流里的空内容，唯一结局是适配器看门狗开火、内容整轮丢失。
 *
 * 兜底判据（shouldRescueStalledCapture，纯函数可离线反向验证）：流静默 ≥
 * cfg.captureStallRescueMs（默认 45s，**必须小于适配器看门狗 120s**）+ 本轮 DOM
 * 内容相对发送后基线变过 + DOM 有真实内容 + 页面仍在写或流从未送来过正文。
 * 动作是把剥掉计时文案后的 DOM 文本当 partial 结果交出去——与下方稳态收束同形，
 * runTurn 的部分流落账（recoveredTurns/lastRecovered/noteEndReason）全部复用。
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
      // 采样返回**两件事**：找到了助手节点吗（found）+ 它的文本。
      //
      // 为什么必须区分（0.19.16 真机）：旧实现只返回文本，找不到节点时回空串，
      // 而调用方把「拿到一个字符串」当成「页面可采样」⇒ domAvailable=true。
      // 对 chatglm.cn 选择器实测一个都不命中（real-probe-30-glm-dom.mjs），
      // 于是 lastDomGrowthAt 永不刷新、「DOM 停长」恒成立，收束器只凭流静默
      // 2.5s 就动手——而那一刻解码器还没收到 status:'finish'，内容被丢。
      // found=false 表示「对页面还在不在写零证据」，必须走更宽的窗口。
      let domFound = false;
      try {
        const s = await page?.evaluate?.((sel) => {
          const last = [...document.querySelectorAll(sel)].pop();
          return last ? { found: true, text: (last.innerText || '') } : { found: false, text: '' };
        }, answerSelector);
        if (s && typeof s === 'object') { domText = s.text; domFound = s.found === true; }
        else if (typeof s === 'string') { domText = s; domFound = true; }   // 注入式测试页兜底
      } catch { domText = null; domFound = false; }
      if (active !== a) return;                              // 轮次已结束或被替换
      const domLen = typeof domText === 'string' ? answerDomLength(domText) : null;
      if (typeof domLen === 'number') {
        a.domAvailable = true;
        a.domFound = domFound;
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
        // 0.19.12：兜底基线（语义见 active 声明处）。每拍**重算**而不是置真后保留：
        // 兜底交付的就是这一拍的 domText，「内容变过」必须对**当前**文本成立——
        // 单调置真的话，节点内容理论上回落到基线时会拿着旧文本误交一轮。
        if (a.domTextAtStart == null) a.domTextAtStart = String(domText);
        a.domTextChanged = String(domText) !== a.domTextAtStart;
      } else {
        // 页面取不到（关窗/导航中）：退回「仅流停」判定，并如实标注收束原因。
        a.domAvailable = false;
      }
      const now = performance.now();
      // 0.19.12 捕获停摆兜底：先于 bodyReady 早退判定——要救的恰恰是「正文没从
      // 流里来过」的轮次。签名与动作见 metrics.shouldRescueStalledCapture 的注释；
      // 动作与下方稳态收束刻意同形（partial 结果走同一条 runTurn 落账路径，
      // recoveredTurns/lastRecovered/noteEndReason 全部复用，不新增第二条收尾通路）。
      if (!a.domRescueDone && shouldRescueStalledCapture({
        now,
        lastProgressAt: a.lastProgressAt,
        lastDomGrowthAt: a.lastDomGrowthAt,
        domLen: a.lastDomLen,
        domTextChanged: a.domTextChanged,
        hasStreamBody: Boolean(a.text) || Boolean(a.thinking) || (Array.isArray(a.images) && a.images.length > 0),
        domAvailable: a.domAvailable,
        stallMs: CAPTURE_STALL_MS,
        wipIdleMs: WIP_IDLE_MS,
      })) {
        a.domRescueDone = true;
        const rescuedText = cleanAnswerDomText(String(domText || '')).trim();
        warn(`capture stalled while page still writing — rescuing turn from page DOM `
          + `${rescuedText.length} chars (reason=dom-rescue-capture-stall); `
          + 'stream images are not recoverable this way');
        const result = {
          text: rescuedText,
          thinking: String(a.thinking || ''),
          images: Array.isArray(a.images) ? a.images : [],
          complete: false,
          partial: true,
          reason: 'dom-rescue-capture-stall',
        };
        a.settled_by = 'dom-rescue-capture-stall';
        noteEndReason('dom-rescue-capture-stall');
        const resolve = a.resolve;
        finishActive();
        resolve(result);
        return;
      }
      const bodyReady = Boolean(a.text) || Boolean(a.thinking) || (Array.isArray(a.images) && a.images.length > 0);
      if (!bodyReady) { a.wipTimer = setTimeout(tick, WIP_IDLE_MS); return; }
      // 第四条判据，也是唯一**权威**的那条（0.19.41）：网页自己在流里说了「还在生成」。
      //
      // 前三条全是**推断**（流静默 / DOM 停长 / 只出思考的硬上限），而推断在
      // 「思考阶段正文节点看不到内容」的站点上必然出错。真机现场（kimi，带附件轮）：
      //   wip steady state — settling turn with 0 chars answer / 114 chars thinking
      // 那一轮网页还在思考，是驱动先收束的，正文一个字符都没等到。
      // 而 kimi 的 Connect-RPC 流里每帧都带 `message.status`
      // （MESSAGE_STATUS_GENERATING / COMPLETED）——**有权威信号就不该靠推断**。
      //
      // 为什么仍然保留硬上限：一个永远不说「完成」的站点不能被这里挂死。
      // 上限沿用 `shouldSettleStalledThinking` 的同一把尺子（answerTimeoutMs，
      // 默认 180s），并发一条 warn 留下现场——「等到了上限」与「网页说完成」
      // 必须事后可分辨，否则下一个人无法判断这条判据有没有生效。
      // 无该信号的站点（`isGenerating` 缺省返回 false）行为与 0.19.40 逐字相同。
      if (a.decoder?.isGenerating?.() === true) {
        const waitedSinceAnswer = now - (Number(a.lastAnswerAt) || now);
        if (waitedSinceAnswer < cfg.answerTimeoutMs) {
          a.wipTimer = setTimeout(tick, WIP_IDLE_MS);
          return;
        }
        warn('web page still says GENERATING after ' + Math.round(waitedSinceAnswer / 1000)
          + 's with ' + String(a.text || '').length + ' chars answer — settling anyway (hard cap '
          + Math.round(cfg.answerTimeoutMs / 1000) + 's)');
      }
      // 第三条判据优先判定：它不需要 DOM，也不被思考增量推迟。
      const stalled = shouldSettleStalledThinking({ now, lastAnswerAt: a.lastAnswerAt, hardCapMs: cfg.answerTimeoutMs });
      if (!stalled && !shouldSettleWip({
        now,
        lastProgressAt: a.lastProgressAt,
        lastDomGrowthAt: a.lastDomGrowthAt,
        domAvailable: a.domAvailable,
        // 第三态（0.19.16）：页面在、但**认不出哪条是助手回复**（选择器对本站
        // 点瞎）。此时对「页面还在不在写」零证据，必须走更宽的窗口才允许收束，
        // 否则 GLM 那类站点会只凭「流静默 2.5s」被腰斩。
        domFound: a.domFound !== false,
        wipIdleMs: WIP_IDLE_MS,
        domBlindMs: DOM_BLIND_MS,
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
      // 0.18.0：进程名**不能写死 `msedge.exe`**。浏览器来源改成「自带 Chromium 优先」
      // 之后，实际跑的是 `chrome.exe`（playwright 的 Chromium）；只按 msedge 过滤会
      // 一个都匹配不到，孤儿进程留在那里持有 profile 单实例锁 —— 表现为下一次
      // launch 报 ProcessSingleton/SingletonLock，而自愈路径恰好也依赖这个函数。
      // 这里按**可执行文件名**取，同时覆盖 Edge / Chrome / Brave / Vivaldi / Chromium。
      const exeName = path.basename(String(cfg.executablePath || 'msedge.exe'));
      const safeName = exeName.replace(/'/g, "''");
      const script =
        `$procs = Get-CimInstance Win32_Process -Filter "Name='${safeName}'" | ` +
        `Where-Object { $_.CommandLine -like '*${dir}*' }; ` +
        `foreach ($p in $procs) { Invoke-CimMethod -InputObject $p -MethodName Terminate | Out-Null; Write-Output $p.ProcessId }`;
      const out = child_process.execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 30_000, encoding: 'utf8' });
      const pids = out.split(/\s+/).filter(Boolean);
      if (pids.length) warn(`killed orphan browser (${exeName}) for profile via WMI (pids: ${pids.join(', ')})`);
      setTimeout(() => clearStaleProfileLocks(), 500);
    } catch (err) { warn('orphan browser kill failed:', err?.message); }
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

  // ── 「下载插件即可用」的最后一块（0.18.0）─────────────────────────────────
  //
  // 用户要求（2026-09-22，逐字）：「直接复制过来 chrom 核做到只用下载本插件就能实现」
  // 「尽量对应本插件外的少干扰少依赖，确保人人下载安装可用本插件所有功能」。
  //
  // 426 MB 的 Chromium 打不进 npm 包（当前 tarball 543 KB），因此兑现方式是
  // **缺的时候自己下**。设置页的「下载浏览器」按钮是**可选加速入口**，不是唯一入口：
  // 新用户第一次点「连接 / 登录」走的正是 launch —— 那一刻若只抛一句「请手动执行
  // CLI 命令」，他看到的仍然是「插件不能用」。所以补齐动作必须在 launch 里。
  //
  // 并发保护：同一次下载在进程内复用（与 web-control 的 browserInstallPromise 同族）。
  // 两个面板同时触发时不该下两份、更不该写坏同一个下载目录。
  let autoInstallPromise = null;

  /**
   * 确保有一个可用的浏览器可执行文件；没有就自己下。
   *
   * @returns {Promise<string>} 可执行文件绝对路径
   * @throws {Error} 下载也失败时抛出，错误里带**真实原因**（code + 输出尾部）
   */
  async function ensureExecutable() {
    if (cfg.executablePath) return cfg.executablePath;
    // 再解析一次：用户可能刚在设置页点过「下载浏览器」，或本机新装了浏览器。
    // 构造时算的那一次不该成为永久判决。
    const again = resolveBrowserExecutable();
    if (again.path) { cfg.executablePath = again.path; return cfg.executablePath; }
    if (!autoInstallPromise) {
      warn('未找到任何浏览器 —— 正在下载插件自带 Chromium（仅一次，约 150 MB）…');
      autoInstallPromise = installBundledChromium({ timeoutMs: 10 * 60_000 })
        .finally(() => { autoInstallPromise = null; });
    }
    const res = await autoInstallPromise;
    const after = resolveBrowserExecutable();
    if (after.path) {
      cfg.executablePath = after.path;
      log('自带 Chromium 就绪：' + after.path + '（revision ' + after.revision + '）');
      return cfg.executablePath;
    }
    // 下载失败：报真实原因，不报「安装失败」这种没法排查的话。
    throw new Error('未找到可用的浏览器，自动下载也失败了（' + (res?.code || 'unknown') + '）：'
      + String(res?.output || '').slice(-400)
      + ' —— 可在设置页点「下载浏览器」重试，或在设置里指定 executablePath');
  }

  async function launch({ headless } = {}) {
    await ensureExecutable();
    fs.mkdirSync(cfg.profileDir, { recursive: true });
    // 0.19.18 用户准则（2026-09-26 原话「同一账号不能同时桥接运行！」）：
    // 启动浏览器**之前**先拿账号级互斥锁，被拒就当场报错。
    //
    // 为什么必须在 launch 之前、而不是靠 Chromium 自己的 SingletonLock：
    // 那一道的失败形态是「抛 ProcessSingleton + 本文件的 killOrphanEdgeForProfile
    // 按 profileDir 杀掉对方浏览器」——两个桥会**互相杀**，表现为随机超时与
    // 登录态丢失，用户完全看不出原因。本锁给出的是「谁占着、怎么办」的明确拒绝。
    //
    // 一次性语义：只在这一轮 launch 里尝试；拿到后由 close() 释放（见 releaseBridgeLock
    // 的调用点）。失败即抛，绝不自愈式重试——重试就等于绕过这条准则。
    if (!accountLock.held) {
      const got = acquireBridgeLock(cfg.profileDir, {
        siteId, accountKey, startedAt: PROCESS_STARTED_AT,
      }, { logger: console });
      if (!got.ok) {
        // 0.19.22：报错里必须带上**存活读数**与**锁文件路径**——用户最先想知道
        // 「那个 pid 到底还在不在」，以及「我能不能自己清掉它」。判据只会在
        // 确认持有者活着时给出 held，因此这里传 true。
        // 0.19.71：`recoverable`（锁过期但 pid 仍活着）必须一并透传——那是
        // 「原持有者跑了很久」与「pid 被无关进程复用」无法区分的那一种，
        // 文案要说清两种可能，而不是让用户面对一句无从下手的拒绝。
        const err = new Error(describeBridgeLockHolder(got.holder, siteId, accountKey, {
          alive: true, lockPath: got.path, recoverable: got.recoverable === true,
        }));
        withWebcodeCode(err, 'BRIDGE_ACCOUNT_BUSY');
        err.bridgeLock = got;
        warn(err.message);
        throw err;
      }
      accountLock.held = true;
      accountLock.path = got.path;
    }
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
      // ctx 真死了 = 浏览器整个退出（用户 X 掉了窗口，或进程崩溃）。「有头」这一
      // 形态随之终结——不把 headed 复位的话，下一次 ensure() 会按 cfg.headless 重启
      // 无头浏览器，而 headed 仍写 true，openWindow 于是跳过「无头→有头」的转换
      // 分支，在一个无头浏览器上跑有头逻辑：窗口永远不出现（见 windowMinimized
      // 声明处的收尾说明）。
      ctx = null; page = null; headed = false; windowMinimized = false;
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
        requestMetadata = summarizeRequestMetadata(body);
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
      // ① 首选：原生 value setter + input 事件（0.19.5）。
      //    这是本轮「长文本桥接失败」的根因修复，真机读数如下（同一台机器、同一个
      //    DeepSeek composer，只写不发送）：
      //
      //      | 写入量  | 逐块 insertText（旧实现） | 原生 setter |
      //      | ---    | ---                     | ---        |
      //      | 100k   | 4.5s                    | 10ms       |
      //      | 200k   | 16s                     | 15ms       |
      //      | 400k   | **72s**                 | **28ms**   |
      //      | 800k   | （未测，按 O(n²) 外推 >5min） | **57ms** |
      //
      //    逐块路径的代价是 O(n²)：每插一块都要让网页重新处理整段已写文本，且
      //    `page.keyboard.insertText` 每块都是一次跨进程往返。400k 时 72 秒已经
      //    逼近链路里最小的那条预算（适配器看门狗首字节相位窗口 216s 的 1/3，
      //    而整轮 240s 预算还要留给网页 prefill 与生成）——真机上表现为「长文本
      //    一轮卡很久然后超时」，正是用户报的「长文本桥接失败」。
      //
      //    为什么这条路是**安全**的（不是把判据绕过去）：
      //      · 时序已验证：写后**立即**回读长度就等于请求长度，等 500ms 再读仍然相等
      //        —— React 受控组件没有用旧 state 回写覆盖；
      //      · 元素无 maxLength（真机读数 `maxLength:-1, hasMaxLengthAttr:false`），
      //        因此「原生 setter 绕过 maxLength」这一风险在该站点上不存在；
      //      · 写入后**照旧**走下面的 readComposer 回读校验，长度对不上仍然抛
      //        PROMPT_TRUNCATED（那才是「网页端真的截断」的判据，不因写入方式而放宽）。
      //    ② 原生路径拿不到长度（元素形态不同 / setter 被覆写）→ 回落既有分块路径，
      //       保持对不认识的站点与富文本形态零位移。
      const native = await writeFieldNative(locator, text);
      if (native === text.length) return { kind, wrote: native };
      if (native >= 0) {
        warn('native composer write returned ' + native + '/' + text.length
          + ' chars — falling back to chunked write');
      }
      if (plan.mode === 'single') { await locator.fill(text); return { kind, wrote: text.length }; }
      return { kind, wrote: await writeFieldChunked(locator, text, plan.chunkChars) };
    }
    // contenteditable：fill() 在部分富文本编辑器上不触发框架的 input 事件
    // （tiptap/ProseMirror 靠 beforeinput/input 维护内部文档），因此先聚焦、
    // 清空既有内容，再用键盘级插入——这是与真人输入最接近的路径。
    await locator.click({ timeout: 10_000 }).catch(() => {});
    await locator.focus().catch(() => {});
    try { await page.keyboard.press('Control+A'); await page.keyboard.press('Delete'); } catch { /* 空框 */ }
    //
    // ## 0.19.41：不再分块，改**一次性 insertText**（真机 kimi 的主因修复）
    //
    // 旧实现在 `plan.mode === 'chunked'` 时逐块 `insertText`。真机取证
    // （.tmp-probe/kimi/RESULT.md，2026-09-27，副本 profile、产品同源路径）证明
    // **分块本身才是在 kimi 上丢内容的原因**，而不是网页的输入框上限：
    //
    //   | 写入方式 | 写入 | 回读 | 丢失 |
    //   | --- | --- | --- | --- |
    //   | 单次 insertText | 8,000 / 16,000 / 20,158 / 38,807 | 逐字相等 | **0** |
    //   | 单次 insertText | 50,000 / 100,000 / 200,000（中文+换行） | 逐字相等 | **0**（43/94/167ms）|
    //   | 分块 20,000+18,400（含换行） | 38,400 | **20,002** | 尾部 18,398 |
    //   | 分块 20,000+18,400（纯 ASCII） | 38,400 | 38,400 | 0 |
    //   | 分块 10,000+10,000（含换行） | 20,000 | **10,060** | 尾部 |
    //
    // 关键读数：块间间隔 0 / 100 / 300 / 600 / 1000 / 2000 / 4000ms **七档结果完全一致**，
    // 插入后 4 秒轨迹也稳定 ⇒ 「等一等再写」救不了它，只有一次性写入可靠。
    // 用户报的 `PROMPT_TRUNCATED: 20158/38807` 正是「第一块写进去了、第二块几乎全丢」
    // 的读数（kimi-probe 用产品路径复现为 `20012/38025`，说明它不是站点常量）。
    //
    // 为什么这个改动对其它富文本站点是**安全**的：单次插入是**更少**的框架事件、
    // 更接近真人粘贴，且成本与长度近线性（200k = 167ms）。真机已知的写不进去的形态
    // 仍由「写后回读 + PROMPT_TRUNCATED」兜底，行为可见、不静默。
    await page.keyboard.insertText(text);
    // 回读校验仍由调用方（fillComposer 之后的 readComposer）负责——写入方式变了，
    // 「网页端有没有截断」的判据一字未变。
    return { kind, wrote: text.length };
  }

  /**
   * 表单控件（textarea/input）的**原生写入**：value setter + input 事件。
   *
   * 返回实际写入长度；任何一步拿不到可信结果就返回 -1（由调用方回落分块路径）。
   * 为什么不用 `locator.fill()`：Playwright 的 fill 对超长文本会在网页侧整段卡住
   * （真机会话 turn/end 里留着 80 万字符 30s 超时的现场，见 fillComposer 注释），
   * 而 setter 是**同步**的，写入成本与文本长度基本无关（实测 800k = 57ms）。
   *
   * 关键细节：必须用 `HTMLTextAreaElement.prototype` 上的**原生** setter。React 会
   * 在元素实例上重定义 value 属性来做受控绑定，直接 `el.value = text` 只会更新 React
   * 的内部记录、不触发它的 onChange；原生 setter 之后补一个冒泡的 `input` 事件，
   * React 才会真正把这段文本收进 state（真机已验证：写后立即回读长度相等，等 500ms
   * 再读仍相等，没有回滚）。
   */
  async function writeFieldNative(locator, text) {
    try {
      return await locator.evaluate((el, v) => {
        const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (!desc || typeof desc.set !== 'function') return -1;
        desc.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value.length;
      }, text);
    } catch { return -1; }
  }

  /**
   * textarea/input 的分块写入（**回落路径**）。
   *
   * 0.19.5 起它不再是首选：首选是 `writeFieldNative`（同步、O(1) 量级）。这条路径
   * 保留给「原生 setter 拿不到」的形态，并继续承担两项它在行内特有的职责：
   *   · 每块后回读长度 → 停滞判定（PROMPT_WRITE_STALLED，带已写/总长/元素现场）；
   *   · 真机已知它会随长度平方级变慢，因此只在原生路径失败时才走。
   *
   * 第一块用 `fill`（它会先清空，语义最干净），后续块用键盘级 `insertText`
   * ——对 textarea 也成立，且不会像 `fill` 那样每次都重建整个值。
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
    withWebcodeCode(err, 'PROMPT_WRITE_STALLED');
    err.scene = scene;
    return err;
  }

  /** 回读 composer 里的文本，用于「网页端有没有截断」校验。
   *  表单控件读 value；contenteditable 读**块感知文本**（见 EDITOR_BLOCK_TEXT）。
   *
   *  ## 0.19.78：contenteditable 从 `innerText` 改成块感知读取（doubao 真机修出）
   *
   *  真机实证（doubao/tiptap，2026-10-14，只写不发送）：
   *
   *  | 写入（17 字） | `innerText` | `textContent` | 块感知 |
   *  | --- | --- | --- | --- |
   *  | `[本地工具传输协议]\n请回复：收到` | **18**（`\n`→`\n\n`） | **16**（换行被吞） | **17 ✓** |
   *
   *  tiptap 把**每个换行**渲染成一个 `<p>`，于是 `innerText` 在两个块之间补出两个换行
   *  （`a\nb` ⇒ `<p>a</p><p>b</p>` ⇒ innerText `a\n\nb`），而 `textContent` 完全不补。
   *  ⇒ **两个浏览器内建读数都不等于写入内容**，`composerEchoVerdict` 必然报
   *  `content-mismatch` ⇒ **每一轮含换行的提示词都被 `PROMPT_TRUNCATED` 拦住**
   *  （DSH 的真实轮次必然含换行 ⇒ 这是 doubao 全线不可用的量级；
   *   kimi 真机同样是 18/16 两种错读，同一根因）。
   *
   *  **修读取，而不是放宽判据**：`composerEchoVerdict` 的白名单一个字都没动
   *  —— 真正的截断在块感知读取下**依然**不等，照旧被拦住。
   */
  async function readComposer(locator) {
    const kind = await composerKind(locator);
    if (kind === 'field') return await locator.inputValue().catch(() => null);
    return await locator.evaluate(EDITOR_BLOCK_TEXT).catch(() => null);
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
  /**
   * 「网页会话正文」节点选择器（transcript）——用来把**正文里的同名文本**排除出附件证据。
   *
   * ## 为什么必须有它（2026-09-24 真机取证，本判据的由来）
   *
   * 旧 `filenameEvidence` 扫的是 `document.querySelectorAll('body *')` 全页，只加两道
   * 过滤（文本长度 ≤ 文件名 + 80、取最深命中）。这两道**挡不住「同名文本出现在正文
   * 里」**——而本桥自己的投递指令就写着 `webcode-context.md` 这个名字，于是从第二轮起
   * 判据恒为真。真机读数（`POST /__webcode/attach-probe`）：
   *
   *   `nameHit: { tag: 'code', cls: '', snippet: "<code>ok:true, evidence:'text:webcode-probe.md'</code>" }`
   *   同时 10 条类名候选**全部 count:0、visible:0**
   *
   * 即「附件节点一个都没出现，却报了 ok:true」。后果是最坏的一种：文件真没上去，桥报
   * 成功，正文被替换成一句「请先读取该附件全文」——模型只能说看不到附件。
   *
   * ## 判据为什么长这样（同一轮真机实测的层高读数）
   *
   * 从 textarea 逐层往上测「是否含真附件 chip / 是否含正文节点」：
   *
   * | 层 | 节点 | 含附件 chip | 含正文 |
   * | --- | --- | --- | --- |
   * | 2 | `div._020ab5b`（含文件入口） | 0 | 0 |
   * | 5 | `div._871cbca` | **2** | **0** |
   * | 6 | `div.ds-virtual-list…` | 2 | **3** |
   *
   * ⇒ **composer 作用域 = 从输入框往上、最高的「含文件入口且不含正文节点」的祖先**
   * （这里是第 5 层）。它同时满足两件事：包含真 chip、排除正文里的假阳性。
   * 这条判据**不依赖任何站点类名**（类名是构建期哈希、随发版变化），只用
   * 「谁是输入框的祖先」与「谁含正文」两个结构事实。
   */
  const TRANSCRIPT_SELECTOR = ".ds-markdown, .markdown, [data-message-author-role], [data-role='assistant'], [data-role='user']";

  async function filenameEvidence(name) {
    if (!String(name || '')) return null;
    const e = await pageAttachEvidence(name);
    return e.nameHit;
  }

  /**
   * composer 作用域 + 附件证据的**唯一**页内取样函数（0.19.5）。
   *
   * 为什么必须只有一个：本仓库反复记过「同一个判断写两份，一份改了另一份没改」。
   * 附件证据有三个消费点（`waitForAttachment` 的确认、`attachEvidenceDiag` 的失败
   * 现场、`cleanupAttachment` 的清理回读），三者必须用**同一套**判据，否则会出现
   * 「探针说有附件、投递说没有」这种自相矛盾的现场。
   *
   * 判据与真机依据见 `TRANSCRIPT_SELECTOR` 与 `filenameEvidence` 上方注释。
   */
  async function pageAttachEvidence(name) {
    const target = String(name || '');
    const sels = attachCandidates();
    // 判定主体**只有一份**：lib/attach-scope.js 的 pickAttachEvidence。这里把它以源码
    // 字符串注入浏览器执行，因此「页面里跑的那份」与「护栏驱动的那份」逐字同一。
    // 为什么不在这里内联写：内联那份无法被单测真正驱动，护栏只能查字符串是否存在——
    // 反向验证证明那种护栏是装饰品（把过滤条件短路掉仍然全绿，见 attach-scope.js 头注）。
    return page.evaluate(({ NAME, MAX, T_SEL, INPUT_SEL, sels, PICK_SRC, STEM_FB }) => {
      // eslint-disable-next-line no-new-func
      const pick = new Function('return (' + PICK_SRC + ')')();
      const input = document.querySelector(INPUT_SEL);
      const ta = [...document.querySelectorAll('textarea')]
        .find((e) => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 0; }) || input;
      return pick({ doc: document, input, ta, name: NAME, max: MAX, transcriptSel: T_SEL, sels, stemFallback: STEM_FB });
    }, {
      NAME: target,
      // 长度尺度必须覆盖**两把尺子中较长的那次匹配**：stem 命中时节点的 textContent
      // 上限是 stem.length + 80，而 stem 可能比完整名短一大截（`a.md` vs `a`），
      // 只按完整名算会把合法的 stem 命中拒掉。两个候选取大值即可。
      MAX: (target || '').length + 80,
      T_SEL: TRANSCRIPT_SELECTOR, INPUT_SEL: contract.attachSelector || "input[type='file']", sels,
      PICK_SRC: ATTACH_PICK_SRC,
      // 0.19.41：允许按去扩展名的 stem 再试（kimi 的附件卡只渲染 stem，真机读数见
      // attach-scope.js 的注释）。默认开着：它只增加「能确认」的情形，且仍受
      // 作用域 + 正文排除 + 长度三道闸约束。
      STEM_FB: true,
    })
      .catch(() => ({ candidates: [], nameHit: null, domSnippet: null, scoped: false, scopeDesc: null, transcriptNodes: -1 }));
  }

  /** 轮询等待附件在页面上出现。返回命中的选择器（文件名证据返回 `text:<name>`），或 null（超时）。
   *
   * `name` 是**本轮真正上传的文件名**：传了它才会启用文件名证据（见 filenameEvidence）。
   * 不传（图片轮）时行为与 0.16.2 逐字相同——只认类名清单，不动图片轮已确认过的路径。 */
  async function waitForAttachment(timeoutMs = 15_000, { name = null, allowCandidates = true } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // 一次取样同时回答两件事：类名候选命中（作用域内计数）与文件名证据。
      // 不再分成「Playwright locator 逐个试」+「evaluate 扫全页」两条路径——
      // 那两条用的判据不同（一个看可见性、一个扫全页文本），正是假阳性的温床。
      //
      // 0.19.9：`allowCandidates:false` 给**文本附件**用。类名候选只看「输入区里有
      // 可见附件节点」，**分不出是谁的**：带图轮里图片的 `img[src^='blob:']` 会立刻
      // 命中，于是刚 setInputFiles 的 .md 即便没落地也会被判「已确认」——
      // 一个真实的假阳性陷阱。文本附件的证据因此必须是**文件名本身**
      // （`text:<name>`）：名字是我们传给 setInputFiles 的，出现在 composer 作用域里
      // 只有一种解释。图片那条仍保留候选兜底（`uploadImages` 的既有行为）。
      const e = await pageAttachEvidence(name);
      if (allowCandidates) {
        const cand = (e.candidates || []).find((c) => c.visible > 0);
        if (cand) return cand.sel;
      }
      if (name && e.nameHit) return 'text:' + name;
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
   *
   * **判据与确认路径同源（0.19.5）**：本函数直接复用 `pageAttachEvidence` 的返回。
   * 0.19.4 及以前这里另写了一份「扫全页、不排除正文」的取样——于是探针能拿到的
   * 假阳性（正文里的同名 `<code>`）与投递路径**各写各的**，这正是本仓库记过多次的
   * 「同一个判断写两份，一份改了另一份没改」。
   */
  async function attachEvidenceDiag(name) {
    const e = await pageAttachEvidence(name);
    return {
      candidates: e.candidates || [],
      nameHit: e.nameHit ? { ...e.nameHit, snippet: String(e.nameHit.snippet || '').slice(0, 200) } : null,
      domSnippet: e.domSnippet ?? null,
      scoped: e.scoped === true,
      scopeDesc: e.scopeDesc ?? null,
      transcriptNodes: e.transcriptNodes ?? null,
    };
  }

  /**
   * 把图片作为附件上传，**等页面给出可见证据**才放行。
   *
   * 0.19.10：证据等待窗口从 15s 提到 **90s**。真机取证（2026-09-24，用户那张
   * 1086×1425 / 942,941 字节的图）：同一张图、同一条路径，一次 `imageTransport.ok=true`
   * 端到端 **37 秒**，而用户自己那次跑出了
   * `⚠ 图片未能附加到网页（ATTACH_NOT_CONFIRMED）`（见 webcode-bridge-replies.log）。
   *
   * 判据被读错了：15s 不是「上传失败」，是**「还没渲染出缩略图」**。DeepSeek 的
   * 客户端缩略图（`img[src^='blob:']`）要等它的上传/压缩流程走完才出现，而图片越大
   * 越久——942KB 那张在真机上就是几十秒量级。窗口一到就报 ATTACH_NOT_CONFIRMED，
   * 于是**该轮静默退化成纯文本**（用户看到的正是「有图片但加载不出来 / 图没上去」）。
   *
   * 为什么加长不会让正常轮次变慢：证据一出现就 return，等待窗口只决定**失败**时
   * 等多久。而上传入口本身在 setInputFiles 前就查过（缺入口立刻抛 ATTACH_UNAVAILABLE），
   * 所以这里等的是「网页自己的上传完成」，不是网络重试。
   */
  async function uploadImages(files, { timeoutMs = 90_000 } = {}) {
    const fi = page.locator(contract.attachSelector || "input[type='file']").first();
    if (!await fi.count()) {
      const err = new Error('ATTACH_UNAVAILABLE: 页面没有可用的文件上传入口');
      withWebcodeCode(err, 'ATTACH_UNAVAILABLE');
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
    //
    // 0.19.5：**图片轮也必须给名字证据**。旧实现调用时 `name` 缺省为 null，只剩
    // 类名清单这一条路，而该清单在 DeepSeek 上真机零命中（见 ATTACH_PREVIEW_FALLBACK
    // 的 2026-09-17 反证）——等于图片附件在 DeepSeek 上永远确认不了。文件名是我们
    // 自己传给 setInputFiles 的，出现在**composer 作用域内**只有一种解释：网页收到了
    // 这个文件并渲染了它（判据与作用域定义见 pageAttachEvidence）。
    // 多图时逐个试：任一张确认即算上传成功（各图共享同一个 composer 作用域）。
    const deadline = Date.now() + timeoutMs;
    let hit = null;
    for (;;) {
      const e = await pageAttachEvidence(null);
      const cand = (e.candidates || []).find((c) => c.visible > 0);
      if (cand) { hit = cand.sel; break; }
      for (const p of payloads) {
        const one = await pageAttachEvidence(p.name);
        if (one.nameHit) { hit = 'text:' + p.name; break; }
      }
      if (hit) break;
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(250);
    }
    if (!hit) {
      const diag = await attachEvidenceDiag(payloads[0]?.name || null);
      const err = new Error('ATTACH_NOT_CONFIRMED: 已选择 ' + payloads.length
        + ' 个文件，但 ' + Math.round(timeoutMs / 1000) + 's 内页面上没有出现附件'
        + '（网页可能拒绝了该格式/大小，或上传入口与预览节点都已改版）');
      withWebcodeCode(err, 'ATTACH_NOT_CONFIRMED');
      // 现场挂到 err 上，由调用点原样写进读数——只 warn 到控制台等于没有读数。
      err.attachDiag = diag;
      throw err;
    }
    return { attached: payloads.length, evidence: hit, names: payloads.map((p) => p.name) };
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
  // 0.19.10：与 uploadImages 同一口径 —— 20s 也把「网页还在处理」读成了「失败」。
  // 文本附件更小、通常更快，但 85k 字符的真实投递在真机上也是几十秒量级
  // （2026-09-24 实测 53s 端到端），因此同样给足窗口。
  async function uploadTextAttachment(text, { timeoutMs = 90_000, name = 'webcode-context.md' } = {}) {
    const fi = page.locator(contract.attachSelector || "input[type='file']").first();
    if (!await fi.count()) {
      const err = new Error('ATTACH_UNAVAILABLE: 页面没有可用的文件上传入口');
      withWebcodeCode(err, 'ATTACH_UNAVAILABLE');
      throw err;
    }
    const body = String(text ?? '');
    await fi.setInputFiles([{ name, mimeType: 'text/markdown', buffer: Buffer.from(body, 'utf8') }]);
    // 0.19.9：文本附件的证据只认**文件名**，不认类名候选——带图轮里图片的 blob 节点
    // 会让候选判据立刻命中，把「.md 没落地」误判成成功（见 waitForAttachment 注释）。
    const hit = await waitForAttachment(timeoutMs, { name, allowCandidates: false });
    if (!hit) {
      // 失败必须带现场：真机 0.16.3 的那次失败只留下 `ATTACH_NOT_CONFIRMED` 一个码，
      // 事后既看不出「网页压根没收」还是「收了而选择器没认出来」，也就无法判断该
      // 改证据判据还是该改上传方式。现场同时挂到 err.attachDiag 上，由 runTurn
      // 原样写进 attachTransport（进 /__webcode/status，面板可读）。
      const diag = await attachEvidenceDiag(name);
      const err = new Error('ATTACH_NOT_CONFIRMED: 已选择附件 ' + name + '，但 '
        + Math.round(timeoutMs / 1000) + 's 内页面上没有出现附件'
        + (diag?.domSnippet ? ' — 现场 DOM：' + diag.domSnippet : ''));
      withWebcodeCode(err, 'ATTACH_NOT_CONFIRMED');
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
   *
   * ## 0.19.32：站点级覆盖（与「发送间隔」逐字同构的一条链）
   *
   * 用户要求「提示词投递：给每个模型站点都做到和『发送间隔（全局）』一样的逻辑：
   * 全局设置一个，但是针对每个单独网站设置能够单独设置」。发送间隔那条链是
   * `accounts.sendGapForSlot`：**槽显式值 → 站点级键 → 全局值**。这里逐字照搬成
   * **站点显式值 → 全局设置 → 插件 config → 'attach'**。
   *
   * 为什么不在驱动里查 `promptTransportBySite[siteId]` 而要多一个读取函数：驱动读的是
   * **本实例的站点**，而设置命名空间的形状（哪个键、怎么归一化）属于控制面。驱动只认
   * 「给我一个取值函数」这一条契约，于是「站点级键的归一化规则」在写入侧（web-control）
   * 只有一份，这里不再抄第二遍。
   *
   * 兼容性硬约束：没有 `getPromptTransportForSite` 时必须**逐字**走旧的
   * `getPromptTransport`。既有护栏（test/settings-transport.test.mjs ③）正是用后者钉
   * 「每次现读、不是构造期快照」，那条语义不能因为新增一档而改变。
   *
   * @param {string|null} siteId 本实例的站点；缺省（老调用点）只读全局那一档
   */
  /**
   * 本站点**显式**的投递形态覆盖；没有覆盖时返回 `null`（跟随全局）。
   *
   * 只回答「有没有覆盖、覆盖成什么」，不做回落——回落是 `promptTransportNow` 的事。
   * 拆成两个函数是因为它们的**消费者不同**：`promptTransportNow` 的返回值喂给判定层
   *（决定这一轮走附件还是纯文本），本函数的返回值喂给读数层（面板要能显示「跟随全局」
   * 与「已覆盖为纯文本」两种状态，而这两种状态合并后就只剩一个值，看不出区别）。
   *
   * 非法值一律视同「没有覆盖」（返回 `null`）而不是返回一个非法值：设置文件可手改，
   * 写错的配置只许退化成「跟随全局」，不许变成第三种谁也没定义过的口径。
   */
  function promptTransportSiteOverride(siteId) {
    if (!siteId || typeof options.getPromptTransportForSite !== 'function') return null;
    try {
      const raw = options.getPromptTransportForSite(siteId);
      return raw === 'inline' || raw === 'attach' ? raw : null;
    } catch { return null; }
  }

  function promptTransportNow(siteId = null) {
    let raw;
    try {
      if (siteId && typeof options.getPromptTransportForSite === 'function') {
        raw = options.getPromptTransportForSite(siteId);
      } else {
        raw = typeof options.getPromptTransport === 'function' ? options.getPromptTransport() : options.promptTransport;
      }
    } catch { raw = options.promptTransport; }
    // 站点档与全局档都只认这两个字面量；其余（含读取函数抛错后的 undefined）一律
    // 落回全局那一档，全局也不合法才退到 'attach'。
    if (raw === 'inline' || raw === 'attach') return raw;
    let global;
    try {
      global = typeof options.getPromptTransport === 'function' ? options.getPromptTransport() : options.promptTransport;
    } catch { global = options.promptTransport; }
    return global === 'inline' ? 'inline' : 'attach';
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
    // 回读用与确认路径**同一个**判据：清理成功的定义就是「那条证据不再命中」。
    // 旧实现用 filenameEvidence，而它当时扫全页——正文里写着这个名字时清理会永远
    // 报 cleaned:false（真机探针读数 `cleanup: no-delete, still: true`），用户看到
    // 的却是「探针没清干净」。判据收紧后这一条自动一致。
    const gone = async () => !(await filenameEvidence(name));
    try {
      if (await fi.count()) await fi.setInputFiles([]);
    } catch { /* 清空失败照样走下面的回读与 ② */ }
    if (await gone()) return { cleaned: true, cleanedBy: 'input-cleared' };
    const clicked = await page.evaluate(({ NAME, MAX, T_SEL }) => {
      // 附件 chip 的最深命中节点（真机实拍：`<div class="e70accd6">webcode-probe.md</div>`）。
      // 它自己就是 chip 的文本节点，**删除控件不一定在它的祖先里**——所以下面
      // 除了沿祖先链找，还要横向找兄弟（见 `roots`）。
      //
      // 0.19.5：**必须排除正文节点**。旧实现扫全页，于是「正文里写着这个文件名」时
      // 它会去点正文里的那个节点旁边的控件——那可能是复制按钮、引用按钮，甚至无关链接。
      // 这正是真机探针读数 `cleanup: no-delete` 之后仍然报「没清干净」的一半原因。
      const hits = [...document.querySelectorAll('body *')].filter((el) => {
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'INPUT' || tag === 'TEXTAREA') return false;
        try { if (el.closest(T_SEL) !== null) return false; } catch { /* 选择器不支持：按旧行为 */ }
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
    }, { NAME: String(name || ''), MAX: 200, T_SEL: TRANSCRIPT_SELECTOR }).catch(() => null);
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

  async function runTurn(message, { navigate, key = null, signal, onDelta, onThink, onImage, model, images, thinkMode, searchMode = 'auto', siteMode = null, reasoningEffort = null } = {}) {
    if (busy || transitioning) throw new Error('driver busy');
    busy = true;
    let timer = null;
    let stopClick = null;
    let attachEvidence = null;   // 本轮图片上传的确认结果 { attached, evidence }
    // 本轮图片投递读数写的是**驱动级** imageTransport（见上方声明）——status() 在另一个
    // 闭包，这里若再声明一个同名的局部量，就会把它遮住：status 读不到本轮结果，
    // 而局部量在函数返回后即消失。0.19.5 首版正是这样写错的。
    imageTransport = null;
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
          withWebcodeCode(err, 'NEED_LOGIN');
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
        //
        // ⚠ 这一支**不能**引用 `nav`（0.15.2 起的真实缺陷，2026-09-26 修）：`nav` 是
        // `conversationNav()` 的返回值，只存在于 `sendTurn` 的作用域里；`runTurn`
        // 收到的是**已经解好的** `navigate` 字符串（'fresh' 或目标 URL），两者不是
        // 同一个作用域。原写法 `${nav.reason || 'n/a'}` 在本行必然抛
        // `ReferenceError: nav is not defined`。
        //
        // 为什么能潜伏这么久：`attempt=0` 时不进这一支，第一次导航失败走的是正常
        // 重试路径；**只有第二次仍不 ready 才踏进来**，而那正是「页面冷加载慢」的
        // 常见现场。此时抛出的 ReferenceError 被外层当成普通失败，用户看到的是
        // 「这一轮模型整个没回复」（GLM 现场逐字为 `assistant/attempt` 直接
        // finish(error): `nav is not defined`），而不是「重试了一次仍然失败」——
        // 归因方向被彻底带偏。`node --check` 抓不到它（语法合法，作用域非法），
        // 因此护栏必须做**作用域走查**而不是语法检查。
        //
        // 诊断信息改用本作用域真实持有的 `target`（本轮要导航回去的会话 URL）：
        // 同样是可复核的现场，且不依赖任何外层变量。
        //
        // ⚠ 同族的第二例（0.19.33 修）：等待重试间隔原先写的是 `await sleep(1500)`，
        // 而 `sleep` 只存在于本文件的 `DOM_CAPTURE` **注入模板串**里（那是浏览器侧
        // 执行的代码），Node 模块作用域没有这个绑定 ⇒ 这一行必然抛
        // `ReferenceError: sleep is not defined`。触发条件与上面 `nav` 那一例**完全
        // 相同**（`attempt=0` 不进这一支，只有第一次导航就没 ready 才踏进来，
        // 而那正是页面冷加载慢的常见现场），所以用户看到的现象也逐字相同：
        // 「GLM 这一轮整个没回复」。
        //
        // 为什么护栏第一次没抓到它：`test/driver-scope.test.mjs` 的绑定表是用**原始
        // 源码**上的正则建的，模板串里那句 `const sleep = (ms) => …` 因此被当成了
        // 一个真实的模块级绑定，扫描器对 `sleep` 彻底瞎了（正是该文件头注里写明的
        // 「只会漏报」那一个宽松方向）。该文件的模板串建模与回归钉本轮一并修好。
        //
        // 现在用模块级的 `delay`（Node 侧唯一等待原语）。
        for (let attempt = 0; attempt < 2 && !ready; attempt += 1) {
          if (attempt > 0) {
            warn(`resume navigation not ready — retrying once (site=${siteId}, target=${safeUrl(target)})`);
            await delay(1500);
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
            withWebcodeCode(err, 'NEED_LOGIN');
            throw err;
          }
          const reason = challenge
            ? `导航回既有会话时被风控验证页拦截（${challenge}）`
            : '网页会话已不可达（已删除或过期）';
          const err = new Error(`WEB_SESSION_LOST: ${reason} — 需要整段重建`);
          withWebcodeCode(err, 'WEB_SESSION_LOST');
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
        const url = safeUrl(page?.url?.() || '');
        const id = sessionIdFromUrl(page?.url?.() || '');
        // 0.19.52：无形状站点（zai/doubao/qwen…）拿不到 id，但页面落在会话路径上
        //（z.ai 真机：发送后页面导航到 `/c/<uuid>`，两轮一致）——此时「地址本身」
        // 就是身份。站点根（fresh 落点）不算会话身份：把它记下来会让「手动回了
        // 首页」被 stay 判据误认成「还在原会话」。判据用 contract.js 的同一份
        // freshPath 语义（pathname 与 cfg.site 相同 = 根）。
        let landedIdentity = null;
        if (!id && url) {
          try {
            const u = new URL(url);
            const freshPath = new URL(cfg.site).pathname;
            if (u.pathname !== freshPath && u.pathname !== '/') landedIdentity = url;
          } catch { /* 地址不可解析就当没有 */ }
        }
        if (!id && !landedIdentity) return null;
        const before = conversationFor(key)?.webSessionId || null;
        if (before === id && !landedIdentity) return id;
        rememberConversation(key, id || null, 'store', landedIdentity);
        pushNavTrace({
          phase: 'landed:' + phase, key: String(key),
          storedBefore: before, landedId: id, landedUrl: landedIdentity || null,
          pageUrl: safeUrl(page?.url?.() || ''),
        });
        log(`web session slot written at ${phase}: key=${key} ${id ? 'id=' + id : 'landedUrl=' + landedIdentity}${before ? ' (was ' + before + ')' : ''}`);
        return id;
      };
      // ① 导航落地这一刻。resume 的目标地址本来就带 id（通常与槽里一致，无事
      //    发生）；fresh 之后地址栏一般还是站点根，由下面 ② 的发送后读取补上。
      noteLanded('nav');

      loggedIn = true;
      // thinkMode: 'auto'(按模型默认) | 'on'(强制开) | 'off'(强制关)——设置页手动覆盖。
      // DeepSeek 的「深度思考」pill 是独立开关,auto 时按模型 thinking 属性双向同步。
      const thinkOverride = thinkMode === 'on' ? true : thinkMode === 'off' ? false : null;
      const selection = model ? await selectModel(model, { hasImages: Array.isArray(images) && images.length > 0, thinkOverride, resume: navigate !== 'fresh' }) : null;
      // 思考等级（0.19.48）：**在模型选择之后**下发——真机读数里 kimi 的档位控件就长在
      // 模型菜单里、glm 的档位子菜单长在模型弹层里，先选模型再落档位是唯一不会互相
      // 覆盖的顺序。`reasoningEffort` 为 null（用户没选 / 停在 Default）时它**立即返回**，
      // 不点、不改网页——因此对既有用户是零位移。
      // 失败**必须**抛（不吞）：判据与执行都在 lib/think-effort.js 的 applyEffort（唯一执行器，
      // 真机探针与驱动走同一条路径），这里只负责把成功的读数记进 status。
      if (reasoningEffort) {
        const eff = await applyEffort(page, { siteId, target: reasoningEffort });
        if (eff.applied) {
          effortApplied = { at: Date.now(), siteId, target: eff.target, readback: eff.readback, basis: eff.reason };
          log(`think effort applied: site=${siteId} target=${eff.target} readback=${JSON.stringify(eff.readback)} (${eff.reason})`);
        }
      }
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
      // 联网搜索开关（0.19.94，用户需求：三态 auto/on/off，站点级可覆盖）。
      //
      // 旧实现只有这里一句硬编码：「aria-pressed=true 就点掉」——等价于**只有 off**，
      // 用户手动开了联网搜索也会被静默关掉。现在按 `planSearchToggle` 的计划执行：
      //   · auto → 一个字都不动（零位移，默认值；与旧实现的差别是「不强制关」）；
      //   · off  → 保持旧行为：只把已按开的点掉；
      //   · on   → 未开则点开，并**回读 aria-pressed 确认真的变成 true**。
      //
      // 回读必须轮询：点击只保证事件派发，React 受控组件的 aria-pressed 属性是**下一
      // 次渲染**才更新；点完立刻读一次会把「刚点开」误判成失败（本项目「合成点击后
      // 立即回读」这一类早前已记过）。超时仍不是 true ⇒ 抛 SEARCH_TOGGLE_UNCONFIRMED，
      // 绝不静默当成功——用户选了 on，网页却没开，必须让他知道。
      //
      // 站点没有 searchTogglePattern 契约时**不动网页也不抛错**：该设置目前只对
      // deepseek 真机校准（设置页也只在 deepseek 分区露出这个控件）；在别的站点上
      // 因为「读不到控件」而杀掉整轮，会把无关站点一起拖红。仅在有契约的站点上，
      // 「契约在但控件读不到」才按 plan 的 fail 处理。
      const searchModeEffective = searchMode === 'on' || searchMode === 'off' ? searchMode : 'auto';
      if (contract.searchTogglePattern) {
        const search = page.locator('[aria-pressed]').filter({ hasText: contract.searchTogglePattern });
        const searchCount = await search.count();
        const beforePressed = searchCount ? (await search.first().getAttribute('aria-pressed')) === 'true' : null;
        const searchPlan = planSearchToggle({ pressed: beforePressed, mode: searchModeEffective });
        if (searchPlan.action === 'turn-off') {
          await search.first().click();
          log(`search toggle turned off (site=${siteId}, reason=${searchPlan.reason})`);
        } else if (searchPlan.action === 'turn-on') {
          await search.first().click();
          // 回读确认：最多等 ~1.5s（10 × 150ms），读不到 true 就是没开成。
          let afterPressed = null;
          for (let i = 0; i < 10; i += 1) {
            afterPressed = await search.first().getAttribute('aria-pressed');
            if (afterPressed === 'true') break;
            await delay(150);
          }
          if (afterPressed !== 'true') {
            const toggleErr = new Error(
              `SEARCH_TOGGLE_UNCONFIRMED: 已点击联网搜索开关但回读 aria-pressed=${JSON.stringify(afterPressed)}`
              + `（site=${siteId}，期望 true）— 网页控件可能已改版，本轮不会假装搜索已开启`,
            );
            // 错误码不登记进 WEBCODE_CODES 的原因见 test/settings-transport.test.mjs ⑩
            // 与 .tmp/live-2026-10-19/search-toggle-report.md：error-codes.js 不在本轮
            // 改动写域内（任务边界），登记由 Lead 收口；withWebcodeCode 仍保证 failure
            // 快照与 code 同源，码不会在 harness 边界退化成 UNKNOWN。
            withWebcodeCode(toggleErr, 'SEARCH_TOGGLE_UNCONFIRMED');
            toggleErr.siteId = siteId;
            toggleErr.readback = afterPressed;
            warn(`search toggle not confirmed (site=${siteId}, after=${JSON.stringify(afterPressed)})`);
            throw toggleErr;
          }
          log(`search toggle turned on and confirmed (site=${siteId}, reason=${searchPlan.reason})`);
        } else if (searchPlan.action === 'fail') {
          const toggleErr = new Error(
            `SEARCH_TOGGLE_UNCONFIRMED: 本轮要求开启联网搜索，但页面上读不到搜索控件`
            + `（site=${siteId}，匹配 aria-pressed 文本 ${contract.searchTogglePattern}）— 网页可能已改版`,
          );
          withWebcodeCode(toggleErr, 'SEARCH_TOGGLE_UNCONFIRMED');
          toggleErr.siteId = siteId;
          throw toggleErr;
        }
        // noop：auto（零位移）/ off 且本来就关 / on 且本来就开 —— 一律不点。
      } else if (searchModeEffective === 'on') {
        // 站点没有搜索控件契约：如实提示「无法确认」，但**不杀轮**（理由见上）。
        onThink?.(`⚠ 本轮联网搜索设为 on，但 ${siteId} 站点尚未校准搜索开关，无法确认已开启`);
      }
      // ── 任务模式（task-8，设置层，先只服务 GLM）：fresh 轮才应用 ────────────────
      // 判定收在纯函数 planSiteMode（默认空=零位移；resume 不动）；失败抛可读的
      // SITE_MODE_UNAVAILABLE，绝不静默降级。
      //
      // ⚠ 回读判据以**真机校准**为准（`.tmp/live-2026-10-19/glm-mode-calibration.md`）：
      //   点中模式后工具行立刻淡出隐藏，`div.model-select-item.selected` 文本=模式名但
      //   **不可见**；条目全程无 aria-selected/aria-checked。因此「已生效」只能由
      //   siteModeVerdict 的两条证据判定：selected item 文本（不过滤可见）**或**
      //   可见 `.selected-model-info` chip 文本。旧「只看可见 item」实现恒失败，已废弃。
      const siteModePlan = planSiteMode({ siteMode, fresh: navigate === 'fresh' });
      if (siteModePlan.apply) {
        const modePicker = site.modePicker;
        if (!modePicker || !modePicker.option) {
          throw withWebcodeCode(new Error('SITE_MODE_UNAVAILABLE: 站点 ' + siteId + ' 未声明 modePicker 契约，无法切换到任务模式「' + siteModePlan.mode + '」'), 'SITE_MODE_UNAVAILABLE');
        }
        // 真机形状：chip 是 `.selected-model-info`（点击可展开工具行）；旧契约的
        // trigger 可能是容器，这里两个来源都试，但**只有一个读取口径**（readSiteModeState）。
        const infoSels = [modePicker.selectedInfo, modePicker.trigger].filter((s) => typeof s === 'string' && s.trim());
        const readSiteModeState = () => page.evaluate(({ itemSel, infoSels }) => {
          const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const textOf = (el) => (el && el.textContent ? el.textContent : '').trim().replace(/\s+/g, ' ');
          const items = [...document.querySelectorAll(itemSel)];
          let infoText = null;
          for (const s of infoSels) {
            let el = null;
            try { el = document.querySelector(s); } catch { el = null; }
            if (el && vis(el)) { const t = textOf(el); if (t) { infoText = t; break; } }
          }
          return {
            items: items.map((el) => ({ text: textOf(el), visible: vis(el) })).slice(0, 30),
            // 真机：selected item 在淡出后**不可见**，所以这里**不过滤可见**。
            selectedItemTexts: [...document.querySelectorAll(itemSel + '.selected')].map(textOf),
            selectedInfoText: infoText,
          };
        }, { itemSel: modePicker.option, infoSels }).catch((e) => ({ error: String(e && e.message ? e.message : e) }));

        let modeState = await readSiteModeState();
        if (modeState.error) {
          throw withWebcodeCode(new Error('SITE_MODE_UNAVAILABLE: 读取任务模式状态失败（' + modeState.error + '）'), 'SITE_MODE_UNAVAILABLE');
        }
        let modeVerdict = siteModeVerdict({ selectedItemTexts: modeState.selectedItemTexts, selectedInfoText: modeState.selectedInfoText, mode: siteModePlan.mode });
        // ③ 幂等：已在目标模式 ⇒ fresh 轮也不重复点。
        if (!modeVerdict.confirmed) {
          // ① 目标 item 当前不可见 ⇒ 先点 chip（.selected-model-info）展开工具行。
          // 注：这里刻意用 for-of 循环而不是 `.some((it) => …)`——driver-scope 护栏
          // 不收集箭头函数形参（LTI #72 的已知边界），`it` 会被误判成自由标识符，
          // 改代码形状是仓库纪律，不去改扫描器。
          let targetVisible = false;
          for (const item of modeState.items || []) {
            if (item.text === siteModePlan.mode && item.visible) { targetVisible = true; break; }
          }
          if (!targetVisible && infoSels.length) {
            await page.locator(infoSels[0]).first().click({ timeout: 3000 }).catch(() => {});
            await delay(250);
          }
          // 点目标 item（按文本精确匹配；不可见时先展开再点）。
          const clicked = await page.evaluate(({ itemSel, want }) => {
            const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            const textOf = (el) => (el && el.textContent ? el.textContent : '').trim().replace(/\s+/g, ' ');
            const all = [...document.querySelectorAll(itemSel)].filter((el) => textOf(el) === want);
            const el = all.find(vis) || all[0] || null;
            if (el) el.click();
            return { clicked: Boolean(el), visibleAtClick: Boolean(el && vis(el)) };
          }, { itemSel: modePicker.option, want: siteModePlan.mode }).catch(() => ({ clicked: false }));
          // ② 回读：selected item 文本（不过滤可见）或 chip 文本 = 目标。
          for (let i = 0; i < 10 && !modeVerdict.confirmed; i += 1) {
            await delay(150);
            modeState = await readSiteModeState();
            modeVerdict = siteModeVerdict({ selectedItemTexts: modeState.selectedItemTexts, selectedInfoText: modeState.selectedInfoText, mode: siteModePlan.mode });
          }
          if (!modeVerdict.confirmed) {
            // ④ 失败带真机现场（items 文本 / selected 文本 / chip 文本），可读归因。
            // 同上：for-of 而非 `.map((it) => …)`（driver-scope 护栏的箭头形参边界）。
            const itemScene = [];
            for (const item of modeState.items || []) itemScene.push(item.text + (item.visible ? '' : '(hidden)'));
            const scene = {
              clicked: Boolean(clicked && clicked.clicked),
              items: itemScene.slice(0, 20),
              selectedItemTexts: modeState.selectedItemTexts || [],
              selectedInfoText: modeState.selectedInfoText ?? null,
            };
            throw withWebcodeCode(new Error('SITE_MODE_UNAVAILABLE: 已点击任务模式「' + siteModePlan.mode + '」但回读未确认（真机现场：' + JSON.stringify(scene) + '）'), 'SITE_MODE_UNAVAILABLE');
          }
        }
        log('site mode confirmed: ' + siteModePlan.mode + ' (site=' + siteId + ', basis=' + modeVerdict.basis + ')');
      }
      throwIfAborted();
      if (Array.isArray(images) && images.length) {
        // 上传后**确认**附件真的进了网页才继续（见 uploadImages 的注释）：
        // 拿不到可见证据就抛 ATTACH_NOT_CONFIRMED。
        //
        // 0.19.5：**图片失败不再杀掉整轮**。旧实现在这里直接 await（没有 try），
        // 于是确认失败会把本轮判死——用户看到的是「一发图就整轮失败」，而不是
        // 「图没上去、正文照常」。这与文字附件那条路径的纪律不一致（后者失败一律
        // 回落 inline）。现在改为：失败**如实记读数**（imageTransport，含现场），
        // 然后**继续以纯文本发送**——宁可这一轮没有图，也不要一个什么都做不了的
        // 失败轮。判据与文字附件共用同一套证据（pageAttachEvidence）。
        try {
          attachEvidence = await uploadImages(images);
          imageTransport = {
            at: Date.now(), ok: true, count: attachEvidence.attached,
            evidence: attachEvidence.evidence, names: attachEvidence.names || null,
          };
        } catch (err) {
          imageTransport = {
            at: Date.now(), ok: false, code: err?.code || null, count: images.length,
            fallback: true, reason: 'image-attach-failed',
            diag: err?.attachDiag || null,
          };
          warn('image attachment failed, continuing text-only: ' + (err?.code || err?.message));
          onThink?.('⚠ 图片未能附加到网页（' + (err?.code || '未知原因') + '），本轮将以纯文本发送');
        }
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
          // 0.19.12：捕获停摆兜底的基线。domTextAtStart = 发送后**首个采样点**的
          // 助手节点原文——那一刻页面上是上一轮的回复（或空的思考占位），本轮兜底
          // 只允许在「当前内容 ≠ 基线」时开火，否则会把上一轮留在页面上的旧回复
          // 当成本轮的交出去。domRescueDone 保证一轮最多兜底一次。
          domTextAtStart: null,
          domTextChanged: false,
          domRescueDone: false,
          wipTimer: null,
          settled_by: null,
          // 0.19.75 交付链逐层取证（**一轮一个实例**，绝不跨轮复用——跨轮复用正是
          // 本仓库记过的「旧读数冒充本轮」那一类缺陷的来源）。
          // 只在显式开启时创建，默认零开销：`WEBCODE_DELIVERY_TRACE=1`，
          // 或配置传入的 deliveryTrace 开关。
          trace: deliveryTraceEnabled
            ? createDeliveryTrace({ sampleChars: deliveryTraceSampleChars })
            : null,
        };
      });
      timer = setTimeout(async () => {
        const a = finishActive();
        // 超时必须带页面现场：「网页没生成」和「捕获链死了」修法完全不同，
        // 黑盒超时只能瞎猜（2026-09-12 断流事故：页面早有全文、捕获从未建立）。
        const scene = await page?.evaluate?.((sel) => {
          const last = [...document.querySelectorAll(sel)].pop();
          return {
            captureAlive: typeof window.__webcodeChunk === 'function' && window.__webcodeCaptureInstalled === true,
            replyChars: last ? (last.innerText || '').length : 0,
            // 找不到节点本身就是要紧的读数（0.19.16）：它把「页面真的没有回复文本」
            // 与「我们的选择器对这个站点是瞎的」分成两种现场——两者的下一步完全不同，
            // 而 replyChars:0 会把它们印成同一句话。
            selectorHit: Boolean(last),
          };
        }, answerSelector).catch(() => null);
        const detail = !scene ? '页面不可用'
          : (scene.captureAlive ? '捕获链在' : '捕获链缺失')
            + (scene.replyChars ? `，页面已有 ${scene.replyChars} 字回复未回传` : '，页面无回复文本');
        warn('turn timeout scene:', JSON.stringify(scene));
        // 现场同时落进 status：只 warn 到控制台的话，用户与事后排查都取不到，
        // 而这正是「页面早有全文、捕获从未建立」这类事故的唯一直接证据。
        lastTimeoutScene = scene ? { ...scene, at: Date.now() } : { at: Date.now(), page: 'unavailable' };
        // ── 0.19.83：把「等一下」的假故障归因到**真原因**（long-term-issues #63）──────
        //
        // 真机（doubao，2026-10-14）：消息**发送成功**后网页弹出**图片选择式**人机验证
        // （「请选择所有符合上文描述的图片，并拖拽到下方」+ 提交按钮），验证通过前
        // 网页**不生成回复** ⇒ 桥等 110s 报 `turn timeout scene {captureAlive:true,
        // replyChars:0, selectorHit:false}`。**报错方向是误导的**：用户会以为是桥/网页
        // 卡住，而实际是「需要你去过验证」。
        //
        // 为什么修在这里（超时点）而不是发送后那一次采样：这种验证**不在发送那一刻**
        // 出现，它在发送**之后**才弹出（z.ai 那类「发送前 await HN()」是另一形态，
        // 发送后 2.5s 的采样对它有效）。只在发送后查一次，对这种**延迟弹出**的验证
        // 是瞎的——本缺陷就是这么漏掉的。超时点离弹出最近，是能稳定抓住它的位置。
        //
        // 判据（两条独立证据，任一命中即归因）：
        //   ① 站点声明位 `captchaSelector` 命中**可见**节点（复用发送后那一段的
        //      「真实像素」判据：宽高都 > 0 且非 display:none / visibility:hidden）；
        //   ② **可见文案指纹**命中（不依赖站点声明）——图片选择式验证的措辞是通用的，
        //      而 doubao 没有声明 `captchaSelector`，只靠 ① 会继续漏。
        // ⚠ 文案指纹只用来**归因**（把超时说成「大概是验证」），**不**代替站点声明：
        //   站点知识仍收口在 providers.js；这里只是「页面自己说了什么」。
        let challengeAtTimeout = null;
        try {
          // ⚠ 必须**逐 frame** 查，不能只查主框架（0.19.83 真机教训）。
          //   `page.evaluate` 只跑在**主框架**，而风控/人机验证在业界普遍渲染在
          //   独立 iframe 里（隔离自己的 CSS/JS）⇒ 主框架 `document.body.innerText`
          //   **一个字都看不到**，词表再全也抓不到。
          //   0.19.83 真机复验正是这样：修完重跑 doubao 仍是 `web turn timed out`
          //   （**不是**验证归因）⇒ 只查主框架的实现在那种形态下必然漏。
          //   这里对 `page.frames()` 逐个查；跨域 frame 的 `evaluate` 抛错就跳过
          //   （跳过是**如实**的：抓不到就不假装命中，`probe` 会记下来）。
          // ⚠⚠ **0.19.87 修掉一处致命形状**（long-term-issues #75）。
          //   本段原先给 `evaluate` 传了**四个顶层实参**（一个回调 + 三个值），
          //   而 Playwright 的契约只允许「回调 + **一个** arg」——
          //   多传时它**同步抛出** `Too many arguments`（原文：多值必须包进一个对象）。
          //   （离线实证：仓库自带 chromium，见 `.tmp/audit-adaptation/verify-evaluate-argc.mjs`。）
          //
          //   ⚠ 危害不在「参数写错」，而在**它抛得早、又紧接着 `.catch`**：
          //   表达式抛 ⇒ 异常被吞成 `null` ⇒ 调用方看到的是「没命中」，
          //   与「页面本来没有验证码」**完全一样**，而真相是**那段判据从未执行**。
          //   ⇒ 这正解释了 0.19.83 的真机复验：报错仍是 `web turn timed out`、
          //     连 `probe` 诊断行都没打出来——那是「代码没跑」的指纹。
          //   ⇒ 教训同「工具自己制造假结论」：**改了代码 + 加了护栏 ≠ 那段代码真的在跑**；
          //     当时的源码级护栏只覆盖「源码里有某个字符串」，覆盖不到「运行时会抛」。
          //   ⇒ 修法：把全部参数收进**一个对象**（契约内唯一的多值形态）。
          // 单 frame 探测：**写成函数声明**而不是箭头函数。
          //
          // ⚠ 这不是风格偏好，是 `test/driver-scope.test.mjs` 的一条真实边界（#72）：
          //   它的绑定表**不收集箭头函数的形参**，只收 `runTurn` 自身形参与
          //   **`function X(` 声明的形参**。写成 `const checkFrame = async (f) => f.evaluate(…)`
          //   时，`f` 不在绑定表里 ⇒ 判据说「`f` 是跨作用域自由标识符」并变红。
          //   ⇒ 与 0.19.83 面对 `PAT.body` 时的处置**同一条纪律**：**改代码形状，不放宽扫描器**
          //   （它当前能抓 `nav` / `sleep` 两个真实家族，放宽的代价大于收益）。
          //   函数声明让它真的看得见这个绑定，而且读起来也更清楚「这是探测器」。
          async function probeFrame(frame) {
            // ⚠ **单对象实参**（#75）：Playwright 的 `evaluate` 只接受一个 arg，
            //   传多了会**同步抛** `Too many arguments…`；而这类调用几乎总带 `.catch`
            //   ⇒ 异常被吞成「没命中」，那段判据**从来没跑过**。见本节上方的 #75 说明。
            return frame.evaluate((o) => {
              const txt = String(document.body?.innerText || '');
              const patBody = o.patBody;
              const patTitle = o.patTitle;
              const sel = o.sel;
              // 词表判据的唯一真源：lib/challenge-heuristics.js（以 source 传参重建）。
              // 图片选择式 / 点选式 / 滑块式的措辞都在这两份模式里；真机 doubao 原文逐字见上。
              // ⚠ **没命中时要把「为什么没命中」也带出来**（0.19.83 真机教训）：有了下面
              //   这份 `probe`，下一次能立刻分清「页面本来就没有验证码」与「有验证码但抓不到」
              //   ——两者下一步完全不同，而只记一句「没命中」会把它们印成同一件事。
              //   刻意**不落整页正文**（只落关键词命中与长度）：这类页面可能含账号信息。
              const probe = {
                bodyLen: txt.length,
                // 与词表同族但**更宽**的关键词，用来判断「形态漏了」还是「本来没有」
                kws: ['验证', '请选择', '拖拽', '图片', '滑块', '拖动', '人机', '安全', '提交']
                  .filter((k) => txt.includes(k)),
                titleLen: String(document.title || '').length,
              };
              if (new RegExp(patBody).test(txt)) return { basis: 'body-text', head: txt.slice(0, 160), probe };
              if (new RegExp(patTitle).test(String(document.title || ''))) {
                return { basis: 'title', head: String(document.title || '').slice(0, 120), probe };
              }
              if (!sel) return { basis: null, probe };
              const vis = [...document.querySelectorAll(sel)].filter((el) => {
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return false;
                const cs = window.getComputedStyle(el);
                return cs.display !== 'none' && cs.visibility !== 'hidden';
              });
              if (vis.length) return { basis: 'site-selector', head: String(vis[0].className || '').slice(0, 120), probe };
              // 走到这里 = **没命中**：把 probe 带出来（否则「没有验证码」与「抓不到」不可分）
              return { basis: null, probe };
            }, {
              sel: site.captchaSelector ? String(site.captchaSelector) : null,
              patBody: CHALLENGE_PATTERN_SOURCES.body,
              patTitle: CHALLENGE_PATTERN_SOURCES.title,
            }).catch((e) => ({ basis: null, frameError: String(e?.message || e).slice(0, 80) }));
          }
          // 编排逻辑抽到 `lib/captcha-gate-scan.js`（纯函数，可离线驱动）。
          // 为什么必须抽：0.19.83 这段写在超时回调里、依赖真实 `page` ⇒ 只能写**源码级**护栏，
          // 而源码级护栏只证明「字符串在场」、不证明「跑得起来」——#75 因此全程没被发现
          // （`evaluate` 传 4 个实参 ⇒ Playwright 同步抛 ⇒ 被 `.catch` 吞 ⇒ 判据从未运行）。
          // 抽出来后用**假 frame** 直接驱动，命中即停 / probe 汇总 / frameError 都变成可断言的行为。
          challengeAtTimeout = await scanFramesForChallenge(page.frames?.() || [], probeFrame);
        } catch { challengeAtTimeout = null; }
        // 没命中时的**诊断**：只落关键词命中与长度，不落整页正文（页面可能含账号信息）。
        // 它的价值在 0.19.83 真机上就体现过：修完重跑 doubao 读数仍是 timeout，
        // 这一格让人能一眼分清「页面本来没有验证码」与「有验证码但我不认」。
        if (challengeAtTimeout && !challengeAtTimeout.basis) {
          warn('captcha probe at timeout (no hit): ' + JSON.stringify(challengeAtTimeout.probe || null));
        }
        if (challengeAtTimeout && challengeAtTimeout.basis) {
          await page.bringToFront?.().catch(() => {});
          const err = new Error('WEB_CAPTCHA_REQUIRED: 网页弹出人机验证（判据='
            + challengeAtTimeout.basis + '，现场 ' + JSON.stringify(challengeAtTimeout.head) + '，'
            + 'frame ' + JSON.stringify(challengeAtTimeout.frameUrl || 'main') + '），'
            + '消息**未被网页受理**（站点在验证通过前不会生成回复）。'
            + '处理：在弹出的浏览器窗口里手动完成验证后重试本轮。'
            + '（这不是解码器问题，也不是「网页没回传」——本轮零回复是验证闸门造成的）');
          withWebcodeCode(err, 'WEB_CAPTCHA_REQUIRED');
          err.captcha = challengeAtTimeout;
          err.timeoutScene = lastTimeoutScene;
          warn('captcha gate hit at timeout: ' + JSON.stringify(challengeAtTimeout) + ' site=' + siteId);
          lastEndReason = 'captcha';
          lastEndReasonAt = Date.now();
          if (a) a.reject(err); else warn(err.message);
          return;
        }
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
      //
      // 0.19.9：这里原先的条件是 `if (!attachEvidence)`，而 `attachEvidence` 在
      // **带图轮**已经被上面的 `uploadImages` 置位 —— 于是「既有图、正文又超长」的
      // 轮次**整块跳过**了正文投递判定：81,004 字符正文与图片一起被灌进输入框。
      // 真机复现（2026-09-24，用户原话「明明在附件投递模式下，看的还是完整上下文」）：
      // 页面上的用户消息 `userMsgChars=81139`、`mentionsFullHistory=true`，
      // 而 `attachTransport` 停在上一轮的读数（读数是**上一轮**的，于是面板还显示
      // 「当前生效：附件投递」，用户看到的是全文 —— 这正是最坏的那种不一致）。
      //
      // 判据改成「**正文是否需要附件**」而不是「有没有用过附件」：图片与文本附件是
      // 网页输入区里两件独立的东西，一个已经挂上不代表另一个不用挂。
      // `plan.mode` 在图片 + 短正文时仍是 inline（under-limit），那是既有正确行为。
      // 站点上限先收紧（0.19.11）：deepseek 的典型首轮实测 48,937/53,797 字符，
      // 全站默认 60,000 会让它们**全部走 inline**（真机取证见 SITE_ATTACH_INLINE_LIMIT）。
      // 只收紧不开启：配置 0 仍然一律 inline。算一次、两处同源，判据不各写一份。
      const attachInlineLimit = effectiveAttachInlineLimit(siteId, cfg.attachInlineLimitChars);
      const plan = promptTransportPlan({
          chars: String(message).length,
          inlineLimit: attachInlineLimit,
          attachEnabled: attachInlineLimit > 0,
          attachSupported: true,
          // 站点级禁令（0.16.7 静态表 + 0.16.28 运行期自愈）。
          // **0.19.11 事实更正**：静态表 `ATTACH_FORBIDDEN_SITES` 已是空集，而且
          // 2026-09-18「DeepSeek 收得下附件但读不到它」这条结论**已被真机推翻**——
          // test-mock/real-attach-ingest.mjs（2026-09-24）用「标记只写进附件正文」的
          // 内容级判据实测：3,554 与 62,054 字符两个尺寸都从附件里读出了标记值
          // （3.4s / 4.3s，零超时），62k 正是当年被记成「240s 零回复」的那个尺寸。
          // 因此这里**不能**把 deepseek 写回静态禁令；运行期自愈照旧保留（它是
          // 读数驱动的兜底，不是对站点能力的断言）。
          attachForbidden: attachForbiddenFor(siteId),
          // 设置面的「投递形态」开关（0.16.3）：'inline' = 用户显式要求纯文本，
          // 逐字回到旧行为；其余一律 'attach'（是否真的走附件仍由上面的阈值决定）。
          // 现读而不是取构造函数快照，理由见 promptTransportNow。
          // 0.19.32：传本实例站点，于是站点级覆盖在这一条判据里生效（与 status 同源）。
          transport: promptTransportNow(siteId),
          // 站点级纯文本硬上限（0.19.41）：即便用户选了「纯文本」，超过它也必须改走
          // 附件——因为纯文本在这一长度上已被真机证明发不完整（内容被静默丢弃，
          // 上层只看到 PROMPT_TRUNCATED）。读数与理由见 SITE_COMPOSER_HARD_LIMIT。
          // 未列出的站点返回 null ⇒ 不设底线，行为与 0.19.40 逐字相同。
          hardLimit: composerHardLimitFor(siteId),
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
        } else if (plan.reason === 'inline-unsafe') {
          // 0.19.41：用户选了「纯文本」，但这一轮的长度超过站点**实测硬上限**，
          // 因此改走附件。这不是静默无视用户选择——必须留痕（面板 + 会话内提示），
          // 否则用户看到的是「我明明选了纯文本，怎么变成附件了」。
          // 与 TRANSPORT_INLINE 同型：这是本站点的安全底线，不是故障。
          attachTransport = { at: Date.now(), fallback: false, code: 'INLINE_UNSAFE', total: String(message).length,
            transport: 'attach', reason: plan.reason, siteId, hardLimit: composerHardLimitFor(siteId) };
          log('prompt transport overrode user inline choice: over site hard limit, site=' + siteId
            + ' chars=' + plan.total + ' hardLimit=' + composerHardLimitFor(siteId));
          onThink?.('本轮 ' + plan.total + ' 字符超过 ' + siteId + ' 的纯文本实测上限 '
            + composerHardLimitFor(siteId) + ' 字符（真机读数），已改用附件投递以免内容被网页静默截断。');
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
      const input = page.locator(SEL.input).first();
      // 2026-09-13：doubao（tiptap/ProseMirror）与 kimi（div.chat-input-editor）
      // 的输入框是 contenteditable，**不是**表单控件。Playwright 的 fill() 只认
      // input/textarea/[contenteditable]（后者要走 locator.fill 的 contenteditable
      // 分支）；而 inputValue() 对富文本编辑器永远抛错 → 旧实现里这两个站点要么
      // 写不进去、要么回读校验直接失败。按真实元素形态分派输入与回读。
      await fillComposer(input, message);
      // 网页输入框有长度上限，超限会被静默截断——模型只看到半截提示词却照常
      // 作答，长跑里表现为「越到后面越答非所问」。回读一次，对不上就拒绝
      // 发送，让上层压缩后重试（此时还没按 Enter，网页端没有被污染）。
      //
      // ## 0.19.71：判据从「比长度」改成「比内容等价」（long-term-issues #48）
      //
      // 旧判据是 `echoed.length < message.length - 8`。它有个**实测过的误报**：
      // 浏览器按 HTML 规范把 `textarea.value` 里的 `\r\n` 规范化成 `\n`，于是
      // 回读**必然**比原文短（短多少 = CRLF 个数）。真机读数：44,202 字符的
      // 提示词两次都恰好「丢 126 个字符」——那 126 正是注入的 `AGENTS.md` 的
      // 行数（126 个 `\r\n`），**正文一字未少**。而 `-8` 的容差对 126 毫无帮助
      // ⇒ 长会话 `inline` 档必然失败。
      //
      // 长度在换行口径不同的情况下**本就不可比**，所以判据改成比较**内容等价**：
      // 只在**显式白名单**的规范化之后比较。白名单刻意极窄——只允许换行规范化
      // （`\r\n` → `\n`）与行尾空白差异，**不允许**泛化的 trim / 折叠空白 /
      // 忽略缩进（那会掩盖真正的内容损坏）。
      //
      // 真正的截断（网页只收了前半截）在规范化后**依然**不等 ⇒ 照旧拦住。
      const echoed = await readComposer(input);
      // 与下方发送确认里的 `sent`（布尔）区分：这里用 echoVerdict 承载判据结果。
      const echoVerdict = composerEchoVerdict(String(message), echoed);
      if (!echoVerdict.ok) {
        const err = new Error(`PROMPT_TRUNCATED: 网页输入框只接收了 ${echoVerdict.echoedLength}/${echoVerdict.sentLength} 字符`
          + `（判据=${echoVerdict.reason}）— 请缩短上下文或先压缩历史再重试`);
        withWebcodeCode(err, 'PROMPT_TRUNCATED');
        // accepted/total 供 executor 的自动压缩重试取数（0.16.11）：真机 0a62dbb8
        // 整轮差 11 个字符就作废——这种轮次必须能按已接受长度自动压缩重试一次。
        err.accepted = echoVerdict.echoedLength;
        err.total = echoVerdict.sentLength;
        throw err;
      }
      throwIfAborted();
      if (active) active.t0 = performance.now();
      // 发送方式按站点契约：定义了 sendButton 的站点（如 z.ai 的
      // #send-message-button）点按钮提交——这些站点对程序化 Enter 不响应
      // （真机 2026-09-12：z.ai 轮次静默挂死正因 Enter 不触发发送）；
      // 其余站点维持 Enter。按钮点击失败回落 Enter，不发半截消息。
      //
      // 0.19.8：**发送必须确认**。
      //
      // 真机取证（2026-09-24，本机 0.19.7）：带图片的那一轮，上传证据命中
      // （`imageTransport.ok=true`、`img[src^='blob:']`），但 22 秒后**页面仍停在首页、
      // 正文还躺在输入框里**——程序化 Enter 那一下没有提交（同一页面手工按 Enter 立刻
      // 成功，且模型正确读出图里的字符 `7QK-42`）。整轮于是白等 240s 超时，而读数只说
      // 「超时」，看不出「消息压根没发出去」。
      //
      // 这是本项目记过多次的同一形状：**把「我调用了动作」当成「动作发生了」**。
      // 因此把「发出去了没有」变成可判定的读数，判据取两条页面事实之一：
      //   · 输入框被清空（网页收下消息才会清空）；
      //   · 地址栏从站点根变成 `/a/chat/s/<id>`（新会话由 SPA 在收下那一刻改写）。
      // 第一条路未确认就换下一条（按钮 → 聚焦后回车），都试过仍没发出就**明确抛错**，
      // 不再伪装成「已发送然后超时」。
      const composerCleared = async () => {
        const v = await readComposer(input).catch(() => null);
        return typeof v === 'string' && v.trim() === '';
      };
      const navigatedAway = () => !/^https?:\/\/[^/]+\/?$/.test(page.url());
      let sent = false;
      const settle = async (rounds) => {
        for (let i = 0; i < rounds && !sent; i += 1) {
          await page.waitForTimeout(250);
          sent = (await composerCleared()) || navigatedAway();
        }
      };
      // 附件在场时发送键可能**暂时**不可用——真机 kimi（2026-09-27，带附件轮）：
      // 上传完成前发送控件是 `<div class="send-button-container disabled">`，
      // 那一刻按 Enter **网页不响应**（实测：Enter 后 2 秒内输入框长度恒为 81、
      // 地址栏不动；而等 `disabled` 类消失后点它，输入框立刻清空、附件 chip 清 0）。
      // 旧实现只试一次「点按钮 → 回车 → 再点按钮」，全在禁用窗口内 ⇒
      // `SEND_NOT_CONFIRMED`，用户侧就是「带附件的轮次发不出去」。
      //
      // 判据取**页面事实**（宿主控件的 disabled 状态）而不是等固定时长：
      // 上传耗时随文件大小变化，等固定值必然两头不讨好。
      // 只对**宿主元素**判 disabled（`div` 上的 `disabled` 属性没有语义，但站点
      // 用类名表达禁用，`[disabled]`、`aria-disabled`、含 `disabled` 的 class 三种
      // 都认）；`<button disabled>` 仍由 Playwright 的 isEnabled 负责。
      const sendReady = async (sel) => {
        if (!sel) return false;
        const st = await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return 'missing';
          if (el.tagName === 'BUTTON' && el.disabled === true) return 'disabled';
          if (el.getAttribute('aria-disabled') === 'true') return 'disabled';
          // 宿主元素（kimi 是 div）的禁用态只能用类名表达。按**切词后精确相等**
          // 判定，不写含 `|` 的正则字面量——本文件的源码扫描护栏
          //（test/driver-scope.test.mjs）会把正则里的 `|` 当代码切分，
          // 于是 `…|disabled|…/i` 被误读成一个自由标识符（0.19.41 实测变红）。
          const cls = String(el.getAttribute('class') || '').split(/\s+/);
          if (cls.includes('disabled')) return 'disabled';
          return 'ready';
        }, sel).catch(() => 'missing');
        return st === 'ready';
      };
      const clickSendButton = async (sel, timeout = 4000) => {
        const b = page.locator(sel).first();
        if (!await b.count()) return false;
        await b.click({ timeout });
        return true;
      };
      // 先等发送控件就绪（最多 12s：真机 kimi 上传 32KB 附件约 2 秒，留足余量）。
      let sendReadySeen = !SEL.sendButton;             // 没声明按钮的站点直接进 Enter 路
      for (let i = 0; i < 24 && !sendReadySeen; i += 1) {
        sendReadySeen = await sendReady(SEL.sendButton);
        if (!sendReadySeen) await page.waitForTimeout(500);
      }
      log('send path: sel=' + String(SEL.sendButton) + ' ready=' + sendReadySeen
        + ' composerChars=' + (await readComposer(input).then((v) => (typeof v === 'string' ? v.length : -1)).catch(() => -2))
        + ' url=' + page.url());
      if (SEL.sendButton && !sendReadySeen) {
        warn('send button still disabled after 12s (site=' + siteId + ', sel=' + SEL.sendButton
          + ') — trying Enter anyway');
      }
      // ── F16：发送前的**页面级 UI 遮罩检测**（真机 z.ai 产品导览，2026-10-19 Wave2）──
      //
      // ## 缺陷现场（只读 live-probe，`.tmp/live-2026-10-19/probe-report-2.md` §4）
      //
      // z.ai 既有会话页带产品导览：`body.className="driver-active driver-fade"`、
      // `.driver-overlay` svg、`.driver-popover`（「将任务结果保存到文件夹 … 1/2 下一页」）。
      // `elementFromPoint` 在发送键中心与输入框中心命中的都是 `.driver-overlay` 里的
      // `<path>`（pointer-events:auto）⇒ 点击打空；catch 改 Enter（zai 对程序化 Enter
      // 不响应）⇒ 再点仍打空 ⇒ 含糊的 `SEND_NOT_CONFIRMED`。
      //
      // ## 判据与边界（保守、最小、不绕过风控）
      //
      //   · 只在 elementFromPoint **确实盖住发送键/输入框中心**时才动作（无遮罩零行为变化）；
      //   · 产品导览（driver-overlay/popover）先 Escape 一次（可逆 UI），等 400ms 重测；
      //   · 地区/公告弹窗（._modal-overlay）**不自动处理**，检测到就直接抛可读错误；
      //   · 仍被盖住 ⇒ 抛 `WEB_UI_OVERLAY_BLOCKED`（已在 error-codes.js 登记），
      //     不再让用户看到含糊的「发送未确认」。
      const overlayHitAtTarget = async () => {
        try {
          return await page.evaluate((targetSel) => {
            const out = [];
            for (const t of [targetSel, 'composer']) {
              let el = null;
              try {
                if (t === 'composer') {
                  el = [...document.querySelectorAll('textarea, [contenteditable="true"]')].find((e) => {
                    const r = e.getBoundingClientRect();
                    return r.width > 40 && r.height > 0;
                  });
                } else if (t) el = document.querySelector(t);
              } catch { el = null; }
              if (!el) { out.push(null); continue; }
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) { out.push(null); continue; }
              const x = Math.round(r.x + r.width / 2);
              const y = Math.round(r.y + r.height / 2);
              const hit = document.elementFromPoint(x, y);
              if (!hit) { out.push(null); continue; }
              const ancestorClasses = [];
              for (let n = hit; n && n !== document.body && ancestorClasses.length < 8; n = n.parentElement) {
                ancestorClasses.push(String(n.className || n.id || ''));
              }
              out.push({
                className: String(hit.className || hit.id || ''),
                ancestorClasses,
                bodyClasses: String(document.body.className || ''),
                point: { x, y },
              });
            }
            return out;
          }, SEL.sendButton || null);
        } catch { return null; }
      };
      const detectOverlay = async () => {
        const hits = await overlayHitAtTarget();
        if (!Array.isArray(hits)) return { blocked: false, kind: null };
        for (const hit of hits) {
          const v = overlayBlocksPoint(hit);
          if (v.blocked) return v;
        }
        return { blocked: false, kind: null };
      };
      let overlay = await detectOverlay();
      if (overlay.blocked) {
        if (overlay.kind === 'driver-tour') {
          // 产品导览是**可逆 UI**：Escape 关掉再重测；不是绕过验证码/风控。
          warn('[ui-overlay] product tour overlay blocks send target; pressing Escape once (site=' + siteId + ')');
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(400);
          overlay = await detectOverlay();
        }
        if (overlay.blocked) {
          const label = overlay.kind === 'modal-overlay'
            ? '地区/公告弹窗（_modal-overlay）'
            : '产品导览遮罩（driver-overlay）';
          const err = new Error('WEB_UI_OVERLAY_BLOCKED: 网页上有' + label
            + '盖住了发送目标（发送键/输入框中心），点击不会命中 ⇒ 消息未被发送。'
            + '处理：在弹出的浏览器窗口里人工关闭/折叠该遮罩后重试本轮。'
            + '（这不是发送按钮故障，也不是解码器问题——点击被页面级遮罩拦截）');
          withWebcodeCode(err, 'WEB_UI_OVERLAY_BLOCKED');
          err.overlay = overlay;
          throw err;
        }
      }
      // 路 ①：契约既有行为（声明了 sendButton 就点它，否则回车）。
      //
      // 顺序在 0.19.41 调整过：旧实现先判 `btn.isEnabled()`，而 kimi 的控件是
      // **div**，`isEnabled()` 恒真 ⇒ 即使处于禁用窗口也会去点（点了没反应），
      // 于是三条路全废。现在改成「按站点声明点按钮」——那正是 sendButton 契约的语义。
      try {
        if (SEL.sendButton) await clickSendButton(SEL.sendButton, 5000);
        else await input.press('Enter');
      } catch { await input.press('Enter').catch(() => {}); }
      await settle(8);
      if (!sent) {
        // 路 ②：按钮再点一次（第一下可能落在禁用窗口或动画上）。
        //
        // 这里**刻意直接写 `page.locator(SEL.sendButton)`**，不调上面那个
        // `clickSendButton` 小助手：既有的结构护栏 `test/send-confirmed.test.mjs`
        // 要在这里看到「按契约点发送按钮」这条路径确实存在（它的判据是源码里
        // 有 `page.locator(SEL.sendButton)`）——助手函数在块外，护栏就看不见它了。
        // 护栏的意图是对的（重试路径必须真实存在），所以让源码形状服从它。
        try {
          if (SEL.sendButton) {
            const b = page.locator(SEL.sendButton).first();
            if (await b.count()) await b.click({ timeout: 4000 });
          }
        } catch { /* 下一条路 */ }
        await settle(8);
      }
      if (!sent) {
        // 路 ③：聚焦输入框末位再回车（textarea 失去焦点时 Enter 会被页面忽略）。
        try {
          await input.click({ timeout: 3000 });
          await input.press('End').catch(() => {});
          await input.press('Enter');
        } catch { /* 已尽力 */ }
        await settle(12);
      }
      if (!sent) {
        const err = new Error('SEND_NOT_CONFIRMED: 正文已写入输入框，但按站点契约发出后网页没有收下'
          + '（输入框未清空、地址栏也未切到会话）——附件在场时发送键可能变了或被禁用');
        withWebcodeCode(err, 'SEND_NOT_CONFIRMED');
        throw err;
      }
      log('send confirmed (composer cleared / navigated) url=' + page.url());
      // 站点风控闸门：发送已确认，但网页**可能卡在自带的人机验证上**——那时
      // `/api/chat/completions` 根本不会被发出（真机 z.ai：前端 `await HN()` 停在
      // 阿里云滑块上不返回），wire 上零帧，桥只能等到 120s/240s 报一句
      // 「网页没回传」，把排查方向引到解码器上。
      //
      // 判据是**站点声明**（`captchaSelector`），不是按站点名硬编码——站点知识收口在
      // providers.js 是本仓库的既定分层。没声明的站点一次 evaluate 都不做（零成本）。
      //
      // 为什么必须放在「发送已确认」之后：发送前失败有自己的错误（SEND_NOT_CONFIRMED /
      // PROMPT_TRUNCATED），在这之前查验证会把那些真错误盖掉。
      //
      // 为什么只查一次、而不是持续巡检：一次采样已经能定性（有头把窗口带到前台让人点，
      // 没头直接如实报错）。持续巡检会让「网页慢」这类正常轮次多出无意义的读数。
      if (site.captchaSelector) {
        await page.waitForTimeout(2_500);
        const gate = await page.evaluate((sel) => {
          const els = [...document.querySelectorAll(sel)];
          // ⚠ 2026-10-14 真机修（判据由 test/captcha-gate.test.mjs 与 driver-scope.test.mjs 双重钉住）：
          //   旧判据把 getClientRects().length 当「可见」的兜底，而它对**零尺寸但仍在布局里**
          //   的节点恒为真。z.ai 的 chat-captcha-element 正是这种（常驻 DOM、0x0、rects=1；
          //   发送中密集采样 20 拍全中）⇒ 闸门在空壳上开火，正常轮次被误判成需要人机验证。
          //   新判据：必须有**真实像素**（宽高都 > 0）且不是 display:none / visibility:hidden。
          //   真弹窗（332x329）仍被判可见 ⇒ 不放过真拦截。
          //   ⚠ 本段刻意不写反引号：注释里的反引号会被 driver-scope 的 codeOnly 当成模板串边界，
          //   从而改变它对该函数体内自由标识符的扫描范围（实测会把 getComputedStyle 报成自由变量）。
          const vis = els.filter((el) => {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const cs = window.getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden';
          });
          return { total: els.length, visible: vis.length,
            head: vis[0] ? String(vis[0].className || '').slice(0, 120) : null };
        }, String(site.captchaSelector)).catch(() => null);
        if (gate && gate.visible > 0) {
          // 有头时把窗口带到前台：验证必须**由人**完成，我们能做的是让那个窗口可见。
          await page.bringToFront?.().catch(() => {});
          const err = new Error('WEB_CAPTCHA_REQUIRED: 网页弹出人机验证（' + site.captchaSelector
            + ' 命中 ' + gate.visible + ' 个可见节点，首个 ' + JSON.stringify(gate.head) + '），'
            + '消息**未被网页受理**（站点在验证通过前不会发出请求）。'
            + '处理：在弹出的浏览器窗口里手动完成验证后重试本轮。'
            + '（这不是解码器问题，也不是「网页没回传」——wire 上零帧是验证闸门造成的）');
          withWebcodeCode(err, 'WEB_CAPTCHA_REQUIRED');
          err.captcha = gate;
          warn('captcha gate hit: ' + JSON.stringify(gate) + ' site=' + siteId);
          throw err;
        }
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
      // 「绝不静默降级模型」：核验本轮真实请求元数据。
      //
      // 是否严格由**契约字段**决定，不在这里硬编码站点 id（#57）：旧实现写死
      // `siteId === 'deepseek'`，而 `contract.js` 的 `strictModelType` 全仓零消费
      // ——契约声明了一个不会被读取的字段，等于把「哪些站点严格核验」这件事藏在
      // 驱动的第二份知识里。现在只认 `contract.strictModelType`（deepseek=true、
      // 其余站点=false，语义与旧实现逐字等价：其它站不新增行为）。
      if (contract.strictModelType === true && model && selection?.strict !== false) {
        // 新版统一 UI 的模式差异在 thinking_enabled（model_type 恒为 default），
        // 旧三 pill UI 的差异在 model_type。取不到请求体本身即失败——旧实现只
        // 比对非空 model_type，请求体一旦改形（如 model_type 消失）就会静默放行。
        if (!requestMetadata) {
          const err = new Error('MODEL_UI_CHANGED: 未捕获到本轮 /chat/completion 请求体，无法核验网页实际模式');
          withWebcodeCode(err, 'MODEL_UI_CHANGED');
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
          withWebcodeCode(err, 'MODEL_UI_CHANGED');
          throw err;
        }
      }
      if (!result.complete && !result.partial) {
        // 限流单列：hint 带着服务端原话（「消息发送过于频繁」），按专门错误码
        // 抛出，让上层退避后重试，而不是和无从下手的不完整流混在一起。
        if (result.reason === 'rate_limited') {
          const err = new Error(`RATE_LIMITED: ${site.name} 网页端限流（${result.hint || '消息发送过于频繁，请稍后重试'}）— 将退避后重试`);
          withWebcodeCode(err, 'RATE_LIMITED');
          throw err;
        }
        // 带上流首段原文：整流零响应帧时，「网页 200 包错误 JSON（风控/审核）」
        // 和「流形态对不上」在报错文本里一眼可分，不用再开 SSE_DEBUG 抓包。
        // 0.19.45 补流尾段：首段对多数站点是恒定的开帧（GLM 的 status:"init"），
        // 只看它会把「后面为什么断」这条线索整条丢掉。见 emptyWebResponseError 的注释。
        const headText = lastFinished?.rawHead ? ' | 流首段: ' + String(lastFinished.rawHead).slice(0, 200) : '';
        const tailRaw = lastFinished?.rawTail ? String(lastFinished.rawTail).slice(-200) : '';
        const tailText = tailRaw && tailRaw !== String(lastFinished?.rawHead || '').slice(0, 200)
          ? ' | 流尾段: ' + tailRaw
          : '';
        throw new Error('web capture ended incomplete: ' + (result.reason || 'unknown') + headText + tailText);
      }
      // 0.16.11（#26）：只看 text 会把「只有思考」的轮次整轮作废（真机 d5fd2e11
      // turn 8：reasoning 块 + finish、正文/调用为零 → UNKNOWN 硬失败，任务断链）。
      // 思考-only 由适配器的 thinkingOnlyNotice 路径交回提示继续任务；这里只拦全空。
      const emptyErr = emptyWebResponseError(result, {
        lastEndReason, rawHead: lastFinished?.rawHead, rawTail: lastFinished?.rawTail,
      });
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
      // 本轮收束原因：稳态巡检器收束时已写好 settled_by；否则按**解码器自己的判决**
      // 说真话（0.19.45）。
      //
      // ## 旧写法是一句假陈述（真机事故 2026-09-28，GLM）
      //
      // 旧实现是 `lastFinished?.settled_by || (site.decoder === 'dom' ? 'dom-capture'
      // : 'finished')` —— 兜底那一格**无条件写 'finished'**，完全不看解码器是
      // `{complete:true}` 还是 `{complete:false, reason:'incomplete'}`。
      // 于是 GLM 那一轮的报错文本成了「empty response from web AI（收束原因 finished）」，
      // 而**流根本没有 finished**：GLM 只在 `status === 'finish'` 帧才置 done，
      // 那一轮只有 `status:"init"` + `parts:[]` 就断了 ⇒ 解码器给的是
      // `{complete:false, reason:'incomplete'}`。报错把「网页没说完」写成了
      // 「网页正常收束」，与本项目记过的同类缺陷（旧读数冒充本轮、`mid-stream`
      // 被印成「已开流后的静默」）逐字同族——排查方向当场被带偏。
      //
      // 判据与 `result.complete` 同源（不新开一份口径）：跑完整了才写 finished，
      // 没收完整就把解码器给的 reason 如实带出去（incomplete / invalid_stream /
      // rate_limited…）。这样「收束原因」这一格与「本轮到底有没有交付」永远自洽。
      //
      // dom 站点仍然优先写 dom-capture：它不走解码器，`result.complete` 由 DOM
      // 文本是否非空决定，用同一个 reason 表达更准。
      const decoderSettled = result.complete
        ? (site.decoder === 'dom' ? 'dom-capture' : 'finished')
        : ('partial:' + (result.reason || 'unknown'));
      noteEndReason(lastFinished?.settled_by || decoderSettled);
      metrics.endReason = lastEndReason;
      // 0.19.75：把**权威全文**也记进 driver 层。
      //
      // 为什么这一步不能省：真机存在「增量通道什么都没送、正文只存在于
      // decoder.finish() 的权威全文里」的形态（0.16.4 记过）。若 driver 层只记
      // onDelta 的增量，那种轮次会显示成「driver 层 0 字」而被误判成分叉。
      // 这里补记两者之差：差额部分**不是丢失**，而是「没走增量通道」。
      if (active?.trace && typeof result.text === 'string' && result.text) {
        const already = active.trace.snapshot().driver.chars;
        if (result.text.length > already) {
          active.trace.note('driver', result.text.slice(already),
            active.trace.snapshot().driver.lastAt ?? undefined);
        }
      }
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

  async function sendTurn(key, message, { fresh = false, signal, onDelta, onThink, onImage, model, images, thinkMode, searchMode = 'auto', siteMode = null, reasoningEffort = null } = {}) {
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
    if (!existing?.webSessionId && !existing?.landedUrl && !fresh) {
      const fromUrl = sessionIdFromUrl(page?.url?.() || '');
      if (fromUrl && !deadSessions.has(fromUrl)) {
        rememberConversation(key, fromUrl, 'url-heal');
        existing = conversationFor(key);
        warn(`web session slot healed from page URL (site=${siteId}, key=${key}, id=${fromUrl}) — 槽为空但页面就停在该会话上`);
        pushNavTrace({
          phase: 'heal', key: String(key || 'main'),
          healedId: fromUrl, pageUrl: safeUrl(page?.url?.() || ''),
        });
      } else if (!fromUrl) {
        // 0.19.52：无形状站点的同型自愈——地址里解不出 id（没有形状表），但页面
        // 停在**会话路径**上（≠ 站点根）。把地址本身锚进槽（身份=地址，见
        // rememberConversation 的 landedUrl 注释），让下面的 stay 判据接得住
        // 「落地了但槽没写下来」的现场（2026-09-17 事故的无形状形态）。
        const pageUrl = safeUrl(page?.url?.() || '');
        if (pageUrl) {
          try {
            const u = new URL(pageUrl);
            const freshPath = new URL(cfg.site).pathname;
            if (u.pathname !== freshPath && u.pathname !== '/') {
              rememberConversation(key, null, 'url-heal', pageUrl);
              existing = conversationFor(key);
              warn(`web session slot healed from landed URL (site=${siteId}, key=${key}, url=${pageUrl})`);
              pushNavTrace({
                phase: 'heal', key: String(key || 'main'),
                healedUrl: pageUrl, pageUrl,
              });
            }
          } catch { /* 地址不可解析就当没有 */ }
        }
      }
    }
    // 三态导航（C-2）：'fresh' 开新会话、'resume' 导航回既有会话、
    // 'unsupported' 明确报错。**没有第四态**——旧实现在这里默默开新会话并把增量
    // 发进去，网页模型在毫无前文的情况下接着答，是「跑着跑着变傻」的根因。
    let nav = conversationNav({
      siteId,
      origin: new URL(cfg.site).origin,
      fresh,
      sessionId: existing?.webSessionId,
    });
    // 落地地址锚（0.19.52）：没有地址形状的站点（zai/doubao/qwen…）永远进不了
    // 'resume' 态，旧实现于是**每轮** WEB_SESSION_LOST → 整段重放 → 每轮新开一个
    // 网页对话（真机：webcode-sessions-zai.json 恒 2 字节空对象）。但只要页面从
    // 上一轮落地起就没被导航走，它就仍在那条会话上——原地续聊即可，判据在
    // contract.js（conversationStay：同源 + 同 pathname + 非站点根）。
    //
    // ② 页面**不在**锚上时（浏览器重启后的新页停在站点根 / 被别的会话导航走）：
    // 尝试**导航回锚**再验证。锚是本会话上一轮落地的真实地址（不是猜测），这与
    // shaped 站的 resume 导航同一语义；站点若把深链弹回根（z.ai 真机实测如此），
    // 验证失败 ⇒ 照旧 WEB_SESSION_LOST 整段重建，零额外风险。只在锚与站点同源时
    // 才动（防手改 store 写进外域地址）。
    if (nav.state === 'unsupported' && !fresh && existing?.landedUrl) {
      const siteOrigin = new URL(cfg.site).origin;
      const freshPath = new URL(cfg.site).pathname;
      // 锚判据要读页面地址，而 sendTurn 阶段驱动可能还没起页（懒启动——ensure
      // 在 runTurn 里才跑）。先确保有页：起不来（浏览器启动失败）就按「不在锚上」
      // 收场，错误由后面的 WEB_SESSION_LOST 如实带出去。
      if (!page || page.isClosed?.()) { try { await ensure(); } catch { /* 见上 */ } }
      let currentUrl = safeUrl(page?.url?.() || '');
      const staysNow = () => Boolean(currentUrl && conversationStay({
        origin: siteOrigin, freshPath, currentUrl, landedUrl: existing.landedUrl,
      }));
      if (!staysNow() && page && !page.isClosed()) {
        let anchorOrigin = null;
        try { anchorOrigin = new URL(existing.landedUrl).origin; } catch { /* 锚坏了就当没有 */ }
        if (anchorOrigin === siteOrigin) {
          pushNavTrace({
            phase: 'stay-goto', key: String(key || 'main'),
            target: existing.landedUrl, pageUrl: currentUrl,
          });
          try { await page.goto(existing.landedUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }); } catch { /* 导航失败按「不在锚上」收场 */ }
          currentUrl = safeUrl(page?.url?.() || '');
        }
      }
      if (staysNow()) {
        nav = { state: 'resume', url: currentUrl, reason: 'landed-url-stay' };
        pushNavTrace({
          phase: 'stay', key: String(key || 'main'),
          landedUrl: existing.landedUrl, pageUrl: currentUrl,
        });
        log(`web session stays on landed conversation (site=${siteId}, key=${key}, url=${currentUrl}) — 不再新开对话，原地续聊`);
      }
    }
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
      withWebcodeCode(err, 'WEB_SESSION_LOST');
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
      result = await runTurn(message, { key, navigate, signal, onDelta, onThink, onImage, model, images, thinkMode, searchMode, siteMode, reasoningEffort });
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
    if (result.sessionId) {
      // 流/地址里拿到了 id：确认写（landedUrl 走合并语义保留——见
      // rememberConversation 的注释，传 null 表示「不动旧值」）。
      rememberConversation(key, result.sessionId, 'store', null);
    } else if (navigate !== 'fresh' && !conversationFor(key)?.landedUrl) {
      // 旧语义保留：resume 了却拿不回任何身份（id 与落地地址都没有）——这种会话
      // 无法续聊，丢槽让上层整段重建。**有 landedUrl 的不算**（0.19.52）：无形状
      // 站点的身份就是地址本身，丢掉它会把「每轮新开对话」原样请回来。
      forgetConversation(key);
    }
    return result;
  }

  async function sendPrompt(prompt, { signal, onDelta, onThink, onImage, meta, model, thinkMode, searchMode, siteMode = null } = {}) {
    return runTurn(prompt, {
      navigate: 'fresh', signal, onDelta, onThink, onImage, thinkMode, siteMode,
      // 联网搜索（0.19.94）：与 have-session 的 sendTurn 同一形参名、同一条 meta 来源，
      // 否则「无会话轮」与「会话轮」会给出两种搜索开关行为——第二份真相。
      searchMode,
      model: model || meta?.model,
      images: meta?.images,
      // 无会话的一轮（OpenAI 前端）同样接受思考等级：契约与有会话那一轮**同一条**
      // （都在 meta 上），否则「同一个模型两条路给出两种档位行为」就成了第二份真相。
      reasoningEffort: meta?.reasoningEffort ?? null,
    });
  }

  async function selectModel(value, { hasImages = false, thinkOverride = null, resume = false } = {}) {
    const model = resolveWebModel(value);
    if (model.siteId !== siteId) throw new Error(`MODEL_SITE_MISMATCH: 模型 ${model.id} 属于站点${model.siteId}，当前驱动为 ${siteId}`);
    if (model.vision && !hasImages) {
      const err = new Error('VISION_REQUIRES_IMAGE: 识图模式必须附带至少一张图片');
      withWebcodeCode(err, 'VISION_REQUIRES_IMAGE');
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
    return selectModelGeneric(model, { label, resume });
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
  async function selectModelGeneric(model, { label, resume = false }) {
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

    const result = await selectWebModel(page, model, picker, { resume });
    if (!result.ok) {
      selectedModel = null;
      const detail = result.options?.length ? ' — 弹层可选：' + result.options.join('、') : '';
      // 0.19.81：`trigger-disabled` 的报错要与 `no-options` **分开**（真机 z.ai）。
      // 站点在「发过一条消息之后」把模型按钮置灰（60/60 采样、持续 ≥47s），
      // 旧实现照点不误 → 菜单不开 → 报 `no-options`，把「按钮此刻不可用」
      // **误导**成「模型不在菜单里」。这里换成一句指向真因的话。
      const reasonText = result.reason === 'trigger-disabled'
        ? '当前页面的模型按钮不可用（站点在生成中/生成后把它禁用了，按钮文本：'
          + JSON.stringify(result.triggerText ?? null) + '）— 这不是「模型不在菜单里」'
        : result.reason;
      const err = new Error(`MODEL_UNAVAILABLE: 未能切换到 ${result.requested}（${reasonText}）${detail}`);
      withWebcodeCode(err, 'MODEL_UNAVAILABLE');
      err.reason = result.reason;
      throw err;
    }
    // F15（真机 doubao，2026-10-19 Wave2）：分段控件只在新会话页渲染。续聊轮控件
    // 不在页 ⇒ 模式是会话属性、保留即可，但**必须出声**（不能静默成功）：
    // 这条 warn 就是「本轮没有重新选择模型」的可核对痕迹；`strict:false` 让上层
    // 按既有路径把 note 提示给用户（绝不假装已切换，红线 1）。
    if (result.reason === 'segmented-control-absent-on-resume') {
      selectedModel = null;
      warn('[model] segmented control absent on resume; keeping conversation mode');
      return {
        strict: false, ui: 'noop', applied: null,
        fallback: 'segmented-absent-on-resume',
        note: `续聊会话页没有模型分段控件（站点只在新建会话时渲染它）：保留该会话已选的「${model.name}」模式，本轮不切换`,
      };
    }
    selectedModel = model.id;
    if (result.ui === 'noop') {
      // 幂等快路命中：页面**已经是**目标模型 ⇒ 一个 UI 动作都没做。
      // 与 think-effort 的 `already:` 同形（`reason` 里带 `already-current`）。
      return { strict: true, ui: 'noop', applied: result.applied, note: '页面已是目标模型，未做任何 UI 动作' };
    }
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
        withWebcodeCode(err, 'MODEL_UI_CHANGED');
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
      withWebcodeCode(err, 'MODEL_UI_CHANGED');
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
    // F8（真机 Wave1 暴露的取样缺陷）：收束读数 `lastEndReason` / `lastEndReasonAt`
    // 必须出现在**诊断**返回体里，不能只在 `status()` 上。
    //
    // 缺陷现场：`site-verify.mjs` 的 `turn.settled` 取
    // `diag?.lastEndReason ?? st?.lastEndReason`，但
    //   ① `st` 是**发送前**取的（那时本轮还没收束，天然是旧值/null）；
    //   ② `diagnostics()` 返回体里**根本没有** lastEndReason 字段。
    // 两处都取不到 ⇒ 一轮**成功收束**（`noteEndReason('finished')` 已写，
    // 见 runTurn 收尾）也会被记成 `turn.settled=UNVERIFIED`。
    //
    // 放在这里而不是只在调用点重取 status()：诊断接口的语义就是「本轮/最近一轮
    // 的现场」，收束原因是其中最关键的一格；缺了它，任何诊断消费方都会重复踩
    // 同一个坑。调用点同时改成收束后重取（两边都修，读数才可靠）。
    const settle = { lastEndReason, lastEndReasonAt };
    if (!page) return { controls: [], urlPath: null, transport: 'playwright-edge', preview: false, siteId, ...settle };
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
      // 本轮/最近一轮的收束现场（F8）：诊断消费方（test-mock/site-verify.mjs 的
      // turn.settled）必须能从这里读到，否则「成功收束」会被记成「没有收束读数」。
      ...settle,
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
    const report = (s) => { loginPhase = s; try { onState?.(s); } catch {} };
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
      // 0.19.52：上次「关闭」是最小化（见 closeWindow），这里恢复窗口状态即可——
      // 不 goto、不重载，会话现场原地保留。恢复失败不致命（bringToFront 照跑）。
      if (windowMinimized) {
        try {
          const cdp = await ctx.newCDPSession(page);
          const { windowId } = await cdp.send('Browser.getWindowForTarget');
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
          await cdp.detach();
        } catch (err) { warn('window restore failed (stays minimized):', err?.message); }
        windowMinimized = false;
      }
      await page.bringToFront().catch(() => {});
      return { ok: true, alreadyOpen: true, ...windowState() };
    }
    const w = Math.max(360, Math.min(3840, Math.round(Number(width) || 0)) || 1000);
    const h = Math.max(480, Math.min(2160, Math.round(Number(height) || 0)) || 900);
    // 0.19.52：打开窗口的落点**优先回到会话现场**，而不是站点根。旧实现无脑
    // goto(cfg.site)——无头→有头每转换一次就丢一次正在看的对话（用户报的
    // 「切换后要重新加载」的驱动侧一半）。取值顺序：调用方显式 url（登录流程
    // 用它）→ 转换前那一页的真实地址（多数情况正是刚跑完的那条会话）→ 最近
    // 一轮的地址读数（lastTurn.url；标签被关掉时页面已不在）→ 站点根（全新浏览器）。
    let remembered = null;
    if (page && !page.isClosed?.()) remembered = safeUrl(page.url());
    remembered ||= lastTurn?.url || null;
    if (ctx && !headed) {
      // 无头上下文 → 有头窗口：持久 profile 只能开一个实例，必须先关再开。
      try { await ctx.close(); } catch {}
      ctx = null; page = null;
      await launch({ headless: false });
    } else if (!page || page.isClosed()) {
      await ensure();
    }
    headed = true;
    windowMinimized = false;
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
    const target = url || remembered || cfg.site;
    try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {}); } catch { /* already there */ }
    // 与登录同一套判定（z.ai 游客页有输入框，旧「URL 不含 login 即已登录」
    // 会把未登录记成已登录）；先等输入框渲染完再判，避免瞬时误判未登录。
    await page.waitForSelector(SEL.input, { timeout: 15_000 }).catch(() => {});
    loggedIn = await judgeLoggedIn(page);
    if (loggedIn) persistLoginState({ loggedIn: true, at: Date.now(), message: '独立窗口核验' });
    log(`headed window open ${w}x${h} → ${target}`);
    return { ok: true, ...windowState() };
  }

  /**
   * 关闭展示窗口（0.19.52 起语义：**最小化**，不是关掉重启）。
   *
   * 旧实现是 `ctx.close() + 立即重启无头`：一次「关→开」循环要整浏览器重启两遍、
   * 整页重载两遍，且 openWindow 一律 goto 站点根——正在看的会话直接丢现场。这正是
   * 用户报的「每次打开网站窗口都要停顿加载很久 / 切换后要重新加载」的驱动侧根因。
   *
   * 最小化让页面、登录态、会话现场全部原地保留；自动化轮次照常驱动同一页面
   *（最小化只影响渲染节流，SSE/DOM 流不受影响），重新打开 = 恢复窗口 + 前置，
   * 全程零重载。因此也不再需要旧实现里「正在生成就先等它收场」的那段——
   * 最小化不动页面，轮次可以继续跑。
   *
   * CDP 最小化失败（浏览器形态不支持等罕见情形）才回退到旧的关掉重启无头路径。
   */
  async function closeWindow() {
    throwIfTransitioning();
    if (!headed) return { ok: true, ...windowState() };
    if (ctx && page && !page.isClosed()) {
      try {
        const cdp = await ctx.newCDPSession(page);
        const { windowId } = await cdp.send('Browser.getWindowForTarget');
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
        await cdp.detach();
        windowMinimized = true;
        log('headed window minimized (page state preserved — reopen restores it)');
        return { ok: true, ...windowState() };
      } catch (err) {
        warn('window minimize failed — falling back to headless relaunch:', err?.message);
      }
    }
    // 回退路径（旧语义）：真的关掉并回到无头。这里才会打断进行中的轮次，
    // 因此保留旧实现的「先等它收场」。
    if (busy) {
      // 正在生成：不硬关（会杀掉进行中的轮次页面），只标记意图，轮次结束后由 ensure 收尾。
      warn('a web turn is running — window will go headless after it settles');
      await activeSettled();
    }
    try { if (ctx) await ctx.close(); } catch {}
    ctx = null; page = null;
    headed = false;
    windowMinimized = false;
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
      withWebcodeCode(err, 'DRIVER_BUSY');
      throw err;
    }
  }

  function windowState() {
    return {
      // 0.19.52：最小化态不算「开着」——面板的开关按钮按「可见」语义取值：
      // 关闭（=最小化）后按钮回到「打开窗口」，再点走 openWindow 的恢复分支。
      // minimized 单独透出，便于诊断「窗口在但看不见」。
      open: headed && !windowMinimized && Boolean(page && !page.isClosed?.()),
      headed,
      minimized: windowMinimized,
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
          withWebcodeCode(err, 'COOKIE_IMPORT_UNDECRYPTABLE');
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
    // 0.19.18：浏览器关掉即释放账号锁（否则下一次启动会被自己的陈旧锁挡住——
    // 那是最糟的失败形态：用户主动关闭后反而打不开）。只释放自己的那份，
    // 已被别人接管的锁不动（见 releaseBridgeLock 的判据）。
    if (accountLock.held) {
      releaseBridgeLock(cfg.profileDir, { startedAt: PROCESS_STARTED_AT });
      accountLock.held = false;
      accountLock.path = '';
    }
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
  return { sendPrompt, conversationForSession, sendTurn, resetConversation, conversationFor, sessionSlot: sessionSlotFor, connect, interact, openLogin, openWindow, closeWindow, importStorageFromProfile, status, close, diagnostics, getToken, profileCookies, writeProfileCookies, userAgent, probeAttachment, readAccountIdentity, get page() { return page; }, webApi, listSessions, fetchHistory, screenshotBase64, setImageLimitsProvider };
}

function abortError() {
  const err = new Error('webcode driver: aborted');
  err.name = 'AbortError';
  return err;
}
