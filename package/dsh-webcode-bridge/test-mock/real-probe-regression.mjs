// real-probe-regression.mjs — 回归对比探针：同一流程分别驱动两个版本的 lib。
// 用法：PROBE_LIB=<lib目录> node test-mock/real-probe-regression.mjs
// 判定：R1 有返回文本 = 返回值链路通；R2 文本含 42 = 会话继承正常。
import { setTimeout as sleep } from 'node:timers/promises';

const libRoot = process.env.PROBE_LIB;
if (!libRoot) { console.error('need PROBE_LIB'); process.exit(2); }
const { pathToFileURL } = await import('node:url');
const { join } = await import('node:path');
const { createBrowserDriver } = await import(pathToFileURL(join(libRoot, 'browser-driver.js')).href);

const ROOT = 'd:/9_Code_Workspace/dsh-webcode-bridge';
const TAG = process.env.PROBE_TAG || 'probe';

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/',
  profileDir: process.env.PROBE_PROFILE || ROOT + '/.edge-real-profile',
  headless: process.env.PROBE_HEADLESS !== 'false',
  requestTimeoutMs: 90_000,
  logger: { log: () => {}, warn: (...a) => console.log('[warn]', ...a), error: (...a) => console.log('[err]', ...a) },
});

const timer = setTimeout(() => { console.log(TAG, 'GLOBAL-TIMEOUT'); process.exit(2); }, 240_000);
try {
  const conn = await driver.connect();
  console.log(TAG, 'connect loggedIn=', conn.loggedIn);
  if (!conn.loggedIn) { console.log(TAG, 'NEED_LOGIN'); process.exit(3); }

  const r1 = await driver.sendTurn(TAG + '-session', '回归探针：请记住暗号X=42，然后只回复两个字：已记', { fresh: true, model: 'flash' });
  console.log(TAG, 'R1 text=', JSON.stringify((r1?.text || '').slice(0, 100)));
  console.log(TAG, 'R1 metrics=', JSON.stringify(r1?.metrics || null));

  const r2 = await driver.sendTurn(TAG + '-session', '暗号X是多少？只回复数字本身。', { fresh: false, model: 'flash' });
  console.log(TAG, 'R2 text=', JSON.stringify((r2?.text || '').slice(0, 100)));

  const retOk = (r1?.text || '').trim().length > 0;
  const inheritOk = /42/.test(r2?.text || '');
  console.log(TAG, retOk ? 'RETVAL-PASS' : 'RETVAL-FAIL', inheritOk ? 'INHERIT-PASS' : 'INHERIT-FAIL');
  await driver.resetConversation(TAG + '-session');
} catch (e) {
  console.error(TAG, 'PROBE-ERROR:', e?.message, e?.code ?? '');
} finally {
  clearTimeout(timer);
  try { await driver.close(); } catch {}
}
