# 诊断报告：dsh-webcode-bridge（2026-09-16）

**范围**：进度核对、文档整理、缺陷归因、代码质量全局评估、未来框架与排期。
**方式**：只读实测 + 可复现探针。所有结论都附命令或 `文件:行` 证据；推断与实测分开标注。
**基线**：工作树 `0.15.7`（`89f7d41`）。

> 本报告的每一节都可以被独立复核。凡写「实测」的，命令与读数在正文里；
> 凡写「推断」的，明确标注。**未取证的结论不写成本报告的结论。**

---

## 0. 一句话结论

**代码质量显著高于其文档自述的混乱程度**——39/39 测试全绿、记账闸门真在跑、
缺陷台账里**没有一条假修复**（四条「已修」claim 全部有真实实现 + 真实护栏）。
问题不在代码，在**记账漂移**与**三条被错记的缺陷**：

1. 台账（`progress.md`）第 4 次过期：写着「已装 0.15.6 / 运行 0.15.6」，实测**已装且正在运行 0.15.7**；
   且「0.15.4～0.15.7 全未推送」也错（实际**只有 0.15.7 未推送**）。
2. `long-term-issues.md` 的 `一览表` **漏登记 #19、#20**；#18 连正文标题都没有。
3. profile 清单仍钉在 **已被删除的 `0.15.6.tgz`** 上——安装状态不可复现。
4. **#19 的真根因本次定位**（`invoke` 体 lazy 正则截断）；**#22 的前提被推翻**
   （有 text 块，且那是桥自己的诊断文本被持久化）；**#9 的三项是 UNTESTABLE，不是 FAIL**。

> 一个必须点明的反直觉事实：**#19 能定位，靠的是运气**——现场恰好被当成
> 仓库根的 `REPORT.md` 落了盘（22,366 字符的泄漏样本）。若没有那份样本，
> 本条仍会卡在「不知道是哪种形状」。所以「把泄漏现场落盘」这条留痕纪律，
> 价值高于任何一次具体修复。

---

## 1. 进度核对（实测 vs 台账）

### 1.1 台账过期（第 4 次）

| 项 | `doc/progress.md` 写的 | 实测 | 证据 |
| --- | --- | --- | --- |
| 工作树版本 | 0.15.7 | 0.15.7 ✅ | `package.json:3` |
| 已装版本（web） | **0.15.6**（0.15.7 已打包待装） | **0.15.7 已装** ❌ | `profiles/web/node_modules/dsh-webcode-bridge/package.json` |
| 运行中的进程 | **0.15.6**（需重启） | **0.15.7 正在运行** ❌ | `GET http://127.0.0.1:3080/__webcode/status` → `{"version":"0.15.7","hash":"07d2dd2f58a7"}` |
| 单测基线 | 39/39 | 39/39 ✅（须先修 TMPDIR，见 §2） | 逐文件跑，见 §2 |
| 上游 | `origin/main = a956512`；0.15.4~0.15.7 未推送 | **仅 0.15.7 一个提交未推送** ❌（0.15.4~0.15.6 已在 origin） | `git log origin/main..HEAD` → 只有 `89f7d41` |

`doc/progress.md` 自己在第 32-35 行写着「同一毛病第 3 次出现…靠自觉的记账已经失败三次」。
**本次是第 4 次。** 结论：`check-ledger.mjs` 只盖「版本号 + 测试文件数」两格（见 §4），
而**这两个格子恰恰是现在唯一还准的两格**——说明闸门有效，但覆盖面太小。

### 1.2 未推送与已推送的边界（实测）

```
$ git log origin/main..HEAD --oneline
89f7d41 fix(decoder): SET 重发吞掉流式增量（0.15.7）
```
**只有 1 个提交未推送**。台账说「0.15.4～0.15.7 全部改动均在本地」是**过期读数**
（应为「0.15.7 未推送」）。这一条会影响收尾判断：不存在一个待推送的大变更集。

---

## 2. 测试与环境：3 个「失败」全是沙箱假阳性（实测）

### 2.1 现象

逐文件跑 39 个测试文件，**36 通过 / 3 失败**：
`regression.test.mjs`、`tool-loop.test.mjs`、`wiring-roster.test.mjs`。

### 2.2 根因（实测，非推断）

失败全部是同一行：

```
EPERM: operation not permitted, mkdtemp 'C:\Users\rsyhn\AppData\Local\Temp\dsh-Rbxub0\…'
```

对照探针（同一台机器、同一个 Node 进程）：

