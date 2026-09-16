# CI/CD（.github/workflows + scripts/）

本文件记录本仓库的三条流水线：**什么在哪里跑、什么故意不跑、怎么在本地复现、怎么发版**。
最后给一份分支保护需要的**必需检查清单**。

口径来源：全部步骤都在本机实测过（Windows / Node 24.18.0 / pnpm 11.25.0，2026-09-15），
命令与退出码写在下面各节里，可自行复核。

---

## 1. 三条流水线

| 工作流 | 触发 | 平台 | 时长预算 | 交付物 |
| --- | --- | --- | --- | --- |
| [`ci.yml`](../.github/workflows/ci.yml) | `push`→`main`、`pull_request`、`workflow_dispatch` | ubuntu-latest **和** windows-latest × Node **20 和 22** | `timeout-minutes: 45` | 失败时上传基准产物 |
| [`release.yml`](../.github/workflows/release.yml) | tag `v*` | ubuntu-latest / Node 22 | `timeout-minutes: 20` | GitHub Release 上的 `.tgz` |
| [`codeql.yml`](../.github/workflows/codeql.yml) | `push`/`pull_request`→`main`、每周一 03:17 UTC | ubuntu-latest | `timeout-minutes: 30` | SARIF 到 code scanning |

`ci.yml` 带 `concurrency: ci-<ref>` + `cancel-in-progress: true`：同一分支上的旧运行被新推送
取代后立即取消（省 runner，也避免旧结论贴在新 commit 上）。

### 1.1 `ci.yml` 的步骤顺序

1. 检出 → `pnpm/action-setup@v4`（**11.25.0**，取自 `package/dsh-webcode-bridge/package.json`
   的 `packageManager`）→ `actions/setup-node@v4`
2. `pnpm install --no-frozen-lockfile --prefer-offline`（**理由见 §3.1**）
3. `node scripts/lint-comments.mjs`（**阻断**，见 §4）
4. 全量单测 —— 两套等价命令按 Node 版本分流（**理由见 §3.2**）
5. `node test-mock/prompt-bench.mjs --offline`
6. `node test-mock/artifacts-check.mjs`
7. `node scripts/ci-local.mjs --fast` —— **本地入口自检**
8. `if: failure()` → 上传 `test-mock/prompt-bench/out/` 与 `test-mock/out/`

第 7 步明知与第 3/6 步重叠仍保留，是刻意的：`ci-local.mjs` 里有一段**按平台分叉**的逻辑
（pnpm 在 Windows 上是 `pnpm.cmd`、其它平台是 `pnpm`），开发者在自己的机器上只走得到一个
分支，另一边永远没人验证。`--fast` **跳过全量单测**（慢的那一步），因此净成本约 1 秒，
换来两个平台都验证一次「文档让你跑的那条命令真的能跑」。若将来 CI 时长紧张，删掉它是安全的，
但要同时接受「本机入口只在单平台被验证」。

`fail-fast: false`：一个平台的失败会掩盖另一个平台的失败，而两平台失败的**原因通常不同**。

---

## 2. 刻意**不在** CI 里跑的东西

这是本文件最重要的一节。CI 只跑**离线层**；**真机层**由人按发版节奏跑。

### 2.1 真机探针（全部跳过）

| 探针 | 为什么不在 CI |
| --- | --- |
| `test-mock/real-verify.mjs`（`npm run doctor`） | 需要一台**已登录的** Edge profile（三模型 `model_type` 核验 + 工具闭环）。CI runner 没有那份登录态，登录态也不可能放进去。 |
| `test-mock/real-mirror-matrix.mjs` | 需要 CDP 附着到**桥已开的** Edge，逐站点加载真实镜像并截图。同上。 |
| `test-mock/real-probe-*.mjs`（20+ 个） | 需要真实站点，且每个都受站点风控限制。 |
| `test-mock/run-real-longrun.mjs` | 真实 Edge + 真实网页会话跑多轮工具闭环，未登录会自动开有头窗口等人工登录——CI 里没人能去点那个窗口。 |

**风控纪律**（`doc/comment-style.md` §9.1 第 5 条，依据 `doc/bridge-failure-ledger.md` §3 的 0.14.3
事故）：反复深链同一会话地址会触发站点风控。真机跑必须**串行、每变体 ≤3 次、间隔 ≥20s**，
且 `--live` 需要显式批准串（`test-mock/prompt-bench.mjs` 的 `LIVE_APPROVAL_TOKEN`）。
CI 既没有登录态，也不该替用户去敲站点——这两条任意一条都足以让它留在 CI 之外。

