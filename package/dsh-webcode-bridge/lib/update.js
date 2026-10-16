// update.js — 本插件「检查更新 / 下载 / 安装 / 重启提醒」的逻辑层（0.19.56）。
//
// 需求（用户原话）：「参考 dsh-store 的设置界面顶部『插件市场 / dsh-market /
// v1.65.1 / 更新插件市场 / 本次全部忽略』设计好本插件的更新和只做提醒重启操作，
// 替换现在空白的单独 github 按钮」；0.19.56 追加：「为什么没法做到真正更新？
// 点击检查更新后不能自动拉取更新安装？已经现在设置默认启动时候检查一次更新吧」。
//
// ## 0.19.56：更新源从 npm registry 换成 GitHub Releases（真缺陷修复）
//
// 0.19.39–0.19.55 的检查与安装**全都对着 npm registry**，但本项目的发布事实是
// 另一回事（两处都能机器核实，2026-10-03 实测）：
//
//   · `.github/workflows/release.yml` 文件头写着「绝不 publish 到任何 registry」，
//     且末步有一条守卫：工作流里出现 `npm publish`/`pnpm publish` 即构建失败；
//   · registry 上最新是 **0.19.51**（2026-09-29 发布，手工发布的那次），
//     而 GitHub Releases 上 v0.19.54 / v0.19.55 的 tgz 已挂好（CI 产物）。
//
// 于是本地 0.19.55 ≥ registry 0.19.51 ⇒ `updateDecision` 永远回答 `current`，
// 「检查更新」按钮永远没有可装的东西——这不是按钮坏，是**更新源指错了地方**。
// 修法就是把两边都搬到唯一真实的发布渠道：GitHub Releases（`gh release upload`
// 的产物，release.yml 每次打 tag 自动产出并校验过 sha256）。
//
// ## 三个设计决定，各有理由
//
// 1. **只提醒重启，绝不代重启**。「装完不重启 dsh web = 等于没装」是本项目反复
//    记录过的一条事实（README 与 doc/progress.md 都写着）。但重启 dsh web 会
//    终止正在跑的会话——而那正是用户此刻在用的东西。所以装完之后给的是**一句
//    提醒**，不是一次自动重启。这是「只做提醒重启操作」的字面含义。
//
// 2. **检查与安装分离，检查是纯只读**。检查 = 一次 GET（Releases API，匿名可读），
//    装 = 下载 tgz + 一次真的进程调用。两者失败面完全不同，因此分开两个动作：
//    查不到就说查不到（不假装「已是最新」），装失败就报退出码与 stderr 片段。
//
// 3. **纯判据与副作用分离**。版本解析/比较/挑最新版/资产定位全是纯函数（可离线
//    反向验证，见 test/update.test.mjs）；碰网络与子进程的只有 `fetchReleases` /
//    `downloadReleaseAsset` / `installFromRelease` 三个入口。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 本插件的包名（tarball 资产名与安装日志都用它，写一处避免两处漂移）。 */
export const PACKAGE_NAME = 'dsh-webcode-bridge';

/** 发布仓库（release.yml 的发布目标；写死而不是读 package.json——安装时进程里就有它）。 */
export const GITHUB_REPO = 'RSLN-creator/dsh-web-bridge';

/**
 * Releases API 基址。可用 WEBCODE_RELEASES_API 覆盖（代理/内网镜像场景），
 * 覆盖值必须是 http(s) URL，且仍要过 `isSafeDownloadUrl` 的下载域白名单。
 */
export const RELEASES_API = process.env.WEBCODE_RELEASES_API || 'https://api.github.com';

/**
 * 下载 URL 白名单：Releases 资产的真实下载地址只会落在这几个域。
 *
 * 资产 URL 来自 API 响应（外部数据），**不**直接信任整条 URL——只允许这两个域
 * （`github.com` 的直链 302 到 `objects.githubusercontent.com`，fetch 会跟着走），
 * 响应里被塞进任意域的 URL 在这里被拒。判定是纯函数，可离线反向验证。
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isSafeDownloadUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'https:') return false;
    return ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']
      .includes(u.hostname.toLowerCase());
  } catch { return false; }
}

/**
 * 把一个 semver 字符串解析成可比较的三段数字 + 预发布标记。
 *
 * 为什么自己写而不引 semver 包：本插件**零运行时依赖**（只有 playwright-core），
 * 而这里需要的比较规则很窄——「谁是更新的正式版」。引一个包来回答这一个问题，
 * 换来的是一份供应链面。
 *
 * 预发布（`1.2.3-rc.1`）**不参与**「谁更新」的比较：`1.2.3-rc.1` 与 `1.2.3` 的
 * 数字段相同，而正式版应当胜过同号的预发布。因此预发布标记只用来**排除**候选
 *（见 pickLatest），不用来排序——这比实现完整的 semver 优先级规则更不容易出错。
 *
 * @param {string} v
 * @returns {{major:number,minor:number,patch:number,prerelease:string}|null} 解析失败返回 null
 */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] || '' };
}

