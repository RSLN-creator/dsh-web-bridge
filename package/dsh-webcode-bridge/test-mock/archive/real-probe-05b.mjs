// real-probe-05b.mjs — follow-up probe: thinking-phase metrics on a real
// reasoning prompt + chat-clip screenshot metadata on a CONVERSATION page
// (where the session sidebar is visible and must be clipped away).
import { createBrowserDriver } from '../lib/browser-driver.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const out = { startedAt: new Date().toISOString(), steps: {} };
const step = (name, data) => { out.steps[name] = data; console.log(`[${name}]`, JSON.stringify(data).slice(0, 400)); };

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/',
  profileDir: path.join(os.homedir(), '.dsh', 'webcode-edge-profile'),
  headless: true,
  requestTimeoutMs: 240_000,
  logger: console,
});

try {
  const conn = await driver.connect().catch((e) => ({ ok: false, error: e.message }));
  step('connect', conn);
  if (conn.ok && conn.loggedIn) {
    // reasoning prompt — expert mode should emit THINK fragments first
    const d0 = Date.now();
    const deep = await driver.sendPrompt('9.11 和 9.9 哪个更大？请一步步仔细推理后给出结论。', { meta: { model: 'deepseek' } }).catch((e) => ({ error: e.message }));
    step('deepseek-reasoning', {
      ms: Date.now() - d0,
      text: (deep.text || '').slice(0, 100),
      metrics: deep.metrics || null,
      error: deep.error || null,
      sessionUrl: driver.status().lastTurn?.url || null,
    });

    // conversation page screenshot — sidebar visible → clip should engage
    const shot = await driver.screenshotBase64({ width: 900, height: 1100, withMeta: true }).catch((e) => ({ error: e.message }));
    step('screenshot-conversation', {
      clip: shot?.clip ?? null,
      viewport: shot?.viewport ?? null,
      bytes: shot?.base64 ? shot.base64.length : 0,
      error: shot?.error || null,
    });

    const diag = await driver.diagnostics().catch((e) => ({ error: e.message }));
    step('diagnostics-after', { urlPath: diag.urlPath, selectedModel: diag.selectedModel, controls: (diag.controls || []).slice(0, 6) });

    await driver.sendPrompt('只回答：好', { meta: { model: 'flash' } }).catch(() => {});
  }
} finally {
  out.finishedAt = new Date().toISOString();
  const dest = path.resolve('..', '..', '..', 'doc', 'research', 'real-probe-05b.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log('saved:', dest);
  await driver.close().catch(() => {});
}
