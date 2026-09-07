import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMirror } from '../lib/mirror.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('mirror serves a fixed upstream for the sidebar iframe', async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "frame-ancestors 'none'",
        'x-frame-options': 'DENY',
        'set-cookie': 'sid=abc; Domain=upstream.test; Secure; SameSite=None',
      });
      res.end('<!doctype html><html><head></head><body><textarea>chat</textarea></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  const upstreamPort = await listen(upstream);
  const mirror = createMirror({
    siteOrigin: `http://127.0.0.1:${upstreamPort}`,
    getToken: async () => 'test-token',
    logger: { log() {}, warn() {} },
  });
  const relay = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://loopback');
    mirror.handle(req, res, url.pathname, url.search)
      .then((handled) => { if (!handled) { res.writeHead(404); res.end(); } })
      .catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  });
  const relayPort = await listen(relay);
  t.after(() => { upstream.close(); relay.close(); });

  const response = await fetch(`http://127.0.0.1:${relayPort}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), null);
  assert.equal(response.headers.get('content-security-policy'), null);
  assert.match(html, /data-webcode-mirror/);
  assert.match(html, /test-token/);
  assert.match(response.headers.get('set-cookie') || '', /sid=abc/);
  assert.doesNotMatch(response.headers.get('set-cookie') || '', /Domain=|Secure|SameSite=None/i);

  const foreign = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: relayPort, path: '/', headers: { host: 'evil.example' } }, resolve);
    request.on('error', reject);
  });
  foreign.resume();
  assert.equal(foreign.statusCode, 403);
  const localRoute = await fetch(`http://127.0.0.1:${relayPort}/bridge/status`);
  assert.equal(localRoute.status, 404);
});
