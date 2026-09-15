# DSH web profile 故障诊断报告

生成时间：2026-09-15
检查对象：`C:\Users\rsyhn\.dsh\profiles\web`
dsh 版本：`0.1.5-rc.1` ｜ pnpm `11.25.0` ｜ node `v24.18.0`

---

## 修复状态：✅ 已完成并验证通过（2026-09-15 22:35）

| 项目 | 状态 |
|---|---|
| `ERR_PNPM_UNUSED_PATCH` | **已消除** |
| `pnpm install` | **exit=0** |
| loopx 残渣（workspace / lockfile / package.json） | **全部清零** |
| 11 个 bundle 可解析 | **全部 OK** |
| `dsh-webcode-bridge` | **0.15.2**（spec = installed = source，三者一致） |

实际执行的修改：

1. `pnpm-workspace.yaml` — 删除悬空的 `patchedDependencies:` 块
   （备份：`pnpm-workspace.yaml.bak-2026-09-15-223459-loopxfix`）
2. `patches\dsh-loopx-plugin@0.1.1-beta.3.patch` → 重命名为 `.disabled`
3. `.dsh-market\state.json` — 移除 `dsh-loopx-plugin` 条目
4. `pnpm install` ×3 — 清理 lockfile、清掉 20 个 loopx 残留包

**过程中的一个副作用（已按你的选择恢复）**：首次 `pnpm install` 做一致性校验时，
发现 `package.json` 的 spec 停留在 `0.14.6.tgz`，而 `node_modules` 里实际是手动装上的
`0.15.2`，于是按 spec 回退到了 0.14.6。经确认后已把 spec 改为 `0.15.2.tgz` 并重装，
现在 spec / installed / 源码三者都是 **0.15.2**。

---

## 一、结论先说

**插件市场本身没坏。坏的是「从市场卸载 dsh-loopx-plugin」这一步留下的残渣，把整个 web profile 的 pnpm 锁死了。**

