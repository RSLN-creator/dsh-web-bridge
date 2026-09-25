# Harness Web Bridge

将已登录的网页 AI 接入 DeepSeek Harness：网页模型产生工具调用，由 Harness 原生权限系统执行本地工具，结果回传同一网页会话。包名 `dsh-webcode-bridge` 与 provider `webcode` 保留兼容。

## 安装

本插件**不发 npm registry**，唯一交付物是打包好的 `.tgz`。两条路二选一。

### 方式 A — 下载已打包的安装包（推荐，不用本地构建）

1. 打开 [Releases](https://github.com/RSLN-creator/dsh-web-bridge/releases)，下载最新一版的
   `dsh-webcode-bridge-<版本>.tgz`。
2. 装进 DSH 的 `web` profile：

   ```powershell
   dsh plugin --profile web add C:\下载路径\dsh-webcode-bridge-<版本>.tgz
   ```

3. **重启 `dsh web`。** 这一步不能省：安装只换了磁盘上的文件，正在跑的进程里还是旧代码。
4. 重启后打开 http://127.0.0.1:3080，按下面的「初次启动」走一遍。

### 方式 B — 从源码打包

1. `cd package/dsh-webcode-bridge`
2. `pnpm install`。**不要加 `--frozen-lockfile`**——本仓库的 lockfile 对干净安装不成立
   （`ERR_PNPM_OUTDATED_LOCKFILE`，实测直接退出 1），理由见 [doc/ci-cd.md](doc/ci-cd.md)。
3. `pnpm pack` → 在 `package/dsh-webcode-bridge/` 下产出 `dsh-webcode-bridge-<版本>.tgz`。
4. 回到方式 A 的第 2–4 步。

> 仓库里另有两个打包辅助脚本，只在本地排查时用得上：`scripts/verify-pack.mjs`
> 逐文件核对 tarball 与工作树（改完代码忘了重新 pack 时直接报错），
> `scripts/install-profiles.mjs` 先删旧目录再解包（绕开 pnpm 对同版本 tarball
> 「Already up to date」不重解的坑）。两条都是真实踩过的坑。

## 初次启动

1. **确认依赖**：Node.js 22.13+ 与 Microsoft Edge。无需安装任何浏览器扩展。
2. **启动**：`dsh web`，浏览器打开 http://127.0.0.1:3080。
3. **登录网页站点**：原生「设置 > 网页桥接」里点「登录」——会打开一个真实 Edge 窗口，
   完成后自动切回无头。登录态按站点各自持久化，默认目录 `~/.dsh/webcode-edge-profile`。
4. **选模型**：模型选择器的 **Harness Web Bridge** 分组按站点列出模型（DeepSeek / GLM / Kimi /
   通义千问 / 豆包…）；新建会话的默认模型在设置页选择。
5. **用起来**：右侧网页面板使用 **DSH 官方右侧栏**（`@deepseek-ai/dsh-client-ui-sidebar-right`）
   的标签页，与会话头右上角的 Web Bridge 按钮互为一对（点击展开/收起）。
   **不依赖任何第三方侧栏插件。**

网页模型产生的工具调用由 DSH 原生权限系统执行本地工具，结果回传同一网页会话——
权限与审批仍是 DSH 那一套，不会被桥绕过。**装完不重启 = 等于没装**，这是本项目
反复踩到的一条。

## 当前能力

| 模型 ID | 名称 | 实际请求（旧三 pill UI） | 实际请求（2026-09-10 新版 UI） |
| --- | --- | --- | --- |
| `deepseek:deepseek` | DeepSeek | model_type=expert | model_type=default + thinking_enabled=true |

带图能力对该模型自动生效：有图就上传（网页自行路由为 `default + ref_file_ids`），无图不受限。
历史模型 id（`flash` / `vision` / `deepseek-web` / `deepseek-reasoner`）保留为别名，升级后旧设置值仍可解析。

网页模型生成工具请求，由 Harness 原生权限系统执行本地工具，结果回传同一网页会话。支持完整首轮上下文、增量工具结果、历史改写后重建和重启后从 Harness 历史恢复。网页智能搜索在自动生成前关闭。

右侧主视图通过本地固定上游代理加载真实网页 iframe，可直接输入、滚动和操作，登录放在原生设置；不再使用截图降级。设置页首次授权后永久保留，账户失效时才需更换登录；设置页还可追加「全局指令」，会注入每个新网页会话的首轮提示词。面板顶栏提供 **刷新** 按钮（官方右侧栏本身没有该入口）。

普通输出及已识别工具名称会流式传递，工具参数完整解析后才交给 Harness。token 估算统一为 CJK≈0.7、ASCII≈0.25；速度指标为网页 SSE 实测（首字/思考/正文），与估算口径区分。

多站点限流防护：设置页可设「发送间隔」（`sendGapMs`，站点级发送前节流）；触发站点限流时桥识别专用错误并按 max(发送间隔, 10 秒) 自动退避重试，实际等待在右栏统计的「发送前等待」单独展示（含限流重试次数）。

站点差异化调用协议：GLM（chatglm.cn）会用自己的原生工具层拦截正文里的调用标签（只认其内置 search/open/click/find，报 unknown tool call），因此该站点只教 ```json 代码块形状，并支持从思考流兜底解析调用；派发前还会按工具 schema 自动补齐缺失的纯描述性必填参数（如 `pwsh` 的 `description`）。其它站点维持既有 `<tool_call>` 教学不变。

子代理：支持独立网页会话（按 agentId 隔离）与独立站点分流（`subAgentSite`）；所选子代理站点的账户与登录管理内联在子代理设置区（原生面板与独立设置页两处），登录/检测/独立窗口与主站点同一套逻辑，登录态按站点各自持久化。

## 多站点与跨域资源

**每个站点一个独立源**（0.12.9）：右栏 iframe 走 `http://<siteId>.localhost:8931/`，站点看到的 pathname 与它自己的真实站点逐字一致，SPA router 基线与根相对资源天然正确（旧形态 `/__webcode/site/<id>/` 会被 router 认不出，且站点用 history API 写回根相对路径时会跳回中继根 = DeepSeek 镜像）。例外是 **DeepSeek 恒挂在中继根**：它校验宿主名，套子域会得到 `Unknown hostname` 空白页。`*.localhost` 由系统解析到回环，暴露面不变。

站点 HTML 常把脚本/样式放在**另一个域**上并用 `crossorigin` 引用，而该域返回的 `Access-Control-Allow-Origin` 可能是非法通配（DeepSeek 的 `https://*.deepseek.com`），浏览器会硬性拒绝执行，整页退化成「页面资源加载异常」。

因此站点声明 `staticOrigins` 后，`lib/mirror.js` 会：

1. 把 HTML/CSS 里指向这些域的绝对 URL 改写成同源 `/__static/<host>/…`；
2. 剥离 `integrity`（URL 变了必然失配）与 `crossorigin`；
3. 把脚本运行时发往这些域的 `fetch`/`XHR`（埋点上报等）一并改写，避免控制台刷 CORS 错误；
4. **根相对与协议相对 URL 也改写**（`/main.*.js`、`//at.alicdn.com/…`）。GLM 的 webpack 产物用根相对路径引入整包 JS，z.ai 运行时请求根相对的 `/api/config`；不改写就会落到回环根（= 默认站点 DeepSeek 的镜像），拿到 `200 text/html` 后被严格 MIME 校验拒绝执行，`#app` 永远空白——这正是「DeepSeek 右栏能开、GLM/z.ai 打不开」的直接原因；
5. bootstrap 再装一层**运行时钩子**（`fetch`/`XHR`/`createElement`/`setAttribute`），兜住 webpack 懒加载 chunk 这类运行时才拼出来的地址。钩子带幂等守卫，已镜像的路径不会被二次加前缀。

`rootPathForSpa`：个别站点的前端 router 只认根路径（当前是 z.ai）。这类站点打开该开关后，注入脚本会在站点脚本之前把 `pathname` 改写成 `/`；否则镜像页只会渲染错误边界（接口全部 200 且返回正确 JSON，纯粹是路由基线不匹配）。默认关闭，开启会破坏 SPA 深链，不要给 DeepSeek/GLM 打开。

**顺序很关键**：先改写站点 HTML，再注入 bootstrap。反过来的话 bootstrap 里的 `UP`/`ASSETS` 常量会被一起改写，运行时比较永不命中（此坑已由 `test/mirror.test.mjs` 的护栏锁住）。

站点不可达（本机网络/代理不通）时，面板给出的是带站点名与重试按钮的说明页，而不是裸 JSON。

各站点静态域现状（2026-09-11 实测）：

| 站点 | staticOrigins | 实测 |
| --- | --- | --- |
| deepseek | `fe-static.deepseek.com` | 200，CORS 0 |
| glm | `sdata.chatglm.cn` | 200，CORS 52→0 |
| kimi | `statics.moonshot.cn` | 200（域名已由 `kimi.moonshot.cn` 迁移到 `www.kimi.com`） |
| qwen | `g.alicdn.com`、`img.alicdn.com` | 200，CORS 0 |
| doubao | — | 200，CORS 3→0 |
| claude | — | 200（地区受限，网页自身提示） |
| chatgpt / grok / gemini | — | 本机网络不可达（502 + 说明页） |

## 验证和边界

- `pnpm test`：回归、解析和 Harness 适配契约（含镜像同源改写护栏）。
- `node test-mock/real-mirror-matrix.mjs --port 8931`：**右栏真机验收矩阵**——CDP 附着到桥已开的 Edge（沙箱下 spawn 浏览器必 EPERM），逐站点加载真实站点镜像，采集渲染/探活/跳站/乱码证据并截图；输出 `test-mock/out/real-mirror-matrix-<ts>.json` + `.tmp/shots/matrix-*.png`。0.12.9 实测 10/10。
- 设置页「账户与登录管理」每站点有 **导入本机登录态**（把本机真实 Edge 的 cookies 采纳进该站点的桥 profile）。**实测边界**：Edge 128+ 用 app-bound 加密（cookie 的 `encrypted_value` 前缀为 `v20`，密钥绑定到 Edge 应用身份而非仅用户），复制 profile 后一枚都解不开（本机 372 枚全部 v20，`storageState` 返回 0）。因此该按钮在当前 Edge 上会**如实报错**并指向「登录」按钮，而不是假装成功。实现只复制读取所需的最小文件集到临时 profile，且绝不打开你正在用的 Edge User Data。cookie 仍为 v10（DPAPI）的旧 Edge 或其它 Chromium 上该通路可用。
- `node test/glm-session-replay.test.mjs`：用真机会话形状回放 glm 站点工具调用链路——网页存活形状解析、缺失必填补齐、站点差异化教学立场。
- `node test-mock/run-real-longrun.mjs`：长期真实调用验证——真实 Edge + 真实网页会话跑多轮工具闭环（未登录自动开有头窗口等人工登录），断言同一网页会话连续、回复完整、无协议泄漏；设计说明见 [长期问题台账](doc/long-term-issues.md)。
- `node test-mock/run-m2b-driver.js`：真实 Edge 加模拟站点 JSON/SSE。
- `node test-mock/run-m2c-webapi.js`：控制面、预览和跨站拒绝。
- 已真实跑通本地 `providers.js` 读取、审查、工具结果回注、刷新续聊；详见 [验收](doc/verify.md)。
- 图片附件上传已接入；网页没有独立 Vision 控件时走图片附件兼容路径。
- 设置页新增「网页历史」导入区：读取真实网页会话列表，选择工作区后一键导入为主线 DSH 会话（已真机验证 fetch_page / history_messages 解析）。
- 不保证模型审查结论正确；网页输出中的工具示例也可能被误识别，必须保留 Harness 的工具权限与审批。
- 网页会话被删/过期时不再静默降级：桥会用整段首轮提示词重建（见 [长跑审查](doc/deepseek-longrun.md)）；网页输入框截断超长提示词会报 `PROMPT_TRUNCATED` 而不是发出半截。
- **切换会话/重建节流不再中断会话**（0.16.6）：同一个会话键在 60 秒内已经整段重建过一次时，
  第二次既不重放四十万字符、也**不再把这一轮判死**——桥交回一条「网页会话已切换」提示，
  会话不断链，直接发送下一条消息即可继续（窗口过去后这一轮照常整段重建）。这一轮的正文
  没有进网页会话，因此发送游标不前进、会话槽不重置：下一轮会把这一轮的内容一并带上，
  不会静默丢上下文。本进程提示过几次可在 `/__webcode/status` 的
  `driver.sessionSwitchNotices` 核对。
- 2026-09-10 新版 UI（无模型 pill、只剩深度思考开关）已适配：驱动按 UI 代际自动选择操作路径，`pnpm doctor` 在新版真机 8/8 通过；取证见 [新版 UI 取证](doc/research/deepseek-newui-2026-09-10.md)。
- **Harness 侧 markdown 逐字保真**（0.16.9）：`## 标题` 变 `##标题`、空行消失、代码围栏不闭合、
  表格塌成一行——这些「格式错乱」的真因**不是渲染，是字节在桥里被吃掉**。流式正文外发处的
  残渣判据把**纯空白**和 **ASCII 竖线 `|`** 当成标签碎片静默丢弃，而 `PROSE_TAIL_CHARS = 8`
  的滞后让「放行区间恰好是一个空格」成为必然。回归窗口自 0.14.2（0.9.x 无此分支，所以那时正常）。
  现在判据要求「只由标签字符组成」**且**「至少含一个真标签字符」，纯空白与表格竖线照常外发；
  护栏 `test/markdown-whitespace.test.mjs` 用**逐字符驱动**钉住逐字相等。
- **DeepSeek 附件禁令可核对**（0.16.9）：站点禁令（0.16.7）此前只写在代码里——读数不记、
  `/__webcode/status` 不投影、面板还在承诺「超阈值改走附件」。现在有 `SITE_NO_ATTACH` 读数、
  `driver.attachForbidden` 投影，面板也按站点如实说明。
- **`pnpm test` 恢复可跑**（0.16.9）：lockfile 曾把可选 peerDep 记为 `specifier:'*'` 对
  `version:0.1.5-alpha.1`，pnpm 的前置检查必然失败，且在 CI 下**会先删 `node_modules` 再报错**——
  全量测试连启动都做不到。已把 specifier 收紧为 `^0.1.5-alpha.1`。
- **右栏画面清晰度**（0.21.2）：0.21.1 修好了**比例**，但**分辨率上限 1280×2000 没动**——
  客户端画布 backing 是「面板 CSS × dpr」，服务端却把页面渲染成「面板 CSS × k，
  k ≤ min(2, 1280/宽, 2000/高)」。只要面板宽 × dpr > 1280（临界点 **640 CSS px**），
  源图就小于画布，`drawImage` 上采样 ⇒ 糊。实算最坏 2.19×（1400×900 @dpr2）；
  **RTC 路线同样中招**（`rtc-offer` 只停 screencast、不撤 Emulation，页面仍被压在 1280 宽）。
  现在视口 = **面板 CSS × dpr**（= 画布 backing），两端 1:1、零重采样；上限抬到 2560×3200
  覆盖「1280×1600 面板 @dpr2」，超出时按比例收缩（误差 <0.5%）。dpr 由面板经 `resize` 上报，
  上限与客户端 `panelDpr()` 同口径（2）。
- **三档画质：静止无损 PNG / 运动中半分辨率**（0.21.2）：用户要「高精度 + 低占用」，
  一个折中参数做不到，改为按内容状态换编码——`idle` 用 **PNG 全分辨率**（损伤帧在静止时
  本就稀疏，无损几乎不增开销，**文字零 JPEG 伪影**）、`stream` 用 JPEG q88 全分辨率、
  `motion` 用 JPEG q55 **0.55× 出帧**（滚动时降分辨率换帧率）。判据从「500ms 内 ≥3 帧」
  换成**帧间隔 EWMA**（纯函数 `pickStreamMode`）：损伤帧在静止时一帧不发，用计数会把
  「静止但编码慢」误判成静止并回满质量，形成正反馈。
- **RTC 锐度四件套**（0.21.2）：`contentHint='detail'`（W3C 映射到 maintain-resolution）、
  `degradationPreference='maintain-resolution'`、**显式 `maxBitrate` 20 Mbps**、帧率随档位
  （运动 60 / 其余 30）。缺 `contentHint` 时编码器按「摄像头」假设工作，**为保帧率主动降分辨率**；
  不给 `maxBitrate` 则走 BWE 慢爬——实测 VP9 在 3 Mbps 上要 **12 秒**才收敛，收敛前持续降分辨率，
  这正是「刚滚起来是糊的、过十几秒才清楚」。本机是回环、带宽无穷，没有理由让它慢慢猜。
- **右栏 UI 与生命周期**（0.21.2）：删掉面板内那条自建状态行（`.hwb-live-bar`，
  「● DeepSeek · 实时画面」+ 页签 + 「+」）——上面 `.hwb-toolbar` 已含站点名与状态，
  那行是重复信息且**在骗人**（点「+」开了新页，行里标题变了、画面却没跟着换）。
  新页现在**立刻成为画面**（`openPage` 返回新页 id，hub 收到即 attach）。
  右栏**全部面板关闭 ⇒ 回收该账户浏览器**（省内存；正在跑轮次时不关，避免掐断回复；
  驱动对象保留在表中，下一轮 `ensure()` 重新拉起，回收可逆）。
  新增**昼夜同步**：客户端观察 DSH 的 `data-ds-dark-theme`，经 `Emulation.setEmulatedMedia`
  把 `prefers-color-scheme` 推给页面，站点深浅色跟着宿主走。
- **右栏画面流比例适配**（0.21.1）：`viewportForPanel` 的宽、高曾**各自独立**做
  `max(下限, min(上限))`，任一维触边就改写视口比例；客户端按 `contain` 居中绘制
  ⇒ 比例不等的部分全变黑边，观感即「不适配窗口大小」。实算最坏 −68%（全屏工作区
  2400×1200 → 视口 0.640 vs 面板 2.000），且**RTC 路线同样受影响**（`rtc-offer` 只停
  screencast、不停 Emulation，getDisplayMedia 采到的仍是失配比例）。现改为**一次按比例
  缩放**：先求唯一标量 `k = clamp(min(1280/w, 2000/h), 0.25, 2)` 再同时缩放宽高，
  比例严格等于面板（10/10 组误差 0.0%，原来就正确的两组数值逐字不变），k 上限仍为 2
  ⇒ 0.20.2 的 ×2 超采样画质手段完整保留。护栏 `test/live-view.test.mjs` 从「宽高双钳制」
  改判「比例误差 < 0.5% 且双上限同时成立」。
- **RTC 状态机两处漏判**（0.21.1）：`rtcActive` 此前只被**写**、没有任何产帧路径读它，
  于是 RTC 接管后仍有两条路把 JPEG 投屏**重新拉起**——`adaptTimer`（250ms 轮询判定切画质）
  与 `resize` 分支（拖分栏每 120ms 一次）。后果是 RTC 视频与 JPEG 编码同时跑、CPU 翻倍，
  而客户端 canvas 此时 `visibility:hidden`，帧根本没人看。现两处各加 `rtcActive` 守卫，
  且守卫只挡 RTC 活跃期（`rtc-failed` 回落投屏后 resize 照常生效）。
  护栏：`test/live-view.test.mjs` 的 RTC 守卫 A/B 与反向线三条用例（缺守卫时 A/B 必失败，
  已用变异测试确认）。

[进度台账](doc/progress.md)记录当前走到哪与下一步；[长期问题](doc/long-term-issues.md)记录已知缺陷与「为什么不现在修」；[全局诊断](doc/diagnosis-2026-09-16.md)给出一次完整的进度/缺陷/质量/框架评估；[安全审查](doc/security-review.md)记录实际防护及剩余限制；[审查入口](doc/review-guide.md)给出代码地图与探针清单。

> **注**：根目录 `PLAN*.md`、`REPORT.md` 是**本地私有留痕**（`.gitignore` 已排除），
> 不在仓库里，因此上面的链接**不指向它们**——克隆本仓库看不到那几个文件。
> 仓库内的权威入口是 `doc/README.md` 的文档索引。

