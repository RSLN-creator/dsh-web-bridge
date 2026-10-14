// decoder.js — 各内容服务 SSE/JSON 流解码器（content-script 风格全局注册表）。
//
// DeepSeek 解码器改编自 MIT 的 webcode 项目（three-water666/webcode）。本次改造：
// • THINK/THINKING 片段不再丢弃：onThink 全程吐出思考增量，finish() 带回 thinking 全文；
//   SET 累积式思考同样只吐增量（与 RESPONSE 同一套防重逻辑），流不会因重复而放大。
// • 图片片段（IMAGE / image_asset_pointer 等）不再被读成空串：onImage 吐出，
//   finish() 带回 images 数组——修复“网页明明出了图、桥却说什么都没有”。
// • 多站点解码器按逆向证据对齐真实事件结构（reference/ 下的逆向仓库为证）：
//   - glm：chatglm.cn 的 /assistant/stream 返回 {conversation_id, status, parts:[{content:[
//     {status, type:'text'|'image'|'code'|'quote_result', text, image:[{image_url}]}]}]}（glm-free-api 同构）；
//   - kimi：kimi.moonshot.cn 的 /completion/stream 是 {event:'cmpl'|'req'|'all_done'|'error', text} 事件流
//     （Kimi-Free-API 同构；cmpl 才取正文，all_done/error 收尾）；
//   - chatgpt：backend-api/conversation 同时存在 JSON-patch 帧 {o:'append', p:'/message/content/parts/0', v} 与
//     结构帧 {message:{content:{parts}}} 两种形态（LLMs2API 同构），两种都认；
//   - qwen：LLMs2API 实测浏览器端为 OpenAI 兼容 SSE（choices[].delta），qwen-free-api 的 h2 直连
//     contents[] 结构仅作兼容兜底，不主用。
// • 通过 globalThis.WebCodeStreamDecoders 按站点 decoder 字段选用。

