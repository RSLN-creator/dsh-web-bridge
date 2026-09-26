# GLM 六问调查 · 第一轮报告（goal_round 2，2026-09-26）

> 本报告由 GLM-5.3（chatglm.cn 网页桥，本会话即 `session-3efcd7ec__glm`）产出。
> 全部结论基于真实读数：源码、`~/.dsh` 实盘、桥回复日志、既有文档。无凭空推断。
> 第二轮报告（实施+验证）留给后续 goal round，实施版本钉在 0.19.x。

## Q1 为什么消耗的不是智谱清言积分？——真实消耗来源

**结论：本会话走 `webcode` provider → dsh-webcode-bridge 插件 → Playwright 驱动 chatglm.cn 网页版。账面上根本没有积分通道在动。**

证据链（本机实测）：

1. 本会话的提示词落盘 `C:\Users\rsyhn\.dsh\webcode\sessions\session-3efcd7ec-...__glm.md` 存在且更新（说明走 webcode 桥、站点 glm）；
2. 桥回复日志 `~/.dsh/logs/webcode-bridge-replies.log` 逐轮记录本会话原始回复（session=session-3efcd7ec）；
3. `.credentials.yaml` 里只有 `DEEPSEEK_API_KEY` / `FREEHUB_AMD_5_API_KEY` / `LITTLE_DEEPSEEK_API_KEY` —— **没有任何智谱/z.ai 的 API key**；`dsh-free-models-hub-keypools.json` 为空（`{keyPools:{},targets:{}}`）；provider 快照里只有 deepseek-official 有余额（12.53 CNY）；
4. 桥的驱动用 Playwright + 独立 Edge profile（`~/.dsh/webcode-edge-profile/sites/glm`，登录态 `loggedIn:true, basis:probe-ok`）发消息、截获网页自身的 SSE 完成流（`chatglm.cn/backend-api/assistant/stream`，GlmDecoder 解码）。

**所以「不是清言积分」的原因是产品结构：**
- 智谱清言网页版的 GLM 基础对话按账号免费额度/会员处理，**不显示为积分扣减**（积分通道是 API/bigmodel 的口径）。
- DSH 侧的 token 计量是桥自己估的（metrics.js：CJK≈0.75 tok/字），用于上下文预算闸，不是计费。
- 桥声明 glm 上下文 1M（providers.js 实测下界）；usage 上报叠加 2048 固定开销。

## Q2 「完整实现引用会话内容」现状

**现状：已有一半，缺另一半。**

已有的那一半（网页侧批注引用，`lib/web-control.js`）：
- `POST task-comment`（quote 字段，`:1291`）、`POST task-implement`（`:1320`：quote → 指令拼装 `针对正文片段的批注引用: > ...`，dispatchBy:'client'）。任务板批注能带正文片段引用下发到模型。

缺的那一半（**会话消息级引用**）：
- 目前 `POST chat` 没有 quote/replyTo 形参；并列多会话各列之间、以及 DSH 官方对话区引用历史消息再提问的链路**不存在**。
- GLM 网页版本身有「引用上一条」交互，桥未映射。

**第二轮实施方向**：
1. `POST chat` 增加 `quote` 可选参数，落盘前拼进 prompt（与 task-implement 同一套拼接习惯），保持 `> ` 块引格式；
2. 并列多会话 UI（client.cjs MultiModelCompareView）每列消息加「引用到 X 列」按钮 → 引用另一列的回复作为上下文（与 Q5 的三框设计天然咬合）；
3. 护栏：引用内容长度的截断规则（引用过长的消息截前保尾+省略标记），防 context 爆炸。

## Q3 为什么最近会话还出现 `"mcp_action": "call"…` 原文？如何适配？

**三种真实来源（桥回复日志实锤，逐字保留）**：

