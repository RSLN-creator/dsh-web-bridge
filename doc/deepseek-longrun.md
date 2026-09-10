# DeepSeek 网页桥「长时间正常运行」审查（2026-09-10）

审查对象：`package/dsh-webcode-bridge`（0.7.1 工作树）。结论先行：**长跑能不能稳，
不取决于桥本身，而取决于三件事——用哪个 agent 预设、网页会话丢了怎么办、以及
发出去的提示词有没有被网页静默截断。** 这三件里有两件原本是错的，本次已修。

## 一、Harness 真实提示词长什么样（实测，不是转述）

本机 DSH 0.1.1-rc.2，`~/.dsh/profiles/web`。查证自安装本体
（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\config\agent-presets\`）：

- `@deepseek-ai/dsh-system-prompt` 只注册两段：`harness:identity`
  （原文 `You are an AI agent powered by DeepSeek Harness.`）和 persona。
- persona 由预设给。`complete: true` 时它**就是全文系统提示词**：

| 预设 | persona 原文 | 运行时上下文 | 压缩 |
| --- | --- | --- | --- |
| 极简模式 minimal | `You are a helpful software engineer assistant.` | 关闭 | **无** |
| 标准模式 standard | `You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.` | 开启 | 有 |
| PTC 模式 code | 同标准模式 | 开启 | 有 |

- **工具规则不在系统提示词里**。DSH 走原生 function calling，工具的
  `description` 字段本身就是提示词，逐条带着硬约束，例如
  `dsh-tool-pwsh-persistent` 的原文里写着
  `Use native Windows paths (C:\...) and $env:NAME variables; this is PowerShell, not bash.`

对网页桥的直接含义：**网页模型拿不到这些 description，除非桥把它原样搬进首轮预设。**
旧实现把每条工具描述截到 300 字符——而实测 DSH 工具描述最长约 400 字符
（`dsh-tool-fs` 373、`dsh-tool-fs-search` 375、`dsh-tool-subagent` 397），
被截掉的正好是这些约束条款。已改为 1200 字符上限，并补了一行本机平台说明
（真机马拉松轨迹里约一半工具错误来自模型用 `ls -la`、`&&` 打 Windows）。

## 二、当前配置正好踩在长跑最差的一档

`~/.dsh/settings.yaml` 实测：

```yaml
agent-presets:
  default: minimal          # 极简模式
agent-default-model:
  provider: webcode
  model: deepseek:flash
