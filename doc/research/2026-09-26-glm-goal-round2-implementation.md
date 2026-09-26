# GLM 六问 · 第二轮报告（实施 + 验证，0.19.19 / 0.19.20）

> 第一轮报告见 [`2026-09-26-glm-goal-round1-investigation.md`](2026-09-26-glm-goal-round1-investigation.md)（只调查、零改动）。
> 本文是**第二轮**：把第一轮列的待办**真的改掉**，并给出读数。
> 全部改动**只增不改**、版本仍在 **0.19.x**（用户 R5 的硬约束）。
> 工作树：`package/dsh-webcode-bridge`。

---

## 一、本轮改了什么（逐文件）

| # | 文件 | 改动 | 对应问题 |
| --- | --- | --- | --- |
| 1 | `lib/providers.js` | **新增 `answerSelector` 字段**：GLM / Z.ai 各声明一条站点专属助手节点选择器 | Q6-#1（审计 C1） |
| 2 | `lib/contract.js` | `genericContract` 投影 `answerSelector`（缺省 `null`） | 同上 |
| 3 | `lib/browser-driver.js` | `createBrowserDriver` 内一次求值 `answerSelector = contract.answerSelector \|\| ANSWER_SELECTOR`，**三处消费点共用**；注释补「0.19.19 兑现了那句承诺」 | 同上 |
| 4 | `lib/web-control.js` | `POST chat` **新增 `quote` / `quoteFrom`**：拼成 `> ` 块引 + 4000 字符截断 | Q2「完整实现引用会话内容」 |
| 5 | `lib/client.cjs` | 并列多会话：**删除共享底栏 / `handleSendAll` / `pendingRef` / 全局 `sending`**；改为**每列一个对话框**；新增**主审列**与**跨列引用槽** | Q5 + Q2 |
| 6 | `lib/client.cjs` | CSS：删 `.hwb-compare-input-bar`，加 `.hwb-compare-col-input` / `.review` / `.hwb-quote-bar` / `.hwb-chat-head` / `.hwb-chat-text` | Q5 + Q6-UI |
| 7 | `test/team-compare.test.mjs` | 两条旧判据按新结构改写；**新增三条 0.19.20 判据**（独立对话框 / 跨列引用 / 主审唯一） | 交付纪律 |

---

## 二、Q5 实施细节：三个独立对话框 + 主审 + 沙箱

### 2.1 删掉的四样东西（以及为什么）

用户原话（逐字）：「**移除『并列多会话』里面的同时发送功能**，然后尽可能将底部对话框变为三个，
按照 dsh 风格分隔会话，3 者独立，但是考虑做好沙箱适配……怎么做到**选定一个模型进行主要审查**？
怎么选定模型进行**同时互不影响的方案探索**」。

| 删掉 | 它的职责 | 为什么必须删 |
| --- | --- | --- |
| `handleSendAll` | 一个共享输入条发给所有列 | 它**就是**「同时发送」 |
| 共享 `prompt` state | 三列共用一个输入值 | 三列没法各自输入，与「三个独立对话框」直接冲突 |
| 全局 `sending` state | 共享发送按钮的锁 | 「一列在跑 = 全体发不出去」，与「互不影响」直接冲突 |
| `pendingRef` 计数器 | 判「全体都回来了」才解锁 | 共享按钮没了，就没有「全体」这个概念 |

**一个额外收益**：0.19.0 修过的那个阻断级缺陷（「三列都显示已完成、发送按钮却永远锁在
『发送中…』」）在**结构上**不可能复发。当时的修法是「用计数器，记得在 `finally` 里减」——
那是**纪律**；现在每列的锁由那一列自己的 `status === 'streaming'` **派生**，没有跨列共享的
可变量——那是**结构**。纪律靠人记得，结构不用。

### 2.2 每列的对话框

```
hwb-compare-col
  ├── hwb-compare-col-head     站点选择 / 状态 / 设为主审 / 移除
  ├── hwb-compare-session      会话身份（可核对续在哪条会话上）
  ├── hwb-compare-col-body     消息流（可滚动）
  │     └── hwb-chat-msg       每条助手回复带「引用」按钮
  └── hwb-compare-col-input    ★ 本列自己的对话框（贴底）
```

- 用 `form` + `onSubmit` 而不是裸 div：回车提交是用户对输入框的默认预期，
  而 `form` + `onSubmit` 是唯一**不依赖键盘事件细节**的做法。
