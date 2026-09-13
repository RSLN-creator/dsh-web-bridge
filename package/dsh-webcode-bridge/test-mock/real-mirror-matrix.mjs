// real-mirror-matrix.mjs — 右栏镜像的**真机**逐站点验收矩阵（0.12.9）。
//
// 为什么不用单测代替（用户硬约束 U4）：这一轮的缺陷全部只在「真实浏览器 + 真实
// 站点 + 真实镜像」三者同时在场时出现——
//   • doubao 空白：SPA router 的 pathname 基线（只有真跑才知道 router 不认前缀）
//   • z.ai 点登录跳回镜像根：站点前端 history API 写回根相对路径
//   • gemini 502：undici 16KB 响应头上限（Node 全局 fetch 的硬限制）
//   • qwen/kimi 徽标误报：游客页自带输入框 / 输入框根本不是 textarea
// 因此本脚本的产物是**截图 + JSON 证据**，不是断言日志。
//
// 取证通路（本机沙箱唯一可行）：
//   spawn 浏览器必 EPERM（Playwright launchPersistentContext 直接失败），所以
//   附着到桥自己已经开着的 Edge —— profile 里的 DevToolsActivePort 第二行…
//   实际第一行就是端口；只 newPage()/close()，绝不碰已有页面。
//
// 用法：
//   node test-mock/real-mirror-matrix.mjs                # 默认端口 8931（DSH 中继）
//   node test-mock/real-mirror-matrix.mjs --port 8932    # 独立运行的中继
//   node test-mock/real-mirror-matrix.mjs --sites doubao,zai,qwen
//   node test-mock/real-mirror-matrix.mjs --keep         # 保留页面便于人工看
//
// 输出：test-mock/out/real-mirror-matrix-<ts>.json + .tmp/shots/matrix-<sid>-<ts>.png

import { chromium } from '../node_modules/playwright-core/index.mjs';
import { SITES, getSite } from '../lib/providers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(argOf('--port', '8931'));
const ONLY = String(argOf('--sites', '')).split(',').map((s) => s.trim()).filter(Boolean);
const KEEP = argv.includes('--keep');
const WAIT_MS = Number(argOf('--wait', '13000'));
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const OUT_DIR = path.resolve('test-mock', 'out');
const SHOT_DIR = path.resolve('.tmp', 'shots');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

/**
 * 每站点的验收口径。`expect` 是「修好之后必须成立」的事实；`allowBlocked`
 * 表示该站点上游风控/地区受限时，「诚实引导页」也算通过（不是本轮缺陷）。
 */
const EXPECT = {
  deepseek: { mustRender: true, note: '基线：唯一端到端可用的站点，不得回归' },
  glm: { mustRender: true },
  doubao: { mustRender: true, note: '0.12.9 根修：子域根挂载让 SPA router 基线正确' },
  zai: { mustRender: true, note: '0.12.9 根修：登录页留在本站源内（不再跳回镜像根）' },
  qwen: { mustRender: true, note: '0.12.9 根修：登录流程留在本站源内' },
  kimi: { mustRender: true },
  grok: { mustRender: true, allowBlocked: true },
  gemini: { mustRender: true, allowBlocked: true, note: '0.12.9 根修：大响应头（httpFetch）' },
  chatgpt: { mustRender: false, allowBlocked: true, note: '上游 403（本机网络/风控级），只要求诚实说明页' },
  claude: { mustRender: false, allowBlocked: true, note: '上游 403（地区受限），只要求诚实说明页' },
};

function findCdp() {
  const candidates = [
    process.env.WEBCODE_PROFILE_DIR ? path.join(process.env.WEBCODE_PROFILE_DIR, 'DevToolsActivePort') : null,
    path.join(os.homedir(), '.dsh', 'webcode-edge-profile', 'DevToolsActivePort'),
    path.resolve('.edge-real-profile', 'DevToolsActivePort'),
  ].filter(Boolean);
  for (const f of candidates) {
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
      const port = lines.find((l) => /^\d+$/.test(l));
      if (port) return { port, file: f };
    } catch { /* next */ }
  }
  return null;
}

const cdp = findCdp();
if (!cdp) {
  console.error('[matrix] 找不到 DevToolsActivePort —— 桥还没启动过 Edge，先让中继跑一次任意站点。');
  process.exit(2);
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdp.port, { timeout: 15_000 });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });

const sites = (ONLY.length ? SITES.filter((s) => ONLY.includes(s.id)) : SITES);
const results = [];

