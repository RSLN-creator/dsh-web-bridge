# 本轮要求与进度留痕（2026-09-26）

> 用户指令：「**记录这次对话我说的要求和意见和你的进度**，先保证 0.19.x 版本不变，然后开始真实允许测试 glm 和完成 glm 真实适配，参考 glm 自己调研，以及直接看最开先我引用的会话查看和记录那里我提出来的问题并修复，**记录更新打包安装交付**」。
>
> 本文是**逐字要求** + **实测进度**的对照表。要求原文一律加引号，不复述、不改写。

---

## 一、用户逐字要求清单

按本会话时间顺序。每条附「是否已做 / 证据」。

| # | 用户原话（逐字） | 落地状态 | 证据 |
| --- | --- | --- | --- |
| R1 | 「你能调查本机几个问题吗？思考完整两轮，参考 dream sci?就是谷歌那个之思考多轮的：避免影响 deepseek 网页端：本机别的 ai 在修改：请你查看 z.ai 和 glm-5.3 真实实现现在 deepseek 已经完整实现能力你该如何做？从 dsh 调用开始原生原本路线走一遍，有项目就参考项目：确保和使用 glm api 调用一样原生」 | **部分完成**（调查已完成，落地在进行） | 调查全文见 §三；本轮已落地围栏修复 + 账号互斥；z.ai 方言教学仍在 P2 |
| R2 | 「继续，检查任务完成」 | 进行中 | 见 §二 |
| R3 | 「你需要修补加上一个准则记录：**同一账号不能同时桥接运行！**」 | ✅ **已完成** | `lib/bridge-lock.js`（新增）+ `lib/browser-driver.js` 接线 + `test/bridge-lock.test.mjs` **14/14** |
| R4 | 「记录这次对话我说的要求和意见和你的进度」 | ✅ **本文** | 本文件 |
| R5 | 「**先保证 0.19.x 版本不变**」 | ✅ 已遵守 | 版本 `0.19.16 → 0.19.17 → 0.19.18`，**始终在 0.19.x 内**，未升 0.20 |
| R6 | 「开始真实允许测试 glm 和完成 glm 真实适配」 | 进行中 | 见 §四 |
| R7 | 「参考 glm 自己调研」 | 待做 | 计划研读 `reference/` 下 GLM 相关仓库 |
| R8 | 「直接看最开先我引用的会话查看和记录那里我提出来的问题并修复」 | ✅ 已抽取并核对 | §三 的原始报告已完整解码（会话 `session-a552eb11`） |
| R9 | 「记录更新打包安装交付」 | 进行中 | 见 §五 |

---

## 二、本轮进度台账

### 2.1 已完成

| 项 | 内容 | 证据 |
| --- | --- | --- |
| **A. 上一会话失败根因** | 会话 `session-0b292806` turn2 step3 死于 `WEB_NO_PROGRESS`。**报错自相矛盾**：既说「超过 120s 没有任何新内容」，又说「最近驱动活动时间 **1s** 前」「相位=已开流后的静默」——驱动 1s 前还在活动。⇒ 看门狗量的是「适配器事件通道静默」，而通道静默的原因是**协议原文在挤占正文通道**（与 B 同源） | `doc/progress.md` 0.19.17 节 |
| **B. 正文空白+乱码根因（已复现已修）** | 流式期间**调用围栏本身**被当正文外发。GLM 走 codeblock 传输；围栏刚开、JSON 还没吐出 `mcp_action`/`arguments` 的窗口里 `findProtocolStart` 判据不成立 ⇒ 外发边界只剩 `PROSE_TAIL_CHARS`（8）⇒ 围栏与 JSON 头逐字符进正文。真机会话正文块里全是 `\n```\n\n` | `lib/agent-preset.js` 新增 `unresolvedCallFenceAt` + `closingFenceAfter`；`lib/index.js` 接线；`test/fence-tail.test.mjs` **10/10** |
| **C. 账号互斥准则（R3）** | 见 §一 R3 | `lib/bridge-lock.js` + `test/bridge-lock.test.mjs` 14/14 |
| **D. 架构审计（R1 的第一问）** | 逐站点分模块现状 | `doc/research/2026-09-26-dwb-site-modularity-audit.md` |
| **E. 会话落盘取证手法** | 会话是**多帧 zstd**，`zstdDecompressSync` 只解首帧（220 字节 = 仅 session 头）⇒「解出来只有一行」是**假象**。正确：扫 `28 b5 2f fd` 魔数分帧拼接 | `test-mock/probe-fence-decision.mjs` |

### 2.2 待做

| 项 | 内容 |
| --- | --- |
| **F** | GLM 真机端到端测试（真实发消息、验证工具循环） |
| **G** | GLM 真实适配补完（DOM 选择器 / 传输形状按 §三 报告的第 2 步） |
| **H** | 全量回归 |
| **I** | 打包安装交付 |

---

## 三、用户最早引用的会话里提出的问题（已完整解码）

来源：`session-a552eb11-deb0-401c-9f0f-6f3a28b042bf`（用户 R8 指定的那份）。
解码方式：多帧 zstd 分帧拼接（见 §2.1-E）。

### 3.1 该会话给出的**原始结论**（逐字要点）

**① 原生路线现状**
- DSH 本体 0.1.7-alpha.2 的 lib 只是入口壳，LLM 路由由插件提供；`list_subagent_models` 实测 `webcode` provider 已注册多条 GLM 路由：`webcode/glm:glm-5.3`、`glm-5.3-flash`、`auto`，以及**独立的** `webcode/zai:*`（glm-5.3 / 5.3-flash / 5.2 / auto）——**z.ai 与智谱清言是两条独立站点路由**。
- provider 真身是本工作区 `dsh-webcode-bridge`，用 playwright 驱动真实网页、捕获网页自身的完成流解码，**不是 API 客户端**。
- 三站对比：

  | 站点 | 流端点 | 解码器 | 传输形状 |
  | --- | --- | --- | --- |
  | DeepSeek | `/api/v0/chat/completion` | `deepseek` | **`official`**（官方训练模板） |
  | 智谱清言 | `chatglm.cn` `/chatglm/backend-api/assistant/stream` | `glm` | `codeblock`（```json） |
  | Z.ai | `chat.z.ai` `/api/chat/completions`（OpenAI 兼容 SSE） | `openai-sse` | `tag`（通用标签兜底） |

