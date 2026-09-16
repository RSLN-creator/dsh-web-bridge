// real-probe-15-need-login.mjs — 验证"未登录/账号失效"路由的优雅诊断：
// 用一个空的临时 profile 目录启动，connect() 应干净返回 loggedIn=false，status 正常，不静默卡死。
import { createBrowserDriver } from '../lib/browser-driver.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-empty-'));
const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/', profileDir: tmp,
  headless: true, requestTimeoutMs: 30_000, logger: { log: () => {}, warn: () => {}, error: () => {} },
});
let timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); process.exit(2); }, 60_000);
try {
  const conn = await driver.connect();
  const st = driver.status();
  const clean = !conn.loggedIn && (st.needLogin === true || st.loggedIn === false);
  console.log('loggedIn=', conn.loggedIn, 'needLogin=', st.needLogin, 'running=', st.running);
  console.log(clean ? 'PASS need-login 干净诊断，未静默卡死' : 'FAIL 未登录诊断异常');
} catch (e) {
  console.log('FAIL connect 抛错而非诊断: ', e?.message);
} finally {
  clearTimeout(timer);
  try { await driver.close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}