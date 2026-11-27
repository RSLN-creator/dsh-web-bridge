// client-server-contract.test.mjs — 客户端动作名/方法与服务端动作表的**契约**护栏。
//
// ## 为什么需要它（这是第三次同一族的真机故障）
//
// 0.15.2 真机：设置页「网页桥接」里取花名册的那一栏永远是空白/读不到。
// 根因不是花名册本身，而是**客户端与服务端对同一个动作的方法不一致**：
//
//     lib/client.cjs      api('status', { sessionId })   → 带 body ⇒ POST
//     lib/web-control.js  'GET status'                   → 只注册了 GET
//
// 真机结果：POST /__webcode/status ⇒ **HTTP 405**（web-control 的
// 「路径存在但方法不对」分支会带 Allow 头返回 405，绝不空 body）。
//
// ## 为什么全量单测全绿却漏掉了它
//
// `client-render.test.mjs` 的 mock fetch **不看方法**——它对任何 URL 都回
// 200 + JSON。于是「服务端根本没有这条路由」在离线测试里完全不可见：
// 组件拿到的是漂亮的假数据，渲染当然不抛错。护栏自己的建模失真，
// 覆盖不到真实契约。
//
// 与前两次（`projectRoster` 漏 import）同族：**引用/调用点都在，链路的
// 另一端不存在**，而且只在真机 HTTP 上才暴露。所以这里把两端放在同一份
// 测试里对齐——这才是唯一能自动发现这一族问题的位置。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(here, '../lib/client.cjs');
const SERVER = path.resolve(here, '../lib/web-control.js');
const MANIFEST = path.resolve(here, '../package.json');
const PACKAGE_README = path.resolve(here, '../README.md');
const ROOT_README = path.resolve(here, '../../../README.md');

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const clientSrc = readFileSync(CLIENT, 'utf8');
const serverSrc = readFileSync(SERVER, 'utf8');
const packageReadmeSrc = readFileSync(PACKAGE_README, 'utf8');
const rootReadmeSrc = readFileSync(ROOT_README, 'utf8');

/**
 * 服务端动作表里注册的 `METHOD action` 组合。
 *
 * 动作表的键就是 'GET status' / 'POST status' 这种形态（web-control.js 的
 * `index.get(suffix)` 与 405 分支都依赖它），所以直接抽键即可——不做语义推断。
 *
 * 两种注册形态都要认，因为两者都真实发生注册：
 *   1. 对象字面量里的键：`'POST status': async (body) => …`
 *   2. 表建好后的别名赋值：`actions['POST status'] = actions['GET status'];`
 *
 * 第二种（0.15.3 引入）是为了让 GET/POST 共用**同一份**实现——复制一份迟早
 * 会漂移，那正是本次 405 的同族病。测试必须认它，否则「用别名修好了」会被
 * 判成「没注册」。
 */
function serverActions() {
  const out = new Set();
  for (const m of serverSrc.matchAll(/'(GET|POST)\s+([a-z][a-z0-9-]*)'\s*:/g)) {
    out.add(m[1] + ' ' + m[2]);
  }
  for (const m of serverSrc.matchAll(/actions\s*\[\s*'(GET|POST)\s+([a-z][a-z0-9-]*)'\s*\]\s*=/g)) {
    out.add(m[1] + ' ' + m[2]);
  }
  return out;
}

/**
 * 客户端发出的所有动作调用，以及它实际会用的方法。
 *
 * `api(action, body)` 在 client.cjs 里的契约是：`body === undefined` ⇒ GET，
 * 否则 POST（见 lib/client.cjs 的 request()）。因此判据是「调用点有没有第二个实参」，
 * 不是「有没有写 body 这个词」。
 */
function clientCalls() {
  const out = [];
  for (const m of clientSrc.matchAll(/\bapi(?:Soft)?\(\s*'([a-z][a-z0-9-]*)'\s*(,?)/g)) {
    // `api('x',` / `api('x' ,` ⇒ 有第二实参 ⇒ POST；`api('x')` ⇒ GET。
    const hasBody = m[2] === ',' ;
    out.push({ action: m[1], method: hasBody ? 'POST' : 'GET', raw: m[0] });
  }
  return out;
}

test('契约：客户端每个 api() 动作都必须在服务端动作表里有对应的方法', () => {
  const actions = serverActions();
  assert.ok(actions.size > 10, '服务端动作表解析失败（只找到 ' + actions.size + ' 条）——先修本测试的解析');

  const calls = clientCalls();
  assert.ok(calls.length > 10, '客户端 api() 调用解析失败（只找到 ' + calls.length + ' 处）——先修本测试的解析');

  const missing = [];
  for (const c of calls) {
    if (!actions.has(c.method + ' ' + c.action)) missing.push(`${c.method} ${c.action}   ← ${c.raw}`);
  }
  assert.deepEqual(missing, [],
    '客户端调用的方法在服务端未注册（真机会是 HTTP 405，而 mock fetch 看不见）：\n  ' + missing.join('\n  '));
});

test('契约：服务端每个动作至少能被一种方法触达（没有写错方法名的死路由）', () => {
  const calls = clientCalls();
  const used = new Set(calls.map((c) => c.method + ' ' + c.action));
  const actions = serverActions();
  // 只校验「客户端用过这个名字」的那些动作：其余动作是给外部/测试用的，
  // 不强制客户端一定要调（否则会把合法未用路由判成缺陷）。
  const names = new Set(calls.map((c) => c.action));
  const dead = [...actions].filter((k) => names.has(k.split(' ')[1]) && !used.has(k));
  assert.deepEqual(dead, [],
    '同名动作存在但方法对不上（客户端发的方法服务端没注册）：\n  ' + dead.join('\n  '));
});
test('Web client manifest declares the real module dependencies and lazy browser entry', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web');
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-chat',
    '@deepseek-ai/dsh-client-ui-settings-general',
    '@deepseek-ai/dsh-client-ui-sidebar-right',
  ]);
  assert.equal(manifest.exports?.['./client'], './lib/client.cjs');
  assert.match(clientSrc, /window\.__ModuleLoader__\.load\(\{\s*id:\s*'dsh-webcode-bridge'/,
    'the browser bundle must register the package id with the DSH lazy module loader');
});

