// content/capture_page.js — MAIN world network capture for chat.deepseek.com.
//
// Wraps XHR and fetch so the page's own chat-completion responses can be read
// while they stream in, and forwards raw SSE bytes to the isolated content
// script via window.postMessage. The page's behavior is untouched: XHR keeps
// its normal lifecycle; fetch bodies are tee()ed so the site reads its own
// response exactly as before.
//
// Runs at document_start so page requests are never missed.

(function () {
  'use strict';
  if (window.__webcodeCaptureInstalled) return;
  window.__webcodeCaptureInstalled = true;

  const TARGET = '/api/v0/chat/completion';
  const ORIGIN = window.location.origin;

  function post(captureId, phase, text) {
    window.postMessage({ source: 'webcode-page', type: 'capture', captureId, phase, text }, ORIGIN);
  }
  function newCaptureId() { return 'cap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  function isTarget(method, url) {
    return method === 'POST' && typeof url === 'string' && url.includes(TARGET);
  }

  // ---- XHR (the site's actual transport: xhr-sse) ----------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__wcInfo = { method: String(method || '').toUpperCase(), url: String(url || '') };
    } catch {}
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const info = this.__wcInfo;
    if (info && isTarget(info.method, info.url)) {
      const captureId = newCaptureId();
      let lastLen = 0;
      const drain = () => {
        try {
          const text = typeof this.responseText === 'string' ? this.responseText : '';
          if (text.length > lastLen) {
            post(captureId, 'chunk', text.slice(lastLen));
            lastLen = text.length;
          }
        } catch {}
      };
      const timer = setInterval(drain, 30);
      post(captureId, 'start', '');
      this.addEventListener('loadend', () => {
        clearInterval(timer);
        drain();
        post(captureId, 'end', '');
      });
    }
    return origSend.call(this, body);
  };

  // ---- fetch (fallback in case the site switches transports) -----------
  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = async function (input, init) {
      const resp = await origFetch(input, init);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (method === 'POST' && url.includes(TARGET) && resp.ok && resp.body) {
          const captureId = newCaptureId();
          post(captureId, 'start', '');
          const [forPage, forCapture] = resp.body.tee();
          const reader = forCapture.getReader();
          const decoder = new TextDecoder();
          (async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                if (text) post(captureId, 'chunk', text);
              }
            } catch {}
            post(captureId, 'end', '');
          })();
          return new Response(forPage, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
        }
      } catch {}
      return resp;
    };
  }

  window.postMessage({ source: 'webcode-page', type: 'ready' }, ORIGIN);
})();