真机验收的归属是 [verify.md](verify.md) 的矩阵。

### 2.2 已知的假失败（不该进 CI）

`doc/review-guide.md` 已经点名三项**在改动前的干净树上同样失败**的既有欠账，属既有欠账不是回归：

- `test-mock/run-m2.js` — 已随旧扩展链路一起归档到 `test-mock/archive/`（2026-09-16）。
  **注意**：它在本机是 `spawn EPERM`（未跑到断言），不是「恒 FAIL」——见 `long-term-issues.md` #9 的复核段
- `run-m2b-driver.js` / `run-m2c-webapi.js` — mock 站点响应形状已与驱动期望脱节

它们**不在** `pnpm test` 的链里，因此不会让 CI 红。不要为了「覆盖率好看」把它们加进去。

### 2.3 模型自评与 `--live` 基准

§9.1 第 1 条：**不做模型自评**，判据必须机器可判。第 5 条：**默认离线**。
CI 里跑的是 `--offline`（等价于默认行为），只走「全部通过 → 退出 0」这一条路径；
负向对照（期望退出 1）由 `test-mock/bench-ci.mjs` 负责，已含在 `pnpm test` 里。

---

## 3. 两个必须知道的 CI 环境事实

### 3.1 不能用 `--frozen-lockfile`

`package/dsh-webcode-bridge/pnpm-lock.yaml` **已入库**，但它**已过期**。实测（本机）：

```powershell
cd D:\9_Code_Workspace\dsh-webcode-bridge\package\dsh-webcode-bridge
pnpm install --frozen-lockfile
# [ERR_PNPM_OUTDATED_LOCKFILE] Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not
# up to date with <ROOT>\package.json
#   Failure reason:
#   The importer resolution is broken at dependency
#   "@deepseek-ai/dsh-client-ui-sidebar-right": version "0.1.5-alpha.1" doesn't satisfy range "*"
# → 退出码 1
```

改用 `--no-frozen-lockfile`（实测退出 0，且在干净临时目录里也成功解析出
`@deepseek-ai/dsh-client-ui-sidebar-right 0.1.5-alpha.1`、`playwright-core 1.63.0`、`ws 8.21.3`）：

```powershell
pnpm install --no-frozen-lockfile   # 退出码 0，且 lockfile 的 sha256 前后一致（未被改写）
```

根因是 `package.json` 的 `peerDependenciesMeta` 把该 peer 标成 optional，而 lockfile 的 importer
段仍要求满足 `*`。**这不是「绕过校验」**：该 lockfile 对干净安装本就不成立，冻住它只会让 CI 恒红。

> 修好 lockfile（重新生成并提交，使 `--frozen-lockfile` 通过）之后，应当把两条流水线都改回
> `--frozen-lockfile`——那才是 CI 应有的严格度。在那之前用 `--no-frozen-lockfile` 是**如实描述
> 现状**，而不是放宽标准。

### 3.2 CI 的 Node 矩阵必须与 `engines.node` 相容（2026-09-17 修正）

**这一节此前写的是「Node 20 上 `pnpm test` 会因 glob 失败」。那个结论是错的**——
它描述的现象存在，但它不是 CI 变红的原因。实测（run 35137367183）：Node 20 那两条腿
**在 `pnpm install` 就退出了**，任何一条测试都没跑到：

```
warn: This version of pnpm requires at least Node.js v22.13
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
Process completed with exit code 1.
```

根因不是 glob，而是**两处版本声明互相矛盾**：`package.json` 的 `packageManager` 钉的是
`pnpm@11.25.0`，该版本要求 Node ≥22.13；而矩阵里放着 Node 20。于是「Node 20 专用命令」
那段分流从未被执行过——它是一段**为错误前提写的补丁**，恰好掩盖了真因。

修法是让三处对齐到同一个事实：

| 位置 | 现在写的是 |
| --- | --- |
| `package/dsh-webcode-bridge/package.json` → `engines.node` | `>=22.13`（与 `packageManager` 相容） |
| `.github/workflows/ci.yml` → `matrix.node` | `[22, 24]` |
| 单测步骤 | **只有一条** `pnpm test`（两平台四条腿跑同一条命令） |