/**
 * 比较两个版本号。
 *
 * @returns {number} a>b → 1，a<b → -1，相等或无法比较 → 0
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;   // 无法比较时**不猜**：返回 0 表示「不分高下」
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  // 数字段相同：正式版 > 预发布版；两个预发布之间不排序（返回 0）。
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  return 0;
}

/**
 * 从 Releases 响应（数组）里挑出**最新的正式版**的版本号。
 *
 * 输入是 `GET /repos/:repo/releases` 的响应体：一个 release 对象数组，每条带
 * `tag_name` / `prerelease` / `draft` / `assets`。GitHub 按创建时间倒序返回，
 * 但「最新发布的」不等于「版本号最大的」（补发旧版本 tag 时会错位），因此仍按
 * 版本号比，不按数组顺序取第一条。
 *
 * 与旧 npm 版 `pickLatest` 相同的三条纪律：
 *   · 预发布（`prerelease: true`）与草稿不参与「谁最新」——正式版应当胜出；
 *   · 版本号解析失败的条目跳过，不抛（外部数据不可信）；
 *   · 全被过滤光时回落**数组第一条**（GitHub 倒序里它就是最近一次发布），
 *     而不是回答「没有更新」——把「有得装」说成「没得装」是本项目记过的假陈述。
 *
 * @param {unknown} releases Releases API 的响应体（期望数组）
 * @returns {string|null}
 */
export function pickLatest(releases) {
  const list = Array.isArray(releases) ? releases : [];
  let best = null;
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    if (r.draft === true || r.prerelease === true) continue;
    const v = parseVersion(r.tag_name);
    if (!v) continue;
    if (best === null || compareVersions(r.tag_name, best) > 0) best = String(r.tag_name);
  }
  if (best) return best.replace(/^v/, '');
  const first = list.find((r) => r && parseVersion(r?.tag_name));
  const tag = first ? String(first.tag_name) : '';
  return parseVersion(tag) ? tag.replace(/^v/, '') : null;
}

/**
 * 从 Releases 响应里定位某个版本的 tgz 资产。
 *
 * 两种用法都走这里：`updateDecision` 给「最新版」定位资产；POST update 的显式
 * 版本号（含降级安装）按版本精确匹配。判据：
 *   · release 的 tag 解析出的版本**逐字等于**请求版本（`v0.19.56` ≡ `0.19.56`）；
 *   · 该 release 的 assets 里存在 `<PACKAGE_NAME>-<版本>.tgz`（release.yml 的
 *     命名规则），并返回它的下载地址；
 *   · 预发布只允许**显式点名**安装（自动检查永远只给正式版）。
 *
 * @param {unknown} releases Releases API 的响应体
 * @param {string} version 期望版本号（不带 v 前缀也算命中）
 * @returns {{name:string,url:string}|null}
 */
export function assetForVersion(releases, version) {
  const want = parseVersion(version);
  if (!want) return null;
  const list = Array.isArray(releases) ? releases : [];
  for (const r of list) {
    if (!r || typeof r !== 'object' || r.draft === true) continue;
    const v = parseVersion(r.tag_name);
    if (!v
      || v.major !== want.major || v.minor !== want.minor || v.patch !== want.patch
      || v.prerelease !== want.prerelease) continue;
    const name = PACKAGE_NAME + '-' + String(version).replace(/^v/, '') + '.tgz';
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const asset = assets.find((a) => a && a.name === name && typeof a.browser_download_url === 'string');
    if (asset && isSafeDownloadUrl(asset.browser_download_url)) {
      return { name, url: String(asset.browser_download_url) };
    }
    return null;   // 版本命中但资产缺失/域不对：宁可 null 也不给一条未校验的 URL
  }
  return null;
}

/**
 * 判据：当前版本 vs Releases 上的最新正式版。
 *
 * 返回的 `status` 只有三种，每种对应一句**可以说出来的话**：
 *   · `current`  —— 已是最新（或当前版本比 Releases 还新，本地 tgz 场景很常见）
 *   · `outdated` —— 有新版，给出 latest 与它的 tgz 资产（`asset`，安装用）
 *   · `unknown`  —— 查不到（网络失败/仓库不存在/版本号不可解析）
 * `unknown` **不是** `current`：把「没查到」说成「已是最新」是本项目反复记过的
 * 假陈述。调用方据此显示的是「检查失败」而不是一个绿色的「已是最新」。
 *
 * @param {{current?:string, releases?:unknown, error?:string}} o
 * @returns {{status:'current'|'outdated'|'unknown', current:string, latest:string|null, asset?:{name:string,url:string}, reason?:string}}
 */
