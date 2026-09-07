// real-probe-05d.mjs — final combined probe:
//   1. reasoning prompt → does the site stream THINK fragments (thinkingMs)?
//   2. wide viewport (1400px) conversation screenshot → sidebar clip engages?
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
  const conn = await driver.connect();
  step('connect', conn);
  if (conn.ok && conn.loggedIn) {
    const r = await driver.sendPrompt('一个农场有鸡和兔共35个头94只脚，问鸡兔各几只？请仔细推理。', { meta: { model: 'deepseek' } }).catch((e) => ({ error: e.message }));
    step('reasoning', { text: (r.text || '').slice(0, 80), metrics: r.metrics || null, error: r.error || null });

    const wide = await driver.screenshotBase64({ width: 1400, height: 1000, withMeta: true }).catch((e) => ({ error: e.message }));
    step('wide-screenshot', { clip: wide?.clip ?? null, viewport: wide?.viewport ?? null, bytes: wide?.base64?.length ?? 0 });

    await driver.sendPrompt('只回答：好', { meta: { model: 'flash' } }).catch(() => {});
  }
} finally {
  out.finishedAt = new Date().toISOString();
  const dest = path.resolve('..', '..', '..', 'doc', 'research', 'real-probe-05d.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log('saved:', dest);
  await driver.close().catch(() => {});
}
