// real-probe-10-vision-debug.mjs — 定位识图发送卡点
// 直接 profileDir，send 期间通过 driver.page 检查 composer / 图片 / 发送按钮状态
import { createBrowserDriver } from '../lib/browser-driver.js';
import fs from 'node:fs';

const imgPath = 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\package\\dsh-webcode-bridge\\test-mock\\vision-test-hello.jpg';
const question = '请用一句话说清图片文字';
const buf = fs.readFileSync(imgPath);
const images = [{ name: 'vision-test.jpg', contentType: 'image/jpeg', data: buf.toString('base64') }];

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/',
  profileDir: 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\.edge-real-profile',
  headless: true,
  requestTimeoutMs: 80_000,
  logger: console,
});
let timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); process.exit(2); }, 100_000);
try {
  const conn = await driver.connect();
  console.log('connect loggedIn=', conn.loggedIn);
  if (!conn.loggedIn) process.exit(3);
  const t0 = Date.now();
  let sent = false;
  const poll = setInterval(async () => {
    try {
      const p = driver.page;
      const st = await p.evaluate(() => {
        const ta = document.querySelector('textarea.ds-scroll-area, textarea');
        const imgs = document.querySelectorAll('img');
        return {
          hasTextarea: !!ta,
          textareaVal: ta ? ta.value : null,
          sendBtns: [...document.querySelectorAll("[role='button'],button")].filter(b=>/发送|send/i.test((b.getAttribute('aria-label')||'')+' '+(b.textContent||''))).map(b=>({aria:b.getAttribute('aria-label'),disabled:b.disabled||b.getAttribute('aria-disabled'),title:b.getAttribute('title')})).slice(0,6),
          pendingUploads: [...document.querySelectorAll('[class*="upload"], [class*="Upload"], [class*="preview"]')].length,
        };
      });
      console.log(`  [${Date.now()-t0}ms] textarea=${JSON.stringify(st.textareaVal)} uploadEls=${st.pendingUploads} sendBtns=${JSON.stringify(st.sendBtns)} sent=${sent}`);
    } catch (e) { console.log('  poll-err', e.message); }
  }, 3000);
  const pr = driver.sendPrompt(question, {
    model: 'vision',
    meta: { model: 'vision', images },
    onDelta: (d) => { sent = true; process.stdout.write(d); },
  });
  const result = await Promise.race([
    pr,
    new Promise((_,rej)=>setTimeout(()=>rej(Object.assign(new Error('inner-timeout'),{code:'INNER'})),85000)),
  ]);
  clearInterval(poll);
  console.log('\nRESULT text=', (result.text||'').slice(0,150));
} catch (e) {
  console.error('\nERR:', e?.message, e?.code??'');
  try { const d = await driver.diagnostics(); console.log('DIAG:', JSON.stringify(d)); } catch {}
} finally {
  clearTimeout(timer);
  try { await driver.close(); } catch {}
}