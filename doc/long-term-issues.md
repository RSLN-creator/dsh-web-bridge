# 长期问题与已知欠账

本文件收录 **dsh-webcode-bridge 结构性、已知、本次不修**的问题。

它不是 bug 列表：其中的每一条都已经过真机取证或被写进代码注释，且当前**有意**保持现状。
目的是让后续维护者（以及未来的会话）不必把同一件事重新发现一遍。

版本口径：本文件随 **0.14.0** 建立。

## 一览表

| # | 条目 | 严重度 | 阻塞 0.14.0 发布 | 关联文件 |
| --- | --- | --- | --- | --- |
| 1 | 上下文窗口声明口径 | 中 | 否 | `lib/index.js`、`lib/providers.js`、`lib/browser-driver.js` |
| 2 | 会话槽 LRU 上限与淘汰 | 中 | 否 | `lib/index.js` |
| 3 | 网页 UI 漂移 | 高 | 否 | `lib/providers.js`、`lib/contract.js`、`lib/decoder.js`、`lib/browser-driver.js` |
| 4 | 模型选择契约覆盖率 | 中 | 否 | `lib/providers.js`、`lib/browser-driver.js`、`lib/model-picker.js` |
| 5 | 单槽吞吐（**多账号真并发已实现，0.19.4 车道；上限可配 0.19.52**；同账号串行是网页会话的物理约束） | 中 | 否 | `lib/relay.js`、`lib/index.js`、`lib/settings-page.js` |
| 6 | 超时口径三者关系 | 中 | 否 | `lib/index.js`、`lib/browser-driver.js`、`lib/metrics.js` |
| 7 | profile 锁与孤儿 Edge | 中 | 否 | `lib/browser-driver.js` |
| 8 | 发送间隔的基准语义 | 低 | 否 | `lib/index.js`、`lib/metrics.js` |
| 9 | 三项既有假失败（**2026-09-30 实证收口：m2b/m2c 双门全绿——真因三处已修；run-m2.js 已于 0.15.8 删除，登记漂移一并更正**） | 低 | 否 | `doc/review-guide.md`、`test-mock/run-m2b-driver.js`、`test-mock/run-m2c-webapi.js` |
| 10 | 测试脚本的收集口径与环境限制 | 低 | 否 | `package.json` |
| 11 | 大 prompt 的性能提示（可选节） | 低 | 否 | `lib/browser-driver.js` |
| 12 | 图片预算（可选节） | 低 | 否 | `lib/index.js` |
| 13 | 网页端「部分流」自愈（可选节） | 低 | 否 | `lib/browser-driver.js` |
| 14 | Z.ai 无会话地址形状（**0.19.52 landedUrl 会话锚已落地：`/c/<uuid>` 实锤、原地续聊 + 锚回导航；「每轮新开对话」形态就此关闭**；交错会话边界见正文） | 中 | 否 | `lib/providers.js`、`lib/browser-driver.js`、`lib/contract.js` |
| 15 | `<call>` / `</call_call>` 残片漏进正文（**已修，0.14.6**；无下划线族 **0.15.0**） | 中 | 否 | `lib/agent-preset.js`、`test-mock/parse-session-log.mjs` |
| 16 | 同站多账户（**已实现，0.14.7**）+ Team 面板（**已实现，0.15.0**） | — | 否 | `lib/accounts.js`、`lib/providers.js`、`lib/browser-driver.js`、`lib/client.cjs`、`lib/roster.js` |
| 17 | 工具调用参数缺失族（**0.16.16 归因落定**：熔接形吃参；熔接形**已修**，`command` 原样本无法确证同形） | 中 | 否 | `lib/agent-preset.js`（`normalizeDsml`）、`lib/index.js` |
| 18 | **协议原文被持久化进助手正文**（新，0.15.0，**已修**） | 高 | 否 | `lib/agent-preset.js`（`proseSafeEnd`/`normalizeDsml`）、`lib/index.js` |
| 19 | **0.15.6 修复不完整：边界命中但不可执行**（2026-09-16 **已归因 / 0.15.8 已修**） | 高 | 否 | `lib/agent-preset.js`（`invokeBodyEnd`）、`test/fence-nested-call.test.mjs` |
| 20 | `doc/security-review.md` 带 BOM（2026-09-16，低优先） | 低 | 否 | `doc/security-review.md` |
| 21 | **SET 重发吞掉流式增量**（新，0.15.7，**已修**） | 高 | — | `lib/decoder.js`（`emitFragmentDiff`） |
| 22 | DeepSeek 只出思考不出正文（**已重新定性**，2026-09-16 复核） | 高 | 否 | `lib/metrics.js`、`lib/index.js`（`thinkingOnlyNotice`） |
| 23 | **缺 `name` 字段的调用被静默丢弃**（0.15.9 新发现，**已修**） | 高 | 否 | `lib/agent-preset.js`（`inferToolNameFromArgs`）、`lib/index.js`、`test/nameless-call.test.mjs` |
| 10b | 本机 `%TEMP%` 受限导致 3 个测试文件假失败（2026-09-16 实测）——**#10 的子条目**，正文见 §10 的「10b」小节 | 低 | 否 | `package.json`、`test/*.test.mjs`、`doc/progress.md` |
| 24 | **网页侧回复被时间窗判死 / 超长纯文本投递**（0.16.3 部分解决：首字节相位已分） | 高 | 否 | `lib/idle-window.js`、`lib/index.js`、`lib/browser-driver.js`、`test/watchdog-first-byte.test.mjs` |
| 25 | **TOOL_CALL_UNPARSED 两类残根：缺 `name` 的流式块 / 断流截断的参数**（0.16.10 定性；0.16.11–0.16.16 **大幅收口**，残余形态未修，见正文 §25） | 高 | 否 | `lib/agent-preset.js`、`lib/index.js`、`test/fixtures/unparsed-notice-*.txt` |
| 26 | **`empty response from web AI`：思考-only 流走硬失败**（2026-09-19 新登记，**0.16.11 已修**） | 高 | 否 | `lib/index.js`、`lib/browser-driver.js`；与 #22 同族 |
| 27 | **站点品牌图标的来源无法在本机复核**（0.16.36 新登记，**0.16.37 已解决**） | 低 | 否 | `lib/client.cjs`（`SITE_ICON_PATHS`） |
| 28 | **思维链退化重复（同段内容原地打转）**（2026-09-26 新登记，**已修 0.19.26**）——#22 的一个可判定子形态 | 中 | 否 | `lib/repeat-detect.js`、`lib/index.js`（`thinkingOnlyNotice`）、`test/repeat-detect.test.mjs` |
| 29 | **Z.ai 自带风控闸门（验证通过前不发请求）**（2026-09-27 新登记；2026-09-30 实时复现 + 新读数：**滑块弹在无头浏览器里，用户看不见**——「人工打开没见过验证」与「桥轮次被拦」同时为真）——**代码无法解决**，已改为提前如实报错 | 高 | 否 | `lib/providers.js`（`captchaSelector`）、`lib/browser-driver.js`（`WEB_CAPTCHA_REQUIRED`）、`test/captcha-gate.test.mjs` |
| 30 | **Z.ai 真实流帧格式未录制**（2026-09-27 新登记）——9 个既有 decoder 都读不了它；**取证工具链已就绪**（有头探针 + 实时 tee，见正文 2026-09-30 段），缺一次人肉滑块配合 | 高 | 否 | `lib/decoder.js`、`lib/providers.js`（ZAI 的 `decoder` 刻意未改） |
| 31 | **四站的「思考等级」没有真机读数 ⇒ 刻意不声明**（2026-09-28 新登记；**0.19.52 五站已声明 `defaultEffort`——「Default」行消失**；四站缺口维持）——kimi 的 `标准` 档亦未取证 | 中 | 否 | `lib/think-effort.js`、`lib/providers.js`、`test-mock/probe-think-control.mjs` |
| 32 | **kimi 的登录态在 localStorage 而非 cookie ⇒ 「拷 profile 副本」式探针拿到的是游客页**（2026-09-28 新登记，**已给出替代取证法**）——会让真机读数与线上现场错位 | 中 | 否 | `lib/providers.js`（kimi 的 `storageState` 相关注释）、`test-mock/probe-think-effort-live.mjs`、`test-mock/probe-think-control.mjs` |
| 33 | **需要人才能过的验收环节没有「提醒人手动过」的回路**（2026-09-29 新登记）——桥不会自己起浏览器、也不会在取不到读数时明确提示「请手动过一下 z.ai」 | 中 | 否 | `test-mock/probe-think-effort-live.mjs`、`test-mock/probe-think-control.mjs`、`doc/verify.md` |
| 34 | **zai / doubao 的思考等级回读只有静态复算，没有真机读数**（2026-09-29 新登记；**2026-09-30 补上：zai 实时只读 CDP 读数在案（pill「深度思考 最高」）、doubao fresh dump ×4（「豆包 快速」）**） | 中 | 否 | `lib/think-effort.js`、`test-mock/probe-think-effort-live.mjs`、`doc/research/2026-09-28-think-effort-readback.md` |
| 35 | **并列三列的「列级沙箱」是约定而非拦截**（2026-09-29 新登记）——provider 通路会真改文件、控制面通路只回文本；两列今天对工作区没有文件效果，且本插件**结构上**不拥有权限层 | 中 | 否 | `lib/column-context.js`、`lib/column-fs.js`、`doc/research/2026-09-26-column-sandbox-round1-thinking.md` |
| 36 | **`ref-index` 既有红**（2026-09-29 复核：**已解决**）——登记的是「曾被记为欠账、实测已不在」这次更正本身 | 低 | 否 | `reference/README.md`、`scripts/gen-reference-index.mjs` |
| 37 | **两条既有常红是同一条行为：网页会话丢失 → 整段重放**（2026-09-30 复核归因：**已修——根因是测试隔离缺陷，不是重放分支**；2026-09-30 晚登记）——`regression` 53/1 与 `aux-delta-compact` 4/1 的 60s 压线来自裸测试读到真实 profile 的发送间隔与基准 | 高 | 否 | `lib/index.js`（profile 落盘守卫）、`test/profile-isolation.test.mjs`、`doc/progress.md`（2026-09-30 段） |
| 38 | **`NODE_TEST_CONTEXT` 守卫在裸跑形态的残余洞：prompt store 读写通道**（2026-10-02 登记；regression 用例本轮已补隔离）——同族于 #37 的第二条通道；且由此暴露**生产缺陷候选：真实轮重放读回首轮正本会丢后续增量（红线二形状）**，见正文 §38 | 高 | 否 | `lib/index.js`（`readSessionPrompt`、executor 重建分支）、`lib/prompt-store.js`、`test/regression.test.mjs` |
| 39 | **错误码在 harness 边界全部退化成 `UNKNOWN`**（2026-10-02 登记；**同轮已修，0.19.54**）——本插件给普通 `Error` 挂 `.code`，而官方 `normalizeLlmFailure` 只认 `instanceof HarnessError`；实测 284 份会话里归因本插件的 **137/137** 条 error finishes 全是 `code:"UNKNOWN"`（官方 provider 丢码 0 条）。后果：官方 `llm-retry` 自动重试与 `compaction-basic` 超限自动压缩修复**对本插件从未生效且不报错**；UI 一律显示 `UNKNOWN`。另含 `RATE_LIMITED` ≠ 官方 `RATE_LIMIT` 的码名不符 | 高 | 否 | `lib/error-codes.js`（新增，错误码真源）、`lib/index.js`、`lib/browser-driver.js`、`lib/think-effort.js`、`lib/upstream.js`、`lib/zero-progress.js`、`test/error-codes.test.mjs`、`scripts/scan-error-codes.mjs`、`doc/research/2026-10-02-dsh-official-error-and-repair.md` || 40 | **并发会话的「一组一行」在官方会话清单里做不到**（2026-10-03 登记）——用户要「明显的一行是3个重叠标签页形状一行区分与普通会话」；真会话会各自成行，而官方清单条目是 **shell 私有代码**（`SessionNodeItem`），插件只能**装饰既有行**（4 个槽），不能新增行、不能分组。本轮已在**左栏面板行**上用「三个重叠标签页」图标表达「这是会话组」，清单内部分组未做 | 低 | 否 | `lib/client.cjs`（`ConcurrentPanelIcon`）、`doc/progress.md`（2026-10-03） |
| 40 | **并发会话的「一组一行」在官方会话清单里做不到**（2026-10-03 登记）——用户要「明显的一行是3个重叠标签页形状一行区分与普通会话」；真会话会各自成行，而官方清单条目是 **shell 私有代码**（`SessionNodeItem`），插件只能**装饰既有行**（4 个槽），不能新增行、不能分组。本轮已在**左栏面板行**上用「三个重叠标签页」图标表达「这是会话组」，清单内部分组未做 | 低 | 否 | `lib/client.cjs`（`ConcurrentPanelIcon`）、`doc/progress.md`（2026-10-03） |
| 41 | **CI 在 `main` 上长期恒红（2026-09-26 起）**（2026-10-03 登记，**同轮已修**）——每条都是**判据/环境**问题、与产品行为无关：① `site-prompt-transport.test.mjs` 把 profile 建在**被 gitignore 的** `.tmp/` 下，干净 clone 里不存在 ⇒ `ENOENT ...\.tmp\siteprompt-cp-XXXXXX`（④/⑥a/⑥b/session-import 四条一起红）；② `column-fs.test.mjs` 拿**未规范化**的 `columnRootOf()` 去比**已规范化**的写入返回值，在「临时目录带 8.3 短名」的机器（CI `C:\Users\RUNNER~1\…`）必然为假；③ `pre-deliver-window.test.mjs` ①b 用「两轮墙钟之差」量间隔，而 `end-to-start` 基准下该差值恒 = gap − 上一轮稳态收尾（CI 实测 `4302 vs 1514`）；④ `column-fs.test.mjs` 另一条用例用 `new URL(import.meta.url).pathname.slice(1)` 拼源码路径，在 POSIX 上把 `/home/…` 削成 `home/…`（相对路径）⇒ ubuntu 腿 `ENOENT: open 'home/runner/…'`；⑤ `site-mount.test.mjs` 那条「白名单内 + 存在」的断言用 `path.join(os.homedir(),'.dsh')`，而 CI runner 上**没装 DSH** ⇒ 先撞「目录不存在」（两条腿都红）。修完前三条推上去 CI 又红，才暴露出④⑤——被前三条的噪声盖住了 | 中 | 否 | `test/site-prompt-transport.test.mjs`、`test/column-fs.test.mjs`、`test/pre-deliver-window.test.mjs`、`test/site-mount.test.mjs`、`doc/progress.md`（2026-10-03） |
| 43 | **deepseek 与 z.ai 的账号昵称在驱动页面上读不到**（2026-10-03 登记，本轮**不修**）——deepseek 昵称候选 **0 条**（账号区不可见；但头像照样读到，因为读取不判可见性）；z.ai 头像候选 `rect.x = -12`（侧栏在视口外，同为折叠态）且是 Svelte 哈希类名。两站**没有昵称节点的真机读数 ⇒ 不声明选择器**；出路见正文（展开侧栏后取证 / 改成以头像为锚的结构感知读取） | 中 | 否 | `lib/providers.js`（`accountProbe`）、`lib/browser-driver.js`（`readAccountIdentity`）、`test-mock/probe-account-identity-live.mjs`、`lib/account-candidates.js` |
| 44 | **「检查更新」恒报「已是最新」：仓库没跟上 `package.json` 的 tag**（2026-10-04 登记，本轮**不修**）——最新 tag 是 **v0.19.55** 而 `package.json` 已是 0.19.60/0.19.61 ⇒ `latest < current` ⇒ 判据如实给出「已是最新」。真因是 `release.yml` 只在**打 tag** 时产出 tarball，而 0.19.56–0.19.61 几轮只改版本号没打 tag ⇒ Releases 上最后一个是 0.19.55。发版是对外不可逆动作，登记不代做；出路（用户点头后）= `git tag v0.19.61 && git push origin v0.19.61`，且 tag 必须打在 `package.json` 已是 0.19.61 的 commit 上 | 低 | 否 | `package/dsh-webcode-bridge/package.json`、`.github/workflows/release.yml`、`lib/update.js` |
| 42 | **「网页桥接」设置分区的导航图标不可自定义**（2026-10-03 登记）——用户报「仍然是默认齿轮」；真因在**官方壳**里：`settings.section` 的注册契约只有 `id/order/label`（**没有 icon**），导航字形由官方 `dsh-client-ui-settings-general` 的 `navIcon(id)` **硬编码**（只认 `account` / `models` / `agent-presets` / `plugins` / `archived-sessions`，其余一律回落齿轮）。插件侧**结构上无解**，除非改官方包或占用一个 shipped id | 低 | 否 | `lib/client.cjs`（`settings.section` 注册处）、官方 `@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`（`navIcon`）、`doc/progress.md`（2026-10-03） |
| 45 | **桌面 profile 的声明与磁盘分叉：声明仍钉 0.19.61，磁盘已是 0.19.63**（2026-10-05 登记）——本轮靠官方 `client-hmr` 通道**原地热换** `lib/client.cjs` 让桌面端立刻用上修复（不改进程、不重启应用），但**没改 profile 声明**。风险：任何一次 pnpm 通道（装别的插件、启动期 reconcile）都可能把客户端静默换回声明里的旧版 ⇒ 缺陷复发。恢复「声明 == 磁盘」必须**完全退出桌面端**后走官方通道装一次（`dsh` CLI 拒绝管理 desktop profile，须用桌面端自己的 carrier），且宿主半边本来就要重启才换 | 中 | 否 | `~/.dsh/profiles/desktop/package.json`、`~/.dsh/profiles/desktop/node_modules/dsh-webcode-bridge/lib/client.cjs`、`doc/progress.md`（2026-10-05 §八）、`doc/research/2026-10-05-dsh-multi-session-and-client-hot-swap.md` §5 |

> **一览表完整性（2026-09-16 修正；2026-09-26 补上闸门）**：本表此前**漏登记 #19 与 #20**（正文有、表里没有）。
> 这两条都是可机检的登记错误，而当时没有任何闸门覆盖「正文条目 ↔ 表格条目」的一致性。
> 补登记的同时，这条缺口已写进 [`diagnosis-2026-09-16.md`](diagnosis-2026-09-16.md) §6.2 的 P1 排期。
>
> **那条闸门当时并没有被建出来，于是同一族缺陷在 2026-09-26 复发**：#26 的正文标题已写
> 「0.16.11 已修」而表里仍是「未修」；#27 有正文条目、表里根本没有这一行。现已补齐
> [`scripts/check-long-term-issues.mjs`](../../scripts/check-long-term-issues.mjs)（三条判据：
> 正文→表缺行 / 表→正文孤儿行 / 状态矛盾）并接进 `ci-local` 与 `ci.yml`。它自带
> `--self-test`——措辞判据最典型的失效形态不是报错，而是**悄悄不再匹配任何东西**，
> 那时它会一路 PASS、看起来比谁都干净。

错误码视角的横向台账（已做哪些适配 / 残留风险）见 [`bridge-failure-ledger.md`](bridge-failure-ledger.md)。

> **第 16 条状态更新（2026-09-15）**：**Team 面板已实现（0.15.0）**。
> 0.14.9 只做到了「子代理与 Team 分两区渲染」，数据源却是**写死的空数组**——
> 面板永远显示「当前没有正在运行的子代理或 Team 成员」。
> 0.15.0 通过新增 `lib/roster.js` 接上真实数据源：Team 成员走官方
> `agentTeams` 服务的 `listMembers(agent)`，子代理走当前会话的
> `subagentCatalog` 持久化投影。两个分区独立降级，读不到时给空数组
> **并带上原因**（`teamError` / `subAgentsError`），面板据此把「确实没有」
> 与「读不到」分开说。负向断言见 `test/roster.test.mjs`。

## 18. 协议原文被持久化进助手正文（0.15.0 新增，**已修**）
>
> **现象**：assistant/message 的 **text 块**里带着整段 DSML 协议原文被写进会话。
> 真机逐码点取证（不是肉眼）：
>   - 会话 `e5cb719c`（子代理）step 6：354 字符的 text 块，散文之后是
>     `<` + U+FF5C×2 + `DSML` + U+FF5C×2 + **U+0020** + `calls` + `>`，
>     随后 `invoke name="pwsh"`、`parameter name="command"`；
>   - 会话 `session-a6835ca1` step 22：同一形态，**21,905 字符**被写进会话。
>
> **为什么边界探测没拦住它**：`findProtocolStart` 在这两段上返回的是
> `{index: 99/65, transport: true}`——**探测是对的**。但那一轮网页流是断的
> （`no_response_frames` / `stream_ended_before_finished`），invoke 的 JSON
> 只到一半，`parseAgentReply` 返回 **0 个调用**，收尾于是走「没有调用 ⇒ 整段
> 都是正文」的分支，把 `finalText` 全量当 text-delta 发了出去。**漏洞在收尾，
> 不在探测**。
>
> **两个叠加的成因**：
> 1. **`normalizeDsml` 不吃标记后的空格**。旧实现只把 `<` 换成 `<`，
>    空格留在原地，归一化结果是 `< calls>` 而不是 `<calls>`。锚点写作
>    `<\s*\/?\s*(?:…)` 容忍了 `<\s`，所以**边界照样探得到**（这就是它一直没被
>    发现的原因）；但 `partialProtocolAt` 的前缀表是**精确字符串**，`< calls`
>    不是任何一项的前缀，流式半成品防线因此整条失效。
> 2. **收尾不复用探测结论**。「没有可执行调用」被当成了「整段都是正文」，
>    而不是「正文最多到边界为止」。流式期间开过文本块的那条分支更直接：
>    `finalText.slice(textSent.length)` 里的 `textSent` 记的是「已发到哪」，
>    不是「最多能发到哪」——两者在断流轮里不相等。
>
> **修法**：
> - `normalizeDsml` 在标记后**确实跟着已知标记名**时连空格一起吃（带 lookahead，
>   避免把普通换行也吃掉、凭空接出假标签）；
> - 新增 `proseSafeEnd(text, from)`：正文的安全终点只有一个判据，探测与收尾
>   共用（完整锚点优先，否则扣住半成品标记）；
> - `lib/index.js` 的**两条**收尾分支都改用它，并给被扣住的字符数打 `warn` 留痕
>   ——静默丢弃会让「模型什么都没干」与「模型调用了但流断了」在日志里长得一样。
>
> **护栏**：`test/protocol-leak.test.mjs` 的 `proseSafeEnd` 用例组（含
> 「标记后带空格」「截断在标记中间」两个真机形态）+
> `test/protocol-leak.test.mjs` 的锚点/检测器一致性断言。
>
> **与第 15 条的关系**：同一族问题的第 3 次。第 15 条留下的方法论
> 「检测器不能只覆盖已知形态」在本条上第 2 次生效——这次是**归一化**与
> **收尾**两处各自漏了一种形态，而它们都共享同一个假阴性外观
> （「日志没有泄漏告警」）。

---

## 1. 上下文窗口声明口径：**已改为实测下界**（0.14.2 部分解决）

> **0.14.2 更新**：本条的一大部分已经落地，阅读时请以下面为准。
>
> - **「composer 真实上限未知」这个前提被推翻了**。真机探针
>   （`test-mock/real-probe-23-glm-budget.mjs` + `real-probe-24-glm-ceiling.mjs`，
>   2026-09-14，有头 Edge + 真实登录态）把输入框逐档灌满并回读：GLM 到
>   **1,200,000 字符**、Z.ai 到 **1,000,000 字符**，**全部逐字回读、没有一档被截断**。
>   即输入框容量比原先假设的大得多，**从来不是瓶颈**。
> - 声明值因此收口为 `providers.js` 的 `GLM_CONTEXT_WINDOW = 1_000_000`（glm 3 条 +
>   zai 4 条共用），并有**实测下界**支撑，不再是随手写的占位。
> - **仍然未知、也测不到的是「模型注意力窗口的规格」**——那要看站点服务端的截断
>   行为，探针测不出来，且会随网页改版变化。所以声明值的真实语义是
>   「本桥愿意让 transcript 长到多大」，**不是**模型规格。这一点已写进代码注释。
> - **越界现在有专门的闸**：`metrics.checkContextBudget` + `CONTEXT_WINDOW_EXCEEDED`
>   （在 `buildTurn` 之后、`attach` 之前拦下，网页端完全未被写入），
>   配合既有的 `PROMPT_TRUNCATED` 回读校验形成「发前拦、发后核」两道。
> - **声明值现在可见**：`GET /__webcode/context-windows` 列出每站点的声明值与来源。
>
> 下面保留原文，因为「为什么当初选择保守声明」的推理与
> 「未校准站点仍取 64_000 兜底」这两点**依然有效**。

### 现状

DSH 的 LLM provider 必须通过 `resolveModel` 声明一个 `contextWindow`，宿主据此决定何时压缩
transcript。但**网页 composer 的真实上限未知**——它是网页端的实现细节，没有对外契约。

代码位置：`lib/index.js` 的 `resolveModel`，`lib/index.js:434-441`。取值优先级是：

1. 模型自带 `m.context`（`lib/providers.js` 各站点的 `models[].context`，如 `deepseek` 为
   `1_000_000`，见 `lib/providers.js:42`）；
