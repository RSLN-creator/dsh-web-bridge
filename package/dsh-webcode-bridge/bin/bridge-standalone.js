#!/usr/bin/env node
// bridge-standalone.js — run the relay + driver + OpenAI front WITHOUT DSH.
// Used for local verification (driver E2E against the mock site) and by
// anyone wanting the bridge alone.
//
//   node bin/bridge-standalone.js [port]
//   WEBCODE_SITE=http://127.0.0.1:8932/ WEBCODE_PROFILE_DIR=... node bin/bridge-standalone.js

import os from 'node:os';
import path from 'node:path';
import { createRelay } from '../lib/relay.js';
import { createOpenAiFront } from '../lib/openai.js';
import { createBrowserDriver } from '../lib/browser-driver.js';
import { createWebControl } from '../lib/web-control.js';
import { createMirror } from '../lib/mirror.js';

const port = Number(process.argv[2] || process.env.WEBCODE_PORT || 8931);
const cfg = {
  port,
  host: '127.0.0.1',
  requireConsent: process.env.WEBCODE_NO_CONSENT ? false : true,
  requestTimeoutMs: Number(process.env.WEBCODE_REQUEST_TIMEOUT_MS || 240_000),
  queueTimeoutMs: Number(process.env.WEBCODE_QUEUE_TIMEOUT_MS || 300_000),
  site: process.env.WEBCODE_SITE || 'https://chat.deepseek.com/',
  profileDir: process.env.WEBCODE_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'webcode-edge-profile'),
  headless: process.env.WEBCODE_HEADED ? false : true,
};

const driver = createBrowserDriver({
  site: cfg.site,
  profileDir: cfg.profileDir,
  headless: cfg.headless,
  requestTimeoutMs: cfg.requestTimeoutMs,
  logger: console,
});

let front = null;
const relay = createRelay({
  ...cfg,
  logger: console,
  executor: (prompt, opts) => driver.sendPrompt(prompt, opts),
  driverStatus: () => driver.status(),
  loginTrigger: () => driver.openLogin(),
  siteConnect: () => driver,
  windowOpener: (siteId, action, opts = {}) => action === 'close' ? driver.closeWindow() : driver.openWindow(opts),
  onHttp: (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname;
    // web-side control plane fallbacks (no DSH host services here, so
    // sessions/history/preview work and import reports unavailable)
    if (pathname === '/bridge/web/preview') {
      webControl.handlePreview(req, res).catch(() => { try { res.end(); } catch {} });
      return;
    }
    if (pathname.startsWith('/bridge/web/')) {
      webControl.handle(req, res, pathname).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'no route: ' + pathname } }));
        }
      }).catch(() => { try { res.end(); } catch {} });
      return;
    }
    if (!frontClaims(pathname)) {
      mirror.handle(req, res, pathname, u.search).catch(() => { try { res.end(); } catch {} });
      return;
    }
    if (!front) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'front not ready' } }));
      return;
    }
    front.handle(req, res, pathname);
  },
});
const webControl = createWebControl({ driver, relay, config: cfg, host: {}, logger: console });
const mirror = createMirror({ siteOrigin: new URL(cfg.site).origin, getToken: () => driver.getToken(), logger: console });

/** Routes the OpenAI front owns on the relay; everything else mirrors upstream. */
function frontClaims(pathname) {
  return pathname.startsWith('/v1') || pathname.startsWith('/webcode/v1') ||
    pathname === '/bridge/status' || pathname === '/bridge/consent' ||
    pathname === '/bridge/login' || pathname === '/bridge/import-session';
}
front = createOpenAiFront(relay, {
  providerId: 'webcode',
  modelId: process.env.WEBCODE_MODEL_ID || 'deepseek-web',
  modelName: 'DeepSeek Web (网页版)',
});
relay.start();

setTimeout(() => {
  const st = relay.status();
  if (!st.running) {
    console.error('[webcode-bridge] failed to start:', st.startError);
    process.exit(1);
  }
}, 1500);

process.on('SIGINT', () => { relay.stop(); driver.close().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { relay.stop(); driver.close().finally(() => process.exit(0)); });
