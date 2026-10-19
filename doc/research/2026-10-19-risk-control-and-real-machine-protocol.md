# 真机实验：站点风控机制调研 + 本轮真机协议（2026-10-19）

> **本文件回答两个问题**：① 同类「网页 AI 转 provider」插件/反检测工具是怎么处理站点风控的，哪些该学、哪些**明确不学**；
> ② 今晚这轮真机实验按什么硬规则发消息，怎样才算「验证过」。
>
> **立场先说**：本项目的红线是 **「代码不绕站点风控」**（`doc/long-term-issues.md` #29/#30、
> `.tmp/real-lane/GATE.md`、`CONTRIBUTING.md` §1.3 三处独立成文）。本文件调研「降触发率」，
> **不调研、不实现「绕过检测」**。两者的分界写在第 3 节。

## 0. 一句话结论

网页版 AI 站点的风控不是单一「反爬开关」，而是**自动化信号 × 行为节律 × 登录/会话 × 网络环境 × 账号打分**的加权判定。
对本项目（驱动本机真实浏览器 + 用户自己的已登录 profile）而言，**最有效的降风控手段恰好就是产品本来的形态**：
真实 Edge、真人有头、持久登录态、单账号串行、按产品节奏发送、发现验证码立即停手交人。
**对抗式反检测（指纹伪造 / 打码 / 代理池 / PoW 求解）在本项目里既不必要，也会把「外部风控」与「产品缺陷」在读数上搅成一片**（#29 的教训）。

## 1. 目的与边界

| 做 | 不做 |
| --- | --- |
| 把桥**自身**造成的可疑节律降到与真人一致（串行、间隔、零重试、少量发送） | 伪造浏览器指纹 / `navigator.webdriver` / UA |
| 用真实浏览器与真实用户 profile（登录态、localStorage、cookie 原样） | 引入 patchright / nodriver / 打码平台 / 代理池轮换 |
| 命中验证码/滑块时**如实 BLOCKED**、提示人手动过 | 求解站点 PoW/签名（`a_bogus`/`msToken` 等）或自动化过验证 |
| 逐次记录真机发送（站点/变体/时刻/结果/是否见验证码） | 把「站点忙/被限流」写成产品 FAIL，或反过来把 FAIL 写成 BLOCKED |

## 2. 站点侧风控一般看什么（公开资料归纳）

| 维度 | 站点侧的常见信号 | 对本项目的影响 |
| --- | --- | --- |
| 自动化信号 | `navigator.webdriver`、CDP 痕迹（Runtime/Console 域）、headless 特征、`cdc_` 变量、UA/插件/权限 API 异常 | 本项目用**真实 Edge + 持久 profile**，绝大多数信号天然不存在；剩余风险来自 CDP 本身（见 §3） |
| 行为节律 | 固定间隔、零间隔连发、页面停留/滚动不自然、鼠标轨迹缺失、瞬时切换模型/会话 | **本轮协议的主要控制点**：串行、≥20s、每站每次实验 ≤3 发、零重试 |
| 登录与会话 | 游客态、cookie 与 localStorage 不一致、会话地址跳变、多账号共用指纹 | 每站独立 profile 目录（`slotProfileDir`）；不拷 profile 副本冒充（kimi 登录态在 localStorage，见 #32） |
| 网络环境 | 机房/代理 IP、IP 跳变、同 IP 多账号高频 | 本机家用网络；**不做代理轮换**（轮换本身是更明显的信号） |
| 账号打分 | 历史违规、内容审核命中、资源配额、会员等级 | 站点自有资源错误（如 kimi `resource_exhausted`）应记 **BLOCKED** 而非产品 FAIL（#62） |

外部资料（均为公开文章，**不是**可执行方案背书）：

- Castle《From Puppeteer stealth to Nodriver》系统梳理了反检测框架与 CDP 痕迹的关系，并指出
  「重度 CDP（Runtime/Console 域）本身可被页面观测」——这正是本项目**只在必要时用 CDP、不做 DOM 高频轮询**的旁证。
- Bright 与 ZenRows 的实践文都强调：UA/headers、cookie 复用、**降低请求节律**通常比「伪造指纹」更稳；
  ZenRows 同时列了 IP 轮换、CAPTCHA 处理等对抗手段（本项目**不采用**）。
- Scrapfly 的自动化检测对照表可用于自查（headless 特征、框架标记、CDP 痕迹）。

## 3. 同类工具的做法与「学 / 不学」判定

