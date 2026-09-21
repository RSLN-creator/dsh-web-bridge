# 审查报告：0.17.0 / 0.17.1（含 0.16.40 溯源）

> 审查对象：0.17.0 之后的改动。被 @ 引用的会话是 `session-2e148fda-f412-4b0a-9c7a-62df1a91886f`，
> 由 provider `little-gemini` / model `gemini-3.8-flash` 驱动（`~/.dsh/settings.yaml` 的
> `little-gemini` 段：`api: anthropic-messages`、`baseURL: https://api.littlecold.cn`）。
> 本报告只写**实测到的事实**，每条结论都带取证命令或文件坐标。

## 0. 结论摘要

| 维度 | 判定 |
| --- | --- |
| 代码能否跑 | **能**。全量 861/861 绿（exit 0，399s）；`verify-pack` 41/41 逐字相同 |
| 0.17.1 的 `arg_value` 解析 | **实现可用**，我独立喂四种形状全部解析成功；但台账写的取证依据**不成立**（§3） |
| 0.17.0 的「等待占比」 | **有真缺陷**，线上正在显示 `100%`（§2，已实测复现）——**已修，见 §7.1** |
| 交付卫生 | **差**。28 改 + 28 未跟踪，**零提交**；0.17.0/0.17.1 无 tag（§4）——**已入库，见 §7.3** |
| 装机一致性 | **web 正确、headless 装错、嵌套 tgz 陈旧**（§5）——**已统一，见 §7.4** |
| 计划完成度 | 计划 **0/33 勾选**，但其中多条实际已做完（§6） |

> **第 7 节记录同一会话内已落地的全部修复**（0.17.2）。第 1–6 节保留首轮审查的
> 原始判定（含当时的读数），不回头改写。

---

## 1. 基线核验（先证明「审的是哪一份」）

```
node scripts/verify-pack.mjs dsh-webcode-bridge-0.17.1.tgz
  → 逐字相同 41/41，接线完好，tarball 与工作树一致
node --test test/*.test.mjs
  → tests 861, pass 861, fail 0, exit 0
```

线上服务实测（`GET http://127.0.0.1:3080/__webcode/status`，审查当时）：
`build.version = 0.17.1`、`build.hash = d392d43013a9`、`driver.siteId = deepseek`。

三个 profile 的实际内容（逐文件比字节）：

| profile | `package.json` 声明 | 实测内容 |
| --- | --- | --- |
| web | 0.17.1 | **与工作树逐字相同** ✔ |
| headless | 0.17.1 | `settings-page.js` 33,909 字节 = **0.16.40 的内容** ✖ |

---

## 2. 【真缺陷】0.17.0 的「等待占比」在线上读出 100%

**这是本轮唯一一个「用户现在就能看见」的错。**

占比分母是 `totalWaitMs + totalDurationMs`，而 `totalDurationMs` 是 **0.17.0 才引入**的
字段；账本却**落盘且跨版本延续**（`webcode-wait-stats.json`）。升级那一刻，磁盘上的
老账本里 8000+ 轮的历史耗时**全是 0**。

线上实测（`POST /__webcode/wait-stats`）：

```json
"total": { "totalWaitMs": 113215468, "totalDurationMs": 521868, "turns": 8579 }
"rows":  [ { "label": "平均会话等待时长占比", "value": "100%" } ]
```

31 小时的等待对上 8.7 分钟的耗时 —— 但那 8.7 分钟只是**最近几轮**的，8579 轮里绝大多数
发生在 `durationMs` 存在之前，分母贡献是 0。于是设置页把「平均会话等待时长占比 **100%**」
当结论印给用户：这台机器上的时间几乎全花在节流上。

占比公式没错，错在**分母的覆盖范围与分子不一致**。判据应是「耗时记账覆盖了几轮」，
而不是「耗时 > 0」。

**修法（方案已逐步验证过，本轮未落地，理由见 §7）：**

1. 账本加 `durationTurns`：只有 `durationMs > 0` 的轮次才 `+1`；
2. `sanitizeWaitStats` 对旧账本**不向后推断**，缺失即 0（= 覆盖为零）；
3. 三种读数：全覆盖 `61%` / 零覆盖 `未记录` / 部分覆盖 `61%（覆盖 40/57 轮）`；
4. 顺带修 `formatPercent`：`99.6%` 走 `Math.round` 会印成 `100%`，把「只差一点」说成
   「已经全部」——占比档应向下取整。