- 提交目标逐列固定：`onSubmit: (e) => { e.preventDefault(); sendCol(c.key); }`。
  护栏直接断言这一行 —— 提交到一个全局函数就是共享输入条的回潮。

### 2.3 主审 vs 探索（用户的第二问）

- 每列有 `role: 'review' | 'explore'`，**全局恰好一个 `review`**（初始即 c1）。
- 非主审列上有「设为主审」按钮；`setReviewCol` 把其余列一律降为 `explore`。
- 头部实时显示「主审：<站点名>」，用户一眼看出审查落在哪个模型上。
- 为什么必须唯一：三份并列的审查意见**等于没有审查**。

### 2.4 沙箱适配（同一文件并发思考/修改）——**0.19.21 已交付可落地的那一半**

用户问的是「可能对于同一文件进行思考/修改，怎么做到……互不影响」。

**先说边界，不含含糊**：本插件**只做约定，不做拦截**。模型发起的 `edit` / `pwsh` 调用由
**Harness 的工具执行器**落地，那条链路上**没有本插件的插槽**。要在文件系统层真的拦住
「探索列不许写主工作树」，必须在 `provider → adapter → 工具调用元数据` 全链把列身份带下去，
再由工具执行器按列改写 `workdir` / 拒绝越界写——那是**跨层改造**，不是本插件单方面能完成的，
也超出用户「先保证 0.19.x 不变 / 不要动别的模型实现根基」两条约束。

**再说交付了什么**（新模块 [`lib/column-context.js`](../../package/dsh-webcode-bridge/lib/column-context.js)，0.19.21）：

| 落点 | 做什么 |
| --- | --- |
| 列身份随请求下发 | `lib/client.cjs` 的 `sendCol` 每轮带 `columnContext: { role, key, index, total }` |
| 渲染成一段**工作区约定** | `POST chat` 调 `withColumnGuidance(prompt, body?.columnContext)` 拼进 `promptText` |
| 探索列 | 产出写 `<workspace>/.hwb/cols/<列键>/`，**不要直接修改主工作树** |
| 主审列 | 职责是**汇总与裁决**：给出统一结论、指出彼此冲突、说明采信哪条为什么 |
| `.gitignore` | 新增 `.hwb/` 规则（探索列草稿是运行期产物，不是源码） |

三条设计纪律（都有护栏）：

1. **不认识就不认**：角色不在 `['explore','review']` 里一律返回 `null`，**绝不猜**。
   猜错角色（把探索列说成主审）会让模型按错误职责行事，而用户从界面上看不出来——
   错的身份比没有身份危险得多。
2. **不撒谎**：拼出来的文本必须写明「这是**工作区约定**，不是强制隔离；真正的文件权限
   仍由 Harness 的工具权限与审批决定」。本项目一贯不许把约定说成隔离。
3. **短、可执行、不夹带协议教学**：十来行、给的是路径与动作（不是「请注意隔离」这类
   无法落地的要求），且**不重复**工具协议教学——那是首轮教学的事，两者会打架。

护栏 [`test/column-context.test.mjs`](../../package/dsh-webcode-bridge/test/column-context.test.mjs) **6/6**，
并做过**反向验证**：把 `sendTurn(sessionKey, promptText,` 变异回 `sendTurn(sessionKey, prompt,`
（即「拼了却发原串」这个本项目记过多次的病）→ **判据必红**；还原 → 绿。

**仍未做（明确留给下一轮）**：文件系统层的**真拦截**（列级 `workdir` 改写 + 越界写拒绝）。
它需要上面那条跨层改造，`lib/column-context.js` 的文件头把这条论证写全了，
下一轮要动手时从那里读起。

---

## 三、Q2 实施细节：会话内容引用

用户原话：「**请你完整实现引用会话内容**」。第一轮查明：**只有一半**——
任务板批注能带正文片段（`POST task-implement` 的 `quote`），而**会话消息级**引用整条缺失。

本轮补上另一半，分两跳：

| 跳 | 位置 | 做什么 |
| --- | --- | --- |
| ① 前端 | `lib/client.cjs` | 每条**已完成**的助手回复上有「引用」按钮 → 写入**全局**引用槽 → 引用条显示「待引用「Kimi」：…」→ 发送时随 `quote`/`quoteFrom` 下发，**用掉即清** |
| ② 路由 | `lib/web-control.js` `POST chat` | 把引用拼成 `引用会话内容（来自「X」的回复片段）:` + `> ` 块引，**再拼用户本轮的话**，然后才 `sendTurn(sessionKey, promptText, …)` |

