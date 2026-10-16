// update.test.mjs — 更新判据的纯函数护栏（0.19.39；0.19.56 换数据源后重写）。
//
// 需求（用户原话）：「参考 dsh-store 的设置界面顶部……设计好本插件的更新和只做
// 提醒重启操作，替换现在空白的单独 github 按钮」；0.19.56 追加：「为什么没法做到
// 真正更新？——点击检查更新后不能自动拉取更新安装？」。
//
// 0.19.55 及之前更新源是 npm registry，但本项目**从不 publish**（release.yml 有
// 守卫强制）——真发布渠道是 GitHub Releases。数据源换成 Releases 后，这一层钉的
// 仍是**判据**：哪个版本算更新、资产怎么定位、URL 安不安全。它不碰网络也不碰
// 子进程，因此可以离线钉死。真下载/真安装（fetchReleases / downloadReleaseAsset /
// installLocalTarball）有副作用，由接线层与人工验证覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseVersion, compareVersions, pickLatest, assetForVersion, updateDecision,
  isSafeDownloadUrl, isSafeProfileName, installLocalTarball, PACKAGE_NAME, GITHUB_REPO,
} from '../lib/update.js';

/** 造一条 Releases API 形状的记录（只带本模块消费的字段）。 */
function rel(tag, { draft = false, prerelease = false, assets = [] } = {}) {
  return { tag_name: tag, draft, prerelease, assets };
}

// ---- parseVersion ---------------------------------------------------------

test('parseVersion：解析三段数字与预发布标记，畸形一律 null', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: '' });
  assert.deepEqual(parseVersion('v0.19.39'), { major: 0, minor: 19, patch: 39, prerelease: '' });
  assert.deepEqual(parseVersion('1.2.3-rc.1'), { major: 1, minor: 2, patch: 3, prerelease: 'rc.1' });
  // 构建元数据（+build）不参与比较，但**不该**让解析失败。
  assert.equal(parseVersion('1.2.3+build.5')?.patch, 3);
  for (const bad of ['', null, undefined, '1.2', '1.2.3.4', 'abc', 'latest', '^1.2.3']) {
    assert.equal(parseVersion(bad), null, bad + ' 应解析失败');
  }
});

// ---- compareVersions ------------------------------------------------------

