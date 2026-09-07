// real-probe-06-live.mjs — 尝试用本机真实 Edge profile 连通 chat.deepseek.com
// 验证：登录态是否有效、各模式（flash / vision / deepseek）真实轮询是否可用。
// 用法：node test-mock/real-probe-06-live.mjs [模型flash|vision|deepseek] [消息]
import { createBrowserDriver } from '../lib/browser-driver.js';

const model = process.argv[2] || 'flash';
const prompt = process.argv[3] || '请只回复四个字：链路OK';
const profileDir = process.env.REAL_PROFILE || 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\.edge-real-profile';

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/',
  profileDir,
  headless: true,
  requestTimeoutMs: 90_000,
  logger: console,
});

let timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); process.exit(2); }, 120_000);

try {
  const status = driver.status();
  console.log('driver status:', JSON.stringify(status));
  const conn = await driver.connect();
  console.log('connect:', JSON.stringify(conn));
  if (!conn.loggedIn) {
    console.log('NEED_LOGIN: 该 profile 无有效登录态');
    process.exit(accel(3));
  }
  console.log('已登录，开始真实轮询 model=', model);
  const t0 = Date.now();
  let firstDelta = null;
  const result = await driver.sendPrompt(prompt, {
    model,
    onDelta: (d) => { if (firstDelta == null) firstDelta = Date.now() - t0; process.stdout.write(d); },
  });
  console.log('\n\nRESULT:', JSON.stringify({ model, firstDeltaMs: firstDelta, ...result }));
  // 输出诊断信息
  try { console.log('DIAG:', JSON.stringify(await driver.diagnostics())); } catch (e) { console.log('DIAG-ERR', e.message); }
} catch (e) {
  console.error('\nPROBE-ERROR:', e?.message, e?.code ?? '');
  if (e?.code) console.error('ERR-CODE', e.code);
} finally {
  clearTimeout(timer);
  try { await driver.close(); } catch {}
}

function accel(n) { return n; }