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
      if (this.failed) return { complete: false, reason: 'invalid_stream', ...collected };
      if (!this.receivedClose || !this.response || this.response.status !== 'FINISHED') {
        // 流没送到 FINISHED / close：网页端掉流、被合流截断、或用户切走页面。
        // 旧实现直接 complete:false，把已经解码出来的正文与（可能完整的）工具
        // 调用全部丢掉——真机表现就是「回复到一半突然停止，工具也不执行了」。
        // 正文/思考/图片任何一项非空都算「部分可用」，把 partial 标出来交给
        // 驱动层决定（它知道工具协议是否完整），而不是在解码层判死。
        const partial = Boolean(collected.text || collected.thinking || collected.images.length);
        return {
          complete: false,
          partial,
          reason: this.response ? 'stream_ended_before_finished' : 'no_response_frames',
          status: this.response?.status || null,
          ...collected,
        };
      }
      return { complete: true, ...collected };
    }
    consume(events) { for (const ev of events) this.consumeEvent(ev); }
    consumeEvent(ev) {
      if (ev.event === 'close') { this.receivedClose = true; return; }
      let payload;
      try { payload = JSON.parse(ev.data); } catch { this.failed = true; return; }
      if (ev.event === 'error') { this.failed = true; return; }
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
    consumeResponse(response) {
      if (response.role !== 'ASSISTANT' || !Array.isArray(response.fragments)) { this.failed = true; return; }
      const id = readId(response.message_id) || this.readyResponseId;
      if (!id) { this.failed = true; return; }
      const isFirst = !this.response;
      this.response = {
        fragments: response.fragments.map(readFragment).filter(Boolean),
        id,
        status: typeof response.status === 'string' ? response.status.toUpperCase() : '',
      };
      if (isFirst) {
        for (const f of this.response.fragments) {
          if (f.type === 'RESPONSE' && f.content) { try { this.onDelta?.(f.content); } catch {} }
          else if ((f.type === 'THINK' || f.type === 'THINKING') && f.content) { try { this.onThink?.(f.content); } catch {} }
          else if (f.image) this.pushImage(f.image);
        }
      }
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
        if (opName === 'SET' && Array.isArray(op.v)) { response.fragments = op.v.map(readFragment).filter(Boolean); return; }
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
      if (this.failed) return { complete: false, reason: 'invalid_stream' };
      if (!this.done) return { complete: false, reason: 'incomplete' };
      return { complete: true, text: this.text.trim(), thinking: this.think.trim(), images: this.images };
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
      if (this.failed) return { complete: false, reason: 'invalid_stream' };
      if (!this.done) return { complete: false, reason: 'incomplete' };
      return { complete: true, text: this.text.trim(), thinking: this.think.trim(), images: this.images };
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
      if (this.failed) return { complete: false, reason: 'invalid_stream' };
      if (!this.done) return { complete: false, reason: 'incomplete' };
      return { complete: true, text: this.text.trim(), thinking: this.think.trim(), images: this.images };
    }
    line(l) {
      if (l === '[DONE]') { this.done = true; return; }
      let j; try { j = JSON.parse(l); } catch { return; }
      this.obj(j);
    }
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
    constructor(options) { super(options); this.seen = new Map(); }
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
              // 与已发内容无前缀关系 = 新片段（glm-free-api 的增量语义），追加
              this.seen.set(key, prev + t);
              this.emitText(t);
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
    pickText: (j) => str(j.event_data) ?? str(j.text) ?? str(j.delta?.message?.content?.text),
    pickThink: (j) => str(j.reasoning) ?? str(j.thinking),
    pickImages: (j) => imagesIn(j),
    isDone: (j) => j.event === 'done' || j.is_finish === true || j.done === true,
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
      if (this.failed) return { complete: false, reason: 'invalid_stream' };
      if (!this.done) return { complete: false, reason: 'incomplete' };
      return { complete: true, text: this.text.trim(), thinking: this.think.trim(), images: this.images };
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

  // 注册表：driver 按 providers.js 里站点的 decoder 字段取用。
  // 'dom' 站点（Gemini 等）没有稳定网络流，由 driver 在页面里做终态抓取。
  globalThis.WebCodeDeepSeekStreamDecoder = DeepSeekStreamDecoder;
  globalThis.WebCodeStreamDecoders = Object.freeze({
    deepseek: DeepSeekStreamDecoder,
    'openai-sse': OpenAiSseDecoder,
    chatgpt: ChatGptDecoder,
    glm: GlmDecoder,
    kimi: KimiDecoder,
    doubao: DoubaoDecoder,
    grok: GrokDecoder,
    claude: ClaudeSseDecoder,
    dom: null,
  });
})();