2. 配置项 `cfg.contextWindowBySite[siteId]`（默认只有 `{ deepseek: 1_000_000 }`，
   见 `lib/index.js:49-52`）；
3. 兜底：`deepseek` 取 `1_000_000`，**其余站点取 `64_000`**（`lib/index.js:439-441`）。

越界不靠截断兜底，而靠**回读校验**：驱动填入输入框后会 `readComposer` 回读一次，
长度短于原文超过 8 个字符即抛 `PROMPT_TRUNCATED`，且此时还没按发送键，网页端未被污染
（`lib/browser-driver.js:1081-1089`）。

### 影响

- 声明值偏小时，DSH 的上下文压缩会比网页真实能力**更早**触发——多花几轮压缩，但不会丢内容。
- 声明值偏大时，压缩可能永不触发，transcript 只增不减，最终撞上 `PROMPT_TRUNCATED`
  或网页端性能下降（见第 11 节）。
- 用户在 GUI 上看到的上下文占用百分比，是相对一个**估计值**的比例，不是网页真实用量。

### 为什么现在不修

真实上限只能靠真机二分探测得出，且**会随网页改版变化**——今天测出的数字明天就可能失效。
把它写成"精确值"反而制造一种不存在的确定性。当前选择是「保守声明 + 越界明确报错」：
失败是可见的、可解释的，而不是静默截断成半截提示词（后者表现为「越到后面越答非所问」，
正是 `lib/browser-driver.js:1081-1083` 注释里记录的历史症状）。

### 若要修，从哪下手

做一次可重复的真机探测（`test-mock/` 下新增探针：逐档递增字符数，直到 `PROMPT_TRUNCATED`），
把结果按站点写进 `cfg.contextWindowBySite`，并在设置页暴露「按真机校准」按钮。
但探测结果必须有失效日期与复检入口，否则只是把漂移问题推迟。

---

## 2. 会话槽 LRU：上限 512，超出丢弃最老条目

### 现状

`sessionState` 是 `apply()` 作用域内的一个 `Map`，键是会话路径，值是「已经发到第几条消息」
的游标（`lib/index.js:362`）。

- 淘汰阈值写死在提交路径里：`lib/index.js:1476`——`if (sessionState.size > 512) sessionState.delete(sessionState.keys().next().value);`
- 策略是 **LRU**，靠「先删后插」把键移到 `Map` 尾部实现（`lib/index.js:1470-1475`）。
  注释明确记录了旧写法的错误：对已存在的键 `set` 不改变插入序，淘汰会先丢掉**最老的热会话**。

### 影响

被淘汰的会话在下一轮会被判为「无游标」→ 走 `serializeFirstTurn` **整段重发**。
表现为：一个长期挂着的会话，忽然在某一轮把全部历史重新发一遍（网页侧也会因此变慢）。
用户看到的是「上下文像重置了」，但实际是游标丢失导致的重复发送，不是内容丢失。

### 为什么现在不修

512 个并发活跃会话远超单机实际用量（本插件的瓶颈是单槽吞吐，见第 5 节），
调大上限只是把内存压力往后推。真正的修复方向不是「更大的 Map」，而是
「把游标持久化到会话存储」——那是一次数据结构变更，不该在 0.14.0 的收尾里做。

### 若要修，从哪下手

把 `sessionState` 从内存 `Map` 改为经 `ctx.get('sessionPersistence')`（或 profile 目录下的
小 JSON）持久化的键值存储，并对 `commit()` 的写入做原子化处理（参考 `lib/index.js:1055-1063`
的 `rememberSend` 写法）。上限可保留，但淘汰应只发生在冷会话上。

---

## 3. 网页 UI 漂移：契约是手工维护的，改版即失效

### 现状

每个站点的网页契约（输入框/发送按钮/停止按钮/附件选择器/完成路径/解码器）集中声明在
`lib/providers.js` 的 `SITES` 数组里，严格模型校验与期望元数据在 `lib/contract.js`，
各站点流解码器在 `lib/decoder.js`。**这三处是站点知识的唯一定义处**，其余模块只面向
`{site, model}` 二元组（`lib/providers.js:1-8` 的注释即此约定）。

发现漂移的手段：

- **错误码**：`MODEL_UI_CHANGED`（未捕获到请求体，或实际元数据与期望不符，
  `lib/browser-driver.js:1120-1144`）、`MODEL_UNAVAILABLE`（模型切换失败，
  `lib/browser-driver.js:1295-1300`）、`PROMPT_TRUNCATED`（`lib/browser-driver.js:1086-1088`）、
  `WEB_SESSION_LOST`、`RATE_LIMITED` 等。
- **探针**：`test-mock/real-verify.mjs`（`pnpm doctor`）、`real-probe-17` ~ `real-probe-20`，
  以及站点级的 `probe-model-dropdown.mjs` / `verify-model-switch.mjs`。清单见
  `doc/review-guide.md:41-50`。
- **只读诊断端点**：`GET /__webcode/diagnostics` → `driver.diagnostics()`
  （`lib/web-control.js:201`，实现见 `lib/browser-driver.js:1496-1531`），返回当前 URL 路径、
  检测到的 UI 代际、`selectedModel`、`requestMetadata`、composer 附近的可点元素列表等。

### 影响

任意一家站点改版，都可能让该站点的选择器或解码器失效。故障形态从「完全不能用」
（输入框定位不到）到「静默降级」（能对话但模型没切过去）不等。

### 为什么现在不修

**不能自动适配**，因为网页 DOM 与 SSE 形状没有稳定契约，任何「自适应选择器」都只能靠启发式猜，
而猜错的代价正是历史上最严重的一类事故——0.12.9 的 `getByText(labels[0], {exact:true})`
启发式会选错模型（`lib/browser-driver.js:1263-1273`、`lib/providers.js:307-308` 记的
`GLM-5.3` 是 `GLM-5.3-Flash` 前缀这一具体陷阱）。当前立场是：**宁可不切，也不猜着切**。

### 若要修，从哪下手

把「发现漂移」做成例行而非事后：定期跑 `pnpm doctor` + `real-verify.mjs`，
把每次真机 dump 落进 `test-mock/out/` 并纳入版本控制（现在已经是这个模式，
见 `lib/providers.js` 各站点注释里引用的 dump 文件名），使选择器变更可 diff、可回溯。
进一步的自动化只能做到「改版后立刻报警」，做不到「自动修好」。

---

## 4. 模型选择契约覆盖率：部分站点有，其余如实报 unverified

### 现状

`lib/model-picker.js` 执行「精确名匹配 + 点击后回读确认」。是否可用由
`pickerUsable(picker)` 判定（`lib/model-picker.js:355-357`）——`segmented: true` 的契约
**故意不声明 trigger**（选项常驻页面，点触发等于先把模式切走）。

**当前有 `modelPicker` 契约的站点**（从 `lib/providers.js` 读出，非推测）：

| 站点 | 形态 | 位置 |
| --- | --- | --- |
| `glm`（智谱清言） | 弹层式，`.think-mode-trigger` → `.think-mode-item` | `lib/providers.js:73-88` |
| `kimi` | 弹层式，触发只显示思考强度，回读需开菜单（`readbackInMenu: true`） | `lib/providers.js:147-158` |
| `doubao`（豆包） | **分段式**，`segmented: true`，无 trigger、无 `aria-selected` | `lib/providers.js:218-224` |
| `zai`（Z.ai） | 弹层式，`button.modelSelectorButton` → `button[aria-label='model-item']` | `lib/providers.js:309-314` |

**当前没有 `modelPicker` 契约的站点**：`deepseek`（走独立的 `selectModelDeepSeek` 路径，
不使用通用契约，见 `lib/browser-driver.js:1259`）、`chatgpt`、`qwen`、`grok`、`claude`、`gemini`。

没有契约时的行为：先试一次原生 `<select>`（读回值相等才算成功），否则
`selectedModel = null`，返回 `{ strict: false, fallback: 'unverified' }` 并 `warn`
（`lib/browser-driver.js:1275-1292`）。**不假装切换成功**——这一点是 0.13.0 的
核心修正，旧实现在没有契约时猜着点、点不到就 `return { strict:false, fallback:'default-model' }`，
而调用方把它当成功继续走，于是模型选择在多数站点上是静默的空操作
（`lib/browser-driver.js:1266-1273`）。

另外两类「点了但无法确认」也如实标注：
`readback-mismatch`（点了也回读到名字，但不是目标名）与 `unverified-click`
（站点没声明回读选择器），见 `lib/browser-driver.js:1303-1312`。

### 影响

对无契约站点，用户在选择器里选「Qwen」「Grok」等具体条目时，**桥不做任何模型 UI 操作**，
实际对话用的是网页当前选中的模型。选择器里能选 ≠ 网页上真的切了。

### 为什么现在不修

契约必须逐站真机 dump 才能写（`test-mock/probe-model-dropdown.mjs`），而
`chatgpt` / `claude` 在本机网络层返回 403（WAF / 地区限制，见 `lib/providers.js:107-111`
与 `:255-259`），**根本进不去页面**，无从 dump。这是网络级障碍，不是代码问题。

### 若要修，从哪下手

对可达但未校准的站点（`qwen` / `grok` / `gemini`）逐个跑 `probe-model-dropdown.mjs`，
按 dump 结果往 `lib/providers.js` 补 `modelPicker`；每补一个，在
`test-mock/verify-model-switch.mjs` 里加一条真机断言。`chatgpt` / `claude` 需要先解决网络可达性。

---

## 5. 单槽吞吐：网页一次只能跑一轮，并行子代理只能排队

> ### 2026-09-30 结账（0.19.52）：「多 profile 真并发」的可调面已落地
>
> 车道模型（同账号串行、跨账号真并发、每车道独立浏览器实例）0.19.4 起就在
> `relay.js`；本轮（用户指令「真并发 = 多 profile，我需要实现」）把**上限**从常量
> 提升为设置项：`maxConcurrentLanes`（默认 2 = 保守起点逐字保留，夹取 1..8，
> 设置页「速度与排队保护」分组，**保存即生效**——`configManager.set()` 经
> `laneCapSink` 直写 `relay.config`）。用法：设置页「网站账号」给站点配多个账号
> （每账号独立 profile/浏览器），再调大上限即真并发。护栏 `settings-transport` ⑨。
> **仍不解决的**：同一账号内的并发（一个网页会话只有一个输入框，多发互相污染——
> 被操作对象决定的物理约束，与实现无关）。
>
> 下面保留原文（「为什么当时不做」的推理仍有效：单账号场景的串行是约束不是缺陷）。

### 现状

`lib/relay.js` 是一个**单槽执行器 + FIFO 队列**：`busy` 标志保证同一时刻只有一个请求在跑
（`lib/relay.js:88-91`、`lib/relay.js:208-211`）。原因写在文件头注释里——
「the web page only ever automates one message at a time (low-frequency)」
（`lib/relay.js:10-12`）。

- **队列上限 32**：超出直接拒绝，错误文本是
  `queue full (32) — the web page is a low-throughput backend`（`lib/relay.js:216-219`）。
- **排队超时 `queueTimeoutMs`**：`lib/relay.js:26` 的默认值是 `300_000`（5 分钟），
  但插件通过 `DEFAULTS` 传入 **`900_000`（15 分钟）**（`lib/index.js:42-45`）。
  该默认值的注释明确写了为什么必须显著大于单轮上限：旧值 300s 只比单轮的 240s 多 60s，
  排在第二位的请求几乎必然「刚开始跑就超时」，长任务里的并行分支会成片失败。
- 排队中的请求可以被取消：`item.signal` 的 abort 会把它从队列里摘掉（`lib/relay.js:237-247`）。

### 影响

并行子代理（DSH 侧同时发起多个分支）在本插件上是**串行**的。第 N 个分支的端到端延迟
≈ N × 单轮耗时。队列满 32 或排队超过 15 分钟的分支会直接失败。

### 为什么现在不修

不能并发是**被操作对象**决定的，不是实现偷懒：一个 Edge profile 对应一个网页会话，
网页 composer 一次只接受一条消息，多发会互相污染输入框与流捕获。要做真并发，
需要多 profile / 多账号 / 多 Edge 实例，那是产品级决策（登录态、风控、资源占用），
不属于当前插件的范围。

### 若要修，从哪下手

若真要提升吞吐，方向是「按站点开多槽」（每个站点已有独立 profileDir 与独立 driver，
见 `lib/index.js:931-956`），把 `busy` 从全局改为**按站点**。但同一站点内的并发仍然无解。
队列上限与超时值可改为可配置项（当前 32 与 900s 都是常量）。

---

## 6. 超时口径：三个超时各管一段，不要混为一谈

### 现状

0.14.0 之后有三个独立的超时概念，作用域完全不同：

| 名称 | 默认值 | 配置项 | 作用域 | 位置 |
| --- | --- | --- | --- | --- |
| `requestTimeoutMs` | `240_000`（240s） | `cfg.requestTimeoutMs` | **单轮**总上限：从发出到本轮结束 | `lib/index.js:41`、`lib/relay.js:25`、`lib/browser-driver.js:177`、定时器在 `lib/browser-driver.js:1046-1067` |
| `WIP_IDLE_MS` | `2500`（2.5s） | `cfg.wipIdleMs` | **稳态窗口**：流停且 DOM 停止增长持续这么久 → 按已有正文收束 | 常量 `lib/browser-driver.js:217`、`lib/index.js:1072`；判定 `lib/metrics.js:106-111`；巡检 `lib/browser-driver.js:531-578` |
| `IDLE_TIMEOUT_MS` | `120_000`（120s） | `cfg.idleTimeoutMs` | **适配器侧看门狗**：自上次 delta/think/image 起无任何事件 | `lib/index.js:1073`、消费点 `lib/index.js:503-514` |

三者的关系：

- `WIP_IDLE_MS` 是**救援**机制，把「网页写完了但没送 FINISHED」的轮次在秒级救回来，
  避免用户看到无限「思考中」。它的判定是**双条件**（流停 **且** DOM 助手消息长度停止增长），
  任一条不满足就不收束——只看流停会把仍在生成的长回复判死（`lib/metrics.js:93-95`）。
- `IDLE_TIMEOUT_MS` 是**护栏**，管的是 WIP 收束救不了的那一类：捕获链从未建立、页面僵死、
  或整个 relay 卡在别处。它必须在 `WIP_IDLE_MS` **之后**才开火，否则会把本可救回的回复判死——
  代码里用 `Math.max(WIP_IDLE_MS + 1000, ...)` 强制保证这个顺序（`lib/index.js:1071-1073`）。
- `requestTimeoutMs` 是**兜底**，只在驱动自己还在跑时有效。

`endReason` 会在 relay metrics 里透出收束原因：`finished` / `partial-wip-settled` /
`timeout`（`lib/relay.js:181-183`）。

### 影响

三者都可在真机上表现为「等很久然后失败」，但修法完全不同：
调 `wipIdleMs` 治「回复写完了却卡住」，调 `idleTimeoutMs` 治「桥这边没有事件」，
调 `requestTimeoutMs` 才是真的在改单轮预算。混用会互相掩盖。

### 为什么现在不修

这不是缺陷，而是三层的分工。但三者**只存在于代码与配置项里**，设置页没有暴露——
用户遇到「卡住」时只能看到一个笼统的失败，无法自己调。

### 若要修，从哪下手

在设置页暴露三个值（带「必须满足 idleTimeoutMs > wipIdleMs + 1s」的校验提示），
并在右栏统计里显示本轮实际的 `endReason`。`endReason` 已经在 metrics 里了
（`lib/relay.js:181-183`），只差展示。

---

## 7. profile 锁与孤儿 Edge：只能按命令行匹配杀

### 现状

Windows 上 Chromium 的持久 profile 有单实例锁，锁文件是
`SingletonLock` / `SingletonCookie` / `SingletonSocket` / `lockfile`
（`SINGLETON_FILES`，`lib/browser-driver.js:596`）。浏览器被强杀或启动中途失败时这些文件会留下，
下一次 `launchPersistentContext` 直接抛 `ProcessSingleton` 类错误——
用户看到的是「退出过一次之后不管哪里都无法登录」（`lib/browser-driver.js:592-595`）。

处理分三层：

1. **清陈旧锁文件**：`clearStaleProfileLocks()` 只在本次进程确认没有活着的 `ctx` 时才清
   （有 `ctx` 说明锁是真被持有的），`lib/browser-driver.js:597-616`。
2. **清不掉时杀孤儿进程**：Windows 上 `fs.rmSync` 抛 `EPERM` 意味着锁被一个**活着的** Edge
   持有，于是调用 `killOrphanEdgeForProfile()`（`lib/browser-driver.js:611`）。
3. **WMI Terminate**：用 `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"`
   过滤出命令行包含本 `profileDir` 的进程，逐个 `Invoke-CimMethod ... Terminate`，
   `lib/browser-driver.js:621-636`。必须走 WMI，因为 `Stop-Process` / `taskkill` 对 Chromium
   子进程的受限 DACL 会拒绝访问（真机 2026-09-12 实测）。

另有一条更温和的路：`releaseOrphanByCDP()`（`lib/browser-driver.js:638-649`）经
profile 里的 `DevToolsActivePort` 连上调试端口后 `browser.close()`，让孤儿进程优雅退出。

### 影响

**局限很明确：只能杀掉命令行里含本 `profileDir` 的进程。** 如果 Edge 的启动方式让
`CommandLine` 里不含该路径（例如由别的启动器拉起、路径被改写、或用户手动开的 Edge
恰好用了同一个 profile），孤儿进程就杀不掉，锁也清不掉，该站点会一直无法启动。
此时唯一的恢复手段是用户手工关闭那个 Edge。

另外，杀进程是**有副作用**的：若那个 Edge 窗口里还有用户自己的标签页，它们会一起被终结。

### 为什么现在不修

没有更精确的判据可用：Windows 上无法从进程反查「它是否持有这个 profile 的锁」。
命令行匹配是在「不误杀用户自己的 Edge」与「能救回卡住的场景」之间的折中——
宁可漏杀（用户手工处理），也不误杀。

### 若要修，从哪下手

优先走 `releaseOrphanByCDP()`（优雅、无副作用），把 WMI 强杀降级为最后手段；
并在失败时把「请手动关闭任务管理器里的 msedge.exe」写进面向用户的报错文本
（目前只有 `warn('orphan edge kill failed:', ...)`）。

---

## 8. 发送间隔的基准：已改为 send-to-send，**切换项已于 0.16.31 落地**

> ### 2026-09-20 结账（0.16.31）：本节「待定项」已实现，不再挂账
>
> 用户指令（逐字）：「我需要的是 web 思考后调用时间后不立即回复而是间隔多少秒回复，
> 不是现在好像是的那个距离上传里面回复时间？注意是为了隔开和他发消息我立马回复的规避点！」
>
> 即本节下面预告的 `basis` 开关**按原计划落地**（`'send-to-send' | 'end-to-start'`，
> 命名沿用「若要修，从哪下手」里的写法）：
>
> - `computeSendGap({ lastSendAt, lastEndAt, basis, now, gapMs })`，返回值新增 `basis` 回显；
> - `webcode-send-state.json` 的值从裸数字升成 `{ send, end }`，**旧格式照样读**
>   （裸数字即 send、end 缺失），升级不丢基准；
> - 设置页两个面（HTML 页 + 右栏 React 面板）都有口径下拉，`POST/GET settings` 双向归一化；
> - 读数 `gapBasis` 进 metrics 与面板明细行（「距上次发出」/「距上次回复完成」文案随口径切换）；
> - 默认**仍是 send-to-send**：改默认值等于静默改掉所有既有用户的行为，因此只新增选项。
>
> 护栏 `test/send-gap-basis.test.mjs`（纯函数 + 源码结构两段）；既有
> `test/send-gap.test.mjs` 八条逐字未改、全部仍绿。
>
> 顺带修掉本节下方「判定与透出」没提到的一个真缺陷：药丸的**跳动**。
> 旧实现把 `clearLiveWait` 放在等待 sleep 的 `finally` 里，于是等待一结束在途读数就
> 消失，而账本要等整轮生成跑完才吸收——中间那几十秒药丸掉回上一轮的旧值、收束时
> 再跳上去。现在正常路径保留在途读数（`endsAt` 已把它冻结），只有 abort 才清。

### 现状

设置页的「发送间隔」= 两次向同一站点**发送**之间的最小毫秒数，也是 `RATE_LIMITED`
退避的基数（`lib/index.js:65-72`）。

0.14.0 做了两处语义修正：

- **基准从「上一轮结束」改为「上一轮发出」**（send-to-send）。旧实现在长回复下会把等待
  吃掉——真机实测一轮跑 20918ms 时，10000ms 的间隔只剩 7609ms 可见
  （`lib/index.js:68-71`，现场记录见 `.local-plans/PLAN-0.14.0-HANDOFF.md:28-29`）。
- **基准落盘**：`<profileDir>/webcode-send-state.json`，原子写 + `0o600`，启动读回时丢弃
  24h 以上的陈旧条目并拒绝未来时间戳（时钟回拨）（`lib/index.js:1031-1063`，
  判定函数 `lib/metrics.js:68-80`）。旧实现只在进程内存里，DSH 每次重启就清空，
  于是**重启后第一轮零等待**。

判定与透出：`computeSendGap()` 返回 `{ waitMs, sincePrevSendMs, skewed }`，
metrics 里对应 `sendWaitMs` / `gapTargetMs` / `sincePrevSendMs`
（`lib/relay.js:173-183`、`lib/index.js:1121-1136`）。

### 待定项：基准是否应该做成可切换项

`.local-plans/PLAN-0.14.0-HANDOFF.md:181` 把 `sendGapBasis` 的**切换项**列为待办，
而 0.14.0 只实现了单一语义（send-to-send）。两种语义各有适用场景：

- **send-to-send**（当前实现）：防止**发送频率**过高触发站点滑窗限流。
  间隔从发出那一刻起算，长回复期间时钟一直在走，因此下一轮可能**不需要等待**——
  这正是「设了 10s 却看不到等待」的另一半来源，而这是正确的行为。
- **end-to-start**（旧语义）：保证两轮之间有固定的**冷却期**，给站点侧的处理留出喘息。
  对「回复越长、服务端越累」的站点更安全，代价是整体吞吐更低。

两者不是对错之分，是防护目标不同。

### 影响

当前固定为 send-to-send。如果某个站点实际是被「轮次间冷却」而非「发送频率」限流的，
当前实现会在长回复后立刻再发，可能撞上限流（表现为 `RATE_LIMITED` 退避重试）。

### 为什么现在不修

两种语义都需要真机数据才能判断哪家站点适用哪种，而 0.14.0 已经有更紧急的
「卡住」问题要收尾（见 `.local-plans/PLAN-0.14.0-HANDOFF.md` 的 P1-3）。先在单一语义上把
**可见性**做对（设置值与实际间隔都透出，没等待时也有数字可核对），
比再加一个开关更重要。

### 若要修，从哪下手

在 `computeSendGap` 之上加一个 `basis` 参数（`'send-to-send' | 'end-to-start'`），
设置页加对应选项，`webcode-send-state.json` 需要同时记「上次发出」与「上次结束」两个时刻。
`lib/metrics.js` 的 `computeSendGap` 是纯函数，两种语义都可以离线断言。

---

## 9. 三项「既有假失败」：**归因错误**（2026-09-16 复核推翻；**2026-09-30 实证收口**）

> ### 2026-09-30 实证收口：m2b/m2c 双门全绿，「UNTESTABLE」的旧判作废
>
> 本会话的沙箱不再挡子进程派生（danger-full-access），两门**真跑**后的实锤——
> 2026-09-16 那条「断言从未被执行」的环境结论在本机已不成立，且真跑暴露了
> 三处真因（全部已修，读数见 `doc/progress.md` 2026-09-30 第二轮 §六）：
>
> 1. `bin/bridge-standalone.js` 的 `driverFor` 条件**反了**：mock 形态
>    （`WEBCODE_SITE` 已设）的 deepseek 请求被派去指向**真实站点**的懒驱动
>    ⇒ NEED_LOGIN ⇒ `completion via driver` 恒失败——这正是被记为「恒 FAIL」的
>    那一条，**它是真缺陷，不是环境假失败**。
> 2. m2b 断言停在两处旧语义：consent 0.19.31 起默认开（关闸的正确形态 = 落盘
>    `accepted:false`；`WEBCODE_NO_CONSENT` 是「无闸」不是「关闸」）；非流式
>    content 0.16.x 起是 parts 数组（图片支持）。
> 3. mock-server 停在旧版 UI 形态（模型 select），现行契约是统一 UI 的
>    「深度思考」pill + `model_type/thinking_enabled` 请求体——mock 已升级。
>
> **收口读数**：`run-m2b-driver.js` PASS；`run-m2c-webapi.js` **10/10 PASS**。
> 另更正一处登记漂移：`run-m2.js` 已于 0.15.8 随归档**删除**（git 实查），
> 本条标题里的「三项」实际只剩两门。
>
> 下面两段保留原文（历史归因链，含 2026-09-16 的复核）。