零覆盖时**不许**回落到 0% 或 100%，两个都是错的；如实说「未记录」。

---

## 3. 0.17.1 的 `arg_value` 修复：实现可用，但台账依据不成立

### 3.1 实现是好的（独立复核，不看它自己的测试）

直接调 `parseAgentReply` 喂四种形状：

| 形状 | 结果 |
| --- | --- |
| 夹具形状（工具名换行 + `k\nv</arg_value>`） | ✔ `{"command":"Get-ChildItem -Force","description":"List dir"}` |
| 真实网页形状（工具名与 key 同行） | ✔ 同上 |
| 开源模板 `<arg_key>/<arg_value>` 成对 | ✔ `{"command":"Get-Process"}` |
| 反斜杠续行长命令 | ✔ `{"file_path":"D:\\a\\b.js","offset":680,"limit":90}` |
| JSON 体（基线回归） | ✔ 未被破坏 |

`coerceArguments` 的 `path/filepath → file_path`、`cmd → command` 别名纠偏同样正确。

### 3.2 但台账写的那条依据，在它自己引用的会话里查不到

`doc/progress.md` 的 0.17.1 段写着：

> 「GLM-4/5 在网页端原生吐出 `<tool_call>…<arg_value>…` 语法，旧解析器只支持 JSON 体
> 导致每轮判 UNPARSED 触发自动续跑」「真机 session-2411bccd 实锤」

我把该会话日志（`session.v3.jsonl.zstd`，zstd 多帧）解出来逐串统计：

```
session-2411bccd-e9dc-4d1f-a93c-e8204bfe401a
  arg_value = 0            ← 台账所指的「实锤形状」，一次都没出现
  arg_key   = 0
  AUTO_CONTINUED = 15      ← 自动续跑确实发生了
  TOOL_CALL_UNPARSED = 0   ← 但并不是以这个错误码发生的
```

**结论：`arg_value` 在这条会话里不存在。** 自动续跑（15 次）是真的，但把它归因到
`arg_value` 缺解析没有证据支持——该会话 `<tool_call>` 片段里能看到的是配平 JSON 体
（`pwsh{…}</tool_call>`）。

这不否定修复本身（GLM 开源模板确实产 `<arg_key>/<arg_value>`，放宽解析有价值），
但**台账把一次「预防性加固」写成了「真机缺陷修复」**，而依据的那条会话不支持该归因。
按本项目自己的纪律（`doc/progress.md` 开头：状态以事实为准），这条需要更正。

---

## 4. 交付卫生：零提交、零 tag

```
git log --oneline 888fab5..HEAD  → 0 条   # 0.16.32 之后没有任何提交
git status --porcelain           → 28 modified + 28 untracked
git tag                          → 最新只到 v0.16.31
```

即：**0.16.33 到 0.17.1 的全部工作（约 4000 行改动）从未进过 git**。
风险不是抽象的——本项目自己的 `doc/ci-cd.md` 与 `scripts/check-ledger.mjs` 都把
「台账 ↔ 事实一致」当纪律，而现在的状态是「工作树是唯一副本」。

> **已修复（2026-09-22 同一会话）**：全部入库，两个提交（`a10249c` 主体 +
> `6f486b0` 未接线标注），tag `v0.17.0` / `v0.17.2`。工作树干净。

未跟踪文档里有 4 份**没进 `doc/README.md` 索引**：

- `doc/plans/2026-09-21-domestic-sites-protocol.md`
- `doc/research/2026-09-21-domestic-sites-protocol-design.md`
- `doc/research/2026-09-21-login-probe-matrix.md`
- `doc/ANSWERS-0.16.33.md`

（`repo-hygiene` 只查「索引里的链接是否死链」，不查「是否所有文档都进了索引」，
所以它 PASS 并不代表这里没问题。）

---

## 5. 装机一致性：三个交付物，三份内容