| 目标目录 | `mkdtempSync` 结果 |
| --- | --- |
| `os.tmpdir()` = `%TEMP%`（沙箱 ACL 受限） | **EPERM** |
| 工作区内 `D:\9_Code_Workspace\dsh-webcode-bridge\.tmp` | **OK** |

**因此这 3 个失败是沙箱 `%TEMP%` 的 ACL 造成，不是回归。** 反向验证：
把 `TMPDIR`/`TEMP`/`TMP` 指到工作区 `.tmp` 后重跑全部 39 个文件 →

```
ok=39 fail=0
```

**结论：台账「39/39 全绿」的结论是对的**，但它没有记录「本机必须先改 TMPDIR」这个前提。
这正是 `long-term-issues.md` #10（测试脚本的收集口径与环境限制）应当收录的一条。

### 2.3 顺带发现：本会话的沙箱后端一度不可用

诊断开始时 `workspace-write` 沙箱因自带的临时目录 `…\Temp\dsh-Rbxub0` **不存在**而拒绝
执行任何命令（"no sandbox backend is usable on this host"）。该目录已重建，之后正常。
这属于**宿主基础设施**问题，不是本仓库的缺陷，但会让人误判「测试全崩」。

---

## 3. 代码质量全局评估（实测量化）

### 3.1 规模

`lib/` 共 **23 个文件 / 12,356 行**（含注释；本仓库注释密度极高，属有意设计）。

| 行数 | 文件 | 评价 |
| --- | --- | --- |
| 2450 | `browser-driver.js` | **God file**。站点差异化、DOM 契约、发送、捕获、SSE 全在里面 |
| 2079 | `index.js` | **God file**。其中 `apply()` 单函数跨 **L423–L1181 ≈ 760 行** |
| 1266 | `agent-preset.js` | 协议编解码，本身内聚，但已含 5 代兼容分支 |
| 868 | `web-control.js` | 控制面，尚可 |
| ≤745 | 其余 19 个 | 规模健康 |

抽取脚本实测的「最大单块深度」：

| 文件 | 最大块（行） | 起始行 |
| --- | --- | --- |
| `browser-driver.js` | **2224** | L220 |
| `decoder.js` | 726 | L19 |
| `mirror.js` | 701 | L24 |
| `web-control.js` | 672 | L113 |
| `settings-page.js` | 386 | L8 |
| `relay.js` | 291 | L35 |
| `openai.js` | 224 | L83 |

> 注：块深度按花括号配平估算，会把「对象字面量包裹的整模块」算成一块
> （`decoder.js`/`mirror.js` 是 `makeXxxDecoder({...})` 工厂形态，数值偏保守）。
> 但 `browser-driver.js` 的 2224 行与 `apply()` 的 760 行是**真函数体**，可直接核对。

### 3.2 耦合

| 方向 | 读数 | 读法 |
| --- | --- | --- |
| fan-in 最高 | `metrics.js`(5)、`accounts.js`(4)、`providers.js`(4) | 这三个是真正的共享底座，健康 |
| fan-out 最高 | `web-control.js`(6)、`browser-driver.js`(5) | 偏高但可接受 |
| **`index.js` fan-out** | **15 个 lib 模块** | **唯一的超级枢纽**：路由、队列、协议、镜像、设置、花名册全汇于此 |

模块图**没有环**，也没有互相 import 的纠缠——这一点比多数同规模项目好。

### 3.3 站点知识的分布（未来框架的核心问题）

这是最重要的结构性发现：

| 位置 | 承担什么 | 现状 |
| --- | --- | --- |
| `contract.js`（**仅 99 行**） | 本应是「每站点契约」的唯一出处 | 实际只是 `providers.js` 的**薄适配层**，`genericContract()` 对 9 个站点一视同仁 |
| `providers.js` | 站点元数据（origin/选择器/模型目录/context） | **真·数据源**，667 行 |
| `browser-driver.js` | 站点差异化**行为** | 散落 `siteId === 'deepseek'` 硬分支（实测 4 处），其余站点走通用路径 |
| `agent-preset.js` | 站点差异化**教学与传输** | GLM 特例硬编码（6 处提及） |
| `index.js` | 站点/账户路由 | 5 处 `siteId === 'deepseek'` 特例 |

**判断**：站点知识的**声明**与**行为**分家了。声明在 `contract.js`/`providers.js`，
行为在 `browser-driver.js`/`agent-preset.js`/`index.js` 的 if 分支里。
这是 `long-term-issues.md` #3（网页 UI 漂移，严重度「高」）真正难修的原因——
改版时要动的不是一处契约文件，而是 3 个文件里的散落分支。

