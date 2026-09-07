// real-probe-09-vision-clean.mjs — 隔离 profile 干净验证识图 + 发送后轮询定位
import { chromium } from 'playwright-core';
import { createBrowserDriver } from '../lib/browser-driver.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const srcProfile = 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\.edge-real-profile';
const imgPath = 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\package\\dsh-webcode-bridge\\test-mock\\vision-test-hello.jpg';
const question = process.argv[3] || '请用一句话说清图片文字';

// 1) 从真实 profile 导出登录态
let storage;
{
  let tmp;
  try {
    tmp = await chromium.launchPersistentContext(srcProfile, {
      executablePath: edge, headless: true,
      args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
    });
    await tmp.pages()[0].goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
    await new Promise(r=>setTimeout(r,1500));
    storage = await tmp.storageState();
  } finally { try { await tmp?.close(); } catch {} }
}
console.log('storageState cookies=', storage.cookies.length, 'origins=', storage.origins.length);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-clean-'));
const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/',
  profileDir: tmpDir,
  storageState: storage,
  headless: true,
  requestTimeoutMs: 90_000,
  logger: console,
});
const buf = fs.readFileSync(imgPath);
const images = [{ name: 'vision-test.jpg', contentType: 'image/jpeg', data: buf.toString('base64') }];

let timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); process.exit(2); }, 120_000);
try {
  const conn = await driver.connect();
  console.log('connect loggedIn=', conn.loggedIn);
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }
  const t0 = Date.now();
  let firstDelta = null;
  const poll = setInterval(async () => {
    try {
      const d = await driver.diagnostics();
      console.log(`  [poll ${Date.now()-t0}ms] selectedModel=${d.selectedModel} requestMetadata=${JSON.stringify(d.requestMetadata)} url=${d.urlPath}`);
    } catch {}
  }, 5000);
  const pr = driver.sendPrompt(question, {
    model: 'vision',
    meta: { model: 'vision', images },
    onDelta: (dd) => { if (firstDelta==null) firstDelta = Date.now()-t0; process.stdout.write(dd); },
  });
  const result = await Promise.race([
    pr,
    new Promise((_,rej)=>setTimeout(()=>rej(Object.assign(new Error('inner-timeout'), {code:'INNER'})), 95000)),
  ]);
  clearInterval(poll);
  console.log('\nRESULT:', JSON.stringify({ firstDeltaMs: firstDelta, complete: !!result.text, text: (result.text||'').slice(0,120) }));
} catch (e) {
  console.error('\nERR:', e?.message, e?.code??'');
  try { const d = await driver.diagnostics(); console.log('DIAG:', JSON.stringify(d)); } catch {}
} finally {
  clearTimeout(timer);
  try { await driver.close(); } catch {}
}