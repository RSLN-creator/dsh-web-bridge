# 依赖、权限、外部服务与失败边界

> 本文回答四个问题：**装这个插件会引入什么依赖、它能碰你机器上的什么、它会连哪些外部
> 服务、出错时它会怎样**。每一条都给出可自行复核的读数，不是「设计意图」。
>
> 这份文件的存在理由是 DSH STORE 的收录要求，也是**它自己被 `approved` 的前提**：
> 高权限插件必须把能力声明清楚，声明本身不保证自动批准（见 §6）。

口径：本文件写于 2026-09-26，对应 `dsh-webcode-bridge@0.19.25`。命令一律给全，
读数一律为本机实测。**版本相关的读数会过期**——按本文给的命令重读，不要沿用结论
（本项目在 [`compliance-audit-0.19.1.md`](compliance-audit-0.19.1.md) §0 记过一次
「把当时的版本读数当成长期事实」的教训）。

---

## 1. 运行依赖

### 1.1 事实

| 类别 | 值 | 出处 |
| --- | --- | --- |
| 运行依赖 | `playwright-core@^1.63.0` | `package/dsh-webcode-bridge/package.json` 的 `dependencies` |
| 开发依赖 | `ws@^8.21.3` | 同文件的 `devDependencies` |
| 可选 peer | `@deepseek-ai/dsh-client-ui-sidebar-right@^0.1.5-alpha.1` | 同文件的 `peerDependencies` + `peerDependenciesMeta.optional: true` |
| Node | `>=22.13` | 同文件的 `engines.node` |
| DSH | `>=0.1.0-rc.6` | 同文件的 `engines.dsh` |
| 浏览器 | 本机 **Microsoft Edge**，或 playwright 自带的 Chromium | [`README.md`](../README.md)「初次启动」；`lib/browser-runtime.js` |
| 浏览器扩展 | **不需要任何扩展** | `README.md`「初次启动」第 1 条 |

复核：

```powershell
node -p "const p=require('./package/dsh-webcode-bridge/package.json'); JSON.stringify({deps:p.dependencies, dev:p.devDependencies, peer:p.peerDependencies, engines:p.engines}, null, 2)"
```

### 1.2 `ws` 曾经被记为运行依赖，但它不是（0.19.24 更正）

**这是本轮唯一一处「声明与事实不符」的修正。** 旧声明把 `ws` 列在 `dependencies` 里；
实测**它从来没有被运行时代码引用过**：

```powershell
# 运行时代码（lib/ + bin/）里搜 ws 的导入 —— 0 命中
Select-String -Path 'package\dsh-webcode-bridge\lib\*.js','package\dsh-webcode-bridge\lib\*.cjs','package\dsh-webcode-bridge\bin\*.js' -Pattern "import.*'ws'"
```

唯一的引用者是 `test/fake-extension.js`（一个**测试替身**，用来在没有浏览器的情况下
回放整条链路）。因此本版把它移到 `devDependencies`：运行依赖只剩 `playwright-core`。

**为什么这条不是洁癖**：插件的运行依赖会进入 DSH STORE 的**供应链审查面**。
一个从未被执行的包仍然要求用户与审查方评估它，这是真实的成本。

> 背景：`extension/` 浏览器扩展链路已于 2026-09-16 归档，`ws` 是那条链路的遗留。

### 1.3 关于「运行时代码超过自动审查上限」

DSH STORE 的自动低风险通道有界：**单文件 ≤ 256 KiB、合计 ≤ 2 MiB**。本插件的运行时代码
当前**超出**该界，因此不能走自动批准，需人工审查。这是**如实披露**，不是缺陷：

```powershell
$f = Get-ChildItem 'package\dsh-webcode-bridge\lib','package\dsh-webcode-bridge\bin' -File -Recurse
"文件数 = $($f.Count)"
"单文件最大 = $(($f | Sort-Object Length -Descending | Select-Object -First 1).Length) 字节"
"合计 = $(($f | Measure-Object Length -Sum).Sum) 字节"
```

本机实测（0.19.24）：**44 个文件、单文件最大 371,289 字节（`lib/client.cjs`）、
合计 1,787,067 字节**。即合计仍在 2 MiB 内，但单文件超出 256 KiB。

**不为了过闸而拆文件**：`client.cjs` 是 DSH 客户端要求的**单文件 CJS bundle**
（它不能 `import` 自己的 `lib/`，理由写在 `lib/client.cjs` 文件头），拆分它会破坏官方
契约。这一点如实记在此处，供审查方按「需要人工审查」处理。

---

## 2. 权限

