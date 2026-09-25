# 手动 /compact 失效的取证与修复（2026-09-25，0.19.14）

> 用户报告：DSH 里手动 `/compact` 不行。本文是真机取证 + 修复记录。
> 探针脚本：`test-mock/real-compact-probe.mjs`（A/B 相）、`test-mock/real-compact-ladder.mjs`（尺寸阶梯）。

## 一、压缩调用的真实形状

`dsh-command-compact` → `dsh-compaction-basic`（宿主内置，非 profile 插件）：

```
ctx.llm.stream({
  provider/model,  messages = [整段会话历史回放..., user(COMPACTION_INSTRUCTION)],
  tools, maxTokens: 65536, sessionId: <同一会话>, purpose: 'compaction',
})
```

finish 为 `error/aborted/max-tokens` 才判失败；摘要必须含文本。指令作为**最后一条
user 消息**追加（不是 system），KV-cache 复用的设计意图是「重放前缀 + 只发指令」。

## 二、桥侧的旧路径（病因）

`lib/index.js` buildTurn：`keyPath = sessionId && contextMode==='session' && !purpose ? … : null`。
**purpose 非空 → 无会话键 → 当作独立首轮 `serializeFirstTurn` 整包重发**，后果三连：

1. **历史被整包重放**（教学 + 全部消息 + 指令压成一条消息）发进一个临时网页会话；
2. 真实长会话必然撞墙：本项目最大会话历史 ≈ **190 万字符**（会话扫描 contentChars
   1.79M–1.94M）≈ 110 万+ token，超过桥声明给 DSH 的 100 万窗口 ——
   `assertContextBudget` 在发送前抛 **CONTEXT_WINDOW_EXCEEDED**，轮次根本发不出去；
3. 无键分支旧实现没有 `rebuild()` → PROMPT_TRUNCATED 一次重试都没有，报错文案还是
   「请缩短上下文或先压缩历史再重试」——**压缩恰恰只在需要压缩的会话上做不了**。

## 三、真机读数（2026-09-25，生产 profile，headless）

| 探针 | 内容 | 结果 |
| --- | --- | --- |
| A 相 | 历史先落进网页会话，**只发指令**（增量） | 3 秒产出结构化摘要，**4/4 事实标记逐字复现**（鉴权决策/崩溃文件/错误码/待办） |
| B 相 | 88k 整包重放（旧行为） | 网页收下，摘要正确，12 秒 |
| 阶梯 160k / 320k | 整包重放 | **全部通过**（10 秒级）——9 月 23 日的 ~73k 输入框上限已不存在 |

结论：**长度截断不是今日的病因**（320k 都收得下），190 万字符会话死于
桥自己的 1M 预算闸；即便窗口调大，190 万字符的重复粘贴也只是「勉强能用」。
增量发送（A 相）在 190 万字符会话上同样只要 3 秒——上下文本来就在网页侧。

## 四、修复（0.19.14）

`buildTurn` 无键分支前置「辅助增量」判定，复用真实轮的同一套游标机制
（`session-anchor.js`：契约指纹 + 尾部内容锚）：

- 主会话游标存在、契约指纹一致、`reanchorSent` 把游标重定位到「只多最后一条指令」
  → **只把指令作为增量**发进主会话的网页对话（`meta.sessionKey = 主键`，fresh=false），
  `commit()`/`noteOutput()` 均为空——**辅助轮不碰主游标**：压缩成功后宿主替换
  surface，下一真实轮锚点失配自然整段重建（摘要即新起点）；压缩失败则游标原样有效。
- 判定不满足（无游标/换账号/历史被改写）→ 回落整段独立首轮，但**显式用辅助专用槽**
  `aux::<purpose>::<sessionId>` + `fresh=true`（旧实现无 sessionKey → 驱动 'main' 槽，
  可能被 URL 自愈接到用户当前正看的会话上），并补 `rebuild()` 让 PROMPT_TRUNCATED
  重试覆盖辅助轮。
- 执行器 WEB_SESSION_LOST 重放（index.js `readSessionPrompt(m.sessionKey)`）对
  purpose 轮跳过落盘正本——那份是真实首轮，**不含本轮压缩指令**，读回重放会丢指令。
- 无 purpose 的无状态轮（OpenAI 前端裸调用）**保持原形态**（无 sessionKey 走
  sendPrompt）——aux 槽只给 purpose 辅助轮。

## 五、护栏

`test/aux-delta-compact.test.mjs`（5 条）：

1. 游标命中 → 只发增量（prompt 含指令、不含历史，<4000 字符）进主键、fresh=false；
2. 辅助轮后主游标原样有效（下一真实轮仍是增量）；
3. 锚点失配 → 回落整段独立首轮，aux 槽 + fresh=true；
4. 无游标 → 同上；
5. 增量遇 WEB_SESSION_LOST → 整段重放且**必须含本轮指令**。

## 六、遗留

- DSH 的自动压缩阈值 = 声明窗口 × 0.8 = 80 万 token（1M 声明），正常使用触不到；
  自动压缩首次触发时的行为验证仍是开放项（doc/research/2026-09-23 两轮思考 §3.3）。
- `summarizationProvider/Model` 未配置时压缩调用路由到会话当前模型（= 网页桥），
  即本修复覆盖的路径；配置了别的 provider 则不走桥。
