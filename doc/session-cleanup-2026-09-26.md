# 会话清理记录（dsh-webcode-bridge，2026-09-26）

## 一句话

本项目下 257 条会话里，**19 条真的什么也没产出、已删除**（备份保留）；另有
**52 条「一轮没跑成」但确实产出了东西**，故意**没删**，列在下面等人看。
删掉的每一条都能从备份一键还原。

## 为什么要清

用户要求清两类会话：**没进行过一轮的**、**第一轮就报错失败的**。
按这两个字面判据一扫就是 118 条 —— 但那个数是错的，见下面「判据修正」。
真正该清的是 **19 条**，占 257 条的 7.4%。

## 判据修正（三条，都是实测踩出来的）

### 1. 「第一轮 reason≠completed」不等于「这条会话废了」

第一版判据只看第一轮。结果 `session-0f9fe6cf` 被判成废物 —— 它有 **12 轮**，
其中 **5 轮 completed**，只是第一轮被用户按了停止。

现在的判据是两条同时成立才算失败：

1. 第一轮的收束原因不是 `completed`，**且**
2. 整条会话**一轮都没 completed**（一次都没成过）。

`aborted` / `interrupted` 是**用户按停止**，由上方独立归成 `aborted-no-completion`
一类，**不参与清理**。22 条。

### 2. 「一轮没跑成」不等于「没价值」

分类只回答「这一轮跑成了没有」。删之前的 71 条候选里，**20 条带着真实产出**：

| 会话 | 规模 | 产出证据 |
| --- | --- | --- |
| `session-2f8975a0` | 674KB | 135 个 step / 133 次工具调用 / **4 次 goal 变更**，最后停在 `goal/change: pause`（目标还挂着） |
| `session-69d44b56` | 886KB | goal + todo，正文 4062 字 |
| `session-9de3fbfd` | 803KB | 4 次 goal 变更，正文 6796 字 |
| `session-5d08018b` | 686KB | **正文 34876 字** |
| `cbb933a9` / `8b2598fa` | 282KB / 228KB | `deliverables/presented` 交付物事件 |

删掉 `session-2f8975a0` = 那 133 次工具调用的经过、那个还挂着的目标，全部消失。
所以判据加了一条：**有 goal / 交付物 / team 状态 / todo / 成篇正文（>2000 字）的一律不自动删。**

> 判据只认「模型真干了活」的信号。`session/end-seed` **不算** —— 它只是日志播种
> 边界标记，连那条 684 字节、零轮的会话里都有一条；`session/title` 也不算，
> 它只根据首轮提示词生成。

### 3. 子代理会话不能先于父会话消失

删之前候选里有 **25 条是子代理**（`origin=subagent`），其中 **20 条的父会话是正常保留的**
（最大的父会话 2.4MB）。子代理的日志就是父会话里那次委派的全部经过；父会话留着、
子代理删了，用户点回父会话时那段历史就凭空消失。

现在的判据是「**整条链都得是垃圾**」：父会话自己也在待删集里，才放行子会话。
否则会出现「删了孩子、留着爹」——爹的日志里那些调用指向不存在的会话。

### 4. 明确写着「可重试」的失败不算废

`session-63bd1b99`（4 轮、223KB）最后死在桥**自己**的 30 秒重建节流
（`WEB_SESSION_REBUILD_THROTTLED`，重放了 127895 字符）——隔 30 秒重发就能接着跑。
这类「瞬态」一律不自动删。

## 实际删掉的 19 条

全部是**零产出**：既没有 goal / 交付物 / todo，正文也不足 2000 字。

| 类别 | 条数 | 判据 |
| --- | --- | --- |
| `zero-turn` | 1 | 没有任何 `turn/start` —— 打开就关 |
| `first-turn-failed` | 18 | 真失败且一次都没跑完，且无产出、无活着的父会话、错误不可重试 |

合计 0.6 MB。典型：

- `session-8182608c`（1KB）—— 全文只有 6 条事件，最后一条是 `session/end-seed`，
  即「建了会话、什么也没输入就关了」。
- `session-0a62dbb8` / `session-3756a994` / `session-d3593a14` —— `PROMPT_TRUNCATED`：
  提示词超过网页输入框上限（如 98894/98933 字符），**整轮没发出去**。
- `session-098cf14b` —— `locator.press` 超时，连输入框都没找到。
- `session-6b0bd985` —— `NEED_LOGIN`，站点没登录。

## 失败原因台账（71 条「一轮没跑成」的整体分布）

按桥的错误码归类，括号内为条数。**归因依据是桥自己的错误文案**，不是推测。

### A. 站点/网络侧（环境问题，多数可重试）

| 错误码 | 条数 | 含义 | 现在怎么处理 |
| --- | --- | --- | --- |
| `PROMPT_TRUNCATED` | 7 | 提示词超过网页输入框上限，**整轮没发出去** | 缩短上下文或先 `/compact` |
| `RATE_LIMITED` | 5 | 站点限流 | 桥按 max(发送间隔, 10s) 退避重试 |
| `empty response from web AI` | 7 | 流结束了但没正文（含 `partial-wip-settled` / `finished` 两种收束原因） | 重试 |
| `web capture ended incomplete` | 7 | 捕获中断：`no_response_frames`（一条响应帧都没来）/ `incomplete` | 重试 |
| `WEB_NO_PROGRESS` | 9 | 适配器 120s 看门狗：页面还在、有回复字未回传 | 本轮中止，可重试 |
| `webcode relay: request timed out` | 2 | 中继超时 | 重试 |
| `Insufficient Balance` / `HTTP 503` / `HTTP 500` / `HTTP 524` / `status code (no body)` / `Concurrency limit` | 各 1–4 | 上游账户或网关问题 | 环境问题 |