1. **未解析调用 + 强制重发**（主源）：模型输出的调用块前缀缺失/被网页截胡/JSON 不配平 → 桥判 TOOL_CALL_UNPARSED（`lib/index.js:2268` 起）→ 自动化续跑提示要求重发 → 会话里留下「残缺原文 + 重发的新调用」。日志里逐字可见：
   - 残缺片段 `name": "read", "purpose": …`（前缀 ` {"mcp_actio` 缺头）+ 同一调用 JSON 两份完整重复；
   - 我上一轮真实犯错：用了被网≈页拦截的标签写法，桥报 `protocol anchors present but no parseable call`。
2. **思考流透传**：GLM 网页版强制思考，桥把 thinking 全文外发（日志 `note=raw thinking, verbatim` 全量落盘）。模型在思考里打草稿/复读调用 JSON → 用户在思考区看到调用原文。这不是错误，但和病形状叠加。
3. **围栏窗口泄漏**（0.19.17 已修，残留风险已钉护栏）：围栏刚开、JSON 头未到时 `findProtocolStart` 返回 -1 → 只剩 PROSE_TAIL_CHARS=8 兜底 → ```` ```json\n{"mcp_actio ```` 逐字符进正文。`lib/agent-preset.js` 新增 `unresolvedCallFenceAt`/`closingFenceAfter` + `lib/index.js:1550` 接线，`test/fence-tail.test.mjs` 10/10。

**适配方案（第二轮实施清单）**：
- a) TOOL_CALL_UNPARSED 的原文在 DSH 侧**直接隐藏**（用户指令「TOOL_CALL_UNPARSED: 直接隐藏」已落实一半：0.16.29 再教学提示只作补发，`index.js:1307/1991`），待办：对**思考流里与最近真实调用逐字相同**的块做折叠（判据=与已执行调用对象配平比较，避免误伤 §3.3「讨论协议形状」的散文）；
- b) 残缺开头（`name":...` 缺前缀）说明 GLM 流本身存在丢帧/截断重连，GlmDecoder 的 glmSegBuf/seen 拼接已有防御，第二轮补一条「未配平 JSON 开头帧不外发」的护栏；
- c) 重复段判重：收尾 parseAgentReply 与流式开块共用一份文本指纹（已同源），补「重发后旧块不二次外发」。

## Q4 GLM 系列模型真机适配状态（goal/compact/token）

**已真机 PASS（`doc/session-2026-09-26-requirements-and-progress.md` §4.2）**：
- 正文产出：`real-glm-e2e.mjs` 6.1s PASS（思考 150 字+正文"2"）；
- 工具循环端到端：`real-glm-tool-loop.mjs` 48.1s PASS，四判据全过（随机 secret ZQ913 由模型从工具结果复述 → 回注链路活的）；
- 路由：`webcode/glm:glm-5.3`、`glm-5.3-flash`、`auto` 已注册。

**特性适配逐项**：
- **goal**：本会话即证明——goal_round 2 通过 GLM 网页桥自动续跑（`continuations/session-3efcd7ec__glm.json` cumulative:1）。「除本会话模型外新开实例验证」留给第二轮（用 glm-5.3 非 flash 或 deepseek 站点）。已知注意：GLM 强制思考、思考流占比高（2472 回复中 1051 纯思考），goal 轮需要 `usageInput` 累计口径（0.16.22 已改）防预算误判。
- **compact**：0.19.14 aux-delta 修复已覆盖 GLM（研究文档 `2026-09-25-compact-aux-delta.md`）：压缩指令作为**增量**发进主会话（复用 session-anchor 游标），游标失配回落 aux 槽整段重建+rebuild() 重试。5 条护栏测试在 `test/aux-delta-compact.test.mjs`。
- **token**：metrics.js CJK 0.75 tok/字（2026-09-23 校准文档）；glm 上下文 1M 实测下界；DSH 自动压缩阈值=窗口×0.8=80 万 token，正常使用触不到。
- **「不动别的模型根基」纪律**：本轮实施全部「只增不改」——不碰 official/tag 分支、新增站点若需第三种传输形状走 VARIANT_SPECS only 声明，deepseek/glm 零改动（用户最早引用会话的约束仍在生效）。

## Q5 并列多会话：移除「同时发送」+ 三个独立底部对话框（0.19.x 实施方案）