test('compareVersions：三段数字逐段比，无法比较时返回 0（不猜）', () => {
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.3.0', '1.2.99'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  // 段数不同不是「更大」——必须真的按数字比，不能按字符串长度。
  assert.equal(compareVersions('0.19.9', '0.19.10'), -1);
  // 无法比较 ⇒ 0，而不是抛错或当成「更新」
  assert.equal(compareVersions('abc', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', null), 0);
});

test('compareVersions：正式版胜过同号预发布，两个预发布之间不分高下', () => {
  // 这条决定了「1.2.3 与 1.2.3-rc.1 谁该被装」——正式版必须赢。
  assert.equal(compareVersions('1.2.3', '1.2.3-rc.1'), 1);
  assert.equal(compareVersions('1.2.3-rc.1', '1.2.3'), -1);
  // 两个预发布之间返回 0：本模块不实现完整 semver 优先级，只说「不分高下」。
  assert.equal(compareVersions('1.2.3-rc.1', '1.2.3-rc.2'), 0);
});

// ---- pickLatest -----------------------------------------------------------

test('pickLatest：只认正式 release，预发布与草稿不进候选', () => {
  const releases = [
    rel('v2.0.0-rc.1', { prerelease: true }),
    rel('v1.1.0'),
    rel('v1.0.0', { draft: true }),
    rel('v0.9.0'),
  ];
  // 2.0.0-rc.1 是 prerelease、1.0.0 是 draft ⇒ 都不选；
  assert.equal(pickLatest(releases), '1.1.0');
});

test('pickLatest：tag 的 v 前缀被剥掉（对外报的版本号与 package.json 同形）', () => {
  assert.equal(pickLatest([rel('v0.19.55'), rel('v0.19.54')]), '0.19.55');
});

test('pickLatest：按版本号比，不按数组顺序（补发旧 tag 时不被顺序骗到）', () => {
  // GitHub 倒序里第一条是 v0.19.51，但版本号最大的是 v0.19.55。
  assert.equal(pickLatest([rel('v0.19.51'), rel('v0.19.55'), rel('v0.19.54')]), '0.19.55');
});

test('pickLatest：全部不可用时回落数组第一条可解析 tag，仍不冒充「没有更新」', () => {
  assert.equal(pickLatest([rel('v1.0.0-rc.3'), rel('v1.0.0-rc.1')]), '1.0.0-rc.3');
});

test('pickLatest：畸形响应一律 null（不抛）', () => {
  for (const bad of [null, undefined, {}, [], 'nope', [null, 'x', {}]]) {
    assert.equal(pickLatest(bad), null);
  }
});

// ---- assetForVersion ------------------------------------------------------

test('assetForVersion：按命名规则定位 <包名>-<版本>.tgz，返回下载地址', () => {
  const releases = [
    rel('v0.19.55', { assets: [{ name: 'dsh-webcode-bridge-0.19.55.tgz', browser_download_url: 'https://github.com/RSLN-creator/dsh-web-bridge/releases/download/v0.19.55/dsh-webcode-bridge-0.19.55.tgz' }] }),
    rel('v0.19.54', { assets: [{ name: 'dsh-webcode-bridge-0.19.54.tgz', browser_download_url: 'https://github.com/RSLN-creator/dsh-web-bridge/releases/download/v0.19.54/dsh-webcode-bridge-0.19.54.tgz' }] }),
  ];
  const a = assetForVersion(releases, '0.19.55');
  assert.equal(a.name, 'dsh-webcode-bridge-0.19.55.tgz');
  assert.match(a.url, /^https:\/\/github\.com\//);
  // 不带 v 前缀 / 带 v 前缀都能命中同一条
  assert.equal(assetForVersion(releases, 'v0.19.54')?.name, 'dsh-webcode-bridge-0.19.54.tgz');
});

test('assetForVersion：资产缺失或域名不对时返回 null（不给未校验的 URL）', () => {
  // 版本命中但没有 assets
  assert.equal(assetForVersion([rel('v0.19.55')], '0.19.55'), null);
  // 资产在，但下载域是陌生域（外部数据不可信）
  const evil = [rel('v0.19.55', { assets: [{ name: 'dsh-webcode-bridge-0.19.55.tgz', browser_download_url: 'https://evil.example/x.tgz' }] })];
  assert.equal(assetForVersion(evil, '0.19.55'), null);
  // 版本号本身解析失败
  assert.equal(assetForVersion([rel('v0.19.55')], 'abc'), null);
  // 显式点名预发布允许命中（降级/内测场景），前提是资产齐全
  const pre = [rel('v1.0.0-rc.1', { prerelease: true, assets: [{ name: 'dsh-webcode-bridge-1.0.0-rc.1.tgz', browser_download_url: 'https://github.com/r/r/dsh-webcode-bridge-1.0.0-rc.1.tgz' }] })];
  assert.equal(assetForVersion(pre, '1.0.0-rc.1')?.name, 'dsh-webcode-bridge-1.0.0-rc.1.tgz');
});

// ---- updateDecision -------------------------------------------------------

test('updateDecision：有新版 → outdated，带上 latest 与 asset', () => {
  const releases = [
    rel('v0.19.56', { assets: [{ name: 'dsh-webcode-bridge-0.19.56.tgz', browser_download_url: 'https://github.com/r/r/dsh-webcode-bridge-0.19.56.tgz' }] }),
    rel('v0.19.55'),
  ];
  const d = updateDecision({ current: '0.19.55', releases });
  assert.equal(d.status, 'outdated');
  assert.equal(d.current, '0.19.55');
  assert.equal(d.latest, '0.19.56');
  assert.equal(d.asset.name, 'dsh-webcode-bridge-0.19.56.tgz');
});

test('updateDecision：同版 → current（不提示更新）', () => {
  const d = updateDecision({ current: '0.19.55', releases: [rel('v0.19.55'), rel('v0.19.54')] });
  assert.equal(d.status, 'current');
});

test('updateDecision：本地版本比 Releases 新 → current，不提示「有更新」', () => {
  // 本地 tgz 比 Releases 新是**真实存在**的状态（本项目常年在工作树里跑）。
  // 那时提示「更新到更旧的版本」是错的。
  const d = updateDecision({ current: '0.19.56', releases: [rel('v0.19.55')] });
  assert.equal(d.status, 'current');
});

test('updateDecision：最新版没有 tarball 资产 → unknown（说得出「有新版但装不了」）', () => {
  // 把「有新版」说成「current」是假陈述；「outdated 却没有 asset」会在安装时
  // 才爆炸——所以判据层就把它定为 unknown 并给出原因。
  const d = updateDecision({ current: '0.19.55', releases: [rel('v0.19.56')] });
  assert.equal(d.status, 'unknown');
  assert.match(d.reason, /tarball 资产缺失/);
});

test('updateDecision：查不到 → unknown，**不是** current（不把没查到说成已是最新）', () => {
  const a = updateDecision({ current: '0.19.55', error: 'HTTP 502' });
  assert.equal(a.status, 'unknown');
  assert.match(a.reason, /502/);
  const b = updateDecision({ current: '0.19.55', releases: [] });
  assert.equal(b.status, 'unknown');
  // 当前版本本身不可解析也是 unknown —— 没有「可比较的两端」就没有结论。
  const c = updateDecision({ current: 'dev', releases: [rel('v1.0.0')] });
  assert.equal(c.status, 'unknown');
});

// ---- isSafeDownloadUrl ----------------------------------------------------

test('isSafeDownloadUrl：只放行 Releases 资产的真实下载域，http 与陌生域一律拒绝', () => {
  for (const good of [
    'https://github.com/RSLN-creator/dsh-web-bridge/releases/download/v0.19.55/dsh-webcode-bridge-0.19.55.tgz',
    'https://objects.githubusercontent.com/SIGNED-URL/x.tgz',
    'https://release-assets.githubusercontent.com/SIGNED-URL/x.tgz',
  ]) assert.equal(isSafeDownloadUrl(good), true, good);
  for (const bad of [
    'http://github.com/r/r/x.tgz',                      // 明文 http
    'https://evil.example/x.tgz',                       // 陌生域
    'https://github.com.evil.example/x.tgz',            // 伪装子域（hostname 不等于 github.com）
    'ftp://github.com/x.tgz',                           // 非 http(s) 协议
    'not a url', '', null, undefined, 'javascript:alert(1)',
  ]) assert.equal(isSafeDownloadUrl(bad), false, String(bad));
});

// ---- 常量 -----------------------------------------------------------------

test('包名与发布仓库可核对（改了任何一个，更新就指向了别处）', () => {
  assert.equal(PACKAGE_NAME, 'dsh-webcode-bridge');
  assert.equal(GITHUB_REPO, 'RSLN-creator/dsh-web-bridge');
});

// ---- isSafeProfileName（0.19.92 新增的命令注入防护） -----------------------

test('isSafeProfileName：合法 profile 放行，shell 元字符/空值/超长一律拒绝', () => {
  for (const good of ['web', 'headless', 'desktop', 'my-profile_2']) {
    assert.equal(isSafeProfileName(good), true, good);
  }
  for (const bad of [
    '', ' ', null, undefined,            // 空值
    'web; rm -rf /', 'web && calc', 'web|cat', 'web$(whoami)', 'web`id`',
    'web /tmp', 'web\tx', 'web\nx',       // shell 元字符
    'WEB', 'Web', 'web name',             // 大写 / 空格
    'a'.repeat(33),                       // 超长
    'web;dsh', '--profile', '-x',         // 以 - 开头 / 注入额外参数
  ]) assert.equal(isSafeProfileName(bad), false, JSON.stringify(bad));
});

test('installLocalTarball：非法 profile 在 spawn 之前被拒，不进入命令拼接', async () => {
  // 造一个存在的临时文件，确保它走到 profile 校验这一支（而不是「文件不存在」提前返回）。
  const tmp = path.join(os.tmpdir(), 'webcode-update-guard-' + process.pid + '.tgz');
  fs.writeFileSync(tmp, 'x');
  try {
    const r = await installLocalTarball({ profile: 'web; rm -rf /', file: tmp, timeoutMs: 1000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /profile 名不合法/);
    assert.equal(r.needsRestart, false);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});
