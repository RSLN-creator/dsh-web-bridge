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

`reference/`（逆向参考仓库）与 `doc/` **不是运行链路**，
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

**② 必须用 Node ≥22.13。**

`package.json` 的 `packageManager` 钉的是 `pnpm@11.25.0`，而这一版 pnpm **要求 Node ≥22.13**。
在 Node 20 上跑 `pnpm install` 会直接退出 1：

```
warn: This version of pnpm requires at least Node.js v22.13
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
```

`engines.node` 现在写的是 `>=22.13`，CI 矩阵是 `[22, 24]`，两者由
`scripts/check-repo-hygiene.mjs` 的判据 C 保证相容——改了其中一个而没改另一个会直接红。

> 历史：这里曾经写的是「Node 20 上 `pnpm test` 会因为 glob 而失败」。那个结论是错的，
> 它描述的是另一个现象；真正的失败发生在 `pnpm install`，测试根本没跑。详见
> `doc/ci-cd.md` §3.2。

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

推上去之后跑的是 `.github\workflows\ci.yml`：**ubuntu-latest + windows-latest × Node 22 + 24**，
四组合，`fail-fast: false`。步骤：检出 → pnpm 11.25.0 → Node → `pnpm install --no-frozen-lockfile`
→ 注释纪律 → 台账一致性 → 文件规范（编码 + 文档索引）→ 提交信息 → 全量单测 → 离线基准
→ 生成物卫生；失败时上传基准产物。`timeout-minutes: 45`（本机全量 564s，冷缓存 + 两平台留余量）。

另外两个工作流：`release.yml`（tag `v*` 触发，打包 + verify-pack + 挂 Release，**不发 registry**）、
`codeql.yml`（JS/TS 静态分析，push/PR + 每周定时）。

**刻意不在 CI 里跑的东西**：所有真机探针（`test-mock\real-*.mjs`、`npm run doctor`）。理由见 §1.3。
发版前的真机验收由人按 `doc/verify.md` 的矩阵跑。

完整说明、必需检查列表、以及「CI 在本地怎么复现」见 [doc/ci-cd.md](doc/ci-cd.md)。

### 6.1 五个本机也能跑的闸门脚本

闸门的价值取决于**能不能在本机先跑一遍**——跑到 CI 才发现，等于花一轮往返买同一句话。

| 脚本 | 管什么 | 本机命令 |
| --- | --- | --- |
| `scripts\lint-comments.mjs` | 注释纪律（错误码、§引用、TODO 形态） | `node scripts\lint-comments.mjs` |
| `scripts\check-ledger.mjs` | 台账数字与事实一致（版本号、测试文件数） | `node scripts\check-ledger.mjs` |
| `scripts\check-long-term-issues.mjs` | 长期问题台账「一览表 ↔ 正文」自洽（缺行 / 孤儿行 / 状态矛盾） | `node scripts\check-long-term-issues.mjs` |
| `scripts\check-repo-hygiene.mjs` | 文件编码不得带 BOM + `doc/README.md` 索引无死链 | `node scripts\check-repo-hygiene.mjs` |
| `scripts\check-commit-msg.mjs` | 提交信息形状（见 §9） | `node scripts\check-commit-msg.mjs --self-test` |

五个脚本都是**独立可跑、不引第三方依赖、不用 `spawnSync`** 的纯 Node 工具——这不是风格偏好：
本机实测 Node 里 `spawnSync` 调任何外部程序都 `EPERM`（`doc\progress.md`「已知环境约束」），
凡是靠它去问 git 的闸门在本机都会**空转**，而空转的闸门比没有闸门更坏（它给的是「检查过了」的错觉）。

每个脚本都带 `--self-test`（或等价的正反例自检），用来证明**它的判据本身是活的**——
一个只会在构造输入上返回「通过」的闸门等于没有。改动闸门判据时必须同步改自检的正反例。

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

---

## 9. 提交信息规范（Conventional Commits）

**这条规范以前只存在于实际做法里，没有写下来、也没有闸门。** 实测最近 200 条提交全部
写成下面的形状，但新来的会话/协作者没有任何地方能读到它——一旦掺进一条 `update stuff`，
要么被无声接受，要么在评审里争论一次。所以现在把它写下来，并由
`scripts\check-commit-msg.mjs` 在 CI 上阻断。

### 9.1 形状

```
type(scope): 主题
type(scope)!: 主题            # ! 表示破坏性变更
type+type(scope): 主题        # 复合：一次提交横跨两类改动
type(scope+scope): 主题       # 复合作用域
```

真实例子（全部来自本仓库历史）：

```
fix(decoder): SET 重发吞掉流式增量 —— 网页有输出、harness 收不到（0.15.7）
chore(hygiene)+feat(gate): 清历史 tgz / 废弃备份 + 两条死规则 + 台账闸门
test+ci: 注释闸门转阻断，CI/CD 与审查补强（0.15.2）
feat(bench+roster): 提示词基准层与真实花名册
security: 导入登录态目录白名单 + 两个状态文件统一 0o600
```

### 9.2 类型白名单

`feat` / `fix` / `docs` / `test` / `chore` / `refactor` / `perf` / `ci` / `build` / `revert` / `security`

前八类来自实测；`security` 亦来自实测（安全专项改动）。**新增类型要先改
`scripts\check-commit-msg.mjs` 的 `TYPES` 并在注释里写下理由**——白名单的意义就是它不会
自己长大。

### 9.3 判据（每条都有对应的真实反例）

| 判据 | 为什么 |
| --- | --- |
| 形状必须是 `type(scope)?: 主题` | 让 `git log --oneline` 可被机械化扫描（筛 fix、找某模块） |
| 主题非空 | `feat(ui):` 后面什么都没有不是提交信息 |
| **不得含 BOM** | BOM 会让 `git log \| grep ^fix` 静默漏掉这条，排查时表现为「这条提交好像不存在」 |
| **主题里不得有字面 `\n`** | 真机反例 `6b95cf2`：整段正文被塞进主题行（实测 1031 字符）。正确做法是空一行后写正文 |
| 长度 ≤ 100 字符（只 warn） | 中文信息密度高，硬卡 50/72 会把正常中文写成半句。提醒而不拦 |

`Merge …` / `Revert "…"` / `fixup!` / `squash!` 放行——这些由 git 或交互式 rebase 生成，
不是作者手写的主题。

### 9.4 本机怎么用

```powershell
# 自检判据（改闸门判据后必跑）
node scripts\check-commit-msg.mjs --self-test

# 检查最近一次提交的信息
node scripts\check-commit-msg.mjs

# 检查一批（一行一条主题）
git log --format="%s" -20 | node scripts\check-commit-msg.mjs --stdin
```

**不要用 `--no-verify` 绕过。** 判据本身错了就改判据，并同步补 `--self-test` 的正反例——
这与 `lint-comments.mjs` 的处理立场一致（「若确属误报，请改本脚本的判据而不是绕过它」）。
