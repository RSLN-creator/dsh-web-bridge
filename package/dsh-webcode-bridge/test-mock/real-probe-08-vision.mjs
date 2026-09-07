// real-probe-08-vision.mjs — 真实验证识图模式：上传本地图片 → 模型识别 → 输出
// 用法：node test-mock/real-probe-08-vision.mjs [图片路径] [问题]
import { createBrowserDriver } from '../lib/browser-driver.js';
import fs from 'node:fs';

const imgPath = process.argv[2] || 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\package\\dsh-webcode-bridge\\test-mock\\vision-test-hello.jpg';
const question = process.argv[3] || '请用一句话告诉我这张图片上的文字内容是什么。';

const buf = fs.readFileSync(imgPath);
const images = [{ name: 'vision-test.jpg', contentType: 'image/jpeg', data: buf.toString('base64') }];

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/',
  profileDir: 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\.edge-real-profile',
  headless: true,
  requestTimeoutMs: 120_000,
  logger: console,
});

let timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); process.exit(2); }, 150_000);
try {
  const conn = await driver.connect();
  console.log('connect:', JSON.stringify(conn));
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }
  console.log('已登录，开始识图轮询 vision + image=' + imgPath);
  const t0 = Date.now();
  let firstDelta = null;
  const result = await driver.sendPrompt(question, {
    model: 'vision',
    meta: { model: 'vision', images },
    onDelta: (d) => { if (firstDelta == null) firstDelta = Date.now() - t0; process.stdout.write(d); },
  });
  console.log('\n\nRESULT:', JSON.stringify({ firstDeltaMs: firstDelta, ...result }));
  try { console.log('DIAG:', JSON.stringify(await driver.diagnostics())); } catch (e) { console.log('DIAG-ERR', e.message); }
} catch (e) {
  console.error('\nVISION-ERROR:', e?.message, e?.code ?? '');
  try { console.log('DIAG-ON-ERR:', JSON.stringify((await driver.diagnostics()).requestMetadata)); } catch (e2) { console.log('DIAG-ON-ERR-FAIL', e2.message); }
} finally {
  clearTimeout(timer);
  try { await driver.close(); } catch {}
}