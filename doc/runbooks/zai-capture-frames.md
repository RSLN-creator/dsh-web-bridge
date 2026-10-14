# Runbook：抓 z.ai（chat.z.ai）的真实 completion 帧

本文件回答一个问题：**长期问题 #30「Z.ai 真实流帧格式未录制」到底怎么拿到帧。**

> ## ✅ 2026-10-14：这条流程**已经跑通一次**，帧已取得
>
> 用户人工跑了一次，**一次成功且没有出现滑块**。产物逐字存为
> [`../../package/dsh-webcode-bridge/test/fixtures/zai-real-frames/zai-chat-2026-10-14.txt`](../../package/dsh-webcode-bridge/test/fixtures/zai-real-frames/zai-chat-2026-10-14.txt)（11 帧），
> decoder 已落地（`lib/decoder.js` 的 `ZaiDecoder`，注册名 `zai`），护栏
> [`../../package/dsh-webcode-bridge/test/zai-decoder.test.mjs`](../../package/dsh-webcode-bridge/test/zai-decoder.test.mjs) 7/7。
>
> **本文件保留**，因为「换一个站点 / 站点改版 / 需要重抓帧」时还要照它走；
> 下面的步骤已按那一次的真实经历校正（含**两条会让人误判的坑**，见 §1.1）。

它是 `lib/providers.js`（ZAI 条目「decoder 现状」那段注释）与
[`../long-term-issues.md`](../long-term-issues.md) §30 共同引用的落点。
那条引用的**形状本身**是本文件存在的原因，见 §4。

| 项 | 读数 / 位置 |
| --- | --- |
| 登记条目 | [`../long-term-issues.md`](../long-term-issues.md) §30（**已关闭**） |
| 探针（入库） | [`../../package/dsh-webcode-bridge/test-mock/zai-capture-frames.mjs`](../../package/dsh-webcode-bridge/test-mock/zai-capture-frames.mjs) |
| 被谁引用 | `lib/providers.js` 的 ZAI `decoder` 注释、§30 正文 |
| 卡在哪 | ~~人的一次手动过闸~~ **2026-10-14 那一次没有滑块**；是否需要人工过闸**不能预设**，见 §1.1 |
| 当前状态 | **帧已取得**（夹具在 `test/fixtures/zai-real-frames/`）；重抓时照本文件走 |

---

## 1.1 两条会让人**误判**的坑（2026-10-14 亲历，先看这两条）

### 坑① 帧抓不到 ≠ 风控拦住了：先看 `network` 里有没有 completion

那一次探针一度报 `NO_FRAMES`，而**请求其实发出去了、页面也渲染了 2419 字**。
真因是**两条互不相干的问题叠在一起**，都会伪装成「被风控挡在发送之前」：

| 真因 | 现象 | 判据 |
| --- | --- | --- |
| 探针 tee 正则写死 `/api/chat/completions` | `dump.hits=0`、`chunks=0` | `summary.network` 里**有** `/api/v2/chat/completions` ⇒ 是捕获层没绑上，不是没发 |
| `completionPaths` 缺 `/api/v2/…`（声明层） | 桥按声明匹配同样接不到 | 同上 |

⇒ **判读顺序**：先看 `summary.network` 里**有没有** completion 请求。
**没有** ⇒ 才考虑风控/未登录；**有** ⇒ 查 tee 正则与 `completionPaths` 是否覆盖了**版本段**。
这两条已在 2026-10-14 修掉（tee 改 `/api/(?:v\d+/)?chat/completions`，声明补 v2）。

### 坑② 滑块「没出现」不等于「不需要人」

那一次 `#chat-captcha-element` / `#chat-captcha-trigger` **仍然显示**（`shown:true`），
但滑块窗口**没有弹**、completion 正常发出。所以：

- **别用那两个节点单独判「本轮被拦」**（`providers.js` 的 `captchaSelector` 注释早就写明）。
- 反过来也**不能**因为「这次没弹」就断言风控闸不存在——2026-09-30 那次是真拦住了
  （见 [`../long-term-issues.md`](../long-term-issues.md) §29 的两列对照）。
  **无头 vs 有头**是已知的影响因素之一。