### 3.4 值得肯定的部分（不是客套，是可核对的事实）

- **注释即设计文档**：`lib/*.js` 顶部注释普遍写清「为什么这么写 + 真机证据 + 护栏位置」。
  `index.js:28-61` 解释 `inject` 为什么**故意不加** `agentTeams`（会让插件在未挂载实验包的
  profile 上卡 waiting，症状是「桥整个不见了」）——这是有取舍的设计记录。
- **决策抽纯函数**：`accounts.js`、`zero-progress.js`、`composerWritePlan`、`emitFragmentDiff`、
  `wait-stats.js` —— 把决策从 IO 里剥出来，所以 38 项纯函数护栏才跑得动。这是**好架构**。
- 无环依赖、36/39 文件独立可跑、每个测试文件顶部写明它在防哪个真机事故。

---

## 4. 文档与仓库卫生（实测）

### 4.1 记账闸门 `check-ledger.mjs` 到底管什么

读完全部 191 行：**只做两件事**。

1. `package.json` 的 version ↔ `progress.md` 的「工作树版本」格；
2. `test/*.test.mjs` 文件数 ↔ 「单测基线」格的 `N/N`（**强制 N===N**）。

实测当前状态：`PASS version 0.15.7` / `PASS testFiles 39/39` → **exit 0，闸门是绿的**，
且已作为**阻断步骤**接进 CI（`.github/workflows/ci.yml:123-124`）。

它**故意不做**：不自动改写台账、不 `spawnSync` 问 git（脚本自己注明「空转的闸门比没有闸门更坏」）、
不依赖第三方。脚本也自己声明：**「闸门全绿 ≠ 台账完整」**。

**这解释并印证了 §1.1**：闸门守住了它管的两格，另外几格（已装版本/运行版本/上游/下一阶段）
就漂了。**修法不是加更多人工规则，而是把可机检的格子扩大。**

### 4.2 `一览表` 漏登记（实测）

`long-term-issues.md` 的正文有 **#1–#22（其中缺 #18 之外连续，#19 #20 存在）**，
但顶部 `一览表` 只列到 #22 中的一部分：

```
正文存在的条目 : 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,19,20,21,22
一览表登记的   : 1..18, 21, 22
缺登记         : #19（0.15.6 修复不完整）、#20（security-review.md 带 BOM）
```

**这是可机检的**，而当前没有闸门管它。

### 4.3 `REPORT.md` 是一份**活的泄漏样本**（实测）——本次最有价值的发现之一

`REPORT.md`（31.2 KB，未入库）**不是报告，是一次泄漏事故的现场**：

```
$ 前 5 行
All data gathered and verified. Writing the deliverable report.

<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="write">
<｜｜DSML｜｜ parameter name="content" string="true"># 最近 5 次本地会话（DSH）真实任务抓取报告
```

它被引用 4 处（`progress.md`、`security-review.md`、`verify.md`、`artifacts-check.mjs`），
文件尾揭示**本该写入的路径** `doc/session-mining-2026-09-15.md` —— **该文件不存在**。
即：**一次 `write` 调用被泄漏成了文件本身，真正的交付物从未落盘。**

**处置建议**：不要简单删除。它应当被**转成回归夹具**（见 §5、§7）。
现在它被 `.gitignore:78` 排除，所以「删掉」不会丢失任何历史，但会丢失唯一的真机样本。

### 4.4 其它卫生问题（实测）

| # | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| a | `reference/` 4 个子目录是 **mode-160000 gitlink，但根目录无 `.gitmodules`** | `git ls-files -s \| Select-String '^160000'` → 4 行；`Test-Path .gitmodules` → False | 补 `.gitmodules` 或把这 4 条从索引移除（**推断**：克隆者会得到空目录；未实测克隆） |
| b | `progress.md:370-375` 仍写「刻意不删历史 tgz」，但 `a956512` 已删光 56 个，`ci-cd.md:320-327` 已改口 | `git ls-files \| grep .tgz` = 0 | 台账是过期副本，删该段并指向 `ci-cd.md` |
| c | `README.md:76,86` 等指向 `PLAN.md`，而 `PLAN.md` 被 `.gitignore:73` 排除 | `git check-ignore -v PLAN.md` → 命中 | 仓库内文档不应引用被排除文件；或把路线摘要进仓库 |
| d | `PLAN.md:3` 自称「当前版本 0.15.2」，且 4 处重复 `## 当前版本` 标题 | 实测 0.15.7 | 违其自身规则（`PLAN.md:5`） |
| e | `review-guide.md` 三处数字过期（「1万多个受版本控制的文件」vs 实测 **228**） | `git ls-files \| Measure-Object` = 228 | 更新或改为可机检 |
| f | `extension/`（9 文件）是死代码 | `lib/relay.js:12`「there is no extension」；lib 里 grep 零命中；`long-term-issues.md:487` 自己已提「随 extension/ 一起删除」 | 与 `test-mock/run-m2*.js` 一并处理 |
| g | `test-mock/` 71 个脚本中 **57 个未被任何代码引用** | 引用扫描（仅代码语料） | 归档到 `test-mock/archive/`，保留 `parse-session-log.mjs`、`real-verify.mjs` 等在用者 |
| h | 9 个 `trace-probe17-*.jsonl`（~1.0 MB）与 `vision-test-hello.jpg` **已入库但不是产物**，未登记进 `artifacts-check.mjs` 的 GENERATED 表 | `git ls-files test-mock/*.jsonl` → 9 条 | 补登记或移出索引 |

