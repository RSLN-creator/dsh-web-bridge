# 0.19.x：无头调用残片泄漏（GLM `name":"pwsh"…`）根因、修复与验证

> 日期：2026-09-26 下午轮。上一轮（0.19.23）修掉了 `json` 四个字符的泄漏（`closingFenceAfter`
> 开启围栏判据），并**诚实标注**：残片 `name": "pwsh", …`（缺 `{"mcp_action": "call", ` 头）
> 「本轮未修、也未定性」。本报告把它定性并修掉。
>
> **本报告的判据全部来自真机读数与离线重放，没有任何一处是"应该已经修好了"的推断。**

---

## 一、真机现场（运行中的 0.19.23 会话，不是旧版本）

- 运行中的 `dsh web`（PID 11268，2026-09-26 14:20:23 启动）加载的是 0.19.23
  （`profiles/web/node_modules/dsh-webcode-bridge` 三个关键文件安装时间 11:57:51，版本 0.19.23）。
- 该进程启动**之后**的 GLM 会话 `session-c20f43e9`（15:21）的 assistant/message 里仍有：
  ```
  [call:read …] [text:"\n\nname\":\"pwsh\",\"purpose\":\"查看 git 状态、远程仓库、标签与最近提交\",
  \"arguments\":{\"command\":\"git status; …\",\"workdir\":\"D:\\9_Code_Workspace\\dsh-webcode-bridge"]
  [call:read …] [call:pwsh …]
  ```
  即：**调用照常解析执行（tool/result 齐备），但同一条调用的无头尾巴作为正文块漏进了会话**。
- 全天扫描（`.tmp/scan-today-leaks.mjs`）：0.19.23 之后**再无** `json` 四字符泄漏（那一项确实修好了）；
  无头残片仍在（c20f43e9 ×2）。

## 二、根因（reply-log 逐字，不是推测）

`~/.dsh/logs/webcode-bridge-replies.log` 2026-09-26T06:27:40Z（c20f43e9）的原始回复：