test('Web bundle imports only modules supplied by the official Web platform', () => {
  // Verified against deepseek-harness packages/client/web/src/platform.ts (0.2.3-alpha.2).
  // Platform modules are preloaded by DSH; feature packages belong in dsh.client.inject.
  const platformModules = new Set([
    'react',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/dsh-client-ui-primitives',
  ]);
  const required = [...new Set([...clientSrc.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)]
    .map((match) => match[2]))].sort();
  const unsupported = required.filter((name) => !platformModules.has(name));
  assert.deepEqual(unsupported, [],
    'client.cjs requests modules not preloaded by the Web platform; declare a real external or inject its package');
});

test('documented minimum DSH version matches package engine requirement', () => {
  const required = manifest.engines?.dsh;
  assert.equal(typeof required, 'string', 'package.json must declare the minimum DSH version');
  for (const [name, source] of [
    ['package README', packageReadmeSrc],
    ['repository README', rootReadmeSrc],
  ]) {
    assert.ok(source.includes('| DeepSeek Harness | ' + required + ' |'),
      name + ' must document the same DSH minimum as package.json engines.dsh (' + required + ')');
  }
});

test('right-sidebar split opens the current site and account in the new official pane', () => {
  const start = clientSrc.indexOf('const splitPanel =');
  const end = clientSrc.indexOf('const floatPanel =', start);
  assert.ok(start >= 0 && end > start, 'splitPanel must be registered before the float action');
  const split = clientSrc.slice(start, end);
  assert.ok(split.includes('ctx.sidebarRight.split()'), 'must use the official sidebar split operation');
  assert.ok(split.includes('if (!paneId) return;'), 'must not open a tab when DSH cannot split the pane');
  assert.ok(split.includes('ctx.sidebarRight.openTab(SITE_KIND, {')
    && split.includes("paneId, params: { siteId: sid, slot: slot || '' }"),
    'the new pane must open the site tab with its site and account parameters');
  assert.ok(clientSrc.includes('onClick: () => onSplit(siteId, accountSlot)'),
    'the button must pass the current site and selected account rather than the click event');
  assert.ok(!clientSrc.includes('pendingPaneSite') && !clientSrc.includes('openSiteInPane'),
    'the old module-level handoff must not compete with official tab navigation params');
});

test('Web UI site labels and choices come from the live server adapter directory', () => {
  assert.match(clientSrc, /const SITE_DIRECTORY = new Map\(\)/,
    'the bundle must keep only a runtime cache, not a copied site-name table');
  assert.match(clientSrc, /rememberSiteDirectory\(r\.data\?\.driver\?\.sites\)/,
    'GET status must hydrate the directory from the canonical adapter projection');
  assert.match(clientSrc, /const siteRecord = sid => SITE_DIRECTORY\.get/);
  assert.match(clientSrc, /const siteName = sid => siteRecord\(sid\)\?\.name/);
  assert.match(clientSrc, /siteRecord\(sid\)\?\.mountAtRelayRoot === true/,
    'relay-root routing must be adapter metadata, not a client-side site-name exception');
  assert.match(clientSrc, /siteIdsFromRows\(rows\)/,
    'the website catalog must derive its choices from server rows');
  assert.match(clientSrc, /siteIdsFromRows\(sites\)/,
    'the settings tabs must derive their choices from server rows');
  assert.match(clientSrc, /if \(sid && !SITE_DIRECTORY\.has\(sid\)\)[\s\S]{0,220}api\('status'\)/,
    'restored site-tab titles must hydrate their label when opened before the catalog');
  assert.doesNotMatch(clientSrc, /const SITE_NAMES\s*=\s*\{/,
    'site names and supported-site lists must not be duplicated in the browser bundle');
});

test('Web account login relays the selected account PNG QR into its own UI row', () => {
  assert.match(clientSrc, /apiSoft\('login-qr',\s*\{\s*\.\.\.siteSlot\(sid\)\s*\}/);
  assert.match(clientSrc, /response\.data\?\.available === true \? response\.data\.image : null/);
  assert.match(clientSrc, /src: loginQrByAccount\[s\.accountKey\]/);
  assert.match(serverSrc, /'POST login-qr': async \(body\) =>/);
  assert.match(serverSrc, /return reader\(accountKeyOf\(body, \{ fallback: '' \}\)\)/);
});