矩阵仍同时覆盖**最低声明版本**（22）与开发机当前版本（24）：只测 24 会放过「在声明支持的
最低版本上根本跑不起来」这类回归，而那正是本项目最想避免的一类「本地绿、用户红」。

> **为什么删掉 glob 分流**：`node --test` 的 glob 支持是 Node 21 才加入的
> （[Node.js 21 发布公告](https://nodejs.org/en/blog/announcements/v21-release-announce)，PR
> [nodejs/node#47653](https://github.com/nodejs/node/pull/47653)），22 上原生可用。
> 两条腿跑同一条命令之后，「它们跑的到底是不是同一件事」不再需要靠人对照两段命令。

**这条矛盾现在有机器判据**：`scripts/check-repo-hygiene.mjs` 的判据 C 直接比对
`ci.yml` 的 Node 矩阵与 `engines.node`——矩阵里出现低于最低声明版本的大版本、
或矩阵没有覆盖最低声明大版本，都会红。写下它是因为本次事故的形状：改 `engines.node`
时没人去改矩阵，两份人写的声明之间**没有任何东西保证一致**。

---

## 4. 注释纪律闸门：**已转阻断**（2026-09-15，0.15.2）

`scripts/lint-comments.mjs` 在 `ci.yml` 与 `release.yml` 里都**没有** `continue-on-error` 了，
并且已加入 §7 的必需检查清单。

### 4.1 它曾经是非阻断的，为什么

接入时（2026-09-15）现有代码基线未清：实测 **19 个 error + 4 个 warn**（逐条清单见 §8）。
立刻设为阻断会让 `main` 上每一次推送都红——那会让人学会忽略它，比非阻断更糟。
所以当时的写法是「先非阻断接入 + 写下撤回条件」。

**撤回条件现在已经满足**，因此按当时的承诺撤掉了：

| 原欠账 | 数量 | 处置 |
| --- | --- | --- |
| `CS003` 导出函数缺 JSDoc | 13 | 已补齐 |
| `CS002` 待办标记无负责人/日期 | 5 | **是闸门自身的判据 bug**，见 §4.2 |
| `CS001` 缺文件头注释 | 1 | 已补 |
| `CS005` 疑似注释掉的代码 | 4（warn） | 判据收紧，见 §4.3 |

实测 `node scripts/lint-comments.mjs` 现在 **error 0 / warn 0**，退出码 **0**。

> 这条历史值得留在这里：**「先非阻断」只有在同时写下「什么条件下撤回」时才是安全的**。
> 没有撤回条件的非阻断闸门 = 一道永远不亮的灯，而它还会让人以为「我们有这道检查」。

### 4.2 `CS002` 的判据 bug（这一段是本次最值得记的）

原实现按**整行扫源码**找待办标记，于是这两行**代码**被当成了待办注释：

```js
const MARKER_RE = /\b(TODO|FIXME|XXX|HACK)\b/;
const MARKER_OK_RE = /\b(TODO|FIXME|XXX|HACK)\s*(\([^)]+\)|#\d+|\d{4}-\d{2}-\d{2})/;
```

`TODO` 出现在**正则字面量**里，不是注释。一个「检查待办注释」的规则在读代码——这是
典型的「检测器与被检测物搞混」。修法是先用一个**状态机**（`extractComments`）逐字符
走一遍文件，只把真正落在 `//` 或 `/* */` 里的文本交出来，再在**注释文本**上匹配标记。

为什么必须是状态机而不是正则：`/` 是「正则开始」还是「除法」取决于前一个有意义的字符，
而 `'https://…'` 里的 `//` 根本不是注释。正则判不了这两种情况。

**并且验证了它没有变成空壳**：往一个干净文件里种一行 `// TODO fix this later`，
确认 `CS002` 报错、`CS005` 同时报「疑似注释掉的代码」；撤回后重新跑恢复 0 error。
规则仍然抓得住真实违规——这一步不能省，否则「修好假红」与「把规则改瞎」在输出上
长得一模一样。

### 4.3 `CS005` 的四处 warn：全是散文误报，判据收紧而非删文本

四处都**没有**死代码，删掉等于销毁真实文档，所以修的是判据：

| 位置 | 被误判成代码的原因 |
| --- | --- |
| `lib/agent-preset.js:1` | 英文散文用分号结尾（`…first user message;`）+ 出现单词 `new` |
| `lib/model-picker.js:1` | 一行 `//   }` 收的是一个**被记录下来的契约形状**，不是死代码 |
| `test/control-routes.test.mjs:1` | 中文句子 `… -> 405，body 长度 0`、句子里点名 `await response.json()` |
| `test/protocol-leak.test.mjs:1` | 三行英文散文以 `;` 结尾 |

三处收紧（各自都把实测证据写在常量上方）：光秃的 `;\s*$` 现在要求**赋值或调用形态**，
且调用正则禁止 `foo (x)` 这种带空格的写法（正是 `fixture (its index was -1);` 的形状）；
宽松的关键词规则要求关键词后面真的跟代码而不是中文散文或行尾；再加一条 CJK 占比判据
（≥20% 即为散文），专治「恰好含 `return` 的长中文句子」。

规则表（每条都对应 `doc/comment-style.md` 的一个真实章节）：

| 码 | 级别 | 检查 | 依据 |
| --- | --- | --- | --- |
| `CS001` | error | `lib/`、`bin/` 下 js/cjs/mjs 首个非空内容行必须是注释 | §10.1 |
| `CS002` | error | `TODO`/`FIXME`/`XXX`/`HACK` 必须带负责人、日期或 issue 号 | §3.5 |
| `CS003` | error | `lib/` 下导出函数上方必须紧贴 `/** */` JSDoc | §4、§2.4 |
| `CS004` | error | 注释不得复述 diff（`// 新增：`/`// 修改为`/`// 修复了`） | §6.3 |
| `CS005` | warn | 连续 ≥3 行、且多数像代码的 `//` 块（疑似被注释掉的代码） | §3.6 |

**刻意的范围与豁免**（为什么有些东西不查）：

- `CS001` 只覆盖 `lib/` 与 `bin/`（**随包发布**的运行时源码），不覆盖 `test/`、`test-mock/`、
  `scripts/`。后者的头部注释是习惯而非契约，算作违约会制造与真实风险无关的红灯。
- `CS003` 可豁免：被检查行上方任意位置写 `// @nolint-cs003 <一句话理由>`。理由不检查
  （机器判不了），但它在 review 里会被看见。
- `CS002` 只在**抽出的注释文本**上匹配，并剥掉引号内的引用（反引号、`「」`、`''`、`""`）。
  **这条豁免是被自己的输出逼出来的**：本脚本的头部注释解释 §3.5 时必须写出 `TODO` 字样，
  若把引用也算成违规，任何讨论这条规则的文档都过不了闸门。
- `CS001`/`CS004` **刻意仍按原始行判断**，没有换成注释文本：换成注释文本会让块注释开头的
  banner 被当成「缺文件头」，同时让注释掉的代码里的 `// 新增：` 不再被 CS004 命中——
  两处都是能力倒退，收益为零。这一条写在代码注释里，免得下次有人「顺手统一」。
- `CS005` 只是 warn 不是 error：本仓库大量使用连续 `//` 写散文（`lib/index.js:1-8`、
  `scripts/verify-pack.mjs`），散文里出现 `const` 一词是可能的。按 §9.1 第 1 条，
  **判不了的就不要假装判得了**。

脚本**不引任何依赖**（不装 acorn/espree）：本仓库的脚本传统是「可直接 `node` 运行的独立工具」
（见 `test-mock/prompt-bench.mjs:202` 的手写 argv 解析注释），CI 里多一个依赖就多一处供应链面。
代价是规则只能做行级判断（`CS002` 例外，它带一个自写的注释抽取状态机），
所以每条都写明了边界——**宁可漏报也不制造假红**。

---

## 5. 在本地复现 CI

```powershell
cd D:\9_Code_Workspace\dsh-webcode-bridge
node scripts\ci-local.mjs          # 全量：4 步
node scripts\ci-local.mjs --fast   # 跳过全量单测（秒级）
```

它按 CI 的顺序跑：注释纪律 → 生成物卫生 → 离线基准 → 全量单测，打印**每步退出码**与一行
PASS/FAIL 汇总。退出码：`0` 全过 / `1` 有步骤失败 / `2` 脚本自身出错。

`--fast` **只砍最慢的那一步**（全量单测，本机 564s），不砍检查——砍掉的必须是慢的那一步，
而不是「顺手也砍掉检查」的那一步。

**它不跑真机探针**，理由与 §2.1 同。也不修改任何文件、不安装依赖：跑之前请先
`pnpm install --no-frozen-lockfile`（§3.1）。

### 5.1 本机实测基线（2026-09-15，0.15.2）

| 步骤 | 退出码 | 耗时 |
| --- | --- | --- |
| `lint-comments` | **0**（error 0 / warn 0，见 §4） | 292ms |
| `artifacts-check` | 0 | 899ms |
| `bench-offline` | 0（14/14 通过） | 142ms |
| `test`（`pnpm test`） | 0 | ≈567s |

`pnpm test` 全绿，但它**尾部有 10 行「失败 N 条」**——那是 `bench-ci.mjs` 跑**负向对照用例集**
的预期输出（期望退出 1，`bench-ci` 断言了这一点）。看到它不代表失败；判据是整条链的退出码。

### 5.2 `ci-local` 自己曾经是坏的（值得单独记一笔）

**这个脚本的第 4 步（`pnpm test`）在 Windows 上从未真正跑起来过**，
错误是 `spawnSync pnpm.cmd EINVAL`，而它被写下来时**没人发现**——因为当时
`ci-local` 不在 CI 里跑，唯一会执行它的人是本机开发者，而本机开发者遇到 `EINVAL`
只会以为「这脚本坏了，我直接跑 pnpm test 吧」。

根因是 Node 修 CVE-2024-27980（Windows 上 `.bat`/`.cmd` 的参数注入）后加的一道硬化：
**`shell:false` 下 spawn 一个 `.cmd`/`.bat` 会直接抛 `EINVAL`**。原实现取了正确的名字
（`pnpm.cmd`）却配了 `shell:false`，两者不兼容。修法是给这一步配 `shell:true`
（参数全是本文件里的字面量，没有用户输入，不构成那条 CVE 的攻击面）。

> **这一条是本文件里「为什么要把 `ci-local` 也放进 CI」的最好论据**：把
> `node scripts/ci-local.mjs --fast` 加进 `ci.yml` 之后，这个问题在**加进去的当天**
> 就被两个平台各暴露了一次。一个「只在本机、只被文档推荐」的入口，
> 它的坏法恰恰是**安静的**——不报错、不进 CI、没人收到通知。

---

## 6. 怎么发版

本项目**不从 registry 安装**（`README.md` 的安装方式是本地 tarball 装进 DSH profile）。
`release.yml` **绝不 publish 到任何 registry**，且带一道守卫：工作流里出现
`npm/pnpm/yarn publish` 命令行即构建失败（注释里讨论「不 publish」是允许的）。

流程：

```powershell
# 1) 改版本号
#    package\dsh-webcode-bridge\package.json 的 "version"
# 2) 本地先绿一遍
cd D:\9_Code_Workspace\dsh-webcode-bridge
node scripts\ci-local.mjs
# 3) 提交 + 打 tag（tag 必须是 v + package.json 的 version）
git commit -am "release: 0.14.8"
git tag v0.14.8
git push origin main --tags
```

`release.yml` 随后：安装依赖 → **守卫**（无 publish 命令）→ **校验 tag 与 version 一致** →
`pnpm pack` → `node scripts/verify-pack.mjs <tarball>` → 生成物卫生 + 注释纪律预检 →
`gh release create`（或已存在则 `upload --clobber`）→ 记录 sha256 到 Step Summary。

### 6.1 两道发布护栏分别防什么

- **`verify-pack.mjs`** 防「pack 之后又改了代码却忘了重新 pack」。它记录的真实事故：0.14.4
  发布时改了 `lib/mirror.js` 但装进去的是旧文件——**版本号对、文件也在，实际跑的是半旧代码，
  不报错，只是行为悄悄不对**。脚本逐个比 sha256 并打印「N/M 逐字相同」，哈希不同就是不同。
- **tag/version 一致性检查** 防「打了 `v0.14.8` 的 tag 但 `package.json` 还是 `0.14.7`」。
  `verify-pack` 抓不到这个（它只比 tarball 与工作树）。两条合起来才覆盖「名字、内容、工作树」
  三者一致。

**不跑全量单测**：那是 `ci.yml` 的职责，而 tag 应当打在已经绿过 `main` 的 commit 上。

### 6.2 安装与回滚

> **2026-09-16 变更：历史 tgz 已全部删除，本节旧的回滚步骤作废。**
>
> 旧步骤写的是「回滚：装回上一个版本的 tgz（`package\` 下存着历史版本）」。
> 用户于 2026-09-16 决定**不再在仓库里囤积历史 tgz**（56 个 / 5.55 MB），
> 它们已从索引与磁盘一并删除，因此**那条路径不再存在**——照着旧步骤做会直接失败。
>
> 这条变更必须与 `.gitignore` 同步（那是 `*.tgz` 规则注释里自己写下的要求：
> 「`git rm --cached` 并同步改写 doc/ci-cd.md §6.2，两者必须一起做」）。
> 现在两者都做了。

**安装当前版本：**

```powershell
# 1) 打包（产物落在包目录，已是 gitignore 的 *.tgz）
cd package\dsh-webcode-bridge ; pnpm pack
# 2) 装进 profile（先删旧目录再解包，打掉 pnpm 的「同版本号判 up to date」）
node ..\..\scripts\install-profiles.mjs <tgz> --profiles web
# 3) 重启 DSH 后才生效（当前进程里仍是旧代码）
```

**回滚怎么做了（不再依赖仓库里的历史 tgz）：**

| 方式 | 做法 | 适用 |
| --- | --- | --- |
| **git 回滚**（推荐） | `git checkout <上一个已知good的tag或commit> -- package/dsh-webcode-bridge` 后重新 `pnpm pack` + 安装 | 本地有 git 历史，这是**唯一不依赖囤积产物**的方式 |
| **GitHub Release** | 从 Release 页面下载对应版本的 `.tgz`（`release.yml` 在 tag 上发布） | 需要一个已发布的旧版本 |
| **本地缓存** | 若你个人保留了 tgz，放在 `package\` 下即可（该目录已被 `*.tgz` 忽略，不会污染提交） | 仅个人使用 |

**为什么不再囤积**：tgz 是 `pnpm pack` 的**产物**，每次打包字节都可能不同
（时间戳、规范化）。继续入库等于把「同名不同内容」的混淆搬进历史——而本项目已经因为
「同版本号换内容」踩过坑（见 `scripts/verify-pack.mjs` 的文件头）。
回滚应当基于 **git 历史**（可复现），而不是基于**碰巧留在磁盘上的二进制**。

---

## 7. 分支保护：必需检查清单

`main` 上建议开启：

| 必需检查 | 来源 |
| --- | --- |
| `test (ubuntu-latest, node 22)` | `ci.yml` |
| `test (ubuntu-latest, node 24)` | `ci.yml` |
| `test (windows-latest, node 22)` | `ci.yml` |
| `test (windows-latest, node 24)` | `ci.yml` |
| `分析 JavaScript/TypeScript` | `codeql.yml` |
| `打包并发布 tarball` | `release.yml`（只在 tag 上跑，可留可加） |

四项 matrix 全列，不要只留 ubuntu —— `windows-latest` 那条腿是本项目的**主开发平台**
（README：「系统需要 Node.js 22.13+ 和 Microsoft Edge」），历史上大量踩坑来自 Windows
（`lib/browser-driver.js` 的 WMI Terminate、profile 单实例锁残留、分隔符匹配）。

另建议开启：**Require branches to be up to date before merging**、
**Require a pull request before merging**（用 `.github/pull_request_template.md`）、
**Require review from Code Owners**（配合 `.github/CODEOWNERS`）。

### 7.1 注释闸门现在**在**必需检查里了

`注释纪律（scripts/lint-comments.mjs，阻断）` 已加入必需检查。

注意 GitHub 的粒度：**必需检查是 job/step 名，不是文件名**。注释纪律是 `test` job 里的
一个 step，不是独立 job——所以它不能被单独列为必需检查，它红就是 `test (os, node)` 这个
job 红。这是**有意的**设计（它只跑几百毫秒，单开一个 job 要多付一次 checkout + setup-node
的时间），但也意味着：看到 `test` 失败时，**先看是哪一步红的**，不要假定一定是单测。

### 7.1.1 台账闸门（scripts/check-ledger.mjs，2026-09-16 新增）

与注释闸门同属 test job 的一个 step（同样是秒级，不值得单开 job）。

**它存在的理由是「同一条约定失败了三次」。** doc/progress.md 开头写着「每完成一项即更新
这里」，而 doc/long-term-issues.md §2.3 与 2026-09-16 的状态复核各抓到一次记账
未收口；后者那次更彻底——「当前状态」表四行全过期，且 0.15.4/0.15.5 两轮工作整段没有台账。

**边界（必须写清，否则会被误当成「台账已完整」的证明）：**

- **判**：package.json 的 version 对上台账「工作树版本」一格里的版本号。
- **判**：test/ 下 *.test.mjs 的**实际个数**对上台账「单测基线」一格里的 N/N。
- **不判**：「上游」「注释闸门」「下一阶段」等其余各格。
- **不判**：**每一轮工作是否写了段落**——机器判不了，仍需人写。

即**闸门全绿 ≠ 台账完整**，它只保证「版本号与测试数不会再抄错」这一族不再复发。

**为什么用纯 fs 而不 spawnSync 问 git**：本机实测 Node 里 spawnSync 调用任何外部程序都
EPERM（doc/progress.md「已知环境约束」），那会让闸门在本机变成**空转**——空转的闸门比没有
闸门更坏，它给的是「检查过了」的错觉。纯 fs 在本机与 CI 上行为一致。

**反向验证**（doc/verify.md §0.15.7）：台账版本改回 0.15.5 → exit 1；再把单测基线写成
35/35 → 两项同时变红，exit 1；还原 → exit 0。

### 7.2 真机层刻意排除在必需检查之外

`test-mock/real-*.mjs` 与 `npm run doctor` 需要一台**已登录的 Edge**，并且会真实敲
DeepSeek/GLM/Kimi 等站点。CI runner 没有那份登录态，也不该替用户去敲——站点风控是真实
约束（`doc/bridge-failure-ledger.md` §3 记过一次 0.14.3 事故：反复深链触发风控）。
因此真机验收走 `doc/verify.md` 的人工矩阵，由维护者按发版节奏跑，**不是**合并门禁。
把需要登录态的东西设成必需检查，唯一的结果是它永远红、然后被人绕过。

> **CODEOWNERS 生效前提**：`.github/CODEOWNERS` 里的 `@owner` 必须换成真实 GitHub 账号，
> 否则 GitHub 不报错、只是静默地不请求任何人。换完后还必须在分支保护里勾上
> 「Require review from Code Owners」。

---

## 8. 注释欠账清单（接入时的基线 → **已全部清零**）

这一节保留**接入时**（2026-09-15）的实测基线，因为它是「为什么当初要非阻断接入」的唯一证据，
也是下一次有人想再开一道非阻断闸门时该看的先例：**基线 19 error + 4 warn，清完后闸门转阻断**。

实测 `node scripts\lint-comments.mjs` 现在 **error 0 / warn 0，退出码 0**。
四个小节的处置结果分别见下。

> **口径**：下面表格里的行号是**接入时**的行号，不是现在的位置——代码随后被大量修改过，
> 拿旧行号去对现在的文件只会对不上。它们的作用是记录「当时欠了多少、坏在哪一类」，
> 不是待办清单。**当前状态以实跑输出为准**，不以本节的表格为准。

### 8.1 `CS003` — `lib/` 下导出函数缺 JSDoc（13 处）→ **已补齐**

| 文件 | 行（接入时） | 导出函数 |
| --- | --- | --- |
| `package/dsh-webcode-bridge/lib/agent-preset.js` | 247 | `serializeDelta` |
| `package/dsh-webcode-bridge/lib/agent-preset.js` | 383 | `fillMissingRequired` |
| `package/dsh-webcode-bridge/lib/agent-preset.js` | 742 | `parseAgentReply` |
| `package/dsh-webcode-bridge/lib/browser-driver.js` | 206 | `createBrowserDriver` |
| `package/dsh-webcode-bridge/lib/contract.js` | 57 | `getContract` |
| `package/dsh-webcode-bridge/lib/flatten.js` | 46 | `imagesOfOpenAiMessages` |
| `package/dsh-webcode-bridge/lib/index.js` | 119 | `imagesOfMessages` |
| `package/dsh-webcode-bridge/lib/index.js` | 361 | `apply` |
| `package/dsh-webcode-bridge/lib/metrics.js` | 33 | `expectedModelType` |
| `package/dsh-webcode-bridge/lib/mirror.js` | 9 | `createMirror` |
| `package/dsh-webcode-bridge/lib/openai.js` | 69 | `createOpenAiFront` |
| `package/dsh-webcode-bridge/lib/providers.js` | 641 | `getSite` |
| `package/dsh-webcode-bridge/lib/relay.js` | 20 | `createRelay` |

> 这些函数**并非没有注释**——它们上方大多是一段**文件级或区域级的散文注释**，只是不是
> `/** */` 块、或不紧贴声明。这正是这条规则「只会漏报不会误报」的代价：机器判不了「上方那段
> 散文是不是在讲这个函数」。逐条判定需要人读，所以清单是给 Lead 的**复核队列**，不是判决书。

### 8.2 `CS001` — 缺文件头注释（1 处）

| 文件 | 行 | 说明 |
| --- | --- | --- |
| `package/dsh-webcode-bridge/lib/client.cjs` | 1 | 首个非空行是 `window.__ModuleLoader__.load({` |

`lib/client.cjs` 是**浏览器侧 bundle**（`doc/review-guide.md` 把它列为「前端注入」），
它的形状由 `__ModuleLoader__` 契约决定，加文件头注释完全可行。这是**唯一一处真·缺头**。

### 8.3 `CS002` — 待办标记无负责人/日期/issue（**已清：是闸门自身的判据 bug**）

原报的 5 处（`scripts/lint-comments.mjs` 的 86、89、216、217、223）**全部是假红**，
不是代码欠账：

- 86、89 两行是**代码**（`MARKER_RE` / `MARKER_OK_RE` 两个正则字面量的声明），
  `TODO` 在正则里而不是注释里 —— 一个「查待办注释」的规则在读代码。
- 216、217、223 是**讨论这条规则本身的中文散文**，里面的 `TODO` 是对规则的引用。

修法与验证见 **§4.2**。要点是：改了抽取方式（状态机只取真注释文本）而**不是**放宽规则，
并且用「种一条真违规 → 确认报错 → 撤回 → 恢复 0」证明它没有变成空壳。

（`lib/` 与 `test/` 下**零违规**——与 §3.5「本仓库 `lib/` 目录下没有 `TODO`/`FIXME` 字样」一致。）

### 8.4 `CS005` — 疑似被注释掉的代码块（4 处，warn）→ **判据已收紧**

| 文件 | 行 | 连续行数 | 处置 |
| --- | --- | --- | --- |
| `package/dsh-webcode-bridge/lib/agent-preset.js` | 1 | 12 | 散文误报，判据收紧 |
| `package/dsh-webcode-bridge/lib/model-picker.js` | 1 | 24 | 散文误报，判据收紧 |
| `package/dsh-webcode-bridge/test/control-routes.test.mjs` | 1 | 22 | 散文误报，判据收紧 |
| `package/dsh-webcode-bridge/test/protocol-leak.test.mjs` | 1 | 29 | 散文误报，判据收紧 |

四处**都是文件头的散文注释**，**没有一处是死代码**——所以修的是判据而不是删文本
（删掉等于销毁真实文档）。具体收紧方式与逐处原因见 **§4.3**。

注意最后决定**不是**「把扫描起点设在文件头注释块之后」（那是本文件早先的猜测）：
那样做只是把这一形态整体豁免掉，而文件头恰是最容易堆积大段注释的地方，
真出现死代码时反而检不出来。改成收紧「像代码」的判据，是**保留检出能力**的做法。

---

## 9. 相关文件

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — 主闸门
- [`.github/workflows/release.yml`](../.github/workflows/release.yml) — 打包发布（不发 registry）
- [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml) — 静态分析
- [`.github/CODEOWNERS`](../.github/CODEOWNERS) — 审查归属（**须先把 `@owner` 换成真实账号**）
- [`.github/pull_request_template.md`](../.github/pull_request_template.md) — PR 五个小节
- [`scripts/lint-comments.mjs`](../scripts/lint-comments.mjs) — 注释纪律机检
- [`scripts/ci-local.mjs`](../scripts/ci-local.mjs) — 本地一键复现 CI
- [`scripts/verify-pack.mjs`](../scripts/verify-pack.mjs) — tarball 逐字节校验（发布护栏）
- [`scripts/install-profiles.mjs`](../scripts/install-profiles.mjs) — 装进 DSH profile
- [comment-style.md](comment-style.md) §9（实验与取证纪律）、§10（注释与文档是能力放大器）
- [verify.md](verify.md) — 真机验收矩阵（**不在 CI 里跑**，见 §2.1）