```
```json
{"mcp_action":"call","name":"read",…}
```

name":"pwsh","purpose":"查看 git 状态、远程仓库、标签与最近提交","arguments":{"command":"git status; …
…","workdir":"D:\9_Code_Workspace\dsh-webcode-bridge```json
{"mcp_action":"call","name":"read",…}
```

```json
{"mcp_action":"call","name":"pwsh",…}}
``````json
…
```

**网页流的原文本身就含这段无头残片**（GLM 重传/续传调用时把头吃掉、把残片夹在两条完整
调用之间）。桥的防线全部认不出它：

- `findProtocolStart`：残片没有围栏、没有标签、没有行首裸 `{` → -1；
- `partialProtocolAt`：只认标签/围栏半成品；
- `unresolvedCallFenceAt`：认的是落单反引号；
- 于是它一路落到「正文」分支，被 text-delta 逐字发进会话。

## 三、修法（三层，全部只收窄、绝不放宽）

新纯函数 `headlessCallTailAt(text, from, limit)`（`lib/agent-preset.js`）：

1. **语法层（③）**：残片 = 「JSON 对象尾巴」——键的开引号可被吃（`name":` 或 `"name":`）、
   值可以是未闭合的字符串或未闭合的对象、链尾允许逗号/冒号/半成品键。语法里没有
   `mcp_action`，所以**讨论完整调用形状的散文（带 `{"mcp_action"…`）到第一个键就放行**；
   任何散文字符（值引号之外的汉字/字母）让语法失配 → 放行。
2. **键前缀层（②）**：逐字符到达时 `n` → `na` → `name` → `name":` 的每个中间态都扣住；
   前缀之后必须只跟引号/空白/冒号，散文 `name it…` 在 `i` 到达时立即放行（有界，不吞字）。
3. **接线三处**：
   - `lib/index.js` 流式循环：正文外发上限再取 `min(proseLimit, headlessAt)`——残片被扣住，
     等下一个围栏/调用到达后该区间被 `protocolFrom` 越过、自然消化（**不另开解析通路**）；
   - `stripProtocolRegions`：权威散文剔除时把残片随协议区间一起挖掉（收尾补发通道不再复漏）；
   - `proseSafeEnd`：正文安全终点停在残片之前（断流收尾通道同理）。

## 四、验证（全部真跑，附反向变异）

### 4.1 离线重放（`.tmp/replay-headless-fragment.mjs`）

把 reply-log 的真实原文（1664 字符）按三种到达方式喂进真实 `adapter.stream()`：

| 到达方式 | 修复前（0.19.23） | 修复后 |
| --- | --- | --- |
| 整段一次 | 泄漏 | **0 泄漏** |
| 快照切分（真机形态：残片独立成段） | 泄漏 364 字符 | **0 泄漏** |
| 逐字符（人工压力形态） | 泄漏 327 字符 | **0 泄漏** |

三种方式下调用（read/pwsh）都照常解析执行。

### 4.2 语料误伤扫描（`.tmp/scan-headless-false-positive.mjs`）

对全部历史会话的真实 assistant 文本块逐个跑 `headlessCallTailAt`，**扫了两次**：

- 第一次（语法判据首版）：**1308 个**文本块，命中 3 处；
- 第二次（`Kp`/`V` 语法收紧后的**最终代码**，判据面略有加宽，必须重验）：**1341 个**文本块，
  命中 **3 处，全部是真机泄漏残片本身（真阳性），0 误伤**。

两次命中都是同一批残片；**没有一处合法散文被扣住**。

### 4.3 护栏（`test/headless-call-tail.test.mjs`，11 项）

- ① 纯函数：真机残片两种引号形态命中；完整调用/散文/`name it`/引述键名 全部不命中；
- ①c 逐字符中间态**每个都扣得住**（无「放行一瞬」）；
- ② 权威散文剔除 / 安全终点；
- ③ E2E 三种到达方式正文零泄漏、调用照常执行；
- ④ 散文对照：讨论协议形状的正文一字不扣、照常流式外发。

### 4.4 反向变异（两轮都真跑，且确认变异生效）

| 变异 | 预期 | 实测 |
| --- | --- | --- |
| 语法层关掉（`HEADLESS_TAIL_RE` 不执行） | ①/①c/② 应红 | **3 项红**，阴性对照 ①b/①d 保持绿 |
| 流式钳制关掉（`headlessAt = -1`） | ③ E2E 应红 | **3 项红**（正文重新泄漏） |

### 4.5 全量回归（2026-09-26 发布车道实跑，串行独占）

`pnpm test`（= `node --test test/*.test.mjs` + parse + run-m1 + bench-ci + artifacts-check）
**exit 0**：

| 子闸门 | 实测 |
| --- | --- |
| `node --test test/*.test.mjs` | **1094/1094 通过、fail 0、602.8s**（97 个文件，串行独占） |
| `test/parse.test.mjs` | exit 0（在 `&&` 链中通过） |
| `test/run-m1.js` | **M1 RESULT: PASS** |
| `test-mock/bench-ci.mjs` | 4 项整体检查 + 7 条逐判据隔离检查全部符合预期 |
| `test-mock/artifacts-check.mjs` | 8 个生成物被忽略、7 个源文件仍可跟踪 |
| 静态闸门（lint-comments / check-ledger / check-repo-hygiene / check-plugin-contract / commit-msg / ref-index） | 全 PASS（`node scripts/ci-local.mjs --fast` 8/8） |

**环境事实（写下来，免得下一个会话重复踩）**：`node --test` 会为每个测试文件 spawn 子进程并
捕获其 stdio，在**受限文件沙箱**下这一步统一 `spawn EPERM`（97/97 全红，与代码无关）；必须在
放开的权限下跑，读数才算数。并发跑两个测试作业得到的红/慢同样不算读数（本文件上文已记过同型判据）。

## 五、诚实边界（不做乐观声明）

1. **逐字符到达 + 配平收尾的残片**（以 `}}` 完整闭合的尾巴）在「第一个反引号到达」的窗口
   会放行——无法把「已闭合残片」和「后面的半成品围栏」区分开。真机残片全部是截断收尾
   （未闭合字符串），此形态只在人工逐字符驱动下出现；整段/快照切分下它同样被扣住。
2. **残片本身不被执行**：修复是「扣住并随协议区间消化」，完整调用随后在重传快照里照常
   到达并执行（真机 tool/result 齐备）。若某天网页只发残片、不发完整调用，该调用仍会丢
   ——但那是网页侧丢内容，桥无从恢复，且现在至少不再把垃圾铺进会话。
3. `THINKING_ONLY_NO_ANSWER`（GLM 只出思考不出正文）**不是本修复的范围**：那是模型行为，
   桥已有自动续跑处置（0.19.3 提示词 + 0.16.26 思考通道落盘）。
4. **发布边界（2026-09-26 发布车道收口后更新）**：本修复随 **0.19.24** 打包装入双 profile
   （与 DSH STORE 收录契约的 manifest / LICENSE 修正同一车）；代码已在默认分支。但对
   **正在运行**的 `dsh web` 进程（PID 11268）仍需一次重启才生效——重启会终止在跑会话，
   由用户按自己的节奏决定，发布车道不代为重启。