**② 与「GLM API 原生调用」的差距（该会话自己列的四条）**
1. DeepSeek 完整实现的关键是「**教学格式 = 训练分布**」（官方模板）；**z.ai 目前吃的是通用标签教学，不是 GLM 被训练过的工具调用方言**——这是核心差距。
2. z.ai 前端**没有** chatglm.cn 那种标签截胡问题（`prompt-variants.js` 注明），是**最有条件升级为方言教学的站点**；且它网页本身就是 OpenAI 兼容 SSE，是 10 个站点里最接近 API 形状的一条。
3. 网页端 GLM-5.3 **强制思考不可关**（`index.js` 引 zai-copilot-chat 方言佐证），长循环思考流占比高（实测 2472 条回复中 1051 条纯思考流）。
4. 上下文已达标：glm/zai 声明的 1M 是真机探针实测下界（`providers.js`）。

**③ 该会话给出的建议做法（它自己标注「未动手，供你拍板」）**
- 约束前提：另一 AI 正在本工作区改动、不能影响 DeepSeek 路线 → 全部**只增不改**：不碰 official/codeblock 分支、不重启 DSH web。
- **第 1 步取证**：研读 `reference/zai-copilot-chat` 与 `reference/glm-free-api`，提取 GLM 官方工具方言逐字形状。
- **第 2 步实验**：按仓库纪律把「zai 方言」做成实验变体（`EXPERIMENT_SPECS`），用 `test-mock/prompt-bench` 跑配对基准。
- **第 3 步转正**：数据胜出后在 `VARIANT_SPECS` 加 `only:['zai']` 一行，三层映射同源生效，deepseek/glm **零改动**。
- 备选的「协议级原生」路：给 DSH 直连 `api.z.ai` 注册 OpenAI 兼容 provider（原生 `tool_calls`，不经教学/解析），代价是吃 API 额度而非网页会员——**产品取舍需用户决策**。

### 3.2 该会话**没能完成**的部分（本轮要接手的）

| 该会话的建议 | 现状 |
| --- | --- |
| 第 1 步：研读 `reference/` 提取 GLM 方言 | ⬜ **未做**（该会话末尾即中断） |
| 第 2 步：zai 方言做成实验变体 + 配对基准 | ⬜ **未做** |
| 第 3 步：转正 | ⬜ **未做** |
| 「完成 glm 真实适配」 | ⬜ **未做**——且本轮实测发现一个该会话**没看到**的真缺陷（围栏泄漏，见 §2.1-B） |

### 3.3 该会话的一个**现场自证**（很有价值，逐字保留）

> 上一轮正文被桥误判成了未解析的工具调用——原因正是我在报告里引用了带尖括号的 `tool_call` 字样，被解析器当成了协议锚点（这恰好现场演示了报告里描述的“标签形状截胡”问题）。

**这条要记下来**：连「在报告里讨论协议形状」都会触发桥的协议探测。这与本轮修的围栏泄漏是**同一族**问题的两个面（判据太宽 / 判据在流式早期不成立）。

---

## 四、GLM 真机测试与适配

### 4.1 已确认的前置条件（实测）

```
C:\Users\rsyhn\.dsh\webcode-edge-profile\sites\glm\webcode-login-state.json
→ {"loggedIn":true,"at":1790363910649,"basis":"probe-ok","message":"页面核验：命中登录特征"}
```

- GLM profile 目录存在：`sites/glm`（另有 9 个站点各自独立目录）。
- 路由已注册：`webcode/glm:glm-5.3`、`webcode/glm:glm-5.3-flash`、`webcode/glm:auto`。
- **2026-09-26 实测旁证**：一次探针误用 `glm:*` 模型（本想用注入桩驱动）反而打了真机，`chatglm.cn` 真实返回（`send confirmed` → `request done chars=607`），模型自行调起 `pwsh` 并回传本机环境读数。⇒ **`webcode/glm:glm-5.3-flash` 路由当前可用**。

