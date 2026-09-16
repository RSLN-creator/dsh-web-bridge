# 贡献指南（dsh-webcode-bridge）

本仓库把「已登录的网页 AI」接进 DeepSeek Harness：网页模型产出工具调用，由 Harness 原生权限
系统执行本地工具，结果回传同一个网页会话。它建立在**别人的网页 UI** 之上，所以脆弱点是常态。
这份指南只讲一件事：**怎么改，才能让下一个会话（人或 agent）不被你今天的改动坑到。**

先读三份文档，它们的优先级高于本指南：

| 文档 | 读它的时机 |
| --- | --- |
| [doc/review-guide.md](doc/review-guide.md) | 接手评审 / 第一次改代码前。**15 个源码文件的地图 + 三条不可越界约束** |
| [doc/comment-style.md](doc/comment-style.md) | 写新模块或重构前。注释纪律、错误码规范、**§9 实验与取证纪律**、§10 能力放大器 |
| [doc/verify.md](doc/verify.md) | 发版前。真机验收矩阵 |

`reference/`（逆向参考仓库）、`extension/`（旧扩展）与 `doc/` **不是运行链路**，
改代码时可以直接跳过。（`package/backup-installed-*` 与历史 tgz 已于 2026-09-16 删除。）

---

## 1. 跑测试

工作目录是 `package\dsh-webcode-bridge`（npm 脚本都在那儿）。

```powershell
cd D:\9_Code_Workspace\dsh-webcode-bridge\package\dsh-webcode-bridge
pnpm test
```

`pnpm test` 串起五件事（见 `package.json` 的 `test` 脚本）：

1. `node --test "test/*.test.mjs"` — 主单测（回归/契约/指标/解码器/图片流）
2. `node test/parse.test.mjs` — 回复解析
3. `node test/run-m1.js` — M1 契约
4. `node test-mock/bench-ci.mjs` — 基准层的 CI 闸门（含**负向对照**，见 §5）
5. `node test-mock/artifacts-check.mjs` — 生成物卫生

本机实测**约 9.4 分钟**（564s，2026-09-15，Windows / Node 24.18.0），退出码 0。

### 1.1 推之前先跑这一条

```powershell
cd D:\9_Code_Workspace\dsh-webcode-bridge
node scripts\ci-local.mjs          # 全量：注释纪律 + 生成物卫生 + 离线基准 + 全量单测
node scripts\ci-local.mjs --fast   # 跳过全量单测（秒级反馈）
```

它打印**每步的退出码**和一行 PASS/FAIL 汇总。`--fast` 只砍最慢的那一步（全量单测），
不砍检查。

### 1.2 两条环境事实（会让你少踩两次坑）

**① 安装依赖不能用 `--frozen-lockfile`。**

`package/dsh-webcode-bridge/pnpm-lock.yaml` 已经入库，但它**已过期**。实测：

```powershell
pnpm install --frozen-lockfile   # 退出 1
# [ERR_PNPM_OUTDATED_LOCKFILE] ... The importer resolution is broken at dependency
# "@deepseek-ai/dsh-client-ui-sidebar-right": version "0.1.5-alpha.1" doesn't satisfy range "*"
```

改用下面这条即可（实测退出 0，且**不会改写 lockfile**）：

```powershell
pnpm install --no-frozen-lockfile
```

根因是 `peerDependenciesMeta` 把该 peer 标成 optional，而 lockfile 的 importer 段仍要求满足 `*`。
CI 里用的是同一条命令——理由写在 `.github\workflows\ci.yml` 的文件头，不是随手放宽。

**② Node 20 上 `pnpm test` 会因为 glob 而失败。**