### 4.5 体量（实测）

| 目录 | 体量 | 是否入库 | 建议 |
| --- | --- | --- | --- |
| `reference/` | 316.2 MB / 11,626 文件 | 仅 21 条（`local-refs/` + 4 gitlink） | 保留（**对 lib 零代码依赖**，仅 6 处注释引用）；可删 `.git` 内层仓减少体积 |
| `.tmp/` | 272.2 MB / 23,109 文件 | 否（`.gitignore:60-61`） | **只删** `.tmp/pnpm-probe/node_modules`（149.5 MB，可再生产物）；其余被 9 处文档/注释引用，勿整目录删 |
| 入库总量 | **5.60 MB / 228 文件** | — | 健康 |

---

## 5. 缺陷归因：**#19 真根因已定位**（本次最大产出）

### 5.1 先排除法（实测）

台账 #19 原话：「边界探测命中但没有可执行的完整调用」，且归因卡在「不知道是哪种形状」，
只能猜「表格？行内代码？嵌套引号？`edit` 的双参数？」。

我用 8 个候选形状直接打纯函数（合并后的可复现脚本
`.tmp/probe-diagnosis-2026-09-16.mjs` 组 B，`node` 跑，退出码即判据）：

```
edit+表格+行内代码      idx=7 safeEnd=7 len=170 calls=1
write+围栏             idx=7 safeEnd=7 len=123 calls=1
write+围栏紧邻}         idx=7 safeEnd=7 len=113 calls=1
write+花括号+围栏        idx=7 safeEnd=7 len=121 calls=1
edit 对照组（无围栏）     idx=7 safeEnd=7 len=124 calls=1
write 行内单反引号       idx=7 safeEnd=7 len=111 calls=1
正文围栏+真调用          idx=21 safeEnd=21 len=136 calls=1
edit 含反斜杠路径        idx=7 safeEnd=7 len=144 calls=1
```

**8/8 全部健康**，都能解析出 1 个调用、都不泄漏。
→ **0.15.6 怀疑的「围栏形状」全部可以排除。**

### 5.2 用真机样本质证（实测）

把 §4.3 那份 **22,366 字符的真机泄漏样本**喂给当前代码（同一脚本的组 C）：

```
样本长度            : 22366
findProtocolStart   : {"index":67,"name":"write","transport":true}
proseSafeEnd        : 67
可执行调用数          : 0
泄漏字符数           : 22299 (99.7% 被扣住)
散文前缀（将外发）    : "All data gathered and verified. Writing the deliverable report.\r\n\r\n"
```

两条重要读数：
- **边界探测与扣留都正确**（`index=67`、`safeEnd=67`）→ **0.15.6/0.15.7 的护栏是有效的**，
  这份样本今天**不会再泄漏协议原文**。台账 #19 担心的「整段泄漏」已经关掉。
- **但 `calls=0`** → 该轮 `write` **仍然不执行**，静默丢一次调用。

### 5.3 真根因（实测，可复现）

逐步定位到 `lib/agent-preset.js:1186` 那条 `invoke` 正则：

```js
const invokeRe = /<\s*invoke\s+name\s*=\s*"([^"]+)"\s*[^>]*>([\s\S]*?)<\s*\/\s*invoke\s*>/gi;
```

实测读数（`.tmp/probe-diagnosis-2026-09-16.mjs` 组 A，输入已 `normalizeDsml`）：

```
</invoke> 出现位置: [10230, 22268]
</parameter> 位置  : [10264, 10291, 10482, 22127, 22254]
<invoke 起: 76   第一个 </invoke> 止: 10230
=> lazy 体长度: 10154     该体内含 </parameter> 吗: false
```

