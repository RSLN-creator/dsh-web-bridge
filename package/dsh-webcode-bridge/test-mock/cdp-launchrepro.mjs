// cdp-launchrepro.mjs — 最小复现:headless launchPersistentContext 后
// 「newPage + 关闭初始页」是否导致 Edge 整体退出(0.12.0 launch 改动的回归测试)。
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const profile = process.argv[2] || path.join(process.env.DSH_HOME || path.join(process.env.HOME, '.dsh'), 'webcode-edge-profile', 'sites', 'glm');
for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
  try { fs.rmSync(path.join(profile, f), { force: true }); } catch {}
}
const b = await chromium.launchPersistentContext(profile, {
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--remote-debugging-port=0', '--hide-crash-restore-bubble'],
});
const alive = () => !b._connection?.closed; // best-effort
console.log('t0 pages:', b.pages().length);
const stale = b.pages();
const np = await b.newPage();
console.log('after newPage pages:', b.pages().length);
for (const s of stale) { try { await s.close(); } catch (e) { console.log('close err', e.message.slice(0, 60)); } }
console.log('after close-stale pages:', b.pages().length);
await np.goto('https://www.baidu.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('goto err:', e.message.slice(0, 80)));
await new Promise(r => setTimeout(r, 8000));
let final;
try { final = await np.evaluate(() => document.title); } catch (e) { final = 'EVAL-ERR: ' + e.message.slice(0, 60); }
console.log('t+8s alive, title =', final);
await b.close().catch(() => {});
console.log('REPRO-DONE');
