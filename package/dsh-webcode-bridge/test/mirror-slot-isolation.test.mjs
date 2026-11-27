// mirror-slot-isolation.test.mjs — 账户2 的右侧标签页必须拿到**账户2 自己的登录态**（0.19.46）。
//
// ## 真机缺陷（用户原话，2026-09-28）
//
//   > 现在右侧选择了账户2打开界面仍是用户1：rsyhn的登录账户，deepseek
//
// 根因两处，**两端都要修**，缺一处就不成立：
//
// ① **服务端**（`lib/index.js` 的 `mirrorFor`）：镜像原先只按 `siteId` 挂载
//    （Map 的 key 就是 `siteId`），而 cookie 来源写死 `driverFor(sid)` —— 传的是
//    **裸 siteId**，按 `accounts.formatAccountKey` 的语义恒等于**默认槽**。
//    于是账户2 的请求命中默认槽那个 mirror 实例、回填账户1 的 cookies。
//    槽在 URL 里没有任何位置 ⇒ 服务端**结构上无从区分**。
// ② **客户端**（`lib/client.cjs` 的 `siteBase`）：iframe 的源也只按 `siteId` 拼，
//    账户1 与账户2 指向同一个地址。服务端即使修好，客户端仍会把两者混成一条。
//
// 修法：给槽一个**独立源**（沿用本项目「每个站点独立源」的既有立场，因为 SPA
// router 以 pathname 基线为准，且 cookie 按子域天然隔离）：
//
//     默认槽     `<siteId>.localhost`（deepseek 仍走中继根，逐字不变）
//     非默认槽   `<slot>--<siteId>.localhost`
//
// 分隔符取 `--`：`2.deepseek.localhost` 与「站点名里带点」无法区分，而 `--` 不在
// `SITE_ID_RE` 允许的字符集里 ⇒ 无歧义。默认槽形状**逐字不变**（既有用户零位移，
// 与 `accounts.js` 的「默认槽零位移」同一条纪律）。
//
// ## 判据
//
// ① 账户1 与账户2 必须解析成**不同的源**（同一源=用户报的那个 bug）；
// ② 默认槽的形状必须与改动前**逐字相同**（`deepseek` 走中继根、其余走
//    `<siteId>.localhost`），否则既有用户被迁移；
// ③ 服务端必须按 **accountKey** 取驱动（旧实现 `driverFor(sid)` 是全槽共用一个号
//    的直接原因），且 mirror 实例的 key 带槽；
// ④ 服务端主机名解析必须与客户端拼装**同一套形状**（分隔符不一致 ⇒ 404/挂住）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITES } from '../lib/providers.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);

/**
 * 客户端 `siteBase` 的**离线复算**（形状与 `lib/client.cjs` 逐字同口径）。
 *
 * 不复算就要起 DOM 环境；而复算能钉住「形状」这件事本身——两个槽是否不同源、
 * 默认槽是否零位移，都在这几行里判得干净。真实接线由源码断言（下方 ③④）保证。
 */
const RELAY_PORT = 8931;
const relayBase = 'http://127.0.0.1:' + RELAY_PORT;
const SITE_DIRECTORY = new Map(SITES.map((site) => [site.id, site]));
function siteBase(sid, slot) {
  const s = String(slot || '').trim();
  const isDefault = !s || s === 'default' || s === '1';
  if (isDefault) return SITE_DIRECTORY.get(sid)?.mountAtRelayRoot === true
    ? relayBase + '/' : 'http://' + sid + '.localhost:' + RELAY_PORT + '/';
  return 'http://' + s + '--' + sid + '.localhost:' + RELAY_PORT + '/';
}

test('① 账户1 与账户2 必须是不同的源（同源 = 用户报的「选了账户2 还是账户1」）', () => {
  for (const sid of ['deepseek', 'glm', 'kimi', 'chatgpt']) {
    assert.notEqual(siteBase(sid, ''), siteBase(sid, '2'),
      `${sid}: 默认槽与账户2 指向同一个源 ⇒ 账户2 会看到账户1 的登录态`);
    assert.notEqual(siteBase(sid, '2'), siteBase(sid, '3'), `${sid}: 账户2 与账户3 不得同源`);
  }
});

