# Harness Web Bridge

[English](README.md) · **中文**

用你**已经登录的网页版 AI**（DeepSeek、智谱清言 GLM / Z.ai、Kimi、通义千问、豆包）作为
[DeepSeek Harness](https://github.com/RSLN-creator/dsh-web-bridge) 的模型提供方。网页模型发出
工具调用，DSH 用**它自己的权限与审批系统**执行本地工具，结果回传同一个网页会话。

**不需要 API Key。** 走的是你自己的浏览器登录态。

```
dsh plugin --profile web add dsh-webcode-bridge
```

---

## 状态与风险（请先读这段）

**项目状态**：这是一个**正在开发中的项目**（work in progress）——行为与接口都可能变，网页改版
随时可能让某个站点失效（选择器与协议维护是本项目的日常）。欢迎 **fork 与 PR**：提交信息规范与
本地闸门见 [CONTRIBUTING.md](CONTRIBUTING.md)。

**使用风险，请自行评估**：

| 风险 | 说明 |
| --- | --- |
| **站点服务条款 / 账号受限** | 本插件用自动化驱动你**已登录的网页会话**，这可能违反站点服务条款；账号存在被限流或限制的风险——**作者自己的一个 DeepSeek 网页账号就已被限制**。请自行把握使用强度（插件内置了发送间隔与退避，但不构成任何保证）。 |
| **工具模式 = 提示词注入** | 开启「本地工具调用」后，桥会向网页会话注入工具协议教学；注入内容**对站点可见**，与浏览器原样对话相比，被站点识别为自动化的面会变宽。 |
| **网页改版即失效** | 所有站点都是「用网页当后端」，站点一改版对应通道就可能坏。 |
| **数据本地性** | 登录态只存在**本机**插件自己的浏览器 profile 里；没有 API Key、没有遥测、没有云端组件。 |

**默认形态（重要）**：工具调用**默认关闭**——桥只做纯网页会话，网页模型只收到你的原话，
与浏览器一字不差（不注入任何提示词、不回放任何调用）。要用「网页模型调本地工具」，需在
**设置 → 网页桥接 → 本地工具调用**（首张卡）或输入框下方的「本地工具」药丸里**显式开启**；
开启时会弹出确认提醒。工具调用一旦产生，全部按 DSH 原生权限与审批执行。

## 为什么需要它

「用网页模型」这类集成通常在同样三个地方翻车：靠抓 HTML、页面一刷新就丢上下文、绕过宿主的工具权限。
本插件反过来设计：

| 关注点 | 做法 |
| --- | --- |
| **工具权限** | 网页模型只能**提议**调用；真正执行的是 DSH，权限与审批仍是 DSH 那一套，桥绕不过去。 |
| **会话连续性** | 每会话一个游标，网页对话跨轮、跨重启、跨历史改写都不断链。网页会话丢了就**整段重建**，不会静默重开。 |
| **超长提示词** | 超过阈值的正文改走**附件投递**，绕开输入框的写入卡死与截断；任何一步失败自动回落纯文本。 |
| **限流** | 可配的发送间隔（**全局 + 每站点**），命中站点限流时按 max(间隔, 10 秒) 自动退避重试。 |

## 能力

- **工具调用是显式开关（默认关）**：默认桥只做纯网页会话（零注入、零重放）；开启后按站点教协议
  ——每个站点只教它真正接受的调用形状（DeepSeek 的原生 token 格式、GLM 的
  ```json 代码块、其余站点的 `<tool_call>` 标签），且**按当前会话真实工具清单现算**，不会漂移。
- **右栏是真的网页**，不是截图、不是假页面：通过同源镜像加载真实站点，可以直接输入、滚动、
  点击，登录态持久保存。
- **全局 + 站点两级设置**：模型、指令、发送间隔、提示词投递形态都能全局设一个、再给单个站点
  单独覆盖——改一个站点不会动到别的站点。
- **多账户**：同一个站点可以放多个独立登录，各自独立 profile 与各自的发送节奏。
- **可核对**：每一次投递、回落、限流都投影到 `GET /__webcode/status`，「到底有没有生效」看界面
  就能回答，不必翻日志。

## 环境要求

| | |
| --- | --- |
| Node.js | **22.13 或更高** |
| DeepSeek Harness | **0.1.0-rc.6 或更高** |
| 浏览器 | 无需安装：插件自带 Chromium（Playwright），系统浏览器只作兜底。 |

## 安装

### 从 npm 安装（推荐）

```powershell
dsh plugin --profile web add dsh-webcode-bridge
```

### 从 Release 的 tarball 安装

到 [Releases](https://github.com/RSLN-creator/dsh-web-bridge/releases) 下载最新一版的
`dsh-webcode-bridge-<版本>.tgz`：

```powershell
dsh plugin --profile web add C:\下载路径\dsh-webcode-bridge-<版本>.tgz
```

### 从源码打包

```powershell
cd package/dsh-webcode-bridge
pnpm install            # 不要加 --frozen-lockfile，理由见 doc/ci-cd.md
pnpm pack              # 产出 dsh-webcode-bridge-<版本>.tgz
```

> **装完必须重启 `dsh web`。** 安装只换了磁盘上的文件，正在跑的进程里还是旧代码。
> 这是「装了不起作用」报告里最常见的那一条。

### 不要用仓库地址安装

本插件的包在仓库的 `package/dsh-webcode-bridge` 子目录里，**仓库根目录没有 `package.json`**。
因此把 `dsh plugin` 指向**仓库根**会找不到任何清单，插件只会被当成普通依赖装进去，并打一条：

```
dsh: warning: dsh-webcode-bridge declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

插件配置界面同时显示「普通依赖(未声明 dsh 元数据), 不是 profile 层插件」——也就是**已安装，未生效**。
这条警告的意思是**装错了目录**，不是本包缺元数据：它本来就声明了 `dsh.bundle.patch`
（见 `package/dsh-webcode-bridge/package.json`）。请改用下面任一种：

```powershell
# 按包名装
dsh plugin --profile web add dsh-webcode-bridge

# 或指向包所在子目录 / 已打好的 tarball
dsh plugin --profile web add https://github.com/RSLN-creator/dsh-web-bridge/tree/main/package/dsh-webcode-bridge
dsh plugin --profile web add C:\下载路径\dsh-webcode-bridge-<版本>.tgz
```

**不需要**往仓库根补任何东西来「修」这个问题。

> **本插件面向 `web` profile。** 它声明 `dsh.client.platform = "web"`，面板挂在 DSH 的网页设置界面里。
> 装进 `desktop` profile 不受支持——请照上面用 `--profile web`。

## 初次启动

1. **启动**：`dsh web`，打开 <http://127.0.0.1:3080>。
2. **登录站点**：原生「设置 → 网页桥接」里点该站点的**登录**，会打开一个真实浏览器窗口；
   登录完成后自动切回无头，登录态按站点各自持久化。
3. **选模型**：模型选择器里会多出 **Harness Web Bridge** 分组，按站点列出所有已登录站点的模型；
   新建会话的默认模型在设置里选。
4. **用起来**：站点出现在 DSH 右栏（走官方 `@deepseek-ai/dsh-client-ui-sidebar-right` 的标签页，
   **不依赖任何第三方侧栏插件**）。默认是**纯网页会话**——网页模型只收到你的原话，与浏览器一致；
   要让网页模型能调本地工具，在「设置 → 网页桥接 → 本地工具调用」或输入框下方的「本地工具」
   药丸里开启（会弹确认）。

网页模型发出的工具调用，在你的机器上按 DSH 正常的权限提示执行，结果回传同一个网页对话。

## 配置

所有设置都在「设置 → 网页桥接」里，独立设置页也能改。设置按 profile 落盘。

### 全局

| 设置 | 作用 |
| --- | --- |
| **本地工具调用** | **总闸（默认关）**：关 = 纯网页会话（零注入）；开 = 向网页会话注入工具协议教学，网页模型可提议调用本机工具（仍走 DSH 权限审批）。开启需确认。 |
| **默认模型** | 新建会话用哪个模型。 |
| **全局指令** | 追加一段指令，注入每个新网页会话的首条消息（仅工具调用开启时注入）。 |
| **发送间隔** | 两次向同一站点发送之间的最小等待。默认基准是「距上次发出」（防发送频率限流）；「距上次回复完成」防的是贴得太紧。 |
| **提示词投递** | `附件投递`（默认）：超阈值的正文改走附件上传。`纯文本`：永远写进输入框（0.16 之前的行为）。 |

### 按站点

每个站点一个 tab，可以在**不动全局**的前提下单独覆盖：

- **账户与登录**：该站点的每个登录一行，可新增/切换。
- **模型**：这个站点用哪一支。
- **指令**：只对本站点生效的额外指令。
- **发送间隔**：该站点自己的节奏；点「跟随全局」清除覆盖。
- **提示词投递**：`跟随全局` / `附件投递` / `纯文本`。

回落链恒为 **站点覆盖 → 全局 → 内置默认**；清除覆盖是**删键**，不是写第三个值——因此
「从来没配过」与「配成跟随全局」在设置文件里始终可区分。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `WEBCODE_PROMPT_STORE_DIR` | 各站点提示词文件的落盘目录。`off` = 完全关闭落盘。默认 `~/.dsh/webcode`。 |

## 站点现状

**DeepSeek 是主目标，长会话稳得住；GLM 能用，但不稳定。**

| 站点 | 状态 |
| --- | --- |
| DeepSeek `deepseek:deepseek` | **主目标。** 真实浏览器会话上跑通过长轮多轮工具闭环：自动续跑、游标持久化、重启后从 Harness 历史恢复。 |
| GLM `glm:glm-5.3` / `glm-5.3-flash` | **能用但不稳定。** 真实会话上端到端闭环通过——只存在于工具结果里的随机串被模型原样复述，说明往返是真的活的。 |
| Kimi / 通义千问 / 豆包 / Z.ai | 接线完成，未做长跑验证。可用性取决于你的登录态。 |
| Claude | 地区受限，网页自己会提示。 |
| ChatGPT / Grok / Gemini | 本机网络不可达（502 + 说明页）。 |

GLM 的「不稳定」具体指：

- **关不掉思考**，而且思考占满流（2472 条回复里 1051 条只有思考）。
- **网页用自己的原生工具层拦截正文里的调用标签**，因此该站点只教 ```json 代码块形状，
  并支持从思考流兜底解析。
- **深链导航被阿里云滑块挡住**，探针因此走驱动路径。
- 两个失效模式已修：思考中途断流会产生空回复；调用围栏尾部会作为垃圾漏进正文。

一句话：**DeepSeek 可以跑一整天，GLM 适合当第二意见。** GLM 失败就重试——可归因的失败会以
带错误码的消息浮出，而不是静默退化。

## 工作原理

读源码前值得先知道的几件事。

### 右栏：每个站点一个源

每个站点从 `http://<siteId>.localhost:8931/` 提供，站点看到的 pathname 与它自己的真实站点逐字一致，
SPA router 基线与根相对资源天然正确。例外是 **DeepSeek 恒挂在中继根**——它校验宿主名，套子域会得到
`Unknown hostname` 空白页。`*.localhost` 由系统解析到回环，暴露面不变。

站点常把脚本/样式放在**另一个域**上并用 `crossorigin` 引用，而那个域返回的 `Access-Control-Allow-Origin`
可能是非法通配（DeepSeek 的 `https://*.deepseek.com`），浏览器硬性拒绝执行。`lib/mirror.js` 因此把
这些 URL 改写成同源 `/__static/<host>/…`、剥离 `integrity` 与 `crossorigin`、一并改写脚本运行时发往
这些域的 `fetch`/`XHR`，再装一层幂等的运行时钩子兜住懒加载 chunk。

**顺序很关键**：先改写站点 HTML，再注入 bootstrap。反过来 bootstrap 里的常量会被一起改写，
运行时比较永不命中。`test/mirror.test.mjs` 把这条钉死。

### 提示词投递

超过阈值的正文改走附件（`.md`），而不是敲进输入框——这绕开了两个实测失效模式：
`PROMPT_WRITE_STALLED`（写入期间长度不再增长）与 `PROMPT_TRUNCATED`（网页只收了半截）。
这条路上**任何**一步失败都回落纯文本：投递方式是实现细节，「消息必须发出去」才是契约。

DeepSeek 与 Kimi 有各自更低的站点阈值，因为它们的输入框实测比全站默认更早截断。
上传确认**不被读取**的站点会在运行期降级并被记住。

### token 口径

token 估算走三类**实测单价**（0.19.3 起）：CJK **0.75**、散文 ASCII **0.30**、其余 ASCII
（数字/标点/源码）**0.70**，再叠 10% 余量。口径**永不低估**，唯一真相在 `lib/metrics.js` 的
`TOKEN_DENSITY`。速度指标为网页 SSE 实测，与估算口径区分。

## 排错

| 现象 | 先查什么 |
| --- | --- |
| 装完什么都没出现 | **重启 `dsh web`。** 然后确认插件确实装在 `web` profile 下。 |
| 站点显示「未登录」但明明登着 | 桥用的是**它自己的**浏览器 profile。请走「设置 → 网页桥接 → 登录」，不是你日常浏览器。 |
| 某个站点右栏空白 | 该站点页面没加载起来。面板会给带站点名与重试按钮的说明页，而不是裸 JSON。 |
| 「导入本机登录态」失败 | Edge 128+ 上属于预期：cookie 是 app-bound 加密（`v20`），复制 profile 解不开。请改用**登录**。 |
| 长提示词被直接敲进了输入框 | 查该站点的**提示词投递**设置——可能被站点级覆盖设成了 `纯文本`。 |

`GET /__webcode/status` 暴露全部实时读数（最近一次投递、投递形态、会话槽、限流重试次数、
新开会话的逐因计数）——界面说不清时先看它。

## 开发

```powershell
cd package/dsh-webcode-bridge
pnpm test              # 回归、解析与 Harness 适配契约
pnpm lint:comments     # 注释纪律闸门
pnpm ci:local          # 完整本地 CI
```

几个常用的单文件运行：

```powershell
node test/glm-session-replay.test.mjs        # 离线回放真机 GLM 会话形状
node test-mock/real-mirror-matrix.mjs        # 右栏真机验收矩阵，10 个站点
node test-mock/run-real-longrun.mjs          # 真实浏览器长跑工具闭环
node scripts/verify-pack.mjs                 # tarball 与工作树逐字节核对
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档索引](doc/README.md) | 仓库文档的权威入口。 |
| [进度台账](doc/progress.md) | 当前走到哪、下一步是什么。 |
| [长期问题](doc/long-term-issues.md) | 已知缺陷与「为什么不现在修」。 |
| [依赖、权限与边界](doc/permissions-and-boundaries.md) | 依赖、权限、外部服务与失败边界。 |
| [设置文案](doc/settings-copy.md) | 每个设置标签的确切含义与背后的完整解释。 |
| [CI/CD](doc/ci-cd.md) | 构建、发布与回滚。 |

## 许可

**MIT**，全文见 [LICENSE](LICENSE)。第三方来源声明放在
[依赖、权限与边界](doc/permissions-and-boundaries.md) 里，而不是塞进许可正文——这样 GitHub 的
许可识别会报 `MIT` 而不是 `NOASSERTION`。

SSE 解码协议参考 MIT 项目 [`three-water666/webcode`](https://github.com/three-water666/webcode)。
