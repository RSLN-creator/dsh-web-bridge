// content/main.js — isolated-world actor on chat.deepseek.com frames.
//
// Owns the bridge side of the automation: fills the input, triggers send
// (Enter first, button fallback, retried), binds the MAIN-world network
// capture to the DeepSeek SSE decoder, and streams deltas back.
//
// Connection to the extension SW is a long-lived Port (works identically for
// top-level tabs and for iframes embedded in the DSH sidebar). A fresh-chat
// requirement is handled in-frame via sessionStorage + location change, so
// the SW never needs to navigate anything.

(function () {
  'use strict';

  const SEL = {
    input: 'textarea.ds-scroll-area',
    sendButton: "div[role='button']:has(path[d^='M8.3125'])",
    stopButton: "div[role='button']:has(path[d^='M2 4.88'])",
  };
  const SEND_TIMEOUT_MS = 230_000;
  const SEND_RETRY_MS = 1600;
  const SEND_MAX_ROUNDS = 4;
  const PENDING_KEY = 'webcode-pending-send';

  const state = {
    requestId: null,
    captureId: null,
    decoder: null,
    watchdog: null,
    startedAt: 0,
  };

  // ---- helpers ----------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function dbg(text) {
    try {
      let el = document.getElementById('__wc-dbg');
      if (!el) {
        el = document.createElement('div');
        el.id = '__wc-dbg';
        el.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:2147483647;background:rgba(15,23,42,.92);color:#a7f3d0;font:11px/1.5 Consolas,monospace;padding:6px 8px;border-radius:6px;max-width:460px;max-height:40vh;overflow:hidden;white-space:pre-wrap;pointer-events:none';
        (document.body || document.documentElement).appendChild(el);
      }
      el.textContent = (el.textContent + '\n' + text).split('\n').slice(-14).join('\n');
    } catch {}
  }

  function report(status) {
    portPost({ type: 'status', busy: Boolean(state.requestId), ...status });
  }

  // ---- port to the extension SW ------------------------------------------
  let port = null;
  let portReady = false;

  function portConnect() {
    try {
      port = chrome.runtime.connect({ name: 'webcode-frame' });
    } catch (err) {
      dbg('!port-connect ' + (err?.message || err));
      setTimeout(portConnect, 2000);
      return;
    }
    portReady = true;
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      portReady = false;
      setTimeout(portConnect, 1500);
    });
    portPost({ type: 'frame-hello', url: location.href, canAutomate: true });
    report({ page: 'loaded' });
  }

  function portPost(msg) {
    if (!portReady || !port) return;
    try { port.postMessage(msg); } catch (err) { dbg('!port-post ' + (err?.message || err)); }
  }

  function sendEvent(type, extra) {
    if (!state.requestId) return;
    portPost({ type, requestId: state.requestId, ...extra });
  }

  function onPortMessage(msg) {
    if (!msg) return;
    if (msg.cmd === 'webcode-abort' && state.requestId === msg.requestId) {
      finish();
      report({ page: 'aborted' });
      return;
    }
    if (msg.cmd !== 'webcode-send') return;
    if (state.requestId) {
      portPost({ type: 'error', requestId: msg.requestId, message: 'frame busy with request ' + state.requestId });
      return;
    }
    startSend(msg.requestId, msg.prompt);
  }

  // ---- send flow ----------------------------------------------------------
  function startSend(requestId, prompt) {
    // fresh chat: from inside a conversation, hand the prompt to the next
    // page load at the site root (survives the reload; works in iframes).
    if (location.pathname !== '/' && location.pathname !== '') {
      try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ requestId, prompt })); } catch {}
      dbg('navigating to fresh chat');
      location.href = '/';
      return;
    }
    try { sessionStorage.removeItem(PENDING_KEY); } catch {}

    state.requestId = requestId;
    state.startedAt = Date.now();
    dbg('send: ' + prompt.slice(0, 60).replace(/\n/g, ' '));
    report({ page: 'sending' });

    state.watchdog = setTimeout(() => {
      const id = state.requestId;
      finish();
      if (id) portPost({ type: 'error', requestId: id, message: 'page watchdog timeout' });
    }, SEND_TIMEOUT_MS);

    runSend(prompt).catch((err) => {
      const id = state.requestId;
      finish();
      if (id) portPost({ type: 'error', requestId: id, message: 'page error: ' + (err?.message || err) });
    });
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findInput() {
    const list = [...document.querySelectorAll(SEL.input)];
    return list.find(visible) || list[0] || null;
  }

  function stopVisible() {
    return visible(document.querySelector(SEL.stopButton));
  }

  async function waitPageIdle(maxMs = 30_000) {
    const t0 = Date.now();
    while (stopVisible()) {
      if (Date.now() - t0 > maxMs) return false;
      await sleep(400);
    }
    return true;
  }

  async function waitInput(maxMs = 15_000) {
    const t0 = Date.now();
    for (;;) {
      const el = findInput();
      if (el && visible(el)) return el;
      if (Date.now() - t0 > maxMs) return null;
      await sleep(200);
    }
  }

  function setInputValue(el, text) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
      return true;
    }
    el.focus();
    document.execCommand('insertText', false, text);
    return (el.innerText || '').includes(text.slice(0, 40));
  }

  function pressEnter(el) {
    const base = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', base));
    el.dispatchEvent(new KeyboardEvent('keypress', base));
    el.dispatchEvent(new KeyboardEvent('keyup', base));
  }

  function inputCleared() {
    const el = findInput();
    if (!el) return true;
    const v = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.innerText;
    return !v || !v.trim();
  }

  async function triggerSend() {
    // Mirrors webcode auto_send: check-for-completion FIRST each round, one
    // dispatch per round, alternating Enter / button. Success = input cleared
    // or stop button visible. This ordering is what prevents double sends.
    for (let round = 0; round < SEND_MAX_ROUNDS; round++) {
      if (inputCleared() || stopVisible()) return true;
      if (round % 2 === 0) {
        const el = findInput();
        if (el) { el.focus(); pressEnter(el); }
      } else {
        const btn = document.querySelector(SEL.sendButton);
        if (btn && visible(btn)) { try { btn.click(); } catch {} }
      }
      await sleep(round === 0 ? 1200 : SEND_RETRY_MS);
    }
    return inputCleared() || stopVisible();
  }

  async function runSend(prompt) {
    if (!(await waitPageIdle())) {
      const id = state.requestId;
      finish();
      portPost({ type: 'error', requestId: id, message: 'web page busy with another generation' });
      return;
    }
    const input = await waitInput();
    if (!input) {
      const id = state.requestId;
      finish();
      portPost({ type: 'error', requestId: id, message: 'input box not found (not logged in or page changed?)' });
      return;
    }
    if (!setInputValue(input, prompt)) {
      const id = state.requestId;
      finish();
      portPost({ type: 'error', requestId: id, message: 'could not set input value' });
      return;
    }
    const sent = await triggerSend();
    dbg(sent ? 'sent, awaiting capture' : 'send failed');
    if (!sent) {
      const id = state.requestId;
      finish();
      portPost({ type: 'error', requestId: id, message: 'send failed (Enter and button both rejected)' });
    }
    // success path: capture events drive delta/done
  }

  // ---- capture routing ---------------------------------------------------
  function routeCapture(msg) {
    if (!state.requestId) return;
    if (msg.phase === 'start') {
      if (!state.captureId) {
        state.captureId = msg.captureId;
        state.decoder = new WebCodeDeepSeekStreamDecoder({
          onDelta: (t) => sendEvent('bridge-delta', { text: t }),
        });
        dbg('capture bound');
      }
      return;
    }
    if (msg.captureId !== state.captureId) return;
    if (msg.phase === 'chunk' && state.decoder) {
      state.decoder.push(msg.text);
      return;
    }
    if (msg.phase === 'end' && state.decoder) {
      const result = state.decoder.finish();
      const requestId = state.requestId;
      finish();
      if (result.complete && result.text) {
        portPost({ type: 'bridge-done', requestId, text: result.text });
      } else {
        portPost({ type: 'bridge-error', requestId, message: 'capture ended incomplete: ' + (result.reason || 'unknown') });
      }
    }
  }

  function finish() {
    if (state.watchdog) clearTimeout(state.watchdog);
    state.requestId = null;
    state.captureId = null;
    state.decoder = null;
    state.watchdog = null;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'webcode-page') return;
    if (msg.type === 'ready') dbg('page capture ready');
    if (msg.type === 'capture') routeCapture(msg);
  });

  window.addEventListener('beforeunload', () => {
    if (state.requestId) {
      const id = state.requestId;
      finish();
      portPost({ type: 'bridge-error', requestId: id, message: 'page navigated mid-request' });
    }
  });

  // ---- resume after fresh-chat navigation ---------------------------------
  try {
    const pending = sessionStorage.getItem(PENDING_KEY);
    if (pending) {
      sessionStorage.removeItem(PENDING_KEY);
      const { requestId, prompt } = JSON.parse(pending);
      setTimeout(() => startSend(requestId, prompt), 800);
    }
  } catch {}

  portConnect();
})();