### 4.2 真实测试结果（2026-09-26 实跑，非推算）

**测试一：`test-mock/real-glm-e2e.mjs` — 最小可用判据（能拿到正文）**

```
[开始] model=glm:glm-5.3-flash
[webcode-bridge] fresh web chat (reason=no-cursor, sessionKey=e2e-glm-1790370872207::glm) — 整段重建
[webcode-driver:glm] launched (headless) profile=...\sites\glm
[webcode-driver:glm] send confirmed (composer cleared / navigated) url=https://chatglm.cn/main/alltoolsdetail?...cid=6ab6e437aed53d5a7c581264
[webcode-driver:glm] web session slot written at after-submit
[结果] text-delta=1 字  正文块=1 字  思考=150 字
[正文] "2"
[思考尾部] "The user is asking a simple math question: 1+1 = ? They explicitly say \"只回答一个数字\" ... So I should just answer: 2"
[收尾] {"type":"finish","reason":{"kind":"stop"}}
[判定] PASS — GLM 真机可产出正文
[耗时] 6.1s
```

**测试二：`test-mock/real-glm-tool-loop.mjs` — 工具循环端到端（用户要的「和 glm api 调用一样原生」）**

判据四条，全过：

| # | 判据 | 结果 | 读数 |
| --- | --- | --- | --- |
| ① | 第一轮解析出工具调用 | **PASS** | `calls=1` |
| ② | 调用名在工具表内且参数非空 | **PASS** | `{"name":"pwsh","args":"{\"command\":\"Write-Output ZQ913\",\"description\":\"Prints the string ZQ913 to stdout\"}"}` |
| ③ | 工具真的被执行 | **PASS** | `command=Write-Output ZQ913` |
| ④ | 模型读到工具结果并复述 | **PASS** | 第二轮 `text="ZQ913"`（与首轮随机生成的 secret 逐字一致） |

```
[第1轮] text="" calls=1 finish=tool-calls
   调用 pwsh args={"command":"Write-Output ZQ913","description":"Prints the string ZQ913 to stdout"}
[第2轮] text="ZQ913" calls=0 finish=stop
[判定] PASS — GLM 工具循环端到端可用
[耗时] 48.1s
```

**结论**：`webcode/glm:glm-5.3-flash` 的**完整工具循环**（教协议 → codeblock 发调用 → 桥解析 → 派发 → 结果回注 → 模型复述）在真机上跑通。secret 是每轮随机生成的（`ZQ913`），模型只可能从工具结果里读到它 ⇒ **回注链路确实是活的**，不是模型猜出来的。

### 4.3 本轮查明的 **GLM 真机新障碍**（如实记，未修）

| 项 | 读数 | 影响 |
| --- | --- | --- |
| **深链导航被阿里云滑块拦** | `test-mock/real-probe-30`/`31` 用裸 playwright `goto(chatglm.cn/main/alltoolsdetail?cid=...)` 时，页面 title 变成**「滑动验证页面」**，DOM 里只有 `capture-container` / `aliyunCaptcha-*` / `nc-container`，`main` count=0 | **只影响「裸导航深链」的探针**。走**驱动路径**（打开站点首页 + 正常发消息）时**不受影响**——测试一/二都成功。⇒ 这两支 DOM 探针的当前读数**不能**用来判定「选择器对不对」，需改用「驱动路径下采样」。 |
| **`real-probe-30` 的「候选全 0」结论要重新解读** | 首轮读数「`.markdown`/`.ds-markdown`/`.answer`/… count 全为 0」是在**滑块页**上读的，不是在真实会话页上 | 我先前在审计报告 §三 C1 里把它当成「选择器对 GLM 瞎」的证据。**该结论的取证条件不成立**（页面根本没渲染出会话）。诚实修正：**GLM 的选择器命中情况尚未取得有效读数**。 |
| **直接 `driver.sendTurn` 报 `WEB_SESSION_LOST`** | `WEB_SESSION_LOST: 会话槽为空（site=glm，no-stored-session）` | 这是我**用法错误**，不是缺陷：会话槽为空时该 fresh 的策略住在 `lib/index.js` 适配器层。已改用 `adapter.stream()`（生产路径）并通过。 |

### 4.4 与用户最早引用会话（§三）建议的对照

| 该会话的建议 | 本轮状态 |
| --- | --- |
| 第 1 步：研读 `reference/` 提取 GLM 方言 | ⬜ **未做**（`reference/zai-copilot-chat`、`reference/glm-free-api` 已在盘上，未读） |
| 第 2 步：zai 方言做成实验变体 + 配对基准 | ⬜ **未做** |
| 第 3 步：转正 | ⬜ **未做** |
| 「完成 glm 真实适配」 | ✅ **最小可用已达成**（正文 + 工具循环双双真机 PASS）；「方言教学」这一层仍未做 |

---

## 五、更新记录

| 时间 | 事件 |
| --- | --- |
| 2026-09-26 | 建立本文；R3/R4/R5 已完成；R1 的调查部分已完整解码归档 |