> ### 2026-09-16 复核推翻（本条的归因是错的）
>
> **这三项既不是「假失败」，也不该被记成「干净树上同样失败的既有欠账」。**
>
> 实跑（已设好 `TMPDIR`/`TEMP`/`TMP`，排除上一节 `%TEMP%` 的干扰）：
>
> ```
> node test-mock/run-m2.js          → ❌ M2  harness failure: spawn EPERM   EXIT=1
> node test-mock/run-m2b-driver.js  → ❌ M2b harness failure: spawn EPERM   EXIT=1
> node test-mock/run-m2c-webapi.js  → ❌ M2c harness failure: spawn EPERM   EXIT=1
> ```
>
> 三者**没有一个跑到自己的断言**。死在进程派生的位置：
> `run-m2.js` 的 `spawn(process.execPath, [ …build-test-extension.js ])`、
> `run-m2b-driver.js` 与 `run-m2c-webapi.js` 各自 `start()` 里的 `spawn(process.execPath, [ … ])`。
>
> 根因与本节下一段记录的**完全同源**：Node 在本机创建子进程被沙箱挡住
> （`doc/progress.md` 的「已知环境约束」里已写「`spawnSync` 四种写法全部 EPERM」）。
>
> **三条推论**：
>
> 1. 原结论「走的是已废弃的扩展链路 / mock 响应形状脱节」**没有被任何实测支持**——
>    因为脚本在触及那些逻辑**之前**就死了。它是从历史推测写成的，不是测得的事实。
> 2. `run-m2c` 的真正断言（`completion via driver`）**本次根本没被执行**。
>    说它「恒 FAIL」属于**未经执行的结论**。
> 3. 「干净树上同样失败」这句**不可验证**：本机无法在干净树上跑到断言层。
>
> **改为**：这三项在本机（沙箱）**无法运行**，状态是 **UNTESTABLE**，不是 FAIL。
> 真正的验证要么在 CI 上做（CI 里 `spawn` 可用），要么先用真的 Node 子进程能力复核。
> 在拿到 CI 读数之前，**不得**再把它们当成「已知既有失败」来解释红色项。
>
> 另：上一节新增的「`%TEMP%` 受限致 3 个测试文件假失败」是**另一类**环境假阳性，
> 特征不同（那个是 `mkdtemp` EPERM，可用 `TMPDIR` 绕过；本节这个是 `spawn` EPERM，
> 无法用环境变量绕过）。两者都记在 #10 的收集口径下。

### 现状（原文，保留以供对照）

来自 `doc/review-guide.md:52-59`，原文收录：

- `test-mock/run-m2.js`：走的是已废弃的浏览器扩展链路（`extension/`），
  当前架构不再使用，**M2 恒 FAIL**。
- `run-m2b-driver.js` / `run-m2c-webapi.js`：mock 站点的响应形状已与驱动期望脱节，
  `completion via driver` 一项**恒 FAIL**。其余断言仍有效。

这三项在改动前的干净树上同样失败。

### 影响

跑真机/mock 套件时会有固定的红色项。任何「全绿」的说法都必须把这四项排除在外，
否则会被误判为回归。

### 为什么保留它们（而不是删掉）

- `run-m2.js` 对应的 `extension/` 链路**代码仍在仓库里**（虽然不在运行链路，
  `doc/review-guide.md:27-28` 明确说审查时可跳过）。删脚本而不删链路，等于把
  「这条链路已废弃」这一事实的唯一记录也删掉。
- `run-m2b` / `run-m2c` 的其余断言**仍然有效**——它们覆盖的是驱动与 webapi 的其它行为，
  只因 mock 响应形状脱节而挂掉一项。删掉整个文件会连带丢掉那些覆盖。
- 把假失败记录在案，比让每个新维护者重新发现一次要便宜得多。这正是本文件存在的理由。

### 若要修，从哪下手

- `run-m2.js`：要么随 `extension/` 一起删除（需先确认无人依赖），要么改成显式 skip 并打印原因。
- `run-m2b` / `run-m2c`：更新 mock 站点的响应形状，使 `completion via driver` 这一项能真跑通；
  或者把该项从断言改为「已知不适用」的标注。

---

## 10. 测试脚本的收集口径与环境限制

### 现状

`package/dsh-webcode-bridge/package.json:12` 的 test 脚本：

```
node --test "test/*.test.mjs" && node test/parse.test.mjs && node test/run-m1.js
```

即用 **glob 收 `test/*.test.mjs`**，后面再用 `&&` 串上两个显式脚本
（`test/parse.test.mjs` 与 `test/run-m1.js`）。前者本来就落在 glob 模式内，
属于重复列出（无害）；后者是 `.js` 后缀的 M1 契约脚本，glob 收不到，必须显式写。

`doc/review-guide.md:38-39` 的告诫：「glob 收全 `test/*.test.mjs`，别再把新测试文件漏在脚本外」。

**环境限制（本机沙箱）**：`node --test "test/*.test.mjs"` 可能以 `spawn EPERM` 失败
（`.local-plans/PLAN-0.14.0-HANDOFF.md:35-36`）。规避方式是**逐文件**跑：

```
node test/<file>.mjs
```

### 影响

- 新增测试文件时，若文件名不匹配 `test/*.test.mjs`（例如放在子目录、或后缀不同），
  它不会进入 `npm test` 的收集范围，**永远不跑**——这是静默的覆盖率漏洞。
- 在本机沙箱下，`npm test` 会因为 `spawn EPERM` 直接失败，看起来像测试挂了，
  实际是环境限制。误判方向是「以为是回归」。

### 10b. 本机 `%TEMP%` 受限导致 3 个测试文件假失败（2026-09-16 实测）

> 2026-09-16 补充：本机还有**第二类** EPERM，特征不同，别混为一谈
>
> | | 触发点 | 表现 | 能否绕过 |
> | --- | --- | --- | --- |
> | 甲（上段，已记录） | `spawn` 子进程 | `node --test glob` / `npm test` / `run-m2*` 整体 EPERM | **不能**（需真子进程能力，只能逐文件跑或上 CI） |
> | **乙（本次新记）** | `fs.mkdtempSync(os.tmpdir())` | **3 个测试文件假失败**，其余 36 个正常 | **能**：把 `TMPDIR`/`TEMP`/`TMP` 指到工作区 `.tmp` |
>
> 乙类实测：沙箱把 `%TEMP%` 设为 ACL 受限目录，`mkdtempSync` 一律
> `EPERM: operation not permitted, mkdtemp 'C:\Users\…\Temp\dsh-XXXX\…'`。
> 命中 `regression.test.mjs`、`tool-loop.test.mjs`、`wiring-roster.test.mjs`
> （三者都用 `mkdtempSync(path.join(os.tmpdir(), …))` 建临时 profileDir）。
>
> **同一台机器、同一 Node 进程的对照实验**：
>
> | 目标目录 | `mkdtempSync` |
> | --- | --- |
> | `os.tmpdir()`（= 受限 `%TEMP%`） | **EPERM** |
> | 工作区内 `.tmp` | **OK** |
>
> **反向验证**：设好三个环境变量后逐文件重跑 →
> **`ok=39 fail=0`**。即台账「39/39 全绿」是对的，前提是绕过乙类 EPERM。
>
> **收尾纪律**：本机复核测试时，先设 `TMPDIR`/`TEMP`/`TMP` 指向工作区 `.tmp`，
> 再逐文件跑。**不设而看到 3 个红色，是环境，不是回归**——
> 这一条已写进 `doc/progress.md` 的「当前状态」段。
> （同理：`artifacts-check.mjs` 在本机走 SKIP 分支、`ci-local.mjs` 四步都不会真跑，
> 都属甲类，见 `doc/progress.md` 的「已知环境约束」。）

### 为什么现在不修

`spawn EPERM` 是**本机沙箱**的限制，不是仓库的问题——在正常环境下 `node --test` 的
进程派生是允许的。改脚本去迎合一个特定沙箱，会让正常环境失去并行执行的好处。
逐文件跑的代价只是慢，不是不准。

### 若要修，从哪下手

- 在 CI 或文档里固化「逐文件跑」的清单（`.local-plans/PLAN-0.14.0-HANDOFF.md:150-164` 已有一份）。
- 加一条护栏测试：断言 `test/` 下所有 `*.test.mjs` 都能被 `package.json` 的 test 脚本匹配到。
  这能结构性地消灭「新测试漏在脚本外」。

---

## 11. 大 prompt 的性能提示（可选节）

### 现状

驱动在填写输入框之前检查长度，超过 **400,000 字符**时 `warn` 一行
`large prompt:${len} chars — the web composer may become slow; consider trimming context`
（`lib/browser-driver.js:1071-1073`）。

这是一个**纯警告**，不改变行为：消息照发。真正的硬拦截在回读校验那里
（`PROMPT_TRUNCATED`，`lib/browser-driver.js:1084-1089`）。

### 影响

超大 prompt 会让网页 composer 变卡（前端编辑器处理大文本），端到端延迟上升，
但不会失败。用户侧只在宿主控制台能看到这条 warn。

### 为什么现在不修

阈值 400k 是经验值，没有真机校准数据支撑一个更精确的数字；而在警告之外做任何事
（例如拒绝发送）都会在「长上下文任务」这个本插件的核心用例上误伤用户。

### 若要修，从哪下手

把这条 warn 提升为 metrics 里可见的字段（例如 `promptChars` + 一个超限标记），
让右栏能提示「本轮提示词偏长，网页端可能变慢」。真机采集几轮大 prompt 的
`durationMs` / `sendWaitMs` 后，再决定是否需要更早触发压缩。

---

## 12. 图片预算（可选节）

### 现状

`lib/index.js` 定义了两个与图片相关的上限：

- `REQUEST_IMAGE_POLICY = Object.freeze({ maxPixels: 640_000, maxBytes: 1_048_576 })`
  （`lib/index.js:140-142`）。这是传给 `attachments.readImageRequest(ref, policy, signal)`
  的投影预算，注释说明是与 `dsh-llm-deepseek` 的默认档对齐，让桥取到的版本和原生
  DeepSeek 路由同档。
- `RAW_IMAGE_MAX_BYTES = 8 * 1024 * 1024`（`lib/index.js:143-144`）。这是
  attachments 服务不支持 request 投影时的**兜底**上限——直接读原始字节，超限即跳过。

durable 图片块的读取按优先级降级，每一档失败都**记名不静默**
（`lib/index.js:162-171` 的注释与 `resolveImages` 实现）：

1. `readImageRequest(ref, policy)` —— 宿主归一化 + 按预算投影后的请求版本；
2. `readImage(ref)` —— 原始归一化字节，超过 `RAW_IMAGE_MAX_BYTES` 即拒；
3. 都失败 → 记进 `skipped` 并 `warn`，返回给调用方明确报错，
   而不是让模型说「没看到图」（`lib/index.js:207-209`、`lib/index.js:1415`）。

另有远程图片抓取上限：`resolveRemoteImages` 里 `RAW_IMAGE_MAX_BYTES` 也用于拦远程图
（`lib/index.js:146-160`），单张抓取有 10s 超时。

### 影响

- 超过 `maxPixels` / `maxBytes` 的图会被宿主投影（缩放/重编码），不是原图。
- attachments 服务不可用时降级到原始字节，8MB 以上的图会被跳过并报错。
- 网页端的图片**张数**上限由驱动侧另行拦截：`setImageLimitsProvider` 把宿主的
  `attachments.imageLimits` 交给每个驱动，「上传前据此拦下必然被拒绝的输入（张数/字节），
  而不是发出去再猜为什么『模型说没图』」（`lib/index.js:934-937`）。

### 为什么现在不修

这是一组**对齐**而非**欠账**：预算值刻意与原生 DeepSeek 路由保持一致，
避免同一个 harness 截图在两条路径上得到不同清晰度。改动它需要同步上游口径，
不属于本插件能单方面决定的参数。

### 若要修，从哪下手

若 `dsh-llm-deepseek` 的默认档变化，此处必须同步（`lib/index.js:140-141` 的注释即此约定）。
建议加一条测试断言两处数值一致，或在注释里记录上游文件路径与版本。

---

## 13. 网页端「部分流」自愈（可选节）

### 现状

网页流可能不送 `FINISHED`/`close` 就结束（`status: 'WIP'`）。驱动的处理是：
**把已拿到的正文/思考/图片当作本轮结果交出去**，而不是抛错
（`lib/browser-driver.js:1160-1170`）。

- 每次自愈计数 `recoveredTurns += 1`，并记下 `lastRecovered = { at, reason, status, chars }`。
- 注释明确记录旧行为：直接抛错会「把模型已输出的正文与完整工具调用整段丢弃，
  界面上就是『跑到一半突然停止』，且工具循环再也不会继续」。
- 0.14.0 的 WIP 稳态收束（`startWipWatch`）刻意与这条既有 partial 路径**同形**，
  因此上层的工具协议解析、部分流自愈、空回复判定全部照旧，不新增第二条收尾通路
  （`lib/browser-driver.js:528-529`）。
- `recoveredTurns` / `lastRecovered` 会透出到 `/__webcode/status` 与右栏。

### 影响

自愈是**有代价**的：被交出去的内容可能不完整（模型还没写完）。上层会解析工具协议、
执行、回填，下一轮让模型续写。因此用户可能在长回复中看到「分段」的形态。
但它保住的是「已经产出的内容」与「工具循环不中断」，代价明显小于整段丢弃。

### 为什么现在不修

这是**故意的设计**，不是缺陷。它把「网页不稳定」这个外部事实转化为可控的降级，
而不是让桥把它变成硬失败。真正的修法在网页端（让它稳定送 FINISHED），不在桥这边。

### 若要修，从哪下手

不需要修。需要的是**可观测**：右栏在 `recoveredTurns > 0` 时显示一行说明
（`.local-plans/PLAN-0.14.0-HANDOFF.md:128-129` 已列为待做项），让用户知道「这一轮的结束是桥救回来的」，
而不是以为模型自己停了。

---

## 14. Z.ai 没有会话地址形状：只能整段重建（0.14.2 新发现）

> ### 2026-09-30 结账（0.19.52）：landedUrl 会话锚落地，「每轮新开对话」形态关闭
>
> **新证据（本轮两轮一致）**：发送后页面导航到 `/c/<uuid>`（`/c/ac06aeb0` 与
> `/c/fb527fa1`，2026-09-30 实测）——SPA 确实以 `/c/<uuid>` 承载会话；但 goto 深链
> 仍被弹回根地址（0.19.41 的旧读数维持），因此**继续不声明形状**（编形状的代价
> 见下方原文）。
>
> **修法（`landedUrl` 会话锚，`test/session-stay.test.mjs` 6 项护栏）**：
> 会话槽记录扩展为双身份（`webSessionId` + `landedUrl`）；`conversationStay`
> 纯判据（同源 + 同 pathname + 非站点根）判定「页面还停在本会话上」⇒ **原地
> 续聊**（不导航、不重放、不新开）；页面不在锚上时先 `goto(锚)` 再验证（锚回
> 导航——重启后新页停在根的恢复路径；z.ai 弹回根则验证失败、照旧整段重建，
> 零额外风险）。七站「每轮 WEB_SESSION_LOST → 整段重放 → 每轮新开对话」的形态
> 就此关闭（真机实锤：`webcode-sessions-zai.json` / `-doubao.json` 此前恒为
> 2 字节空对象——从未存下过映射）。
>
> **仍不解决的（如实记）**：同账号**交错**的多 DSH 会话（主会话与子代理同站
> 同槽交替）换手时仍会重建/导航重载——彻底解法是「每会话一个标签页」
> （`sessionPages` Map + 参数化 `installPage` + LRU），本轮不做（驱动最敏感区
> 的风险控制），作为后续项。另：右栏面板卸载 = iframe 销毁（浏览器事实），
> 切回必然整页重载——「跨卸载常驻」需要 DOM holder 叠加方案，同记于此。
>
> 下面保留原文（「为什么不能编形状」的推理依然有效）。

### 现状

0.14.2 把「会话 id ↔ 地址」的知识从驱动里抽成**按站点声明**
（`lib/providers.js` 的 `CONVERSATION_URL_SHAPES` / `CONVERSATION_URL_BUILDERS`），
导航判定收成三态（`lib/contract.js` 的 `conversationNav`）：`fresh` / `resume` /
`unsupported`。

- **glm**：形状已取证并声明 —— `?cid=<24 位十六进制>`，且与 SSE 首帧的
  `conversation_id` 逐字相同（真机 2026-09-14 实录
  `https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=6aa6f08454b3a5a4e4f64a77`）。
- **deepseek**：两种历史形状（`?chat_session_id=` 与 `/a/chat/s/`）原样保留。
- **zai**：**故意不声明**。两个探针都没拿到证据：
  - `real-probe-25-zai-url.mjs`：`page.url()` 是裸根 `https://chat.z.ai/`，
    query 键为空，页面里只有两条法务链接，**没有任何会话链接**；
  - `real-probe-23-glm-budget.mjs`（`PROBE_SITE=zai`）：整轮 120s 超时，
    超时现场 `{captureAlive: true, replyChars: 0}`。

### 影响

zai 的每一轮都会走 `unsupported` 分支 → 抛 `WEB_SESSION_LOST` → 上层以
`fresh: true` 重放首轮整段。也就是说 **zai 的会话上下文只能靠「整段重放」维持，
每次都是新开的网页对话**：功能上不丢内容（首轮全文 = 完整上下文 + 工具协议），
但网页侧的对话列表会越堆越多，且每轮都要重发全文（长会话下更慢）。

对比旧实现：那时 zai 也一样拿不到 id，但是**静默**的——用户只看到「每轮新开对话」，
面板上没有任何线索。现在 `sessionLostCount` / `lastSessionLost` 会透出到
`/__webcode/status` 与右栏（`lib/client.cjs`），原因逐字可读。

### 为什么现在不修

**没有证据可以拿来声明形状。** 按本项目一贯立场（0.12.9 的教训：`getByText`
启发式选错模型；`lib/providers.js:307-308` 记的 `GLM-5.3` 是 `GLM-5.3-Flash`
前缀陷阱）——**宁可不切，也不猜着切**。给 zai 编一个形状（哪怕是「照抄 GLM 的
`?cid=`」）会让驱动导航到一个不存在的地址：页面可能停在首页或报错，而驱动会以为
自己在续聊，于是**静默丢掉上下文**——比现在的「明确整段重建」更糟。

另外 zai 那条 120s 超时本身是**独立问题**（`replyChars: 0`，捕获链在但页面没吐
正文），它属于第 3 条「网页 UI 漂移」，不属于本条。

### 若要修，从哪下手

1. **先解决 zai 的轮次超时**（第 3 条的路子）：跑一次带 `WEBCODE_SSE_DEBUG` 的
   zai 轮次，看 `/api/chat/completions` 是否真的被捕获、解码器 `openai-sse`
   是否对得上形状。轮次能正常收尾之后，`conversation_id` 才可能出现在流里。
2. **再取地址形状**：zai 轮次成功后再跑 `real-probe-25-zai-url.mjs`，这回要看
   **历史会话**页面（先手动开一个有历史的对话），确认地址形态后再往
   `CONVERSATION_URL_SHAPES` / `CONVERSATION_URL_BUILDERS` 各加一条。
3. 若最终确认 zai **只**把 id 放在流里、地址栏确实不带，则给
   `CONVERSATION_URL_BUILDERS` 之外补一条「只能靠流 id 续聊」的路径——但那需要
   站点支持「用 API 打开某个会话」，属于新机制，不能靠现有两张表表达。

## 15. `<call>` / `</call_call>` 残片漏进正文（**已修，0.14.6**）

> **状态更新（2026-09-14 晚间）**：本条**已修并已验证**。修法即下方「若要修，从哪下手」的五步，
> 0.14.6 已全部落地：锚点候选集补 `call_call|call`（只进锚点、不进 transport）、
> `partialProtocolAt` 前缀表补 `<call` / `<call_call`、`detectProtocolLeak` 同步扩集、
> 护栏 4 项（含 `<calling>` 反向断言），`protocol-leak` **15/15 通过**。
> 重启后正面证据：`session-ec60921d` / `session-abaa2740` 零 `protocol-leak` 命中，
> 而修复前 `session-b01554c3` 有 4 处。
> 下面保留原文，因为「检测器不能只覆盖已知形态」这条方法论依然有效。

### 现状

`lib/agent-preset.js` 的 `PROTOCOL_ANCHORS[0]` 候选集是
`(?:tool_call|tool_calls|tool_result|tool_results|calls|function|stories|invoke)`。
网页模型偶发产出的 `<call>` / `</call>` / `<call_call>` / `</call_call>` **不在集合里**，
于是 `findProtocolStart` 返回 `index = -1`，这些残片被当正文外发并持久化。

真机证据（`session-698700ea` 的 assistant/message text 块）见
`doc/bridge-failure-ledger.md` §2：`seq=91/119/179/289/326/569/779` 共 13 处。
（原先这里还指向 `doc/session-log-review.md`，那份归因报告已于 2026-09-16 删除；
上面这串 `seq` 号是**证据本身**，它不依赖任何文档。）

用户可见症状：界面上出现 `<>call` 一类碎片。

### 为什么值得优先修

1. **用户直接可见**——与 0.14.5 已修的 `</</` 同族，属「协议文本泄漏」这一类。
2. **现有护栏够不着**——`detectProtocolLeak` 与被保护的正则**共享同一个盲区**，
   所以「日志没告警」是假阴性。这是本轮最有价值的发现：**检测器不能只覆盖已知形态**。

### 为什么现在不修

用户明确要求「team 这个最后实现，优先解决前面问题」，而本轮已把优先级放在
①二维码定位 ②参考归档 ③会话归因 ④失败台账。这条已**完整取证并给出修法**，
留给下一轮作为 0.14.6 的第一项——修法很小（一处正则 + 一处检测器 + 一条夹具），
但必须**连带修检测器**，否则下次还是测不出来。

### 若要修，从哪下手

1. `PROTOCOL_ANCHORS[0]` 加 `call_call|call`（放在 `calls` 之后即可）。
2. **只加进边界锚点，不加进 transport 判定**——残片不是待执行调用。
   与 0.14.5 对 `tool_result` 的处理立场一致（见 `lib/agent-preset.js:438-443` 的注释）。
3. `test-mock/parse-session-log.mjs` 的 `detectProtocolLeak` 同步补这两条。
4. 护栏夹具直接用本文件里的**真实残片字符串**（`seq=91/119/179/289/326/569/779`）。
   （原先写「用本文件与 `session-log-review.md` 里的残片」，后者已于 2026-09-16 删除；
   夹具要的是**字符串本身**，不是它曾经出现在哪份报告里。）
5. 安全边界：`\b` 之后 `call` 只在标签形（`<call>`、`</call>`、`<call `）命中；
   `<calling>` 里 `call` 后跟 `i`（都是词字符）→ `\b` 不成立，**不会误伤正文**。

## 16. 同站多账户 + Team 面板（**均已实现**）

> **状态（2026-09-15 补齐标题）**：本条此前只写在开头的引用块里，**正文没有 `## 16`
> 标题**，导致一览表有 15/16/17 而正文只有 `## 15` 与 `## 17`——跳号会让按编号
> 检索的人以为这条被删了。现补上正标题，内容与开头引用块一致。

- **同站多账户**：0.14.7 落地（`lib/accounts.js` 纯函数身份层 + `lib/providers.js`
  展开槽 + 槽级 `profileDir`）。默认槽与 0.14.6 逐字相同（零位移纪律），
  未配置 `accounts` 时行为完全不变。
- **Team 面板**：0.15.0 落地。0.14.9 只做到「子代理与 Team 分两区渲染」，
  数据源却是**写死的空数组**——面板永远显示「当前没有正在运行的子代理或 Team 成员」。
  0.15.0 通过新增 `lib/roster.js` 接上真实数据源：Team 成员走官方 `agentTeams`
  服务的 `listMembers(agent)`，子代理走当前会话的 `subagentCatalog` 持久化投影。
  两个分区独立降级，读不到时给空数组**并带上原因**（`teamError` /
  `subAgentsError`），面板据此把「确实没有」与「读不到」分开说。
  负向断言见 `test/roster.test.mjs`。

## 17. 工具调用参数缺失族：`missing required property "command"`（本轮新发现；0.16.16 **归因落定**）

> **归因补记（2026-09-19，0.16.16）**：真机长跑第 7 轮的同族样本（`session-6541b055` grep ×4、
> `session-489b0093` read ×1）取到了被污染的**参数值全文**——模型把闭/开参数标记熔接成
> `</ parameter name="X" string="Y">`，残片粘进前一参数值、后参数整体丢失（夹具 19/20，
> 0.16.15 代码上逐字复现）。熔接形已修（`normalizeDsml` 改写，护栏 7 条）。
> 下方三可能里实锤的是第三种的近亲——**不是流式截断、不是漏产，是标记畸形吃掉参数**；
> `command` 原始样本 raw 未落盘，不能确证同形，但机制已实锤存在。

### 现状

`session-ec60921d-08c5-4906-9c1c-d5ab670661c1`（0.14.6 重启后、本轮之前的会话）里有一条：

```
✖ [tool/result] turn=1 isError: Error: invalid arguments: missing required property "command"
```

用 `node test-mock/parse-session-log.mjs --recent 3 --errors-only` 复现得到。

### 为什么值得记

