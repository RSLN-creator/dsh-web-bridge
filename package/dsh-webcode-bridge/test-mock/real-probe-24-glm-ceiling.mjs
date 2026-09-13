// real-probe-24-glm-ceiling.mjs — composer 长度上限的续测（2026-09-14）。
//
// probe-23 已经把斜坡推到 200000 字符仍未触顶（每档 fill+回读 40–100ms，很快）。
// 本探针从 250000 起继续往上，直到出现截断/失败，好让 providers.js 里的
// context 声明有真机依据，而不是继续写「猜的 1_000_000」。
//
// 只填输入框、不按发送；每档填完立刻清空。
import fs from 'node:fs';
import path from 'node:path';
import { createBrowserDriver } from '../lib/browser-driver.js';

const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'out');
const SITE_ID = process.env.PROBE_SITE || 'glm';
const PROFILE = process.env.PROBE_PROFILE || 'C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/' + SITE_ID;
const SITE_URL = SITE_ID === 'glm' ? 'https://chatglm.cn/' : 'https://chat.z.ai/';
const COMPOSER = process.env.PROBE_COMPOSER || 'textarea#chat-input, textarea[placeholder], textarea';
const RAMP = (process.env.PROBE_RAMP || '250000,400000,600000,800000,1000000,1200000')
  .split(',').map((s) => Number(s.trim())).filter((n) => n > 0);

const out = { at: new Date().toISOString(), siteId: SITE_ID, ramp: RAMP, results: [] };
const say = (...a) => { console.log(...a); };

const driver = createBrowserDriver({
  siteId: SITE_ID, site: SITE_URL, profileDir: PROFILE, headless: true,
  requestTimeoutMs: 240_000, loginTimeoutMs: 300_000, logger: console,
});

try {
  await driver.connect();
  const page = driver.page;
  const loc = page.locator(COMPOSER).first();
  if (!await loc.count()) throw new Error('composer not found: ' + COMPOSER);
  say('[composer] found; 站点=' + SITE_ID);
  for (const n of RAMP) {
    const text = 'a'.repeat(n);
    const t0 = Date.now();
    let r;
    try {
      await loc.fill(text, { timeout: 120_000 });
      const back = await loc.inputValue({ timeout: 20_000 });
      r = { n, ok: true, back: back.length, ms: Date.now() - t0 };
    } catch (err) {
      r = { n, ok: false, reason: String(err?.message || err).slice(0, 160), ms: Date.now() - t0 };
    }
    try { await loc.fill('', { timeout: 20_000 }); } catch { /* 清不掉不影响结论 */ }
    out.results.push(r);
    say(`  ${String(n).padStart(8)} → ` + (r.ok ? `回读 ${r.back}（${r.ms}ms）${r.back === n ? ' OK' : ' 截断!'}` : `失败 ${r.ms}ms: ${r.reason}`));
    if (!r.ok || r.back !== n) break;
  }
  const lastOk = [...out.results].reverse().find((r) => r.ok && r.back === r.n);
  out.acceptedAtLeast = lastOk?.n ?? 0;
  out.firstFailure = out.results.find((r) => !r.ok || r.back !== r.n) ?? null;
  say('⇒ 稳定接受 ≥ ' + out.acceptedAtLeast + ' 字符' + (out.firstFailure ? `；首个失败档 ${out.firstFailure.n}` : '（仍未触顶）'));
  say('PROBE RESULT: done');
} catch (err) {
  say('PROBE FAIL: ' + String(err?.message || err));
  out.error = String(err?.message || err);
  process.exitCode = 1;
} finally {
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch { /* out dir */ }
  const file = path.join(OUT_DIR, `glm-ceiling-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  try { fs.writeFileSync(file, JSON.stringify(out, null, 2)); console.log('证据写入 ' + file); } catch { /* best effort */ }
  try { driver.close?.(); } catch { /* 关不掉就算了 */ }
}