### B. 桥自身（有明确修复方向）

| 错误码 | 条数 | 含义 |
| --- | --- | --- |
| `WEB_SESSION_REBUILD_THROTTLED` | 1 | 桥自己的 30 秒重建节流命中；隔窗口重发即可（**不是废会话**） |
| `TOOL_PROTOCOL_INVALID` | 4 | 工具参数不完整/调用顺序不一致（如「流式已开块 read；解析结果 grep, read」） |
| `STREAM_REWRITE` | 2 | 网页重写了已输出内容 |
| `NEED_LOGIN` | 1 | 站点登录态缺失 |

### C. 用户主动停止

`aborted` / `interrupted`：**22 条**，归入 `aborted-no-completion`，**不参与清理**。

## 还剩什么 / 没做什么

- **52 条「待人工复核」原样保留**（12.3 MB）。它们一轮没跑成，但带 goal / 交付物 /
  todo / 成篇正文，或挂在活着的父会话下。脚本只列清单，不替人做决定。
- 复核清单：`node scripts/dsh-session-cleanup-scan.mjs --cwd <项目>` 会打印
  「待人工复核」段，每行带 `workSignals`（如 `goal×4 todo×3 assistantText=56473ch`）。
- **没有**碰其它工作区的会话，也**没有**碰 `.dsh/webcode/` 下的网页会话镜像。

## 怎么还原

删除前每个会话目录整份复制到了备份根，层级与原来一致：

```
C:\Users\rsyhn\.dsh\dsh-session-archive\pruned-2026-09-26\
  manifest.json                                   ← 删了什么、备份在哪
  --D-9_Code_Workspace-dsh-webcode-bridge--\
    <sessionId>\session.v3.jsonl.zstd
```

还原一条：

```powershell
$root = "$env:USERPROFILE\.dsh\dsh-session-archive\pruned-2026-09-26\--D-9_Code_Workspace-dsh-webcode-bridge--"
$dest = "$env:USERPROFILE\.dsh\sessions\--D-9_Code_Workspace-dsh-webcode-bridge--"
Copy-Item "$root\session-0a62dbb8-21ee-41de-a70a-f22acf85ad0e" $dest -Recurse
```

全还原（19 条）：

```powershell
$root = "$env:USERPROFILE\.dsh\dsh-session-archive\pruned-2026-09-26\--D-9_Code_Workspace-dsh-webcode-bridge--"
$dest = "$env:USERPROFILE\.dsh\sessions\--D-9_Code_Workspace-dsh-webcode-bridge--"
Get-ChildItem $root -Directory | Copy-Item -Destination $dest -Recurse
```

## 复现这次清理

```powershell
cd D:\9_Code_Workspace\dsh-webcode-bridge

# 1. 扫描（只读）：出报告 + 人读清单
node scripts/dsh-session-cleanup-scan.mjs --cwd . --json .tmp\cleanup-scan.json

# 2. 预演（不动任何文件）
node scripts/dsh-session-cleanup-apply.mjs --scan .tmp\cleanup-scan.json

# 3. 真删（先备份到 dsh-session-archive\pruned-<日期>，备份成功才删）
node scripts/dsh-session-cleanup-apply.mjs --scan .tmp\cleanup-scan.json --apply
```

脚本自己不做分类判断 —— 想改判据就改 `dsh-session-cleanup-scan.mjs`，
`dsh-session-cleanup-apply.mjs` 只执行报告里的 `safeToDrop` 集合，拿不到该字段就报错停下。

## 本次执行的读数

| 项 | 值 |
| --- | --- |
| 扫描范围 | `D:\9_Code_Workspace\dsh-webcode-bridge`（257 条，含子代理） |
| `ok`（至少一轮跑完） | 164 |
| `aborted-no-completion`（用户停止） | 22 |
| 一轮没跑成（`prunable`） | 71 |
| └ 可安全清理 → **已删** | **19** |
| └ 待人工复核 → 保留 | 52 |
| 保留合计 | 238（257 − 19） |
| 删除失败 | 0 |
| 删除总量 / 备份量 | 0.6 MB / 19 个目录，逐条校验文件数一致 |
| 父子链断链 | 0（删前删后都校验过：无「删了孩子留着爹」，也无「删了爹留着孩子」） |

## 工具

| 文件 | 作用 |
| --- | --- |
| `scripts/dsh-session-cleanup-scan.mjs` | 扫会话、分类、标 `hasWork`、算 `safeToDrop`（只读） |
| `scripts/dsh-session-cleanup-apply.mjs` | 按报告删（默认 dry-run，`--apply` 才真删，先备份后删） |
| `scripts/session-read.mjs` | 已有的会话读取入口（本次复用它解多帧 zstd） |

> 落盘格式坑：会话是**多帧 zstd**，一条事件一帧。`zstdDecompressSync(整个文件)`
> 只解**第一帧**（就是那个 220 字节的 `{"type":"session",…}` 头），文件明明 1.3MB
> 却只解出 220 字节，看起来「日志是空的」。必须按帧切开逐帧解 ——
> `scripts/session-read.mjs` 的 `decodeZstdFrames` 已经处理好了。
