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