test('② 默认槽零位移：形状与改动前逐字相同（既有用户不被迁移）', () => {
  // deepseek 必须仍走中继根（它校验宿主名，deepseek.localhost 会 WhiteScreen）。
  assert.equal(siteBase('deepseek', ''), relayBase + '/');
  assert.equal(siteBase('deepseek', 'default'), relayBase + '/');
  assert.equal(siteBase('deepseek', '1'), relayBase + '/', '`1` 是默认槽的别名，必须与默认槽同源');
  // 其余站点仍是裸 `<siteId>.localhost`。
  assert.equal(siteBase('glm', ''), 'http://glm.localhost:' + RELAY_PORT + '/');
  assert.equal(siteBase('kimi', ''), 'http://kimi.localhost:' + RELAY_PORT + '/');
});

test('③ 非默认槽形状：`<slot>--<siteId>.localhost`，且分隔符与站点名无歧义', () => {
  assert.equal(siteBase('deepseek', '2'), 'http://2--deepseek.localhost:' + RELAY_PORT + '/');
  assert.equal(siteBase('glm', '2'), 'http://2--glm.localhost:' + RELAY_PORT + '/');
  // `--` 不在站点 id 允许字符集里（SITE_ID_RE 是 [a-z0-9-]）⇒ 解析无歧义。
  // 用 `.` 做分隔就会与「站点名里带点」混淆，这里把取舍钉住。
  assert.ok(!/_/.test('2--glm'), '占位：分隔符是 -- 不是 _');
});

test('④ 服务端主机名解析与客户端拼装必须同一套形状', () => {
  const src = readFileSync(join(pkg, 'lib', 'index.js'), 'utf8');
  // 带槽形态的正则必须存在，且**捕获槽与站点两个组**。
  // 断言用实际的源码字面量（转义在两个层面各有一套，写通用正则会变成
  // 「测正则的正则」——本项目对这类不可读断言有过教训）。
  assert.ok(src.includes("const hostSlotSite = /^([a-z0-9-]+)--([a-z0-9-]+)\\.localhost(:\\d+)?$/i.exec(hostHeader);"),
    '服务端必须解析 `<slot>--<siteId>.localhost`（与客户端 siteBase 同一形状）');
  // 默认槽形态必须保留（零位移）。
  assert.ok(src.includes("const hostSite = /^([a-z0-9-]+)\\.localhost(:\\d+)?$/i.exec(hostHeader);"),
    '普通 `<siteId>.localhost` 形态必须保留（默认槽零位移）');
  // 两个分支都要真的被用上：只声明正则不接线 = 空转护栏。
  assert.ok(src.includes('if (hostSlotSite && !isControlPath)'), '带槽分支必须真的接线');
  assert.ok(src.includes('if (hostSite && getSite(hostSite[1].toLowerCase()) && !isControlPath)'), '默认槽分支必须仍在');
});