| 位置 | 内容 |
| --- | --- |
| **根目录** `dsh-webcode-bridge-0.17.1.tgz` | ✔ 最新，41/41 与工作树逐字相同（`web` profile 装的就是它） |
| **嵌套** `package/dsh-webcode-bridge/dsh-webcode-bridge-0.17.1.tgz` | ✖ 是 **0.17.0** 的内容（`agent-preset.js` 93,178 字节，缺 0.17.1 的 arg_value 解析） |
| `headless` profile | ✖ 是 **0.16.40** 的内容，但 `package.json` 声明 0.17.1 |

`settings-page.js` 三方对照最能说明问题：工作树 42,453 / 嵌套 tgz 27,389 / headless 27,389。

命名相同的两个 tgz 内容不同，且**同名不同内容**——这正是 `scripts/verify-pack.mjs`
注释里说的那个坑（「改了代码忘了重新 pack，装上去的是旧文件」），只是这次踩它的是
**第二个** tgz 与 `headless` profile。

注意：`*.tgz` 已被 `.gitignore` 排除（`.gitignore:45`），两个 tgz 都**不在版本控制里**，
所以这个不一致不会在 diff 里暴露。

---

## 6. 计划完成度：0/33 勾选，但实际做了不少

`doc/plans/2026-09-21-domestic-sites-protocol.md`：`- [ ]` × 33，`- [x]` × 0。

但对照代码，其中这些**实际已经落地**：

- Task 1.1/1.2/1.3（统一转换层）→ `lib/tool-transport.js`、`lib/tool-parser.js` 已建，
  且**有意收敛为「只路由、不重写协议」**（头注写明理由：解析已在 `agent-preset` 成熟，
  重写必然漂移）。这比原计划更正确。
- Task 0.1（登录探针矩阵）→ `doc/research/2026-09-21-login-probe-matrix.md`（15,695 字节）已产出。
- Task 2.1（GLM 正文残留）→ 已修（`decoder.js` 的 `glmSegBuf` 段累积去重 +
  `test/glm-tool-snapshot-dedup.test.mjs` 3 条护栏）。

**没做完的**（计划要求「真机端到端验证留痕」）：

- `lib/tool-transport.js` / `lib/tool-parser.js` **只被单测引用，未接线到任何调用点**
  （全树搜 `from './tool-transport'`，只有 `tool-parser.js` 自己与它的测试）。
- Task 3（千问/豆包/Kimi/Z.ai 四站铺开）没有对应验收记录。
- Task 0.2 要求的 `.tmp/glm-replay/raw-frames.jsonl` 原始帧**不在仓库**（`.tmp/` 被忽略）。
- Task 4 的真机矩阵 `10/10` 未见本轮留痕。

---

## 7. 修复落地（2026-09-22 第二、三轮）

§1–§6 是本轮**首轮审查**的结论；其中 §2 的缺陷与 §3.2/§4/§5 的卫生问题
**已在同一会话内全部修完**，记录如下：

### 7.1 §2 的占比缺陷 —— 已修（0.17.2）

- 账本新增 `durationTurns`：只有 `durationMs > 0` 的轮次才 `+1`，作为**覆盖率判据**；
- `sanitizeWaitStats` 对旧账本**不向后推断**（绝不因 `totalDurationMs > 0` 就认定
  「这些轮次都有耗时」——那正是 100% 的来源）；
- 新增 `waitRatio` 作为占比的**唯一计算入口**，六个调用点全部改走它；三种读数：
  全覆盖 `61%` / 零覆盖 `未记录` / 部分覆盖 `61%（覆盖 40/57 轮）`；
- 药丸是 13px 单行，只在**纯百分比**时附占比（`未记录` 与覆盖率尾巴交给点开的面板）。

**真机验证**：拿真实落盘账本（`totalWaitMs=115033353` / `totalDurationMs=1056232` /
`turns=8676`）跑修复后的 `waitRatio` → `未记录`；**同一份数据在修复前算出 `99%`**。

`formatPercent` 的取整语义**未动**（`15.6 → 16%` 是既有契约，有护栏钉住）：
真正的病灶是覆盖率，不是四舍五入。这是首轮一度想改、复核后放弃的一处——
改动超出病灶会让本已有护栏的测试无谓变红。