```

极简模式 = **2 个工具**（持久 pwsh + str_replace_editor）、**没有上下文压缩**、
运行时上下文被抑制。也就是说：默认跑在网页桥上的会话，transcript 只增不减，
而网页那一侧的会话也在同步膨胀。这是长跑最不利的组合，不是桥的问题，
但桥必须能扛住它。

## 三、长跑的四个真实故障点与本次修复

### 1. 网页会话被删/过期 → 桥曾把「增量」发进一个空会话（已修）

`browser-driver.js` 旧逻辑：目标会话页打不开时，静默改开新会话，**把这轮的
增量照发**。新会话里既没有首轮预设也没有任何历史，模型带着半截上下文裸奔——
这就是「跑着跑着变傻」的根因。

改为：抛 `WEB_SESSION_LOST` → `index.js` 用 `serializeFirstTurn` **重放整段首轮
提示词**（首轮全文 + 增量＝完整上下文，网页端本来就是这个模型），一次成功即恢复；
重放仍失败才作废游标，交给下一轮。同一扇门还有第二种走法——本地会话槽空了
但上层仍要续聊——一并用同一个码堵上。

### 2. 中止一轮 ≠ 停下网页那一轮（已修）

旧 `onAbort` 点了停止就立刻放行 `busy`，下一轮可能在站点仍处于「生成中」
时填框发送。且没有停止按钮契约的站点会回落到 `div[role='button']`
（点到页面上第一个按钮，可能是「新会话」）。现在：点停止会等它点完再放行，
没有 `stopButton` 契约就什么都不点。

### 3. 页面崩溃 / 浏览器被关 → 会白等满 240 秒（已修）

新增 `page.on('crash')` 与 `ctx.on('close')`：立刻让进行中的轮次失败并带码，
`ensure()` 下一轮自愈重开，而不是把超时耗尽在死句柄上。生命周期兜底也移进了
`installPage()`，自愈重开的新页同样受保护。

### 4. 网页输入框静默截断超长提示词（已修）

网页 composer 有长度上限，超限**不报错、直接截断**，模型只看到半截提示词却照常
作答。新增发送后回读校验：`inputValue()` 长度对不上就抛 `PROMPT_TRUNCATED`
（此时还没按 Enter，网页端没被污染），提示压缩后重试。

顺带修掉的：`activeSettled()` 旧写法把定时器挂在 `settleHook` 上却从不清除，
「生成期间关窗口」每次都白等 120 秒；`openWindow` 里
`!d.isPrimary === false` 这种双重否定（结果碰巧是对的，但读起来像 bug，
已改写为 `d.isPrimary`）；`localAnswer` 曾按
system 文本里的「标题/命名」判据短路真实轮次（工作区指令里出现这些词，
一次真实提问会被本地截成 16 个字返回）；只出图不出字的回复曾被按「空回复」判死；
会话游标的 LRU 淘汰实际是 FIFO（长会话会先被丢，表现为整段重发）；
`queueTimeoutMs` 300s 只比单轮 240s 多 60s，排在第二位的并行子代理几乎必然超时；
`lib/index.js` 每轮把设置读三遍（可能读到三个版本）；`browser-driver.js`
顶部有一份从未被使用的 `SEL` 常量与死函数 `fillAndSend`，`lib/flatten.js`
的 `flattenGenerateOptions`/`parseToolCall` 已无人引用——都已删除。

## 四、长跑推荐姿势（不是代码问题，是配置问题）

1. **长任务别用极简模式。** 极简模式没有压缩、只有 2 个工具。切标准模式
   （`agent-presets.default: standard`）后再跑自主长任务：有 `compaction-basic`
   和 `tool-result-pruner`，transcript 会自己收敛。
2. **DeepSeek 侧优先用「专家模式」跑需要多轮的活**，快速模式留给单轮问答。
3. **发版前跑 `pnpm doctor`**（`test-mock/real-verify.mjs`），
   它校验三模型 `model_type` 与工具闭环；网页改版时这是最快的报警器。
4. **周期性真机长跑样例**用 `real-probe-17-autonomous-marathon.mjs`：
   单任务、零干预、轨迹落盘，判据是调用数/错误自愈率/思维链字数。

## 五、本次留下的已知欠账（未修，需要决策）

- `test-mock/run-m2.js`（扩展链路）与 `run-m2b`/`run-m2c` 的
  `completion via driver` 两项**在干净树上同样失败**，是既有欠账，不是回归。
  mock 站点的响应形状与驱动期望已脱节，要么修 mock，要么删掉死测试。
- `test-mock/` 下有 8456 个浏览器 profile 缓存文件被纳入版本控制
  （`.git` 已膨胀到 427MB）。已加 `.gitignore` 阻止继续增长，
  存量取消跟踪见同批 git 提交。
- 网页 composer 的真实长度上限仍是未知数——本次只是让它在越界时**报错**
  而不是静默出错。抓一次真实上限填回 `providers.js` 会让 `contextWindow`
  的声明更诚实（当前统一声明 1_000_000，对网页端而言过于乐观）。

## 六、2026-09-10 网页改版：三 pill → 统一模型 + 深度思考开关（已适配）

### 改版事实（probe-19/20 真机取证，证据见 doc/research/deepseek-newui-2026-09-10.md）

| 观测项 | 旧版 UI（≤0.7.2 适配对象） | 新版 UI（2026-09-10 起） |
| --- | --- | --- |
| 模型 pill | 快速模式 / 专家模式 / 识图模式 | **没有模型 pill**；输入框附近只剩「深度思考 / 智能搜索」两个 aria-pressed 开关 |
| 首条消息 model_type | default / expert / vision | **恒为 default** |
| 模式差异载体 | model_type | **thinking_enabled**（点击「深度思考」开关，下一条 POST 的该字段即随之变化） |
| 识图 | 识图模式 → model_type=vision | 无独立入口：带图发送 = default + `ref_file_ids`，回复确实读到图（测试图 HELLO） |
| 续聊消息 | — | `model_type:null`（网页「沿用会话模型」），thinking_enabled 仍逐条发送 |
| 会话 URL | /a/chat/s/<id> | 不变；发送按钮 svg path 也不变 |
| 开关初始状态 | — | 跨会话保留（连续三次运行里 true/false/false 都出现过） |

### 驱动适配（同批修改）

- `detectDeepSeekUi()`：按「有没有三 pill / 有没有 composer 内深度思考开关」判定 UI
  代际（classic/unified），缓存到 `dsUi`，换页失效；两代 UI 都能跑，网页再改回去也不会翻车。
- unified 下 `flash`/`deepseek` 都只操作「深度思考」开关（flash 关、deepseek 开）；
  开关定位不到时抛 `MODEL_UI_CHANGED`（带输入框附近可点项诊断），**不再假装选中**。
- 发送后核验从「只看非空 model_type」升级为「契约期望元数据全量比对」
  （`contract.expectedRequestMetadata`）：unified 必查 `thinking_enabled`；`model_type`
  缺失/null 视为网页「沿用会话模型」（首条消息已核验），其它取值不符即报错。
- 旧实现里 `model_type` 一旦从请求体消失就整段跳过核验——现在取不到请求体本身就是失败。

### 真机验证（2026-09-10 同批）

- `pnpm doctor`（real-verify.mjs）8/8 全绿：flash=default+thinking_enabled:false、
  deepseek=default+thinking_enabled:true、vision 带图回复 HELLO（unified 判据）、
  工具闭环（网页自主 read → 真实执行 → 收束）。
- `real-probe-17-autonomous-marathon.mjs`：10 轮零干预自主长跑，见
  doc/research 轨迹与提交说明。

### 对长跑的含义

1. **每轮同步开关是必需品**：开关状态跨会话保留且会漂移（三次运行初始值不同），
   不做每轮同步就会出现「选了 flash 实际开着深度思考」这类静默错配。
2. **续聊的 model_type=null 不是降级**：会话模型在首条消息确定，驱动在首条核验；
   把 null 当错误会让所有多轮长任务在第一轮之后全灭。
3. 三 pill 时代的 `expectedModelType` 单值契约已不成立，模式期望必须按 UI 代际取值
   （`lib/metrics.js` 的 `MODEL_TYPES_BY_UI`）——两代并存的过渡期尤其如此。

### 六之补：长跑暴露的调用形状漂移（同批修复）

真机马拉松（probe-17，2026-09-10 两跑）抓到两种**解析器漏形状 → 工具循环静默中断**
的真实漂移。两种都表现为「回复看着像调用，解析结果为空」，探针旧判据却把它当收束
（第一跑因此误报 PASS）——这正是长任务跑着跑着不动的典型形态。

| 形状 | 真机原文（节选） | 旧解析结果 | 修复 |
| --- | --- | --- | --- |
| 混合壳 | `<invoke name="read" purpose="…">{"path":"…"}</parameter></invoke>` | 0 调用（invoke 体要求 `<parameter>` 元素，被游离 `</parameter>` 噪声挡住） | `jsonObjectIn()`：无 `<parameter>` 时按裸 JSON 取参 |
| 新版 DSML + 类型属性 | `<｜DSML｜invoke name="shell"><｜DSML｜parameter name="command" string="true">git ls-files</｜DSML｜parameter>` | 0 调用（`paramRe` 要求 name 后直接 `>`，多一个属性就整段漏） | `paramRe` 允许 `name` 之后的任意属性 |
| JSON 包装壳 | `<invoke name="tool_call">{"mcp_action":"call","name":"read",…}</invoke>` | 1 个假调用（工具名变成 `tool_call`，真调用靠裸对象规则兜回，两路重复） | 壳内是完整调用对象时按内层入账 + 内容签名去重 |
| 参数包装壳 | `<invoke name="tool_call"><parameter name="name">shell</parameter><parameter name="arguments">{…}</parameter></invoke>` | 3 个假 `tool_call`/轮（未知工具，errRate 53%） | 包装名（tool_call/function/invoke）+ name/arguments 参数 → 还原成真调用 |
| 标签名漏 JSON | `<parameter name="name": "read", "arguments": {"path":"README.md"}}` | 0 调用 | 片段抢救：按 `"name":"x","arguments":{…}` 花括号配对还原 |
| 属性区漏 JSON | `<invoke name="mcp_action":"call","name":"read","arguments":{"path":"…"}}` | 0 调用 / 1 个假 `mcp_action` | 抢救扫描扩到整个 invoke 匹配（含属性区），`mcp_action` 列入包装名 |

顺带一提：修好之后回放同一批真机轨迹，发现 **旧解析器还在静默丢调用**——例如一轮里模型
连发 3 个 `read`（contract.js / providers.js / decoder.js），旧逻辑只记第 1 个，另外两个
从此消失。修完这批形状后同类轨迹的调用数显著上升，长任务的工具循环因此更完整。

护栏：`parseAgentReply` 两处兜底 + 回归测试各一条；probe-17 增加「收束文本仍含调用
记号（invoke/parameter/mcp_action/DSML）」判 FAIL——静默丢调用不再能混过 PASS。
另修 probe-17 不在 finally 关 driver 的缺陷（每次长跑留一个孤儿 Edge 进程树锁 profile）。