`dsh-loopx-plugin` 已经从 `package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里删掉了，
但下面两处没有一起清理：

| 残留位置 | 当前内容 |
|---|---|
| `pnpm-workspace.yaml` 第 17 行 | `patchedDependencies: dsh-loopx-plugin@0.1.1-beta.3: patches/dsh-loopx-plugin@0.1.1-beta.3.patch` |
| `patches/` 目录 | `dsh-loopx-plugin@0.1.1-beta.3.patch`（1376 字节） |

pnpm 11 的规则是：**声明了 `patchedDependencies`，但依赖图里找不到对应包 → 直接报 `ERR_PNPM_UNUSED_PATCH` 并中止整个 install**。

于是这个 profile 下的**任何** pnpm 操作都会失败——不是只有跟 loopx 有关的操作。所以你在市场里做的事全都挂了：

```
05:17:53  error  uninstall   dsh-loopx-plugin          exit=1 ERR_PNPM_UNUSED_PATCH
05:18:21  error  uninstall   dsh-loopx-plugin          exit=1 ERR_PNPM_UNUSED_PATCH
13:12:14  error  update-rollback  @liustack/modsearch   ← 更新 5.10.3 失败，回滚也没能验证
13:12:14  error  update      @liustack/modsearch -> 5.10.3  exit=1 ERR_PNPM_UNUSED_PATCH
13:12:38  error  uninstall   @opencode2dsh/dsh-plugin  exit=1 ERR_PNPM_UNUSED_PATCH
13:13:06  error  update-rollback  @liustack/modsearch   ← 第二次尝试，同样失败
13:13:06  error  update      @liustack/modsearch -> 5.10.3  exit=1 ERR_PNPM_UNUSED_PATCH
```

证据链完整：卸载 loopx 失败 → 残渣留下 → 之后 modsearch 更新、opencode2dsh 卸载全部被同一个错误顶掉。

---

## 二、当前 profile 真实状态

### 已安装并启用的插件（12 个 bundle）

| 包名 | 装好的版本 | 说明 | 市场状态 |
|---|---|---|---|
| `@deepseek-ai/dsh-base` | 内置 | 核心 | — |
| `@deepseek-ai/dsh-web-app` | 内置 | Web 外壳 | — |
| `dshmarket` | 1.45.1 | 插件市场本体 | 开 |
| `dsh-always-status-bar` | 0.1.0 | 让状态行常驻（不用悬停） | **已关闭** |
| `@liustack/modsearch` | 5.10.2 | 联网搜索 / 读网页 / X 搜索 | 开（想升 5.10.3，失败） |
| `@michengai/dsh-archive-manager` | 0.1.42 | 会话归档管理 | 开 |
| `@opencode2dsh/dsh-plugin` | 0.3.1 | 免费 OpenCode Zen 模型 | 开（你试过卸载，失败） |
| `dsh-free-vision` | 1.0.8 | 给纯文本模型加看图能力 | **已关闭** |
| `dsh-webcode-bridge` | 0.15.2 | 当前工作区自己的插件 | 开 |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | 0.1.5-rc.1 | Agent Teams | 开 |
| `dsh-local-link` | 1.1.1 | 手机/平板局域网访问 Web UI | 开 |

> 注：`dsh-loopx-plugin` 已不在依赖里，`node_modules` 里也已不存在——只剩上面那两处配置残渣。

### 磁盘占用

| 项 | 大小 |
|---|---|
| `node_modules` 合计 | 149.7 MB |
| 其中 dshmarket | 2.9 MB |
| 其中 dsh-free-vision（含 luma-mcp） | 4.1 MB |
| 其中 @opencode2dsh/dsh-plugin | 3.1 MB |
| 其中 @michengai/dsh-archive-manager | 1.6 MB |
| 其中 dsh-local-link | 1.4 MB |
| profile 目录里的 `*.bak-*` 垃圾 | 约 0.5 MB（21 个文件） |
| `.dsh-market\log.ndjson` | 133 KB |
| `.dsh-market\discovery-compatibility-v1.json` | 121 KB |

---

## 三、可以删除的东西（清单）

### A 类 — 必须处理，否则 pnpm 一直锁死

| 目标 | 处理方式 | 风险 |
|---|---|---|
| `pnpm-workspace.yaml` 里的 `patchedDependencies:` 块（2 行） | 删除 | 无。对应包已不在依赖图里 |
| `patches\dsh-loopx-plugin@0.1.1-beta.3.patch` | 重命名为 `.disabled` 或删除 | 无 |

脚本 `fix-dsh-web-profile.ps1` 会自动做这两件事（含备份），并顺带清掉市场 state.json 里的陈旧条目。

### B 类 — 插件层面，看你还用不用

| 插件 | 为什么是候选 | 删了会怎样 | 建议 |
|---|---|---|---|
| `dsh-free-vision` | 市场里**已经是关闭**状态；4.1 MB；靠 `postinstall` 脚本去打 `luma-mcp` 的补丁，机制脆弱 | 纯文本模型重新失去看图能力 | **确认不用就卸** |
| `dsh-always-status-bar` | 市场里**已经是关闭**状态 | 状态行恢复成要悬停才显示 | **确认不用就卸** |
| `@opencode2dsh/dsh-plugin` | 你在 13:12 主动试过卸载它 | 失去 OpenCode Zen 免费模型（你现在默认模型是 `webcode / deepseek:deepseek`，可能本来就没用） | **按你原意卸** |
| `dsh-local-link` | 局域网访问，用不上就是纯占位 | 手机/平板无法访问本机 Web UI | 视需要 |
| `@michengai/dsh-archive-manager` | 无明显问题 | 失去归档会话管理界面 | 保留 |

> ⚠️ 关键区别：**市场里「关闭」≠「卸载」**。`disabled` 只是启动时不加载，`package.json` 的 `dependencies` 和 `bundles` 里照样装着。
> 想让 free-vision / always-status-bar 真正消失，必须走卸载。

### C 类 — 纯垃圾文件，删了没影响

`C:\Users\rsyhn\.dsh\profiles\web\` 下（21 个，共 ~0.5 MB）：

```
cordis.patch.yml.bak-freerev
package.json.bak-0121 / -0140 / -0141 / -0142 / -0143 / -080 / -091
package.json.bak-2026-09-14-accounts / -2026-09-14-addplugins / -2026-09-15-droploopx
package-lock.json.bak                       (99.5 KB，npm 时代的遗物)
pnpm-lock.yaml.bak-0121 / -091 / -2026-09-14-accounts / -2026-09-14-addplugins / -2026-09-15-droploopx
pnpm-workspace.yaml.bak / -2026-09-14-accounts / -2026-09-14-addplugins
```

`C:\Users\rsyhn\.dsh\` 下：

```
freetoken-launch.settings.yaml.*.bak   (5 个)
web-restart.log  web-restart2.log  web-restart4.log  web-restart5.log  web-restart5-err.log
webcode-0127-restart.log               (合计约 77 KB)
```

日志类建议先归档再删；`pnpm-lock.yaml.bak-2026-09-15-droploopx` 建议**留一份**，那是唯一一份"还带 loopx"的锁文件快照，万一要回退有用。

### D 类 — 千万别删

| 东西 | 原因 |
|---|---|
| `dsh-webcode-bridge` | 当前工作区 `D:\9_Code_Workspace\dsh-webcode-bridge` 自己的插件，你现在的默认模型 provider `webcode` 就靠它 |
| `dshmarket` | 市场本体，删了就没界面了 |
| `@liustack/modsearch` | 联网搜索能力，你要**更新**不是删 |
| `@deepseek-ai/dsh-experimental-agent-team*` | Agent Teams 三件套 |
| `cordis.yml` / `cordis.patch.yml` | profile 层配置 |
| `pnpm-workspace.yaml` 的其余部分（`nodeLinker: hoisted`、`allowBuilds`、`minimumReleaseAgeExclude`） | 只删 `patchedDependencies` 块 |

---

## 四、第二个小问题（不阻塞，但要知道）

市场日志里反复出现：

```
warn  dsh-always-status-bar: patch layer write refused — 补丁层以顶层流式结构结尾，
      不支持自动追加。请先整理为条目列表 / the patch layer ends in a top-level flow structure;
      refusing to append — tidy the file into an entry list first
