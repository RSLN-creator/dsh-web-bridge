// real-probe-05.mjs — drive the REAL logged-in DeepSeek web (chat.deepseek.com)
// through the 0.5.0 driver and record:
//   1. connect + model controls on the live page
//   2. flash turn  → real phase metrics (firstResponseMs / thinkingMs / responseMs)
//   3. deepseek turn (深度思考/专家) → metrics + request model_type
//   4. vision turn with a real PNG upload → attachment flow + reply
//   5. chat-clip screenshot (sidebar removal) metadata
// Results land in doc/research/real-probe-05.json next to the console log.
import { createBrowserDriver } from '../lib/browser-driver.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const out = { startedAt: new Date().toISOString(), steps: {} };
const step = (name, data) => { out.steps[name] = data; console.log(`[${name}]`, JSON.stringify(data).slice(0, 300)); };

// 8×8 red PNG (tiny, real image bytes)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGElEQVR4nGP8z8Dwn4EIwESMolGFI0chAG+bAR12QNRhAAAAAElFTkSuQmCC';

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/',
  profileDir: process.env.WEBCODE_PROBE_PROFILE || path.join(os.homedir(), '.dsh', 'webcode-edge-profile'),
  headless: true,
  requestTimeoutMs: 240_000,
  logger: console,
});

try {
  // 1. connect + diagnostics
  const conn = await driver.connect().catch((e) => ({ ok: false, error: e.message }));
  step('connect', conn);
  if (!conn.ok || !conn.loggedIn) {
    step('aborted', { reason: 'not logged in — run the panel login once first' });
  } else {
    const diag = await driver.diagnostics().catch((e) => ({ error: e.message }));
    step('diagnostics', { urlPath: diag.urlPath, selectedModel: diag.selectedModel, controls: (diag.controls || []).slice(0, 8) });

    // 2. flash turn
    const t0 = Date.now();
    const flash = await driver.sendPrompt('只回答两个字：收到', { meta: { model: 'flash' } }).catch((e) => ({ error: e.message }));
    step('flash-turn', { ms: Date.now() - t0, text: (flash.text || '').slice(0, 80), metrics: flash.metrics || null, error: flash.error || null, requestModel: flash.error ? undefined : undefined });

    // 3. deepseek (深度思考/专家) turn
    const d0 = Date.now();
    const deep = await driver.sendPrompt('用一句话说明你是什么模型。', { meta: { model: 'deepseek' } }).catch((e) => ({ error: e.message }));
    step('deepseek-turn', { ms: Date.now() - d0, text: (deep.text || '').slice(0, 80), metrics: deep.metrics || null, error: deep.error || null });

    // 4. vision turn with image upload
    const v0 = Date.now();
    const vision = await driver.sendPrompt('这张图片是什么颜色？只回答颜色名。', {
      meta: {
        model: 'vision',
        images: [{ name: 'probe.png', contentType: 'image/png', data: PNG_B64 }],
      },
    }).catch((e) => ({ error: e.message }));
    step('vision-turn', { ms: Date.now() - v0, text: (vision.text || '').slice(0, 80), metrics: vision.metrics || null, error: vision.error || null });

    // 5. screenshot with panel-size sync + chat clip
    const shot = await driver.screenshotBase64({ width: 800, height: 1000, withMeta: true }).catch((e) => ({ error: e.message }));
    step('screenshot', { clip: shot?.clip ?? null, viewport: shot?.viewport ?? null, bytes: shot?.base64 ? shot.base64.length : 0, error: shot?.error || null });

    // restore the default model so the user's next web visit is untouched
    await driver.sendPrompt('只回答：好', { meta: { model: 'flash' } }).catch(() => {});
  }
} finally {
  out.finishedAt = new Date().toISOString();
  const dest = path.resolve('..', '..', '..', 'doc', 'research', 'real-probe-05.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log('saved:', dest);
  await driver.close().catch(() => {});
}