for (const st of sites) {
  const expect = EXPECT[st.id] || { mustRender: true };
  const rec = {
    siteId: st.id, siteName: st.name, origin: st.origin,
    // 挂载形态必须与 UI/服务端一致：站点声明 mountAtRelayRoot（DeepSeek）时用
    // 中继根——给它套子域会触发站点自身的主机名校验，得到一张空白页。
    url: st.mountAtRelayRoot === true
      ? `http://127.0.0.1:${PORT}/`
      : `http://${st.id}.localhost:${PORT}/`,
    mountedAtRelayRoot: st.mountAtRelayRoot === true,
    expect, consoleErrors: [], pageErrors: [], failed: [], httpErrors: [],
    ok: false, verdict: '',
  };
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') rec.consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => rec.pageErrors.push(String(e?.message || e).slice(0, 200)));
  page.on('requestfailed', (r) => rec.failed.push(r.url().slice(0, 140) + ' :: ' + (r.failure()?.errorText || '')));
  page.on('response', (r) => { if (r.status() >= 400) rec.httpErrors.push(r.status() + ' ' + r.url().slice(0, 140)); });

  try {
    const resp = await page.goto(rec.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    rec.httpStatus = resp?.status() ?? null;
    await page.waitForTimeout(WAIT_MS);
    const probe = await page.evaluate((sel) => {
      const root = document.querySelector('#app, #root, [data-reactroot], main');
      const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
      return {
        title: document.title,
        rootFound: Boolean(root),
        rootChildren: root ? root.children.length : -1,
        rootHtmlLen: root ? root.innerHTML.length : -1,
        bodyTextLen: txt.length,
        bodyText: txt.slice(0, 220),
        composerHits: sel ? document.querySelectorAll(sel).length : -1,
        nTextarea: document.querySelectorAll('textarea').length,
        nEditable: document.querySelectorAll('[contenteditable="true"]').length,
        // 游客页/登录页标志：矩阵据此判断「镜像里看到的登录视角」是否与站点一致
        loginMarkers: [...document.querySelectorAll('button, a')]
          .filter((el) => /^(登录|注册|Sign in|Log in|Sign up)$/.test((el.innerText || '').trim()))
          .map((el) => (el.innerText || '').trim()).slice(0, 4),
        // 跳站检测：z.ai/qwen 点登录后若落到别的站点，host 会变
        host: location.host,
        isSecureContext: window.isSecureContext,
      };
    }, st.input || null).catch((e) => ({ evalError: String(e.message).slice(0, 160) }));
    rec.dom = probe;

    // 断言
    const blocked = rec.httpStatus >= 400 || /无法连接|拒绝了镜像请求/.test(probe.title || '');
    // 「渲染出来了」= 有真实根容器的子节点，或页面正文达到一段真实 UI 的量级。
    // 阈值 60 来自实测分布：坏掉的 doubao 只有 4 字符（「会话列表」骨架），
    // 渲染正常的 grok 是 79 字符。单看根选择器会冤枉那些不用 #app/#root 的站点。
    const rendered = (probe.rootChildren || 0) > 0 || (probe.bodyTextLen || 0) >= 60;
    rec.blocked = Boolean(blocked);
    if (expect.mustRender) {
      if (rendered && !blocked) { rec.ok = true; rec.verdict = '渲染正常'; }
      else if (expect.allowBlocked && blocked) { rec.ok = true; rec.verdict = '上游受限 → 诚实引导页（预期）'; }
      else { rec.ok = false; rec.verdict = `未渲染（http=${rec.httpStatus} rootChildren=${probe.rootChildren} textLen=${probe.bodyTextLen} title=${probe.title}）`; }
    } else {
      rec.ok = blocked || !rendered;
      rec.verdict = rec.ok ? '非可用站点：上游受限，给出说明页（预期）' : '预期受限却渲染成功（口径变化，需复核）';
    }
    // 上游把压缩字节当明文转发时，镜像页会是一屏乱码：显式抓这种形态
    // （真机 2026-09-13 claude 的 zstd 就这么进来的）。
    if (rendered && /[\uFFFD]|锟/.test(String(probe.bodyText || ''))) {
      rec.ok = false; rec.verdict = '正文是乱码（上游 content-encoding 未被正确解压）';
    }
    // 子域挂载自检：镜像页必须停在该站点自己的源上
    if (rec.ok && probe.host && !rec.mountedAtRelayRoot && !probe.host.startsWith(st.id + '.localhost')) {
      rec.ok = false;
      rec.verdict = `跳站：期望 host=${st.id}.localhost，实际 ${probe.host}`;
    }
  } catch (e) {
    rec.ok = false; rec.verdict = '加载异常：' + String(e?.message || e).slice(0, 180);
  }

  const shot = path.join(SHOT_DIR, `matrix-${st.id}-${TS}.png`);
  try { await page.screenshot({ path: shot, fullPage: false }); rec.screenshot = shot; } catch { /* ignore */ }
  if (!KEEP) await page.close().catch(() => {});
  results.push(rec);
  const mark = rec.ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${st.id.padEnd(9)} ${rec.verdict}`);
  if (!rec.ok && rec.dom) {
    console.log(`         bodyText: ${String(rec.dom.bodyText || '').slice(0, 140)}`);
    console.log(`         console : ${rec.consoleErrors.slice(0, 2).join(' | ').slice(0, 200)}`);
  }
}

await ctx.close().catch(() => {});
await browser.close().catch(() => {});

const passed = results.filter((r) => r.ok).length;
const report = {
  at: new Date().toISOString(),
  port: PORT,
  cdp,
  relayBuild: null,
  total: results.length,
  passed,
  failed: results.length - passed,
  results,
};
// 中继 build 指纹（0.12.9 起 status 暴露 version/hash）：报告与部署对不上就是白跑。
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/__webcode/status`);
  const j = await r.json();
  report.relayBuild = j?.build ?? null;
} catch { /* standalone 端口无该路由也算正常 */ }

const outFile = path.join(OUT_DIR, `real-mirror-matrix-${TS}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`\n[matrix] ${passed}/${results.length} PASS · relay build=${JSON.stringify(report.relayBuild)}`);
console.log(`[matrix] 证据：${outFile}`);
console.log(`[matrix] 截图目录：${SHOT_DIR}`);
process.exit(passed === results.length ? 0 : 1);