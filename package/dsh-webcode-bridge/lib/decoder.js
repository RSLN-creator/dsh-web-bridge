// vendor/decoder.js — DeepSeek web chat SSE decoder (content-script global).
//
// Adapted from the MIT-licensed `webcode` project (three-water666/webcode,
// shared/src/deepseekStream.ts + sse.ts). Changes for this bridge: plain
// script exposing a global, plus an onDelta hook so RESPONSE fragment appends
// stream out while the answer is still being generated. THINK (reasoning)
// fragments are deliberately never exposed, matching upstream.
//
// Protocol recap: the /api/v0/chat/completion SSE stream carries JSON events;
// `message` events are JSON-patch ops (fields o=operation, p=path, v=value)
// applied to a response object whose `fragments` array holds THINK/RESPONSE
// content strings. status FINISHED + an `event: close` marks completeness.

(function () {
  'use strict';

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

  const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const readId = (v) => (typeof v === 'string' || typeof v === 'number') ? String(v) : null;
  const normalizePath = (p) => p.replace(/^\/+|\/+$/g, '');
  const joinPaths = (a, b) => {
    const na = normalizePath(a || ''), nb = normalizePath(b || '');
    if (!na) return nb;
    if (!nb) return na;
    return na + '/' + nb;
  };

  // THINK/THINKING 片段的思考内容同样要保留，供 onThink 暴露——此前仅保留 RESPONSE
  // content，导致 fragments 数组里的深度思考被清空而静默丢弃（正文之外的思考过程丢失）。
  const CONTENT_TYPES = new Set(['RESPONSE', 'THINK', 'THINKING']);
  function readFragment(value) {
    if (!isRecord(value) || typeof value.type !== 'string') return null;
    const type = value.type.toUpperCase();
    return { type, content: CONTENT_TYPES.has(type) && typeof value.content === 'string' ? value.content : '' };
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
      this.sse = new SseDecoder();
      this.failed = false;
      this.lastOp = '';
      this.lastPath = '';
      this.readyResponseId = null;
      this.receivedClose = false;
      this.response = null;   // { fragments, id, status }
      this.receivedChars = 0;
    }

    push(chunk) {
      this.receivedChars += chunk.length;
      if (this.receivedChars > this.maxChars * 16) { this.failed = true; return; }
      this.consume(this.sse.push(chunk));
    }

    finish() {
      this.consume(this.sse.finish());
      if (this.failed) return { complete: false, reason: 'invalid_stream' };
      if (!this.receivedClose || !this.response || this.response.status !== 'FINISHED') {
        return { complete: false, reason: 'incomplete' };
      }
      const text = this.response.fragments
        .filter((f) => f.type === 'RESPONSE')
        .map((f) => f.content)
        .join('');
      return { complete: true, text: text.trim() };
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
      if (isRecord(delta) && hasOwn(delta, 'o') && typeof delta.o === 'string') this.lastOp = delta.o.toUpperCase();
      if (isRecord(delta) && hasOwn(delta, 'p') && typeof delta.p === 'string') this.lastPath = normalizePath(delta.p);
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
      // The site can pre-fill RESPONSE content in the opening frame — those
      // are the first words of the answer; stream them out or they are lost.
      // Only on first creation: the object may be re-sent with cumulative
      // content, which must not double-stream.
      if (isFirst && this.onDelta) {
        for (const f of this.response.fragments) {
          if (f.type === 'RESPONSE' && f.content) {
            try { this.onDelta(f.content); } catch {}
          } else if (f.type === 'THINK' && f.content) {
            try { this.onThink?.(f.content); } catch {}
          }
        }
      }
    }

    applyOperation(op, basePath) {
      const response = this.response;
      if (!response) return;
      const opName = typeof op.o === 'string' ? op.o.toUpperCase() : this.lastOp;
      const path = typeof op.p === 'string' ? joinPaths(basePath, op.p) : (basePath || '');

      if (path === 'response/status' && typeof op.v === 'string') { response.status = op.v.toUpperCase(); return; }

      if (path === 'response/fragments') {
        if (opName === 'SET' && Array.isArray(op.v)) {
          response.fragments = op.v.map(readFragment).filter(Boolean);
          return;
        }
        if (opName === 'APPEND') {
          const values = Array.isArray(op.v) ? op.v : [op.v];
          for (const item of values) {
            const f = readFragment(item);
            if (f) {
              response.fragments.push(f);
              if (f.type === 'RESPONSE' && f.content) this.onDelta?.(f.content);
              else if (f.type === 'THINK' && f.content) { try { this.onThink?.(f.content); } catch {} }
            }
          }
          return;
        }
        return;
      }

      const idx = fragmentContentIndex(path, response.fragments.length);
      if (idx === null) {
        // unrelated path — but reasoning streams (thinking_content / reasoning_*)
        // carry the THINK phase on the live site; expose them for phase timing
        if (this.onThink && /think|reason/i.test(path) && typeof op.v === 'string' && op.v) {
          try { this.onThink(op.v); } catch {}
        }
        return;
      }
      if ((opName !== 'APPEND' && opName !== 'SET') || typeof op.v !== 'string') { this.failed = true; return; }
      const fragment = response.fragments[idx];
      if (!fragment) { this.failed = true; return; }
      if (fragment.type !== 'RESPONSE') {            // THINK etc: never expose, only phase timing
        if (this.onThink && op.v) { try { this.onThink(String(op.v)); } catch {} }
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

  // expose (classic script, both worlds)
  globalThis.WebCodeDeepSeekStreamDecoder = DeepSeekStreamDecoder;
})();