(function () {
  'use strict';

  const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const readId = (v) => (typeof v === 'string' || typeof v === 'number') ? String(v) : null;
  const normalizePath = (p) => p.replace(/^\/+|\/+$/g, '');
  const joinPaths = (a, b) => {
    const na = normalizePath(a || ''), nb = normalizePath(b || '');
    if (!na) return nb;
    if (!nb) return na;
    return na + '/' + nb;
  };

  class SseDecoder {
    constructor() { this.buf = ''; this.events = []; }
    push(chunk) {
      this.buf += chunk;
      this.buf = this.buf.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = this.buf.indexOf('\n\n')) >= 0) {
        const raw = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        const ev = { event: 'message', data: '' };
        const dataLines = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) ev.event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        ev.data = dataLines.join('\n');
        if (ev.data || ev.event === 'close') this.events.push(ev);
      }
      return this.events.splice(0);
    }
    finish() {
      if (this.buf.trim()) { this.buf += '\n\n'; return this.push(''); }
      return [];
    }
  }

  // ---------- helpers shared by all decoders ----------
  // 站点限流的统一判定（2026-09-13 真机修复）：
  // 限流 hint 是流的**最后一帧**，而「流首段」这类现场取证只截前 400 字符，
  // 真机上看到的 finish_reason 常常是 `rate_l` 这种被掐断的前缀。旧实现用
  // `finish_reason === 'rate_limited'` 精确相等判断，一旦帧尾丢失就漏判，
  // 整轮退化成 no_response_frames —— 长任务（含子代理）被反复打死却看不出
  // 真因。这里改为「前缀匹配 + 服务端原话兜底」，两种证据任一命中即算限流。
  //
  // 0.19.41 补两类**真机遇到的**限流原话（在此之前它们都不命中，用户看到的是一句
  // 无信息量的 `invalid_stream`）：
  //   · kimi（Connect-RPC，2026-09-27）：`error.code = 'resource_exhausted'` +
  //     protobuf 里一段 base64 中文原文
  //     「和Kimi聊天的人太多了，请根据当前速率限制信息后重试。（Request ID…）」
  //     —— **服务端自己的措辞一个字都不含 rate/frequent**，纯文本判据必然漏；
  //   · GLM 系的「当前访问人数过多，请稍后重试」同族。
  const RATE_HINT_TEXT = /过于频繁|请求频繁|访问人数过多|人数太多|聊天的人太多|too\s*(?:many|frequent)|rate\s*limit|slow\s*down/i;
  function rateLimitHint(hintError, rawText) {
    const fr = String(hintError?.finish_reason || '');
    // 前缀匹配：'rate_l' / 'rate_limited' / 'rate_limit_exceeded' 都算
    if (fr && 'rate_limited'.startsWith(fr)) return true;
    if (RATE_HINT_TEXT.test(fr)) return true;
    const content = String(hintError?.content || '');
    if (content && RATE_HINT_TEXT.test(content)) return true;
    // 帧被截断、JSON 都解析不出来时，退回原始文本判断
    return Boolean(rawText) && RATE_HINT_TEXT.test(String(rawText));
  }
  /** 从原始 hint 文本里取服务端原话（截断帧也能用）。 */
  function rateLimitText(rawText) {
    const m = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(rawText || ''));
    return m ? m[1] : null;
  }

  function imageFromValue(v) {
    if (!isRecord(v)) return null;
    const url = v.url ?? v.image?.url ?? v.image_url?.url ?? (typeof v.image === 'string' ? v.image : null);
    const base64 = v.b64_json ?? v.image?.b64_json ?? v.base64 ?? null;
    if (!url && !base64) return null;
    return { url: url || null, base64: base64 || null, mime: v.mime || v.media_type || 'image/png' };
  }
  function imagesIn(obj) {
    const out = [];
    const push = (v) => { const im = imageFromValue(v); if (im) out.push(im); };
    for (const key of ['images', 'image_urls']) {
      if (Array.isArray(obj?.[key])) for (const it of obj[key]) push(typeof it === 'string' ? { url: it } : it);
    }
    if (Array.isArray(obj?.files)) for (const f of obj.files) if (f && /image/i.test(String(f.file_type || f.type || f.mime || ''))) push(f);
    return out;
  }

  // ---------- DeepSeek（JSON-patch over SSE）----------
  const CONTENT_TYPES = new Set(['RESPONSE', 'THINK', 'THINKING']);
  const IMAGE_TYPES = /image|picture|asset/i;
  function readFragment(value) {
    if (!isRecord(value) || typeof value.type !== 'string') return null;
    const type = value.type.toUpperCase();
    const content = CONTENT_TYPES.has(type) && typeof value.content === 'string' ? value.content : '';
    const image = IMAGE_TYPES.test(type) ? imageFromValue(value) : null;
    return { type, content, image };
  }
  function fragmentContentIndex(path, count) {
    const m = /^response\/fragments\/(-1|\d+)\/content$/.exec(path);
    if (!m) return null;
    return m[1] === '-1' ? count - 1 : Number(m[1]);
  }

  class DeepSeekStreamDecoder {
    constructor(options = {}) {
      this.maxChars = options.maxChars || 256000;
      this.onDelta = typeof options.onDelta === 'function' ? options.onDelta : null;
      this.onThink = typeof options.onThink === 'function' ? options.onThink : null;
      this.onImage = typeof options.onImage === 'function' ? options.onImage : null;
      this.sse = new SseDecoder();
      this.failed = false;
      this.lastOp = '';
      this.lastPath = '';
      this.readyResponseId = null;
      this.receivedClose = false;
      this.response = null;
      this.images = [];
      this.receivedChars = 0;
      // DeepSeek 的错误走 event:hint（type=error），不是 event:error——2026-09-13
      // 真机实锤：限流时 ready(request/response id 都已分配)后紧跟
      // hint{type:'error',content:'消息发送过于频繁',clear_response:true,
      // finish_reason:'rate_limited'}，随后服务端撤回消息、零响应帧收流。
      // 记录之，finish() 时把它作为比 no_response_frames 更真实的失败原因。
      this.hintError = null;
      // hint 帧的原始文本另存一份：限流帧常是流的最后一帧，帧尾被掐断时
      // JSON.parse 会失败，只留结构化的 hintError 就什么都判不出来。
      this.hintRaw = '';
    }
    push(chunk) {
      this.receivedChars += chunk.length;
      if (this.receivedChars > this.maxChars * 16) { this.failed = true; return; }
      this.consume(this.sse.push(chunk));
    }
    finish() {
      this.consume(this.sse.finish());
      const collected = {
        text: this.response ? this.response.fragments.filter((f) => f.type === 'RESPONSE').map((f) => f.content).join('').trim() : '',
        thinking: this.response ? this.response.fragments.filter((f) => f.type === 'THINK' || f.type === 'THINKING').map((f) => f.content).join('').trim() : '',
        images: this.response ? this.response.fragments.filter((f) => f.image).map((f) => f.image) : [],
      };
      // 限流优先于 invalid_stream：限流帧本身就是流的最后一帧，帧尾被掐断时
      // JSON.parse 必然失败、this.failed 被置位；若先按 invalid_stream 返回，
      // 就永远看不到「消息发送过于频繁」这个真因（真机 2026-09-13 实锤）。
      if (this.failed) {
        if (!this.response && rateLimitHint(this.hintError, this.hintRaw)) {
          return {
            complete: false, partial: false, reason: 'rate_limited', status: null,
            hint: this.hintError?.content || rateLimitText(this.hintRaw) || null, ...collected,
          };
        }
        return { complete: false, reason: 'invalid_stream', hint: null, ...collected };
      }
      if (!this.receivedClose || !this.response || this.response.status !== 'FINISHED') {
        // 流没送到 FINISHED / close：网页端掉流、被合流截断、或用户切走页面。
        // 旧实现直接 complete:false，把已经解码出来的正文与（可能完整的）工具
        // 调用全部丢掉——真机表现就是「回复到一半突然停止，工具也不执行了」。
        // 正文/思考/图片任何一项非空都算「部分可用」，把 partial 标出来交给
        // 驱动层决定（它知道工具协议是否完整），而不是在解码层判死。
        const partial = Boolean(collected.text || collected.thinking || collected.images.length);
        // 零响应帧 + 限流 hint：归为 rate_limited 而不是笼统的 no_response_frames，
        // 驱动层据此抛 RATE_LIMITED 交给上层退避重试（hint 只在零帧时升级——
        // 若已有响应帧，hint 只是流中途的旁路提示，不影响结果归类）。
        const rateLimited = !this.response && rateLimitHint(this.hintError, this.hintRaw);
        return {
          complete: false,
          partial,
          reason: this.response ? 'stream_ended_before_finished'
            : rateLimited ? 'rate_limited'
            : 'no_response_frames',
          status: this.response?.status || null,
          hint: rateLimited ? (this.hintError?.content || rateLimitText(this.hintRaw) || null) : null,
          ...collected,
        };
      }
      return { complete: true, ...collected };
    }
    consume(events) { for (const ev of events) this.consumeEvent(ev); }
    consumeEvent(ev) {
      if (ev.event === 'close') { this.receivedClose = true; return; }
      if (ev.event === 'hint') {
        // hint 帧先用原文兜底：限流帧常是流的最后一帧，帧尾可能被掐断，
        // JSON.parse 失败时也要能认出「消息发送过于频繁」。
        this.hintRaw = ((this.hintRaw || '') + String(ev.data || '')).slice(-2000);
      }
      let payload;
      try { payload = JSON.parse(ev.data); } catch { this.failed = true; return; }
      if (ev.event === 'error') { this.failed = true; return; }
      if (ev.event === 'hint') {
        if (isRecord(payload) && payload.type === 'error') {
          this.hintError = { content: typeof payload.content === 'string' ? payload.content : '', finish_reason: typeof payload.finish_reason === 'string' ? payload.finish_reason : '' };
        }
        return;
      }
      if (!isRecord(payload)) return;
      if (ev.event === 'ready') { this.readyResponseId = readId(payload.response_message_id); return; }
      if (ev.event !== 'message') return;
      this.consumeDelta(payload);
    }
    consumeDelta(delta) {
      if (isRecord(delta) && typeof delta.o === 'string') this.lastOp = delta.o.toUpperCase();
      if (isRecord(delta) && typeof delta.p === 'string') this.lastPath = normalizePath(delta.p);
      const root = isRecord(delta) ? delta.v : undefined;
      if (isRecord(root) && isRecord(root.response)) { this.consumeResponse(root.response); return; }
      if (!this.response) return;
      if (this.lastOp === 'BATCH' && Array.isArray(root)) {
        for (const op of root) if (isRecord(op)) this.applyOperation(op, this.lastPath);
        return;
      }
      this.applyOperation({ o: this.lastOp, p: this.lastPath, v: root });
    }
    /**
     * 按**下标**把「新的 fragments 数组」相对「旧的」增量外发。
     *
     * 真机缺陷（用户报告「网页明明有输出，harness 端收不到」，本函数是主修）：
     * DeepSeek 会把**整份 response 对象**反复重发（`{o:'SET', v:{response:{…}}}`
     * 与 `{o:'SET', p:'response/fragments'}` 两种写法都出现过），每次 fragments
     * 都比上一次长。旧实现只在「第一次见到 response」时（isFirst）外发增量，
     * 之后每一次重发都**整份静默替换**——于是流式通道里 acc 停在第一帧的内容，
     * 而 finish() 重新读 fragments 拿到的是完整正文。
     *
     * 后果链条（这正是用户看到的现象）：
     *   1. 界面正文停在半路（只有第一批增量被发出）；
     *   2. `index.js` 的协议边界探测基于 acc，工具调用落在被吞掉的后段里 →
     *      一个 tool-call 块都不开，工具从未执行；
     *   3. 收尾时 `finalText`（来自 finish()）与 `textSent` 分叉 → 该轮被判成
     *      「正文空 + 只有思考」→ 交回 THINKING_ONLY_NO_ANSWER，或抛 STREAM_REWRITE。
     * 用户看到的就是「明明有输出，却说我没有正文」。
     *
     * 三条边界（与 `applyOperation` 的 SET 分支同一套语义，必须一致）：
     *   • 同下标内容**变长**且以旧内容为前缀 → 只发增长的后缀；
     *   • 同下标内容被**改写**（不以旧内容为前缀）→ 不发，交给收尾的权威比对；
     *   • **新增**下标 → 整段当增量发。
     *
     * @param {Array} next 新的 fragments（已 readFragment 归一化）
     * @param {Array} prev 旧的 fragments（首次为 null）
     */
    emitFragmentDiff(next, prev) {
      for (let i = 0; i < next.length; i++) {
        const f = next[i];
        const old = Array.isArray(prev) ? prev[i] : null;
        const grow = (newText, oldText) => {
          if (!old) return newText;                                   // 新增片段
          if (newText === oldText) return '';                          // 没变
          if (newText.startsWith(oldText)) return newText.slice(oldText.length); // 增长
          return '';                                                   // 改写 → 不发
        };
        if (f.type === 'RESPONSE') {
          const grown = grow(f.content, old?.content ?? '');
          if (grown) { try { this.onDelta?.(grown); } catch {} }
        } else if (f.type === 'THINK' || f.type === 'THINKING') {
          const grown = grow(f.content, old?.content ?? '');
          if (grown) { try { this.onThink?.(grown); } catch {} }
        } else if (f.image && !old?.image) {
          this.pushImage(f.image);
        }
      }
    }
    consumeResponse(response) {
      if (response.role !== 'ASSISTANT' || !Array.isArray(response.fragments)) { this.failed = true; return; }
      const id = readId(response.message_id) || this.readyResponseId;
      if (!id) { this.failed = true; return; }
      const prev = this.response ? this.response.fragments : null;
      const next = response.fragments.map(readFragment).filter(Boolean);
      // 先外发增量、再落库：emitFragmentDiff 需要旧的 fragments 做对比，
      // 且它内部不会修改 this.response（避免「边比边改」读到半新半旧的状态）。
      this.emitFragmentDiff(next, prev);
      this.response = {
        fragments: next,
        id,
        status: typeof response.status === 'string' ? response.status.toUpperCase() : '',
      };
    }
    pushImage(img) {
      this.images.push(img);
      try { this.onImage?.(img); } catch {}
    }
    applyOperation(op, basePath) {
      const response = this.response;
      if (!response) return;
      const opName = typeof op.o === 'string' ? op.o.toUpperCase() : this.lastOp;
      const path = typeof op.p === 'string' ? joinPaths(basePath, op.p) : (basePath || '');

      if (path === 'response/status' && typeof op.v === 'string') { response.status = op.v.toUpperCase(); return; }

      if (path === 'response/fragments') {
        if (opName === 'SET' && Array.isArray(op.v)) {
          // SET 是**整数组替换**：旧实现直接 `response.fragments = 新数组` 就返回，
          // 于是「新数组里比旧数组多出来的内容」在流式通道上被静默丢掉——
          // 只有 finish() 重新读 fragments 时才可见。与 consumeResponse 是同一个洞
          // 的两个入口（DeepSeek 两种写法都会出现），共用 emitFragmentDiff 保证语义一致。
          const prev = response.fragments;
          const next = op.v.map(readFragment).filter(Boolean);
          this.emitFragmentDiff(next, prev);
          response.fragments = next;
          return;
        }
        if (opName === 'APPEND') {
          const values = Array.isArray(op.v) ? op.v : [op.v];
          for (const item of values) {
            const f = readFragment(item);
            if (!f) continue;
            response.fragments.push(f);
            if (f.type === 'RESPONSE' && f.content) this.onDelta?.(f.content);
            else if ((f.type === 'THINK' || f.type === 'THINKING') && f.content) { try { this.onThink?.(f.content); } catch {} }
            else if (f.image) this.pushImage(f.image);
          }
          return;
        }
        return;
      }

      const idx = fragmentContentIndex(path, response.fragments.length);
      if (idx === null) {
        // reasoning/thinking 相关路径的裸字符串值 → 思考增量；图片相关路径 → 图片
        if (/think|reason/i.test(path) && typeof op.v === 'string' && op.v) { try { this.onThink?.(op.v); } catch {} }
        else if (/image|asset|picture/i.test(path)) { const im = imageFromValue(op.v); if (im) this.pushImage(im); }
        return;
      }
      if ((opName !== 'APPEND' && opName !== 'SET') || typeof op.v !== 'string') { this.failed = true; return; }
      const fragment = response.fragments[idx];
      if (!fragment) { this.failed = true; return; }
      if (fragment.type !== 'RESPONSE') {
        // THINK/THINKING：SET 是累积全文，只吐增量，避免思考链重复放大
        if (opName === 'APPEND') {
          fragment.content += op.v;
          if (op.v && this.onThink) { try { this.onThink(op.v); } catch {} }
        } else {
          if (!op.v.startsWith(fragment.content)) { this.failed = true; return; }
          const grown = op.v.slice(fragment.content.length);
          fragment.content = op.v;
          if (grown && this.onThink) { try { this.onThink(grown); } catch {} }
        }
        return;
      }
      if (opName === 'APPEND') {
        fragment.content += op.v;
        if (this.onDelta) { try { this.onDelta(op.v); } catch {} }
      } else {
        if (!op.v.startsWith(fragment.content)) { this.failed = true; return; }
        const grown = op.v.slice(fragment.content.length);
        fragment.content = op.v;
        if (this.onDelta && grown) { try { this.onDelta(grown); } catch {} }
      }
    }
  }

  // ---------- OpenAI 兼容 SSE（通义等）----------
  class OpenAiSseDecoder {
    constructor(options = {}) {
      this.onDelta = options.onDelta || null;
      this.onThink = options.onThink || null;
      this.onImage = options.onImage || null;
      this.sse = new SseDecoder();
      this.text = ''; this.think = ''; this.images = [];
      this.done = false; this.failed = false;
    }
    push(c) { for (const ev of this.sse.push(c)) this.eat(ev); }
    finish() {
      for (const ev of this.sse.finish()) this.eat(ev);
      // 与 JsonLinesDecoder.finish 同一条纪律：两个失败分支都要把**已解内容**
      // 带出去，且 partial 只在没收完整时出现（见该处的完整注释）。这里不合并成
      // 一个基类方法，是因为三个 SSE 类各有自己的 eat/字段，合并会把「收尾」与
      // 「解析」两件事耦合到一起。
      const content = { text: this.text.trim(), thinking: this.think.trim(), images: this.images };
      const partial = Boolean(content.text || content.thinking || content.images.length);
      if (this.failed) return { complete: false, partial, reason: 'invalid_stream', ...content };
      if (!this.done) return { complete: false, partial, reason: 'incomplete', ...content };
      return { complete: true, ...content };
    }
    eat(ev) {
      if (ev.event === 'close') { this.done = true; return; }
      if (ev.event === 'error') { this.failed = true; return; }
      if (!ev.data) return;
      const d = ev.data.trim();
      if (d === '[DONE]') { this.done = true; return; }
      let j; try { j = JSON.parse(d); } catch { return; }
      if (j?.error) { this.failed = true; return; }
      // Qwen 直连兜底（qwen-free-api 同构）：{sessionId, msgId, contentType, msgStatus, contents:[{contentType, role, content}]}
      if (isRecord(j) && Array.isArray(j.contents) && !Array.isArray(j.choices)) {
        for (const part of j.contents) {
          if (!isRecord(part)) continue;
          const ct = String(part.contentType || '');
          if (ct !== 'text' && ct !== 'text2image') continue;
          const t = typeof part.content === 'string' ? part.content : '';
          if (t) {
            this.text += t;
            try { this.onDelta?.(t); } catch {}
          }
        }
        if (String(j.msgStatus || '') === 'finished') this.done = true;
        return;
      }
      const ch = j.choices?.[0];
      const delta = ch?.delta || ch?.message || null;
      if (!delta) return;
      const t = typeof delta.content === 'string' ? delta.content : '';
      if (t) { this.text += t; try { this.onDelta?.(t); } catch {} }
      const th = (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '') ||
                 (typeof delta.reasoning === 'string' ? delta.reasoning : '');
      if (th) { this.think += th; try { this.onThink?.(th) } catch {} }
      // Qwen v2（2026-09-12 真机抓包）：思考摘要在 delta.extra.summary_thought.content
      // （字符串数组），结束帧无 finish_reason，以 delta.status='finished' 收束。
      const st = delta?.extra?.summary_thought?.content;
      if (Array.isArray(st)) {
        const t2 = st.filter((x) => typeof x === 'string').join('');
        if (t2) { this.think += t2; try { this.onThink?.(t2); } catch {} }
      }
      for (const img of imagesIn(delta)) { this.images.push(img); try { this.onImage?.(img); } catch {} }
      if (ch?.finish_reason || delta?.status === 'finished') this.done = true;
    }
  }

  // ---------- ChatGPT（backend-api/conversation）----------
  class ChatGptDecoder {
    constructor(options = {}) {
      this.onDelta = options.onDelta || null;
      this.onThink = options.onThink || null;
      this.onImage = options.onImage || null;
      this.sse = new SseDecoder();
      this.text = ''; this.think = ''; this.images = [];
      this.partSeen = [];
      this.done = false; this.failed = false;
    }
    push(c) { for (const ev of this.sse.push(c)) this.eat(ev); }
    finish() {
      for (const ev of this.sse.finish()) this.eat(ev);
      // 与 JsonLinesDecoder.finish 同一条纪律：两个失败分支都要把**已解内容**
      // 带出去，且 partial 只在没收完整时出现（见该处的完整注释）。这里不合并成
      // 一个基类方法，是因为三个 SSE 类各有自己的 eat/字段，合并会把「收尾」与
      // 「解析」两件事耦合到一起。
      const content = { text: this.text.trim(), thinking: this.think.trim(), images: this.images };
      const partial = Boolean(content.text || content.thinking || content.images.length);
      if (this.failed) return { complete: false, partial, reason: 'invalid_stream', ...content };
      if (!this.done) return { complete: false, partial, reason: 'incomplete', ...content };
      return { complete: true, ...content };
    }
    emitText(t) { if (!t) return; this.text += t; try { this.onDelta?.(t); } catch {} }
    emitThink(t) { if (!t) return; this.think += t; try { this.onThink?.(t); } catch {} }
    emitParts(parts) {
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (typeof part === 'string') {
          const seen = this.partSeen[i] ?? '';
          if (part.startsWith(seen)) this.emitText(part.slice(seen.length));
          else this.emitText(part); // 站点重写：全量补发（block-end 侧还有全文校验）
          this.partSeen[i] = part;
          continue;
        }
        if (!isRecord(part)) continue;
        const ct = String(part.content_type || part.contentType || '');
        if (/image/i.test(ct) || part.image_asset_pointer) {
          const ptr = part.image_asset_pointer || part;
          const img = {
            url: ptr?.url ?? null,
            pointer: ptr?.pointer_path ?? null,
            mime: ptr?.content_type || 'image/png',
            assetPointer: ct === 'image_asset_pointer',
          };
          this.images.push(img); try { this.onImage?.(img); } catch {}
        } else if (typeof part.text === 'string') {
          const seen = this.partSeen[i] ?? '';
          if (part.text.startsWith(seen)) this.emitText(part.text.slice(seen.length));
          this.partSeen[i] = part.text;
        }
      }
    }
    eat(ev) {
      if (ev.event === 'close') { this.done = true; return; }
      if (!ev.data) return;
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      // JSON-patch 帧（LLMs2API 同构）：{o:'append', p:'/message/content/parts/0', v:'文本'}
      if (isRecord(j) && typeof j.o === 'string' && typeof j.p === 'string' && typeof j.v === 'string') {
        const p = String(j.p);
        if (/reasoning|thinking/i.test(p)) { this.emitThink(j.v); return; }
        if (p.includes('/message/') && j.v) { this.emitText(j.v); return; }
        return;
      }
      if (isRecord(j) && j.type === 'message_stream_complete') { this.done = true; return; }
      const v = j && Object.prototype.hasOwnProperty.call(j, 'v') ? j.v : j;
      if (typeof v === 'string') { this.emitText(v); return; }
      if (!isRecord(v)) return;
      if (typeof v.reasoning === 'string') this.emitThink(v.reasoning);
      if (typeof v.p === 'string' && /reasoning|thinking/i.test(v.p) && typeof v.v === 'string') this.emitThink(v.v);
      const msg = v.message ?? v;
      const parts = msg?.content?.parts ?? (Array.isArray(v.parts) ? v.parts : null);
      if (Array.isArray(parts)) this.emitParts(parts);
      if (msg?.status === 'finished_successfully' && (msg?.end_turn === true || msg?.metadata?.finish_details)) {
        if (v.is_completion !== false) this.done = true;
      }
    }
  }

  // ---------- JSON-lines 家族（GLM / Kimi / 豆包 / Grok）----------
  class JsonLinesDecoder {
    constructor(options = {}) {
      this.onDelta = options.onDelta || null;
      this.onThink = options.onThink || null;
      this.onImage = options.onImage || null;
      this.buf = '';
      this.text = ''; this.think = ''; this.images = [];
      this.done = false; this.failed = false;
      // 网页会话身份（C-1）：站点在流里报的会话 id。基类默认 null，子类在 obj()
      // 里认字段名后填上。放在基类是为了让**所有**解码器的 finish() 输出形状一致
      // ——驱动只认 result.conversationId，不必按站点分支。
      this.conversationId = null;
      // 「网页自己说它还在生成」的状态位（0.19.41）。默认 false = 没有这个信号的
      // 站点行为与既有实现逐字相同（驱动侧只在它为 true 时才多等）。
      //
      // 为什么必须由**流**来回答「生成完了没有」：驱动侧已有的三条收束防线都是
      // **推断**（流静默 N 秒 + 页面 DOM 停止增长 + 只出思考的硬上限），而推断在
      // 「思考阶段 DOM 看不到内容」的站点上必然出错——真机 kimi：一轮带附件的轮次
      // 在思考阶段被 2.5s 稳态收束，正文一个字符都没等到
      // （`wip steady state — settling turn with 0 chars answer / 114 chars thinking`）。
      // kimi 的 Connect-RPC 流里**本来就有**权威信号：`message.status` =
      // MESSAGE_STATUS_GENERATING / MESSAGE_STATUS_COMPLETED。有权威信号就不该靠推断。
      this.generating = false;
      // 失败时的**服务端原话**（默认 null ⇒ finish() 退回 'invalid_stream'）。
      // 放在基类让所有解码器的 finish() 形状一致，与 conversationId 同一考虑。
      this.failureReason = null;
    }
    push(c) {
      this.buf += c;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this.line(line);
      }
    }
    finish() {
      if (this.buf.trim()) this.line(this.buf.trim());
      // 已解内容的唯一出口。**两个失败分支都必须带上它**——否则流里明明解出了
      // 正文/思考，返回值里却是空的（真机 2026-09-26：GLM 流无收尾帧时整轮被判
      // 「网页什么都没产出」）。
      const content = { text: this.text.trim(), thinking: this.think.trim(), images: this.images };
      // 「有内容可交」与「跑完整了」是两件事：partial 为真表示正文/思考/图片至少
      // 有一项已解出来，调用方可以按部分流收束。**只在没收完整时出现**——
      // complete 结果必须与改动前逐字同形，多一个恒真字段会让调用方
      // （browser-driver 的 `!result.complete && !result.partial` 等）分不开
      // 「跑完了」与「只跑了一半」。
      const partial = Boolean(content.text || content.thinking || content.images.length);
      // 失败原因优先用**解码器自己解出的服务端原话**（kimi 的错误帧），
      // 没有时才退回泛化码。旧实现只有 `invalid_stream` 一个词，真机上
      // 用户看到的就是它——而服务端其实说了「聊天的人太多了，请稍后重试」。
      const failReason = this.failureReason || 'invalid_stream';
      if (this.failed) return { complete: false, partial, reason: failReason, conversationId: this.conversationId, ...content };
      if (!this.done) return { complete: false, partial, reason: 'incomplete', conversationId: this.conversationId, ...content };
      return {
        complete: true, ...content,
        conversationId: this.conversationId,
      };
    }
    line(l) {
      if (l === '[DONE]') { this.done = true; return; }
      let j; try { j = JSON.parse(l); } catch { return; }
      this.obj(j);
    }
    /** 网页**自己**说它还在生成吗？（默认：没有这个信号 ⇒ 永远 false）
     *
     *  只有拿到权威信号的站点才实现它（当前是 kimi 的 Connect-RPC）。
     *  驱动侧只在返回 true 时推迟「稳态收束」，且**仍受硬上限约束**——
     *  一个永远不说「完成」的站点不会被这里挂死。 */
    isGenerating() { return this.generating === true; }
    emitText(t) { if (!t) return; this.text += t; try { this.onDelta?.(t); } catch {} }
    emitThink(t) { if (!t) return; this.think += t; try { this.onThink?.(t); } catch {} }
    pushImage(img) { this.images.push(img); try { this.onImage?.(img); } catch {} }
    obj() {}
  }

  function makeJsonLineDecoder({ pickText, pickThink, pickImages, isDone }) {
    return class extends JsonLinesDecoder {
      obj(j) {
        if (!isRecord(j)) return;
        if (j.error) { this.failed = true; return; }
        this.emitText(pickText(j));
        this.emitThink(pickThink ? pickThink(j) : null);
        for (const img of pickImages ? pickImages(j) : []) this.pushImage(img);
        if (isDone && isDone(j)) this.done = true;
      }
    };
  }

  const str = (v) => (typeof v === 'string' && v) ? v : null;

  // ---------- GLM（chatglm.cn /chatglm/backend-api/assistant/stream）----------
  // 真实帧（glm-free-api 同构，标准 SSE）：data: {conversation_id, status, parts:[{status, content:[
  //   {status, type:'text'|'image'|'code'|'quote_result', text, image:[{image_url}]}]}]}
  // ⚠ text 是**累积全文**而非增量：同一条目在后帧里重复给出「从头到当前」的
  //   完整文本（真机 2026-09-11 实测一句话被原样输出两遍——末两个 update/finish
  //   帧各带全文）。这里按 part:content 槽位做累积差分，只外发新增后缀；
  //   纯增量流（t 恒为新增后缀）与累积流在 diff 下语义一致，两种都兼容。
  class GlmDecoder extends JsonLinesDecoder {
    constructor(options) { super(options); this.seen = new Map(); this.glmSegBuf = ''; }
    /**
     * 外发正文前剥掉**走错通道的思考闭合标签**（0.19.46）。
     *
     * ## 真机取证（2026-09-28，GLM 长跑探针 step 1，`%TEMP%\glm-longrun-EVIDENCE.txt`）
     *
     * 模型把思考的**闭合标签**写进了 text 通道，正文变成：
     *
     *     ```json
     *     {"name": "pwsh", …}
     *     ```</think>两条输出分别是"LQ524"和"STEP2-LQ524"。
     *
     * 即 `</think>` 夹在代码围栏与后续散文之间。用户报的「正文回复明显不对」
     * 有一份就是它——**一个纯属传输残留的标签混进了交给用户的正文**。
     *
     * ## 为什么剥、以及为什么只剥这一族
     *
     * 思考内容本身走 `type === 'think'` 的独立通道（本解码器已正确处理），
     * 因此 text 通道里的 `</think>` / `</thinking>` **不可能是正文的一部分**：
     * 它是模型把两个通道的边界写串了。剥掉它不改变任何语义，只去掉噪声。
     *
     * 判据刻意收窄到**这几个闭合标签本身**，不做任何通用 HTML 清洗：
     *   · 不碰 `<thinking>` 的**开**标签——那可能真的是散文里的引用（宁可留着也不误删）；
     *   · 不碰其它任何标签（本项目对「放宽判据」有多次教训：宽判据会吃掉真内容）。
     * 与 `agent-preset.js` 的关系：那边是**工具协议**的唯一真源，管的是调用围栏；
     * 这里剥的是站点流自己的残留标签，不属于协议层，因此不构成第二套协议口径。
     */
    emitText(t) {
      if (!t) return;
      const cleaned = String(t).replace(/<\/think(?:ing)?>\s*/gi, '');
      if (cleaned) super.emitText(cleaned);
    }
    /**
     * 一帧原始 SSE 文本 → 待解析的数据行。
     *
     * **必须由 push() 与 finish() 共用**：finish() 要把缓冲区里那半帧（缺 \n\n
     * 终结符）按**同一条规则**解出来。若各写一份，「被截断的尾帧能不能救回来」
     * 就取决于哪一份先被改，而漏掉的恰恰是整段回复的**最后一句**。
     */
    frameData(frame) {
      const dataLines = [];
      for (const line of String(frame || '').split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      return dataLines.join('\n');
    }
    push(chunk) {
      this.buf += chunk;
      this.buf = this.buf.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = this.buf.indexOf('\n\n')) >= 0) {
        const frame = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        const data = this.frameData(frame);
        if (data) this.line(data);
      }
    }
    /**
     * 收尾：先把缓冲区里的**残缺尾帧**按 SSE 规则解析掉，再交给基类。
     *
     * 基类 finish() 走的是 `this.line(this.buf.trim())`，而本类（及基类）的
     * line() 是 `JSON.parse(l)` —— 缓冲区里躺的是原始 SSE 文本 `data: {...}`，
     * `JSON.parse('data: {...}')` 必抛 `Unexpected token 'd'`，于是被静默吞掉。
     * 真机后果（2026-09-26 取证）：GLM 正常收尾时**没有** status:'finish' 帧，
     * 末帧常常缺终结空行，那一段正文就此消失。
     */
    finish() {
      const tail = this.buf.trim();
      this.buf = '';
      if (tail) {
        const data = this.frameData(tail);
        if (data) { try { this.line(data); } catch { /* 残缺到解不出 JSON：如实丢弃 */ } }
      }
      return super.finish();
    }
    line(l) {
      let j; try { j = JSON.parse(l); } catch { return; }
      this.obj(j);
    }
    obj(j) {
      if (!isRecord(j)) return;
      // 会话身份：GLM 把会话 id 放在**每一帧**的 conversation_id 字段里（真机
      // 2026-09-14 首帧实录见 finish() 的注释）。这是本桥唯一的会话身份来源——
      // URL 形状与 DeepSeek 完全不同，靠 URL 取 id 必然恒为 null。
      const cid = readId(j.conversation_id);
      if (cid) this.conversationId = cid;
      if (j.error) { this.failed = true; return; }
      if (j.status === 'finish') this.done = true;
      if (!Array.isArray(j.parts)) return;
      for (let pi = 0; pi < j.parts.length; pi++) {
        const part = j.parts[pi];
        if (!isRecord(part) || !Array.isArray(part.content)) continue;
        for (let ci = 0; ci < part.content.length; ci++) {
          const c = part.content[ci];
          if (!isRecord(c)) continue;
          const type = String(c.type || '');
          // GLM 内置工具轮边界（真机 2026-09-21 抓帧）：`tool_calls`（发起调用）、
          // `tool_result`（工具执行结果）本身不带正文，但它们**切断了文本段**——
          // 工具结束后模型输出「新段落」，站点先把该段落拆成多个短碎片、随后把整段
          // 作为一帧完整快照重发（f29/f30 与 f20-f28 碎片拼接逐字相同）。因此遇
          // 工具帧即把「本段落累积」清零：快照逐步被碎片累积、到达时间接判重。
          if (type === 'tool_calls' || type === 'tool_result') { this.glmSegBuf = ''; continue; }
          if (type === 'think') {
            // GLM-5.3 思考内容：content[].type='think'，字段名 think。过程中为纯增量
            // delta（真机抓包：28078 字符思维链拆成 861 个 delta），finish 帧却带
            // 累积全文——与 text 一样走差分，全量重复帧被 startsWith 吸收。
            const t = typeof c.think === 'string' ? c.think : '';
            const tKey = 'think:' + type;
            const prevT = this.seen.get(tKey) || '';
            if (t && t !== prevT) {
              if (t.startsWith(prevT)) {
                this.seen.set(tKey, t);
                if (t.length > prevT.length) this.emitThink(t.slice(prevT.length));
              } else if (prevT.startsWith(t)) { /* 迟到的旧帧 */ }
              else { this.seen.set(tKey, prevT + t); this.emitThink(t); }
            }
          } else if (type === 'text') {
            const t = typeof c.text === 'string' ? c.text : '';
            // 槽位 key 用 type 而不是 content 索引：GLM 的 finish 帧会把
            // think/text 合并进同一条 content 数组，索引在帧间会漂移（真机实测）。
            const key = type;
            const prev = this.seen.get(key) || '';
            if (t === prev) continue;                       // 累积流：末帧重复全文，跳过
            if (t.startsWith(prev)) {
              // 累积/增量 alike：只发新增后缀
              this.seen.set(key, t);
              if (t.length > prev.length) this.emitText(t.slice(prev.length));
            } else if (prev.startsWith(t)) {
              // 比已发内容更短的帧 = 迟到的旧帧，丢弃
              continue;
            } else {
              // 与已发内容无前缀关系 = 新片段（glm-free-api 的增量语义），追加。
              // 真机 raw-frames（2026-09-21，工具轮 execute_sandbox_code）证实：GLM
              // **不是纯增量也不是纯累积，而是「增量碎片 → 完整快照补全」混合**。
              // 且存在两种快照形态：
              //   形态 A：工具后碎片拼出**整段**，再把该整段本身作为快照重发（f 与
              //           SNAP 逐字相同）——旧代码 `t === glmSegBuf` 拦截这一种。
              //   形态 B（2026-09-21 第二次抓帧 1789973933106 新增）：碎片只拼出
              //           **段首**（如「…3¹² = (」），随后站点发一帧从头含到结尾的
              //           完整快照（拼上剩余「(3⁶)² = 729² = 531441」），再原样重发
              //           该快照一次。形态 B 的完整快照以 glmSegBuf 为**前缀**但比其
              //           长，旧 `===` 拦不住 → 补齐剩余被当成新段 emit → 整段播两遍。
              // 判别（覆盖两形态）：
              //   若 t 恰等于自工具轮以来的碎片累积 → 形态 A 重复快照，丢弃；
              //   若 t 以累积为前缀且更长（= 假「新增」其实是快照补全）→ 只补发剩余，
              //     并把累积更新为完整快照，使随后的原样重发帧命中 `===`。
              // 注意：真「同一前缀更长」的**纯新增**（f20 后接 f21 那种增量续写）走上面
              // 的 startsWith(prev) 分支，不会进这里；能进到这里的都是与 seen 无前缀
              // 关系的独立新段，用 glmSegBuf 前缀判定不会误伤增量。
              if (this.glmSegBuf) {
                if (t === this.glmSegBuf) { this.seen.set(key, prev + t); continue; }
                if (t.length > this.glmSegBuf.length && t.startsWith(this.glmSegBuf)) {
                  const add = t.slice(this.glmSegBuf.length);
                  this.seen.set(key, prev + add);
                  this.glmSegBuf = t;
                  this.emitText(add);
                  continue;
                }
              }
              this.seen.set(key, prev + t);
              this.glmSegBuf += t;
              this.emitText(t);
            }
          } else if (type === 'code') {
            // GLM 原生**结构化代码块** part（0.19.23 补）。
            //
            // ## 为什么必须补
            //
            // GLM 网页把「模型要求发起一个调用」表示成 `content[].type === 'code'`
            // 的**结构化字段** `code`，而不是正文里的 ``` 围栏文本。本解码器此前只认
            // text / think / image，`code` 一路落到末尾被静默忽略。
            //
            // 离线实证（`.tmp/probe-glm-native.mjs` ①a 对照 ①b，随机可复跑）：
            //   同一段调用 JSON 放进 `type:'code'`  ⇒ deltas 为空、text 为空，
            //                                        **整个调用消失**；
            //   同一段放进 `type:'text'`           ⇒ 正常外发。
            //
            // 参考实现同构：`reference/glm-free-api/src/api/controllers/chat.ts:994-1013`
            // 把 `type == 'code'` 当**一等公民**，为它拼 codeHead/codeFooter（``` 围栏）
            // 再交给上层——即在这条流里，`code` 与 `text` 是并列的两种正文载体。
            // 本桥此前只实现了后者，这就是「原生 glm 格式」缺的那一半。
            //
            // ## 判据刻意收窄（不要放宽）
            //
            // **只在它确实是工具调用时才接进正文通道**：
            //   · 普通代码块（GLM 自带的代码解释器等）维持 0.19.22 及以前的既有行为
            //     ——丢弃，不外发。贸然外发会把模型内部的草稿代码整段铺进会话，
            //     那是比丢一个调用更常见的噪声；
            //   · 调用形态（含 `"mcp_action"` 或以 `{` 开头）才 emit，让**既有**协议
            //     解析器认出它（findProtocolStart 的裸 JSON 锚点认 `{\s*["\{]`，
            //     见 index.js 的 openerBoundary）——不新开第二条解析通路。
            //
            // 去重与上面 text 分支**同形**：GLM 的 finish 帧会重发全量，前缀吸收即可。
            // 槽位 key 用单槽 'code'（与 text 同理：part 索引在帧间会漂移，
            // 用索引做 key 会让同一段重复外发）。
            const codeText = typeof c.code === 'string' ? c.code : '';
            if (!codeText) continue;
            const codeIsCall = codeText.includes('"mcp_action"') || /^\s*\{/.test(codeText);
            if (!codeIsCall) continue;
            const codeKey = 'code';
            const prevCode = this.seen.get(codeKey) || '';
            if (codeText === prevCode) continue;
            if (codeText.startsWith(prevCode)) {
              this.seen.set(codeKey, codeText);
              if (codeText.length > prevCode.length) this.emitText(codeText.slice(prevCode.length));
            } else if (prevCode.startsWith(codeText)) {
              continue;                                  // 迟到的旧帧
            } else {
              this.seen.set(codeKey, prevCode + codeText);
              this.emitText(codeText);
            }
          } else if (type === 'image' && Array.isArray(c.image)) {
            for (const im of c.image) {
              if (isRecord(im) && typeof im.image_url === 'string' && im.image_url) {
                this.pushImage({ url: im.image_url, mime: 'image/png' });
              }
            }
          }
        }
      }
    }
  }

  // ---------- Kimi（kimi.moonshot.cn /api/chat/{id}/completion/stream）----------
  // 真实帧（Kimi-Free-API 同构，标准 SSE）：data: {event:'cmpl', text} / {event:'req', id} /
  // {event:'search_plus', msg:{type:'get_res', title, url}} / {event:'all_done'} / {event:'error'}。
  // 只有 cmpl 事件携带正文增量；all_done/error 收尾。
  class KimiDecoder extends JsonLinesDecoder {
    push(chunk) {
      this.buf += chunk;
      this.buf = this.buf.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = this.buf.indexOf('\n\n')) >= 0) {
        const frame = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        const data = dataLines.join('\n');
        if (data) this.line(data);
      }
    }
    line(l) {
      let j; try { j = JSON.parse(l); } catch { return; }
      this.obj(j);
    }
    obj(j) {
      if (!isRecord(j)) return;
      const ev = String(j.event || '');
      if (ev === 'error') { this.failed = true; return; }
      if (ev === 'all_done') { this.done = true; return; }
      if (ev === 'cmpl') {
        const t = typeof j.text === 'string' ? j.text : '';
        if (t) this.emitText(t);
        const th = typeof j.reasoning === 'string' ? j.reasoning
          : typeof j.thinking === 'string' ? j.thinking : '';
        if (th) this.emitThink(th);
        for (const img of imagesIn(j.extra_info)) this.pushImage(img);
        for (const img of imagesIn(j)) this.pushImage(img);
      }
    }
  }
  const DoubaoDecoder = makeJsonLineDecoder({
    pickText: (j) => str(j.event_data) ?? str(j.text) ?? str(j.delta?.message?.content?.text) ?? str(j.delta?.content) ?? str(j.message?.content),
    pickThink: (j) => str(j.reasoning) ?? str(j.thinking) ?? str(j.reasoning_content) ?? str(j.delta?.message?.reasoning_content),
    pickImages: (j) => imagesIn(j),
    isDone: (j) => j.event === 'done' || j.is_finish === true || j.done === true || j.event_type === 'done' || j.status === 'done',
  });
  const GrokDecoder = makeJsonLineDecoder({
    pickText: (j) => {
      if (j?.responseType && !/token/i.test(String(j.responseType))) return null;
      return str(j?.result?.token) ?? str(j?.result?.response);
    },
    pickThink: (j) => str(j?.result?.thinkingToken) ?? str(j?.result?.reasoningToken),
    pickImages: (j) => imagesIn(j?.result || j),
    isDone: (j) => j?.responseType === 'done' || j?.result?.done === true,
  });

  // ---------- Claude（append_message SSE）----------
  class ClaudeSseDecoder {
    constructor(options = {}) {
      this.onDelta = options.onDelta || null;
      this.onThink = options.onThink || null;
      this.onImage = options.onImage || null;
      this.sse = new SseDecoder();
      this.text = ''; this.think = ''; this.images = [];
      this.done = false; this.failed = false;
    }
    push(c) { for (const ev of this.sse.push(c)) this.eat(ev); }
    finish() {
      for (const ev of this.sse.finish()) this.eat(ev);
      // 与 JsonLinesDecoder.finish 同一条纪律：两个失败分支都要把**已解内容**
      // 带出去，且 partial 只在没收完整时出现（见该处的完整注释）。这里不合并成
      // 一个基类方法，是因为三个 SSE 类各有自己的 eat/字段，合并会把「收尾」与
      // 「解析」两件事耦合到一起。
      const content = { text: this.text.trim(), thinking: this.think.trim(), images: this.images };
      const partial = Boolean(content.text || content.thinking || content.images.length);
      if (this.failed) return { complete: false, partial, reason: 'invalid_stream', ...content };
      if (!this.done) return { complete: false, partial, reason: 'incomplete', ...content };
      return { complete: true, ...content };
    }
    eat(ev) {
      if (ev.event === 'close') { this.done = true; return; }
      if (!ev.data) return;
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      if (j.error) { this.failed = true; return; }
      if (j.type === 'content_block_delta') {
        const d = j.delta || {};
        if (d.type === 'thinking_delta' && typeof d.thinking === 'string') { this.think += d.thinking; try { this.onThink?.(d.thinking); } catch {} }
        else if (typeof d.text === 'string' && d.text) { this.text += d.text; try { this.onDelta?.(d.text); } catch {} }
      } else if (typeof j.completion === 'string' && j.completion) {
        this.text += j.completion; try { this.onDelta?.(j.completion); } catch {}
      } else if (j.type === 'message_stop' || j.stop_reason) {
        this.done = true;
      }
    }
  }

  /**
   * 把 kimi Connect-RPC 的错误帧解成人能读的一句话（0.19.41）。
   *
   * 真机原始帧（2026-09-27）：
   *   {"error":{"code":"resource_exhausted","details":[{"type":"common.error.v1.ErrorDetail",
   *     "value":"CHUSSQoFemgtQ04SQOWSjEtpbWnogYrlpKnnmoTkurrlpKrlpJrkuobvvIzor7fm…"}]}}
   * `value` 是 base64；前 8 字节是 protobuf 头部（`\x08\x75\x12\x49\x0a\x05\x7a\x68\x2d\x43\x4e`），
   * 其后是 UTF-8 原话：「和Kimi聊天的人太多了，请根据当前速率限制信息后重试。（Request ID…）」。
   *
   * 做法与边界：先整体 base64 解码，再从第一个可打印段里取连续 UTF-8 文本；
   * **解不出来就原样返回**（含 code 与 value 前缀），绝不编造一句「服务繁忙」——
   * 编造的文案会让人以为桥知道发生了什么，而它其实不知道。
   *
   * @param {object} err kimi 错误帧的 error 对象
   * @returns {string} 可读原话（含 code）；任何异常都退回 JSON 摘要
   */
  function kimiErrorText(err) {
    const code = String(err?.code || 'unknown');
    try {
      const value = String(err?.details?.[0]?.value || '');
      if (!value) return code;
      const buf = Buffer.from(value, 'base64');
      // 从第一个 \n（protobuf 文本字段的分隔）之后取到末尾，替换掉非文本控制字节。
      let s = buf.toString('utf8');
      // protobuf 头（tag+len）在第一个 `\n` 之前，其后是服务端原话。
      const cut = s.indexOf('\n');
      if (cut >= 0 && cut + 1 < s.length) s = s.slice(cut + 1);
      // 去掉残留的控制字符（protobuf 头被切剩的字节），保留正文与标点。
      s = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').trim();
      if (!s) return code + '（服务端未给出可读原话，value 前缀 ' + value.slice(0, 24) + '）';
      return code + '：' + s;
    } catch {
      return code;
    }
  }

  // ---------- Kimi Connect-RPC（2026-09-21 真机确证）----------
  // kimi 网页已从旧 SSE（/api/chat/{id}/completion/stream）全面迁移到 Connect-RPC
  // （POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat，application/connect+json）。
  // 响应是二进制帧流，captureInit 已按 [flags(1)][len(4BE)][json] 逐帧拆分并以
  // 一行 JSON emit；本解码器按行喂入。逐帧语义（真机抓帧 2026-09-21 录得）：
  //   {op:'set',  mask:'chat.lastRequest',  chat:{id, lastRequest:{options:{model:'k2d6-chat',...},tools:[...]}}}
  //   {op:'set',  mask:'message',  message:{id, role, status, blocks:[{text:{content}}]}}
  //   {op:'set',  mask:'block.multiStage/stage',  block:{stage:{name:'STAGE_NAME_THINKING',status}}}
  //   {op:'set'|'append', mask:'block.think.content', block:{think:{content:'增量碎片'}}}
  //   {op:'set',  mask:'block.text',  block:{text:{content:'正文'}}}   ← 最终正文（set 一次）
  //   {op:'set',  mask:'message.status', message:{id, status:'MESSAGE_STATUS_COMPLETED'}}
  //   {eventOffset,\n done:{}}                                        ← done 标志
  //   {}                                                              ← 终结空帧
  // 会话身份来自 chat.id；模型从 chat.lastRequest.options.model 取；工具清单在
  // chat.lastRequest.tools（TOOL_TYPE_SEARCH / TOOL_TYPE_CRON_JOB）。
  class KimiConnectDecoder extends JsonLinesDecoder {
    obj(j) {
      if (!isRecord(j)) return;
      // 错误帧的**可读化**（0.19.41）。真机 2026-09-27 原始帧：
      //   {"error":{"code":"resource_exhausted","details":[{"type":"common.error.v1.ErrorDetail",
      //             "value":"CHUSSQoFemgtQ04SQOWSjEtpbWnogYrlpKnnmoTkurrlpKrlpJrkuobvvIzor7fm…"}]}}
      // 旧实现只置 `failed = true`，于是整轮变成
      //   `web capture ended incomplete: invalid_stream | 流首段: {"heartbeat":{}}`
      // ——**用户与排查者都看不到服务端到底说了什么**，而这正是本项目纪律里
      // 「报错必须带现场」的反面。`value` 是 base64，前 8 字节是 protobuf 头部
      // （tag+len），其后是 UTF-8 原话；解不出来就原样留着，绝不编造。
      if (j.error) {
        this.failed = true;
        this.failureReason = kimiErrorText(j.error);
        return;
      }
      const cid = readId(j.chat?.id);
      if (cid) this.conversationId = cid;
      if (isRecord(j.done) || j.done === true) { this.done = true; return; }
      if (isRecord(j.message) && /assistant/i.test(String(j.message.role || ''))) {
        // 终态裁定（0.19.41 由「注释」变成「代码」）。
        //
        // 旧实现这里只有一句 `if (… && !this.text) { /* 不误判 */ }`——即**什么都没做**，
        // 于是 assistant 消息的 status 是这份流里唯一权威的「生成完了没有」信号，
        // 却被丢掉了。驱动侧只能靠「流静默 2.5s + DOM 停长」推断，而 kimi 的思考阶段
        // 正文节点看不到内容 ⇒ 推断恒真 ⇒ 真机把一轮**还在思考**的轮次判成稳态收束
        // （现场：`settling turn with 0 chars answer / 114 chars thinking`）。
        //
        // 两件事一起做：
        //   · `generating` 状态位 —— 驱动据此**推迟**稳态收束（权威信号优先于推断）；
        //   · status 变终态时**真的**置 `done` —— 这样 `finish()` 交回的就是
        //     `complete:true`，而不是让调用方把一轮正常完成的回复当部分流落账
        //     （那正是「partial web stream accepted (incomplete…)」那条读数的来历）。
        const st = String(j.message.status || '');
        if (/GENERATING/i.test(st)) this.generating = true;
        if (/COMPLETED|DONE|ERROR|FAILED|CANCEL/i.test(st)) {
          this.generating = false;
          // ERROR 类终态不算正常完成：交给 finish() 的失败分支（failed 由 j.error 置位），
          // 这里只停止「还在生成」的判定，避免把一个失败的轮次挂到硬上限。
          if (!/ERROR|FAILED|CANCEL/i.test(st)) this.done = true;
        }
      }
      const block = j.block;
      const text = block?.text?.content;
      if (typeof text === 'string' && text) { this.emitText(text); return; }
      const think = block?.think?.content;
      if (typeof think === 'string' && think) { this.emitThink(think); return; }
      for (const img of imagesIn(block || j)) this.pushImage(img);
    }
  }

  // ---------- Z.ai（chat.z.ai /api/v2/chat/completions）----------
  //
  // ## 真机帧证据（2026-10-14 首次取得；此前长期问题 #30 挂了一个月）
  //
  // 原始流**逐字**存于 `test/fixtures/zai-real-frames/zai-chat-2026-10-14.txt`。
  // 帧形状（每个事件一行 `data: {...}`，**不是** OpenAI 的 `choices[].delta`）：
  //
  //   data: {"type":"chat:completion","data":{"delta_content":"…","phase":"thinking"}}
  //   data: {"type":"chat:completion","data":{"phase":"other","usage":{…}}}
  //   data: {"type":"chat:completion","data":{"delta_content":"你好呀","phase":"answer"}}
  //   data: {"type":"chat:completion","data":{"phase":"done","done":true}}
  //
  // 三条要点（都从那一份夹具读出来的，不是推测）：
  //   ① **正文/思考增量都在 `delta_content`**，靠 `phase` 分流
  //      （`thinking` → onThink，其余含 `answer` → onDelta）；
  //   ② 这一份流里 `delta_content` **始终是增量**，没有出现过全量快照
  //      —— 但仍按 `GlmDecoder` 那套**前缀差分**兜底：若某帧的 `delta_content`
  //      以已累积文本开头，只外发新增后缀。两种形态都兼容 ⇒ 「整段播两遍」不会发生。
  //   ③ 收尾认 `data.done === true`；**不能只认 `[DONE]`**（本流里没有它）。
  //
  // ⚠ 这条 decoder 落地**推翻了 `providers.js` 里原来的两条判断**（都已改正）：
  //   · 原写「现有 9 个 decoder kind 没有任何一个能解它」——现在有了；
  //   · 原写 `completionPaths: ['/api/chat/completions','/api/v1/chat/completions']`
  //     ——真机实际打到 **`/api/v2/chat/completions`**，声明里缺 v2。
  class ZaiDecoder extends JsonLinesDecoder {
    constructor(options) {
      super(options);
      // 按 phase 分别做前缀差分（思考与正文两条独立的累积串）
      this.zaiTextSent = '';
      this.zaiThinkSent = '';
    }
    /**
     * 从**一个 SSE 帧**里取出 `data:` 内容。
     *
     * 为什么不直接用基类的 `line()`：基类是 `JSON.parse(l)`，而缓冲区里躺的是原始 SSE
     * 文本 `data: {...}` ⇒ `JSON.parse('data: {...}')` 必抛 `Unexpected token 'd'`，
     * 然后被**静默吞掉**（本文件 §GlmDecoder 的 `finish()` 注释记过这个坑，真机代价是
     * 整段最后一句消失）。所以本类照 GLM 的做法自己切帧、自己剥前缀。
     */
    frameData(frame) {
      const dataLines = [];
      for (const line of String(frame || '').split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      return dataLines.join('\n');
    }
    push(chunk) {
      this.buf += chunk;
      this.buf = this.buf.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = this.buf.indexOf('\n\n')) >= 0) {
        const frame = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        const data = this.frameData(frame);
        if (data) this.line(data);
      }
    }
    /** 收尾时把**残缺尾帧**也按同一规则解掉（GLM 同款理由：正常收尾末帧常缺空行）。 */
    finish() {
      const tail = this.buf.trim();
      this.buf = '';
      if (tail) {
        const data = this.frameData(tail);
        if (data) { try { this.line(data); } catch { /* 残缺到解不出 JSON：如实丢弃 */ } }
      }
      return super.finish();
    }
    /** 前缀差分：只外发**新增后缀**。累积流与纯增量流在它下面语义一致。 */
    zaiDelta(full, sent) {
      if (!full) return '';
      if (full === sent) return '';
      if (sent && full.startsWith(sent)) return full.slice(sent.length);
      // 不是累积形态（或前缀被改写）⇒ 整段当增量发出
      return full;
    }
    obj(j) {
      if (!isRecord(j)) return;
      // 站点错误帧：原话优先（与基类 failureReason 同一考虑）
      if (j.error) {
        this.failed = true;
        this.failureReason = typeof j.error === 'string' ? j.error
          : (j.error && (j.error.message || j.error.code)) || 'zai_error';
        return;
      }
      // 帧外壳：`{type:'chat:completion', data:{…}}`；容错也接受「data 就在顶层」的形状
      const payload = isRecord(j.data) ? j.data : j;
      const phase = typeof payload.phase === 'string' ? payload.phase : '';

      // 收尾：`done:true`（真机最后一帧 `{phase:'done',done:true}`）
      if (payload.done === true || phase === 'done') this.done = true;

      const dc = typeof payload.delta_content === 'string' ? payload.delta_content : '';
      if (dc) {
        if (phase === 'thinking') {
          const d = this.zaiDelta(dc, this.zaiThinkSent);
          this.zaiThinkSent = dc.startsWith(this.zaiThinkSent) ? dc : this.zaiThinkSent + d;
          this.emitThink(d);
        } else {
          const d = this.zaiDelta(dc, this.zaiTextSent);
          this.zaiTextSent = dc.startsWith(this.zaiTextSent) ? dc : this.zaiTextSent + d;
          this.emitText(d);
        }
      }

      // 会话身份（有就记，没有不编）
      const cid = payload.conversation_id || payload.chat_id || payload.id;
      if (!this.conversationId && typeof cid === 'string' && cid) this.conversationId = cid;

      // 站点自己说还在生成（没有这个信号时保持基类 false，行为与既有站点一致）
      if (phase === 'thinking' || phase === 'answer') this.generating = true;
      if (phase === 'done') this.generating = false;
    }
  }

  // 注册表：driver 按 providers.js 里站点的 decoder 字段取用。
  // 'dom' 站点（Gemini 等）没有稳定网络流，由 driver 在页面里做终态抓取。
  globalThis.WebCodeDeepSeekStreamDecoder = DeepSeekStreamDecoder;
  globalThis.WebCodeStreamDecoders = Object.freeze({
    deepseek: DeepSeekStreamDecoder,
    'openai-sse': OpenAiSseDecoder,
    chatgpt: ChatGptDecoder,
    glm: GlmDecoder,
    kimi: KimiDecoder,
    'kimi-connect': KimiConnectDecoder,
    doubao: DoubaoDecoder,
    grok: GrokDecoder,
    claude: ClaudeSseDecoder,
    zai: ZaiDecoder,
    dom: null,
  });
})();