```

`cordis.patch.yml` 的内容是 `[]`（顶层流式空数组）。市场想往里面追加插件开关条目时，无法在 `[]` 后面接着写 `- ...`，所以**自动写入被拒绝**——开关状态只能落到 `.dsh-market\state.json` 的 `disabled` 数组里当兜底。

这解释了为什么 free-vision / always-status-bar 在市场里显示"已关闭"，但 `package.json` 的 bundles 里还赫然列着。**功能上目前没坏**（state.json 的 disabled 确实生效了，日志里有 `plugin kept off`），但两套状态是分裂的。

想让它彻底一致：需要时把 `cordis.patch.yml` 从 `[]` 整理成真正的条目列表格式，再让市场接管。**这一步不影响本次锁死修复，可以先不做。**

---

## 五、修复步骤

```powershell
# 1. 预览（不改任何文件）
pwsh -File D:\9_Code_Workspace\dsh-webcode-bridge\fix-dsh-web-profile.ps1

# 2. 先关掉所有正在跑的 DSH 会话 / agent（否则 pnpm 可能因文件占用失败）

# 3. 执行
pwsh -File D:\9_Code_Workspace\dsh-webcode-bridge\fix-dsh-web-profile.ps1 -Apply
```

脚本会：备份 `pnpm-workspace.yaml` → 删掉 `patchedDependencies` 块 → 把 loopx 补丁重命名成 `.disabled` → 清掉 `state.json` 里的 `dsh-loopx-plugin` → 跑 `pnpm install` 验证。

**验证通过的标准**：`pnpm install` 退出码 0，`ERR_PNPM_UNUSED_PATCH` 消失。

之后回到插件市场：

1. 重试更新 `@liustack/modsearch` 到 5.10.3
2. 卸载 `@opencode2dsh/dsh-plugin`（如果你想）
3. 卸载 `dsh-free-vision` / `dsh-always-status-bar`（如果确认不用）

---

## 六、给市场的反馈（这是个真 bug）

市场卸载带 pnpm 补丁的插件时，只改了 `package.json` 和 `bundles`，**没有清理 `pnpm-workspace.yaml` 的 `patchedDependencies` 和 `patches/` 下的补丁文件**，导致 pnpm 11 的 `ERR_PNPM_UNUSED_PATCH` 把整个 profile 锁死，后续所有装卸载全部失败。

市场自己的 `pnpm-compat.js` 里其实有一段检测补丁失效的提示文案（针对"包升级后补丁打不上"的场景），但没有覆盖"补丁的目标包被整个卸载掉"这个反向场景。值得报给 dshmarket 维护者：
<https://github.com/dsh-market/dsh-market>