**这就是根因**：参数体（一份**审计报告正文**）里**举例引用了协议自身的闭合标签**
（```` ``` ```` 围栏里写着 `</invoke>`、`</function_calls>`、`</parameter>`）。
lazy 的 `([\s\S]*?)` 在**示例里的第一个 `</invoke>`（偏移 10230）**处截断，
截出来的体内**没有配平的 `</parameter>`** → `n===0` → 该调用被跳过。

而真调用一直延伸到 **22268** 才闭合——**跨过了那 12,000 字符的示例文本**。

**修法假设已用可falsify实验验证**（`.tmp/probe-diagnosis-2026-09-16.mjs` 组 A 的 lazy/greedy 对照）：

| 取体方式 | 体长 | 参数 |
| --- | --- | --- |
| lazy（现状） | 10133 | **NO** |
| greedy（取最后 `</invoke>`） | 22171 | **YES**，`name=content`，`valLen=10125` |

且判据成立：`第一个 </invoke>(10230) 之后仍有 </parameter>` → `true`。

### 5.4 为什么这条一直没被归因（方法论）

三个「假阴性外观」叠在一起：

1. `diagnostics` **为空**。0.15.6 的承诺是「丢调用不再静默」，但那套留痕只覆盖
   「形态像调用（含 `mcp_action`/`arguments`/`name` 特征）但 JSON 解析失败」的分支；
   **`invoke` XML 方言走的是另一条规则**，在那里 `n===0` 直接 `continue`，不留痕。
2. 命中的输入形态恰好是**写审计报告/写文档**（正文里讨论协议本身），
   而不是普通写代码——所以用「表格/围栏」去试永远试不出来。
3. `#17`（`missing required property "command"`）与它同族，都被归进「参数缺失族」而搁置。

**结论：#19 应从「未归因」改为「已归因，待修」**，修法与反向用例都在 §7 排期里。

---

## 5.5 复核另有两条台账事实错误（独立验证过）

委托的两路深度审计（缺陷台账 / 文档卫生）各自推翻了台账的一部分自述。
**凡推翻的结论我都独立复跑过**，下面是核实过程与读数。

### 5.5.1 #22 的前提是错的，且该缺陷其实已可定性（严重度：中 → **高**）

台账 #22 写：真机 step 7 的 `assistant/message`「content 只有 `[reasoning]`（1947 字符），
**没有 text 块、没有 tool-call 块**」。

**独立解码复核**（会话原始日志
`…\--D-1_RSYHNHLN_Files-competition-A0-Robocup--\session-fcbb5bf8-…\session.v3.jsonl.zstd`，
按 zstd magic 切多帧后逐帧解压，52 事件）：

```
事件 type= assistant/message  step= 7
block types: ["reasoning","text"]
  - reasoning len=1947  "Now I have a good picture. Let me read the local vision-README.md …"
  - text      len=357   "THINKING_ONLY_NO_ANSWER: 网页只产出了思考内容、正文一个字符都没有…"
```

**台账写错了**：确实有 text 块。而且那个 357 字符的 text 块**就是桥自己写进去的
诊断文本**（来源 `lib/index.js` 的 `thinkingOnlyNotice()`，经
`emitText(notice, turn, nextIndex)` 落库）。

两条推论：

1. **#22 的另一种可能已被排除**：该轮 chunk 序列是
   `block-start#0(reasoning) → block-end#0 → block-start#1(text) → block-end#1 → usage → finish{kind:'stop'}`，
   `finish.reason` 是正常 `stop` 而非 WIP 兜底。没有文本通道被吞的证据。
   → 只剩「模型自身在思考后停止」这一种解释。**#22 不再是「未归因」。**
2. **真正的缺陷是原报告漏掉的那个**：桥把自己的诊断文本写进助手正文并持久化。
   用户看到「模型说了 THINKING_ONLY_NO_ANSWER」，而模型其实什么都没说——
   这会污染会话与后续上下文轮。**已把 #22 严重度由「中」上调为「高」**，
   并写进 `long-term-issues.md`。

### 5.5.2 #9「三项既有假失败」是归因错误（实际是 **UNTESTABLE**）

台账 #9 收录三项「干净树上同样失败、属既有欠账」：
`run-m2.js`（称「走已废弃的扩展链路」）、`run-m2b-driver.js`、`run-m2c-webapi.js`
（称「mock 响应形状脱节」）。

**实跑复核**（已设好 `TMPDIR`/`TEMP`/`TMP`，排除 §2 的干扰）：