export function updateDecision({ current, releases, error } = {}) {
  const cur = String(current || '').trim();
  if (!parseVersion(cur)) return { status: 'unknown', current: cur, latest: null, reason: '当前版本号无法解析' };
  if (error) return { status: 'unknown', current: cur, latest: null, reason: String(error).slice(0, 160) };
  const latest = pickLatest(releases);
  if (!latest) return { status: 'unknown', current: cur, latest: null, reason: 'Releases 上没有可用的正式版' };
  // compareVersions > 0 才算「有新版」：等于不算，更**新**的当前版也不算
  //（本地 tgz 比 Releases 新是真实存在的状态，那时不该提示「有更新」）。
  if (compareVersions(latest, cur) > 0) {
    const asset = assetForVersion(releases, latest);
    return asset
      ? { status: 'outdated', current: cur, latest, asset }
      : { status: 'unknown', current: cur, latest, reason: '最新版 ' + latest + ' 的 tarball 资产缺失' };
  }
  return { status: 'current', current: cur, latest };
}

/**
 * 到 Releases API 取发布清单（只读 GET，匿名可读）。
 *
 * 超时**必须**有：API 不可达时，设置页不该卡在一次等待里。8 秒与旧 npm 检查
 * 同一个取中：足够慢的网络也能回，用户也不会以为界面坏了。
 *
 * @param {{repo?:string, base?:string, timeoutMs?:number}} o
 * @returns {Promise<{ok:boolean, releases?:Array<object>, error?:string}>}
 */
export async function fetchReleases({ repo = GITHUB_REPO, base = RELEASES_API, timeoutMs = 8000 } = {}) {
  const root = String(base || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(root)) return { ok: false, error: 'Releases API 地址不是 http(s)：' + root };
  const url = root + '/repos/' + repo + '/releases?per_page=30';
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': PACKAGE_NAME },
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 8000)),
    });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const body = await res.json();
    if (!Array.isArray(body)) return { ok: false, error: 'Releases 响应不是数组' };
    return { ok: true, releases: body };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * 把一个 release 资产下载到临时目录，返回本地 tgz 路径。
 *
 * 为什么落到临时目录再装、而不是把 URL 直接交给 dsh：`dsh plugin add <spec>`
 * 对 `https://…` 形态的支持没有契约背书，而「本地 tarball」是 README 写明的
 * 安装形态——下载这一步自己做，安装命令就永远走在被验证过的那条路上。
 *
 * 下载用全局 fetch（Node 22 内置），写入用 fs；临时目录固定放在 os.tmpdir()
 * 的自有前缀下，装完（无论成败）由调用方负责清理。
 *
 * @param {{url:string, name:string, timeoutMs?:number, dir?:string}} o
 * @returns {Promise<{ok:boolean, file?:string, bytes?:number, error?:string}>}
 */
