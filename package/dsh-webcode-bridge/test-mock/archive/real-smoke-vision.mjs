// real-smoke-vision.mjs — one-shot real DeepSeek web vision mode smoke.
import { createBrowserDriver } from '../lib/browser-driver.js';
import { serializeFirstTurn } from '../lib/agent-preset.js';

const ROOT = 'd:/9_Code_Workspace/dsh-webcode-bridge';
const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/',
  profileDir: ROOT + '/.edge-real-profile',
  headless: true,
  requestTimeoutMs: 120_000,
  logger: console,
});

// 1x1 PNG, red pixel.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lF3mWQAAAABJRU5ErkJggg==';
const timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); process.exit(2); }, 180_000);
try {
  const conn = await driver.connect();
  console.log('connect loggedIn=', conn.loggedIn);
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }
  const prompt = '请描述这张图片的内容，并说明图片主要颜色。';
  const first = serializeFirstTurn({ messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image', source: { data: PNG, mediaType: 'image/png' } }] }], model: { id: 'vision' } });
  const r = await driver.sendTurn('real-vision-1', first, {
    fresh: true,
    model: 'vision',
    images: [{ name: 'pixel.png', contentType: 'image/png', data: PNG }],
  });
  console.log('vision text=', (r.text || '').slice(0, 160).replace(/\n/g, ' '));
  console.log((r.text || '').trim() ? 'VISION-SMOKE PASS' : 'VISION-SMOKE FAIL');
  await driver.resetConversation('real-vision-1');
} catch (e) {
  console.error('VISION-SMOKE ERROR:', e?.message, e?.code ?? '');
} finally {
  clearTimeout(timer);
  try { await driver.close(); } catch {}
}