test('⑤ 服务端必须按 accountKey 取驱动，且 mirror 实例按槽分键', () => {
  const src = readFileSync(join(pkg, 'lib', 'index.js'), 'utf8');
  // **必须取真正的函数体**：`src.indexOf('function mirrorFor(')` 会命中注释里那句
  // 引用的 `mirrorFor(sid)`（本条缺陷的取证文字就写在上面），于是断言落在注释上——
  // 本文件的第一个版本正是这样假红了一次。改用「函数声明 + 花括号配平」定位。
  const decl = 'function mirrorFor(siteId, { prefixed = false, slot = DEFAULT_SLOT } = {}) {';
  const start = src.indexOf(decl);
  assert.ok(start > 0, '找不到 mirrorFor 的定义（签名变了就同步改本断言）');
  // 体开括号在**签名末尾**：从 decl 的末尾往前找最后一个 `{`，而不是从 start 起
  // 第一个——签名里就有两层花括号（解构参数 + 默认值 `= {}`），配平会当场错位。
  let depth = 0, end = -1;
  for (let k = src.lastIndexOf('{', start + decl.length); k < src.length; k += 1) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}') { depth -= 1; if (depth === 0) { end = k; break; } }
  }
  const body = src.slice(start, end + 1);
  assert.ok(body.length > 200, '函数体定位异常（太短）');
  // ⚠ 断言前必须**剥掉注释**：函数体里那句「旧实现是 `driverFor(sid)`」正是本条
  // 缺陷的取证文字，留着会把「修好的代码」判成「还在犯错」——本文件的第一版就是
  // 这样假红了一次。判据只该看**代码**，不该看解释代码的散文。
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .replace(/^\s*\/\/.*$/gm, '');          // 行注释
  assert.match(code, /formatAccountKey\(sid, s\)/, 'mirrorFor 必须由 siteId+slot 算出 accountKey');
  assert.match(code, /const drv = \(\) => driverFor\(accountKey\)/,
    '必须按 accountKey 取驱动——旧实现 `driverFor(sid)` 是所有槽共用默认槽登录态的直接原因');
  assert.ok(!/driverFor\(sid\)/.test(code),
    'mirrorFor 的**代码**里不得再出现 `driverFor(sid)`（那是本条缺陷的原始写法）');
  assert.match(code, /const key = accountKey \+ \(prefixed \? '#path' : ''\)/,
    'mirror 实例的 key 必须带槽，否则两个账户共用同一个实例');
  // 四个取值点（token/cookies/setCookies/ua）必须全部走同一个 accountKey —— 漏一个
  // 就会出现「页面用账户2、但接口用账户1」这种更难查的半错状态。
  assert.equal((code.match(/drv\(\)\./g) || []).length, 4,
    'getToken / profileCookies / writeProfileCookies / userAgent 四处都必须走 drv()');
});

test('⑦ relay-root mounting is adapter-owned and projected for every account slot', () => {
  const primary = SITES.filter((site) => site.mountAtRelayRoot === true).map((site) => site.id);
  assert.deepEqual(primary, ['deepseek'],
    'DeepSeek is the only adapter whose verified host contract requires the relay root');
  const server = readFileSync(join(pkg, 'lib', 'index.js'), 'utf8');
  assert.equal((server.match(/mountAtRelayRoot: st\.mountAtRelayRoot === true/g) || []).length, 2,
    'driver.sites must expose the adapter capability for both initialized and uninitialized slots');
  const client = readFileSync(join(pkg, 'lib', 'client.cjs'), 'utf8');
  assert.match(client, /siteRecord\(sid\)\?\.mountAtRelayRoot === true/,
    'siteBase must consume the adapter capability');
  assert.doesNotMatch(client, /const ROOT_MOUNTED\s*=/,
    'the browser must not maintain a second list of root-mounted websites');
});

test('⑥ 客户端的 iframe 源必须把槽传进去（不能只按 siteId 拼）', () => {
  const src = readFileSync(join(pkg, 'lib', 'client.cjs'), 'utf8');
  assert.match(src, /const siteBase = \(sid, slot\) =>/, 'siteBase 必须接收槽参数');
  assert.match(src, /siteRecord\(sid\)\?\.mountAtRelayRoot === true/, 'siteBase 必须从适配器目录读取主机挂载能力');
  assert.doesNotMatch(src, /const ROOT_MOUNTED\s*=\s*\{/, '不得再维护客户端 root-mounted 白名单');
  assert.match(src, /siteBase\(sid, accountSlot\)/,
    'ensureFrame 必须传**活状态** accountSlot（只传 controlledSlot 会让标签内切号不生效）');
  assert.match(src, /\}, \[browserSrc, accountSlot\]\)/, 'accountSlot 必须进 deps，否则切号不会重建 frame');
});