三个设计决定与理由：

1. **引用槽是全局的，不是列对象的字段**。挂在某一列里就传不到别的列——
   而「探索列 → 主审列」正是这次三框设计要的那条通路。护栏直接断言这一点。
2. **用掉即清**（`const q = quote; setQuote(null);`）。隐式延续的状态是最难排查的一类：
   用户会看到下一轮莫名其妙又带上同一段引用，而界面上没有任何线索说明为什么。
3. **必须有长度上限**（`QUOTE_LIMIT = 4000`，截前保尾）。引用整条长回复会把上下文预算
   瞬间吃掉——GLM 声明 1M，一次长引用就顶掉大半，而用户的意图通常只需要被指着的那句。
   截断标记写在引用内部（`…（引用过长，此处已截断）`），**不静默截**。

格式刻意与 `task-implement` 的既有引用**同源**（都是 `> ` 块引 + 一行出处）：
一条事实只写一处语义，两处引用格式不同会让模型面对两种「引用」先验。

---

## 四、Q6-#1 实施细节：`answerSelector` 契约

第一轮审计的 C1：`ANSWER_SELECTOR` 是**唯一一处**「站点选择器写死在驱动里」的地方，
而它服务全部 10 个站点；`browser-driver.js` 的注释以「契约层（`providers.js` 的
`answerSelector`）」为前提，但 `grep` **零命中**——声明与实现不同步。

本轮按审计的建议**最小实现**：

```
providers.js   GLM / ZAI 各加一条 answerSelector（站点专属）
contract.js    genericContract 投影成 contract.answerSelector（缺省 null）
browser-driver.js
               const answerSelector = contract.answerSelector || ANSWER_SELECTOR;
               ↑ 一次求值，三处消费点（WIP 巡检采样 / 超时现场）共用
```

**为什么是纯增量**：没声明 `answerSelector` 的 8 个站点走到的仍是逐字相同的那份
DeepSeek 串。所以这是一条**只有上行空间**的改动。

**⚠️ 诚实标注**：GLM / Z.ai 那两条选择器串**尚未取得有效真机命中读数**。
2026-09-26 想复采时，裸 playwright 深链导航被 chatglm.cn 的**阿里云滑块**拦住
（页面 title 变成「滑动验证页面」，DOM 里只有 `capture-container` / `aliyunCaptcha-*`），
所以第一轮 §三 C1 里那批「count 全为 0」的读数**不能**用来判定选择器好坏——
取证条件不成立（第一轮 §4.3 已作诚实修正）。

但它**不会比现状更差**，原因是判据是**三态**的：

| 情形 | 结果 |
| --- | --- |
| 命中 | `domFound = true`，DOM 巡检拿到真实读数（比今天好） |
| 不命中 | `domFound = false` → 走 `DOM_BLIND_MS` 宽窗（**与今天逐字相同**） |

即：它要么更好，要么不变。**真正的验收仍是「驱动路径下的节点计数」**，
那条探针（打开站点首页 + 正常发消息，实测不受滑块影响）留给下一轮。

---

## 五、Q3 复述：为什么还会看到 `"mcp_action": "call"…` 原文

第一轮给过三种来源，本轮**没有新增**改动（0.19.17 的围栏泄漏修复已在盘上）。复述结论：

1. **未解析调用 + 强制重发**（主源）：桥判 `TOOL_CALL_UNPARSED` → 重发提示把**被扣原文开头**
   原样交回 → 会话里留下「残缺原文 + 重发的新调用」。0.16.29 起提示只作补发。