### 3.1 同类「网页转 API」项目（来自本仓库 `reference/` 调研，见 `reference-projects.md`）

| 项目类 | 它们怎么对抗风控 | 本项目的取舍 |
| --- | --- | --- |
| `deepseek-free-api` / `Kimi-Free-API` / `glm-free-api` / `qwen-free-api` | 反向代理网页端点 + **PoW 求解** + token/账号池 + 代理 | **不学**：本项目不是反代，是驱动本机真实浏览器；PoW/签名属于「绕站点校验」 |
| `doubao2api` | Playwright 驱动豆包 + **注入 `a_bogus`/`msToken` 签名** | **不学**：签名注入是明确的对抗；协议形状可作为观测参考 |
| `AIstudioProxyAPI` / `browser-ai-bridge` / `chatgpt-gateway` | Camoufox / 反检测浏览器 + 持久 profile + 代理 | **只学「真实浏览器 + 持久登录**」这一层；不引入反检测浏览器 |
| `dsh-codearts-auth`（同类 DSH provider 插件） | 走厂商**官方 HTTP API**，无网页风控问题 | 架构不同（API vs 网页），但它的「账号池 + per-ref 串行续期」值得对照：**并发必须按账号串行** |

本项目实际采用的 5 个参考项目（`glm-free-api` / `Kimi-Free-API` / `LLMs2API` / `qwen-free-api` / `deepseek-free-api`）
只用了它们的**帧形状与端点事实**，没有采用任何一条反风控代码——这条边界见 `reference-projects.md` 的「教训」一节。

### 3.2 通用反检测方案（调研结论：本仓库不采用）

| 方案 | 它解决什么 | 为什么不用 |
| --- | --- | --- |
| Playwright Stealth / patchright / rebrowser | 抹 `webdriver`、修 CDP 泄漏 | 本项目用有头真实 Edge + 持久 profile，收益趋近 0；引入第三方补丁会破坏「真实浏览器」这一最大优势，且增加与 playwright-core 版本的耦合 |
| Nodriver / Selenium-Driverless（去 CDP） | 消除 CDP 可观测性 | 本项目需要 CDP 做**只读回读**（登录态、思考档位、回复节点）；去 CDP 等于把可观测性换成不可调试性 |
| 代理池 / 住宅 IP | 换网络身份 | 用户只有一个真实账号与真实家庭网络；轮换制造「同名账号多地登录」信号 |
| 打码平台 / 验证码识别 | 过人工验证 | **红线**：站点要求真人即停（#29 的一票停手） |
| 账号池 / token 池 | 分摊限额 | 本插件按用户自己的账号槽工作，不代管他人凭据 |

**一句话**：对抗式方案解决的是「冒充人」，本项目需要的是「不要比人更可疑」。后者靠节律与少量发送即可，且不伤账号。

## 4. 本项目已经做对的（一手台账证据）

| 机制 | 位置 | 备注 |
| --- | --- | --- |
| 真实浏览器 + 持久 profile + 有头优先 | `lib/browser-driver.js`（`playwright-edge`） | 登录一次长期有效，无扩展 |
| 发送间隔按用户设置 + 验收脚本独立 ≥20s 地板 | `lib/metrics.js`（`computeSendGap`）、`test-mock/site-verify-pacing.mjs` | 验收脚本**不得**比产品更狠（#69 修过这个自造风控缺陷） |
| 按账号槽串行 / 多账号分车道 | `lib/relay.js`、`lib/index.js`、`lib/accounts.js` | 同账号并发是网页会话的物理约束 |
| 验证码三路归因（站点声明 + 文案词表 + 逐 frame） | `lib/challenge-heuristics.js`、`lib/captcha-gate-scan.js`、`lib/browser-driver.js` | 命中即 `WEB_CAPTCHA_REQUIRED`，**不尝试绕过** |
| 真机四态判读 | `test-mock/site-verify-verdict.mjs` | `FAIL` 是产品结论；`BLOCKED` 是外部条件；`UNVERIFIED` 绝不是通过 |
| 真机发送台账 | `.tmp/real-lane/GATE.md` | 每次发送后立即回写站点/变体/时刻/结果/是否见验证码 |
| 只读回读优先 | `probe-think-effort-live.mjs` 等 | 能只读就不点击、能零发送就不发送 |

## 5. 本轮（2026-10-19 夜）真机协议（硬约束）

