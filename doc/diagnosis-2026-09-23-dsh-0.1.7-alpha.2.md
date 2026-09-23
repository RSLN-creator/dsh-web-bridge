# 诊断（2026-09-23）：DSH 升到 0.1.7-alpha.2 后本插件的两个真故障

**这份文件回答用户的三个问题**：① 本插件对新版本（0.1.7-alpha.2）有什么问题；
② 为什么 DeepSeek 的上下文窗口「变小了」；③ 底部「等待发送」药丸为什么没了。

- 缺陷的「怎么修 / 怎么防」写在正文各节；错误码横向台账见
  [`bridge-failure-ledger.md`](bridge-failure-ledger.md)。
- 本文所有读数都是**本机实测**（命令逐条给出），不是推断。

---

## 0. 口径更正：本机现在**已经**是 0.1.7-alpha.2

上一轮（[`compliance-audit-0.19.1.md`](compliance-audit-0.19.1.md) §10）记录的
「本机实装 0.1.6-alpha.2」**已经过期**。实测三条：

| 检查 | 读数 |
| --- | --- |
| `dsh --version` | `0.1.7-alpha.2` |
| `@deepseek-ai/dsh/package.json` 的 mtime | `2026-09-23 14:54:13` |
| 正在跑的 Web 服务（`:3080` LISTENING，pid 22164） | 起于 `2026-09-23 18:27:25` |

上一轮「本机不是 0.1.7」的结论在当时是对的（三条读数一致为 0.1.6-alpha.2），
错的是**它被当成了一条长期事实**：DSH 的升级发生在这两轮之间。**教训**：版本口径
每次都要重读，不能从台账里沿用。

---

## 1. 阻断级：客户端服务 `settingsScope` 在 0.1.7 里已被改名

### 1.1 事实（两侧对照，逐条可复核）

| 项 | 0.1.6-alpha.2 | 0.1.7-alpha.2 | 怎么复核 |
| --- | --- | --- | --- |
| 官方客户端设置服务 | `ctx.settingsScope`（`SettingsScopeBinder`） | **`ctx.configForms`**（`ConfigForms`） | `git show <tag>:packages/client/ui-settings/src/client/index.ts` |
| `packages/client` 下 `settingsScope` 出现次数 | 多处（源 + 测试） | **0 次**（只剩 `.agents/notes/` 历史文本） | `git grep -c settingsScope <tag> -- packages/client` |
| 页面注册规则 | `settingsScope.bind/describe` | `configForms.whileServed(namespaces, register)` | 同上 + `docs/cookbook/adding-a-settings-card.md` |

### 1.2 为什么这会让本插件整块不挂载

本插件 `lib/client.cjs` 的 Cordis `inject` 写的是
`['slots','settingsScope','sidebarRightTabs','sidebarRight']`。Cordis 的 `inject`
语义是「**这些服务全部就绪才执行 apply**」（`vendor/cordis/src/fiber.ts`：
`_checkImpl` + `_refresh`，任一服务缺失即把 fiber 停在 `PENDING`）。
`settingsScope` 在 0.1.7 下**永不到达**，于是这个 fiber 永远不激活 ——
设置页 section、右栏标签页、中央并列多会话、左栏任务板**全部不出现**。

0.1.7 的启动审计会把这件事说清楚（`packages/client/web/src/boot-client.ts`
的 `assertEntriesActive`，0.1.6 也有）：

```
web boot: 1 entry did not activate
<包名>: pending (waiting for services: settingsScope)
```

### 1.3 但 `dsh.client.inject`（package.json 那个）是另一回事

`package.json` 的 `dsh.client.inject` 与 Cordis 的 `inject` **同名异义**：
规范逐字写它是「**Informational package-name dependencies, not Cordis service
injection**」，值是**包名**。上一轮已记（`compliance-audit-0.19.1.md` §9）：本项目
填的是服务名，官方三条消费路径全部容忍，因此是**死声明**。

**本轮处置**：整条删掉 `dsh.client.inject`。理由：① 它本来就什么都不做；
② 三条服务名没有任何一条是合法值（合法值是 scoped 包名）；③ 平台种子
（`react` / `react-dom/client` / primitives）由 `PLATFORM_MODULES` 保证，无需声明；
④ 留着它只会让下一个人再把它当成「服务等待」，从而把真问题遮住。

### 1.4 装机不一致（本轮之前的状态）

| 位置 | `lib/client.cjs` 的 `inject` | `package.json` 的 `dsh.client.inject` |
| --- | --- | --- |
| 工作树 | 已删 `settingsScope` | 已删 |
| 已装 profile（0.19.2 之前） | 已删（被手工覆盖，mtime 15:45） | **仍是旧 tar 的清单，含 `settingsScope`** |

