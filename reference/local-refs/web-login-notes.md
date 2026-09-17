# web-login 参考源（三份第三方「登录门」插件的对照）

**这份文件是入库的**（`reference/local-refs/` 是 `reference/*/` 规则唯一的例外，见 `reference/README.md` §2）。
被参考的源码本身**不入库**（`reference/web-login/` 已被 `.gitignore:9` 排除）。

## 一、为什么在这里

用户要求：「另外请你单独新增 web-login 插件放入参考文件夹」。按本仓库既有约定
（`reference/README.md` §2「每个条目 = 纯净第三方源码，不入库；结论写进 local-refs/」），
落地方式是：**把第三方实现原样放进来做对照，把可借鉴的结论写成本文件**。

采集时间 2026-09-17。取法与 `dsh-task-board` 同一条路（npm 包解包，不是 git clone）：

```powershell
$meta = Invoke-RestMethod "https://registry.npmjs.org/<pkg>"
Invoke-WebRequest $meta.versions.$($meta.'dist-tags'.latest).dist.tarball -OutFile reference/web-login/<name>.tgz
node .tmp/extract-web-login.mjs     # 走 scripts/tar.mjs 的纯 Node 解档，不 spawn 系统 tar
```

> 本机 `git clone https://github.com/...` 会因 `OpenSSL verify result: unable to get local
> issuer certificate` 失败；可用 `git -c http.sslVerify=false …`（`doc/verify.md` 同一条口径）。
> npm registry 直连正常。

## 二、三份来源与它们的认证模型（实测读源码，不是读简介）

| 目录 | 包 | 版本 | 大小 | 认证模型 |
| --- | --- | --- | --- | --- |
| `dsh-login/` | `dsh-login` | 0.1.1 | 21 KB | **口令门**：用户名+口令，`salted + scrypt` 哈希、AES-256-GCM 加密后落在 `$DSH_HOME` 下的本地配置文件；**host-only 插件**，不改 dsh 源码 |
| `islibaodong-dsh-login/` | `@islibaodong/dsh-login` | 0.2.1 | 133 KB | **多用户网关**：首访 `/login` 建管理员，账号进 DSH credentials（`DSH_LOGIN_PASSWORD_USERS`），设置页有「用户管理」面板 |
| `dsh-auth-gate/` | `dsh-auth-gate` | 0.13.0 | 242 KB | **应用层认证门**：口令 + TOTP、挑战 cookie、限流、`deploy/` 下给 systemd/反代示例；自带工程规范（`npm run verify`、bundle/slice 检查） |

各包 SHA256 前 16 位（可复核）：`dsh-login` = `0628C3B54A37B63C`、
`@islibaodong/dsh-login` = `8D5329609FDEA8EE`、`dsh-auth-gate` = `9EA7452C97BC971E`。

## 三、三个直接可借鉴的点（有代码位置）

1. **`dsh-web` 的 webserver 没有中间件缝**（`dsh-login/lib/index.js` 顶部注释原话：
   「dsh-web's webserver (dsh-host-webserver) has no middleware seam」）。
   它的解法是**包裹路由注册面**：mount 时把已存在的路由表重新包一遍、以后的注册也边走边包。
   ⇒ 与我们的 `lib/mirror.js`/`lib/web-control.js` 同一条思路，但**我们该继续用
   `webServer.register` 的正规挂载**，不要走到包路由这一层。
2. **凭据落 DSH credentials 而不是自建文件**（`@islibaodong/dsh-login`：账号在
   `DSH_LOGIN_PASSWORD_USERS`）。与桥现在把网页登录态落在
   `webcode-sessions-*.json`（会话语义）是两件事，但「敏感凭据走官方 store」这条值得桥跟进。
3. **cookie 的 HMAC + `timingSafeEqual` 校验**（`dsh-auth-gate/lib/features/password/challenge-cookie.js`、
   `shared/…/password.js`）：桥的 `lib/cookies.js` 目前只处理 Set-Cookie 的转发语义，
   自身不发 cookie；若将来桥要给自己发会话票据，照这份实现写。

## 四、为什么**不**直接拿它们替换桥的登录链路

| 维度 | 这三个插件 | 桥的登录 |
| --- | --- | --- |
| 主体 | **人**（保护 DSH Web 端口） | **网页 AI 站点**（`chat.deepseek.com` 等 9 个站） |
| 状态 | 一张会话票据 / 一个用户表 | 每个「站点 × 账户槽」一个持久 profile 目录 + 独立的登录态判定（probe-bad / probe-ok / input-fallback） |
| 界面 | 自己的一张登录页 | 无头或有头 Edge，人工登录后从 profile 恢复 cookie |
| 失效处理 | 重新登录即可 | 会话槽丢失要**整段重建**（本轮 T1 修的就是它被误触发） |

结论：它们解决的是**入口认证**，桥解决的是**出站登录态的持有与恢复**。可借鉴的是
凭据存储与 cookie 校验的实现手法，**不是**替换关系。写进 `doc/ROADMAP.md` 阶段 4。

## 五、怎么把某个来源拿回来

```powershell
Invoke-WebRequest "https://registry.npmjs.org/dsh-login/-/dsh-login-0.1.1.tgz" -OutFile reference/web-login/dsh-login.tgz
node .tmp/extract-web-login.mjs
```