按 DSH STORE 的四类口径（文件 / 网络 / 命令 / 凭据）逐条声明。**保守填写**：
没有证据证明「不访问」时，写实际读到的能力，不写 `none`。

### 2.1 文件：读写（**高**）

| 读/写 | 位置 | 用途 |
| --- | --- | --- |
| 写 | `~/.dsh/webcode-edge-profile/`（可用设置覆盖） | 浏览器持久 profile：登录态、缓存。**由桥自持**，不碰你日常在用的 Edge User Data |
| 写 | `<工作区>/.webcode-tasks/ledger.json` | 任务板台账 |
| 写 | `~/.dsh/logs/webcode-bridge-replies.log` | 每轮网页原始回复全文（用于协议漂移取证，见 `lib/reply-log.js`） |
| 读写 | DSH profile 的插件目录与设置 | 由官方 `dsh plugin` 与官方设置服务承载，桥不自己写 profile 依赖 |
| 读 | 当前工作目录（经 DSH 工具调用） | 工具调用由 **DSH 原生权限系统**执行，不是桥直接读盘 |

**关键区分**：模型产生的工具调用（`read`/`write`/`pwsh` …）**不是**这个插件执行的，
而是交给 DSH 原生工具与审批链。桥只负责把调用文本从网页回复里解析出来并派发。

### 2.2 网络：访问所列站点 + 本机回环（**高**）

| 方向 | 目标 | 说明 |
| --- | --- | --- |
| 出站 HTTPS | §3 的十个站点域 | 驱动你自己的已登录网页会话 |
| 出站 HTTPS | playwright 的默认下载源 | 仅在缺少可用浏览器时，`playwright install chromium` 拉取 |
| 入站（本机回环） | `127.0.0.1:8931`、`<siteId>.localhost:8931` | 本地中继，服务右栏镜像面板与 `/__webcode/*` 控制面 |
| 出站 HTTPS | 站点声明的静态资源域（`staticOrigins`） | 经本机中继**同源改写**后加载，见 `README.md`「多站点与跨域资源」 |

回环面只接受 IP 回环与 `localhost` 名称族（`lib/loopback.js`，依据 RFC 6761）——
公网无法把一个域名解析到**别人的**本机回环，因此这一族不引入 DNS 重绑定面。

### 2.3 命令：受限（**中**）

桥自己会起子进程，位置与用途固定：

| 位置 | 命令 | 用途 |
| --- | --- | --- |
| `lib/browser-runtime.js` | `process.execPath` + playwright `cli.js install chromium` | 缺浏览器时按需下载 |
| `lib/index.js` | `spawn(..., { detached: true })` | 「重启 `dsh web`」按钮 |
| `lib/browser-driver.js` | `powershell.exe -NoProfile -Command` | Windows 上取浏览器进程信息 |

**它不是任意 shell**：以上三处都是**字面量**命令与参数，不含用户输入拼接。
模型驱动的任意命令执行走 DSH 原生 `pwsh`/`bash` 工具，受官方审批管辖。

### 2.4 凭据：站点登录态（**高**）

| 项 | 内容 |
| --- | --- |
| 凭据种类 | 网页站点的 cookie / 会话登录态（**不是** API key） |
| 存放 | 桥自持的浏览器 profile 目录，落在你本机 |
| 去向 | **只在**驱动你自己的浏览器时使用；不发送给任何第三方 |
| 明文风险 | 已做：导入登录态目录白名单 + 状态文件权限 `0o600`（见 [`security-review.md`](security-review.md)） |

**已知边界（如实记，不假装支持）**：设置页有「导入本机登录态」按钮，但在 Edge 128+
上 cookie 用 app-bound 加密（`encrypted_value` 前缀 `v20`），复制 profile 后一枚都解不开。
该按钮会**如实报错**并指向「登录」按钮，而不是假装成功。详见 `README.md`「验证和边界」。

---

## 3. 外部服务

桥**不是** API 客户端——它没有 API key，走的是你在浏览器里已经登录的网页版会话。
当前站点目录（`lib/providers.js` 的 `SITES`）：

| 站点 id | 域名 | 备注 |
| --- | --- | --- |
| `deepseek` | `chat.deepseek.com` | 默认站点；恒挂中继根（它校验宿主名） |
| `glm` | `chatglm.cn` | 有原生工具层，走站点差异化教学 |
| `kimi` | `www.kimi.com` | |
| `qwen` | `chat.qwen.ai` | |
| `doubao` | `www.doubao.com` | |
| `zai` | `chat.z.ai` | 需 `rootPathForSpa` |
| `claude` | `claude.ai` | 地区受限（网页自身提示） |
| `chatgpt` | `chatgpt.com` | 本机网络不可达时给说明页 |
| `grok` | `grok.com` | 同上 |
| `gemini` | `gemini.google.com` | 同上 |