⇒ 结论：**照旧按「有头 + 留足等待时间」跑**，滑块出现就拖、不出现就让它自己跑完。
两边都会如实落盘，不需要人预先判断。

---

## 1. 为什么需要人（先看这条，否则会以为脚本坏了）

z.ai 自带风控闸：站点前端在**发出 completion 请求之前**先 `await HN()`（阿里云滑块验证），
验证没过就直接 `return`——`POST /api/chat/completions` **根本不存在于 wire 上**。
所以「抓不到帧」的直接原因是**请求没发**，不是捕获层没绑上。

⇒ 探针必须在**有头窗口**里跑，由人把滑块拖过去；帧会立刻落盘。
无人值守跑只会得到 `frames=0`，探针会如实写进 `summary.verdict`（`NO_FRAMES`）而**不是**报成功。

> 一条不要下错的结论：站点风控**不是本项目能在代码里绕过的**。绕过它等于破解站点风控，
> 本项目不做。我们能做且已经做的是**被拦时立刻如实说「被风控拦了」**（`WEB_CAPTCHA_REQUIRED`），
> 而不是等 120s/240s 再报一句由假读数拼出来的 `WEB_NO_PROGRESS`。

---

## 2. 跑法（三步）

### 2.1 准备一份「已登录 chat.z.ai」的**副本** profile

不要用桥自己的 profile：它会被 DSH 启动的那个浏览器独占，`Network/Cookies` 复制会稳定
`EBUSY`（§30 实测 3/3），在它上面再开浏览器等于和运行中的桥抢同一个账号。

副本的两个硬要求：

1. **已登录**：profile 里要有 `chat.z.ai` 的登录态（cookie + localStorage）。
   登录态可以用只读 CDP（`Storage.getCookies`，不 enable 任何 domain）从活着的桥浏览器里取，
   再播种到副本；**不要**直接复制活 profile 的目录。
2. **剔除 `webcode-bridge.lock.json`**：否则驱动侧会判 `BRIDGE_ACCOUNT_BUSY`。

副本放在 `package/dsh-webcode-bridge/test-mock/.zai-probe-profile`（默认值，
被 `.gitignore` 的 `test-mock/.*-profile*/` 覆盖，与其它真机探针同一口径），
或任意路径 + `PROBE_PROFILE` 指过去。

### 2.2 有头跑，人肉过闸

```powershell
cd D:\9_Code_Workspace\dsh-webcode-bridge
$env:PROBE_HEADED='1'
$env:PROBE_WAIT_MS='180000'
node package/dsh-webcode-bridge/test-mock/zai-capture-frames.mjs
```

探针会在**有头窗口**里：打开 chat.z.ai → 点开一个**既有会话**（不新建，避免触发新建接口的
风控）→ 装只读 fetch tee → 用 `providers.js` 里 zai 声明的同一组选择器填字并发送 →
停在页面上等你过闸。**弹滑块时在窗口里拖过去**，帧会自动落盘。

### 2.3 读产物

产物在 `package/dsh-webcode-bridge/test-mock/out/zai-capture/<时间戳>/`：

| 文件 | 读什么 |
| --- | --- |
| `summary.json` | `verdict`（`GOT_FRAMES` / `NO_FRAMES`）、`frames.count`、`frames.topKeys`、`decoders`（现成 decoder 各解出多少）、`dom`（正文/风控现场）、`network`（有没有 `/api/chat/completions`） |
| `raw-stream.log` | **原始帧字节**（逐字）。这是要搬进夹具的那份 |
| `page.png` | 当轮页面截图 |

**判读口诀**：`network` 里**没有** `/api/chat/completions` ⇒ 风控挡在发送之前（重跑并过闸）；
**有**但 `frames.count=0` ⇒ 捕获层问题（这时才值得查 tee）。

`test-mock/out/` 被 `.gitignore` 覆盖——它是**每次跑都变**的产物，不是证据本体。
要留档的帧必须**逐字**搬进 `test/fixtures/`（会话 id 可脱敏），见 §3。

