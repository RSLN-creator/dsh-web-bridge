#!/usr/bin/env node
// real-wr-image.mjs — 0.19.14 真机验收：图片查看链路的字节级对照。
//
// 前置：CONV_ID 指向一个**含图会话**（real-mirror-viewer.mjs 首次运行创建）。
// DeepSeek 图片的真实形态（本探针取证）：消息 fragments[].type=FILE[].signed_path
// = "/file?file_id=…&state=…"，前端拼站点 origin 后请求。三种处境对照：
//   ① 无 cookie 直连 —— 用户浏览器直打真实站点的处境（预期 401/403）；
//   ② 镜像路径 /file?… —— 既有镜像机制（UP 源改写为路径，服务端合并驱动 cookie）；
//   ③ /wr/<绝对URL> —— 0.19.14 新增的未知域兜底（对 UP 源同样必须可用）。
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createBrowserDriver } from '../lib/browser-driver.js';
import { createMirror } from '../lib/mirror.js';
import { getSite } from '../lib/providers.js';

const PROFILE = process.env.REAL_PROFILE || path.join(os.homedir(), '.dsh', 'webcode-edge-profile');
const MIRROR_PORT = Number(process.env.MIRROR_PORT || 8932);
const CONV_ID = process.env.CONV_ID || '';

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/', profileDir: PROFILE, headless: true,
  requestTimeoutMs: 240_000, logger: console,
});
let server;
try {
  const conn = await driver.connect();
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }

  // ① 取真实签名路径（fragments[].type=FILE[].files[].signed_path）
  const r = await driver.webApi('/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(CONV_ID));
  const raw = JSON.stringify(r.json ?? r.text);
  const paths = [...new Set((raw.match(/"signed_path":"(\/file\?[^"]+)"/g) || []).map((m) => m.slice(15, -1).replace(/\\\//g, '/')))];
  console.log('signed paths found:', paths.length);
  if (!paths.length) { console.log('NO_SIGNED_PATH'); process.exit(4); }
  const signedPath = paths[0];
  const absUrl = 'https://chat.deepseek.com' + signedPath;
  console.log('target path:', signedPath.slice(0, 110) + '…');

  // ② 独立 mirror 实例（与插件同一份代码）
  const site = getSite('deepseek');
  const mirror = createMirror({
    siteOrigin: 'https://chat.deepseek.com',
    getToken: () => driver.getToken(),
    assetOrigins: site?.staticOrigins || [],
    mountPrefix: '',
    getCookies: (origin) => driver.profileCookies(origin),
    setCookies: (h, origin) => driver.writeProfileCookies(h, origin),
    getUserAgent: () => driver.userAgent(),
    logger: { log: () => {}, warn: (...a) => console.log('[mirror-warn]', ...a) },
  });
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://loopback');
    mirror.handle(req, res, u.pathname, u.search).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch((e) => {
      console.log('[mirror-handle-err]', e?.message);
      try { res.writeHead(500); res.end(); } catch {}
    });
  });
  await new Promise((r2) => server.listen(MIRROR_PORT, '127.0.0.1', r2));

  const isImg = (buf) => buf[0] === 0x89 && buf[1] === 0x50;   // PNG magic
  // /file 端点要 Authorization（前端 fetch 图片后转 blob；取证见 webApi 的头形态）
  const tok = driver.getToken();
  const bearer = 'Bearer ' + (typeof tok === 'string' ? tok : (tok?.value || ''));
  const authHeaders = { authorization: bearer };

  const describe = async (resp) => {
    const buf = Buffer.from(await resp.arrayBuffer());
    return { ok: resp.ok, status: resp.status, ct: resp.headers.get('content-type'), bytes: buf.length, isPng: isImg(buf) };
  };

  // ③ 无 cookie 无鉴权直连（最不利处境）
  let direct;
  try { direct = await describe(await fetch(absUrl, { redirect: 'manual' })); }
  catch (e) { direct = { ok: false, err: String(e?.message || e).slice(0, 120) }; }

  // ④ 镜像路径 + 鉴权（既有机制：UP 源 → 路径；SPA 的 fetch 会带 Authorization）
  const viaPath = await describe(await fetch(`http://127.0.0.1:${MIRROR_PORT}` + signedPath, { headers: authHeaders }));

  // ⑤ /wr/ + 鉴权（0.19.14 新增兜底：绝对 URL 形态）
  const viaWr = await describe(await fetch(`http://127.0.0.1:${MIRROR_PORT}/wr/` + encodeURIComponent(absUrl), { headers: authHeaders }));

  console.log('\n--- 判定 ---');
  console.log('① direct (no cookies):', JSON.stringify(direct));
  console.log('② mirror path        :', JSON.stringify(viaPath));
  console.log('③ via /wr/           :', JSON.stringify(viaWr));
  console.log('\nVERDICT', JSON.stringify({
    directBlocked: !direct.ok,
    mirrorPathLoads: viaPath.ok && viaPath.isPng,
    wrLoads: viaWr.ok && (viaWr.isPng || /image\//.test(viaWr.ct || '')),
  }));
} catch (e) {
  console.log('ERR: ' + (e?.message || e));
} finally {
  try { server?.close(); } catch {}
  try { await driver.close(); } catch {}
}
