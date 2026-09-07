// background/service_worker.js — owns the relay WebSocket and frame dispatch.
//
// Consent-gated: the popup must set enabled=true AND consentAccepted=true
// (after the risk notice) before any WS connection is made. DeepSeek frames
// (top-level tabs OR iframes embedded in the DSH sidebar) register a
// long-lived Port on load; requests are dispatched over that port and events
// stream back — no tab navigation, no frameId math.
//
// No import/export: same file runs as Chromium service worker and Firefox
// background script.

'use strict';

const SITE_ROOT = 'https://chat.deepseek.com/';
const DEFAULTS = {
  enabled: false,
  consentAccepted: false,
  bridgeUrl: 'ws://127.0.0.1:8931/bridge',
  version: '0.1.0',
};

let cfg = { ...DEFAULTS };
let ws = null;
let reconnectTimer = null;
let backoffMs = 500;
let activeRequest = null; // { requestId, port }

// frames: Port → { url, canAutomate, alive }
const frames = new Set();

// Debug tap: readable from devtools/CDP as globalThis.__wcTap
globalThis.__wcTap = [];
function tap(kind, value) {
  try {
    globalThis.__wcTap.push({ at: Date.now(), kind, value: JSON.stringify(value)?.slice(0, 300) });
    if (globalThis.__wcTap.length > 80) globalThis.__wcTap.shift();
  } catch {}
}

chrome.storage.local.get(DEFAULTS).then((stored) => {
  cfg = { ...DEFAULTS, ...stored };
  if (cfg.enabled && cfg.consentAccepted) connect();
});

const persist = () => chrome.storage.local.set(cfg);

// ---- frame registry -------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'webcode-frame') return;
  tap('frame-connect', { url: port.sender?.url, tabId: port.sender?.tab?.id });
  const entry = { url: port.sender?.url || '', canAutomate: true, alive: true };
  frames.add(port);
  port.onMessage.addListener((msg) => {
    tap('frame-msg', msg);
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'frame-hello':
        entry.url = msg.url || entry.url;
        entry.canAutomate = msg.canAutomate !== false;
        break;
      case 'status':
        safeSend({ type: 'status', busy: msg.busy, page: msg.page });
        break;
      case 'bridge-delta':
      case 'bridge-done':
      case 'bridge-error': {
        const wsType = msg.type.replace('bridge-', '');
        if (wsType !== 'delta') activeRequest = null;
        safeSend({ type: wsType, requestId: msg.requestId, text: msg.text, message: msg.message });
        break;
      }
      default:
        break;
    }
  });
  port.onDisconnect.addListener(() => {
    tap('frame-disconnect', { url: entry.url });
    frames.delete(port);
    if (activeRequest && activeRequest.port === port) {
      const id = activeRequest.requestId;
      activeRequest = null;
      safeSend({ type: 'error', requestId: id, message: 'web AI frame closed mid-request' });
    }
  });
});

function findFrame() {
  for (const port of frames) {
    const url = port.sender?.url || '';
    if (url.startsWith(SITE_ROOT)) return port;
  }
  // test builds use a mock origin; accept any registered automated frame
  for (const port of frames) {
    if (port.sender?.url && !port.sender.url.startsWith('chrome-extension')) return port;
  }
  return null;
}

// ---- WebSocket -----------------------------------------------------------
function shouldConnect() {
  return Boolean(cfg.enabled && cfg.consentAccepted && cfg.bridgeUrl);
}

function connect() {
  if (!shouldConnect() || (ws && ws.readyState <= 1)) return;
  try { ws = new WebSocket(cfg.bridgeUrl); } catch { scheduleReconnect(); return; }

  ws.onopen = () => {
    backoffMs = 500;
    ws.send(JSON.stringify({
      type: 'hello',
      site: 'chat.deepseek.com',
      version: cfg.version,
      userAgent: navigator.userAgent,
      consent: { accepted: true, ts: Date.now() },
    }));
  };
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    tap('ws-in', msg);
    if (msg.type === 'request') dispatchRequest(msg);
    else if (msg.type === 'abort') {
      const ar = activeRequest;
      activeRequest = null;
      if (ar && ar.requestId === msg.requestId) {
        try { ar.port.postMessage({ cmd: 'webcode-abort', requestId: msg.requestId }); } catch {}
      }
    }
    else if (msg.type === 'ping') safeSend({ type: 'pong' });
    else if (msg.type === 'hello-rejected') { tap('hello-rejected', msg); }
  };
  ws.onclose = () => { ws = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws && ws.close(); } catch {} };
}

function safeSend(obj) {
  tap('ws-out', obj);
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} }
}

function scheduleReconnect() {
  if (!shouldConnect() || reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 15_000);
}

function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(1000, 'disabled'); } catch {} ws = null; }
}

// ---- dispatch --------------------------------------------------------------
function dispatchRequest(msg) {
  const { requestId, prompt } = msg;
  if (activeRequest) {
    safeSend({ type: 'error', requestId, message: 'extension busy with request ' + activeRequest.requestId });
    return;
  }
  const framePort = findFrame();
  if (!framePort) {
    safeSend({
      type: 'error',
      requestId,
      message: 'no web AI page connected — open the Web AI sidebar panel (or a chat.deepseek.com tab), log in, and keep the bridge enabled',
    });
    return;
  }
  activeRequest = { requestId, port: framePort };
  try {
    framePort.postMessage({ cmd: 'webcode-send', requestId, prompt });
  } catch (err) {
    activeRequest = null;
    safeSend({ type: 'error', requestId, message: 'frame dispatch failed: ' + (err?.message || err) });
  }
}

// ---- popup control ---------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  tap('popup-msg', msg);

  if (msg.cmd === 'get-status') {
    sendResponse({
      cfg,
      wsState: ws ? ['connecting', 'open', 'closing', 'closed'][ws.readyState] : 'offline',
      frames: [...frames].map((p) => ({ url: p.sender?.url, tabId: p.sender?.tab?.id })),
      activeRequest: activeRequest ? { requestId: activeRequest.requestId } : null,
    });
    return true;
  }
  if (msg.cmd === 'set-config') {
    const next = msg.config || {};
    if (typeof next.enabled === 'boolean') cfg.enabled = next.enabled;
    if (typeof next.consentAccepted === 'boolean') cfg.consentAccepted = next.consentAccepted;
    if (typeof next.bridgeUrl === 'string' && next.bridgeUrl) cfg.bridgeUrl = next.bridgeUrl;
    persist();
    if (cfg.enabled && cfg.consentAccepted) { backoffMs = 500; disconnect(); connect(); }
    else disconnect();
    sendResponse({ ok: true, cfg });
    return true;
  }
  if (msg.cmd === 'open-deepseek') {
    chrome.tabs.create({ url: SITE_ROOT });
    sendResponse({ ok: true });
    return true;
  }
});