---

## 3. 拿到帧之后（**2026-10-14 已照此走完一遍**；下面标了每步的实际落点）

1. 把 `raw-stream.log` 的**逐字**片段（脱敏 `id`）存进
   `test/fixtures/zai-real-frames/`；
   ✅ 已做 → `zai-chat-2026-10-14.txt`（并核过不含 token / user_id / requestId）。
2. 按 `providers.js` 注释里的字段表新增 **zai 专属 decoder kind**（`lib/decoder.js`）——
   语义要点：**`delta_content` 是增量、`content` 是全量快照**，两者混用必须走前缀差分，
   否则整段会播两遍（与 #21「SET 重发吞掉流式增量」同一族坑）；
   ✅ 已做 → `ZaiDecoder`（注册名 `zai`）。
   ⚠ **实施时踩到的坑（照 GLM 的做法即可）**：基类 `line()` 是 `JSON.parse(l)`，
   而缓冲区里躺的是 `data: {...}` ⇒ 必抛且**被静默吞掉**（解出 0 字）。
   必须像 `GlmDecoder` 那样**自己切 `\n\n` 帧 + 用 `frameData()` 剥 `data:` 前缀**，
   并在 `finish()` 里把残缺尾帧也按同一规则解掉。
3. 写护栏断言：新 decoder 能解出正文**且不重复**。缺了「不重复」那半条，
   「整段播两遍」会安静地通过；
   ✅ 已做 → `test/zai-decoder.test.mjs` 7 项（含**合成累积快照帧**专门钉「不重复」）。
4. 把 `providers.js` 的 `decoder: 'openai-sse'` 换成新 kind —— 在夹具与护栏落地**之前不要改**：
   现状是「已知解不出」，换成另一个同样解不出的 kind 是「猜着解不出」，更糟；
   ✅ 已做 → `decoder: 'zai'`；**顺带**补上 `completionPaths` 缺的 `/api/v2/…`（见 §1.1 坑①）。
5. 回写 §30 与 `CHANGELOG.md`，并**如实**写清哪些是真机读数、哪些仍是代码推断。
   ✅ 已回写 §30（标关闭，并明确「未经真站点端到端验证」）。
   ⚠ **`CHANGELOG.md` 尚未写**（本轮 0.19.75 未发版，等用户点头后与 tag 一起写）。

**重抓帧时会用到的两条**（本次实测）：
- 探针的 profile 副本可以直接**文件复制**播（正本没被浏览器占用时）——比 2026-09-27 那次走只读 CDP 更完整。
  关键是 `Local State`（cookie 解密密钥）必须一起拷，并剔除 `webcode-bridge.lock.json`。
- 分流判据用 `phase`：`thinking` → 思考、其余（含 `answer`）→ 正文、`done` → 收尾。

---

## 4. 一条副作用纪律（本文件为什么在 `doc/`）

本文件的抓帧步骤原先只存在于 `.tmp-probe/zai/RESULT.md`，而 `.tmp-probe/` 被 `.gitignore:61`
覆盖 ⇒ **对克隆仓库的人不存在**。同时 `lib/providers.js` 与 §30 的正文都在叫读者去那里取步骤。

这正是本仓库明令禁止的形态（[`../../wiki/protocol.md`](../../wiki/protocol.md) §5、
[`../../AGENTS.md`](../../AGENTS.md) §1）：**「外面没有它就理解不了」的信息必须放在入库处**
（`doc/` 或随包发布的源码）。本仓库此前记过 4 次同类事故，判据是：

> 入库文件（`lib/`、`doc/`、`README*`）里**不得**出现指向 `.tmp/`、`.tmp-*`、`.tmp-probe/`、
> `PLAN*.md`、`REPORT.md` 这些**被 gitignore 且有实质内容**的路径的引用；
> 要么把内容搬进入库处，要么把引用改掉。

§30 与 `providers.js` 的注释已按此条改为指向本文件与
`test-mock/zai-capture-frames.mjs`。