1. 它与 composer / 协议残片**都无关**——不是同一族，因此 0.14.5/0.14.6 的修复覆盖不到它。
2. 它是**本轮之前**最后一条未归因的 `tool/result isError`，若不记账，下一轮会话会以为「都修完了」。

### 为什么现在不归因（而不是不修）

单条样本不足以判定根因。至少三种可能，且需要**不同**的修法：

| 可能 | 判据 | 修法方向 |
| --- | --- | --- |
| 网页模型漏产 `command` 参数 | 该 `tool/call` 的 raw JSON 里确实没有该键 | `fillMissingRequired` 已有的补全逻辑是否覆盖这一层？ |
| 补全逻辑存在但未覆盖该工具 | `fillMissingRequired` 的必填表里缺这条 | 补表 + 护栏 |
| 流式分块导致参数被截断 | 该 `tool/call` 的 raw 与非流式权威调用不一致 | 走 `TOOL_PROTOCOL_INVALID` 的既有修复路径 |

### 若要归因，从哪下手

1. 用 `parse-session-log.mjs --json` 取出该 `tool/call` 的**原始 raw 参数**与工具名（本轮只拿到了 `tool/result` 的报错文本）。
2. 对照 `lib/agent-preset.js` 的 `fillMissingRequired` / `coerceArguments`：该工具名是否在必填表里。
3. 若 raw 里确实没有该键 → 属**模型行为**，修法是补全而非报错；若 raw 里有而 result 报缺 → 属**解析链路**缺陷。
4. 无论如何先加一条护栏：构造「必填参数缺失」的 raw，断言系统要么补全、要么给出**带工具名与缺失键**的可诊断错误码（现状是宿主原生报错，桥接层没有自己的错误码）。

### 安全边界

本轮**不新增真机探针**（风控纪律）。这条只能靠离线日志与单测推进。

---

## 19. **0.15.6 的修复不完整**：参数含围栏的调用仍会被「边界探测命中但不可执行」（2026-09-16 **已归因 / 已在 0.15.8 修复**）

> ### 2026-09-16 修复落地（0.15.8）
>
> 真根因见下节。**修法已实现并验证**：
>
> - `lib/agent-preset.js` 新增 `invokeBodyEnd(src, from)`——**配平感知状态机**，
>   只在「参数外」遇到的第一个 `</invoke>` 才算体的终点。
> - `invokeRe` 那条 lazy 正则已删除；改为「先定位开标签 → 用状态机定界体」。
> - **同时重建 `m[0]` 为整段**（开标签+体+闭标签）：换成两次定位后若不重建，
>   下游「畸形标签抢救」分支（扫 `m[0]` 找 `"name"/"arguments"` 片段）会失效。
>   这是修法**自己引入过的真回归**，实测 `regression.test.mjs` 由 53/53 掉到 49/53。
> - **降级兜底**：状态机扫到结尾仍不配平时退回第一个 `</invoke>`（畸形输入取旧行为），
>   而不是返回 -1 把整条调用丢掉。
>
> **验证读数**（真机样本 `REPORT.md`，22,366 字符）：
>
> | | 修复前 | 修复后 |
> | --- | --- | --- |
> | `boundary` | `{index:67, transport:true}` | 同左（探测一直是对的） |
> | `proseSafeEnd` | 67（扣留正确） | 67（保持） |
> | **`calls`** | **0（静默丢调用）** | **1，`name=write`，`content=10,121` 字符** |
>
> **护栏**：`test/fence-nested-call.test.mjs` 新增 ⑬（正向必须救活）、
> ⑬b（已知限制：参数值里**未被转义**的字面 `</parameter>` 仍会截断该值——诚实钉住，
> 不是期望行为）、⑭（两调用不得吞并）、⑮（散文不得误报）、⑯（未配平不得抛异常）。
> ⑬ 在修复前**实测为红**（`pass 17 / fail 1`），修复后该文件 **19/19 全绿**；
> 全量 **39/39 测试文件通过**。

> ### 2026-09-16 真根因已定位（本条从「未归因」改为「已归因，待修」）
>
> **先做排除法**：本条原来猜的形状是「表格？行内代码？嵌套引号？`edit` 双参数？」。
> 用 8 个候选形状直接打纯函数（`.tmp/probe-issue19.mjs`），**8/8 全部健康**：
> 都能解析出 1 个调用、`findProtocolStart` 命中、`proseSafeEnd` 正确扣留。
> → **0.15.6 怀疑的「围栏形状」可以整体排除。**
>
> **再用真机样本质证**。仓库根有一份**活的泄漏现场** `REPORT.md`
> （22,366 字符，2026-09-15 落盘，未入库；见 §4.3/§5 诊断报告）。喂给当前代码：
>
> ```
> 样本长度            : 22366
> findProtocolStart   : {"index":67,"name":"write","transport":true}
> proseSafeEnd        : 67          ← 扣留正确：99.7% 的协议被拦下
> 可执行调用数          : 0           ← 但调用仍不执行
> ```
>
> 两条读数：**0.15.6/0.15.7 的护栏是有效的**（这份样本今天不会再泄漏协议原文，
> 本条当初担心的「整段泄漏」已关闭）；**但该轮 `write` 依然静默不执行**。
>
> **真根因**：`lib/agent-preset.js` 的 `invokeRe` 用 **lazy** 的体捕获：
>
> ```js
> const invokeRe = /<\s*invoke\s+name\s*=\s*"([^"]+)"\s*[^>]*>([\s\S]*?)<\s*\/\s*invoke\s*>/gi;
> ```
>
> 实测（`.tmp/analyze3.mjs`，输入已 `normalizeDsml`）：
>
> ```
> </invoke> 出现位置: [10230, 22268]
> <invoke 起: 76   第一个 </invoke> 止: 10230   => lazy 体长度 10154
> 该体内含 </parameter> 吗: false
> ```
>
> 参数体是一份**审计报告正文**，里面**举例引用了协议自身的闭合标签**
> （`` ``` `` 围栏里写着 `</invoke>`、`</function_calls>`、`</parameter>`）。
> lazy 的 `([\s\S]*?)` 于是在**示例里的第一个 `</invoke>`（偏移 10230）**处截断，
> 截出的体内没有配平的 `</parameter>` → `n===0` → 该调用被跳过。
> 而真调用一直延伸到 **22268** 才闭合——**跨过了那 12,000 字符的示例文本**。
>
> **修法假设已用可falsify实验验证**（`.tmp/verify-fix19.mjs`）：
>
> | 取体方式 | 体长 | 参数 |
> | --- | --- | --- |
> | lazy（现状） | 10133 | **NO** |
> | greedy（取最后 `</invoke>`） | 22171 | **YES**，`name=content`，`valLen=10125` |
>
> ⚠️ **greedy 只是验证假设的手段，不是最终修法**：同一轮有两个 `invoke` 调用时，
> greedy 会把第二个吞进第一个的体里。正确修法应是**按 `<parameter>` 配平来定界**，
> 或 greedy 取体后再按 `</parameter>` 计数做配平校验。
>
> **必须同时补的两条反向用例**（`doc/comment-style.md §9.3`：先红后绿）：
> ① 一轮两个 `invoke` 调用不得互相吞并；② 体里引用闭合标签必须能被还原。
>
> **留痕缺口仍在**（本条自认的第一步，**尚未做**）：`lib/index.js` 的两处
> `withheld` 只报字符数，不带形状指纹。本次之所以能定位，靠的是**运气**——
> 现场恰好被当成 `REPORT.md` 落了盘。若没有那份样本，本条仍然查不动。
> 因此「把 withheld 现场落盘到 `.tmp/` 一份脱敏样本」应当与上面的修法**一起**做。
>
> **已落护栏**：`test/fence-nested-call.test.mjs` 新增 ⓪a/⓪b 两项真机形态用例
> （全角竖线 DSML 的边界/扣留判据 + 「不可执行的真因在体不在标记」的正面能力判据），
> 该文件由 12 项增至 **14 项，14/14 通过**。
>
> 完整推导见 [`diagnosis-2026-09-16.md`](diagnosis-2026-09-16.md) §5。

### 现状（原文，保留以供对照）

0.15.6 针对「参数里含 ``` 的 `write`/`edit` 调用被丢弃并整段泄漏」做了一次修复，
A/B 表（`doc/verify.md` §0.15.6）证明它修好了**被测的那一种形状**：
`boundary` 从 `-1` 回到 `53`、`proseSafeEnd` 从全文回到 `53`、`parsedCalls` 从 `0` 变 `1`。

**但重启到 0.15.6 之后，同一族缺陷又复现了一次，并吃掉了本轮的一次改动：**

```
一次 edit（把 §7.1.1 写进 doc/ci-cd.md，新文本含 markdown 表格与行内代码）
  → [webcode-bridge] withheld 390 chars of protocol text from assistant prose
  →（边界探测已命中但没有可执行的完整调用：本轮按断流处理，未把协议原文外发）
  → 该次 edit **未落盘**
同一编辑改成不含围栏的小文本重试 → 落盘成功
```

用户侧观感是「harness 端一点显示都没有」——**与本条最初那份 bug 报告的原话完全一致**。

### 为什么值得记

这是**第 5 次**同一族问题的记录，而且它是**修复自己**出的一次：
`doc/status-audit-2026-09-16.md` §6（该报告已按用户指示于 2026-09-16 删除）当时已经把
0.15.5→0.15.6 这次回归写成了「修 A 引入 B」，现在证明 0.15.6 只是**收窄**而没有根除。

更要紧的是一条方法论教训：

> **A/B 表与护栏只覆盖了「被测的那一种形状」，而修复的覆盖面被那张表高估了。**
> 12 项护栏全绿、A/B 三行读数全对，仍然存在一个能让主路径（写文档/写代码）静默失效的输入。

这与本条 #17（工具调用参数缺失族）是**同一族**：都是「工具调用在链路中途消失，
而系统既不执行也不给出可诊断的错误」。

### 为什么现在不归因（而不是不修）

复现是**概率性**的（本轮 2 次编辑中 1 次命中），且现场只留下了一条 `withheld` 提示行，
没有留下判成「不可执行」的那段原文——**当前的日志不足以定位是哪种形状**
（表格？行内代码？嵌套引号？还是 `edit` 的 `old_string`/`new_string` 双参数组合）。
在没有拿到那个形状之前改代码，等于把 0.15.5→0.15.6 那次「修 A 引入 B」再赌一次。

### 若要归因，从哪下手

1. **先补留痕**：那条 `withheld` 提示目前只报字符数（`390 chars`），
   不带被扣留原文的形状指纹。第一步应让它**落盘到 `.tmp/` 一份脱敏后的样本**
   （或至少报出「第一个可能围栏的位置 + 前后 40 字符」），否则复现一次也还是查不了。
2. 用 `.tmp/probe-audit-regress.mjs` 的形状逐个试：markdown 表格、行内单反引号、
   行内三反引号、`\`\`\`` 紧邻 `}`、参数值里同时含 `{`/`}` 与围栏。
   目标是找到**判定分叉点**：`readCallAt` 在哪里返回了「无完整调用」。
3. 找到形状后**先写成反向用例**（`test/fence-nested-call.test.mjs` 追加），
   **确认它变红**，再动修复代码——这是 `doc/comment-style.md` §9.3 的要求，
   也是 0.15.5/0.15.6 两次都做过的那一步。
4. 顺带审 `edit` 与 `write` 的差别：`edit` 有两个长参数（`old_string`/`new_string`），
   本轮命中的正是 `edit`，而 0.15.6 的 A/B 用的是 `write`——**这是一个可疑的差异**。

### 安全边界

纯离线可查（会话日志 + 单测），**不需要新增真机探针**。

---

## 20. `doc/security-review.md` 带 BOM（2026-09-16 新发现，低优先）

### 现状

全仓库已跟踪文件里**只剩这一个**带 UTF-8 BOM（实测前 3 字节 `239,187,191`）。
0.15.5 做过「去 BOM」，但当时只去了 `package.json`，**没有做全量核对**——
所以「去 BOM」这件事在台账上是绿的，在磁盘上只做了一半。

同轮还发现 `.github/CODEOWNERS` **在未提交的改动里被加上了 BOM**（HEAD 里没有），
即一边在去 BOM、一边在加 BOM。CODEOWNERS 那处已于 2026-09-16 修掉（并附上 owner 核对）。

### 为什么值得记

它本身无害（BOM 在 UTF-8 里合法），但它是**「修复没有覆盖面」这一族**的最小样本：
一次修复如果不带一个「全量核对」的判据，它的完成度就只能靠人猜。
本条的代价接近零，所以优先级低；记下来是为了给那一族留一个便宜的标本。

### 若要修，从哪下手

去掉那 3 个字节即可（`security-review.md` 本轮未被改动，所以它**不是**本轮的回归）。
若要防复发，判据应加进 `scripts/lint-comments.mjs` 或另立一条：
**扫描范围内任何文件首 3 字节为 `EF BB BF` 即报错**——这比「记得去 BOM」可靠。

---

## 21. **SET 重发吞掉流式增量**：网页有输出、harness 收不到（0.15.7 新发现，**已修**）

### 现象（用户原话）

> **「？怎么回事》明明有输出：`<tool_call>{…}</tool_call>` 却提示
> THINKING_ONLY_NO_ANSWER」**

用户的观感是「网页明明答了、桥却说它没答」。**这个观感是对的**——问题不在收尾
判定，而在**接收层的流式增量**。

### 根因

DeepSeek 会把**整份 response 对象**反复重发，`fragments` 每次都比上一次长。
两种写法在真机都出现过：

- `{o:'SET', p:'',            v:{response:{message_id, role, status, fragments}}}`
- `{o:'SET', p:'response/fragments', v:[…]}`

旧实现在这两个入口都**整份替换** `response.fragments`，且只在
`consumeResponse` 的 `isFirst`（第一次见到该 response）时外发增量。于是：

```
onDelta 累计 acc = 第一帧的内容      ← 界面正文停在半路
finish().text    = 完整正文          ← 权威全文（所以「明明有输出」）
```

后果链条（与用户现象逐条对应）：

1. 界面正文停在半路（只有第一批增量被发出）；
2. `index.js` 的协议边界探测只看 `acc`，后段里的 `<tool_call>` **探不到** →
   一个 tool-call 块都不开、**工具从未执行**；
3. 收尾 `finalText`（来自 `finish()`）与 `textSent` 分叉 → 该轮被判成
   「正文空 + 只有思考」→ 交回 `THINKING_ONLY_NO_ANSWER`，或抛 `STREAM_REWRITE`。

### 离线复现（修前 / 修后）

```js
// 整份 response 连发三次，内容递增
d.push(SET([{type:'RESPONSE',content:'Hello'}]))
d.push(SET([{type:'RESPONSE',content:'Hello world'}]))
d.push(SET([{type:'RESPONSE',content:'Hello world!'}]))
d.finish()
```

| | 流式外发 | `finish().text` | 差值 |
| --- | --- | --- | --- |
| 修前 | `"Hello"` | `"Hello world!"` | **漏发 12 字符** |
| 修后 | `"Hello world!"` | `"Hello world!"` | 一致 |

同理确认的两个附带缺陷：**新增片段**整段漏发（`AAA` vs `AAABBB`）、
**新增图片**在流式期间不触发 `onImage`（轮次进行中界面无图，只能靠
`finish()` 事后捞回）。

### 修法

抽出 `DeepSeekStreamDecoder.emitFragmentDiff(next, prev)`，**两个入口共用**，
按**下标**逐位对比，只发真正新增的部分。三条边界（缺一不可）：

| 情形 | 处置 |
| --- | --- |
| 同下标**变长**且以旧内容为前缀 | 只发增长的后缀 |
| 同下标**被改写**（不以旧内容为前缀） | **不发**，交给收尾的权威比对（补发会变成重复正文） |
| **新增下标** | 整段当增量发 |

### 护栏

`test/decoder-fragment-diff.test.mjs`（9 项 = 5 判据 + 3 反向安全线 + 1 接线）。
**反向验证已做**：把 `consumeResponse` 的 diff 外发改回「只在首次」，
**pass 4 / fail 5**；恢复后 9/9 全绿。

### 为什么值得单独记一条

这是「**修复的覆盖面被高估**」这一族的第 6 个样本（承 #19 的方法论教训）：
`onDelta`/`finish()` 两条通道**同时存在**，测试却历来只 assert `finish()`
（它总是对的）而不 assert「流式外发与权威全文逐字一致」，于是这个洞活到了真机。
**任何「增量通道 + 权威快照」双通道的解码器，都必须有一条把两者钉在一起的断言。**

---

## 22. DeepSeek「只出思考、不出正文」：**未归因**（2026-09-16 新发现）

### 现状

真机会话 `session-fcbb5bf8`（RoboCup / 本地 ssh orangepi-5）step 7：网页**正常
收尾**（`turn/end reason: completed`、驱动侧 `lastEndReason: finished`、
`thinkingOnlyTurns: 0`），但该 step 的 `assistant/message` 的 content 只有
`[reasoning]`（1947 字符，停在 `"Let me test camera over SSH."`），
**没有 text 块、没有 tool-call 块**。桥按设计交回 `THINKING_ONLY_NO_ANSWER`。

**已核验不是接收层丢内容**：同会话 step 3 的 content 是
`[reasoning, text("SSH 已通。先摸清…"), tool-call(pwsh)]`——正文通道工作正常；
且 #21 修复的 SET 增量洞在该轮不适用（该轮零正文增量，非「有增量被吞」）。

### 为什么现在不归因

要区分两种可能，需要拿到**该轮的 SSE 原始帧**：

1. 网页**确实只生成了思考**（模型自身在思考后停止）——则这是模型侧行为；
2. 网页**生成了正文但没有走捕获链**（SSE 未捕获 / 捕获链未建立）——则是桥的洞。

当前证据只能排除 #21（增量被吞），**不能**在 1 与 2 之间判定。

> ### 2026-09-16 复核推翻（本条前提有错，且已可定性）
>
> **上面前提「content 只有 `[reasoning]`、没有 text 块」是错的。**
>
> 独立解码 `session-fcbb5bf8` 的 `session.v3.jsonl.zstd`（52 事件）后实测，
> step 7 的 `assistant/message` 是：
>
> ```
> block types: ["reasoning","text"]
>   - reasoning len=1947  "Now I have a good picture. Let me read the local vision-README.md …"
>   - text      len=357   "THINKING_ONLY_NO_ANSWER: 网页只产出了思考内容、正文一个字符都没有…"
> ```
>
> **那个 357 字符的 text 块就是桥自己写进去的诊断文本**，来源
> `lib/index.js` 的 `thinkingOnlyNotice()`，经 `emitText(notice, turn, nextIndex)` 落库。
>
> 复核命令（可复现）：解压该会话 → 取 `step===7` 的 `assistant/message` →
> 打印 `content[].type`。判据是 `["reasoning","text"]`，不是 `["reasoning"]`。
>
> **两条结论**：
>
> 1. **可能性 2（捕获链丢正文）已被排除**：该轮 chunk 序列是
>    `block-start#0(reasoning) → block-end#0 → block-start#1(text) → block-end#1 → usage → finish{kind:'stop'}`，
>    `finish.reason` 是正常 `stop` 而非 WIP 兜底（`thinkingOnlyTurns` 只在
>    `browser-driver.js` 的 stall 路径自增，故为 0，与提示文本「累计 0 次」自洽）。
>    没有文本通道被吞的证据。→ **只剩可能性 1：模型自身在思考后停止。**
> 2. **升级出本条真正的缺陷（原报告漏掉的那个）**：桥把**自己的诊断文本写进了助手正文并持久化**。
>    这污染会话与后续上下文轮——用户看到的是「模型说了 THINKING_ONLY_NO_ANSWER」，
>    而实际上模型什么都没说。**严重度由「中」上调为「高」。**
>
> 修法方向：`thinkingOnlyNotice` 的文本不应经 `emitText` 进正文通道，
> 而应只进日志 + `/__webcode/status`（与 `TOOL_UNKNOWN` 的处理分离评估；
> `TOOL_UNKNOWN` 需要模型看见，本条不需要）。
> 护栏应断言「该提示不得出现在 `assistant/message` 的 text 块里」。
>
> 完整证据见 [`diagnosis-2026-09-16.md`](diagnosis-2026-09-16.md) §5.5。

### 若要归因，从哪下手

1. **先补留痕**：`WEBCODE_SSE_DEBUG=<dir>` 已能落盘原始 SSE 帧
   （`browser-driver.js` 的 `SSE_DEBUG_DIR` 分支）。复现时开着它，
   拿到该轮真实帧即可一句话定性。
2. 对照驱动侧现场：`/__webcode/status` 的 `lastStalledSettle`
   （`thinkingChars` / `answerChars` / `domTimerOnly`）与
   `lastEndReason`。`domTimerOnly: true` 说明页面只剩计时文案，
   偏支持可能性 1。
3. 若判定为可能性 2，判据应加进 `lib/browser-driver.js` 的捕获链建立处
   （`onPageCapture` 的 `phase==='start'`），而不是收尾分支。

### 安全边界

**不需要新增真机探针**（风控纪律）。`WEBCODE_SSE_DEBUG` 只在复现时临时开启。

---

### 状态（2026-09-26，0.19.26）：**其中一个子形态已拆出、可判定、已修**

上面「可能性 1（模型自身在思考后停止）」其实混着**两种完全不同的形态**，此前没有分开：

- **形态 A — 想完就停**：思考是一段正常的推理，走到尽头后模型没有落笔；
- **形态 B — 原地打转**：思考**卡在一个周期里自我复制**，重复多少遍都不会产生新结论。

**形态 B 已拆成独立条目 #28 并已修**（判据、收窄、读数与漏报面全部记在那里）。

**形态 A 仍未归因**，本条其余部分——含上面那条「桥把自己的诊断文本写进助手正文」的升级缺陷
——**保持原状，未因这次修复被降级**。

---

## 23. **缺 `name` 字段的调用被静默丢弃**：网页有输出、harness 显示不了（0.15.9 新发现，**已修**）

### 现象（用户原话）

> **「现在返回 web 的内容会在 harness 端显示异常/显示不了？有些可以有些不行？」**

「有些可以」= 同一会话里带 `name` 的调用一直正常；「有些不行」= 不带 `name` 的那些
**整条消失**，界面上只剩散文，或干脆一条空消息，任务停在那里不动。
用户在同一现场的另一句原话更直接：**「一道这个就停了？harness 识别不了？」**

### 真机留痕（唯一一次拿到「网页实际发出的字节」）

会话 `session-07907f7c`（DeepSeek 网页模型，2026-09-16 15:33）→ 网页会话
`49ab6330-0fbd-4842-a7b7-e9ce5d57031b`。取证方式（**可复现**）：

```powershell
# 桥的只读控制面：把网页会话历史整段取回来（不改网页状态）
Invoke-WebRequest -Uri 'http://127.0.0.1:8931/__webcode/history' -Method POST `
  -ContentType 'application/json' -Body '{"sessionId":"49ab6330-…"}' | Out-File .tmp/hist.json utf8
