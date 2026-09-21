// dump-login-candidates.mjs — 抓某站游客页的「登录」候选 DOM，用于校准 loginProbe.bad
// 用法：node test-mock/dump-login-candidates.mjs kimi
import { createBrowserDriver } from '../lib/browser-driver.js';
import os from 'node:os';
import path from 'node:path';
const siteId = process.argv[2] || 'kimi';
const originBySite = { glm:'https://chatglm.cn/', qwen:'https://chat.qwen.ai/', doubao:'https://www.doubao.com/', kimi:'https://www.kimi.com/', zai:'https://chat.z.ai/' };
const profileDir = path.join(os.tmpdir(), 'login-probe-empty', siteId);
const driver = createBrowserDriver({ siteId, site: originBySite[siteId], profileDir, headless: true, requestTimeoutMs: 60_000, logger: { log(){},warn(){},error(){},info(){} } });
try {
  await driver.connect();
  const page = driver.page;
  if (!page) { console.log('no page'); process.exit(0); }
  // 1) 全文扫描游客页可读文本中含登录/注册/sign 的行 + 最小携带节点的形态
  const info = await page.evaluate(() => {
    const re = /登录|登 ?录|注册|sign ?in|log ?in|welcome|欢迎/i;
    const lines = (document.body.innerText || '').split('\n').map(s => s.trim()).filter(s => s && re.test(s)).slice(0, 30);
    // 找「最小可见节点」：只含一行登录文案的元素（children 为空文本或仅为自身文本）
    const smallest = [];
    document.querySelectorAll('*').forEach((el) => {
      const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('');
      if (!re.test(own)) return;
      const rect = el.getBoundingClientRect();
      const visible = !!(el.offsetWidth || el.offsetHeight || rect.width || rect.height);
      if (!visible) return;
      smallest.push({
        tag: el.tagName, own: own.trim().slice(0, 40),
        aria: el.getAttribute('aria-label') || '', href: el.getAttribute('href') || '',
        role: el.getAttribute('role') || '', cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 50),
        rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width)],
      });
    });
    // 按上一级宽度升序取最叶子化的前 12 个
    smallest.sort((a, b) => b.rect[1] - a.rect[1]);
    return { lines, smallest: smallest.slice(0, 16) };
  });
  console.log('=== ' + siteId + ' guest visible login-ish text lines ===');
  for (const l of info.lines) console.log('  line:', JSON.stringify(l));
  console.log('=== smallest login-ish nodes (由叶子到上层) ===');
  for (const n of info.smallest) console.log(JSON.stringify(n));
  // 2) composer 是否可见
  const composer = await page.evaluate(() => {
    const sels = ['textarea','div[contenteditable="true"]','[contenteditable]','textarea[placeholder]'];
    return sels.map(s => { try { const el = document.querySelector(s); if (!el) return null; return { s, visible: !!(el.offsetWidth||el.offsetHeight) }; } catch { return null; } }).filter(Boolean).slice(0,6);
  });
  console.log('=== composer ===', JSON.stringify(composer));
  // 3) 时序假设验证：同样的 bad 选择器在 connect 后「立即」vs「等 3s」的命中差异
  const kimiBad = 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")';
  const t0 = { count: await page.locator(kimiBad).count() };
  t0.firstVisible = (await page.locator(kimiBad).first().isVisible().catch(() => false));
  await page.waitForTimeout(3000);
  const t3 = { count: await page.locator(kimiBad).count() };
  t3.firstVisible = (await page.locator(kimiBad).first().isVisible().catch(() => false));
  console.log('=== timing race check (bad selector) ===');
  console.log('  t0(connect后立即):', JSON.stringify(t0));
  console.log('  t3(+3s):', JSON.stringify(t3));
  console.log('=== url ===', page.url());
} catch (e) { console.log('ERR', e?.message); }
finally { try { await driver.close(); } catch {} }
process.exit(0);