profile 依赖的是 `file:.../dsh-webcode-bridge-0.19.1.tgz`，manifest 是**打包那一刻**的，
而 `lib/` 是从工作树拷进去的 —— 两边不同源。这就是「声明与代码不一致」的形状，
必须重打包 + 重装才能消掉（本轮已做）。

---

## 2. 「DeepSeek 上下文窗口变小了」——两半，请对号入座

### 2.1 前半：本插件声明的值**没变**

- 唯一取值处 `lib/index.js` 的 `contextWindowFor`（`cfg.contextWindowBySite[siteId]`
  优先级最高）与 `cfg.contextWindowBySite: { deepseek: 1_000_000 }`；
  `lib/providers.js` 的 deepseek 模型同样是 `context: 1_000_000`。
- 运行时实测 `GET http://127.0.0.1:8931/__webcode/context-windows`：
  `deepseek: window 1000000, source "declared"`（glm/kimi/qwen/gemini/zai 同为 1M）。
- 本会话的会话投影里 `contextPressure.contextWindow = 1000000`。

历史上确实「小」过，但只出现在**未校准站点**：把 220 个会话按声明窗口分组，
`64000` 那 9 个**全部**是 `webcode / glm:glm-5.3`（09-16 ~ 09-21），
来自 `contextWindowFor` 的保守兜底分支，不是 deepseek。

### 2.2 后半：0.1.7 把**压缩触发点**压低了（用户感觉到的就是它）

官方 compaction 在 0.1.7 新增 `headroomTokens`（默认 65,536）并改了压力阈值公式
（commit `555b664b08`，`packages/compaction/compaction-basic/src/config.ts`）：

```
0.1.6:  threshold = floor(contextWindow × 0.8)
0.1.7:  threshold = floor(min(contextWindow × 0.8,
                              contextWindow − reservedCompletionTokens − headroomTokens))
```

对**官方 deepseek-official**（`DEFAULT_CONTEXT_WINDOW = 1_000_000`、
`DEFAULT_MAX_TOKENS = 256_000`）：

| | 阈值 |
| --- | --- |
| 0.1.6 | 1,000,000 × 0.8 = **800,000** |
| 0.1.7 | min(800,000, 1,000,000 − 256,000 − 65,536) = **678,464** |

**少掉约 121,536 token（≈12% 窗口）**，自动压缩比过去早得多触发。窗口声明本身没动，
被扣的是「预留输出 + 64K 压缩余量」。

对**webcode/deepseek**：本插件的 `resolveModel` 不返回 `defaultMaxTokens`，
因此 `reservedCompletionTokens` 取 `session.requestHeader()?.config.maxTokens`；
没设过 `maxTokens` 时它是 0，阈值仍是 `min(800k, 934,464) = 800k`，与 0.1.6 相同。
一旦在设置里给该模型填了 `maxTokens`（比如 256k），立刻掉到 678k。

### 2.3 怎么自证看到的是哪个数（三条，一分钟）

1. `GET http://127.0.0.1:8931/__webcode/context-windows` —— 桥声明的窗口；
2. GUI 模型选择器里 `deepseek-official / deepseek-v4-flash` 的 context；
3. 会话圆环的**分母**：`ui-conversation/src/client/context-occupancy.ts` 在
   0.1.6→0.1.7 之间 **diff 为空**，分母就是 `contextPressure.contextWindow`。

---

## 3. 「底部发送等待时间没了」——真根因：primitives 图标导出改名

### 3.1 事实

0.1.7-alpha.2 把 `@deepseek-ai/dsh-client-ui-primitives` 的图标导出**整体改名**：
名字不再带像素后缀。

| 0.1.6-alpha.2 | 0.1.7-alpha.2 |
| --- | --- |
| `IconQueueOutline14` | `IconQueueOutlineRegular`（同族 `…Medium`，1.3px 描边） |
| `IconRefreshOutline14` | `IconRefreshOutlineRegular` |
| `IconRightUpOutline16` | `IconRightUpOutlineRegular` |
| `IconFullscreenOutline16` | `IconFullscreenOutlineRegular` |
| `IconPanelLeftOutline16` | `IconPanelLeftOutlineRegular` |
| `IconChevronDownOutline14` | `IconChevronDownOutlineRegular` |
| `IconGlobeOutline14` / `IconBrowseOutline16` | `IconGlobeOutlineRegular` / `IconBrowseOutlineRegular` |

**同一颗图标、同一个尺寸**，只是名字里不再写像素。0.1.7 里旧名**一个都不剩**。

### 3.2 为什么这会让药丸整块消失