1. **范围**：国模五站 `deepseek / glm / kimi / doubao / zai`；`qwen` 因未登录（#61，需用户邮箱验证码）**只做登录只读核验，不发送**。
2. **串行**：全机同一时刻只有一个真机发送在跑；不同站点的 profile 锁不保证跨站串行，靠执行者自律。
3. **限量**：每站点每个**代码变体**（同一份代码）≤ **3 次发送**；`site-verify.mjs` 一次运行正好 3 次
   ⇒ **每个变体每站只跑一次，零重试**。
4. **间隔**：脚本内部按产品设置 + ≥20s 地板；跨站点之间也留 ≥20s。
5. **有头**：`REAL_HEADLESS=0`，验证码必须人能看见；命中即停，记 `BLOCKED`，**不重试、不绕**。
6. **不碰用户正在用的会话**：不重启 DSH、不改 `~/.dsh` 配置、不发消息给用户正在看的浏览器窗口。
7. **记录义务**：每次发送后把「站点/变体/时刻/四态/是否见验证码」写进
   `.tmp/live-2026-10-19/GATE-LEDGER.md`，并在报告里保留**原始 stdout**（结论与读数分开）。
8. **「验证过」的判据**：`site-verify` 的检查项必须为 PASS；任何 `BLOCKED`/`UNVERIFIED` 都如实保留，不允许汇总成 PASS。
9. **不进包**：本轮全部真机产物落 `.tmp/`（gitignore），入库的只有「代码修复 + 护栏 + 台账/调研文档」。

## 6. 四态判读（与 `test-mock/site-verify-verdict.mjs` 同一口径）

| 读数 | 含义 | 本轮处置 |
| --- | --- | --- |
| `PASS` | 真实页面 + 真实请求支持该结论 | 计入「已验证」 |
| `FAIL` | 真实页面复现了失败（产品结论） | 必须修；修不了如实登记 |
| `BLOCKED` | 未登录 / 验证码 / 站点资源限流 / 站点太忙 | 外部条件，**不算产品结论**；记录并继续下一站 |
| `UNVERIFIED` | 缺读数/缺调用/缺回填 | **绝不算通过**；写明缺了哪一项 |

## 7. 剩余风险与需要用户的一步

| 风险/缺口 | 现状 | 处置 |
| --- | --- | --- |
| **qwen 登录**（#61） | profile 已是 `probe-bad / needLogin=true`；登录循环 300s 墙钟且不识别阿里系 WAF | 需要用户在 GUI「设置 → 网页桥接 → Qwen → 打开窗口」里**手动填邮箱验证码**；代码侧本轮补验证码指纹与「请手动过」提示 |
| **z.ai 自带风控闸**（#29） | 历史上弹滑块且无头不可见；10-14 有一次未弹 | 有头跑；命中即 BLOCKED，不绕 |
| **账号打分/内容审核** | 站点自有策略（如 doubao 「不文明用语提醒」、kimi `resource_exhausted`） | 记 BLOCKED；换无害短 prompt，不重试 |
| **服务条款** | 网页版 AI 供人使用，自动化可能违反站点 ToS | 用户自担；本项目只做「用户自己账号的低频自动化」，不做商用/批量 |
| **「完美适配」的边界** | 网页改版随时可能坏；本轮验证只覆盖今晚这一版页面 | 读数带时间戳入台账；不做「永久可用」承诺 |

## 8. 外部引用

- Castle — *From Puppeteer stealth to Nodriver: How anti-detect frameworks evolved to evade bot detection*：
  https://blog.castle.io/from-puppeteer-stealth-to-nodriver-how-anti-detect-frameworks-evolved-to-evade-bot-detection/
- Bright — *避免使用 Playwright Stealth 被检测为机器人*：
  https://www.bright.cn/blog/how-tos/avoid-bot-detection-with-playwright-stealth
- ZenRows — *How to Avoid Bot Detection With Selenium*：
  https://www.zenrows.com/blog/selenium-avoid-bot-detection
- Scrapfly — *Automation Detection Tool*：
  https://scrapfly.io/web-scraping-tools/automation-detector
- 腾讯云开发者社区 — *Claude 降智严重？GPT 总是被限制？拆解背后的风控机制与解决方法*：
  https://developer.cloud.tencent.com/article/2720784
- 百度智能云 — *AI 服务账号安全运营指南：基于真实案例的风险规避与合规实践*：
  https://intl.cloud.baidu.com/zh/article/9155962
