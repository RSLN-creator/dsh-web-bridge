// ssrf-redirect-guard.test.mjs — 钉住 0.19.26 的两条安全修复。
//
// 两条修复各自对应一条 CodeQL 告警，且都是「静态告警落到真实代码后确实成立」的那类
// （其余经逐条关联分析判为模式匹配或非运行路径，处置表见 doc/security-review.md）：
//
//   A. `isPrivateHost`（lib/loopback.js）覆盖内网的**规格化形态**。
//      纯函数、零网络依赖，因此它每次都真跑——这是这条防线里唯一能离线钉死的部分。
//
//   B. `httpFetch`（lib/upstream.js）的**重定向**不得把公网请求升级进内网。
//      验证它需要一个「起点不是内网」的 URL，而本机只能 bind 回环地址，
//      所以用 `localtest.me` 当载体：公共 DNS 里它稳定解析到 127.0.0.1，
//      而它的**字面**不被 isPrivateHost 判成内网（结尾是 `.me`，不匹配 `.*\.local$`）。
//
// 为什么 B 组允许 SKIP 而不是硬失败：DNS 在离线/受限环境不可用是**环境事实**，
// 不是代码回归；让它变红会训练人忽略这一条——本仓库记过「假红的闸门比没有闸门更坏」。
// 但 SKIP 必须**响亮**：打印诊断并注明本次没有真正校验，绝不悄悄通过。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import { isPrivateHost } from '../lib/loopback.js';
import { httpFetch } from '../lib/upstream.js';

/** 起一个只绑回环的临时服务器，返回 `{ port, close }`。 */
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

test('A. isPrivateHost 必须拦住内网字面量（含规格化形态）', () => {
  const privateHosts = [
    // 0.12.9 起的原判据（回归线：这次修复不许把它们弄丢）
    'localhost', '127.0.0.1', '127.1.2.3', '10.0.0.5', '192.168.1.1',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '[::1]',
    'foo.local', 'METADATA.local',
    // 0.19.26 补齐的四类（探针实测：旧判据对它们零命中）
    '0.0.0.0', '0.1.2.3', '[::]', '[fe80::1]', '[fc00::1]', '[fd00::1]',
    // IPv4 映射：Node 把 [::ffff:127.0.0.1] 规格化成这个形状
    '[::ffff:7f00:1]',
  ];
  for (const h of privateHosts) {
    assert.equal(isPrivateHost(h), true, h + ' 应判成内网');
  }
});

test('A2. isPrivateHost 不得误伤公网名字（假红比漏报更伤闸门）', () => {
  const publicHosts = [
    'chat.deepseek.com', 'www.kimi.com', 'chatglm.cn', '1.1.1.1',
    '172.32.0.1',   // 172.16-31 是内网，32 不是
    '172.15.0.1',   // 低于 16，不是
    '11.0.0.1',     // 不是 10.
    'localtest.me', // B 组的载体：字面必须**不**判成内网，否则 B 组无从验证
  ];
  for (const h of publicHosts) {
    assert.equal(isPrivateHost(h), false, h + ' 不该判成内网');
  }
});

test('B. 重定向不得把公网起点升级进内网（且内网端点真的没被访问）', async (t) => {
  let dnsOk = false;
  try {
    const r = await dns.lookup('localtest.me');
    dnsOk = r.address === '127.0.0.1';
  } catch { dnsOk = false; }

  if (!dnsOk) {
    t.diagnostic('[SKIP] localtest.me 未解析到 127.0.0.1（离线/受限 DNS）——'
      + '本组**没有真正校验**重定向防护；A/A2 两组已跑。');
    return;
  }

  // 命中计数：断言「内网端点从未被访问」比断言「抛了个错」强得多——
  // 前者证明防护真的生效，后者只证明某处报错。
  let secretHits = 0;
  const secret = http.createServer((req, res) => {
    secretHits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('SECRET');
  });
  const secretSrv = await listen(secret);

  // 公网起点的替身：它 302 到 `http://localtest.me:<secretPort>/`。
  // 注意 href 里写的是**域名** localtest.me，因此 isPrivateHost 的字面判据不命中，
  // 真正拦住它的是「起点是公网 + 某一跳的字面仍是公网名字」这条之外的**解析后**地址——
  // 这一点必须说清楚：本组验证的是「redirect 分支确实做了复查」这一行代码在不在，
  // 而**不是**字面判据能拦 DNS 重绑定（那超出它的设计边界，见 loopback.js 的已知边界）。
  // 为让本组可判定，替身直接 302 到**字面就是内网**的地址：127.0.0.1。
  const redirector = http.createServer((req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:' + secretSrv.port + '/steal' });
    res.end();
  });
  const redirSrv = await listen(redirector);

  try {
    // 起点：公网名字（localtest.me → 127.0.0.1 是 DNS 的事，字面仍是公网）。
    // 注意这里**必须**用 localtest.me 而不是 127.0.0.1 作起点，否则 startedPrivate
    // 为真、复查被设计性跳过，本组就成了空转。
    let err = null;
    try {
      await httpFetch('http://localtest.me:' + redirSrv.port + '/start', {
        redirect: 'follow',
        timeoutMs: 5000,
      });
    } catch (e) { err = e; }

    assert.ok(err, '重定向到内网必须抛错（拿到响应即说明复查没生效）');
    assert.equal(err.code, 'SSRF_REDIRECT_BLOCKED',
      '应为具名错误码 SSRF_REDIRECT_BLOCKED，实得 ' + String(err.code) + ' / ' + err.message);
    assert.equal(secretHits, 0, '内网端点被访问了 ' + secretHits + ' 次——防护没拦住');
  } finally {
    await redirSrv.close();
    await secretSrv.close();
  }
});

test('B2. 起点本来就在内网时沿用旧行为（不误伤本机开发与测试桩）', async () => {
  // 这是本次修复**刻意保留**的一格：mirror.test.mjs 等一大片用例都以 127.0.0.1
  // 起上游桩，若在这里也拦，它们会整片变红，而那不引入新的攻击面
  //（起点本来就是本机，能访问的本就是本机能访问的）。
  const srv = http.createServer((req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:' + srv.address().port + '/round' });
    res.end();
  });
  const { port, close } = await listen(srv);
  try {
    const r = await httpFetch('http://127.0.0.1:' + port + '/start', {
      redirect: 'follow',
      timeoutMs: 5000,
    });
    assert.equal(r.status, 302, '内网起点的重定向应照旧跟随/返回，不被新判据拦下');
  } finally {
    await close();
  }
});