`package.json` 的 test 脚本里写的是 `node --test "test/*.test.mjs"`。**引号让 shell 无法展开**，
字符串原样交给 Node；而 `--test` 的 **glob 支持是 Node 21 才加入的**
（[Node.js 21 发布公告](https://nodejs.org/en/blog/announcements/v21-release-announce)，
PR [nodejs/node#47653](https://github.com/nodejs/node/pull/47653)）。在 Node 20 上它是字面路径，
找不到文件。CI 的 Node 20 那条腿因此改用 bash 展开 glob 的等价命令（`ci.yml` 里有逐字对照）。
本机日常用 Node 22+ 不会遇到这个问题。

### 1.3 真机探针：需要已登录的 Edge，别在 CI 里跑

```powershell
cd D:\9_Code_Workspace\dsh-webcode-bridge\package\dsh-webcode-bridge
node test-mock\real-verify.mjs            # npm run doctor：三模型 model_type + 工具闭环
node test-mock\real-mirror-matrix.mjs --port 8931   # 右栏真机验收矩阵（CDP 附着到桥已开的 Edge）
```

**风控纪律**（`doc/comment-style.md` §9.1 第 5 条，依据 `doc/bridge-failure-ledger.md` §3 的 0.14.3
事故）：反复深链同一会话地址会触发站点风控。因此真机跑必须**串行、每变体 ≤3 次、间隔 ≥20s**，
并且 `--live` 需要显式批准串。不要在 CI 里跑这些——CI 既没有登录态，也不该替用户去敲站点。

---

## 2. 打包与安装到 DSH profile

本项目**不从 registry 安装**。交付物是本地的 `.tgz`。

```powershell
# 1) 打包（在 package\dsh-webcode-bridge 下）
cd D:\9_Code_Workspace\dsh-webcode-bridge\package\dsh-webcode-bridge
pnpm pack
# → dsh-webcode-bridge-<版本>.tgz

# 2) 校验 tarball 与工作树逐字节一致
cd D:\9_Code_Workspace\dsh-webcode-bridge
node scripts\verify-pack.mjs package\dsh-webcode-bridge\dsh-webcode-bridge-<版本>.tgz

# 3) 装进 profile（README 的官方路径）
dsh plugin --profile web add .\package\dsh-webcode-bridge\dsh-webcode-bridge-<版本>.tgz
# 重启 DSH 后才生效
```

> `<版本>` 请用当前 `package.json` 的 version。此前这里写死 `0.14.7`，
> 而那个 tgz 已于 2026-09-16 随历史 tarball 一起删除（见 `doc/ci-cd.md` §6.2）。

也可以直接装进两个 profile（`web` / `headless`），这个脚本会**先删旧目录再解包**：

```powershell
node scripts\install-profiles.mjs                 # 用 package\ 下 mtime 最新的 tarball
node scripts\install-profiles.mjs --profiles web  # 只装 web
```

### 2.1 为什么 `verify-pack.mjs` 不能省

它的文件头记的是一次真实事故：**0.14.4 发布时 pack 之后又改了 `lib/mirror.js` 却没重新 pack**，
于是装进 profile 的是「旧 mirror.js + 新版本号」的组合——版本号对、文件也在，实际跑的是半旧代码，
**不报错，只是行为悄悄不对**。后来又踩到 pnpm 对同版本号 tarball 判「Already up to date」而不解包。

所以改了代码就必须重新 pack，然后**用哈希核对**（不是「我看了一眼」）：

```powershell
node scripts\verify-pack.mjs <tarball>   # 打印「N/M 逐字相同」；不一致退出 1
```

发布流程（`.github\workflows\release.yml`）把这一步做成了硬门禁，并额外校验 tag 与
`package.json` 的 version 一致。

---

## 3. 证据纪律：真机与离线必须分开写

这是本仓库最容易被违反、代价也最高的一条。`doc/comment-style.md` §9 的原文立场：

- **不做模型自评**。判据必须是机器可判的（调用序列、参数值、收尾方式、协议残片、正文字数）。
- **只做配对比较，不宣称最优**。禁止任何百分比提升字段（`lift` / `improvement` / `提升百分比`），
  有护栏（`FORBIDDEN_REPORT_RE`）。
- **样本量小就明说不足**，`significant` 在样本 ≤3 时只能是 `false`。
- **必须披露 harness**：站点、模型 id、工具清单、首轮提示词字符数、是否离线回放。
- **默认离线**。`--live` 必须显式批准。

写进注释/PR 的结论要带**日期 + 站点/环境 + 现象 + 关键数字**，字段名要能在 `/__webcode/status`、
`/__webcode/diagnostics`、驱动 `status()` 或日志里查到：

```
真机 2026-09-13 DeepSeek：网页流以 status:'WIP' 结束且永不发 FINISHED
（recoveredTurns=1、status='WIP'、chars=463）
```

凭推断得出的结论，就明确标注为**推断**，不要伪装成取证。

---

## 4. 生成物：重新生成，不要提交

基准 harness 每次运行都会写 `test-mock\prompt-bench\out\` 下的三份产物
（`report.md` / `report.json` / `records.csv`，其中 csv 带时间戳）——**每次内容都不同**。

它们必须始终被 `.gitignore` 忽略。这条规矩的由来写在 `test-mock\artifacts-check.mjs` 的文件头：
`.gitignore` 规则是**按路径**匹配的，`test-mock/out/` 不覆盖嵌套的 `test-mock/prompt-bench/out/`，
于是 2026-09-15 实际踩到「`git status` 一直列着它们，`git add -A` 顺手提进库」的漂移。

因此：

- **不要**把 `test-mock\prompt-bench\out\` 下的任何文件提交进库。
- 新增产物目录时，**同时**更新 `.gitignore`（按路径单列一条）与
  `test-mock\artifacts-check.mjs` 的 `GENERATED` / `SOURCES` 清单。
- 提交前跑 `node test-mock\artifacts-check.mjs`，它从**两个方向**验证：生成物被忽略、
  同区域的源文件仍可跟踪（防忽略规则写宽了把源码静默漏掉）。

浏览器 profile（`test-mock\.edge-profile*`、`.driver-profile*` 等）同理：可再生、不入库，
且会把仓库撑到 GB 级。

---

## 5. 注释与文档约定

**权威文档是 [doc/comment-style.md](doc/comment-style.md)**，这里只给摘要。核心一句：
**注释解释「为什么」，代码说明「做什么」**。

写之前先自问：把这段注释删掉，后来者会不会更容易写错？会 → 保留并写足；不会 → 删掉。

必写的场合（§2）：反直觉的实现、曾经的 bug 与回归点、真机取证、不可越界约束、
有意为之的取舍、外部依赖的脆弱点。

禁止的写法（§3）：同义反复、复述参数名、过时的注释（§3.3 的孤儿注释）、
把「是什么」写成一大段、**无信息量的 TODO**、用注释代替代码清晰性。

尤其注意 §6.3：**不要用注释复述 diff**。`// 新增：…`、`// 修改为…`、`// 修复了…`
对后来者没有价值——版本历史属于 git。

### 5.1 机检闸门：`scripts\lint-comments.mjs`

```powershell
cd D:\9_Code_Workspace\dsh-webcode-bridge
node scripts\lint-comments.mjs                    # 人读输出
node scripts\lint-comments.mjs --json             # 机读输出
node scripts\lint-comments.mjs --max-warnings=5   # 允许最多 5 条 warn
```

| 码 | 级别 | 检查 |
| --- | --- | --- |
| `CS001` | error | `lib/`、`bin/` 下 js/cjs/mjs 的首个非空内容行必须是注释 |
| `CS002` | error | `TODO`/`FIXME`/`XXX`/`HACK` 必须带负责人、日期或 issue 号 |
| `CS003` | error | `lib/` 下导出函数上方必须紧贴 `/** */` JSDoc |
| `CS004` | error | 注释不得复述 diff（§6.3） |
| `CS005` | warn | 连续 ≥3 行、且多数像代码的 `//` 块（疑似被注释掉的代码） |

豁免 `CS003`：在被检查行上方写 `// @nolint-cs003 <一句话理由>`。理由写什么不检查
（机器判不了），但它在 review 里会被看见。

> **当前状态**：基线**尚未清干净**——2026-09-15 实测 19 个 error（`CS001` 1 个、`CS002` 5 个、
> `CS003` 13 个）。因此 CI 里这一步目前是 `continue-on-error: true`（非阻断），明细与逐条清单见
> [doc/ci-cd.md](doc/ci-cd.md)。基线清完后要**删掉 `continue-on-error`** 并加进必需检查列表；
> 留着不动，这道闸门等于不存在。

### 5.2 文档同步（§10.3）

- 新增文档必须进 `doc/README.md` 的索引，且**链接要能 `Test-Path` 通过**——指向不存在文件的
  索引等同于没有索引。
- 被代码引用的文档必须在索引里可查，否则「看注释去查」这条路径是断的。
- 文档自述其**口径来源**（官方文档给链接、本机实测给命令），读者能自行复核而不是只能相信。

---

## 6. CI 闸门

推上去之后跑的是 `.github\workflows\ci.yml`：**ubuntu-latest + windows-latest × Node 20 + 22**，
四组合，`fail-fast: false`。步骤：检出 → pnpm 11.25.0 → Node → `pnpm install --no-frozen-lockfile`
→ 注释纪律 → 全量单测 → 离线基准 → 生成物卫生；失败时上传基准产物。`timeout-minutes: 45`
（本机全量 564s，冷缓存 + 两平台留余量）。

另外两个工作流：`release.yml`（tag `v*` 触发，打包 + verify-pack + 挂 Release，**不发 registry**）、
`codeql.yml`（JS/TS 静态分析，push/PR + 每周定时）。

**刻意不在 CI 里跑的东西**：所有真机探针（`test-mock\real-*.mjs`、`npm run doctor`）。理由见 §1.3。
发版前的真机验收由人按 `doc/verify.md` 的矩阵跑。

完整说明、必需检查列表、以及「CI 在本地怎么复现」见 [doc/ci-cd.md](doc/ci-cd.md)。

---

## 7. 三条不可越界约束

改到这几处**先读注释再动手**（`doc/review-guide.md`）：

1. **绝不静默降级模型**——`strictModelType` 站点实际请求的元数据与所选模式不符时必须报错。
   模式期望按 UI 代际取值（`lib/metrics.js` 的 `MODEL_TYPES_BY_UI`）。
2. **绝不静默丢上下文**——网页会话丢失时只能「重放整段」或「抛错」，不允许把增量发进一个
   没有前文的新会话。
3. **工具协议只有一处定义**——`lib/agent-preset.js`。任何别的模块再定义一遍调用格式都会
   造成两套协议漂移。

这几处的注释就是修改边界本身：`lib/agent-preset.js`、`lib/providers.js` 的 `MODEL_ALIAS_IDS`、
`lib/web-control.js` 的 `routeIndex`、`lib/index.js` 的 `inject` 声明。

---

## 8. 提交 PR

用 `.github\pull_request_template.md` 的五个小节：**变更动机 / 证据（真机 or 离线，必须区分）/
护栏 / 文档同步 / 回滚方式**。模板顶部解释了每一节对应本仓库的哪次踩坑。