复核：`node -e "import('./package/dsh-webcode-bridge/lib/providers.js').then(m=>console.log(m.SITES.map(s=>s.id+' '+s.origin).join('\n')))"`

**站点的风控是你与站点之间的既有关系**，桥不改变它：触发站点限流时桥按
`max(发送间隔, 10s)` 退避重试，并有「发送间隔」节流（见 `README.md`）。

---

## 4. 失败边界

### 4.1 三条不可越界的约束

这三条写进 [`CONTRIBUTING.md`](../CONTRIBUTING.md) §7，是本项目最贵的三条：

1. **绝不静默降级模型**——站点实际请求的元数据与所选模式不符时必须报错。
2. **绝不静默丢上下文**——网页会话丢失时只能「重放整段」或「抛错」，不允许把增量发进
   一个没有前文的新会话。
3. **工具协议只有一处定义**——`lib/agent-preset.js`；别处再定义一遍会造成协议漂移。

### 4.2 会响亮失败的情形（而不是悄悄做错）

| 码 | 什么时候 | 边界 |
| --- | --- | --- |
| `CONTEXT_WINDOW_EXCEEDED` | 发送**前**预算闸越界 | 越界时网页端**完全未被写入** |
| `PROMPT_TRUNCATED` | 填写**后**回读校验发现只收了半截 | 是兜底，不是主防线 |
| `WEB_NO_PROGRESS` | 网页侧超时零新内容 | 带相位与两段现场 |
| `NEED_LOGIN` | 逐元素可见性判定未登录 | 不把 WAF 隐藏框判成已登录 |
| `RATE_LIMITED` | 站点限流 | 自动退避重试 |
| `WEB_SESSION_LOST` | 会话不可恢复 | 不静默新开会话 |
| `TOOL_CALL_UNPARSED` | 调用形状不认识 | **不抛错**：把现场与再教学作为本轮回复交回 |

**逐码的「已做什么适配 / 残留风险」不在这里**——那是
[`bridge-failure-ledger.md`](bridge-failure-ledger.md) 的唯一职责。本文只声明边界形状，
不复制那份表（一个事实只写一处）。

### 4.3 明确**不保证**的事

| 不保证 | 说明 |
| --- | --- |
| 模型审查结论正确 | 网页输出可能被误识别为工具调用 |
| 工具权限由桥把关 | **不**：权限与审批一律是 DSH 原生那一套，桥不绕过也不复制 |
| 永不泄漏协议文本 | 已有护栏（见 `doc/research/2026-09-26-glm-native-and-deepseek-no-progress.md`），但这是持续对抗，不宣称已终结 |
| 站点长期可用 | 网页改版会破坏契约；发版前按 [`verify.md`](verify.md) 矩阵真机验收 |
| 已通过独立安全审计 | 本文件是**作者声明**，不是第三方审计结论 |

---

## 5. 自检命令

```powershell
node scripts\check-plugin-contract.mjs      # 声明层与事实一致（本轮新增的闸门）
node scripts\check-repo-hygiene.mjs         # 编码 / 索引 / Node 版本
node scripts\ci-local.mjs --fast            # 本机可跑的 CI 离线步骤
```

`check-plugin-contract.mjs` 把本文最容易漂移的四条变成红灯：仓库指向、许可证三处一致、
运行依赖无死声明、本文存在且被索引。

---

## 6. 与 DSH STORE 状态的关系（如实记）

本插件在 DSH STORE 的目录状态是 **`blocked`**（不是 `approved`）。目录给出的原因是：

> manifest repository 与 canonical 仓库不一致；manifest 与 GitHub 的许可证元数据不一致；
> 运行或可选依赖需要单独的供应链审查；运行时代码超出自动审查字节上限。

本轮修复的是前两条（§1.2、§1.3 与 `package.json` 的 `repository`/`homepage`/`bugs` + 根
`LICENSE`）。后两条**按性质仍需人工审查**：

- 「依赖需要供应链审查」——依赖面已收窄到 `playwright-core` 一个（§1.2），但审查本身
  仍应由人做；
- 「运行时代码超界」——如 §1.3 所述，`client.cjs` 的单文件形态是官方契约要求，
  **不应为了过闸而拆分**。

**声明不保证自动批准**：本文与闸门只保证「声明的与事实一致」，不改变审查结论。
DSH STORE 每八小时自动复检，无需人工确认回复。