2. **思考流透传**：GLM 网页版强制思考，桥把 thinking 全文外发；模型在思考里打草稿/复读调用 JSON。
3. **围栏窗口泄漏**（0.19.17 已修）：围栏刚开、JSON 头未到的窗口里外发边界只剩 8 字符尾随，
   于是 ` ```json\n{"mcp_actio ` 逐字符进正文。

**第四种、也是本轮亲历的一种**：用户消息里的 JSON 块（`{"mcp_action": "call", …}`）
是**用户自己贴进来的**历史会话原文。它出现在会话里不是桥的缺陷，而是用户在引用取证材料。
**判据**：看它是「助手回复块」还是「用户消息块」——前者才是桥的问题。

---

## 六、验证读数（本轮）

| 命令 | 结果 |
| --- | --- |
| `node --test test/team-compare.test.mjs` | **12/12 PASS**（含三条新增 0.19.20 判据） |
| `node --test test/client-render.test.mjs test/hooks-order.test.mjs test/control-routes.test.mjs test/regression.test.mjs` | **128/128 PASS** |
| `node --test test/*.test.mjs`（全量） | **1064/1064 PASS，fail 0** |

---

## 七、仍未完成（明确留给下一轮）

| # | 待办 | 为什么现在不做 |
| --- | --- | --- |
| 1 | **GLM 助手节点选择器的真机命中读数**（走驱动路径采样） | 需要真机 + 登录态；本轮把声明与消费点都铺好了，缺的只是读数 |
| 2 | **列级工作区沙箱的文件系统层真拦截**（按列改写 `workdir` + 拒绝越界写） | 0.19.21 已交付**约定**那一半（列身份 → 提示词 + `.hwb/` 忽略规则）；真拦截需跨层改造（provider → adapter → 工具元数据），见 `lib/column-context.js` 文件头 |
| 3 | **新开 DSH 真机实例、用非本会话模型跑 E2E** | 需要重启 `dsh web` 才会加载新版本；本轮交付物是 tgz + 安装步骤 |

---

## 八、交付（已打包 + 已安装）

| 项 | 值 |
| --- | --- |
| 版本 | **0.19.20**（仍在用户要求的 0.19.x 内，未升 0.20） |
| tarball | `dsh-webcode-bridge-0.19.20.tgz`（仓库根 + `package/dsh-webcode-bridge/`） |
| 打包核对 | `node scripts/verify-pack.mjs` → **逐字相同 47/47**、接线完好、tarball 与工作树一致 |
| 装入 web profile | `dsh plugin --profile web add <tgz>` → `node_modules/dsh-webcode-bridge/package.json` 实测 **0.19.20** |
| 装入 headless profile | 同上 → 实测 **0.19.20** |
| 声明同步 | 两个 profile 的 `dependencies.dsh-webcode-bridge` 均指向 `file:D:/9_Code_Workspace/dsh-webcode-bridge/dsh-webcode-bridge-0.19.20.tgz` |

**用户必须做的一步**：**重启 `dsh web`**。安装只换了磁盘上的文件，正在跑的进程里还是旧代码 ——
这是本项目反复记过的一条（「装完不重启 = 等于没装」）。

## 九、闸门读数（本轮实测）

| 闸门 | 命令 | 结果 |
| --- | --- | --- |
| 全量单测 | `node --test test/*.test.mjs` | **1064/1064 pass，fail 0**（exit 0） |
| Team 护栏 | `node --test test/team-compare.test.mjs` | **12/12** |
| 渲染 / hooks / 路由 / 回归 | 四文件联跑 | **128/128** |
| 注释纪律 | `lint-comments` | PASS |
| 台账一致性 | `check-ledger` | PASS（版本已同步为 0.19.20） |
| 仓库卫生 | `check-repo-hygiene` | PASS |
| 生成物卫生 | `artifacts-check` | PASS |
| 基准离线回放 | `bench-offline` | PASS（21/21） |
| **reference 来源表** | `gen-reference-index --check` | **FAIL（既有问题，非本轮引入）** —— 见下 |

### 关于 `ref-index` 这一红（如实说明）

`reference/README.md` 的「来源表」段里**没有** `puppeteer-stream` 与 `steel-browser` 两行，
而这两个目录在磁盘上。三点事实：

1. **不是本轮引入**：`git status reference/README.md` **无输出**，`git diff --stat reference/README.md`
   **无输出** —— 本轮的 14 个改动文件里不包含它。
2. **生成器写入不生效**：`node scripts/gen-reference-index.mjs --write` 打印了完整表格，
   但重新 `--check` 仍是同一对条目不一致 ⇒ 写入路径没有落到 README 的**表格段**。
3. **不影响本插件**：它是 `reference/`（只读参考资料）的索引卫生闸门，与 `lib/` 运行时代码无关。

本轮**不动它**：修一个与本轮交付无关、且成因在生成器写入路径上的既有闸门，
会让「本轮改了什么」这件事变模糊。已如实记录，留给下一次专门处理。

— 第二轮报告完 —