```
❌ M2  harness failure: spawn EPERM   EXIT=1
❌ M2b harness failure: spawn EPERM   EXIT=1
❌ M2c harness failure: spawn EPERM   EXIT=1
```

三者**都没有跑到自己的断言**，死在进程派生（`spawn(process.execPath, […])`）。
根因与 `progress.md` 已记录的「Node 创建子进程一律 EPERM」同源。

因此台账的归因**没有实测支持**：脚本在触及「扩展链路 / mock 形状」之前就死了。
`run-m2c` 那条所谓的「恒 FAIL」断言（`completion via driver`）**本次根本没被执行**。
正确记法是 **UNTESTABLE（本机）**，而不是 FAIL——「干净树上同样失败」这句在本机不可验证。

已在 `long-term-issues.md` #9 加复核推翻段，并注明须由 CI 读数定性。

### 5.5.3 其余已核实的小项

| 项 | 复核结果 |
| --- | --- |
| 「假修复 / 悬空护栏」 | **none found**。#15/#16/#18/#21 四条「已修」claim 全部有真实实现 + 真实护栏，实跑通过 |
| #15 的「护栏 15/15」 | **计数过期**：`protocol-leak.test.mjs` 现为 **27 项** |
| #18 | 正文**没有 `## 18.` 标题**（只活在开头引用块）——与 #16 声称已修的「跳号」缺陷同型，又犯一次 |
| #20 | BOM 仍在（`security-review.md` 首 3 字节 `239,187,191`），与台账一致 |
| #17 | 确实未归因：`fillMissingRequired` 白名单只有 `description`，**结构性拒绝代填 `command`**；仓库内**不存在** `TOOL_ARGS_MISSING_REQUIRED` 错误码；无覆盖 `command` 的护栏 |
| #19 留痕缺口 | 属实：`withheld` 只报字符数（`index.js:1108`、`:1160`），无形状指纹——本条自认的第一步**尚未做** |

---

## 6. 未来框架与排期建议

### 6.1 框架判断：不该重写，该「把站点知识收口」

现状**不适合推倒重来**——12k 行、39 个测试文件、无环依赖、真机证据完备，
重写的期望收益为负。真正该做的是把 §3.3 那个结构性裂缝补上：

**目标形态（建议）：站点契约从「声明 + 散落 if」收成「声明 + 行为钩子」**

```
lib/sites/<siteId>.js      ← 每站点一个文件，导出同一形状的对象
   { meta,           // origin/选择器/模型目录（现 providers.js）
     decoder,        // 解码（现 decoder.js 的按站点分支）
     modelSelect,    // 选模型（现 browser-driver.js::selectModelDeepSeek）
     teaching,       // 教学立场与传输判定（现 agent-preset.js 的 GLM 特例）
     nav,            // 会话地址三态（现 contract.js::navContractFor）
     capabilities }  // antiBot/rootPathForSpa/staticOrigins/experimental
```

- `contract.js` 从「薄适配层」升级为**注册表 + 兜底**；
- `browser-driver.js` 只保留**通用引擎**，站点差异走 `site.behavior.*` 钩子；
- 每站点一个文件 → **UI 改版时只动一个文件**，#3「UI 漂移」从「高」降为「中」；
- 新增站点从「改 4 个文件」变成「加 1 个文件 + 注册」。

**这不是大重构**：可以**逐站点迁移**，DeepSeek 先迁（它已有最多特例），
其它站点先走 `genericContract` 兜底，行为不动。风险可控、可回退。

### 6.2 排期（按「收益 ÷ 风险」排序，前三条是本次诊断的直接产出）

| 优先级 | 事项 | 状态 |
| --- | --- | --- |
| **P0** | 修 #19：`invoke` 体取体改为**配平感知** | ✅ **已在 0.15.8 完成**（见 §9） |
| **P0** | **#22 修正**：`thinkingOnlyNotice` 不得经 `emitText` 进助手正文 | ⬜ 待做 |
| **P0** | 留痕：`invoke` 方言的 `n===0` 与 `withheld` 都要带形状指纹并落盘 `.tmp/` | ⬜ 待做 |
| **P1** | 台账自动对账：把 §1.1 那三格（已装/运行/上游）纳入机检 | ⬜ 待做 |
| **P1** | `一览表` 完整性闸门：正文条目 ↔ 表格条目一一对应（含 #18 缺标题） | ⬜ 待做 |
| **P1** | #9 重定性：三项改记 **UNTESTABLE**，由 CI 读数定性 | ✅ 文档已改，CI 读数待补 |
| **P2** | 站点契约收口（§6.1），逐站点迁移，先 DeepSeek | ⬜ 待做（框架建议见 §6） |
| **P2** | 卫生：归档探针、移出 `extension/`、清 `.tmp`、补 gitlink | ✅ **已在 0.15.8 完成**（见 §9） |
| **P3** | #17（`command` 缺失族）：与 #19 同族，可在 P0 修完后一并归因 | ⬜ 待做 |