`lib/client.cjs` 里等待药丸的图标取的是**无兜底解构**的那个名字：

```js
const { IconCodeOutline16, IconQueueOutline14 } = primitives;   // ← 旧写法
```

0.1.7 下 `IconQueueOutline14` 是 `undefined`，而 `IconWait` 把它当组件调用：
`h(undefined, …)` → React 抛错 → **整个 dock 条目消失**。用户看到的就是
「底部发送等待时间没了」，而控制台里**没有本插件自己的告警**（`warn` 在注册期，
渲染期不经过它）。

这与 0.16.21 那次白屏是**同一形状**：无回退解构 + 桩缺导出 → 6 条渲染测试全崩。
当时的结论是「降级不是崩溃」，但只对**后面那批** `|| (() => null)` 的写法生效，
`IconCodeOutline16 / IconQueueOutline14` 这两个留在了解构里 —— 于是这一轮它们成了
唯一没被兜住的两个名字。

### 3.3 修法

引入 `iconOf(...names)`：**按「这一代 + 上一代」两套名字依次找**，都取不到才回退
空组件。七处取值全部改用它（含原来已经带 `||` 兜底的那五个 —— 它们虽然不会崩，
但在 0.1.7 下会**静默少图标**，同样要修）。

**护栏**：`test/client-render.test.mjs` 的 `renderPane` 新增 `iconNaming` 开关。
`iconNaming: 'current'` 把测试桩里的旧名**整批换成新名（不留旧名）**，模拟真机 0.1.7；
新增用例「药丸在 primitives 改名后仍必须渲染出来」断言药丸**真的渲染出读数**——
不是「源码里有兜底」那种转述式断言。

---

## 4. 顺带发现：会话身份的两条来源必须都归一

等待药丸的 `inject` 形参是 `(sessionId) => ({ sessionId })`，设置页那条同族路径
**已经在 0.15.3 踩过一次「形状漂移」**（root 作用域下拿到的是 actions 对象，
服务端恒回 `no-session-id`）。

本轮把两条来源（官方 standard prop `useSessions` / 槽 inject 的绑定键）都过
`sessionIdOf` 归一，并给设置页那条既有断言补上「归一后的回落链」。

**真机对照读数**（`POST /__webcode/wait-stats`，本会话）：

| 请求体 | 响应 `label` | 结果 |
| --- | --- | --- |
| `{"sessionId":"<字符串>"}` | `29 分 39 秒 · 等待占比 67%` | 药丸正常 |
| `{"sessionId":{…}}` | 空 | **整行不渲染** |
| `{"sessionId":null}` / `{}` | 空 | **整行不渲染** |

也就是说：**只要会话身份不是字符串，药丸就静默消失**。这正是「无声失败」的形态，
所以取值处必须宽容，而不是赌宿主一定给字符串。

---

## 5. 本轮闸门读数（实测）

| 闸门 | 命令 | 结果 |
| --- | --- | --- |
| 客户端渲染护栏 | `node test/client-render.test.mjs` | **PASS 58/58**（含新增的改名回归） |
| 全量单测 | 逐个 `node test/*.test.mjs`（75 个文件） | 74 PASS；`reply-log.test.mjs` 需 `NODE_TEST_CONTEXT` 前提，本沙箱 `node --test` spawn EPERM，设该变量后 **4/4 PASS** |
| 解析器 | `node test/parse.test.mjs` | PASS 22/22 |
| 端到端 M1 | `node test/run-m1.js` | **M1 RESULT: PASS** |
| 离线基准 | `node test-mock/bench-ci.mjs` | PASS（4 项整体 + 7 条逐判据） |
| 注释纪律 | `node scripts/lint-comments.mjs` | PASS（150 文件，error 0 / warn 0） |
| 仓库卫生 | `node scripts/check-repo-hygiene.mjs` | PASS |
| 台账一致性 | `node scripts/check-ledger.mjs` | 本文件写就时 PASS（版本号已同步到 0.19.2） |

---

## 6. 边界（本轮**没做**的事）

- **不动官方版本声明**：`engines.dsh` 仍写 `>=0.1.0-rc.6`。已证它当前不被强制
  （`compliance-audit-0.19.1.md` §8.2），改它没有功能收益。
- **不追 `settingsScope` → `configForms` 的迁移**：本插件从不调用该服务（只等它），
  因此删掉等待即可；真要改用 `configForms` 是另一轮的功能工作。
- **不动 `contextWindowBySite` 的取值**：那是「本桥愿意让 transcript 长到多大」的
  运维声明，不是模型规格。第 2 节解释的阈值变化发生在**官方 compaction 内部**，
  与本插件的声明无关；要改的是用户的预期，不是这个数。