# 逐字落成夹具（脚本化，避免手抄把缺字段补齐）
node .tmp/extract-nameless-fixtures.mjs
```

四份夹具（`package/dsh-webcode-bridge/test/fixtures/`，未经手改）：

| 网页消息 | 形状 | 旧行为 |
| --- | --- | --- |
| `id=20` | 两个 `{"mcp_action":"call","purpose":…,"arguments":{pattern,path}/{command,description}}`，**都无 name** | `calls=0`、`diagnostics=[]`、扣留 664/664 字符 |
| `id=24` | 「Let me verify the actual file state…」+ 同上两个无名调用 | `calls=0`、扣留 598 字符，界面上只剩那 59 字符散文 |
| `id=26` | `{"mcp_action":"call","name":"read",…}` | `calls=1`，正常执行（对照组） |
| `id=30` | 无名 `{"file_path","offset","limit"}` | `calls=0`、扣留 226/226 |

harness 侧同一时刻的读数（`node scripts/session-read.mjs 07907f7c`）：
`turn 4 step 1 = reasoning(739) + text(59)`，`turn 4 end reason=completed`；
随后 4 个 turn 模型反复说 **「my tool calls didn't get results」**——它**以为**自己调了。

### 根因

`parseAgentReply` 的 `takeObj` 对围栏调用只认「JSON 能解析 **且** 有 `name`」：

```js
const isCall = fenceCall ? (typeof obj.name === 'string' && obj.name.trim()) : …;
if (!isCall) return;      // ← JSON 合法、只是没写 name ⇒ 静默丢，连 diagnostics 都没有
```

诊断只在 `JSON.parse` 失败时才写（0.15.6 的「丢弃不再静默」漏了这一支）。
丢掉调用之后：`proseSafeEnd` 把协议整段扣住 → 只有散文外发；正文全是协议时
整轮落到 `zeroProgressDecision` 的 `thinking-only` 分支，交回一句
**「网页只产出了思考内容、正文一个字符都没有」——与事实相反**（网页明明发了调用）。

### 修法（三处，缺一不可）

| 处 | 内容 |
| --- | --- |
| `inferToolNameFromArgs(args, tools)` | 按**本会话真实下发的工具表**反推名字。三条判据：提供的每个键都必须由该工具声明；必填必须齐（`description` 按 `FILLABLE_REQUIRED` 白名单可由 `purpose` 代填）；候选必须**唯一**，不唯一返回 `null` |
| `parseAgentReply(text, { tools })` | 缺名/包装名（`tool_call`/`function`/`invoke`/`call`）时用上它；猜不出时**必须**写 diagnostics；还原成功的调用带 `nameInferred: true` 供日志留痕 |
| `lib/index.js` | 两处解析都传 `tools`；流式开块也用同一份判据；新增 `TOOL_CALL_UNPARSED` 提示——「探测到协议但解析不出可执行调用」时如实说明并给出重发格式，**替代**那句与事实相反的 thinking-only 文案与空白消息 |

为什么不做「按第一个键查表」：`{file_path}` 会被读成 `write` 并**覆盖文件**——
那是执行错的事，比丢调用更坏。唯一解要求把这类误判挡在门外（护栏 ⑦）。

### 护栏

`test/nameless-call.test.mjs`（14 项）：①②③⑤⑦⑫⑬⑭ 修复前**实测为红**
（夹具在旧代码上 `calls=0`，红基线存于 `.tmp/red-baseline-nameless.txt`）；
④⑥⑧⑨⑩⑪ 是反向安全线（带名字的调用不得被改写、证据不足不许猜、
散文里的 JSON 示例不得误判、`{file_path}` 不得被认成 `write`）。

### 教训（本族第 7 个样本）

`takeObj` 有**两条**出口会丢调用（JSON 解析失败、结构不合法），0.15.6 只给前者
装了留痕。**「不留痕的早退分支」是静默丢弃的唯一来源**：给一条路加日志时，
必须把同一个函数里所有 `return` 一起数一遍。

---

## 24. **网页侧回复被时间窗判死 / 超长纯文本投递**（0.16.3 新登记，**部分解决**）

### 现象（用户原话）

> 「用 bridegege 怎么总是现在返回真实工具调用说正文没有返回？之前让你看了你说是没有返回，
> 但是我看 web 是真实有的啊！你可以去看网页端真实对话回复」……「然后是发送的纯文本太长了！」

本轮报错（用户逐字贴出）：

```
本轮运行失败 WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容（页面在，本轮收束原因 finished） — 本轮已中止，可重试
```

### 真机证据（2026-09-17，全部是读数）

| 读数 | 取法 | 数字 |
| --- | --- | --- |
| 网页原话能不能解出调用 | `POST /__webcode/history {"sessionId":"971db3e8-7ea6-4f63-ad41-c14bb44a6d27"}` 取 assistant 消息 → 逐字落成 `test/fixtures/dsml-real-14-step5-grep-pwsh.txt` → `parseAgentReply(text, {tools})` | **1204 字符 → calls=3（grep / pwsh / pwsh）、diagnostics=[]** |
| 失败那一步等了多久 | 解 `.dsh/sessions/…session-dff3edf7…/session.v3.jsonl.zstd`（29 帧） | turn1 **step5：18:41:59 → 18:43:51，跨度 112s，零事件** |
| 同一轮其它步骤 | 同一份会话 | step1-4 **每一步都有事件**（工具调用 2-4 条）⇒ 捕获链是活的，不是链路坏 |
| 发进网页的纯文本 | `POST /__webcode/history` 的 user 消息 | **127,888 字符**（工具教学 38,279 + 会话 transcript 89,609） |
| 首轮提示词总量 | `GET /__webcode/preset` | **409,555 字符**（其中 transcript 370,985，含 DSH 系统指令 279,223） |

两件事是**同一个根因的两端**：输入端一次贴进 12.8 万字符，网页要 prefill 完整个上下文才吐
第一个 token；而看门狗从「上一次事件」起算 120s，**把「网页还没开口」与「网页不说了」
量成了同一件事**——于是正常的慢启动被当成卡死。

### 当前对策（0.16.3）

| 对策 | 位置 | 护栏 |
| --- | --- | --- |
| 看门狗窗口**按相位**选 | `lib/idle-window.js`（`idleWindowDecision`）；接线 `lib/index.js` 的 `nextWithIdle()` | `test/idle-window.test.mjs`（纯函数 17 项）+ `test/watchdog-first-byte.test.mjs`（接线级 9 项） |
| 相位窗口给**整轮预算**留余量 | `idleWindowDecision({…, totalBudgetMs})`：窗口 ≤ `budget − max(1s, 10%)`，被压过置 `capped:true`（否则宽限后的 240s 与驱动整轮 240s 同值赛跑，报错退化成没有页面现场的 `web turn timed out`） | `test/idle-window.test.mjs` ⑧ 系列 + `test/timeout-order.test.mjs`（三层超时顺序） |
| 首字节相位的倍数可配 | 配置 `idleFirstByteMultiplier`，默认 **2**（120s → 240s）；设 **1** 即逐字恢复旧行为 | 非法值由纯函数回落成 1，不重复 clamp |
| 超时报错带现场 | 驱动 `status()` 的 `lastActivityAt`、`domReplyChars`；报错文本追加「最近驱动活动」「页面已有 N 字回复未回传」 | `test/watchdog-first-byte.test.mjs` ⑤ |
| 超长文本改走附件（**0.16.3 起默认开，阈值 60,000**） | `promptTransportPlan`（`attachInlineLimitChars` 默认 **60,000**，`0` = 关闭）、`uploadTextAttachment`、上限 `attachMaxChars` 默认 **1_500_000** | `test/prompt-transport.test.mjs`、`test/prompt-transport-attach.test.mjs`、`test/upload-attachment-structure.test.mjs`、`test/attach-callsite.test.mjs` |
| 真机回复回归 | 夹具 14（网页原话 1204 字符） | `test/dsml-real-reply-regression.test.mjs`（11 项） |

### 仍未被证实的部分（写清楚，别让下一个人以为已经量过）

1. **「12.8 万字符输入 ⇒ prefill 超过 120s」是推断，不是直接读数。** 直接量到的只有「该步
   112s 零事件 + 页面 `busy` + 同一轮 step1-4 事件正常」。**首字节到底第几秒到达，没有任何
   读数记录过**——报错文本新带的 `最近驱动活动` / `页面已有 N 字回复未回传` 就是为了让
   *下一次*事故能直接量到它。
2. **「网页那侧在 18:43 之后是否真的产出了完整答复」未被证实。** 能证实它的只有那一刻的
   **页面 DOM 读数**（`driver.status().domReplyChars`、页面截图、或网页会话里那条 assistant
   消息），而这次事故没有把这些落盘。桥侧「零事件」只证明**捕获链没收到东西**，不能证明
   网页没生成——这正是用户那句「web 是真实有的」在这条链路上仍然成立的原因。
3. **「走附件会更快/更稳」未被证实。** 0.16.3 起 `attachInlineLimitChars` 默认 **60,000**
   （超阈值即走附件，`0` = 关闭），这是**基于读数做的取舍**，不是已验证的结论：要证明它有效，
   需要同一站点、同一会话、同一 prompt 的 inline / attach 两次配对读数（首字节耗时、
   `attachTransport`、模型是否读到附件）。在这之前，附件投递失败一律**回落 inline**。
4. **附件计划在 inline 分支的读数歧义——0.16.3 已修。** 修前：inline 且 `chars > maxChars` 时
   `promptTransportPlan` 给出 `truncate:true` / `payloadChars=maxChars`，而调用点在 inline
   分支**并不截断**文本（2,000,000 字符原样写进输入框）。现在 inline 一律
   `truncate:false` / `payloadChars = total` / `kept:null`，「若走附件会上传多少」只在
   `mode:'attach'` 时表达；护栏 `test/attach-callsite.test.mjs` ⑦。

### 若要继续，从哪下手

1. **先补读数再改判据**：下一次 `WEB_NO_PROGRESS` 的报错文本应带 `最近驱动活动`（距今秒数）
   与 `页面已有 N 字回复未回传`。若出现 `domReplyChars > 0` 而事件仍为 0，就同时证实了
   「网页在产出、链路没接住」——那才是真的链路缺陷，与相位无关，届时该查解码器/捕获链而
   不是继续放宽窗口。
2. **拿配对数据验证（而不是「决定是否默认开」——0.16.3 已默认开）**：同一站点、同一会话、
   同一 prompt，attach 一次 / inline 一次，比首字节耗时与 `attachTransport` 读数
   （字段在 `/__webcode/status`）。若真机发现附件路径更差，把 `attachInlineLimitChars` 写 0
   即逐字回到旧行为（这条退路必须保留）。
3. **夹具 14 的红色基线是 `normalizeDsml` 的 DSML 标记剥除，不是 `dsml-repair.js`**：
   回滚 `dsml-repair.js` 时 `dsml-real-reply-regression.test.mjs` 仍全绿，
   `dsml-native-close.test.mjs` 才会红（13 份夹具里的无名闭合/缺外壳两族）。
   两条防线各管一族形态，别把它们的红色基线搞混。
4. **别把窗口继续调大当修法**：`idleFirstByteMultiplier` 的作用域只有「首个事件之前 + 驱动
   仍在忙」这一格（`test/idle-window.test.mjs` ②③ 就是为此设的反向安全线：已经开流的静默、
   驱动不忙的静默都必须照旧快报）。

---

## 24-ter. **GLM 第 N 步返回空流（`empty response from web AI`）**（2026-09-28 定性；**未修主体，只修了报错取证**）

用户原话（2026-09-28）：「本轮运行失败 empty response from web AI（收束原因 finished）| 流首段:
data: {"id":"6ab9fff5a0610b1da4035fd6","conversation_id":"6ab9fe16a0610b1da4035b49",…"parts":[],
"created_at":"2026-09-28 13:49:41","status":"init","last_error…」+「你看下：现在是桥的问题吗？
1.正文回复明显不对？2.调用一半我不返回了却提醒这样！」+「请你查看已有会话中 ghatglm 完整跑了
几个小时的，我记得是 40 之前的版本都能够正常使用！glm！」

### 定性：**这一轮不是桥丢了内容**（会话存档逐条解帧）

`session-ee3a8650` 的 `session.v4.jsonl.zstd`（74 行）：turn 1 正常 `completed`；
**turn 2 的前 9 个 assistant 步骤全部正常带 tool-call**（05:44:09 → 05:49:11），
**第 10 步**才返回空流。`/__webcode/status` 的 `relay.lastError` 同时给出
`durationMs: 8620` / `firstTokenMs: 7674` / `responseMs: 946` —— 网页侧开了流
（`status:"init"`）但 `parts:[]`，随后流结束。

⇒ GLM 在失败前**连续正常工作约 6 分钟 / 9 个工具步骤**。

### 0.19.45 已修的是**报错的取证缺陷**（两处，都不是空流本身）

1. **收束原因是假陈述**：`noteEndReason(… || 'finished')` 兜底无条件写 `finished`，
   不看解码器给的是 `complete` 还是 `incomplete`。GLM 解码器只在 `status === 'finish'`
   帧置 done ⇒ 那一轮报「收束原因 finished」而**流根本没 finish**。已改为与
   `result.complete` 同源（`partial:incomplete` 等）。
2. **只截流首段**：`status:"init"` + `parts:[]` 是 GLM **每一轮**的正常开帧，首段按构造
   永远看不出真因；真因（限流原话 / 审核 / `last_error`）在后面的帧里。已新增
   `rawTail`（最后一帧）随首段一起进现场。

### 仍未修 / 未取证（不猜）

1. **空流本身为什么会发生**：未取证。`status:"init"` + `parts:[]` 后流即结束，可能是
   站点限流、内容审核、或该轮请求未被受理。**0.19.45 之后**再遇到这个问题，报错会带上
   **流尾段**（含 `last_error` 真值），届时可直接判定——这是本轮修复的全部目的。
2. **不是风控**：GLM 未声明 `captchaSelector`（该字段只声明在 z.ai，`lib/providers.js`），
   且前 9 步都成功，可排除「消息根本没发出去」这一支。
3. **`last_error` 字段的语义**：全仓库此前**零命中**（`grep last_error` 无任何结果）——
   0.19.45 之后它才会第一次出现在报错里，因此**至今没有它的真值读数**。
   下一次事故的尾段就是它的第一手取证。
4. **「0.19.40 之前 GLM 能跑几小时」**：**未取证，且现有数据不支持**。全部工作区会话存档里
   GLM 驱动步骤共 80 个（占 30,464 步的 0.26%）、47 个会话、**最长连续 0.79 小时 / 8 步**；
   找不到任何「数小时」的 GLM 运行。回复日志的 `site=` 字段是 0.19.30 才加的，更早的
   `webcode-bridge-replies.log.1`（4276 条）**无法归因到 GLM**；0.19.30–0.19.39 十版在 git 里
   是一次性合并提交、版本级不可分辨 ⇒ 现有材料**既不能证实也不能否定**这个记忆。
5. **观察到的相关事实（不是结论）**：桥设置 `"subAgentSite":"glm"` —— GLM 主要承担
   **子代理短调用**，而非主会话长跑；这与「80 步 / 47 会话 / 最长 47 分钟」的读数自洽。

### 若要继续，从哪下手

1. **等下一次复现**：0.19.45 的报错会带流尾段。若尾段里 `last_error` 是限流原话
   （如「当前访问人数过多」），则应把 GLM 也接进 `RATE_HINT_TEXT` 的限流判定，让它走
   `RATE_LIMITED` 退避重试，而不是报一个无从下手的空回复错。
2. **对照 GLM 网页端**：在 chatglm.cn 直接看那条对话（`cid=6ab9fe16a0610b1da4035b49`）
   第 10 步的位置——若网页上显示「当前访问人数过多 / 内容不合规」，则站点侧原因即可证实。
   这是**唯一**能直接回答「空流是什么」的取证路径（本机无法复现：桥持有 GLM 账号锁，
   同一账号不能同时桥接，见 `lib/bridge-lock.js`）。
3. **不要**因为空回复就把 `WEB_NO_PROGRESS` 或空回复判据放宽——本轮已证明前 9 步是好的，
   空流是**真实的空**，放宽只会把故障藏起来。

---

## 24-bis. **GLM「近两分钟才开始思考」+ `WEB_NO_PROGRESS…驱动不在忙`**（2026-09-28 定性；**0.19.44 已修主体**）

用户原话（2026-09-28）：「请你查看下现在的 chatglm 怎么回事：1.超长时间刚开始加载--40 前面版本
我记得都是马上就接着思考而不是现在等近两分钟！才开始有 2. 本轮运行失败 WEB_NO_PROGRESS: 网页侧
超过 120s 没有任何新内容（页面在，上一轮收束原因（120s 前） finished，判定相位=网页还没开口且
驱动不在忙（按常规窗口未宽限）） — 本轮已中止，可重试」+「这个是不是叠加1的问题引起的？」

### 结论（答用户第 2 问）

**是，第 2 条是第 1 条的直接后果**，但其中还夹着一格**独立的判据缺陷**。三条机制各自有据：

1. **`end-to-start` 的发送间隔等待落在看门狗窗口之内（决定性，已实测）。**
   `relay.submit()` 在 `lib/index.js:1192` 调用，`nextWithIdle()` 紧随其后在 `1261` 进入循环，
   看门狗计时器**当场开跑**；而 `computeSendGap` 的 `sleepSignal` 在
   `lib/index.js:3194-3225`——**executor 内部**，即 120s 之内。真机 `webcode-settings.json`
   写着 `sendGapMs: 30000` + `sendGapBasis: "end-to-start"`（旧版本是 `10000` + 默认
   `send-to-send`，见 `webcode-settings.json.bak-0140`）⇒ **每轮开场先白扣 30s**。
   实测（注入式脚本驱动，`idleTimeoutMs=1000`/`mult=2` 压到毫秒尺度，首字节延迟固定 800ms，
   只改 gap）：`gap=0`→OK(992ms)、`gap=1000`→OK(1819ms)、**`gap=2000`→`WEB_NO_PROGRESS`(2607ms)**、
   `gap=3000/5000/8000`→同样约 2609ms 开火且**驱动调用次数只有 1（第二轮根本没送到驱动）**。
   ⇒ 看门狗在**间隔等待期间**就把这一轮判死了。
2. **GLM 长提示词走附件，附件路径另有几十秒。** `SITE_ATTACH_INLINE_LIMIT.glm = 8_000`
   （`lib/browser-driver.js:619`，0.19.41 新增）+ 用户设置 `promptTransportBySite.glm = "attach"`
   ⇒ 任何 >8k 的一轮都走 `uploadTextAttachment`；该函数自己的注释写着真机 **85k 附件实测 53s**
   （`lib/browser-driver.js:2593-2596`）。且附件投递后**正文被换成「请先读取该附件全文」的指针文本**
   （`lib/browser-driver.js:3296-3298`）⇒ 模型先读附件再开始想，首字节必然更晚。
3. **`busy:false` 这一格不给宽限**，而 GLM 驱动是**懒创建**的（`lib/index.js:2606-2652`，
   非 deepseek 默认槽走 `!drivers.has(key)` 分支；创建点在 `attempt()` 内的 `3069`，在 gap 之后）
   ⇒ gap 期间 `driverFor('glm')?.status?.()?.busy` 读到 `false` ⇒
   `lib/idle-window.js:98` 返回 `{windowMs: base, phase:'mid-stream', firstEventSeen:false}`
   ⇒ **宽限（×2）不可达**，窗口停在 120s。报错文本 `lib/index.js:573` 于是印出
   「判定相位=网页还没开口且驱动不在忙（按常规窗口未宽限）」——与用户报错逐字吻合。

### 数值预算（默认值实算）

```
IDLE_TIMEOUT_MS = max(WIP_IDLE_MS+1000, 120000) = max(3500, 120000) = 120000
驱动忙时的倍数窗口 = 120000×2 = 240000，但被整轮预算压到 216000（capped，见 idle-window.js:104-110）
本次实际窗口 = 120000（驱动不忙 ⇒ 未宽限）
真机一轮 = 1790570415877 − 1790570317884 = 97,993ms ≈ 98s
生成前已消耗 ≈ 30s(gap) + 附件上传(几十秒) ⇒ 留给「网页开口」的余量不足 40s
```
即：**用户等的「近两分钟」= 30s 强制间隔 + 附件上传 + 网页 prefill**，而看门狗只给 120s、
且其中约 2/3 被生成前开销吃掉。

### 仍未取证（不猜）

- 那次 GLM 失败**当刻**的 `driverCreated` / 判据时刻的 `busy`：当前代码不落这两个读数，
  `/__webcode/status` 的 `lastError` 已被后续轮次覆盖（读到时为空、`sessionCursorInvalidations:0`）。
- GLM **首字节的直接读数**（第几秒到达）：与 §24 第 1 条同一个空白，至今没有任何记录。
- 当轮是否真的走了附件（无 `attachTransport` 快照可读）。
- GLM 是否命中风控：`captchaSelector` **只声明在 z.ai**（`lib/providers.js:574`），GLM 没有
  ⇒ 这一支可排除。

### 若要继续，从哪下手

0. **0.19.44 已修第 (1)(3) 两条机制**：executor 与适配器共享的 `meta` 上新增
   `delivering`（活标记）与 `preDeliverMs`（累计时长），看门狗的**有效 deadline** 改为
   「真正交给网页之后 windowMs」——间隔等待 / 排队 / 退避被扣出窗口，窗口本身逐字不变。
   护栏 `test/pre-deliver-window.test.mjs` 6 项，已反向变异确认红灯基线。
   **仍未修的是第 (2) 条**（GLM 附件路径本身那几十秒），它需要下面的实测数据才能决定怎么动。
1. **先做零改动的决定性实验**：把 `sendGapMs` 设 **0** 重跑同一 prompt，首字节应前移约 30s。
   `preDeliverMs` 修好之后这一格的意义变小了（等待已不计入窗口），但仍能回答「用户感知的慢
   有多少来自间隔」。
2. **配对实验（§24 第 2 条一直挂着的那条）**：同一 prompt，`promptTransportBySite.glm`
   `attach` / `inline` 各一次，比首字节耗时——这是唯一能证实/推翻「附件路径更慢」的读数，
   也是 0.19.44 之后**唯一还剩的提速方向**。
3. **补读数**：在 `idleScene()` 里加只读字段 `driverCreated`（`drivers.has(key)`）与判据时刻的
   `busy`。0.19.44 已让「投放前」可被扣出，但**报错文本仍无法区分**「驱动还没建」与
   「驱动建了但没在忙」——两者产生逐字相同的文案。
4. **不要**把 `idleFirstByteMultiplier` 调大当修法：它只作用于「首字节之前 + 驱动忙」，
   而本次恰恰是「驱动不忙」那一格，调它对这个 case **完全无效**（`test/idle-window.test.mjs`
   ②③ 是为此设的反向安全线）。

---

本文件是维护台账，不是发布阻塞清单。
## 25. **TOOL_CALL_UNPARSED 两类残根：缺 `name` 的流式块 / 断流截断的参数**（0.16.10 定性；0.16.11–0.16.15 **大幅收口**）

### 现象

用户在多轮里反复收到 `TOOL_CALL_UNPARSED: …（已扣留 N 字符协议原文）`，并直接质疑
「你到底什么问题？还是规则设置错误？？」。0.16.10 节六已收 15 份真夹具
（`test/fixtures/unparsed-notice-*.txt`，逐字摘自会话 `9e00e0b7`/`d795cf0f`/`8e8b7eae`，
扣留量 99–1022 字符）证明提示**不是误报**：网页发了调用、桥没认出。

### 定性（0.16.10 六 + 2026-09-19 会话取证）

两类根因各有独立成因（见 [`diagnosis-2026-09-19.md`](diagnosis-2026-09-19.md) §二问题 1）：

1. **缺 `name` 的流式块**：#23 的 `inferToolNameFromArgs` 已修 parse 层
   （`parseAgentReply`），但流式路径仍有漏网——推断需要参数 JSON 可解析；
   候选不唯一时按设计返回 `null`（不许猜），这类调用落到 UNPARSED。
2. **断流截断的参数**：网页流把调用 JSON 切在半截，收束后全文重parse 也配不平；
   这类调用**不可修复地丢**，只能靠提示让模型重发。

### 2026-09-18 晚新增实测

会话 `d5fd2e11`（0.16.10 运行中）单会话复发 4 次（扣留 868/2193/245/541 字符），
最后一次嵌进最终助手正文，导致「CI 四条腿 + CodeQL」核实步骤被吞。

### 影响

长跑会话的高频阻断项：每次命中都要多花一轮重发，命中在收尾时还可能静默丢步骤。

### 为什么 0.16.10 没修

该轮只修孤立 `<`（同族「字符被静默吃掉」的一条），两类残根各有独立成因，
需要单独的修法与护栏（见 `progress.md` §0.16.10 六的原话）。

### 若要修，从哪下手

1. 流式开块/收口路径复用 #23 的同一份判据：参数可解析且候选唯一时补 `name`
   再派发，推断成功带 `nameInferred: true` 留痕；
2. 断流截断类：收束后用权威 `end.text` 全文重parse 一遍（现有 mismatch 配对只覆盖
   「流式块 ↔ 权威调用」同名配对，不覆盖「流式丢块」）；仍不可救时，UNPARSED 提示
   带上被扣块的**头部片段**（工具名可辨的前 N 字符），让模型精确重发哪一条；
3. 护栏用 15 份真夹具 + `d5fd2e11` 新形状，先红后绿。

### 安全边界

「不许猜名字」的红线**分两层收口**（0.16.14）：严格推断不唯一时，若候选**全部**落在
只读白名单（read/glob/grep）内，允许取第一个可行者并标 `ambiguous`（最坏代价=一次
无害错误读取 + 模型按 RECOVERED_CALL 提示重发）；候选涉及任何写类/副作用工具仍整簇
放弃（`{file_path}` → write 的危险不放宽）。

### 状态（2026-09-19，0.16.16）

- 简写参数漂移（run-2 形态）：`normalizeDsml` 宽容已修（0.16.12，夹具 15）；
- 缺 invoke 开标签 / 闭标记残缺（run-4/6 形态）：恢复派发 + 恢复层预修已修
  （0.16.13–0.16.15，夹具 17/18 全文）；
- 闭/开参数标记**熔接**形（run-7 形态，`</ parameter name="X" string="Y">`）：
  `normalizeDsml` 熔接改写已修（0.16.16，夹具 19/20；红基线污染值与真机 `tool/call`
  存档逐字复现）。本形解析**成功**、参数脏，不走 UNPARSED——后果是
  `missing required property` / `not found` 类 isError 回流（台账同族归因落定）；
- **0.16.18（战略实验，用户拍板）**：教学切**官方 tool-call 训练模板**（HF DeepSeek-V3.1
  chat_template 逐字：`<｜tool▁calls▁begin｜>…<｜tool▁sep｜>{ARGS}…`，模型被训练时见过的
  形状）；DSML 全套解析宽容**保留为备案不删**、只是不再教。同轮修复无参调用整条丢弃
  （run-8 FAIL#3/4/5 根因：cordis_inspect_list 空参数 invoke 被丢）。验收判据：官方模板下
  UNPARSED/isError 显著下降；
- **残余风险**：漂移形状持续翻新（run-8 一轮 4 种：693/1003/1470/1474 字符，
  `session-0fd32761` 2026-09-19 04:24–04:56，含简写+参数名拼错 `olds_string`、
  参数名写成工具名 `parameter name="pwsh"` 等；畸形全部在提示头 200 字符之外，
  全文当时未落盘、形状待取证）；0.16.17 起每轮原始回复全文落
  `~/.dsh/logs/webcode-bridge-replies.log`（`lib/reply-log.js`），复现后即可逐字入夹具；
  `｜｜DSML｜｜` 残片入参数值形未修（保守原则：不剥参数值内部标记）；
  0.16.14 起 long-run 实测 **0 UNPARSED 的窗口已被 run-8 打破**（4 次，全部收束
  原因 finished、循环存活但 edit/pwsh 步骤丢失需重发）；
- 无人值守循环把纯文本提示轮当最终答案的终止问题，靠恢复派发使循环存活，
  DSH 侧循环语义未动（不属于本仓库）。

---

## 26. **`empty response from web AI`：思考-only 流走硬失败**（2026-09-19 新登记，**0.16.11 已修**）

### 现象（取证）

会话 `d5fd2e11` turn 8（22:46:59–22:48:00）整轮失败：

```
turn/end reason = {"kind":"error","error":{"message":"empty response from web AI","code":"UNKNOWN"}}
```

该轮 `assistant/attempt` 的 stream：`block-start (reasoning)` + `reasoning-chunks` +
`finish`——**只有思维链，没有正文块、没有调用块**。取证全文见
[`diagnosis-2026-09-19.md`](diagnosis-2026-09-19.md) §二问题 2。

### 定性

与 #22「只出思考不出正文」同族（网页只产出了思考就收束），但**没走**
`thinkingOnlyNotice` 软提示路径，而是以 UNKNOWN 硬错误终局。两条路径为何分岔
（哪个分支漏接）未归因。

### 影响

硬失败打断长跑（该轮之后用户必须手动补一句才能继续）；
且报错不带任何现场（思考长度、finish 相位），与「报错必须自带取证」的纪律不符。

### 若要修，从哪下手

1. 找到 `empty response from web AI` 的抛出点（先 grep 桥与驱动，
   区分是桥自己抛还是宿主 DSH 报的），确认它为什么绕过了 thinking-only 判定；
2. 思考-only 且 `finished` 收束的轮次应交回 `thinkingOnlyNotice` 同型的
   软提示（把现场与下一步交给模型），不整轮作废；
3. 报错文本带现场：思考字符数、`lastEndReason`、`domReplyChars`；
4. 护栏：构造 reasoning-only 流夹具，断言「不抛 UNKNOWN、交回提示正文」。

### 状态（2026-09-19，0.16.11 已修）

判定抽成纯函数 `emptyWebResponseError`（`lib/zero-progress.js`）：正文/思考/图片全空才
判空，报错带收束原因与流首段；思考-only 轮交回适配器走 `thinkingOnlyNotice`。
护栏 `test/empty-response.test.mjs`（5 条）。**披露**：驱动接线 2 行无自动化红线
（既有测试桩全部绕过真驱动），靠代码评审与真机 run-5/7 连续零 empty-response 佐证。

---

## 27. **站点品牌图标的来源无法在本机复核**（0.16.36 新登记，**0.16.37 已解决**）

### 现象（取证）

`lib/client.cjs` 的 `SITE_ICON_PATHS` 里八条品牌矢量（`openai` / `anthropic` /
`googlegemini` / `x` / `qwen` / `moonshotai` / `bytedance`）声明取自 simple-icons
（CC0-1.0），取件日期 2026-09-20。**当时本机沙箱下 `web_fetch` 对这些 URL 一律返回
`TypeError: fetch failed`**（外网被挡），因此这八条路径**无法在机内与上游文件逐字比对**。

当时做的形状审计（`.tmp/icon-path-audit.mjs`）**已被判定不可采信并作废**：它的数字抽取是
朴素正则，会把 SVG 路径的**标志位**（`a` 命令的 `large-arc-flag` / `sweep-flag`）与
**相对坐标**混进同一串数字里，于是报出的 `min/max` 是解析产物而不是几何事实
（例如 `max=7948` 来自多个 token 首尾相接，不是任何真实坐标）。它**连证伪都做不到**。

### 为什么不能靠「官方也用 simple-icons」绕过

官方 `dsh-client-ui-primitives` 的 `siteGlyph` 确实用同一图集（本机在 `lib/index.js` 实读到
`SITE_HOSTS` 与注释「simple-icons artwork set (CC0-1.0)」）——这解释了**为什么选它**，
但不证明**我们抄的那几条字节**与上游一致。两件事不能混。

### 解决（2026-09-21，0.16.37）

外网恢复后，改用「**取回上游 SVG → 原样贴进复核脚本 → 逐字符比对**」的做法，
脚本 `.tmp/icon-source-verify.mjs` 一次跑通，**九条全部 `IDENTICAL`**：

| 站点 | 上游 | 路径长度 |
| --- | --- | --- |
| chatgpt | `simple-icons@14.5.0/icons/openai.svg` | 1460 |
| claude | `simple-icons@16.32.0/icons/anthropic.svg` | 168 |
| gemini | `simple-icons@16.32.0/icons/googlegemini.svg` | 284 |
| grok | `simple-icons@16.32.0/icons/x.svg` | 194 |
| qwen | `simple-icons@16.32.0/icons/qwen.svg` | 697 |
| kimi | `simple-icons@16.32.0/icons/moonshotai.svg` | 537 |
| doubao | `simple-icons@16.32.0/icons/bytedance.svg` | 218 |
| zai | `@lobehub/icons-static-svg@1.95.0/icons/zai.svg` | 119 |
| glm | `@lobehub/icons-static-svg@1.95.0/icons/chatglm.svg` | 2040 |

**复核过程本身查出一条事实，必须记下来**：`openai` 在 simple-icons **latest 里已经是 404**，
只在 14.5.0 还能取到——即该图标后来被图集移除（simple-icons 的商标移除流程）。因此
「我们的 openai 路径来自哪个版本」必须写在复核脚本里；下一个人若拿 `@latest` 去核，
会得到 404 并误判成「路径是编造的」。

### 仍然要分开的一件事（本条目解除的是「来源」，不是「官方性」）

zai / glm 两条来自 **lobehub 社区图集**，**不是品牌方发布的资产**，与 simple-icons（CC0）
也不同许可。脚本证明的是「字节与上游一致」，**不是「它属于官方发布」**。这一点由
`SITE_ICON_TIER` 的 `vector` 档承载（见 `doc/progress.md` §0.16.37 一），两侧不要互相冒充。

### 若要重跑

```
node .tmp/icon-source-verify.mjs    # 退出码 0 = 九条逐字相同
```

该脚本是**一次性取证留痕**（`.tmp/` 不入库）。若要长期保留，应移进 `scripts/` 并接进 CI——
那样图集升级导致的静默漂移才会变成红灯。当前未做，如实记。

---

## 28. **思维链退化重复：同段内容原地打转**（2026-09-26 新登记，**已修 0.19.26**）

### 现象（用户原话）

> 「出现反复一样字段 20 次以上在思维链时候自动打断重发？然后单纯词语对比度可以做到吗？
> **不是具体词语而是通用适配**」

真机形态：模型在思考里反复催自己（「Let me output. / OK. / Writing. / Go.」循环上百字），
正文一个字符都不落，于是收尾交回一条 `THINKING_ONLY_NO_ANSWER`，下一轮续跑又撞同一个循环。

### 为什么不能写成词表

用户特意排除的那条路（「不是具体词语」）正是本仓库栽过至少三次的坑——真机里模型每次卡住时
唠叨的那句话都**不一样**，写词表就是把「已见过的形态」当成「全部形态」。

### 判据（通用：无词表、无语言假设）

`lib/repeat-detect.js` 的 `findDegenerateRepeat` 做纯统计：把文本切成 token，找**最小周期**，
数它**连续重复了几遍**。默认阈值 20 次（用户指定）、周期上限 40、只看尾部 6000 字符。
「Go. Go. Go.…」与「继续继续继续…」在这个判据下是同一件事。

**一条必要的收窄**：周期内必须含**实词字符**（字母/数字/CJK）。没有它，探针实测出两类
**正常**写法会被误判——尾部长横线 `-`×40（markdown 分隔线）与重复的表格骨架
`| --- | --- |`（模型在思考里画表）。两者都是「装饰在重复」而非「内容在自我复制」。

**代价如实记**：纯符号退化（`[[[[[[…`）不再被本判据抓到。那是有意的取舍——纯符号长串更常见的
成因是协议/JSON 被截断，由协议层与既有整轮续跑兜底；在这里抓它会把「一行长分隔线」一起抓进来，
代价是**打断一个正常回复**。漏报只是回到既有兜底，误报更贵。

### 处置（打断 + 重发，不是仅告警）

命中即 `break` 出流式循环，改走既有 `autoContinueRound` 补发通道把提示送进**同一个网页会话**
（与 thinking-only / UNPARSED 同型），归因换成 `THINKING_REPEAT_DETECTED`，带
`repeats` / `period` / `sample` 读数——只说「检测到循环」而不说循环的是什么，下一个人无法复核。

### 护栏

`test/repeat-detect.test.mjs` **11 项**：9 项判据（**反例多于正例**：正常中英文散文 / markdown 列表 /
代码块 / 两个探针实测误报 / 中间重复但尾部已恢复）+ 2 项**接线断言**（两个流式循环各一处探测、
各一处 `break`、提示函数必须收读数）。接线用例已用**反向变异确认**：删 `break` ⇒ 变红，还原 ⇒ 11/11。

### 两个读数都要看清（不要只挑好听的那个）

- **误报面**：历史回复日志 **4477 段 / 821,766 字符，命中 0（0.00%）** ⇒ 真实语料上没有误报面。
- **漏报面**：同一份日志里也**没有**足够长的退化样本 ⇒ 上面那个 0 **不构成**「判据有效」的证据，
  它只证明「不误伤」。本条目**不声称已量化真阳性率**。

### 本轮自己踩的坑（与判据无关，但它说明了为什么要跑全量）

接线时漏掉纯聊天轮 think 分支的 `continue`，think 事件于是掉到循环末尾的
`end = ev.end; break`（think 事件没有 `ev.end`）⇒ 流被当场截断。它由**与本功能毫无关系**的
`test/watchdog-first-byte.test.mjs` 第 ① 项抓出（期望 `'网页答复'`、实际 `THINKING_ONLY_NO_ANSWER`）；
`git stash` 对照 **HEAD = 9/9 通过**、带本轮改动 = **8/9** ⇒ 确认是本轮引入的回归。修法即补回
`continue`，教训写进代码注释。

---

## 29. **Z.ai 自带风控闸门：验证通过前根本不发请求**（2026-09-27 新登记）

> ### 2026-09-30 复核：闸门仍在，且拿到一条解释「用户看不见」的新读数
>
> 在**实时浏览器**（桥自己的实例，`DevToolsActivePort` 2070）驱动一次无害发送
>（`请只回复三个字：你好呀`，与既有探针同一口径）：**阿里云滑块全窗弹出、
> completion 请求零发出**（页面内 fetch tee 零命中）；无头副本探针同形（0.19.41
> 以来第四次复现）。同时用户报告「人为打开从未见过验证」——两者同时为真的原因
> 实锤：**弹窗发生在无头浏览器里，用户看不见**；用户手工（有头窗口）发送时
> 风控打分不同（或曾静默通过）。桥按纪律不绕过风控；现场已恢复干净（重载清掉
> 悬置滑块）。`WEB_CAPTCHA_REQUIRED` 的如实报错维持。
>
> **待办（一条）**：z.ai 自动化轮次要可用，需要一次**有人能看到的**滑块配合
>（有头探针 `$env:PROBE_HEADED='1'; node .tmp-probe/zai/probe-zai-chat-frames.mjs`，
> 或实时版 `live-zai-send-tee.mjs`）——它同时补 #30 的帧取证。用户本轮选择跳过。

### 现象（用户原话）

> 「然后z.ai:本轮运行失败WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容（页面在，判定相位=
> 网页还没开口且驱动不在忙（按常规窗口未宽限），最近驱动活动时间 1s 前，**页面已有 7 字回复未回传**）」

### 两件事，都不是报错里说的那件

**① 那 7 个字不是回复。** 旧 `answerSelector` 是宽特征串
`div.markdown-body, .markdown-body, [class*="prose"], [class*="message"], main`，
而驱动读的是 `[...querySelectorAll(sel)].pop()`（文档序最后一个）。尾部那条
`[class*="message"]` 命中的是**输入框容器** `div.messageInputContainer`，它的 innerText
恰好是「深度思考\n最高」= **7 字**。三处独立读数逐字吻合：293 元素真机夹具复算 / 落地页实测 /
事故现场 `replyChars:7`。（**已修 0.19.41**：`answerSelector` 改为语义特征
`div.chat-assistant, #response-content-container`，护栏 `test/zai-answer-selector.test.mjs`。）

**② 真因不在解码器，也不在超时：请求根本没发出去。** 站点自带前端
（`z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.1.96/assets/index-p_7VciLU.js`）逐字写着：

```js
if (l()?.features?.enable_captcha) { try { lc = await HN() } catch { …return } }
const bu = await bhe(localStorage.token, {stream, model, messages, params, files, mcp_servers, features}, …, lc)
```

`bhe` 就是 `fetch(`${base}/api/chat/completions?…`)`。`GET /api/config` 的唯一命中读数是
`features.enable_captcha = true`；自动化环境下 `await HN()`（阿里云滑块验证）**不返回**，
于是 `bhe` 永不执行 ⇒ wire 上**零帧**。四轮真机复现（headless×3 含一轮完整 `driver.sendTurn`、
headed×1）**全部 0 帧**；把 UA 从 `HeadlessChrome` 换成正常 Chrome 也**没过闸**。

### 为什么不修它（这是有意的现状）

**绕站点风控属破解行为，本项目不做。** 因此本轮只做两件事：

1. 把真因如实暴露出来：新增站点声明位 `captchaSelector`
   （`#chat-captcha-element, #aliyunCaptcha-window-popup.window-show`），驱动在
   **发送确认之后**做一次采样，命中可见节点即抛 `WEB_CAPTCHA_REQUIRED`，文案说明
   「消息未被网页受理」「wire 上零帧」、要求「在弹出的浏览器窗口里手动完成验证后重试」，
   并**明确否掉**「解码器 / 网页没回传」这两个误导方向；有头时把窗口带到前台。
   护栏 `test/captcha-gate.test.mjs`（5 项，含「必须晚于发送确认与回读校验」
   「不得按站点名硬编码」「必须是一次采样而不是轮询等超时」）。
2. 把「换掉 decoder 就能好」这条错误方向钉死在档案里（见 #30）。

### 未取证（不猜）

人肉过一次验证之后 `enable_captcha` 是否仍每次触发：`lc` 是每次发送的局部变量、
`await HN()` 每次发送重跑，但 `HN()` 内部是阿里云无痕验证语义（分低静默通过、分高弹滑块），
而**我们一次 `HN()` 成功返回都没观测到** ⇒ 答不了。决定性下一步：
`$env:PROBE_HEADED='1'; node .tmp-probe/zai/probe-zai-chat-frames.mjs`（有头窗停在页面 150s，
人肉拖过滑块后 fetch tee 自动落盘真机帧）。这条同时能回答 #30。

---

## 30. **Z.ai 真实流帧格式未录制：现有 9 个 decoder 都读不了它**（2026-09-27 新登记）

> ### 2026-09-30 进展：取证工具链就绪，缺一次人肉滑块配合
>
> 新增实时版探针 `.tmp-probe/zai/live-zai-send-tee.mjs`（在桥自己的浏览器里装
> fetch tee + 无害发送，避开「拷副本丢上下文」的形态）与只读检查
> `live-zai-readonly.mjs`（档位控件/验证码/地址的实时读数，2026-09-30 已跑：
> pill「深度思考 最高」、零验证码节点、发送后地址 `/c/<uuid>`）。帧仍为零——
> 闸门（#29）挡在发送之前。**拿帧只差一步**：有头窗里人肉拖一次滑块（两脚本
> 任一），帧会自动落盘；届时按下方字段形状写 decoder 并存逐字夹具。
> 用户本轮选择跳过，维持登记。

### 结论来自站点 bundle 的逐字片段（**不是**一次真实响应）

站点自带前端里 `"parts"` 出现 **0** 次、`choices` **0** 次、`reasoning_content` **0** 次
⇒ z.ai **既不是** GLM 的 `parts[].content[].type`（`GlmDecoder`），
**也不是** OpenAI 的 `choices[].delta.content`（`OpenAiSseDecoder`）。
真实帧是扁平字段（帧处理器 `di` 的解构，逐字）：

```
{id, done, content, delta_content, edit_content, sources, …, phase="other", …,
 tool_name, delta_arguments, status, metadata, content_blocks}
```

其中 **`delta_content` 是增量、`content` 是全量快照**——混用必须做前缀差分，
否则整段播两遍（与 #21「SET 重发吞掉流式增量」同一族坑）。

### 为什么 `decoder` 字段**刻意没改**

现有 9 个 decoder kind 没有一个读 `delta_content`。把 ZAI 的 `decoder` 换成 `'glm'`
就是「猜着解不出」——比维持现状更糟：现状至少报的是「零帧」，换错会报出一堆错读数。
因此 0.19.41 只改了 `answerSelector`（那是**已被真机证伪的假读数**，不修会继续误导排查）
与本条登记，**decoder 留待有真机帧的那一次**。

### 取帧的方法（已备好，缺一次人肉过验证）

`$env:PROBE_HEADED='1'; node .tmp-probe/zai/probe-zai-chat-frames.mjs`：有头窗停在页面等
150s，人肉拖过滑块后，页面侧 fetch tee 自动把真机帧落盘。拿到帧后按上面字段形状写 decoder，
并把帧样本存成 `test/fixtures/` 的夹具（**逐字**，会话 id 可脱敏）。

### 与此条同时被推翻的一条假设

「z.ai 用 GLM 的 `parts` 帧，所以只是 `decoder` 选错了」——**证伪**。
`completionPaths`（`/api/chat/completions`）是**对的**；会话地址形状 `/c/<uuid>`
虽然**观察到**了但 `goto` 被打回根地址、标记 0 次命中 ⇒ 与 kimi 的 `/chat/<uuid>`
（goto 后地址逐字不变、读回上轮标记）形成对照，z.ai **继续维持 `unsupported`**。

## 31. **四站的「思考等级」没有真机读数 ⇒ 刻意不声明**（2026-09-28 新登记）

> ### 2026-09-30 结账（0.19.52）：五站 `defaultEffort` 已声明——「Default」行消失
>
> 用户指令「去除没有的 auto 挡位」推翻了 0.19.48 的「刻意不声明 defaultEffort」
> 决策：不声明时宿主选择器恒显示「Default」行——网页上没有这档，它就是那枚
> 「没有的 auto」。五站现声明默认档（kimi 标准 / glm 极致 / zai 最高 / qwen 自动 /
> doubao 快速，逐条取证写在 `think-effort.js` 条目注释，zai 侧含 2026-09-30
> 实时 CDP 读数）；声明后 Default 行消失、选模型即携带该档。代价如实记：每轮
> 下发并核对档位，站点改版让回读失效时症状从「选档才报错」变成「每轮
> THINK_EFFORT_UI_CHANGED」——用户明确选择的确定性。
> **四站缺口（chatgpt/gemini/grok/claude）维持**：网络不可达，无读数不声明
>（正文表格不变）。

### 现状（这是有意的，不是漏做）

0.19.48 把 DSH 的推理等级通道接上了（`lib/think-effort.js`），但**只对拿得到真机读数的站点声明**：

| 站点 | 状态 | 为什么 |
| --- | --- | --- |
| kimi / glm / zai / qwen / doubao | 已声明 | 逐个在落盘 profile 副本上采到了控件与档位文本（证据 `test-mock/out/think-control-*.json`） |
| chatgpt / gemini / grok / claude | **未声明** | 本机网络 `ERR_CONNECTION_CLOSED`（三站）/ 停在验证页（claude），拿不到任何 composer 读数 |
| deepseek | **未声明** | 用户原话即「除了 deepseek 是只有深度思考开关没有思考等级开关」；它的开/关由既有的 `syncThinkPill` 链承担 |

### 为什么宁可不声明

`applyEffort` 对「用户选了档、而站点没有可点控件」是**抛错**（绝不静默降级）。声明一个没读数的站点
⇒ 该站点**每一轮**都抛 `THINK_EFFORT_UI_CHANGED`，等于把站点弄成不可用；而少一栏的代价只是少一栏。
两种代价不对称，所以缺口只能等读数。

### 补齐需要什么

1. 一条能到达该站点的网络（chatgpt / gemini / grok 本机全被拒；claude 停在人工验证页）；
2. 一次 `node test-mock/probe-think-control.mjs <site> --dump` 采到 composer 附近的控件与档位文本；
3. 把读到的**逐字文本**写进 `lib/think-effort.js`（等级 id 就是菜单文本，不许翻译）；
4. 跑 `node test-mock/probe-think-effort-live.mjs <site>` 确认下发 + 回读成立。

### 另有两条与「档位」相邻、本轮**没有**动的缺口

* **kimi 的 `标准` 档未取证**（**0.19.49 已解决**）：当时本机那份 kimi profile 掉了登录
  （页面明写「登录以同步历史会话」），只验到 `进阶`。0.19.49 改用**只读 CDP** 在线上已登录页面上
  补到了读数：触发文本 `K3 标准`、`span.current-effort` 的文本是 `标准`，
  且用生产判据复算，目标「标准」判 `match`、目标「进阶」判 `mismatch`（脚本 `.tmp-probe/cdp-verify-fix.mjs`）。
  取证方法本身见 #32。
* **z.ai 的总开关与档位是两条链**：菜单里除三档外还有一个 `role="switch"`（要不要思考）。
  本轮只动档位、不动总开关（它属于 `thinkMode` / `model.thinking` 那条既有链）。已知后果：
  网页端把总开关关掉时，选档位不会把它打开——桥不替用户猜「关掉是不是误操作」。

## 32. **kimi 的登录态在 localStorage 而非 cookie ⇒ 「拷 profile 副本」式探针拿到的是游客页**（2026-09-28 新登记）

### 现象（这一条差点让整轮取证得出错误结论）

`test-mock/probe-think-effort-live.mjs` 与 `probe-think-control.mjs` 的取证方式是
「把落盘 profile **拷一份副本**、在副本上开浏览器」（这个设计本身是对的：杀进程不会污染登录态）。
它在 glm / zai / qwen / doubao 上都工作，**唯独 kimi 拿到的是游客页**：

```
test-mock/out/think-effort-live-kimi-2026-09-28T11-19-23.json：
  "title": "Kimi AI 官网 - K3 上线，专为智能体编程与知识工作打造"
  "url":   "https://www.kimi.com/"
  scene.clickables 里有 "登录"、"登录以同步历史会话"
  overlayCount: 0        ← 模型菜单从未打开
  → THINK_EFFORT_UNAVAILABLE: 档位菜单里没有「标准」（当前读数：快速 进阶）
```

### 根因

kimi（Kimi Agent，`www.kimi.com/agent`）的登录凭据**不在 cookie 里** —— 实测 9 枚 cookie
全是统计/偏好类，真正的 `access_token` 在 **localStorage**。而 profile 副本这条路的登录态
承载在 cookie 库（`Network/Cookies`）上，localStorage（`Local Storage/leveldb`）虽然也拷了，
但 kimi 的 `access_token` 是**短时效**的（15 分钟级），副本里那份往往已经过期 ——
于是站点按未登录渲染。

**为什么这条很危险**：游客页上「模型菜单点不开、档位条目找不到」会稳定产生
`THINK_EFFORT_UNAVAILABLE` / `THINK_EFFORT_UI_CHANGED`，与**真缺陷的症状逐字相同**。
拿这份读数去解释线上报错，就是本仓库记过多次的「拿另一种现场的证据下结论」——
差一点就把 kimi 的真实缺陷（模型名当锚点）记成「站点改版」或「本来就是游客页」。

### 替代取证法（本次采用，可复用）

顺 profile 里的 `DevToolsActivePort`（桥用 `--remote-debugging-port=0` 启动，端口号写在这个文件里）
连上**线上那个浏览器**做**只读** `Runtime.evaluate`：不点击、不填框、不发消息、不改状态。
本机实测端口：kimi 1170 / glm 6353 / zai 11632 / qwen 11419 / doubao 7155。

脚本：`.tmp-probe/cdp-effort-inspect.mjs`（读控件现状）、`.tmp-probe/cdp-effort-models.mjs`
（读模型菜单，仅点一次开菜单后立刻 Esc）、`.tmp-probe/cdp-effort-all.mjs`（逐站点）、
`.tmp-probe/cdp-verify-fix.mjs`（把真机读数喂给生产判据复算）。

⚠ 两条使用边界：

1. 端口文件只在该站点浏览器**正在运行时**有效（浏览器关掉后端口连不上）——
   `cdp-effort-all.mjs` 运行时 glm/kimi 可达而 zai/qwen/doubao 报 「CDP 不可达」，就是这个原因；
2. 它读的是**用户正在用的那个浏览器**，因此脚本必须坚持只读。
   唯一一次点击（`cdp-effort-models.mjs` 点开模型菜单读模型名）之后立即按 Esc 关闭并复读原状，
   已核对菜单开启前后触发文本逐字不变。

### 补齐需要什么

若要让「拷 profile 副本」这条路对 kimi 也成立，需要把 localStorage 里的 `access_token`
一并带过去（或改走 CDP）。**未做**：access_token 是 15 分钟级的短时效凭据，
把它复制进另一个 profile 目录会多出一份可用的凭据副本，收益（少一次 CDP 连接）
不抵代价。因此记在这里，等真的需要「不依赖线上浏览器」的 kimi 探针时再决定。

## 34. **zai / doubao 的思考等级回读只有静态复算，没有真机读数**（2026-09-29 新登记）

> ### 2026-09-30 读数补齐（0.19.52 轮）
>
> - **zai**：实时只读 CDP（`.tmp-probe/zai/live-zai-readonly.mjs`，桥自己的无头
>   浏览器）：pill 文本「深度思考 最高」可见、当前档 = **最高**——档位控件在、
>   形态与声明一致（triggerText「深度思考」+ 后缀档位）。回读判据的**下发-回读
>   循环**仍未跑（受 #29 闸门挡住真实轮次），但「控件在、形态对」已从静态复算
>   升级为实时读数。
> - **doubao**：fresh 页 think-control dump ×4（2026-09-28）：模型下拉
>   「豆包 快速 / 豆包 2.1 Turbo专家」——徽章即档位，fresh 状态 = **快速**，
>   与 `defaultEffort: '快速'` 的声明互证。
>
> 「每轮 THINK_EFFORT_UI_CHANGED」的风险因此收窄为「站点改版」一档
>（0.19.48 起的既有边界），「控件根本不在」一档已被读数排除。

### 现象

0.19.49 修完 kimi / glm / qwen 三处回读缺陷后，收口记录写的是「zai / doubao 复算后未发现缺陷」。
**「复算」不是真机**：那是把**已知的**真机形状喂给生产判据（`.tmp-probe/zai-sim.mjs`），
验的是「判据在这些输入上算得对」，不是「这两个站点的回读今天真的读得到档位」。

### 为什么不能就此算过

本仓库对「没真机读数就声明」有成文纪律（`think-effort.js` 的文件头：#31 四站不声明档位，
理由正是「没有真机读数」）。同一条纪律在这里被放松了一次——不是有意，是**取证条件不允许**：
2026-09-29 复跑时五个站点的 `DevToolsActivePort` 端口文件都在，但 `127.0.0.1:<port>`
**全部积极拒绝**，`Get-Process msedge,chrome` 无输出，即浏览器根本没在跑。

### 影响

`applyEffort` 对「用户选了档、而回读不到」是**抛错**（绝不静默降级）。因此若 zai / doubao
的回读**实际**已坏，症状不是「档位不准」，而是该站点**每一轮**抛 `THINK_EFFORT_UI_CHANGED`
（与用户 2026-09-28 报的那条逐字相同）。这一条正是「其余都是类似原因」在 zai / doubao 上
**尚未排除**的那一半。

### 若要补，从哪下手

1. 先把浏览器跑起来（桥里打开该站点、保持登录），确认 `DevToolsActivePort` 可连；
2. 只读 CDP：`.tmp-probe/cdp-effort-inspect.mjs`（读控件现状，不点击不填框）；
3. 真机下发 + 回读：`node test-mock/probe-think-effort-live.mjs <site>`；
4. 把读数喂给生产判据复算：`.tmp-probe/cdp-verify-fix.mjs`；
5. 读数与结论按 #32 的纪律落进 `doc/research/`（附日期与原始片段）。

**不要**因为「复算过了」就把 #31 里 zai / doubao 的行改成已取证——那正是本条要防的事。

---

## 35. **并列三列的「列级沙箱」是约定而非拦截**（2026-09-29 新登记）

### 现象（这是一个**被有意保留**的现状，不是漏做）

`lib/column-context.js` 与 `lib/column-fs.js` 一起构成「并列多会话的列身份 + 产物围栏」。
但实测（`doc/research/2026-09-26-column-sandbox-round1-thinking.md`）指出同一件事：
**同一个模型有两条路径**——

| 路径 | 入口 | 能否真改文件 |
| --- | --- | --- |
| provider 通路 | `lib/index.js` 注册的 adapter | **能**（工具由 DSH 执行器落地） |
| 控制面通路 | `web-control.js` 的 `POST chat` | **不能**，只回文本 |

结论：**并列三列今天对工作区没有任何文件效果**，因此「按列改写 workdir」是为一个
**不存在的问题**造机器（第一轮思考的原话）。

### 为什么结构上做不到（这是产品边界，不是能力缺口）

本插件**只增加**一条 `llm` 路由与一个本地服务，**从不替换** DSH 的 `fs` / `shell` / `skills` /
`MCP` 注册表（`wiki/architecture.md` §7）。推论：工具调用的权限、沙箱、审批**全在 DSH 侧**。
因此「按列拦截文件写入」这件事**在本插件里没有落点**——模型发起的 `edit` / `pwsh`
由 DSH 工具执行器执行，那条链路上没有本插件的插槽。

### 现有的诚实做法（保留，不要美化）

- `columnGuidance` 只做**约定**：告诉列它「应该」把产物写进哪；
- `column-fs.js` 做**自持写入围栏**（照抄官方 `dsh-fs-sandbox` 的 canonicalize-then-contain，
  Windows 8.3 短名与大小写别名必须被认成同一路径），口径是「本插件自己落盘时不许越界」；
- 第二轮思考的结论 B/C（桥侧产物围栏 + 让产出目录真的存在）**已采用**，D（每列独立 DSH 会话）
  **明确不做**——那要改产品且跨层改造。

### 若要继续，从哪下手

**先回答一个问题**：并列三列是否**应该**有能力改工作区？若答案是「应该」，那要动的是
**DSH 侧的会话/沙箱模型**（每列一个真会话），不是本插件再套一层拦截；若答案是「不该」，
那本条应当从「未修」改成「边界声明」，并在 `doc/permissions-and-boundaries.md` 里显式写清。
**当前不做**：这是一个产品决定，不是一个缺陷。

---

## 36. **`ref-index` 既有红**（2026-09-29 复核：**已解决**）

> 本条登记的是**一次更正**：它曾被当成欠账，实测已经不在。

### 曾经的读数（2026-09-23，`compliance-audit-0.19.1.md` §4.1）

`node scripts/gen-reference-index.mjs --check` **退 1**，`ci-local --fast` 因此只有 6/7 步通过。
差异两项：① `deepseek-harness` HEAD 表里写 `ddefc45…`、磁盘是 `00102833…`；
② 表里**没有** `dsh-official-plugins` 这一行，但目录在磁盘上。
根因是**生成物漂移**：表由脚本生成，磁盘变了而没人重跑生成器。

### 本轮实测（2026-09-29）

```
node scripts/gen-reference-index.mjs --check   →  exit 0（PASS）
node scripts/ci-local.mjs --fast               →  10/10 步通过
```

即那张来源表**已经与磁盘一致**（`reference/deepseek-harness` HEAD 现为
`00102833dfaee1da9f48a3a8eae9d34005a75218`，tag `dsh-v0.1.7-alpha.2`）。

### 为什么仍要留一条正文（而不是删掉）

因为**「曾被记为未修复」这件事本身**是本仓库的一手教训：
`compliance-audit-0.19.1.md` §0 与 `diagnosis-2026-09-23-dsh-0.1.7-alpha.2.md` §0
都记过同一族错误——**把当时的读数当成长期事实**。本条的更正与它们是同一族，
所以保留正文、把结论改成「已解决」，而不是让它悄悄消失。

**护栏**：`check-plugin-contract.mjs` 之外的 `ci-local` 第 8 步 `ref-index` 就是这条的
常驻守卫；它自带 `--check` 形状，生成物一漂就会红。

---

## 33. **需要人才能过的验收环节没有「提醒人手动过」的回路**（2026-09-29 新登记）

### 现象（用户 2026-09-29 的原话就是这一条）

> 顺带解决 z.ai 验证问题——如果需要验证能够提醒人手动过吗？

起因是 0.19.49 收口时的实况：z.ai **本轮未发现缺陷**，但取证停在
「真机形状 + 当前代码」的复算（`.tmp-probe/zai-sim.mjs`），因为 2026-09-28 那次
z.ai 浏览器「端口文件在、连不上」；2026-09-29 复跑时**五个站点全部连不上**
（`DevToolsActivePort` 端口文件都在，`127.0.0.1:<port>` 全部 `积极拒绝`，
`Get-Process msedge,chrome` 无输出）。

也就是说：**有些验收环节必须有人**（登录态、风控验证页、真实轮次），
而当前工具链对这条的处置是**静默**的——探针会在「CDP 不可达」处停下，
但**没有任何一处提示「这一步需要你去点一下」**。人不主动找，就只会看到缺口一直挂着。

### 这不是「没做」，是「做成了另一副样子」

本仓库对「取不到读数」的既有姿态是**正确的**：不假装验过，把缺口如实记进 `doc/`（#31 / #32 即此）。
缺的是**最后一段**：缺口记下来了，却**没有转成一条给人看的、可执行的提醒**——
它躺在 2000 行的台账里，而不是出现在「这一轮该你了」的位置上。

### 补齐需要什么（未做，列在此处备查）

1. **探针侧的显式人因出口**：`probe-think-effort-live.mjs` / `probe-think-control.mjs`
   在 CDP 不可达时，不只打印技术错误，而是给出一句**面向人的动作**
   （「请先在桥里打开 <站点> 并保持登录，然后重跑本命令」），并**退出码可区分**
   （「取不到读数」≠ 「跑出来是坏的」——现在这两种在某些路径上不易分辨）；
2. **`doc/verify.md` 的待人工项**：把「需要人过」的条目单列一节，而不是散在长期问题里；
3. **可选的自动化**（本轮**明确不做**）：桥自己起浏览器 + 检测到需人工时提示。
   它要动驱动生命周期（`launchPersistentContext` / 锁 / 孤儿回收），
   代价明显大于收益——**先做前两条**。

---

## 37. **两条既有常红是同一条行为：网页会话丢失 → 整段重放**（2026-09-30 登记当晚**已修**）

### 二次复核（2026-09-30 晚，**推翻本条最初的归因**）

> **原归因「60s 超时说明用例在等一个永不到来的事件」是错的。** 用例在等一个**真实存在的**
> 事件——用户的真实限流窗口。

**真因：测试隔离缺陷，不是重放分支。** 完整根因链（每步实测）：

1. 裸测试 `apply(ctx, {port:0, driver})` **不传 `profileDir`** ⇒ `cfg.profileDir` 回落
   DEFAULTS 的**真实** `~/.dsh/webcode-edge-profile`（`lib/index.js` DEFAULTS）。
2. settings / send-state / wait-stats 三个落盘路径**没有任何测试守卫**（同文件里
   reply-log / prompt-store / continue-budget 都有 `NODE_TEST_CONTEXT` 守卫，
   唯独这三处漏了）⇒ 测试读到真实 `webcode-settings.json` 的 `sendGapMs: 30000`
   与真实 `webcode-send-state.json` 里 24h 内的发送基准。
3. 重放用例 = 同一账号 3 次发送 ⇒ 2 段 30s 真实等待 = **60.02s**，压线撞 node:test
   默认 60s 用例超时 ⇒ **红**。基准只在 24h 内有效 ⇒ **红绿随本机状态漂移**：
   「干净树同样红」为真，「过一天自己变绿」也为真——两条都是同一个缺陷的表现。
4. `regression` 那条 90s（54 用例中最慢）与 `aux-delta-compact` 那条 60s 同源。
5. **反向污染（比假红更糟的一半）**：`rememberSend` 把测试的假发送时间戳写回真实
   send-state（实测：跑一遍 regression 后 deepseek 条目 `send=1790715108997` =
   2026-09-30 04:51:49，正是测试运行时刻）——用户的下一轮真实请求被测试凭空压上
   30s 发送间隔。

### 修法（一处判据，六个落盘点）

`lib/index.js` 新增统一判据（与 reply-log / prompt-store / continue-budget 守卫同族）：

```js
const profilePersistenceUsable = () => Boolean(config && config.profileDir) || !process.env.NODE_TEST_CONTEXT;
```

- 裸测试形态：settings 读/写、send-state 读/写、wait-stats 读/写全部跳过真实 profile。
- **对称修复（顺带解决的生产死链）**：cursor-state 的旧判据 `Boolean(config.profileDir)`
  前提「生产必传 profileDir」是错的——**DSH bundle 形态（cordis.patch.yml）不传它** ⇒
  0.21.1 的游标持久化在生产从未生效（真实 profile 里没有 `webcode-cursor-state.json`，
  修前实测）。新判据的「非测试进程」分支放行生产；standalone（显式传）不变。

### 护栏与读数

- `test/profile-isolation.test.mjs` **4 项**（判据形状 + 裸 apply 零污染 + 零等待 +
  显式形态不回归）；反向验证：判据改坏 ⇒ 红、删 send-state 读守卫 ⇒ 红。
- 修后同机同命令：`aux-delta-compact` 重放用例 **60.02s → 1.02s**（5/5）；
  `regression` **571.4s → 9.9s**（54/54）；`cursor-persistence` 5/5、
  `session-anchor` 7/7、`settings-transport` 8/8 均不回归。
- 完整根因链与闸门读数见 `doc/progress.md` 的「profile 落盘测试隔离」段（2026-09-30）。

### 原始登记（2026-09-30 早，保留供对照）

### 现象（本轮全量实测）

2026-09-30 跑全量单测（118 文件逐文件跑），**115 通过 / 3 失败**。逐条归因后：

| 测试文件 | 读数 | 归因 |
| --- | --- | --- |
| `prompt-store.test.mjs` | 11/11 **通过**（设 `NODE_TEST_CONTEXT`） | **调用方式产物**，不是缺陷：该用例显式要求 `node --test` 环境（断言原文「node --test 进程不许写真实 `~/.dsh/webcode/`」）。逐文件跑时该变量不存在 ⇒ 假红 |
| `regression.test.mjs` | **53 / 1** | **既有常红**，见上 |
| `aux-delta-compact.test.mjs` | **4 / 1** | **既有常红**，见上 |

### 关键读数：两条红都与本轮改动无关（干净树复跑取证）

```
git stash push -u            # 撤掉本轮全部改动
node test/aux-delta-compact.test.mjs   →  4 pass / 1 fail（同一条、同样 60s 超时）
node test/regression.test.mjs          → 53 pass / 1 fail（同一条、同样 60s 超时）
git stash pop                # 恢复
```

**逐字同样的红**。因此这两条**不是本轮引入的回归**。（复核注：这个取证本身是对的，
但「干净树同样红」恰恰说明红与代码无关——真正该测的是**为什么**会等 60s，见上。）

### 为什么仍要单列成一条长期问题（而不是继续当脚注）

三条理由：

1. **它们是同一条行为**。两条失败都在**「网页会话丢失（`WEB_SESSION_LOST`）→ 整段重放」**
   这条路径上，且都卡在 **60s 超时**——不是两个独立缺陷，是一个。
   `regression` 那条断言「应该整段重放而不是把增量丢进空会话」；
   `aux-delta-compact` 那条断言「重放必须含本轮压缩指令（不能用落盘的真实首轮正本代替）」。
   两者问的是同一件事的**两个面**。
2. **它落在本仓库的红线区**。`doc/review-guide.md` 的第二条不可越界约束正是
   **「绝不静默丢上下文」**——网页会话丢了只能重放整段或抛错。**这条路径的护栏是红的**，
   意味着红线上那道防线**当前没有在保护任何东西**：它可以被改坏而无人察觉，
   与「空转的闸门比没有闸门更坏」是同一个形状。
3. **记录位置不对**。此前它只作为**脚注**存在于 `doc/progress.md` 的「单测基线」格子里
   （「regression 53/1 的那 1 条红…与本轮改动无关」）。**一份 5000 行的台账里的脚注，
   不是一条欠账**——下一个人看到的只会是「全量测试是绿的」这个汇总印象。

### 修后补记

「重放必须含本轮压缩指令」这条断言本身仍然有效（5/5 绿）；护栏现在**真的在保护**那条路径，
而不是靠 60s 超时偶发地通过。红线（绝不静默丢上下文）上的这道防线恢复常绿。



---

## 38. **`NODE_TEST_CONTEXT` 守卫在裸跑形态的残余洞：prompt store 读写通道**（2026-10-02 登记）

### 现象（0.19.53 提交前抽查实测）

- `node test/regression.test.mjs`（**裸跑**——本机 spawnSync EPERM，逐文件裸跑是唯一可行形态）
  稳定红一条：「网页会话丢失时用整段首轮提示词重放」60.03s 失败于 `重放带完整上下文`。
- 断言序列里 `turns.length==3` 与两条 `fresh` 标志**全过**——重放**发生了**，但重放文本
  **缺「第二句」**。这是内容错，不是超时错（60s 是两次 30s 发送间隔的累计，与内容无关）。
- 根因链（实读）：
  1. `readSessionPrompt`（`lib/index.js:72`）的隔离判据是「无 `WEBCODE_PROMPT_STORE_DIR`
     **且**有 `NODE_TEST_CONTEXT` 时返回 null」。`node --test` 会设 `NODE_TEST_CONTEXT`，
     **裸跑不设** ⇒ 守卫失效 ⇒ 重放优先读回真实目录的落盘正本。
  2. 落盘正本 `~/.dsh/webcode/sessions/lost__deepseek.md` 由**测试自己首轮写入**
     （写入端守卫同样只认 `NODE_TEST_CONTEXT`），内容只有首轮文本——
     **增量轮刻意不落盘**（`prompt-store.js` 的 `writePromptFiles` 注释明言）。
  3. 重放读回「只有第一句」的正本 ⇒ 断言缺「第二句」。测试用固定 sessionKey `lost`，
     所以从第二次裸跑起**必红**。
- 同族：#37（2026-09-30）修的是 cursor/profile 通道的同一类缺口；本条是**漏掉的
  第二条通道**（prompt store 写 + 读回）。

### 本轮处置（已做，随 0.19.53 入库）

- `test/regression.test.mjs` 顶部显式 `WEBCODE_PROMPT_STORE_DIR='off'`：该文件的重放
  断言目标就是**内存 rebuild 路径**，落盘读回是另一条（生产）行为，本文件不需要它。
- 删除真实目录里的测试残留 `lost__deepseek.md`。

### ⚠ 生产缺陷候选（更重要，本轮**不修**）

`lib/index.js:3457`：

```js
const rebuildText = (m?.purpose ? null : readSessionPrompt(m.sessionKey)) ?? m.rebuild();
```

- 落盘正本 = 最近一次首轮/整段重建全文，**增量不落盘** ⇒ 真实会话在第 2 轮以后
  丢会话（`WEB_SESSION_LOST`）时，重放读回的是**不含后续增量**的首轮文本；
  而 `commit()` 把游标推到全部消息 ⇒ **增量在网页侧永久缺失**——
  这正是红线二（绝不静默丢上下文）要防的形状。
- 0.19.14 的注释**自己写明了这个失败形态**（对 purpose 轮）：「读回来重放会丢掉
  指令本身（摘要对着错误上文产出），必须走本轮自己的 rebuild()」。purpose 轮已
  绕开读回，**真实轮的同一形状没有绕**。
- 测试为何没抓住：`NODE_TEST_CONTEXT` 守卫让测试环境里 `readSessionPrompt` 恒 null
  ⇒ 护栏永远只测 fallback 分支，**生产首选分支零覆盖**。裸跑撞红反而是它第一次
  被真实执行。
- 修法方向（需要设计轮，未做）：重放源必须含增量——要么恒走 `m.rebuild()`，
  要么读回后拼接 `serializeDelta` 增量段，要么增量轮也落盘。三个候选都要与
  0.16.29「文件投递字节保真」的初衷对表（读回存在的理由就是「发出去什么与重建
  用什么恒为同一份字节」），并配真机验证。同型断言参考
  `test/aux-delta-compact.test.mjs`（purpose 轮不许用落盘正本代替）。

## 39. **错误码在 harness 边界全部退化成 `UNKNOWN`**（2026-10-02 登记，**同轮已修 0.19.54**）

**完整机制、官方对位与证据见**
[`research/2026-10-02-dsh-official-error-and-repair.md`](research/2026-10-02-dsh-official-error-and-repair.md)。
本节记「缺陷是什么 / 怎么修的 / 为什么这么修」。

### 修复（0.19.54，同轮实施）

新增 [`lib/error-codes.js`](../package/dsh-webcode-bridge/lib/error-codes.js) 作为**错误码真源**：

- `webcodeError(message, code, extra)` / `withWebcodeCode(err, code)` —— **不可分割地**
  同时写 `code` 与一个**自洽的** `failure` 快照（`Object.freeze({message, code})`）。
  官方 `ownFailureSnapshot` 的采信条件正是 `failure.code === error.code`，
  两者不一致仍会退化成 `UNKNOWN`（已实测），故把它做成一步、调用方没有机会只改一半。
- **为什么不用 `new LlmError(...)`**（官方推荐路径）：`@deepseek-ai/dsh-llm`
  **不在本仓库工作区**（实测 `ERR_MODULE_NOT_FOUND`），静态 import 会让全部测试文件
  加载失败；且桌面版把宿主打进 `app.asar`，插件解析到的 `dsh-llm` 与宿主内部那份
  **可能不是同一模块实例** ⇒ `instanceof` 跨副本不成立。官方实现自己就为这件事
  留了口子（`adapter-failure.js:17-21` 逐字注释 *Cross-package copies preserve own
  data but not class identity*），自洽快照走的就是这条路，**零新依赖、同步可用**。
- **24 处抛点全部改走真源**（`browser-driver.js` 22 / `index.js` 2 / `think-effort.js` 1 /
  `upstream.js` 3），另把两处「空回复」的**无码**错误对齐成官方的 `EMPTY_RESPONSE`
  （`lib/index.js` 的 `assertNonEmpty`、`lib/zero-progress.js` 的 `emptyWebResponseError`）
  ——该码在官方默认可重试集里，其文档逐字写着「没有产出任何耐久内容，重试安全」。

**`providerRetryPolicy` 从 `undefined` 改为显式策略**（`WEBCODE_RETRY_POLICY`）：
`maxRetries: 1`、`initialDelayMs: 2000`。理由：返回 `undefined` 会用官方 **HTTP** 默认
（5 次 / 500ms 起），而本插件**重试一次 = 再驱动一次浏览器**，代价完全不同。

⚠ **`CONTEXT_WINDOW_EXCEEDED` 刻意不进 `retryableCodes`**（`test/error-codes.test.mjs` ④ 钉死）：
`dsh-base/cordis.patch.yml` 里 `llm-retry`（:91）注册在 `compaction-basic`（:341）**之前**，
waterfall 按注册顺序调用 ⇒ `llm-retry` 一旦命中就**不再 `next()`**
（`dsh-llm-retry/lib/index.js:160`）。把它放进可重试集，超限请求会被**原样重发** N 次，
而**官方的压缩修复永远不会跑**——静默毁掉它。

### 验证（反向变异 + 端到端）

- **端到端**：走**真实** `adapter.stream()` 抛错 → 交给**真实**官方
  `normalizeLlmFailure`，读数 `{"message":"webcode relay: empty response from web AI",
  "code":"EMPTY_RESPONSE"}`（修复前是 `"code":"UNKNOWN"`）。
- **反向变异**（改坏了必须变红）：删掉 `failure` 快照 ⇒ 护栏 **3 条红**；
  把 `CONTEXT_WINDOW_EXCEEDED` 混进 `retryableCodes` ⇒ **1 条红**。逐字还原后 10/10 绿。
- **全量**：121 个测试文件逐文件 exit 0（含新增 `test/error-codes.test.mjs` 10/10）。
- **三个既有护栏初版变红**（`captcha-gate` / `context-budget` / `glm-conversation`）：
  它们是**结构断言停在旧形态**（钉 `err.code = 'X'`）。已改为「断言
  `withWebcodeCode(err, 'X')` **且否定**裸赋值」——判据**收紧**而非放宽。
- **基线可复现**：`node scripts/scan-error-codes.mjs` 输出「本插件错误码存活率」。
  ⚠ **该读数要等新会话产生后才变**（历史会话的 `UNKNOWN` 是既成事实，不会被追溯修复），
  故本次**未**声称基线数字已改善——**只声称机制已接通**（端到端 + 变异验证）。

### 刻意没做（下一轮的候选）

- **码名未对齐官方**：`RATE_LIMITED` 仍是自定名（官方是 `RATE_LIMIT`）。理由写在
  `error-codes.js`：官方退避 500ms 起，而本站限流滑窗以**十秒**计，改过去会让每次重试
  都变成一次真实浏览器投递。`NEED_LOGIN` 同理不映射到 `AUTH`（会让 UI 显示
  「API 密钥无效」，把人引向错误的排查方向）。
- **自建重试未删**：`RATE_LIMITED` 的 10s 下限退避与 `PROMPT_TRUNCATED` 的一次性压缩
  重试都保留。契约要求「不要自己写退避循环」，但**在观察官方 `llm-retry` 真接住之前
  不能删**——那会变成「两条都没有」。
- **未把 `WEB_SESSION_LOST` 的整段重建搬到 `agent/request-error` 扩展点**（结构性改动，
  需单独设计轮）。

### 原始缺陷记录（保留，供对照）

DSH 的 `HarnessError.code` 是**唯一**的机器路由判据
（`dsh-llm/lib/types/error.d.ts:13` 逐字 *route on this, never by parsing `message`*）。
而它的归一化只对 `instanceof HarnessError` 保留码
（`dsh-llm/lib/types/adapter-failure.js:104-107`）：

```js
/** Trust only Harness-owned codes; third-party SDK codes are not our taxonomy. */
function harnessErrorCode(error) {
    return error instanceof HarnessError ? error.code : 'UNKNOWN';
}
```

本插件**从不 import `dsh-llm`**、**从不构造 `LlmError`**，而是给普通 `Error`
挂 `.code`（**24 处**，分布在 `browser-driver.js` / `index.js` / `think-effort.js` /
`upstream.js`）⇒ 全部退化成 `UNKNOWN`。

**实测（2026-10-02，284 份会话全量扫描，`node scripts/scan-error-codes.mjs`）**：

```
终止失败合计 171；code=UNKNOWN 137（80.1%）
  137 条全部归因本插件   ← 137/137，存活率 0.0%
  官方 provider 丢码 0 条  ← 不是 DSH 的问题，是本插件单方面的接口错配
```

**同码对照（最干净的一组证据）**：`CONTEXT_WINDOW_EXCEEDED` 两边都在用，
本插件的落盘成 `UNKNOWN`、官方适配器的**原样保留**——
同一个码名、同一个语义、同一个 harness，只差异常类型。

一条真实会话的原始 JSONL 是决定性证据：消息里写着 `WEB_NO_PROGRESS`，
而 `code` 字段是 `UNKNOWN`：

```json
{"type":"turn/end","seq":278,"data":{"turn":1,"reason":{"kind":"error","error":{
  "message":"WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容…","code":"UNKNOWN"}}}}
```

### 影响

1. **官方自动重试从未生效**：`DEFAULT_RETRYABLE_CODES` 只有
   `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`，本插件没有任何码能进
   ⇒ `llm-retry` 的 `retryableCodes.includes(failure.code)` 恒为假 ⇒ 直接放弃。
2. **官方超限自动压缩修复从未触发**：`compaction-basic` 的订阅判据是
   `failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE`。本插件**确实设了**这个码
   （`lib/index.js:1038`），但到那里已经变成 `UNKNOWN` ⇒ 不匹配 ⇒ 不压缩。
   ⚠ 而 `dsh-base` **已经挂载了** `compaction-basic` / `tool-result-pruner` /
   `image-offload`（`dsh-base/cordis.patch.yml:341,418,427`）——**机制在，只是接不上**。
3. **UI 一律显示 `UNKNOWN`**：`dsh-client-ui-chat/lib/client.js:1302-1305` 把
   `node.code` 渲染成 `<code>` 徽章；`failureMessage()`（`:1219-1224`）只对
   `AUTH` / `QUOTA` / `ACCOUNT_QUOTA` / `ACCOUNT_SIGNED_OUT` / `ACCOUNT_SIGN_IN_REQUIRED`
   做特殊文案，其余原样显示消息 ⇒ 用户看到的是「失败 + 文案 + `UNKNOWN`」。
4. **静默性**：以上三件事**都不会报错**。没有任何日志、没有任何提示，
   只是「本该发生的自动修复没有发生」。

### 为什么现在不修

- **这是行为变更，不是 bug 修复**：让码活下来之后，官方 `llm-retry` 会开始
  **真的重试**，而网页桥的一次重发代价是「再驱动一次浏览器、再等网页吐一轮」，
  **远高于 HTTP 重试**。当前自建的两套重试（`RATE_LIMITED` 站点退避
  `max(发送间隔,10s)×次数`、`WEB_SESSION_LOST` 整段重建）与官方
  `localDelay` 的指数+抖动**语义不同**，切换会改变实际等待时长。
- **码名还没对齐**：`RATE_LIMITED`（本插件）≠ `RATE_LIMIT`（官方默认可重试集）。
  只修异常类型而不改名，`RATE_LIMITED` 仍不会被重试。两步必须一起设计。
- **`NEED_LOGIN` / `MODEL_UI_CHANGED` 该映射到哪仍未定**：映射到 `AUTH` 会让 UI 显示
  「API 密钥无效」，而用户真正要做的是「打开网页登录一次」——**可能比保留自定名更糟**。
  需要先定「这个码要驱动什么行为」，再决定码名。
- 本轮任务是**研究并记录**（用户原话是「需要先学习和记录文档」），不是实施。

### 若要修，从哪下手

**顺序不能颠倒**（先删自建重试 = 两条都没有）：

1. **让码活下来**（收益最大、风险最低）。两条路：
   - 用 `LlmError`：需 `import { LlmError } from '@deepseek-ai/dsh-llm'`，
     并确认它作为 peer 还是 dependency（官方适配器都是 peer）。
   - **零新依赖的逃生口**：挂一个**自洽**的 `failure` 快照
     （`err.failure = {message, code}` **且** `err.code === code`）——
     已实测可通过 `ownFailureSnapshot` 校验。⚠ 两者不一致仍会退化成 `UNKNOWN`。
2. **码名对齐官方词汇表**：`RATE_LIMITED` → `RATE_LIMIT`；
   `empty response from web AI` → `EMPTY_RESPONSE`（官方就是为这个场景定义的码）；
   `WEB_NO_PROGRESS` 是否改报 `TIMEOUT` 待定（进默认重试集 vs 语义精确性）。
3. **观察官方 `llm-retry` 是否真的接住**，再决定自建重试删哪一段。
4. （可选，需单独设计轮）把 `WEB_SESSION_LOST` 的整段重建搬到官方
   `agent/request-error` 扩展点上。

**验收判据（唯一可证伪的）**：`node scripts/scan-error-codes.mjs` 的
「本插件错误码存活率」从 **0.0%** 上升。改前改后各跑一次对照。

## 40. **并发会话的「一组一行」在官方会话清单里做不到**（2026-10-03 登记）

### 现象

用户 2026-10-02 原话（逐字）：

> 「然后是显示会话，明显的一行是3个重叠标签页形状一行区分与普通会话」

意思是：并发会话那几条真会话，在左侧会话清单里希望**表现为一行**（一行里三个重叠的标签页），
而不是三条各自独立的普通会话行。

### 为什么做不到（官方契约，不是能力不足）

0.19.55 起每列是一条**真官方会话**（`ctx.sessions.create()`），它们必然进入官方会话清单。
而清单条目由 **shell 私有代码**渲染（`dsh-client-ui-workspace` 的 `SessionNodeItem`），
插件能用的只有 4 个**装饰既有行**的槽（`sidebar.session.row.leading` / `sidebar.session.row.hover` /
`sidebar.workspaces.session.menu.item` / `sidebar.workspaces.session.row.action`），
**没有**「新增一行」「把多行合并成一行」「自定义分组」的入口。
唯一能减少行数的杠杆是 `ctx.workspaces.archiveSession()`（归档行默认不显示），
但它 ① 改变会话语义（归档 ≠ 分组）、② 在轮次进行中会被拒。

### 这不是「没做」，是「做成了另一副样子」

在**左栏面板行**（`sidebar.panellist` 的「并发会话」）上画了「三个重叠的标签页」图标，
让这一行一眼区别于普通会话行——它代表的确实是一个**会话组**而不是一条会话。
清单**内部**的分组未做，也不假装做了。

### 若要继续，从哪下手

1. 先确认 `ctx.workspaces.archiveSession()` 是不是唯一杠杆、归档会不会影响会话可用性；
2. 若可接受，可在建组时归档成员会话，让清单只剩一条「并发会话」面板行——
   **但那会把「能够查看」变成「只能从面板查看」**，与用户上一句「并发必须能够保留真实会话！
   能够查看！」存在张力，须由用户拍板，不能替用户决定；
3. 另一条路是给清单行加装饰（第一行显示「+2」、hover 展开），但它不改变「占三行」这个事实。


## 41. **CI 在 `main` 上长期恒红**（2026-09-26 起；2026-10-03 登记，**同轮已修**）

### 现象

`CI / test (windows-latest, node 22|24)` 自 2026-09-26 的 `chore(release): 0.19.27` 之后**每轮都红**，
且每次失败的是**同一组**用例。最近一次绿是 `36244903186 chore(release): 0.19.27 对外文案英文化`。

### 五条都是**判据/环境**问题，不是产品行为

> 修的过程中分**两批**发现：第一批是 CI 日志直接点出的三条（①②③），修完推上去之后
> CI 又红，才暴露出第二批两条（④⑤）——它们此前**被前三条的噪声盖住了**：整套 `pnpm test`
> 在同一个进程里跑，前面红了后面的读数就不再被人细看。这也是「一次只修一条、修完再看」
> 比「一次性猜完」更可靠的原因。

1. **profile 建在被 gitignore 的目录里**（`site-prompt-transport.test.mjs`）。
   它把 profile 建在 `package/dsh-webcode-bridge/.tmp/` 下，而 `.tmp/` 在 `.gitignore` 里、
   **干净 clone 根本不存在** ⇒ `mkdtempSync` 直接
   `ENOENT: ...\.tmp\siteprompt-cp-XXXXXX`，把 ④ / ⑥a / ⑥b / session-import 四条一起判红。
   开发机上一直绿，只是因为包目录里恰好堆着历史 `.tmp/**`。
2. **拿两种规范化程度的路径互比**（`column-fs.test.mjs`）。
   断言是 `isPathUnder(writeColumnArtifact(...), columnRootOf(...))`：左边是**规范化后**的路径
   （`canonicalWithMissingTail` 会解析符号链接、把 Windows 的 8.3 短名展开成长名），右边只做词法拼接。
   CI 的临时目录是 `C:\Users\RUNNER~1\AppData\Local\Temp`（带 8.3 短名）⇒ 必然为假；
   本机 temp 没有短名 ⇒ 不复现。**这条只在 CI 红、本机永远绿**，最难自己发现。
3. **量了一个与问题无关的量**（`pre-deliver-window.test.mjs` ①b）。
   它用「两轮**整轮墙钟**之差」证明「发送间隔真的生效」，但默认基准 `end-to-start` 是从上一轮
   **生成结束**起算的，而「生成结束 → 本轮提交」之间还夹着驱动的稳态收尾（实测约 1.2s），
   那段时间先吃掉一部分间隔 ⇒ 墙钟之差 ≈ gap − 1.2s，**且差多少取决于机器**。
   CI 实测 `4302ms vs 1514ms`（差 2788 < 断言的 3000）。
4. **把 POSIX 路径削成了相对路径**（`column-fs.test.mjs` 的另一条用例「三跳齐全：POST chat
   必须落盘…」）。它用 `new URL(import.meta.url).pathname.slice(1)` 拼源码路径——那个
   `.slice(1)` 是「Windows 上削掉盘符前多出来的斜杠」的补丁，在 POSIX 上却把
   `/home/runner/...` 削成 `home/runner/...`（**相对路径**）⇒ ubuntu 腿直接
   `ENOENT: open 'home/runner/work/.../lib/web-control.js'`；Windows 腿恰好正确，
   所以这条也是**只在 CI 红、本机永远绿**。
5. **断言依赖「装了 DSH 的机器」才有的目录**（`site-mount.test.mjs` 的
   「白名单内 + 存在 ⇒ 放行」那条）。它用 `path.join(os.homedir(), '.dsh')`，
   而 CI runner 上**没有** `~/.dsh` ⇒ 先撞「源 profile 目录不存在」分支，`ok` 变 false。
   （这条在**两条腿上都红**——ubuntu 与 windows runner 都没装 DSH。）

### 修法（五步各一处，产品代码零改动）

1. 先 `fs.mkdirSync(tmpRoot, { recursive: true })` 建父目录——保留「profile 落在包内 `.tmp`」的原语义，
   只补上缺的前置条件（**不**改用 `os.tmpdir()`，免得把语义一起改掉）。
2. 两边都先 `canonicalWithMissingTail()` 再比。`columnRootOf()` 的契约本来就只做词法拼接，产品无需改。
3. ①b 改用 `send-to-send` 基准 + **两次投递的时刻差**（`driver.calls`）：`send-to-send` 从上一轮
   **发出**起算（`rememberSend` 就在投递前一刻），所以 `calls[1] − calls[0] ≥ gap` 恒成立、
   与机器快慢无关；gap=0 时该差值只剩驱动自身耗时。基准语义本身由 `test/send-gap-basis.test.mjs` 钉住。
4. 改用 `fileURLToPath(import.meta.url)`——Node 的跨平台正解（本文件其它用例早就这么写）。
5. 把源目录换成**本包树**（`permittedImportRoots` 的第三个根，见 `lib/web-control.js:81`）：
   断言含义一字未变（白名单内 + 真实存在 ⇒ 放行且原样透传站点 id），但不再要求机器上装过 DSH。

### 反向验证（证明判据不是空转）

- ① 还原旧写法 + 把 `.tmp` 挪走 ⇒ **3 红**，报错逐字与 CI 日志相同；
- ② 还原「未规范化比较」+ 把 `TEMP` 指到 8.3 短名目录 ⇒ 精确复现那条红（另用真实短名探针亦复现）；
- ③ 把 large 轮次的 `gapMs` 改成 0（= 间隔没生效）⇒ ①b **1 红**；
- ④ 逐字演示旧表达式在 POSIX URL 上的读数：`new URL('file:///home/runner/…').pathname.slice(1)`
  → `home/runner/…`（相对路径，丢掉了前导斜杠）——这就是 ubuntu 腿那条 `ENOENT` 的成因；
- ⑤ 该条断言的「before」就是 CI 日志本身（两台 runner 都红、本机绿），修后本机 7/7；
- 全量：121 个测试文件逐文件 exit 0；三条修好后逐字还原，各自回到绿。

### 为什么值得单列成一条

「假红的闸门比没有闸门更坏」是本仓库写进 `doc/comment-style.md` 的立场，而这次红的是**全量单测**
这一步——它对任何人都恒红，于是所有人都学会了忽略它。修它不是在「让 CI 变绿」，
而是**把这一步的信号重新接通**。

## 42. **「网页桥接」设置分区的导航图标不可自定义**（2026-10-03 登记，本轮**不修**）

### 现象（用户原话）

用户 2026-10-03：「设置界面左侧：『账号与余额 / 通用设置 / 模型 / 内置插件 / Agent 预设 /
通知 / Jet Hub / 网页桥接 / 壁纸引擎』栏目中，**没有设置好网页桥接的图标，仍然是默认齿轮**」。

### 真因：字形表在官方壳里，且注册契约里没有 icon

取证（本机 app.asar 内 `@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`）：

```
/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id) {
  if (id === "account") ...
  if (id === "models") ...
  if (id === "agent-presets") ...
  if (id === "plugins") ...
  if (id === "archived-sessions") ...
  return <IconSettingsOutlineMedium/>;   // ← 其余一律齿轮
}
...
children: [navIcon(row.id), <span>{row.label}</span>]
```

也就是：导航行的图标**只由 `id` 决定**，而 `id` 是我们注册分区时给的字符串（本插件给的是
`webcode`）。同时 `settings.section` 的**注册契约**只有三个字段：

| 字段 | 类型 | 必需 |
| --- | --- | --- |
| `id` | string | 是 |
| `order` | number | 否 |
| `label` | string \| (() => string) | 否 |

（由本机 client Slot 检查器现读：`Slots/listSubTree(root: "settings.section")`。）

因此插件**没有任何合法途径**给这个分区挂图标。注意：**这不是本插件漏做**——
`general`（通用设置）、`notifications`（通知）、`jet-hub`、`wallpaper-engine` 这些 id
同样不在那张表里，它们**也**是齿轮。

### 为什么不在本轮「想办法」修

- 改官方包（`app.asar` 里的 `client.js`）会在下一次 DSH 更新后被整体覆盖，
  且属于修改宿主，不在本插件的产品边界内（本插件只增加路由与界面插槽）；
- 占用一个 shipped 的 id（如 `plugins`）会**替换**官方那一个分区，代价远大于一个图标；
- 在客户端半用 DOM/CSS 观察把那一颗齿轮换成 dwb 标记属于**非官方补丁**：
  它依赖官方壳的类名与渲染时序，DSH 一改版就会静默失效或错位——本仓库对
  「静默失效」的立场是宁可如实不做。

### 若官方以后支持，从哪下手

1. 先查 `settings.section` 的注册契约是否新增了 `icon`（官方包与 Slot 检查器都能现读）；
2. 若新增，在 `lib/client.cjs` 的 `settings.section` 注册处补 `icon: DwbMark`
   （标记组件已存在，就是右栏 guide 与标签标题在用的那一个）；
3. 补一条 `test/client-render.test.mjs` 断言，把「分区注册带图标」钉住。

## 43. **deepseek 与 z.ai 的账号昵称在驱动页面上读不到**（2026-10-03 登记，本轮**不修**）

### 真机读数（证据文件在 `test-mock/out/`）

同一批活页面取证（`node test-mock/probe-account-identity-live.mjs`）：

| 站点 | 昵称读数 | 昵称候选 | 头像读数 | 头像候选 |
| --- | --- | --- | --- | --- |
| deepseek | null | **0 条** | 有（`static.deepseek.com/user-avatar/…`） | **0 条** |
| zai | null | 1 条（`span.svelte-rfjy4c` = "API"） | 有（`avatars.githubusercontent.com/…`） | 3 条（最优那条 `rect.x = -12`） |

### 两条**不同**的成因（不要合成一条）

- **deepseek**：语义子树里没有任何合格叶子 ⇒ 账号区存在但**不可见/未展开**
  （`getBoundingClientRect` 为 0 或侧栏折叠）。注意 `readAccountIdentity` 的 `srcOf`
  **不判可见性**，所以它照样读到了头像 URL —— 这解释了「头像有、昵称没有」的不对称。
- **z.ai**：侧面证据是**负坐标**（`rect.x = -12`，侧栏在视口外）⇒ 同样是折叠态；
  且它是 Svelte 生成的哈希类名（`svelte-*`），选择器天然脆。

### 为什么本轮不修

本站纪律是「**没有真机读数不许编选择器**」。这两站此刻**读不到昵称节点本身**
（不是「读到了但选错」），凭印象补一个 CSS 等于把猜测写进真源。两条可行出路（择一，都要先有读数）：

1. **先让账号区可见**再取证：探针按站点加一个「展开侧栏」的只读前置动作（当前探针严格只读、不点击，
   所以这条要先改纪律边界并取证「点这一下确实只是展开」）；
2. **把读取改成结构感知**：以**头像为锚**（头像总是读得到），读它所在那一行的文本作为昵称——
   这要把 `accountProbe` 从「一串 CSS」升级成「锚 + 取文本策略」，属于契约变更，需要单独的护栏与反例。

### 边界

本条目**只**覆盖 deepseek 与 z.ai。glm（`p.sidebar-user-name`）、kimi（`span.user-name`）、
doubao（`span.min-w-0.overflow-hidden.text-left`）三站已有真机读数并已声明 `accountProbe`。

---

## 44. **「检查更新」恒报「已是最新」：仓库没有跟上 `package.json` 的 tag**（2026-10-04 登记）

### 现象与读数

设置页点「检查更新」永远显示「已是最新」，**不是**因为它检查错了，而是因为
**GitHub Releases 上确实没有比当前更新的版本**：

| 事实来源 | 读数（2026-10-04） |
| --- | --- |
| `package/dsh-webcode-bridge/package.json` 的 `version` | **0.19.60**（本轮改到 0.19.61） |
| 本机 `git tag --sort=-v:refname` 最新 | **v0.19.55** |

于是 `updateDecision` 的比较是 `latest(0.19.55) < current(0.19.60)` ⇒ 判据给出
「已是最新」。**这个判据本身是对的**（`lib/update.js` 用真 semver 比较，优于
`dsh-store` 那种字符串不等判定——后者在本机已把 0.19.60 判成「可更新到 0.19.51」，是**降级**）。

### 真因

`release.yml` 的触发条件是**打 tag**（`on: push: tags: v*`），流程里还会校验
`tag == v + package.json.version`。而 0.19.56–0.19.61 这几轮**只改了 `package.json`
没有打 tag** ⇒ Releases 上最后一个是 0.19.55，中间 5 个版本从未产出 tarball。

### 为什么本轮不修

发版是**不可逆的对外动作**（会在 GitHub 上产生公开 Release 与 tag），且本轮尚未
由用户确认要发。按本项目「交付动作要用户点头」的惯例，登记而不代做。

### 出路（用户点头后一条命令）

```powershell
git tag v0.19.61 && git push origin v0.19.61
```

推上去后 `release.yml` 会产出 tarball 挂到 Release，更新检查随即能报出真实的新版本
并装上。**注意顺序**：tag 必须打在 `package.json` 已是 0.19.61 的 commit 上，
否则工作流第二步的「tag 与 version 一致」校验会直接失败。

### 边界

本条目只讲「Releases 上没有新版本可装」。它与 0.19.61 修掉的两件事**不是**同一件事：
① 缓存里存判据且缺 `current` ⇒ 版本位渲染成空「v」（**已修**）；
② `profile` 名取成了浏览器数据目录名 ⇒ 安装命令指向不存在的 profile（**已修**）。
本条是第三个、**纯仓库流程**的缺口。

---

## 45. **桌面 profile 的声明与磁盘分叉（0.19.63 客户端已热换，声明仍钉 0.19.61）**

（2026-10-05 登记。与本文件其余「有意不修」的条目不同：**这一条是必须收口的欠账**，
只是收口动作需要用户给一个「完全退出桌面端」的窗口，本轮不擅自触发。）

### 现状与读数

| 层 | 值 | 取证 |
| --- | --- | --- |
| 桌面 profile 声明 | `file:D:/9_Code_Workspace/dsh-webcode-bridge/package/dsh-webcode-bridge/dsh-webcode-bridge-0.19.61.tgz` | `~/.dsh/profiles/desktop/package.json` |
| 桌面端磁盘上的客户端产物 | 0.19.63 的 `lib/client.cjs`（483,339 B / `B5ADC88A…`） | 文件实读 |
| 桌面端磁盘上的宿主产物 | **仍是 0.19.61 的 `lib/index.js`**（本轮没换，也不需要换：修的是客户端） | 同上 |
| 运行中宿主实读 | `build.version = 0.19.61`（`GET :8932/__webcode/status`） | 客户端热换不改宿主 |

### 本轮为什么这样处理（而不是直接装）

1. `dsh`（npm 全局 0.2.0-rc.2）**拒绝管理 desktop profile**：
   `error: profile "desktop" is managed exclusively by the Electron application`；
   官方说明要求**先把应用完全退出**再 `dsh plugin --profile desktop add <spec>`。
2. 用户本轮明令「不要影响桌面端」——退出应用属于影响，故**不擅自做**。
3. 客户端产物可以经官方 `client-hmr` 通道**原地覆盖热换**（§5.1 的姿势），
   于是「立刻可用」与「不打扰用户」两件事可以同时成立。

### 风险（不是理论，本仓库记过同族事故）

声明与内容分叉时，**判据永远是声明**：任何一次走 pnpm 的通道
（应用内插件管理器装/卸别的插件、启动期 reconcile）都会按声明重建 `node_modules`，
把客户端**静默换回 0.19.61** ⇒ 用户重新看到「面板一片空白」，而磁盘上「明明是新版」。

### 收口动作（等用户给窗口，一条命令 + 重开应用）

```powershell
# ① 用户完全退出 DeepSeek Harness（含托盘）；确认进程表里没有它
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue

# ② 用**桌面端自己的 carrier** 装（它带 manageDesktopProfile=true 与自带 pnpm）
$asar = 'D:\2_Download_Main\4_DeepSeek Harness_code\resources\app.asar'
$env:ELECTRON_RUN_AS_NODE = '1'
& 'D:\2_Download_Main\4_DeepSeek Harness_code\DeepSeek Harness.exe' --expose-internals `
  "$asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" `
  plugin --profile desktop add 'D:\9_Code_Workspace\dsh-webcode-bridge\package\dsh-webcode-bridge\dsh-webcode-bridge-0.19.63.tgz'

# ③ 核对三层一致（声明 / lockfile / 磁盘版本）
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Pattern 'dsh-webcode-bridge'
(Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-webcode-bridge\package.json" | ConvertFrom-Json).version

# ④ 重开应用，核对：/plugins/events 的图 rev 已变，且 /__webcode/status 的
#    build.version 也应变成 0.19.63（这次换了宿主半边所在的包目录，重启即生效）
```

### 边界

- 只换客户端产物**不会**改 `build.version`——它**不是**「没生效」的判据；
  判据是图 rev + 按该 rev 取回的字节与磁盘逐字节相同（见
  [`research/2026-10-05-dsh-multi-session-and-client-hot-swap.md`](research/2026-10-05-dsh-multi-session-and-client-hot-swap.md) §5.1）。
- 热换只许**原地覆盖**：`Move-Item -Force`（删除+改名）会让 `clientModules` 拒绝为新内容
  重建响应（该 rev 及之后全部 404，实测）。恢复 = 把旧字节原地写回。