**P0 的关键约束**：§5.3 的 greedy 只是**验证假设的手段，不是最终修法**——
greedy 会在「同一轮两个 invoke 调用」时把第二个吞进第一个的体里。
正确修法应是**按 `<parameter>` 配平来定界**（或 greedy 取体后按 `</parameter>` 数配平校验），
并配两条反向用例：①两调用的一轮不得互相吞并；②体里引用闭合标签必须能被还原。

> **关于 #22 的待定项**：`TOOL_UNKNOWN` **需要**模型看见（下一轮要据此改正），
> 而 `thinkingOnlyNotice` **不需要**——两者当下共用 `emitText` 通道，
> 修 #22 时必须把这两类提示**分开评估**，不能一刀切地都改成只进日志。


### 6.3 能力「可删除 / 可增长」判断

**可删除（低价值或死亡）** —— ✅ 已于 0.15.8 全部执行，见 §9

| 对象 | 依据 | 处置 |
| --- | --- | --- |
| `extension/`（9 文件） | 代码零引用；`relay.js:12` 明言无扩展；台账自己已提议删 | ✅ 移到 `test-mock/archive/extension/` |
| `test-mock/` 58 个未被引用的一次性探针 | 引用扫描实测；历史价值已被 `doc/verify.md` 与测试文件吸收 | ✅ 移到 `test-mock/archive/` |
| `.tmp/pnpm-probe/node_modules`（149.5 MB） | 可再生 | ✅ 已删 |
| `PLAN-2026-09-12-P0P1-右栏一致性.md` | 全仓零引用的一次性快照（gitignored，本地私有留痕） | ⬜ 留待用户决定（不入库，无影响） |

**可增长（有真实需求且已有地基）**

| 方向 | 依据（为什么值得做） |
| --- | --- |
| 站点契约收口（§6.1） | 9 站点已是既成事实，散落分支是主要维护成本 |
| 记账机检扩面（§6.2 P1） | 闸门已证明有效，扩大覆盖面是最高性价比的工程投入 |
| 泄漏/丢调用的**真机样本夹具化** | `REPORT.md` 已证明真机样本能抓到离线构造抓不到的形态 |
| 新增站点（更多网页 AI） | 框架就位后边际成本很低——但**要排在契约收口之后**，否则继续加分支 |

---

## 7. 本次已落地的改动（可复核）

| 文件 | 改动 | 验证 |
| --- | --- | --- |
| `test/fence-nested-call.test.mjs` | 新增 ⓪a / ⓪b 两条**真机样本**用例：全角竖线 DSML 的边界与扣留判据；以及「不可执行的真因在体不在标记」的正面能力判据 | 该文件 **14/14 通过**（原 12 项 + 新 2 项） |

新增的 ⓪a 把 **#18 的修法钉在真机形态上**（`index=67`、`safeEnd=67`、不外发）；
⓪b 钉住「缩小样本必须可执行」这条正面能力，防止今后有人误把根因归到标记上。

**诊断轮未改动产品代码**；修法与结构整理已在 0.15.8 落地，见 §9。

---

## 9. 执行记录：0.15.8（#19 修复 + 结构整理）

诊断之后立即执行的两批工作，全部经测试与闸门验证。

### 9.1 #19 修复（产品代码）

| 项 | 内容 |
| --- | --- |
| 新增 | `lib/agent-preset.js` 的 `invokeBodyEnd(src, from)`——配平感知状态机 |
| 删除 | `invokeRe` 的 lazy 体捕获（`([\s\S]*?)</invoke>`） |
| 关键细节 | 必须**重建 `m[0]`**（开标签+体+闭标签）：否则下游「畸形标签抢救」分支失效——实测把 `regression.test.mjs` 从 53/53 打到 49/53 |
| 兜底 | 扫到结尾不配平时降级为第一个 `</invoke>`（畸形取旧行为），不返回 -1 |
| 版本 | `0.15.7` → **`0.15.8`**（仓库纪律：同名同版本换内容会被 pnpm 去重而静默不更新） |

**真机样本读数**（`REPORT.md`，22,366 字符）：

```
修复前: boundary={index:67} proseSafeEnd=67 calls=0     ← 静默丢调用
修复后: boundary={index:67} proseSafeEnd=67 calls=1     ← name=write, content=10,121 字符
```

