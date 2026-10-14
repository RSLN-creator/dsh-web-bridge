# AGENTS.md — 给 AI 协作者的第一条指令

你正在 `dsh-webcode-bridge`（DSH 插件，把十个网页 AI 接成 LLM provider）。
动手之前，先做下面这件事。

---

## 0. 会话纪律（用户 2026-10-03 明令；先读这一条，再读别的）

**0.1 会话开始：先提问确认意图，再动手。**

任何一轮会话的第一件事**不是**读代码、不是改文件，而是把「我理解你要我做什么」
写成一段可核对的话（逐条复述 + 我打算怎么改），向用户提问、**等他选择或确认**
之后才开始操作。宁可多问一句，也不许带着可能错误的理解开工——理解错了，
后面所有工作都是白做，而且会在错误的实现上继续加东西。

**0.2 会话结束：记录用户原话。**

每一轮工作收尾时，重新生成用户原话记录：

```powershell
cd D:\9_Code_Workspace\dsh-webcode-bridge
node scripts/user-voice-log.mjs        # 重新生成 doc/user-voice-log.md
```

`doc/user-voice-log.md` 是**脚本生成**的（文件头已写明「不要手改」），
因此「记录原话」这个动作就是**重跑脚本**，不是手写追加——手写会被下一次重跑
抹掉，且与 `doc/user-voice-log.json` 的口径分叉。

---

## 1. 先读 `wiki/`（本机索引，回答「在哪、动谁」）

按这个顺序，**全部都很短**：

| 文件                     | 你得到什么                                                 |
| ------------------------ | ---------------------------------------------------------- |
| `wiki/README.md`       | 项目是什么、目录地图、三个找东西的动作                     |
| `wiki/protocol.md`     | **硬约束**（下面 §2 是摘要，细则在那里）            |
| `wiki/architecture.md` | 分层、数据流、provider/分组、三条红线                      |
| `wiki/modules.md`      | **53 个模块**的一句话角色 + 导出符号行号（自动生成；数字以 `gen-index --check` 为准） |
| `wiki/tasks.md`        | 常见改动（加站点 / 网页改版 / 加护栏 / 改协议）的配方      |
| `wiki/glossary.md`     | 账户槽、车道、兼容空壳、只读立面……                       |

> ⚠ `wiki/` **在 `.gitignore` 里**（本机索引，不入库）。所以：
> **任何「外面没有它就理解不了」的信息必须放在 `doc/`（入库）**，wiki 只能引用它。

---

## 2. 硬约束：改代码必须看原文，改完必须同步索引

**这是本仓库对 AI 协作者最重要的一条要求。**

### 2.1 索引只用于「找」，不用于「改」

`wiki/modules.md` 里「文件、行号、导出符号名」是**现扫生成**的，在生成那一刻为真；
但它是**快照**，且**不包含语义**（比较并交换？失败抛什么？哪些前提？）。

**要改任何函数，必须 `read` 原文件的相关段落。**
不许写「wiki 里写着，所以代码就是」——这类二手信息被当成一手事实，本仓库记过多次。

### 2.2 改完必须让索引重新变真

改动 `package/dsh-webcode-bridge/lib/` 下任何文件后：

```powershell
cd D:\9_Code_Workspace\dsh-webcode-bridge
node wiki/tools/gen-index.mjs           # 重建 wiki/modules.md + wiki/generated/modules.json
node wiki/tools/gen-index.mjs --check   # 必须 PASS（退 0）
```

- **新增模块**必须同时在 `wiki/tools/gen-index.mjs` 的 `ROLES` 里补一句角色，否则生成器**报红退出**。
  这是故意的：不允许索引里出现「某模块没人知道它是干什么的」。
- 手写层（`architecture.md` / `tasks.md` / `glossary.md`）**变了才改**，见 `wiki/protocol.md` §2.2 的表。
  普通 bug 修复**不要**去改 `architecture.md`——那是分层图，不是变更日志。

### 2.3 同步 `doc/`（长期知识层）

wiki 与 `doc/` 分工是硬的：wiki 回答**在哪/动谁/别踩什么**，`doc/` 回答
**为什么这么设计/验收到哪/还剩什么问题**。

- 修了一个真缺陷 → `doc/progress.md`（当轮）与包内 `CHANGELOG.md`（对外）
- 确认了一个新约束 → `doc/comment-style.md` 或 `doc/review-guide.md`
- 发现一个不现在修的问题 → `doc/long-term-issues.md`
- 新增文档 → **必须**登记进 `doc/README.md` 索引（闸门会验链接不死）

---

## 3. 提交前跑闸门

```powershell
cd D:\9_Code_Workspace\dsh-webcode-bridge
node scripts\lint-comments.mjs        # 注释纪律（新模块必跑：首行注释 + 导出 JSDoc）
node scripts\check-ledger.mjs         # 台账数字（版本号、测试文件数）
node scripts\check-repo-hygiene.mjs   # BOM + doc/README.md 死链
node scripts\check-commit-msg.mjs     # 提交信息形状（形状 type(scope): 主题）
```

提交信息规范见 `CONTRIBUTING.md` §9。**不要用 `--no-verify` 绕过**——判据错了就改判据。

---

## 4. 三条不可越界约束（改到这些地方先读注释）

1. **绝不静默降级模型** —— `strictModelType` 站点实际请求的元数据与所选模式不符时必须报错。
2. **绝不静默丢上下文** —— 网页会话丢了只能「重放整段」或「抛错」，
   不许把增量发进一个没有前文的新会话。
3. **工具协议只有一处定义** —— `lib/agent-preset.js`。任何别的模块再定义一遍调用格式
   都会造成两套协议漂移。

---

## 5. 本仓库的两条环境事实（会让你少踩两次坑）

- **安装依赖用 `pnpm install --no-frozen-lockfile`**：入库的 lockfile 已过期，
  `--frozen-lockfile` 会直接失败。
- **Node 必须 ≥22.13**（`packageManager` 钉的 pnpm 要求）。CI 矩阵与 `engines.node` 由
  `scripts/check-repo-hygiene.mjs` 保证相容。
- 本机实测 Node 里 `spawnSync` 调任何外部程序都 `EPERM`，因此 `node --test test/*.test.mjs`
  这类 glob + 子进程的跑法在本机会失败；逐文件 `node <单个文件>` 可行。

---

## 6. 一句话总结

**用 `wiki/` 快速定位 → 读原文件再改 → 改完重建索引并跑闸门 → 长期结论写进 `doc/`。**