**现状代码**（`lib/client.cjs` MultiModelCompareView `:2231-2468`）：
- 共享一个输入条（`handleSendAll` `:2312`）+ per 列 sessionKey（`team-<scope>-<col>-<site>`）+ pendingRef 计数解锁（0.19.0 修过 Invalid hook call）。

**第二轮实施方案（0.19.x）**：

1. **移除同时发送**：删除共享 form（`:2459-2467`），handleSendAll → 每列独立 handleSendCol(key, text)；发送互不锁（各列独立 sending 状态存列对象 status 字段，沿用 pendingRef 思路但 per 列计数）。
2. **每列底部独立 composer**：列视图底部渲染 input+按钮（placeholder = 「向 <站点> 继续提问…」），DSH 风格的列分隔（hwb-compare-col 已是列布局，补底部 sticky composer 样式）。
3. **沙箱适配（同一文件并发思考/修改）**：
   - 探索列（explorer）输出到**列隔离工作区**：`<workspace>/.hwb/cols/<colKey>/`（列会话目录），文件操作全部落列目录；
   - 主审列（reviewer，用户选定）工作区=主工作树，可读所有列目录，产出走合并；
   - 冲突防线：桥侧文件写拦截（列目录外写入 → 提示列模型改路径或降级只读引用），复用 DSH 沙箱 permissions 枚举思路；
   - 每列的独立会话身份（sessionKey）已有，正好承载「互不影响」。
4. **主审查/探索角色**：列头徽章（主审/探索）+ 设置项「主审列」。主审列收「合并请求」：探索列完成时自动把产出摘要+diff 推给主审列（复用 Q2 的 quote 通道：引用探索列最终回复作为主审输入）。
5. **护栏测试**：client-render 桩判据按「位置」重写（2270 行注释记录过桩测不出 hooks 规则的教训）；team-compare 判据改为断言独立 composer 结构与 per-列发送语义。

## Q6 其余问题全景（第二轮逐项实施）

按优先级（含证据）：

| # | 问题 | 证据 | 修法方向 |
| --- | --- | --- | --- |
| 1 | `browser-driver.js` ANSWER_SELECTOR 服务 10 站点却写死 DeepSeek 类名；`providers.js` 的 `answerSelector` 契约字段**不存在**（声明与实现不同步） | 模块化审计 C1 | 加 `answerSelector` 字段+驱动侧降级兜底 |
| 2 | 站点知识散落 4 文件，新增站点要改 4 处 | CODE-STRUCTURE 第七节第 2 笔 | `lib/sites/<siteId>.js` 收拢（P2，逐站点迁移，DeepSeek 先行） |
| 3 | GLM 深链导航被阿里云滑块拦（裸 goto） | real-probe-30/31 修正记录 | 探针改走驱动路径；深链导航需绕行 |
| 4 | GLM 强制思考不可关，思考流占比高 | 2472 回复 1051 纯思考 | 教学提示已适配；token 口径含思考（0.15.9+） |
| 5 | client.cjs 4992 行 God file | 模块化审计 | 与 sites/ 迁移同期分片 |
| 6 | progress.md 445KB/user-voice-log 477KB 文档体积 | doc 目录清单 | 建立归档轮转（月度切片） |
| 7 | probe 会话文件混在生产 sessions 目录 | sessions 目录实测 | 探针专用 `__probe__` 前缀+定期清理 |
| 8 | `answerSelector` 注释声称存在实际没有（文档漂移） | 审计 §六-4 | 修注释或补字段（随 #1） |

## 本轮未完成（第二轮接手）

1. Q3 适配方案 a/b/c 三条代码落地（涉及 index.js 流式收尾 + decoder 护栏 + 测试）；
2. Q5 三框 UI 实装（client.cjs + web-control.js composer 端点）；
3. Q2 会话级 quote 落地（POST chat quote 参数）；
4. 「新开 DSH 真机实例、用非本会话模型」E2E 验证；
5. 打包 0.19.x 新版本号 + 全量回归 + 安装交付（用户 R9）；
6. 第二轮报告（实施+验证+回归读数）。

— 报告完 —