export async function downloadReleaseAsset({ url, name, timeoutMs = 120000, dir = null } = {}) {
  if (!isSafeDownloadUrl(url)) return { ok: false, error: '下载地址不在允许的域内：' + String(url).slice(0, 120) };
  const target = path.join(
    dir || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-webcode-bridge-update-')),
    name || 'release.tgz',
  );
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': PACKAGE_NAME, accept: 'application/octet-stream' },
      signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || 120000)),
    });
    if (!res.ok) return { ok: false, error: '下载失败：HTTP ' + res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) return { ok: false, error: '下载内容过小（' + buf.length + 'B），不像 tarball' };
    fs.writeFileSync(target, buf);
    return { ok: true, file: target, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * profile 名白名单：合法 profile 是 `web` / `headless` 这类短小写标识符。
 *
 * 它会被拼进 `dsh plugin --profile <profile> add …` 命令行（Windows 上 `shell:true`），
 * 因此**必须在拼接前拒绝**一切 shell 元字符——`;`、`&`、空格、引号、`$()` 都不许出现。
 * 此前这里直接 `String(profile)` 拼进去，是一个真实的命令注入面：本机进程经
 * `POST /__webcode/update` 传入 `profile`（`web-control.js` 只做了 `trim`），
 * 带分号的值会在这台机器上以当前用户身份执行任意命令（见 doc/security-review.md §6.3.1
 * 「本机进程可直连 127.0.0.1」）。
 *
 * @param {string} p 待校验的 profile 名
 * @returns {boolean}
 */
export function isSafeProfileName(p) {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(String(p || ''));
}

/**
 * 真的执行一次安装：`dsh plugin --profile <p> add <本地 tgz 绝对路径>`。
 *
 * 为什么用 `dsh` 而不是直接 `pnpm add`：profile 的依赖与 bundles 声明由 dsh 自己
 * 维护（它还会写 package.json 与 lockfile）。绕过它直接动 node_modules，会让
 * 「声明」与「实装」分家——而本项目刚在 0.19.x 反复处理过这种不一致。
 *
 * 为什么传入的是**本地文件路径**而不是 registry spec：0.19.55 前传的是包名
 * （`dsh plugin add dsh-webcode-bridge` ⇒ npm registry），那正是「永远装不到新
 * 版」的根因（见文件头）。现在装的就是从 Releases 下载的那份 tgz。
 *
 * 为什么返回 `needsRestart` 而不是自己重启：见文件头第 1 条。装完**必然**要重启
 * 才生效（这是本项目的第一号踩坑），但重启会杀会话，所以只提醒。
 *
 * @param {{profile?:string, file?:string, timeoutMs?:number}} o
 * @returns {Promise<{ok:boolean, output?:string, error?:string, needsRestart:boolean, command:string}>}
 */
export function installLocalTarball({ profile = 'web', file = '', timeoutMs = 300000 } = {}) {
  const spec = String(file || '');
  if (!spec || !fs.existsSync(spec)) {
    return Promise.resolve({ ok: false, error: '本地 tarball 不存在：' + spec, needsRestart: false, command: '' });
  }
  const profileName = String(profile || 'web');
  if (!isSafeProfileName(profileName)) {
    return Promise.resolve({ ok: false, error: 'profile 名不合法：' + profileName.slice(0, 40), needsRestart: false, command: '' });
  }
  const args = ['plugin', '--profile', profileName, 'add', spec];
  const command = 'dsh ' + args.join(' ');
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve({ needsRestart: true, command, ...v }); } };
    let child;
    try {
      // Windows 上 `dsh` 是 .cmd/.ps1 脚本，必须 shell:true 才找得到；路径里的
      // 空格由我们手工加引号（shell:true 下 node 不替数组参数加引号）。
      child = process.platform === 'win32'
        ? spawn('dsh ' + args.slice(0, -1).join(' ') + ' "' + spec + '"', { shell: true, windowsHide: true })
        : spawn('dsh', args, { windowsHide: true });
    } catch (e) {
      return done({ ok: false, error: String(e?.message || e) });
    }
    let out = '';
    const cap = (buf) => { if (out.length < 8000) out += String(buf); };
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      done({ ok: false, error: '安装超时（' + Math.round(timeoutMs / 1000) + 's）', output: out.slice(-2000) });
    }, Math.max(10000, Number(timeoutMs) || 300000));
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: String(e?.message || e), output: out.slice(-2000) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 退出码是唯一判据：不看输出里有没有「error」字样（那会误判警告）。
      done(code === 0
        ? { ok: true, output: out.slice(-2000) }
        : { ok: false, error: 'dsh 退出码 ' + code, output: out.slice(-2000) });
    });
  });
}

/**
 * 一条龙：定位资产 → 下载 → 安装。控制面 `POST update` 的实现体。
 *
 * 每一步失败都如实带原因返回；临时目录在 finally 里清理（best-effort，
 * 清理失败只 warn 不影响结果——它就在 os.tmpdir() 里，系统迟早会收走）。
 *
 * @param {{releases?:Array<object>, version?:string, profile?:string, current?:string}} o
 * @returns {Promise<{ok:boolean, error?:string, output?:string, needsRestart:boolean, command:string, spec?:string, bytes?:number}>}
 */
export async function installFromReleases({ releases = null, version = '', profile = 'web', current = '' } = {}) {
  const list = Array.isArray(releases) ? releases : [];
  let asset = null;
  let spec = '';
  if (version) {
    asset = assetForVersion(list, version);
    spec = PACKAGE_NAME + '@' + version;
    if (!asset) return { ok: false, error: 'Releases 上找不到 ' + version + ' 的 tarball', needsRestart: false, command: '', spec };
  } else {
    const decision = updateDecision({ current, releases: list });
    if (decision.status !== 'outdated' || !decision.asset) {
      return {
        ok: false,
        noUpdate: true,
        error: decision.status === 'current'
          ? '已是最新（v' + decision.current + '）'
          : (decision.reason || '检查更新失败'),
        needsRestart: false,
        command: '',
      };
    }
    asset = decision.asset;
    spec = PACKAGE_NAME + '@' + decision.latest;
  }
  const dl = await downloadReleaseAsset({ url: asset.url, name: asset.name });
  if (!dl.ok) return { ok: false, error: dl.error, needsRestart: false, command: '', spec };
  try {
    const r = await installLocalTarball({ profile, file: dl.file });
    return { ...r, spec, bytes: dl.bytes };
  } finally {
    try { fs.rmSync(path.dirname(dl.file), { recursive: true, force: true }); } catch { /* 临时目录，清理失败不阻塞 */ }
  }
}
