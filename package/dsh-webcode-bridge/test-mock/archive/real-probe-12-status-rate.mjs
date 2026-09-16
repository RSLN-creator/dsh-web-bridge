// real-probe-12-status-rate.mjs — 真机验证 status().lastRate 与账户字段
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn } from '../lib/agent-preset.js';
const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/', profileDir: 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\.edge-real-profile',
  headless: true, requestTimeoutMs: 60_000, logger: console,
});
let timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); process.exit(2); }, 90_000);
try {
  const conn = await driver.connect();
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }
  const r = await driver.sendTurn('rate-probe', serializeFirstTurn({ messages: [{ role: 'user', content: '请回复十个字。' }], tools: [], model: { id: 'flash' } }), { fresh: true, model: 'flash' });
  const st = driver.status();
  console.log('turn metrics endToEndMs=', r.metrics?.endToEndMs, 'firstResponseMs=', r.metrics?.firstResponseMs, 'responseMs=', r.metrics?.responseMs);
  console.log('status.lastRate=', JSON.stringify(st.lastRate));
  const ok = st.lastRate && typeof st.lastRate.charsPerSec === 'number' && st.lastRate.charsPerSec > 0 && st.lastRate.firstResponseMs != null;
  console.log(ok ? 'LOAD_RATE OK' : 'LOAD_RATE MISSING');
} catch (e) {
  console.error('ERR:', e?.message, e?.code ?? '');
} finally {
  clearTimeout(timer);
  try { await driver.close(); } catch {}
}