新增 5 条护栏（`wait-stats.test.mjs`），删掉 `durationTurns` 判定第 2 条必红。

### 7.2 §3.2 的归因 —— 已在台账更正

`doc/progress.md` 0.17.1 段保留原文（历史不改写），在其上方新增一行
「0.17.1 归因**更正**（2026-09-22）」，写明 `arg_value = 0` 的实测与
「性质是预防性加固」的结论。

### 7.3 §4 的交付卫生 —— 已入库

两个提交（`a10249c` 主体 + `6f486b0` 标注），tag `v0.17.0` / `v0.17.2`，工作树干净。

### 7.4 §5 的交付物不一致 —— 已统一

根 tgz 与嵌套 tgz 现在**同一份字节**（均为 0.17.2，531,241 字节）；
两个 profile（web / headless）都实装 0.17.2，且各 7/7 与工作树逐字相同；
`package.json` 与 `pnpm-lock.yaml` 的声明同步改到 0.17.2（否则 pnpm 通道会静默回退）。

### 7.5 §6 的未接线 —— 已标注（未删）

`lib/tool-transport.js` 与 `lib/tool-parser.js` 头注加了醒目警告：**只被单测引用、
未接线到任何调用点**，并指向计划 Task 1.4 决定去留。没有单方面删除——
它们是计划点名的交付物，删或接线是产品决定，不是审查者的。

### 7.6 首轮为何一度回退

首轮编辑时发现 `wait-stats.js` 出现我无法解释的内容（一个 `waitRatio` helper 及其
大段注释），同时我的改动把 7 条既有测试改红。在无法确定文件最终状态时我选择
**从已验证发布物恢复并回退**，而不是继续堆改动。第三轮在独占状态下重做，
逐条夹具同步、复跑全绿后落地。

---

## 8. 验证与残余

**全部通过（0.17.2 实跑）**：

| 项 | 结果 |
| --- | --- |
| 全量单测 | **866/866，exit 0**（新增 5 条） |
| `wait-stats` | 39/39 |
| `control-routes` | 12/12 |
| `client-render` | 48/48 |
| `tool-transport` | 10/10 |
| `verify-pack` | **41/41 逐字相同** |
| `lint-comments` | 146 文件，error 0 / warn 0 |
| `check-ledger` | PASS（0.17.2 / 73） |
| `repo-hygiene` | PASS |
| `ref-index` | PASS（45 条目） |

**残余（如实记）**：

1. **需重启 DSH 才生效**——当前 3080 上跑的仍是旧代码（`build.version` 会仍报
   0.17.1 直到重启）。重启后 `POST /__webcode/wait-stats` 的
   「平均会话等待时长占比」应从 `100%` 变成 `未记录`（覆盖率随 0.17.2 的轮次
   逐步累积后，才转为真实百分比）。
2. Task 3（千问/豆包/Kimi/Z.ai 四站铺开）仍未做验收；计划勾选仍未补
   （计划文件里 33 条 checkbox 全空，其中多条实际已完成）。
3. `durationTurns` 从 0.17.2 起才开始积累：**在那之前的历史轮次永远算「未覆盖」**，
   这是设计选择（如实说「没记」而不是编一个数），不是待修项。

---

## 附：本次审查用到的取证命令

```powershell
# 基线
node scripts/verify-pack.mjs dsh-webcode-bridge-0.17.1.tgz
node --test test/*.test.mjs

# 线上读数（0.17.0 占比缺陷的证据）
Invoke-RestMethod 'http://127.0.0.1:3080/__webcode/status'
Invoke-RestMethod 'http://127.0.0.1:3080/__webcode/wait-stats' -Method Post `
  -ContentType 'application/json' -Body '{"sessionId":"<id>"}'

# 交付卫生
git log --oneline 888fab5..HEAD ; git status --porcelain ; git tag

# 解析器独立复核
node .tmp/probe-argvalue.mjs
node .tmp/probe-provenance.mjs session-2411bccd-e9dc-4d1f-a93c-e8204bfe401a

# 会话身份（谁做的这轮）
node .tmp/probe-session-model.mjs session-2e148fda-f412-4b0a-9c7a-62df1a91886f
```