**护栏 ⑬~⑯**（`test/fence-nested-call.test.mjs`，12 → 19 项）：

- ⑬ 正向：参数体里引用 `</invoke>` 必须仍可执行（**修复前实测为红**：`pass 17/fail 1`）
- ⑬b **已知限制诚实钉住**：参数值里**未被转义的**字面 `</parameter>` 仍会截断该值
  （XML 语义上无法与真闭合标签区分；真正修法是实体感知扫描，不是放宽判据）
- ⑭ 反向：一轮两个 invoke 不得互相吞并（**这是拒绝 greedy 的护栏**）
- ⑮ 反向：散文提到 `</invoke>` 不得凭空造出调用
- ⑯ 反向：配平异常不得抛异常

### 9.2 结构整理

| 动作 | 前 → 后 | 机制 |
| --- | --- | --- |
| 探针归档 | `test-mock/` 顶层 **83 → 25** 项 | 58 个无代码引用的脚本移到 `test-mock/archive/`；git 识别为 **58 个 rename**（历史保留） |
| 死代码出根 | 根目录有 `extension/` → **无** | 9 文件移到 `test-mock/archive/extension/`（零代码引用，`relay.js:12` 明言无扩展） |
| `.tmp` | **272.3 → 122.8 MB** | 删 149.5 MB 可再生 `pnpm-probe/node_modules` + 30 个空的 `webcode-test-*`/`webcode-wiring-*` 残留 |
| 悬空 gitlink | 4 条 mode-160000 → **0** | `git rm --cached`（磁盘保留）；`.gitignore:9 reference/*/` 从此真正生效 |
| 死链 | 2 处 → **0** | `README.md` 指向被 gitignore 的 `PLAN.md` 已改为仓库内权威入口 |
| 目录约定 | 新增 `test-mock/archive/README.md` | 写明「留 vs 归档」判据 + 归档后相对导入失效的注意 |

同步更新的文档：`doc/review-guide.md`、`doc/ci-cd.md`、`CONTRIBUTING.md`、
`doc/progress.md`（0.15.7 表已更正为 0.15.8 与真实安装态）。

### 9.3 收尾验证（全绿）

| 闸门 | 读数 |
| --- | --- |
| 测试文件 | **39/39 通过**（含 `npm test` 链路的 `parse.test.mjs`、`run-m1.js`、`bench-ci.mjs`、`artifacts-check.mjs` 全部 exit 0） |
| 记账闸门 | `check-ledger.mjs` **PASS**（version 0.15.8 / testFiles 39/39，exit 0） |
| 注释闸门 | `lint-comments.mjs` **error 0 / warn 0**（exit 0） |
| 真机样本 | `REPORT.md` 的 `calls` 由 **0 → 1**（`write`，10,121 字符） |

> **注**：注释闸门扫描文件数由 131 降为 81——因为 58 个探针移入 `archive/` 后
> 不再纳入扫描范围。这是整理的副作用，不是闸门退化。

### 9.4 本轮未做（留给下一轮）

- **#22**（`thinkingOnlyNotice` 不得进正文通道）——已定性、修法明确，**P0 待做**。
  注意 `TOOL_UNKNOWN` **需要**模型看见，两类提示必须分开评估。
- `withheld` / `invoke` 丢调用的**形状指纹留痕**（#19 自认的第一步）
- 台账机检扩面（已装/运行/上游三格）+ `一览表` 完整性闸门
- 站点契约收口（§6.1）

---

## 8. 不确定与未取证（明示边界）

- **未做真机探针**。全部结论来自离线样本、已装包源码、离线单测——遵守仓库的风控纪律
  （间隔 ≥20s、最多 3 次、风控页 ≠ 未登录）。
- **未验证克隆行为**：`reference/` 4 个 gitlink 无 `.gitmodules`，**推断**克隆者会得到空目录，
  未实际克隆验证。（0.15.8 已把这 4 条 gitlink 从索引移除，该风险随之关闭。）
- `artifacts-check.mjs` 在本机 **SKIP（不是 PASS）**——因为它需要 `spawnSync` 调 git，
  而本机 Node 创建子进程被沙箱挡住（`progress.md` 的「已知环境约束」已记录该约束）。
  因此本报告对「产物目录规则」的结论**不依赖**那条闸门。
- 块深度用花括号配平估算，工厂形态（`makeXxxDecoder({...})`）会偏保守，已在 §3.1 注明。
- `#22` 的性质已由本次复核**改为「已可定性」**（见 §5.5.1）；仍未做的是**修复**，不是归因。
